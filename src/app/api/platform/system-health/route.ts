import { NextRequest, NextResponse } from 'next/server';

import { getAdminAccessToken, getFirebaseProjectId } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import {
  MONITORING_SAMPLE_PERIOD_SECONDS,
  MONITORING_MAX_PUBLICATION_DELAY_MS,
  SYSTEM_HEALTH_SERVER_CACHE_TTL_MS,
  TIME_RANGES,
  type TimeRange,
} from '@/lib/system-health/config';
import {
  evaluateFirestoreHealth,
  evaluateOverallHealth,
  evaluateMonitoringSampleHealth,
  evaluateWorkerHealth,
  isMonitoringDataStale,
  safeResponseCode,
} from '@/lib/system-health/model';
import {
  buildCloudMonitoringParams,
  queryCloudflareWorker as queryCloudflareWorkerProvider,
  queryVercelProductionDeployment,
  type WorkerMetricRow,
} from '@/lib/system-health/providers';
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
  const latest = series.flatMap((timeSeries) =>
    (timeSeries.points ?? []).map((point) => ({
      timestamp: point.interval?.endTime ?? null,
      value: pointValue(point),
    })).filter((point): point is { timestamp: string; value: number } =>
      point.timestamp !== null && point.value !== null,
    ),
  ).sort((left, right) => Date.parse(right.timestamp) - Date.parse(left.timestamp));
  return latest[0]?.value ?? null;
}

function source(
  status: HealthSource['status'],
  detail: string,
  checkedAt: string | null,
): HealthSource {
  return { status, detail, checkedAt };
}

function windowFor(range: TimeRange, now: number) {
  return windowForSeconds(TIME_RANGES[range].seconds, now);
}

