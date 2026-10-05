import { NextRequest, NextResponse } from 'next/server';

import { getAdminAccessToken, getFirebaseProjectId } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import {
  MONITORING_SAMPLE_PERIOD_SECONDS,
  SYSTEM_HEALTH_SERVER_CACHE_TTL_MS,
  TIME_RANGES,
  type TimeRange,
} from '@/lib/system-health/config';
import {
  evaluateFirestoreHealth,
  evaluateOverallHealth,
  evaluateWorkerHealth,
  isMonitoringDataStale,
  safeResponseCode,
} from '@/lib/system-health/model';
import type {
  HealthSource,
  MonitoringError,
  SystemHealthPayload,
} from '@/lib/system-health/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FIRESTORE_METRICS = {
  reads: 'firestore.googleapis.com/document/read_ops_count',
  writes: 'firestore.googleapis.com/document/write_ops_count',
  deletes: 'firestore.googleapis.com/document/delete_ops_count',
  apiRequests: 'firestore.googleapis.com/api/request_count',
  apiLatency: 'firestore.googleapis.com/api/request_latencies',
} as const;

const WORKER_NAME = 'student2gate-api';
const MAX_ERROR_ROWS = 25;
const SERVER_ERROR_CODES = new Set([
  'internal', 'unavailable', 'deadline_exceeded', 'resource_exhausted',
  'aborted', 'unknown', '500', '502', '503', '504',
]);
const SUCCESS_CODES = new Set(['success', 'ok', '0', '200']);
const WORKER_ERROR_LABELS: Record<string, string> = {
  scriptThrewException: 'Worker threw an exception',
  exceededResources: 'Worker exceeded runtime resources',
  internalError: 'Cloudflare Workers runtime error',
};

const cache = new Map<TimeRange, {
  expiresAt: number;
  payload: SystemHealthPayload;
}>();

class MonitoringProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MonitoringProviderError';
  }
}

type TimeSeriesPoint = {
  interval?: { endTime?: string };
  value?: {
    int64Value?: string | number;
    doubleValue?: number;
    distributionValue?: { mean?: number; count?: string | number };
  };
};

type TimeSeries = {
  metric?: { labels?: Record<string, string> };
  points?: TimeSeriesPoint[];
};

type MonitoringResult = {
  series: TimeSeries[] | null;
  error: string | null;
};

type WorkerMetricRow = {
  sum?: { requests?: number | string; errors?: number | string };
  dimensions?: { datetime?: string; status?: string };
};

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

function pointValue(point: TimeSeriesPoint): number | null {
  const value = point.value;
  if (!value) return null;
  if (value.int64Value !== undefined) return numeric(value.int64Value);
  if (value.doubleValue !== undefined) return numeric(value.doubleValue);
  if (value.distributionValue?.mean !== undefined) {
    return numeric(value.distributionValue.mean);
  }
  return null;
}

function sumSeries(series: TimeSeries[] | null): number | null {
  if (!series || series.length === 0) return null;
  let found = false;
  let total = 0;
  for (const timeSeries of series) {
    for (const point of timeSeries.points ?? []) {
      const value = pointValue(point);
      if (value === null) continue;
      found = true;
      total += value;
    }
  }
  return found ? total : null;
}

function lastSeriesValue(series: TimeSeries[] | null): number | null {
  if (!series) return null;
  const values = series.flatMap((timeSeries) =>
    (timeSeries.points ?? []).map(pointValue).filter(
      (value): value is number => value !== null,
    ),
  );
  return values.length > 0 ? values[values.length - 1] : null;
}

function source(
  status: HealthSource['status'],
  detail: string,
  checkedAt: string | null,
): HealthSource {
  return { status, detail, checkedAt };
}

function windowFor(range: TimeRange, now: number) {
  return {
    start: new Date(now - TIME_RANGES[range].seconds * 1_000).toISOString(),
    end: new Date(now).toISOString(),
    seconds: TIME_RANGES[range].seconds,
  };
}

