export const SYSTEM_HEALTH_REFRESH_INTERVAL_MS = 30_000;
export const SYSTEM_HEALTH_SERVER_CACHE_TTL_MS = 15_000;
export const PROVIDER_METRIC_MAX_DELAY_MS = 4 * 60_000;
export const PROVIDER_METRIC_STALE_AFTER_MS = 10 * 60_000;

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
} as const;