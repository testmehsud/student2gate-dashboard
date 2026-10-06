import type { FirestoreHealthSource } from './types';

const DEFAULT_TIMEOUT_MS = 5_000;
type HealthDocumentSnapshot = {
  exists: boolean;
  get(field: string): unknown;
};

type FirestoreHealthDatabase = {
  collection(name: string): {
    doc(id: string): {
      get(): Promise<HealthDocumentSnapshot>;
    };
  };
};

export function readPlatformOwnerHealthRecord(
  db: FirestoreHealthDatabase,
  platformOwnerUid: string,
): () => Promise<void> {
  return async () => {
    const snapshot = await db
      .collection('platformAdmins')
      .doc(platformOwnerUid)
      .get();
    if (!snapshot.exists || snapshot.get('status') !== 'ACTIVE') {
      throw new Error('The verified Platform Owner record was unavailable.');
    }
  };
}

class FirestoreHealthTimeoutError extends Error {}

function safeFirestoreFailure(error: unknown): string {
  if (error instanceof FirestoreHealthTimeoutError) {
    return 'Firestore health check timed out.';
  }

  const code = error && typeof error === 'object' && 'code' in error
    ? (error as { code?: unknown }).code
    : undefined;
  const normalizedCode = String(code ?? '').toLowerCase().replaceAll('_', '-');

  if (code === 4 || normalizedCode === 'deadline-exceeded') {
    return 'Firestore health check timed out.';
  }
  if (code === 7 || normalizedCode === 'permission-denied') {
    return 'Firestore access was denied.';
  }
  if (code === 14 || normalizedCode === 'unavailable') {
    return 'Firestore is temporarily unavailable.';
  }

  return 'Firestore health check failed.';
}

export async function checkFirestoreHealth(
  read: () => Promise<unknown>,
  options: {
    timeoutMs?: number;
    monotonicNow?: () => number;
    dateNow?: () => Date;
  } = {},
): Promise<FirestoreHealthSource> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const dateNow = options.dateNow ?? (() => new Date());
  const checkedAt = dateNow().toISOString();
  const startedAt = monotonicNow();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new FirestoreHealthTimeoutError()), timeoutMs);
    });
    await Promise.race([Promise.resolve().then(read), timeoutPromise]);
    return {
      status: 'healthy',
      detail: 'Firestore connectivity check succeeded.',
      checkedAt,
      latencyMs: Math.max(0, Math.round(monotonicNow() - startedAt)),
    };
  } catch (error) {
    return {
      status: 'unavailable',
      detail: safeFirestoreFailure(error),
      checkedAt,
      latencyMs: null,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}