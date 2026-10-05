import type { TimeRange } from './config';

export type HealthState =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'unavailable';

export type HealthSource = {
  status: HealthState;
  detail: string;
  checkedAt: string | null;
};

export type ErrorSeverity = 'critical' | 'warning' | 'info';

export type MonitoringError = {
  id: string;
  service: 'Student2Gate Worker' | 'Firestore';
  severity: ErrorSeverity;
  errorType: string;
  message: string;
  count: number;
  firstOccurrence: string | null;
  lastOccurrence: string | null;
  status: 'Observed';
};

export type SystemHealthPayload = {
  ok: true;
  generatedAt: string;
  range: TimeRange;
  globalStatus: HealthState;
  statusReason: string;
  sources: {
    web: HealthSource;
    worker: HealthSource;
    firestore: HealthSource;
    firestoreMetrics: HealthSource;
    firebaseAuth: HealthSource;
    vercel: HealthSource;
    cloudflareIssues: HealthSource;
  };
  metrics: {
    worker: {
      requests: number | null;
      successes: number | null;
      errors: number | null;
      errorRatePercent: number | null;
      cpuP99: number | null;
      requestsPerMinute: number | null;
      recentErrorCount: number | null;
    };
    firestore: {
      reads: number | null;
      writes: number | null;
      deletes: number | null;
      apiRequests: number | null;
      apiSuccesses: number | null;
      apiErrors: number | null;
      errorRatePercent: number | null;
      p95LatencyMs: number | null;
      recentErrorCount: number | null;
    };
  };
  deployment: {
    environment: string | null;
    commit: string | null;
    deploymentId: string | null;
    deploymentUrl: string | null;
    deployedAt: string | null;
    workerVersion: string | null;
  };
  errors: MonitoringError[];
  unavailableSources: string[];
  configuredRateLimits: Array<{
    name: string;
    requests: number;
    periodSeconds: number;
  }>;
};
