import { NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';

const REQUESTS = 'dataDeletionRequests';
const MAX_REQUESTS = 100;
function json(body: unknown, status = 200) {
  return NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}
function iso(value: unknown): string | null {
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return null;
}
function serialize(snapshot: FirebaseFirestore.QueryDocumentSnapshot) {
  const data = snapshot.data() ?? {};
  return {
    requestId: snapshot.id,
    requestReference: typeof data.requestReference === 'string' ? data.requestReference : '',
    email: typeof data.email === 'string' ? data.email : '',
    accountRole: typeof data.accountRole === 'string' ? data.accountRole : 'OTHER',
    school: typeof data.school === 'string' ? data.school : '',
    status: typeof data.status === 'string' ? data.status : 'RECEIVED',
    submittedAt: iso(data.submittedAt),
    updatedAt: iso(data.updatedAt),
  };
}
export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return json({ error: 'Platform Owner access required.' }, 401);
  }
  try {
    const snapshot = await getAdminDb().collection(REQUESTS)
      .orderBy('submittedAt', 'desc').limit(MAX_REQUESTS).get();
    return json({ ok: true, requests: snapshot.docs.map(serialize), limit: MAX_REQUESTS });
  } catch {
    return json({ error: 'Unable to load deletion requests.' }, 500);
  }
}
