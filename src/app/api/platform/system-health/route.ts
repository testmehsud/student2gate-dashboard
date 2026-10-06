import { NextRequest, NextResponse } from 'next/server';

import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import {
  PROVIDER_METRIC_STALE_AFTER_MS,
  SYSTEM_HEALTH_SERVER_CACHE_TTL_MS,
  TIME_RANGES,
  type TimeRange,
} from '@/lib/system-health/config';
import {
  evaluateMetricSampleHealth,
  evaluateOverallHealth,
  evaluateWorkerHealth,
  filterSystemHealthErrors,
} from '@/lib/system-health/model';
import { checkFirestoreHealth, readPlatformOwnerHealthRecord } from '@/lib/system-health/firestore-health';
import {
  queryCloudflareWorker as queryCloudflareWorkerProvider,
  queryVercelProductionDeployment,
  type WorkerMetricRow,
} from '@/lib/system-health/providers';
import type { HealthSource, SystemHealthError, SystemHealthPayload } from '@/lib/system-health/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WORKER_NAME = 'student2gate-api';
const MAX_ERROR_ROWS = 25;
const WORKER_ERROR_LABELS: Record<string, string> = {
  scriptThrewException: 'Worker threw an exception',
  exceededResources: 'Worker exceeded runtime resources',
  internalError: 'Cloudflare Workers runtime error',
};

const cache = new Map<TimeRange, {
  expiresAt: number;
  payload: SystemHealthPayload;
}>();

function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function isTimeRange(value: string | null): value is TimeRange {
  return !!value && Object.hasOwn(TIME_RANGES, value);
}

function numeric(value: unknown): number | null {
  const result = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(result) ? result : null;
}

function source(
  status: HealthSource['status'],
  detail: string,
  checkedAt: string | null,
): HealthSource {
  return { status, detail, checkedAt };
}

function windowFor(range: TimeRange, now: number) {
  const seconds = TIME_RANGES[range].seconds;
  return {
    start: new Date(now - seconds * 1_000).toISOString(),
    end: new Date(now).toISOString(),
    seconds,
  };
}

function queryCloudflareWorker(start: string, end: string) {
  return queryCloudflareWorkerProvider({
    start,
    end,
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    token: process.env.CLOUDFLARE_API_TOKEN,
    workerName: process.env.CLOUDFLARE_WORKER_NAME || WORKER_NAME,
  });
}

function summarizeWorkerRows(rows: WorkerMetricRow[]) {
  let requests = 0;
  let errors = 0;
  const incidents = new Map<string, { count: number; first: string | null; last: string | null }>();
  for (const row of rows) {
    const requestCount = numeric(row.sum?.requests) ?? 0;
    const errorCount = numeric(row.sum?.errors) ?? 0;
    requests += requestCount;
    errors += errorCount;
    const status = row.dimensions?.status ?? '';
    if (errorCount <= 0 || !WORKER_ERROR_LABELS[status]) continue;
    const incident = incidents.get(status) ?? { count: 0, first: null, last: null };
    const timestamp = row.dimensions?.datetime ?? null;
    incident.count += errorCount;
    if (timestamp && (!incident.first || Date.parse(timestamp) < Date.parse(incident.first))) {
      incident.first = timestamp;
    }
    if (timestamp && (!incident.last || Date.parse(timestamp) > Date.parse(incident.last))) {
      incident.last = timestamp;
    }
    incidents.set(status, incident);
  }
  return { requests, errors, incidents };
}

