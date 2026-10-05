export const SYSTEM_HEALTH_REFRESH_INTERVAL_MS = 30_000;
export const SYSTEM_HEALTH_SERVER_CACHE_TTL_MS = 15_000;
export const MONITORING_SAMPLE_PERIOD_SECONDS = 60;
export const MONITORING_STALE_AFTER_MS = 10 * 60_000;

export const TIME_RANGES = {
  '5m': { label: '5 minutes', seconds: 5 * 60 },
  '1h': { label: '1 hour', seconds: 60 * 60 },
  '24h': { label: '24 hours', seconds: 24 * 60 * 60 },
  '7d': { label: '7 days', seconds: 7 * 24 * 60 * 60 },
} as const;

export type TimeRange = keyof typeof TIME_RANGES;

export const HEALTH_THRESHOLDS = {
  worker: {
    warningErrorRatePercent: 1,
    criticalErrorRatePercent: 5,
    warningFailures: 5,
    criticalFailures: 25,
  },
  firestore: {
    warningErrorRatePercent: 1,
    criticalErrorRatePercent: 5,
    warningFailures: 3,
    criticalFailures: 10,
    warningP95LatencyMs: 1_000,
    criticalP95LatencyMs: 3_000,
  },
  monitoring: {
    staleAfterMs: MONITORING_STALE_AFTER_MS,
  },
} as const;
