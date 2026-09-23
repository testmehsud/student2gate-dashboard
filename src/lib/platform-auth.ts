import { cookies } from 'next/headers';
import { getAdminAuth, getAdminDb } from '@/lib/firebase-admin';

export const PLATFORM_SESSION_COOKIE = 's2g_platform_session';

export type PlatformAdmin = {
  uid: string;
  email: string | null;
  name: string;
  role: 'PLATFORM_OWNER';
  status: 'ACTIVE';
};

export async function getCurrentPlatformAdmin(): Promise<PlatformAdmin | null> {
  const cookieStore = await cookies();
  const session = cookieStore.get(PLATFORM_SESSION_COOKIE)?.value;

  if (!session) {
    return null;
  }

  try {
    const decoded = await getAdminAuth().verifySessionCookie(
      session,
      true,
    );

    const snapshot = await getAdminDb()
      .collection('platformAdmins')
      .doc(decoded.uid)
      .get();

    if (!snapshot.exists) {
      return null;
    }

    const data = snapshot.data();

    if (data?.status !== 'ACTIVE') {
      return null;
    }

    const storedName =
      typeof data.name === 'string' ? data.name.trim() : '';

    return {
      uid: decoded.uid,
      email: decoded.email ?? null,
      name:
        storedName ||
        decoded.name ||
        decoded.email ||
        'Platform Owner',
      role: 'PLATFORM_OWNER',
      status: 'ACTIVE',
    };
  } catch {
    return null;
  }
}

export async function requirePlatformAdmin(): Promise<PlatformAdmin> {
  const admin = await getCurrentPlatformAdmin();

  if (!admin) {
    throw new Error('PLATFORM_OWNER_REQUIRED');
  }

  return admin;
}