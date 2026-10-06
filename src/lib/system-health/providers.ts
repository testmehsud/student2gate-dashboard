export type WorkerMetricRow = {
  sum?: { requests?: number | string; errors?: number | string };
  dimensions?: { datetime?: string; status?: string };
};
type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<FetchResponse>;

export function buildWorkerAnalyticsRequest(start: string, end: string, accountId: string, workerName: string) {
  return {
    query: `query WorkerInvocations($accountTag: string!, $scriptName: string!, $start: string!, $end: string!) {
      viewer { accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(limit: 10000, filter: {
          scriptName: $scriptName, datetime_geq: $start, datetime_lt: $end
        }) {
          sum { requests errors }
          dimensions { datetime scriptName status }
        }
      } }
    }`,
    variables: { accountTag: accountId, scriptName: workerName, start, end },
  };
}

function isWorkerRows(value: unknown): value is WorkerMetricRow[] {
  return Array.isArray(value) && value.every((row) => {
    if (!row || typeof row !== 'object') return false;
    const candidate = row as WorkerMetricRow;
    const timestamp = Date.parse(candidate.dimensions?.datetime ?? '');
    const requests = Number(candidate.sum?.requests);
    const errors = Number(candidate.sum?.errors);
    return Number.isFinite(timestamp) && Number.isFinite(requests) && requests >= 0 &&
      Number.isFinite(errors) && errors >= 0;
  });
}

export async function queryCloudflareWorker(options: {
  start: string; end: string; accountId?: string; token?: string;
  workerName?: string; fetcher?: Fetcher;
}): Promise<{ rows: WorkerMetricRow[]; error: string | null }> {
  const { start, end } = options;
  const accountId = options.accountId?.trim();
  const token = options.token?.trim();
  const workerName = options.workerName?.trim() || 'student2gate-api';
  const fetcher = options.fetcher ?? fetch;
  if (!accountId || !token) return { rows: [], error: 'Cloudflare account ID or API token is not configured on the server.' };
  if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(start) >= Date.parse(end)) {
    return { rows: [], error: 'Cloudflare Analytics time range is invalid.' };
  }
  try {
    const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(buildWorkerAnalyticsRequest(start, end, accountId, workerName)),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { rows: [], error: `Cloudflare Workers Analytics returned HTTP ${response.status}; check Worker-scoped observability access and account/Worker configuration.` };
    const result = await response.json() as {
      data?: { viewer?: { accounts?: Array<{ workersInvocationsAdaptive?: unknown }> } };
      errors?: unknown[] | null;
    };
    if (result.errors?.length) return { rows: [], error: 'Cloudflare rejected the Workers Analytics query; check Worker-scoped observability access and account/Worker configuration.' };
    const accounts = result.data?.viewer?.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 1) {
      return { rows: [], error: 'Cloudflare returned no accessible account for the configured Workers Analytics query.' };
    }
    const rows = accounts[0]?.workersInvocationsAdaptive;
    if (!isWorkerRows(rows)) return { rows: [], error: 'Cloudflare returned an invalid Workers Analytics result.' };
    return { rows, error: null };
  } catch {
    return { rows: [], error: 'Cloudflare Workers Analytics could not be reached.' };
  }
}

export type SafeVercelDeployment = {
  deploymentId: string; state: string | null; commit: string | null;
  createdAt: string | null; target: string; url: string | null;
};

export async function queryVercelProductionDeployment(options: {
  token?: string; projectId?: string; teamId?: string; fetcher?: Fetcher;
}): Promise<{ deployment: SafeVercelDeployment | null; error: string | null }> {
  const token = options.token?.trim();
  const projectId = options.projectId?.trim();
  const teamId = options.teamId?.trim();
  const fetcher = options.fetcher ?? fetch;
  if (!token) return { deployment: null, error: 'Vercel API credential is not configured on the server.' };
  if (!projectId) return { deployment: null, error: 'Vercel project information is not available in this runtime.' };
  const url = new URL('https://api.vercel.com/v6/deployments');
  url.searchParams.set('projectId', projectId);
  url.searchParams.set('target', 'production');
  url.searchParams.set('limit', '1');
  if (teamId) url.searchParams.set('teamId', teamId);
  try {
    const response = await fetcher(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { deployment: null, error: `Vercel deployment API returned HTTP ${response.status}; check this project's token read access.` };
    const result = await response.json() as { deployments?: Array<{
      uid?: unknown; id?: unknown; readyState?: unknown; state?: unknown;
      createdAt?: unknown; created?: unknown; target?: unknown; url?: unknown;
      meta?: Record<string, unknown>;
    }> };
    const record = result.deployments?.[0];
    if (!record) return { deployment: null, error: 'Vercel returned no production deployments for the configured project.' };
    const deploymentId = typeof record.uid === 'string' ? record.uid : typeof record.id === 'string' ? record.id : null;
    const target = typeof record.target === 'string' ? record.target : null;
    const created = typeof record.createdAt === 'number' ? record.createdAt : typeof record.created === 'number' ? record.created : null;
    const rawCommit = record.meta?.githubCommitSha ?? record.meta?.gitlabCommitSha ?? record.meta?.bitbucketCommitSha;
    const commit = typeof rawCommit === 'string' && /^[a-f0-9]{7,40}$/i.test(rawCommit) ? rawCommit : null;
    const hostname = typeof record.url === 'string' && /^[a-z0-9.-]+$/i.test(record.url) ? record.url : null;
    if (!deploymentId || target !== 'production') {
      return { deployment: null, error: 'Vercel returned an incomplete production deployment record.' };
    }
    return {
      deployment: {
        deploymentId,
        state: typeof record.readyState === 'string' ? record.readyState : typeof record.state === 'string' ? record.state : null,
        commit,
        createdAt: created === null ? null : new Date(created).toISOString(),
        target,
        url: hostname ? `https://${hostname}` : null,
      },
      error: null,
    };
  } catch {
    return { deployment: null, error: 'Vercel deployment history could not be reached.' };
  }
}
