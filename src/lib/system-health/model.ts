import { HEALTH_THRESHOLDS, MONITORING_STALE_AFTER_MS } from './config';
import type { HealthState, MonitoringError } from './types';

export function evaluateWorkerHealth(
  requests: number | null,
  errors: number | null,
): HealthState {
  if (requests === null || errors === null) return 'unavailable';
  if (requests === 0) return errors === 0 ? 'healthy' : 'critical';

  const rate = (errors / requests) * 100;
  if (
    rate > HEALTH_THRESHOLDS.worker.criticalErrorRatePercent ||
    errors >= HEALTH_THRESHOLDS.worker.criticalFailures
  ) return 'critical';
  if (
    rate > HEALTH_THRESHOLDS.worker.warningErrorRatePercent ||
    errors >= HEALTH_THRESHOLDS.worker.warningFailures
  ) return 'warning';
  return 'healthy';
}

export function evaluateFirestoreHealth(
  errorRatePercent: number | null,
  failures: number | null,
  p95LatencyMs: number | null,
): HealthState {
  if (
    errorRatePercent === null &&
    failures === null &&
    p95LatencyMs === null
  ) return 'unavailable';

  if (
    (errorRatePercent !== null && errorRatePercent > HEALTH_THRESHOLDS.firestore.criticalErrorRatePercent) ||
    (failures !== null && failures >= HEALTH_THRESHOLDS.firestore.criticalFailures) ||
    (p95LatencyMs !== null && p95LatencyMs >= HEALTH_THRESHOLDS.firestore.criticalP95LatencyMs)
  ) return 'critical';

  if (
    (errorRatePercent !== null && errorRatePercent > HEALTH_THRESHOLDS.firestore.warningErrorRatePercent) ||
    (failures !== null && failures >= HEALTH_THRESHOLDS.firestore.warningFailures) ||
    (p95LatencyMs !== null && p95LatencyMs >= HEALTH_THRESHOLDS.firestore.warningP95LatencyMs)
  ) return 'warning';

  return 'healthy';
}

export function evaluateOverallHealth(
  states: HealthState[],
): HealthState {
  if (states.includes('critical')) return 'critical';
  if (states.includes('warning')) return 'warning';
  if (states.includes('unavailable')) return 'unavailable';
  return 'healthy';
}

export function isMonitoringDataStale(
  sampledAt: string | null,
  now = Date.now(),
): boolean {
  if (!sampledAt) return true;
  const sampleTime = Date.parse(sampledAt);
  return !Number.isFinite(sampleTime) || now - sampleTime > MONITORING_STALE_AFTER_MS;
}

const RESPONSE_CODES: Record<string, { label: string; severity: MonitoringError['severity'] }> = {
  success: { label: 'Success', severity: 'info' },
  ok: { label: 'Success', severity: 'info' },
  '0': { label: 'Success', severity: 'info' },
  '200': { label: 'Success', severity: 'info' },
  invalid_argument: { label: 'Invalid argument', severity: 'info' },
  not_found: { label: 'Not found', severity: 'info' },
  already_exists: { label: 'Already exists', severity: 'info' },
  failed_precondition: { label: 'Failed precondition', severity: 'info' },
  unauthenticated: { label: 'Unauthenticated', severity: 'warning' },
  permission_denied: { label: 'Permission denied', severity: 'warning' },
  resource_exhausted: { label: 'Resource exhausted', severity: 'warning' },
  aborted: { label: 'Aborted', severity: 'warning' },
  deadline_exceeded: { label: 'Deadline exceeded', severity: 'warning' },
  internal: { label: 'Internal error', severity: 'warning' },
  unavailable: { label: 'Service unavailable', severity: 'warning' },
  unknown: { label: 'Unknown service error', severity: 'warning' },
  '500': { label: 'Internal error', severity: 'warning' },
  '502': { label: 'Service unavailable', severity: 'warning' },
  '503': { label: 'Service unavailable', severity: 'warning' },
  '504': { label: 'Deadline exceeded', severity: 'warning' },
};

export function safeResponseCode(value: unknown): {
  key: string;
  label: string;
  severity: MonitoringError['severity'];
} {
  const key = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const known = RESPONSE_CODES[key];
  return known
    ? { key, ...known }
    : { key: 'other', label: 'Other response', severity: 'info' };
}

export function filterMonitoringErrors(
  errors: MonitoringError[],
  service: string,
  severity: string,
): MonitoringError[] {
  return errors
    .filter((error) => service === 'all' || error.service === service)
    .filter((error) => severity === 'all' || error.severity === severity)
    .sort((left, right) =>
      Date.parse(right.lastOccurrence ?? '') - Date.parse(left.lastOccurrence ?? ''),
    )
    .slice(0, 25);
}
