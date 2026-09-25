import { NextResponse } from 'next/server';

import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';

const MAX_EVENTS = 50;

function json(
  body: unknown,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}

export async function GET() {
  try {
    await requirePlatformAdmin();
  } catch {
    return json(
      { error: 'Platform Owner access required.' },
      401,
    );
  }

  try {
    const snapshot = await getAdminDb()
      .collection('platformAuditLog')
      .orderBy('createdAt', 'desc')
      .limit(MAX_EVENTS)
      .get();

    const events = snapshot.docs.map((doc) => {
      const data = doc.data() ?? {};
      const createdAt =
        typeof data.createdAt?.toDate === 'function'
          ? data.createdAt.toDate().toISOString()
          : null;

      return {
        id: doc.id,
        actorUid:
          typeof data.actorUid === 'string'
            ? data.actorUid
            : '',
        actorName:
          typeof data.actorName === 'string'
            ? data.actorName
            : '',
        actorEmail:
          typeof data.actorEmail === 'string'
            ? data.actorEmail
            : '',
        eventType:
          typeof data.eventType === 'string'
            ? data.eventType
            : '',
        targetType:
          typeof data.targetType === 'string'
            ? data.targetType
            : '',
        targetId:
          typeof data.targetId === 'string'
            ? data.targetId
            : '',
        schoolId:
          typeof data.schoolId === 'string'
            ? data.schoolId
            : '',
        createdAt,
      };
    });

    return json({
      ok: true,
      events,
    });
  } catch {
    return json(
      { error: 'Unable to load audit events.' },
      500,
    );
  }
}