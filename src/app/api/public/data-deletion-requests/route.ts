import crypto from 'node:crypto';
import { isIP } from 'node:net';
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { NextRequest, NextResponse } from 'next/server';
import { getAdminDb } from '@/lib/firebase-admin';
import {
  evaluateDataDeletionRateLimit,
  isOpenDataDeletionStatus,
  normalizeDataDeletionRequest,
} from '@/lib/data-deletion';

const REQUESTS = 'dataDeletionRequests';
const RATE_LIMITS = 'dataDeletionIntakeLimits';
const RATE_WINDOW_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS_PER_WINDOW = 5;
const MAX_BODY_BYTES = 4096;
const PRODUCTION_WEBSITE_ORIGIN = 'https://student2gate-website.vercel.app';
const DEVELOPMENT_WEBSITE_ORIGINS = new Set(['http://localhost:5173', 'http://127.0.0.1:5173']);
class RateLimitError extends Error {}
function allowedOrigin(origin: string | null): string | null {
  if (origin === PRODUCTION_WEBSITE_ORIGIN) return origin;
  if (process.env.NODE_ENV !== 'production' && origin && DEVELOPMENT_WEBSITE_ORIGINS.has(origin)) return origin;
  return null;
}
function json(body: unknown, status: number, origin: string): NextResponse {
  return NextResponse.json(body, { status, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  } });
}
function getClientIp(request: NextRequest): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.trim();
  if (!forwarded) return null;
  const ip = forwarded.split(',').at(-1)?.trim() ?? '';
  return isIP(ip) ? ip : null;
}
function timestampMillis(value: unknown): number | null {
  if (value && typeof value === 'object' && 'toMillis' in value && typeof value.toMillis === 'function') {
    return value.toMillis();
  }
  return null;
}
export async function OPTIONS(request: NextRequest) {
  const origin = allowedOrigin(request.headers.get('origin'));
  if (!origin) return NextResponse.json({ error: 'This request cannot be accepted.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const method = request.headers.get('access-control-request-method');
  if (method && method.toUpperCase() !== 'POST') return json({ error: 'This request cannot be accepted.' }, 403, origin);
  return new NextResponse(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '600',
    'Cache-Control': 'no-store',
    Vary: 'Origin',
  } });
}
export async function POST(request: NextRequest) {
  const origin = allowedOrigin(request.headers.get('origin'));
  if (!origin) return NextResponse.json({ error: 'This request cannot be accepted.' }, { status: 403, headers: { 'Cache-Control': 'no-store' } });
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (declaredLength > MAX_BODY_BYTES) return json({ error: 'The request could not be accepted. Check the fields and try again.' }, 413, origin);
  let body: unknown;
  try {
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_BODY_BYTES) return json({ error: 'The request could not be accepted. Check the fields and try again.' }, 413, origin);
    body = JSON.parse(rawBody);
  } catch {
    return json({ error: 'The request could not be accepted. Check the fields and try again.' }, 400, origin);
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'The request could not be accepted. Check the fields and try again.' }, 400, origin);
  const record = body as Record<string, unknown>;
  if (typeof record.website === 'string' && record.website.trim() !== '') return json({ error: 'The request could not be accepted. Check the fields and try again.' }, 400, origin);
  const normalized = normalizeDataDeletionRequest(body);
  if (!normalized.ok) return json({ error: 'Enter a valid account email, role, and school name if applicable.' }, 400, origin);
  const clientIp = getClientIp(request);
  if (!clientIp) return json({ error: 'The request service is temporarily unavailable. Please try again or contact support.' }, 503, origin);

  try {
    const db = getAdminDb();
    const requestCollection = db.collection(REQUESTS);
    const rateLimitId = crypto.createHash('sha256').update(clientIp).digest('hex');
    const rateLimitRef = db.collection(RATE_LIMITS).doc(rateLimitId);
    const now = Date.now();
    const newRequestRef = requestCollection.doc();
    const newRequestReference = 'DR-' + crypto.randomBytes(6).toString('hex').toUpperCase();
    const initialEventRef = newRequestRef.collection('statusEvents').doc(crypto.randomUUID());

    const result = await db.runTransaction(async (transaction) => {
      const rateSnapshot = await transaction.get(rateLimitRef);
      const rateData = rateSnapshot.data() ?? {};
      const rateDecision = evaluateDataDeletionRateLimit(
        timestampMillis(rateData.windowStartedAt),
        typeof rateData.attemptCount === 'number' ? rateData.attemptCount : 0,
        now,
        MAX_ATTEMPTS_PER_WINDOW,
        RATE_WINDOW_MS,
      );
      if (!rateDecision.allowed) throw new RateLimitError();
      const matchingRequests = await transaction.get(requestCollection.where('email', '==', normalized.value.email));
      const duplicate = matchingRequests.docs.find((snapshot) => {
        const data = snapshot.data() ?? {};
        return data.accountRole === normalized.value.accountRole
          && data.school === normalized.value.school
          && isOpenDataDeletionStatus(data.status);
      });
      transaction.set(rateLimitRef, {
        windowStartedAt: Timestamp.fromMillis(rateDecision.windowStartedAtMs),
        attemptCount: rateDecision.attemptCount,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (duplicate) {
        return { requestReference: String(duplicate.get('requestReference') ?? ''), duplicate: true };
      }
      transaction.create(newRequestRef, {
        requestReference: newRequestReference,
        email: normalized.value.email,
        accountRole: normalized.value.accountRole,
        school: normalized.value.school,
        status: 'RECEIVED',
        submittedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      transaction.create(initialEventRef, {
        fromStatus: null,
        toStatus: 'RECEIVED',
        actorType: 'REQUESTER',
        createdAt: FieldValue.serverTimestamp(),
      });
      return { requestReference: newRequestReference, duplicate: false };
    });
    return json({ ok: true, requestReference: result.requestReference }, result.duplicate ? 200 : 201, origin);
  } catch (error) {
    if (error instanceof RateLimitError) return json({ error: 'Too many requests were submitted from this network. Please wait and try again later.' }, 429, origin);
    return json({ error: 'The request service is temporarily unavailable. Please try again or contact support.' }, 503, origin);
  }
}