async function queryCloudMonitoring(
  metricType: string,
  start: string,
  end: string,
  alignmentSeconds: number,
  groupByResponseCode = false,
): Promise<TimeSeries[]> {
  const projectId = getFirebaseProjectId();
  if (!projectId) {
    throw new MonitoringProviderError(
      'FIREBASE_PROJECT_ID is not configured for Cloud Monitoring.',
    );
  }

  const accessToken = await getAdminAccessToken();
  const params = new URLSearchParams({
    filter: `metric.type = "${metricType}"`,
    'interval.startTime': start,
    'interval.endTime': end,
    'aggregation.alignmentPeriod': `${alignmentSeconds}s`,
    'aggregation.perSeriesAligner': metricType === FIRESTORE_METRICS.apiLatency
      ? 'ALIGN_PERCENTILE_95'
      : 'ALIGN_SUM',
    'aggregation.crossSeriesReducer': metricType === FIRESTORE_METRICS.apiLatency
      ? 'REDUCE_PERCENTILE_95'
      : 'REDUCE_SUM',
    view: 'FULL',
    pageSize: '100',
  });
  if (groupByResponseCode) {
    params.append('aggregation.groupByFields', 'metric.labels.response_code');
  }

  const response = await fetch(
    `https://monitoring.googleapis.com/v3/projects/${encodeURIComponent(projectId)}/timeSeries?${params.toString()}`,
    {
      method: 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    },
  );

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new MonitoringProviderError(
        'Cloud Monitoring access is unavailable. Enable the Cloud Monitoring API and grant this Firebase service account Monitoring Viewer access (monitoring.timeSeries.list).',
      );
    }
    throw new MonitoringProviderError(`Cloud Monitoring returned HTTP ${response.status}.`);
  }

  const result = await response.json() as {
    timeSeries?: TimeSeries[];
    nextPageToken?: string;
  };
  return Array.isArray(result.timeSeries) ? result.timeSeries : [];
}

async function safeMonitoringQuery(
  metricType: string,
  start: string,
  end: string,
  alignmentSeconds: number,
  groupByResponseCode = false,
): Promise<MonitoringResult> {
  try {
    return {
      series: await queryCloudMonitoring(
        metricType, start, end, alignmentSeconds, groupByResponseCode,
      ),
      error: null,
    };
  } catch (error) {
    return {
      series: null,
      error: error instanceof MonitoringProviderError
        ? error.message
        : 'Cloud Monitoring could not be reached. Check the service account and API availability.',
    };
  }
}

function aggregateResponseCodes(series: TimeSeries[] | null) {
  const groups = new Map<string, {
    code: ReturnType<typeof safeResponseCode>;
    count: number;
    first: string | null;
    last: string | null;
  }>();

  for (const timeSeries of series ?? []) {
    const code = safeResponseCode(timeSeries.metric?.labels?.response_code);
    const group = groups.get(code.key) ?? { code, count: 0, first: null, last: null };
    for (const point of timeSeries.points ?? []) {
      const value = pointValue(point);
      if (value === null || value <= 0) continue;
      const timestamp = point.interval?.endTime ?? null;
      group.count += value;
      if (timestamp && (!group.first || Date.parse(timestamp) < Date.parse(group.first))) {
        group.first = timestamp;
      }
      if (timestamp && (!group.last || Date.parse(timestamp) > Date.parse(group.last))) {
        group.last = timestamp;
      }
    }
    groups.set(code.key, group);
  }
  return [...groups.values()];
}

function workerRequestBody(start: string, end: string, accountId: string, workerName: string) {
  return {
    query: `query WorkerInvocations {
      viewer {
        accounts(filter: { accountTag: ${JSON.stringify(accountId)} }) {
          workersInvocationsAdaptive(limit: 10000, filter: {
            scriptName: ${JSON.stringify(workerName)},
            datetime_geq: ${JSON.stringify(start)},
            datetime_leq: ${JSON.stringify(end)}
          }) {
            sum { requests errors }
            dimensions { datetime scriptName status }
          }
        }
      }
    }`,
  };
}

async function queryCloudflareWorker(
  start: string,
  end: string,
): Promise<{ rows: WorkerMetricRow[]; error: string | null }> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const missing = [
    !accountId ? 'CLOUDFLARE_ACCOUNT_ID' : null,
    !token ? 'CLOUDFLARE_API_TOKEN' : null,
  ].filter((value): value is string => !!value);
  if (missing.length > 0 || !accountId || !token) {
    return {
      rows: [],
      error: `Missing server environment variable${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}.`,
    };
  }

  const workerName = process.env.CLOUDFLARE_WORKER_NAME || WORKER_NAME;
  try {
    const response = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(workerRequestBody(start, end, accountId, workerName)),
      cache: 'no-store',
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      return {
        rows: [],
        error: `Cloudflare Analytics returned HTTP ${response.status}. Check the token's Account Analytics:Read permission.`,
      };
    }

    const result = await response.json() as {
      data?: {
        viewer?: {
          accounts?: Array<{ workersInvocationsAdaptive?: WorkerMetricRow[] }>;
        };
      };
      errors?: unknown[] | null;
    };
    if (result.errors?.length || !result.data?.viewer) {
      return {
        rows: [],
        error: 'Cloudflare rejected the Workers Analytics query. Check Account Analytics:Read access and the configured Worker name.',
      };
    }
    const rows = result.data.viewer.accounts?.[0]?.workersInvocationsAdaptive;
    return Array.isArray(rows)
      ? { rows, error: null }
      : { rows: [], error: 'Cloudflare returned no Workers Analytics result.' };
  } catch {
    return {
      rows: [],
      error: 'Cloudflare Analytics could not be reached. Check the account token and network access.',
    };
  }
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

