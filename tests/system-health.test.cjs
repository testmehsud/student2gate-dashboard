/* eslint @typescript-eslint/no-require-imports: off */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
  module._compile(output, filename);
};

const {
  evaluateMetricSampleHealth,
  evaluateOverallHealth,
  evaluateWorkerHealth,
  filterSystemHealthErrors,
  isProviderMetricStale,
} = require('../src/lib/system-health/model.ts');
const { checkFirestoreHealth, readPlatformOwnerHealthRecord } = require('../src/lib/system-health/firestore-health.ts');
const { queryCloudflareWorker, queryVercelProductionDeployment } = require('../src/lib/system-health/providers.ts');

function errorRow(overrides = {}) {
  return {
    id: 'worker-runtime-error',
    service: 'Student2Gate Worker',
    severity: 'warning',
    errorType: 'Worker threw an exception',
    message: 'Worker threw an exception',
    count: 2,
    firstOccurrence: '2026-10-06T10:00:00.000Z',
    lastOccurrence: '2026-10-06T10:05:00.000Z',
    status: 'Observed',
    ...overrides,
  };
}

function mockResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return body; },
  };
}

test('all available checks healthy stays healthy without database usage metrics', () => {
  const firestore = { status: 'healthy', detail: 'Connectivity check succeeded.', latencyMs: 42, checkedAt: '2026-10-06T10:00:00.000Z' };
  assert.equal(firestore.status, 'healthy');
  assert.equal(firestore.latencyMs, 42);
  assert.equal(evaluateOverallHealth(['healthy', 'healthy', firestore.status, 'healthy', 'healthy']), 'healthy');
  const types = fs.readFileSync(require.resolve('../src/lib/system-health/types.ts'), 'utf8');
  assert.doesNotMatch(types, /firestoreMetrics|reads: number \| null|p95LatencyMs/);
});

test('warning and critical connected provider states are preserved', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'warning', 'healthy']), 'warning');
  assert.equal(evaluateOverallHealth(['healthy', 'critical', 'warning']), 'critical');
  assert.equal(evaluateWorkerHealth(1_000, 11), 'warning');
  assert.equal(evaluateWorkerHealth(1_000, 51), 'critical');
});

test('unavailable Firestore, Worker, or Vercel checks cannot appear healthy', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'unavailable', 'healthy']), 'unavailable');
  assert.equal(evaluateOverallHealth(['healthy', 'healthy', 'unavailable']), 'unavailable');
  assert.equal(evaluateWorkerHealth(null, null), 'unavailable');
});

test('mixed provider states retain critical and unavailable priority', () => {
  assert.equal(evaluateOverallHealth(['healthy', 'warning', 'unavailable']), 'unavailable');
  assert.equal(evaluateOverallHealth(['critical', 'unavailable']), 'critical');
});

test('Worker sample freshness distinguishes fresh, delayed, stale, and confirmed no traffic', () => {
  const now = Date.parse('2026-10-06T10:10:00.000Z');
  assert.equal(isProviderMetricStale('2026-10-06T10:00:00.000Z', now), false);
  assert.equal(isProviderMetricStale('2026-10-06T09:59:00.000Z', now), true);
  assert.equal(isProviderMetricStale(null, now), true);
  assert.equal(isProviderMetricStale('invalid', now), true);
  assert.equal(evaluateMetricSampleHealth('2026-10-06T10:08:00.000Z', now), 'healthy');
  assert.equal(evaluateMetricSampleHealth('2026-10-06T10:05:00.000Z', now), 'warning');
  assert.equal(evaluateMetricSampleHealth('2026-10-06T09:59:00.000Z', now), 'unavailable');
  assert.equal(evaluateMetricSampleHealth(null, now, true), 'healthy');
  assert.equal(evaluateMetricSampleHealth(null, now, false), 'unavailable');
});

