import type { TimeRange } from './config';

export type HealthState = 'healthy' | 'warning' | 'critical' | 'unavailable';

export type HealthSource = {
  status: HealthState;
  detail: string;
  checkedAt: string | null;
};

export type FirestoreHealthSource = HealthSource & { latencyMs: number | null };
export type ErrorSeverity = 'critical' | 'warning' | 'info';

export type SystemHealthError = {
  id: string;
  service: 'Student2Gate Worker';
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
    firestore: FirestoreHealthSource;
    firebaseAuth: HealthSource;
    vercel: HealthSource;
    cloudflareIssues: HealthSource;
    durableObjects: HealthSource;
    kv: HealthSource;
    rateLimits: HealthSource;
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
  };
  deployment: {
    environment: string | null;
    target: string | null;
    state: string | null;
    commit: string | null;
    deploymentId: string | null;
    deploymentUrl: string | null;
    deployedAt: string | null;
    workerVersion: string | null;
  };
  errors: SystemHealthError[];
  unavailableSources: string[];
  configuredRateLimits: Array<{ name: string; requests: number; periodSeconds: number }>;
};