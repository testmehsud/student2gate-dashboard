import { NextRequest, NextResponse } from 'next/server';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';
import { PLATFORM_SESSION_COOKIE } from '@/lib/platform-auth';

const CSRF_COOKIE = 's2g_csrf';
const SESSION_DURATION_MS = 5 * 24 * 60 * 60 * 1000;
const RECENT_AUTH_SECONDS = 5 * 60;

function validOrigin(request: NextRequest): boolean {
  const expected = process.env.DASHBOARD_ORIGIN;
  const origin = request.headers.get('origin');

  return !!expected && !!origin && origin === expected;
}

export async function POST(request: NextRequest) {
  if (!validOrigin(request)) {
    return NextResponse.json(
      { error: 'Invalid request origin.' },
      { status: 403 },
    );
  }

  try {
    const body = await request.json();

    const idToken =
      typeof body?.idToken === 'string' ? body.idToken : '';

    const csrfToken =
      typeof body?.csrfToken === 'string' ? body.csrfToken : '';

    if (
      idToken.length < 100 ||
      idToken.length > 20000 ||
      csrfToken.length < 32 ||
      csrfToken.length > 128
    ) {
      return NextResponse.json(
        { error: 'Invalid authentication request.' },
        { status: 400 },
      );
    }

    const cookieCsrf = request.cookies.get(CSRF_COOKIE)?.value;

    if (!cookieCsrf || cookieCsrf !== csrfToken) {
      return NextResponse.json(
        { error: 'Invalid CSRF token.' },
        { status: 403 },
      );
    }

    const decodedToken = await getAdminAuth().verifyIdToken(
      idToken,
      true,
    );

    const authTime = Number(decodedToken.auth_time);
    const now = Math.floor(Date.now() / 1000);

    if (
      !Number.isFinite(authTime) ||
      now - authTime > RECENT_AUTH_SECONDS
    ) {
      return NextResponse.json(
        { error: 'Recent sign-in required.' },
        { status: 401 },
      );
    }

    const adminSnapshot = await getAdminDb()
      .collection('platformAdmins')
      .doc(decodedToken.uid)
      .get();

    if (!adminSnapshot.exists) {
      return NextResponse.json(
        { error: 'Platform Owner access denied.' },
        { status: 403 },
      );
    }

    const adminData = adminSnapshot.data();

    if (adminData?.status !== 'ACTIVE') {
      return NextResponse.json(
        { error: 'Platform Owner account is inactive.' },
        { status: 403 },
      );
    }

    const sessionCookie = await getAdminAuth().createSessionCookie(
      idToken,
      {
        expiresIn: SESSION_DURATION_MS,
      },
    );

    const response = NextResponse.json(
      {
        ok: true,
        admin: {
          uid: decodedToken.uid,
          email: decodedToken.email ?? null,
          name:
            typeof adminData.name === 'string' &&
            adminData.name.trim()
              ? adminData.name.trim()
              : decodedToken.name ??
                decodedToken.email ??
                'Platform Owner',
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store',
        },
      },
    );

    response.cookies.set(
      PLATFORM_SESSION_COOKIE,
      sessionCookie,
      {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/',
        maxAge: SESSION_DURATION_MS / 1000,
      },
    );

    return response;
    } catch {
    return NextResponse.json(
      { error: 'Authentication failed.' },
      { status: 401 },
    );
  }
}