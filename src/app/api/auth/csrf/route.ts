import { NextResponse } from 'next/server';
import crypto from 'node:crypto';

const CSRF_COOKIE = 's2g_csrf';

export async function GET() {
  const token = crypto.randomBytes(32).toString('hex');

  const response = NextResponse.json({ token });

  response.cookies.set(CSRF_COOKIE, token, {
    httpOnly: false,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60,
  });

  return response;
}