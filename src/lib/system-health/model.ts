import { HEALTH_THRESHOLDS, PROVIDER_METRIC_MAX_DELAY_MS, PROVIDER_METRIC_STALE_AFTER_MS } from './config';
import type { HealthState, SystemHealthError } from './types';

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

export function evaluateMetricSampleHealth(
  sampledAt: string | null,
  now = Date.now(),
  noTrafficConfirmed = false,
): HealthState {
  if (!sampledAt) return noTrafficConfirmed ? 'healthy' : 'unavailable';
  const sampleTime = Date.parse(sampledAt);
  if (!Number.isFinite(sampleTime) || isProviderMetricStale(sampledAt, now)) return 'unavailable';
  return now - sampleTime > PROVIDER_METRIC_MAX_DELAY_MS ? 'warning' : 'healthy';
}

export function evaluateOverallHealth(states: HealthState[]): HealthState {
  if (states.includes('critical')) return 'critical';
  if (states.includes('unavailable')) return 'unavailable';
  if (states.includes('warning')) return 'warning';
  return 'healthy';
}

export function isProviderMetricStale(
  sampledAt: string | null,
  now = Date.now(),
): boolean {
  if (!sampledAt) return true;
  const sampleTime = Date.parse(sampledAt);
  return !Number.isFinite(sampleTime) || now - sampleTime > PROVIDER_METRIC_STALE_AFTER_MS;
}

export function filterSystemHealthErrors(
  errors: SystemHealthError[],
  service: string,
  severity: string,
): SystemHealthError[] {
  return errors
    .filter((error) => service === 'all' || error.service === service)
    .filter((error) => severity === 'all' || error.severity === severity)
    .sort((left, right) =>
      Date.parse(right.lastOccurrence ?? '') - Date.parse(left.lastOccurrence ?? ''),
    )
    .slice(0, 25);
}