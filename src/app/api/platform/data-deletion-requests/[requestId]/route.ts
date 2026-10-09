import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import { canTransitionDataDeletionStatus, DATA_DELETION_STATUSES } from '@/lib/data-deletion';

const REQUESTS = 'dataDeletionRequests';
const CSRF_COOKIE = 's2g_csrf';
const MAX_BODY_BYTES = 2048;
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
function validOrigin(request: NextRequest): boolean {
  return !!process.env.DASHBOARD_ORIGIN && request.headers.get('origin') === process.env.DASHBOARD_ORIGIN;
}
function validCsrf(request: NextRequest, bodyToken: unknown): boolean {
  if (typeof bodyToken !== 'string') return false;
  const cookieToken = request.cookies.get(CSRF_COOKIE)?.value;
  return !!cookieToken && cookieToken === bodyToken;
}
function iso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return null;
}
function serializeRequest(id: string, data: FirebaseFirestore.DocumentData) {
  return {
    requestId: id,
    requestReference: typeof data.requestReference === 'string' ? data.requestReference : '',
    email: typeof data.email === 'string' ? data.email : '',
    accountRole: typeof data.accountRole === 'string' ? data.accountRole : 'OTHER',
    school: typeof data.school === 'string' ? data.school : '',
    status: typeof data.status === 'string' ? data.status : 'RECEIVED',
    submittedAt: iso(data.submittedAt),
    updatedAt: iso(data.updatedAt),
  };
}
export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    await requirePlatformAdmin();
  } catch {
    return json({ error: 'Platform Owner access required.' }, 401);
  }
  const { requestId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: 'Deletion request not found.' }, 404);
  try {
    const ref = getAdminDb().collection(REQUESTS).doc(requestId);
    const snapshot = await ref.get();
    if (!snapshot.exists) return json({ error: 'Deletion request not found.' }, 404);
    const eventSnapshot = await ref.collection('statusEvents').orderBy('createdAt', 'asc').limit(100).get();
    const events = eventSnapshot.docs.map((event) => {
      const data = event.data() ?? {};
      return {
        id: event.id,
        fromStatus: typeof data.fromStatus === 'string' ? data.fromStatus : null,
        toStatus: typeof data.toStatus === 'string' ? data.toStatus : '',
        actorType: typeof data.actorType === 'string' ? data.actorType : 'PLATFORM_OWNER',
        actorUid: typeof data.actorUid === 'string' ? data.actorUid : '',
        actorName: typeof data.actorName === 'string' ? data.actorName : '',
        changedAt: iso(data.changedAt ?? data.createdAt),
      };
    });
    return json({ ok: true, request: serializeRequest(snapshot.id, snapshot.data() ?? {}), events });
  } catch {
    return json({ error: 'Unable to load deletion request.' }, 500);
  }
}
export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  let admin;
  try {
    admin = await requirePlatformAdmin();
  } catch {
    return json({ error: 'Platform Owner access required.' }, 401);
  }
  if (!validOrigin(request)) return json({ error: 'Invalid request origin.' }, 403);
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: 'Invalid request.' }, 413);
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return json({ error: 'Invalid request.' }, 400);
  }
  if (!validCsrf(request, body?.csrfToken)) return json({ error: 'Invalid CSRF token.' }, 403);
  const nextStatus = body?.status;
  if (typeof nextStatus !== 'string' || !DATA_DELETION_STATUSES.includes(nextStatus as (typeof DATA_DELETION_STATUSES)[number])) {
    return json({ error: 'Choose an available review status.' }, 400);
  }
  const { requestId } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: 'Deletion request not found.' }, 404);
  try {
    const db = getAdminDb();
    const ref = db.collection(REQUESTS).doc(requestId);
    const eventRef = ref.collection('statusEvents').doc(crypto.randomUUID());
    const updated = await db.runTransaction(async (transaction) => {
      const current = await transaction.get(ref);
      if (!current.exists) return { error: 'not_found' as const };
      const data = current.data() ?? {};
      if (!canTransitionDataDeletionStatus(data.status, nextStatus)) return { error: 'invalid_transition' as const };
      const changedAt = FieldValue.serverTimestamp();
      transaction.update(ref, { status: nextStatus, updatedAt: changedAt });
      transaction.create(eventRef, {
        fromStatus: data.status,
        toStatus: nextStatus,
        actorType: 'PLATFORM_OWNER',
        actorUid: admin.uid,
        actorName: admin.name,
        createdAt: changedAt,
        changedAt,
      });
      return { request: { ...data, status: nextStatus, updatedAt: new Date() } };
    });
    if ('error' in updated) {
      return updated.error === 'not_found'
        ? json({ error: 'Deletion request not found.' }, 404)
        : json({ error: 'That status change is not available.' }, 409);
    }
    return json({ ok: true, request: serializeRequest(requestId, updated.request) });
  } catch {
    return json({ error: 'Unable to update deletion request.' }, 500);
  }
}
