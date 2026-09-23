import { NextRequest, NextResponse } from 'next/server';
import { PLATFORM_SESSION_COOKIE } from '@/lib/platform-auth';

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

  const response = NextResponse.json(
    { ok: true },
    {
      headers: {
        'Cache-Control': 'no-store',
      },
    },
  );

  response.cookies.set(PLATFORM_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  return response;
}