test('Firestore reads exactly one existing Platform Owner document and returns measured latency only', async () => {
  const calls = { collection: [], doc: [], reads: 0, fields: [] };
  const db = {
    collection(name) {
      calls.collection.push(name);
      return {
        doc(uid) {
          calls.doc.push(uid);
          return {
            async get() {
              calls.reads += 1;
              return {
                exists: true,
                get(field) {
                  calls.fields.push(field);
                  return field === 'status' ? 'ACTIVE' : 'private-user-value';
                },
              };
            },
          };
        },
      };
    },
  };
  const times = [100, 142];
  const read = readPlatformOwnerHealthRecord(db, 'verified-owner-uid');
  const result = await checkFirestoreHealth(read, {
    monotonicNow: () => times.shift(),
    dateNow: () => new Date('2026-10-06T10:00:00.000Z'),
  });
  assert.deepEqual(calls, { collection: ['platformAdmins'], doc: ['verified-owner-uid'], reads: 1, fields: ['status'] });
  assert.equal(result.status, 'healthy');
  assert.equal(result.latencyMs, 42);
  assert.equal(result.checkedAt, '2026-10-06T10:00:00.000Z');
  assert.equal(JSON.stringify(result).includes('private-user-value'), false);
});

test('Firestore errors and timeouts are unavailable with sanitized reasons', async () => {
  const failed = await checkFirestoreHealth(async () => {
    const error = new Error('Bearer secret-token private email');
    error.code = 14;
    throw error;
  });
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.detail, 'Firestore is temporarily unavailable.');
  assert.equal(failed.latencyMs, null);
  assert.doesNotMatch(JSON.stringify(failed), /secret-token|private email|Bearer/);

  const timedOut = await checkFirestoreHealth(() => new Promise(() => {}), { timeoutMs: 2 });
  assert.equal(timedOut.status, 'unavailable');
  assert.equal(timedOut.detail, 'Firestore health check timed out.');
});

test('Firestore permissions errors are mapped to a safe reason', async () => {
  const result = await checkFirestoreHealth(async () => {
    const error = new Error('raw permissions detail');
    error.code = 7;
    throw error;
  });
  assert.equal(result.detail, 'Firestore access was denied.');
  assert.doesNotMatch(JSON.stringify(result), /raw permissions detail/);
});

test('Firestore health check issues no HTTP or Cloud Monitoring request', async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => { calls += 1; throw new Error('unexpected network request'); };
  try {
    const result = await checkFirestoreHealth(async () => ({ exists: true }));
    assert.equal(result.status, 'healthy');
    assert.equal(calls, 0);
  } finally {
    global.fetch = originalFetch;
  }
});

test('error center filtering sorts and caps sanitized Worker groups', () => {
  const rows = Array.from({ length: 30 }, (_, index) => {
    const minute = String(5 + index).padStart(2, '0');
    return errorRow({ id: `row-${index}`, lastOccurrence: `2026-10-06T10:${minute}:00.000Z` });
  });
  rows.push(errorRow({ id: 'critical', severity: 'critical', lastOccurrence: '2026-10-06T11:00:00.000Z' }));
  const filtered = filterSystemHealthErrors(rows, 'Student2Gate Worker', 'warning');
  assert.equal(filtered.length, 25);
  assert.equal(filtered[0].id, 'row-29');
  assert.equal(filtered.at(-1).id, 'row-5');
  assert.equal(filterSystemHealthErrors(rows, 'Student2Gate Worker', 'critical')[0].id, 'critical');
});

test('Cloudflare Worker request uses configured account, script, and bounded UTC interval', async () => {
  const start = '2026-10-06T10:00:00.000Z';
  const end = '2026-10-06T10:05:00.000Z';
  let request;
  const result = await queryCloudflareWorker({
    start, end, accountId: 'account-id', workerName: 'student2gate-api', token: 'server-only-token',
    fetcher: async (url, init) => {
      request = { url: String(url), init };
      return mockResponse({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{
        sum: { requests: 12, errors: 1 },
        dimensions: { datetime: '2026-10-06T10:04:00.000Z', scriptName: 'student2gate-api', status: 'scriptThrewException' },
      }] }] } } });
    },
  });
  assert.equal(result.error, null);
  assert.equal(result.rows[0].sum.requests, 12);
  assert.equal(request.url, 'https://api.cloudflare.com/client/v4/graphql');
  assert.equal(request.init.headers.Authorization, 'Bearer server-only-token');
  const body = JSON.parse(request.init.body);
  assert.equal(body.variables.accountTag, 'account-id');
  assert.equal(body.variables.scriptName, 'student2gate-api');
  assert.equal(body.variables.start, start);
  assert.equal(body.variables.end, end);
  assert.match(body.query, /workersInvocationsAdaptive/);
  assert.match(body.query, /sum \{ requests errors \}/);
  assert.match(body.query, /dimensions \{ datetime scriptName status \}/);
  assert.match(body.query, /datetime_lt: \$end/);
});