function latestWorkerSample(rows: WorkerMetricRow[]): string | null {
  return rows
    .map((row) => row.dimensions?.datetime)
    .filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

function workerErrors(
  rows: WorkerMetricRow[],
  alertHealth: ReturnType<typeof evaluateWorkerHealth>,
): SystemHealthError[] {
  const summary = summarizeWorkerRows(rows);
  const severity: SystemHealthError['severity'] = alertHealth === 'critical'
    ? 'critical'
    : alertHealth === 'warning' ? 'warning' : 'info';
  return [...summary.incidents.entries()]
    .map(([status, incident]) => ({
      id: `worker-${status}`,
      service: 'Student2Gate Worker' as const,
      severity,
      errorType: status,
      message: WORKER_ERROR_LABELS[status],
      count: incident.count,
      firstOccurrence: incident.first,
      lastOccurrence: incident.last,
      status: 'Observed' as const,
    }))
    .sort((left, right) => Date.parse(right.lastOccurrence ?? '') - Date.parse(left.lastOccurrence ?? ''))
    .slice(0, MAX_ERROR_ROWS);
}

function configuredRateLimits() {
  return [
    { name: 'Teacher reads', requests: 20, periodSeconds: 60 },
    { name: 'Parent pickup creation', requests: 5, periodSeconds: 60 },
    { name: 'Teacher actions', requests: 10, periodSeconds: 60 },
    { name: 'Guest access', requests: 30, periodSeconds: 60 },
    { name: 'Guest creation', requests: 5, periodSeconds: 60 },
    { name: 'School Admin actions', requests: 30, periodSeconds: 60 },
    { name: 'Admin password actions', requests: 5, periodSeconds: 60 },
  ];
}

async function buildPayload(range: TimeRange, platformOwnerUid: string): Promise<SystemHealthPayload> {
  const generatedAt = new Date().toISOString();
  const now = Date.now();
  const rangeWindow = windowFor(range, now);
  const recentWindow = windowFor('5m', now);

  const firestoreCheck = checkFirestoreHealth(async () => {
    await readPlatformOwnerHealthRecord(getAdminDb(), platformOwnerUid)();
  });

  const workerSelected = await queryCloudflareWorker(rangeWindow.start, rangeWindow.end);
  const workerRecent = range === '5m'
    ? workerSelected
    : await queryCloudflareWorker(recentWindow.start, recentWindow.end);
  const recentWorker = summarizeWorkerRows(workerRecent.rows);
  const selectedWorker = summarizeWorkerRows(workerSelected.rows);
  const workerLatestAt = latestWorkerSample(workerRecent.rows);
  const workerNoRecentTraffic = workerRecent.error === null && workerRecent.rows.length === 0;
  const workerMetricError = workerSelected.error ?? workerRecent.error ?? null;
  const workerSampleHealth = evaluateMetricSampleHealth(
    workerLatestAt,
    now,
    workerNoRecentTraffic && workerMetricError === null,
  );
  const workerAlertHealth = workerMetricError
    ? 'unavailable'
    : evaluateWorkerHealth(recentWorker.requests, recentWorker.errors);
  const workerMetricHealth = workerMetricError || workerSampleHealth === 'unavailable'
    ? 'unavailable'
    : evaluateOverallHealth([workerSampleHealth, workerAlertHealth]);
  const workerSourceDetail = workerMetricError ?? (
    workerSampleHealth === 'unavailable'
      ? `Latest Cloudflare Worker sample is older than the ${PROVIDER_METRIC_STALE_AFTER_MS / 60_000}-minute freshness limit.`
      : workerNoRecentTraffic
        ? 'No recent Worker traffic. Cloudflare returned a valid empty result for the last 5 minutes.'
        : workerSampleHealth === 'warning'
          ? 'Cloudflare Worker metrics are delayed but remain within the freshness limit.'
          : `${selectedWorker.requests.toLocaleString()} Worker requests in the selected period.`
  );
  const workerSource = source(workerMetricHealth, workerSourceDetail, workerLatestAt);
  const firestoreSource = await firestoreCheck;

  const vercelResult = await queryVercelProductionDeployment({
    token: process.env.VERCEL_ACCESS_TOKEN,
    projectId: process.env.VERCEL_PROJECT_ID,
    teamId: process.env.VERCEL_TEAM_ID || process.env.VERCEL_ORG_ID,
  });
  const deployment = {
    environment: vercelResult.deployment?.target ?? null,
    target: vercelResult.deployment?.target ?? null,
    state: vercelResult.deployment?.state ?? null,
    commit: vercelResult.deployment?.commit ?? null,
    deploymentId: vercelResult.deployment?.deploymentId ?? null,
    deploymentUrl: vercelResult.deployment?.url ?? null,
    deployedAt: vercelResult.deployment?.createdAt ?? null,
    workerVersion: null,
  };
  const vercelSource = source(
    vercelResult.error
      ? 'unavailable'
      : deployment.state === 'READY' ? 'healthy'
        : deployment.state === 'ERROR' || deployment.state === 'CANCELED' ? 'critical'
          : 'warning',
    vercelResult.error ?? (
      'Production deployment ' + (deployment.state ?? 'state unavailable') +
      (deployment.commit ? '; commit ' + deployment.commit : '; commit unavailable') +
      (deployment.deployedAt ? '; created ' + deployment.deployedAt : '')
    ),
    deployment.deployedAt,
  );

  const cloudflareIssues = source(
    'unavailable',
    'Cloudflare Issues/log details are not integrated in this stage.',
    null,
  );
  const durableObjectsSource = source(
    'unavailable',
    'TeacherMutationCoordinator configured; live telemetry unavailable.',
    null,
  );
  const kvSource = source(
    'unavailable',
    'KV configured; live telemetry unavailable.',
    null,
  );
  const rateLimitsSource = source(
    'unavailable',
    'Rate-limit configuration is checked in; live limits and rejection telemetry are unavailable.',
    null,
  );

  const webSource = source(
    'healthy',
    'The System Health page and its authenticated API are responding from this dashboard runtime.',
    generatedAt,
  );
  const authSource = source(
    'healthy',
    'Platform Owner session verification succeeded. Firebase Authentication usage metrics are not exposed by this check.',
    generatedAt,
  );

  const globalStatus = evaluateOverallHealth([
    webSource.status,
    workerSource.status,
    firestoreSource.status,
    authSource.status,
    vercelSource.status,
  ]);
  const unavailableSources: string[] = [];
  if (workerSource.status === 'unavailable') unavailableSources.push('Worker metrics: ' + workerSource.detail);
  if (firestoreSource.status === 'unavailable') unavailableSources.push('Firestore health: ' + firestoreSource.detail);
  if (vercelSource.status === 'unavailable') unavailableSources.push('Vercel deployment data: ' + vercelSource.detail);

  const statusReason = unavailableSources.length > 0
    ? unavailableSources.join(' ')
    : workerMetricHealth === 'critical'
      ? `Worker error thresholds were exceeded in the last 5 minutes (${recentWorker.errors} failures from ${recentWorker.requests} requests).`
      : workerMetricHealth === 'warning'
        ? `Worker errors or delayed telemetry require attention (${recentWorker.errors} failures from ${recentWorker.requests} requests in the last 5 minutes).`
        : globalStatus === 'healthy'
          ? 'All available health checks and providers are healthy.'
          : vercelSource.status === 'critical'
            ? `Vercel production deployment is ${deployment.state ?? 'in a critical state'}.`
            : vercelSource.status === 'warning'
              ? `Vercel production deployment is ${deployment.state ?? 'not ready yet'}.`
              : 'A connected provider requires attention.';

  return {
    ok: true,
    generatedAt,
    range,
    globalStatus,
    statusReason,
    sources: {
      web: webSource,
      worker: workerSource,
      firestore: firestoreSource,
      firebaseAuth: authSource,
      vercel: vercelSource,
      cloudflareIssues,
      durableObjects: durableObjectsSource,
      kv: kvSource,
      rateLimits: rateLimitsSource,
    },
    metrics: {
      worker: {
        requests: workerSelected.error ? null : selectedWorker.requests,
        successes: workerSelected.error ? null : Math.max(selectedWorker.requests - selectedWorker.errors, 0),
        errors: workerSelected.error ? null : selectedWorker.errors,
        errorRatePercent: workerSelected.error || selectedWorker.requests === 0
          ? null
          : (selectedWorker.errors / selectedWorker.requests) * 100,
        cpuP99: null,
        requestsPerMinute: workerSelected.error
          ? null
          : selectedWorker.requests / (rangeWindow.seconds / 60),
        recentErrorCount: workerRecent.error ? null : recentWorker.errors,
      },
    },
    deployment,
    errors: filterSystemHealthErrors(workerErrors(workerSelected.rows, workerAlertHealth), 'all', 'all'),
    unavailableSources,
    configuredRateLimits: configuredRateLimits(),
  };
}

export async function GET(request: NextRequest) {
  let platformAdmin;
  try {
    platformAdmin = await requirePlatformAdmin();
  } catch {
    return json({ error: 'Platform Owner access required.' }, 401);
  }

  const requestedRange = request.nextUrl.searchParams.get('range');
  const range: TimeRange = isTimeRange(requestedRange) ? requestedRange : '5m';
  const now = Date.now();
  const cached = cache.get(range);
  if (cached && cached.expiresAt > now) return json(cached.payload);

  try {
    const payload = await buildPayload(range, platformAdmin.uid);
    cache.set(range, {
      expiresAt: Date.now() + SYSTEM_HEALTH_SERVER_CACHE_TTL_MS,
      payload,
    });
    return json(payload);
  } catch {
    return json({ error: 'System Health data temporarily unavailable.' }, 503);
  }
}