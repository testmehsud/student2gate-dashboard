export const DATA_DELETION_ACCOUNT_ROLES = [
  'PARENT_GUARDIAN', 'TEACHER_OR_STAFF', 'SCHOOL_ADMIN', 'STUDENT', 'OTHER',
] as const;
export type DataDeletionAccountRole = (typeof DATA_DELETION_ACCOUNT_ROLES)[number];
export const DATA_DELETION_STATUSES = [
  'RECEIVED', 'VERIFICATION_REQUIRED', 'IN_PROGRESS', 'UNABLE_TO_COMPLETE',
] as const;
export type DataDeletionStatus = (typeof DATA_DELETION_STATUSES)[number];
export type NormalizedDataDeletionRequest = {
  email: string; accountRole: DataDeletionAccountRole; school: string;
};
export type NormalizeDataDeletionResult =
  | { ok: true; value: NormalizedDataDeletionRequest }
  | { ok: false; error: 'email' | 'accountRole' | 'school' | 'form' };
const OPEN_STATUSES: readonly DataDeletionStatus[] = [
  'RECEIVED', 'VERIFICATION_REQUIRED', 'IN_PROGRESS',
];
const NEXT_STATUSES: Record<DataDeletionStatus, readonly DataDeletionStatus[]> = {
  RECEIVED: ['VERIFICATION_REQUIRED', 'IN_PROGRESS', 'UNABLE_TO_COMPLETE'],
  VERIFICATION_REQUIRED: ['IN_PROGRESS', 'UNABLE_TO_COMPLETE'],
  IN_PROGRESS: ['VERIFICATION_REQUIRED', 'UNABLE_TO_COMPLETE'],
  UNABLE_TO_COMPLETE: [],
};
export function normalizeDataDeletionRequest(input: unknown): NormalizeDataDeletionResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'form' };
  const record = input as Record<string, unknown>;
  const rawEmail = typeof record.email === 'string' ? record.email.normalize('NFKC').trim() : '';
  const email = rawEmail.toLowerCase();
  if (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
    return { ok: false, error: 'email' };
  }
  const accountRole = record.accountRole;
  if (typeof accountRole !== 'string' || !DATA_DELETION_ACCOUNT_ROLES.includes(accountRole as DataDeletionAccountRole)) {
    return { ok: false, error: 'accountRole' };
  }
  const school = typeof record.school === 'string'
    ? record.school.normalize('NFKC').trim().replace(/\s+/g, ' ')
    : '';
  if (school.length > 160 || /[\u0000-\u001f\u007f]/.test(school)) {
    return { ok: false, error: 'school' };
  }
  return { ok: true, value: { email, accountRole: accountRole as DataDeletionAccountRole, school } };
}
export function isOpenDataDeletionStatus(status: unknown): status is DataDeletionStatus {
  return OPEN_STATUSES.includes(status as DataDeletionStatus);
}
export function canTransitionDataDeletionStatus(current: unknown, next: unknown): next is DataDeletionStatus {
  return DATA_DELETION_STATUSES.includes(current as DataDeletionStatus)
    && DATA_DELETION_STATUSES.includes(next as DataDeletionStatus)
    && NEXT_STATUSES[current as DataDeletionStatus].includes(next as DataDeletionStatus);
}
export function nextDataDeletionStatuses(current: DataDeletionStatus): readonly DataDeletionStatus[] {
  return NEXT_STATUSES[current];
}
export function evaluateDataDeletionRateLimit(
  windowStartedAtMs: number | null,
  attemptCount: number,
  nowMs: number,
  maximumAttempts = 5,
  windowMs = 60 * 60 * 1000,
): { allowed: boolean; windowStartedAtMs: number; attemptCount: number } {
  if (windowStartedAtMs !== null && nowMs >= windowStartedAtMs && nowMs - windowStartedAtMs < windowMs) {
    if (attemptCount >= maximumAttempts) return { allowed: false, windowStartedAtMs, attemptCount };
    return { allowed: true, windowStartedAtMs, attemptCount: attemptCount + 1 };
  }
  return { allowed: true, windowStartedAtMs: nowMs, attemptCount: 1 };
}