test('Cloudflare GraphQL errors and HTTP failures are unavailable and sanitized', async () => {
  const queryError = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z', end: '2026-10-06T10:05:00Z', accountId: 'account-id', token: 'must-not-leak',
    fetcher: async () => mockResponse({ data: null, errors: [{ message: 'must-not-leak' }] }),
  });
  assert.equal(queryError.rows.length, 0);
  assert.match(queryError.error, /rejected/);
  assert.equal(queryError.error.includes('must-not-leak'), false);

  const httpError = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z', end: '2026-10-06T10:05:00Z', accountId: 'account-id', token: 'must-not-leak',
    fetcher: async () => mockResponse({}, 403),
  });
  assert.match(httpError.error, /HTTP 403/);
  assert.doesNotMatch(httpError.error, /must-not-leak/);
});

test('Cloudflare empty result means confirmed zero recent traffic, not a provider error', async () => {
  const result = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z', end: '2026-10-06T10:05:00Z', accountId: 'account-id', token: 'server-only-token',
    fetcher: async () => mockResponse({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [] }] } } }),
  });
  assert.deepEqual(result, { rows: [], error: null });
  assert.equal(evaluateMetricSampleHealth(null, Date.parse('2026-10-06T10:05:00Z'), result.error === null), 'healthy');
  assert.equal(evaluateWorkerHealth(0, 0), 'healthy');
});

test('Cloudflare malformed empty account and stale sample are not reported healthy', async () => {
  const malformed = await queryCloudflareWorker({
    start: '2026-10-06T10:00:00Z', end: '2026-10-06T10:05:00Z', accountId: 'account-id', token: 'token',
    fetcher: async () => mockResponse({ data: { viewer: { accounts: [] } } }),
  });
  assert.match(malformed.error, /no accessible account/);
  assert.equal(evaluateMetricSampleHealth('2026-10-06T09:59:00.000Z', Date.parse('2026-10-06T10:10:00.000Z')), 'unavailable');
});

test('Vercel provider returns only safe production deployment fields server-side', async () => {
  let request;
  const result = await queryVercelProductionDeployment({
    token: 'server-only-token', projectId: 'configured-project-id', teamId: 'configured-team-id',
    fetcher: async (url, init) => {
      request = { url: new URL(String(url)), init };
      return mockResponse({ deployments: [{
        uid: 'dpl_safe-id', readyState: 'READY', createdAt: Date.parse('2026-10-06T10:00:00Z'),
        target: 'production', url: 'student2gate-dashboard.vercel.app', meta: { githubCommitSha: 'a'.repeat(40) },
      }] });
    },
  });
  assert.equal(result.error, null);
  assert.deepEqual(result.deployment, {
    deploymentId: 'dpl_safe-id', state: 'READY', commit: 'a'.repeat(40),
    createdAt: '2026-10-06T10:00:00.000Z', target: 'production', url: 'https://student2gate-dashboard.vercel.app',
  });
  assert.equal(request.url.searchParams.get('projectId'), 'configured-project-id');
  assert.equal(request.url.searchParams.get('teamId'), 'configured-team-id');
  assert.equal(request.url.searchParams.get('target'), 'production');
  assert.equal(request.url.searchParams.get('limit'), '1');
  assert.equal(request.init.headers.Authorization, 'Bearer server-only-token');
  assert.equal(JSON.stringify(result).includes('server-only-token'), false);
});

test('missing Vercel credential and provider failures are sanitized', async () => {
  const missing = await queryVercelProductionDeployment({ projectId: 'configured-project-id' });
  assert.equal(missing.deployment, null);
  assert.match(missing.error, /Vercel API credential/);
  assert.doesNotMatch(missing.error, /VERCEL_ACCESS_TOKEN/);
  const failed = await queryVercelProductionDeployment({
    token: 'must-not-leak', projectId: 'configured-project-id', fetcher: async () => mockResponse({}, 403),
  });
  assert.equal(failed.deployment, null);
  assert.match(failed.error, /HTTP 403/);
  assert.doesNotMatch(failed.error, /must-not-leak/);
});