function windowForSeconds(seconds: number, now: number) {
  return {
    start: new Date(now - seconds * 1_000).toISOString(),
    end: new Date(now).toISOString(),
    seconds,
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
  const params = buildCloudMonitoringParams(metricType, start, end, alignmentSeconds, groupByResponseCode);

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
  const now = Date.now();
  const rangeWindow = windowFor(range, now);
  const recentWindow = windowFor('5m', now);
  const firestoreRangeWindow = windowFor(range, now - MONITORING_MAX_PUBLICATION_DELAY_MS);
  const firestoreRecentWindow = windowFor('5m', now - MONITORING_MAX_PUBLICATION_DELAY_MS);
  const firestoreFallbackWindow = windowForSeconds(15 * 60, now - MONITORING_MAX_PUBLICATION_DELAY_MS);

  const workerSelected = await queryCloudflareWorker(rangeWindow.start, rangeWindow.end);
  const workerRecent = range === '5m'
    ? workerSelected
    : await queryCloudflareWorker(recentWindow.start, recentWindow.end);
  const recentWorker = summarizeWorkerRows(workerRecent.rows);
  const workerRecentRows = workerRecent.rows;
  const workerNeedsFallback = workerSelected.error === null &&
    workerRecent.error === null && workerRecentRows.length === 0 &&
    range !== '24h' && range !== '7d';
  const workerFallback = workerNeedsFallback
    ? await queryCloudflareWorker(
      windowFor('24h', now).start,
      windowFor('24h', now).end,
    )
    : null;
  const workerMetricError = workerSelected.error ?? workerRecent.error ??
    workerFallback?.error ?? null;
  const selectedWorker = summarizeWorkerRows(workerSelected.rows);
  const workerLatestAt = workerRecentRows
    .map((row) => row.dimensions?.datetime)
    .filter((value): value is string => !!value)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
    workerFallback?.rows
      .map((row) => row.dimensions?.datetime)
      .filter((value): value is string => !!value)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ??
    null;
  const workerRecentHasSample = workerRecentRows.length > 0;
  const workerDataStale = workerRecentHasSample &&
    isMonitoringDataStale(workerLatestAt, now);
  const workerAlertHealth = workerMetricError
    ? 'unavailable'
    : evaluateWorkerHealth(recentWorker.requests, recentWorker.errors);
  const workerMetricHealth = workerMetricError || workerDataStale
    ? 'unavailable'
    : workerAlertHealth;
  const workerSourceDetail = workerMetricError ?? (
    workerDataStale
      ? 'Latest Cloudflare Worker metric sample is older than the 10-minute freshness threshold.'
      : !workerRecentHasSample
        ? 'No recent Worker traffic. Cloudflare returned a valid empty metrics result for the selected short range.'
        : selectedWorker.requests.toLocaleString() + ' Worker requests in the selected period.'
  );
  const workerSource = source(workerMetricHealth, workerSourceDetail, workerLatestAt);

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
    fallbackRequests: MonitoringResult;
    fallbackLatency: MonitoringResult;
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
      fallbackRequests: failedResult,
      fallbackLatency: failedResult,
    };
  } else {
    const [reads, writes, deletes, requests, latency] = await Promise.all([
      safeMonitoringQuery(FIRESTORE_METRICS.reads, firestoreRangeWindow.start, firestoreRangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.writes, firestoreRangeWindow.start, firestoreRangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.deletes, firestoreRangeWindow.start, firestoreRangeWindow.end, rangeWindow.seconds),
      safeMonitoringQuery(FIRESTORE_METRICS.apiRequests, firestoreRangeWindow.start, firestoreRangeWindow.end, rangeWindow.seconds, true),
      safeMonitoringQuery(FIRESTORE_METRICS.apiLatency, firestoreRangeWindow.start, firestoreRangeWindow.end, rangeWindow.seconds),
    ]);
    const [recentErrors, recentLatency, fallbackRequests, fallbackLatency] = await Promise.all([
      safeMonitoringQuery(FIRESTORE_METRICS.apiRequests, firestoreRecentWindow.start, firestoreRecentWindow.end, MONITORING_SAMPLE_PERIOD_SECONDS, true),
      safeMonitoringQuery(FIRESTORE_METRICS.apiLatency, firestoreRecentWindow.start, firestoreRecentWindow.end, MONITORING_SAMPLE_PERIOD_SECONDS),
      safeMonitoringQuery(FIRESTORE_METRICS.apiRequests, firestoreFallbackWindow.start, firestoreFallbackWindow.end, MONITORING_SAMPLE_PERIOD_SECONDS, true),
      safeMonitoringQuery(FIRESTORE_METRICS.apiLatency, firestoreFallbackWindow.start, firestoreFallbackWindow.end, MONITORING_SAMPLE_PERIOD_SECONDS),
    ]);
    firestoreResults = {
      reads, writes, deletes, requests, latency,
      recentErrors, recentLatency, fallbackRequests, fallbackLatency,
    };
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
  const providerError = metricResults.find((result) => result.error)?.error ?? null;
  const selectedMetricResults = [
    firestoreResults.reads,
    firestoreResults.writes,
    firestoreResults.deletes,
    firestoreResults.requests,
    firestoreResults.latency,
  ];
  const hasSelectedSamples = selectedMetricResults.some(
    (result) => result.series && result.series.length > 0,
  );
  const hasFallbackSamples = [
    firestoreResults.fallbackRequests,
    firestoreResults.fallbackLatency,
  ].some((result) => result.series && result.series.length > 0);
  const latestFirestoreSample = metricTimestamp(metricResults.flatMap(
    (result) => result.series ?? [],
  ));
  const firestoreSampleHealth = evaluateMonitoringSampleHealth(
    latestFirestoreSample,
    now,
    !latestFirestoreSample && !providerError,
  );
  const firestoreMetricsStale = latestFirestoreSample !== null &&
    firestoreSampleHealth === 'unavailable';
  const firestoreMetricsDelayed = firestoreSampleHealth === 'warning';
  const firestoreMetricDetail = providerError ?? (
    !hasSelectedSamples && !hasFallbackSamples
      ? 'No recent Firestore traffic. Cloud Monitoring queries succeeded but returned no samples in the 15-minute verification window.'
      : firestoreMetricsDelayed
        ? 'Firestore telemetry is delayed but remains within the 10-minute freshness limit. Samples are aligned to complete 60-second periods.'
        : hasSelectedSamples
          ? 'Cloud Monitoring returned recent Firestore samples. Empty metric families remain unavailable rather than being counted as zero.'
          : 'Firestore activity is present in the fallback window; the selected period has no recent traffic.'
  );
  const firestoreMetricsStatus = providerError || firestoreMetricsStale
    ? 'unavailable'
    : firestoreMetricsDelayed ? 'warning' : firestoreMetricHealth;
  const firestoreMetricsSource = source(
    firestoreMetricsStatus,
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
    'Aggregate Worker invocation metrics use the configured Worker-scoped observability access. Raw Worker logs and traces are not queried or exposed; the Issues/log query is not integrated.',
    null,
  );
  const durableObjectsSource = source(
    'unavailable',
    'TeacherMutationCoordinator  configured; live Durable Object telemetry is unavailable in this dashboard.',
    null,
  );
  const kvSource = source(
    'unavailable',
    'KV-backed rate limits  configured; live KV telemetry is unavailable in this dashboard.',
    null,
  );
  const rateLimitsSource = source(
    'unavailable',
    'Rate-limit configuration is checked in; live deployed limits and rejection telemetry are unavailable.',
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
    durableObjectsSource.status,
    kvSource.status,
    rateLimitsSource.status,
  ]);
  const reasons: string[] = [];
  if (workerAlertHealth === 'critical') {
    reasons.push('Worker error threshold exceeded in the last 5 minutes (' + recentWorker.errors + ' failures from ' + recentWorker.requests + ' requests).');
  } else if (workerAlertHealth === 'warning') {
    reasons.push('Worker error rate is elevated in the last 5 minutes (' + recentWorker.errors + ' failures from ' + recentWorker.requests + ' requests).');
  }
  if (firestoreMetricHealth === 'critical') {
    reasons.push('Firestore failure count or p95 latency exceeded its critical threshold in the last 5 minutes (' + recentErrorCount + ' service errors).');
  } else if (firestoreMetricHealth === 'warning') {
    reasons.push('Firestore failure count or p95 latency exceeded its warning threshold in the last 5 minutes (' + recentErrorCount + ' service errors).');
  }

  const unavailableSources: string[] = [];
  if (workerSource.status === 'unavailable') unavailableSources.push('Worker metrics: ' + workerSource.detail);
  if (firestoreMetricsSource.status === 'unavailable') unavailableSources.push('Firestore metrics: ' + firestoreMetricsSource.detail);
  if (vercelSource.status === 'unavailable') unavailableSources.push('Vercel deployment data: ' + vercelSource.detail);
  if (cloudflareIssues.status === 'unavailable') unavailableSources.push('Cloudflare Issues/logs: ' + cloudflareIssues.detail);
  if (durableObjectsSource.status === 'unavailable') unavailableSources.push('Durable Object metrics: ' + durableObjectsSource.detail);
  if (kvSource.status === 'unavailable') unavailableSources.push('KV metrics: ' + kvSource.detail);
  if (rateLimitsSource.status === 'unavailable') unavailableSources.push('Rate-limit telemetry: ' + rateLimitsSource.detail);
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