function metricTimestamp(series: TimeSeries[] | null): string | null {
  const timestamps = (series ?? []).flatMap((timeSeries) =>
    (timeSeries.points ?? []).map((point) => point.interval?.endTime)
      .filter((value): value is string => !!value),
  );
  return timestamps.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
}

function workerErrors(
  rows: WorkerMetricRow[],
  alertHealth: ReturnType<typeof evaluateWorkerHealth>,
): MonitoringError[] {
  const summary = summarizeWorkerRows(rows);
  const severity: MonitoringError['severity'] = alertHealth === 'critical'
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

function firestoreErrors(
  selectedSeries: TimeSeries[] | null,
  recentSeries: TimeSeries[] | null,
): MonitoringError[] {
  const selectedGroups = aggregateResponseCodes(selectedSeries);
  const recentGroups = aggregateResponseCodes(recentSeries);
  const recentByCode = new Map(recentGroups.map((group) => [group.code.key, group.count]));
  const recentFailures = recentGroups
    .filter((group) => SERVER_ERROR_CODES.has(group.code.key))
    .reduce((sum, group) => sum + group.count, 0);

  return selectedGroups
    .filter((group) => group.count > 0 && !SUCCESS_CODES.has(group.code.key))
    .map((group) => {
      const recentCount = recentByCode.get(group.code.key) ?? 0;
      const alertHealth = SERVER_ERROR_CODES.has(group.code.key)
        ? evaluateFirestoreHealth(null, recentFailures, null)
        : 'healthy';
      const severity: MonitoringError['severity'] = alertHealth === 'critical' && recentCount > 0
        ? 'critical'
        : alertHealth === 'warning' && recentCount > 0
          ? 'warning'
          : group.code.severity;
      return {
        id: `firestore-${group.code.key}`,
        service: 'Firestore' as const,
        severity,
        errorType: group.code.label,
        message: `Firestore API returned ${group.code.label.toLowerCase()} responses.`,
        count: group.count,
        firstOccurrence: group.first,
        lastOccurrence: group.last,
        status: 'Observed' as const,
      };
    })
    .sort((left, right) => Date.parse(right.lastOccurrence ?? '') - Date.parse(left.lastOccurrence ?? ''))
    .slice(0, MAX_ERROR_ROWS);
}

function missingMonitoringReason(results: MonitoringResult[]) {
  const firstError = results.find((result) => result.error)?.error;
  if (firstError) return firstError;
  return 'Cloud Monitoring returned no samples in this time range. Firestore metrics are sampled every 60 seconds and can take up to 4 minutes to appear.';
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

async function buildPayload(range: TimeRange): Promise<SystemHealthPayload> {
  const generatedAt = new Date().toISOString();
  const rangeWindow = windowFor(range, Date.now());
  const recentWindow = windowFor('5m', Date.now());
  const [workerSelected, workerRecent] = await Promise.all([
    queryCloudflareWorker(rangeWindow.start, rangeWindow.end),
    range === '5m' ? Promise.resolve(null) : queryCloudflareWorker(recentWindow.start, recentWindow.end),
  ]);
  const selectedWorker = summarizeWorkerRows(workerSelected.rows);
  const recentWorker = range === '5m' ? selectedWorker : summarizeWorkerRows(workerRecent?.rows ?? []);
  const workerAlertHealth = evaluateWorkerHealth(
    workerRecent?.error ? null : recentWorker.requests,
    workerRecent?.error ? null : recentWorker.errors,
  );
  const recentWorkerRows = range === '5m' ? workerSelected.rows : workerRecent?.rows ?? [];
  const workerLatestAt = recentWorkerRows
    .map((row) => row.dimensions?.datetime)
    .filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const workerDataStale = isMonitoringDataStale(workerLatestAt, Date.parse(generatedAt));
  const workerMetricHealth = workerSelected.error || workerRecent?.error || workerSelected.rows.length === 0 || workerDataStale
    ? 'unavailable'
    : workerAlertHealth;
  const workerSourceDetail = workerSelected.error ?? (
    workerDataStale
      ? 'Latest Cloudflare Worker metric sample is older than the 10-minute freshness threshold.'
      : workerSelected.rows.length === 0
        ? 'Cloudflare returned no Worker invocation samples for this period.'
        : `${selectedWorker.requests.toLocaleString()} Worker requests in the selected period.`
  );
  const workerSource = source(
    workerMetricHealth,
    workerSourceDetail,
    workerLatestAt,
  );

  const monitoringAuth = await Promise.allSettled([
    getFirebaseProjectId(),
    getAdminAccessToken(),
  ]);
  const monitoringAuthFailed = monitoringAuth.some((item) => item.status === 'rejected');
  const monitoringProjectMissing = monitoringAuth[0].status !== 'fulfilled' || !monitoringAuth[0].value;
  const failedResult: MonitoringResult = {
    series: null,
    error: 'Google Cloud Monitoring could not use the configured Firebase Admin service account. Check project configuration and Monitoring Viewer access.',
  };
  let firestoreResults: {
    reads: MonitoringResult;
    writes: MonitoringResult;
    deletes: MonitoringResult;
    requests: MonitoringResult;
    latency: MonitoringResult;
    recentErrors: MonitoringResult;
    recentLatency: MonitoringResult;
  };

  if (monitoringAuthFailed || monitoringProjectMissing) {
    firestoreResults = {
      reads: failedResult,
      writes: failedResult,
      deletes: failedResult,
      requests: failedResult,
      latency: failedResult,
      recentErrors: failedResult,
      recentLatency: failedResult,
    };
  } else {

    const [reads, writes, deletes, requests, latency] = await Promise.all([
      safeMonitoringQuery(FIRESTORE_METRICS.reads, rangeWindow.start, rangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.writes, rangeWindow.start, rangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.deletes, rangeWindow.start, rangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.apiRequests, rangeWindow.start, rangeWindow.end, rangeWindow.seconds, true),
      safeMonitoringQuery(FIRESTORE_METRICS.apiLatency, rangeWindow.start, rangeWindow.end, rangeWindow.seconds),
    ]);
    const recentErrors = range === '5m'
      ? requests
      : await safeMonitoringQuery(FIRESTORE_METRICS.apiRequests, recentWindow.start, recentWindow.end, MONITORING_SAMPLE_PERIOD_SECONDS, true);
    const recentLatency = range === '5m'
      ? latency
      : await safeMonitoringQuery(FIRESTORE_METRICS.apiLatency, recentWindow.start, recentWindow.end, TIME_RANGES['5m'].seconds);
    firestoreResults = { reads, writes, deletes, requests, latency, recentErrors, recentLatency };
  }

  const reads = sumSeries(firestoreResults.reads.series);
  const writes = sumSeries(firestoreResults.writes.series);
  const deletes = sumSeries(firestoreResults.deletes.series);
  const requestGroups = aggregateResponseCodes(firestoreResults.requests.series);
  const recentRequestGroups = aggregateResponseCodes(firestoreResults.recentErrors.series);
  const apiRequests = firestoreResults.requests.series?.length
    ? requestGroups.reduce((sum, group) => sum + group.count, 0)
    : null;
  const apiSuccesses = firestoreResults.requests.series?.length
    ? requestGroups.filter((group) => SUCCESS_CODES.has(group.code.key)).reduce((sum, group) => sum + group.count, 0)
    : null;
  const apiErrors = apiRequests !== null && apiSuccesses !== null
    ? Math.max(apiRequests - apiSuccesses, 0)
    : null;
  const recentErrorCount = recentRequestGroups
    .filter((group) => SERVER_ERROR_CODES.has(group.code.key))
    .reduce((sum, group) => sum + group.count, 0);
  const errorRatePercent = apiRequests && apiErrors !== null
    ? (apiErrors / apiRequests) * 100
    : apiRequests === 0 ? 0 : null;
  const latencySeconds = lastSeriesValue(firestoreResults.latency.series);
  const p95LatencyMs = latencySeconds === null ? null : latencySeconds * 1_000;
  const recentLatencySeconds = lastSeriesValue(firestoreResults.recentLatency.series);
  const recentP95LatencyMs = recentLatencySeconds === null ? null : recentLatencySeconds * 1_000;
  const recentTotal = recentRequestGroups.reduce((sum, group) => sum + group.count, 0);
  const recentSuccesses = recentRequestGroups
    .filter((group) => SUCCESS_CODES.has(group.code.key))
    .reduce((sum, group) => sum + group.count, 0);
  const firestoreAlertRate = recentTotal > 0
    ? ((recentTotal - recentSuccesses) / recentTotal) * 100
    : null;
  const firestoreMetricHealth = evaluateFirestoreHealth(
    firestoreAlertRate,
    firestoreResults.recentErrors.error ? null : recentErrorCount,
    recentP95LatencyMs,
  );

  const metricResults = Object.values(firestoreResults);
  const hasFirestoreSamples = metricResults.some(
    (result) => result.series && result.series.length > 0,
  );
  const allFirestoreMetricsPresent = [
    firestoreResults.reads,
    firestoreResults.writes,
    firestoreResults.deletes,
    firestoreResults.requests,
    firestoreResults.latency,
    firestoreResults.recentErrors,
    firestoreResults.recentLatency,
  ].every((result) => result.series !== null && result.error === null && result.series.length > 0);
  const firestoreMetricDetail = !hasFirestoreSamples
    ? missingMonitoringReason(metricResults)
    : allFirestoreMetricsPresent
      ? 'Cloud Monitoring returned Firestore operation, request, and latency samples. Values are sampled and delayed.'
      : 'Some Firestore metric types have no samples or are not accessible. Missing values remain unavailable, not zero.';
  const latestFirestoreSample = metricTimestamp(firestoreResults.recentErrors.series);
  const firestoreMetricsStale = isMonitoringDataStale(latestFirestoreSample, Date.parse(generatedAt));
  const firestoreMetricsSource = source(
    !hasFirestoreSamples || !allFirestoreMetricsPresent || firestoreMetricsStale ? 'unavailable' : firestoreMetricHealth,
    firestoreMetricsStale
      ? 'Latest Firestore Cloud Monitoring sample is older than the 10-minute freshness threshold.'
      : firestoreMetricDetail,
    latestFirestoreSample,
  );

  const errors = [
    ...workerErrors(workerSelected.rows, workerAlertHealth),
    ...firestoreErrors(firestoreResults.requests.series, firestoreResults.recentErrors.series),
  ]
    .sort((left, right) => Date.parse(right.lastOccurrence ?? '') - Date.parse(left.lastOccurrence ?? ''))
    .slice(0, MAX_ERROR_ROWS);

  const deployment = {
    environment: process.env.VERCEL_ENV || null,
    commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
    deploymentId: process.env.VERCEL_DEPLOYMENT_ID || null,
    deploymentUrl: process.env.VERCEL_URL || null,
    deployedAt: null,
    workerVersion: null,
  };

  const missingCloudflare = [
    !process.env.CLOUDFLARE_ACCOUNT_ID ? 'CLOUDFLARE_ACCOUNT_ID' : null,
    !process.env.CLOUDFLARE_API_TOKEN ? 'CLOUDFLARE_API_TOKEN' : null,
  ].filter((value): value is string => !!value);
  const cloudflareIssues = source(
    'unavailable',
    missingCloudflare.length > 0
      ? `Missing server environment variables: ${missingCloudflare.join(', ')}. The current Worker config enables Observability, but does not configure Workers Logs or Issues queries.`
      : 'Aggregate invocation metrics are queried separately. Workers Issues and log details are not integrated in this stage.',
    null,
  );

  const vercelMissing = [
    !process.env.VERCEL_ACCESS_TOKEN ? 'VERCEL_ACCESS_TOKEN' : null,
    !process.env.VERCEL_PROJECT_ID ? 'VERCEL_PROJECT_ID' : null,
  ].filter((value): value is string => !!value);
  const vercelSource = source(
    'unavailable',
    vercelMissing.length > 0
      ? `Missing server environment variables: ${vercelMissing.join(', ')}. Current production deployment details cannot be queried.`
      : 'The Vercel deployment history provider is not connected in this stage.',
    null,
  );

  const webSource = source(
    'healthy',
    'The System Health page and its authenticated API are responding from this dashboard runtime.',
    generatedAt,
  );
  const authSource = source(
    'healthy',
    'The Platform Owner session was successfully verified for this request. Firebase Authentication usage metrics are not exposed by this check.',
    generatedAt,
  );
  const firestoreSource = source(
    'healthy',
    'The Platform Owner authorization lookup completed successfully through Firestore.',
    generatedAt,
  );

  const globalStatus = evaluateOverallHealth([
    webSource.status,
    workerSource.status,
    firestoreSource.status,
    firestoreMetricsSource.status,
    authSource.status,
    vercelSource.status,
    cloudflareIssues.status,
  ]);
  const reasons: string[] = [];
  if (workerAlertHealth === 'critical') {
    reasons.push(`Worker error threshold exceeded in the last 5 minutes (${recentWorker.errors} failures from ${recentWorker.requests} requests).`);
  } else if (workerAlertHealth === 'warning') {
    reasons.push(`Worker error rate is elevated in the last 5 minutes (${recentWorker.errors} failures from ${recentWorker.requests} requests).`);
  }
  if (firestoreMetricHealth === 'critical') {
    reasons.push(`Firestore failure count or p95 latency exceeded its critical threshold in the last 5 minutes (${recentErrorCount} service errors).`);
  } else if (firestoreMetricHealth === 'warning') {
    reasons.push(`Firestore failure count or p95 latency exceeded its warning threshold in the last 5 minutes (${recentErrorCount} service errors).`);
  }

  const unavailableSources: string[] = [];
  if (workerSource.status === 'unavailable') unavailableSources.push(`Worker metrics: ${workerSource.detail}`);
  if (firestoreMetricsSource.status === 'unavailable') unavailableSources.push(`Firestore metrics: ${firestoreMetricsSource.detail}`);
  if (vercelSource.status === 'unavailable') unavailableSources.push(`Vercel deployment data: ${vercelSource.detail}`);
  if (cloudflareIssues.status === 'unavailable') unavailableSources.push(`Cloudflare Issues/logs: ${cloudflareIssues.detail}`);
  if (reasons.length === 0 && unavailableSources.length > 0) reasons.push(...unavailableSources);

  const statusReason = reasons.length > 0
    ? reasons.join(' ')
    : globalStatus === 'healthy'
      ? 'All configured monitoring sources returned current data.'
      : 'Monitoring data is not complete, so overall health cannot be confirmed.';

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
      firestoreMetrics: firestoreMetricsSource,
      firebaseAuth: authSource,
      vercel: vercelSource,
      cloudflareIssues,
    },
    metrics: {
      worker: {
        requests: workerSelected.error || workerSelected.rows.length === 0 ? null : selectedWorker.requests,
        successes: workerSelected.error || workerSelected.rows.length === 0 ? null : Math.max(selectedWorker.requests - selectedWorker.errors, 0),
        errors: workerSelected.error || workerSelected.rows.length === 0 ? null : selectedWorker.errors,
        errorRatePercent: workerSelected.error || workerSelected.rows.length === 0 || selectedWorker.requests === 0
          ? null
          : (selectedWorker.errors / selectedWorker.requests) * 100,
        cpuP99: null,
        requestsPerMinute: workerSelected.error || workerSelected.rows.length === 0
          ? null
          : selectedWorker.requests / (rangeWindow.seconds / 60),
        recentErrorCount: workerRecent?.error ? null : recentWorker.errors,
      },
      firestore: {
        reads,
        writes,
        deletes,
        apiRequests,
        apiSuccesses,
        apiErrors,
        errorRatePercent,
        p95LatencyMs,
        recentErrorCount: firestoreResults.recentErrors.error ? null : recentErrorCount,
      },
    },
    deployment,
    errors,
    unavailableSources,
    configuredRateLimits: configuredRateLimits(),
  };
}

export async function GET(request: NextRequest) {
  try {
    await requirePlatformAdmin();
  } catch {
    return json({ error: 'Platform Owner access required.' }, 401);
  }

  const requestedRange = request.nextUrl.searchParams.get('range');
  const range: TimeRange = isTimeRange(requestedRange) ? requestedRange : '5m';
  const now = Date.now();
  const cached = cache.get(range);
  if (cached && cached.expiresAt > now) return json(cached.payload);

  try {
    const payload = await buildPayload(range);
    cache.set(range, {
      expiresAt: Date.now() + SYSTEM_HEALTH_SERVER_CACHE_TTL_MS,
      payload,
    });
    return json(payload);
  } catch {
    return json({ error: 'Monitoring data temporarily unavailable.' }, 503);
  }
}