test('no Google Cloud Monitoring adapter, request, or billing permission remains in System Health', () => {
  const files = [
    '../src/app/api/platform/system-health/route.ts',
    '../src/lib/system-health/providers.ts',
    '../src/lib/system-health/model.ts',
    '../src/lib/system-health/config.ts',
  ].map((file) => fs.readFileSync(path.resolve(__dirname, file), 'utf8')).join('\n');
  assert.doesNotMatch(files, /monitoring\.googleapis\.com|timeSeries|monitoring\.timeSeries\.list|monitoring\.viewer|Cloud Monitoring/i);
});

test('health route is Platform Owner-only and ignores intentionally unavailable optional telemetry', () => {
  const route = fs.readFileSync(require.resolve('../src/app/api/platform/system-health/route.ts'), 'utf8');
  const authIndex = route.indexOf('platformAdmin = await requirePlatformAdmin()');
  const payloadIndex = route.indexOf('await buildPayload(range, platformAdmin.uid)');
  assert.ok(authIndex >= 0 && payloadIndex > authIndex);
  assert.match(route, /Platform Owner access required\./);
  assert.match(route, /Platform Owner session verification succeeded\./);
  assert.match(route, /Firebase Authentication usage metrics are not exposed/);
  const globalIndex = route.indexOf('const globalStatus = evaluateOverallHealth([');
  const globalEnd = route.indexOf(']);', globalIndex);
  const states = globalIndex >= 0 && globalEnd > globalIndex ? route.slice(globalIndex, globalEnd) : '';
  assert.match(states, /firestoreSource\.status/);
  assert.doesNotMatch(states, /cloudflareIssues|durableObjects|kvSource|rateLimitsSource/);
  assert.match(route, /No recent Worker traffic/);
  assert.doesNotMatch(route, /workerFallback|Monitoring/);
});

test('public System Health response and client assets exclude secrets and Firestore user data', () => {
  const page = fs.readFileSync(require.resolve('../src/app/dashboard/system-health/page.tsx'), 'utf8');
  const types = fs.readFileSync(require.resolve('../src/lib/system-health/types.ts'), 'utf8');
  const firestoreHealth = fs.readFileSync(require.resolve('../src/lib/system-health/firestore-health.ts'), 'utf8');
  assert.doesNotMatch(page, /VERCEL_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|FIREBASE_SERVICE_ACCOUNT/);
  assert.doesNotMatch(types, /token\??:|apiKey\??:|private_key|FIREBASE_SERVICE_ACCOUNT/);
  assert.match(firestoreHealth, /collection\('platformAdmins'\)[\s\S]*?\.doc\(platformOwnerUid\)[\s\S]*?\.get\(\)/);
  assert.doesNotMatch(firestoreHealth, /students|parents|teachers|platformAuditLog|where\(|limit\(/i);

  const sourceFiles = path.resolve(__dirname, '../src');
  const pendingSource = [sourceFiles];
  while (pendingSource.length) {
    const directory = pendingSource.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pendingSource.push(entryPath);
      else if (entry.isFile() && /\.(?:ts|tsx|js|jsx)$/.test(entry.name)) {
        const source = fs.readFileSync(entryPath, 'utf8');
        assert.doesNotMatch(source, /NEXT_PUBLIC_(?:VERCEL_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|FIREBASE_SERVICE_ACCOUNT)/);
      }
    }
  }

  const clientAssets = path.resolve(__dirname, '../.next/static');
  if (fs.existsSync(clientAssets)) {
    const pending = [clientAssets];
    while (pending.length) {
      const directory = pending.pop();
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) pending.push(entryPath);
        else if (entry.isFile() && entry.name.endsWith('.js')) {
          const source = fs.readFileSync(entryPath, 'utf8');
          assert.doesNotMatch(source, /VERCEL_ACCESS_TOKEN|CLOUDFLARE_API_TOKEN|FIREBASE_SERVICE_ACCOUNT_JSON/);
        }
      }
    }
  }
});
