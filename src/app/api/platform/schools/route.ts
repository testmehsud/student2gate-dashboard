import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';

const CSRF_COOKIE = 's2g_csrf';

const MAX_NAME_LENGTH = 200;
const MAX_CITY_LENGTH = 100;

const MIN_PICKUP_RADIUS_METERS = 1;
const MAX_PICKUP_RADIUS_METERS = 5_000;

const MIN_PICKUP_REQUEST_LIFETIME_MINUTES = 1;
const MAX_PICKUP_REQUEST_LIFETIME_MINUTES = 180;

const MIN_RELEASE_MINUTES_BEFORE_BELL = 0;
const MAX_RELEASE_MINUTES_BEFORE_BELL = 60;

const MIN_SESSION_DURATION_MINUTES = 1;
const MAX_SESSION_DURATION_MINUTES = 240;

class SchoolConflictError extends Error {
  constructor() {
    super('School ID collision.');
    this.name = 'SchoolConflictError';
  }
}

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

function validOrigin(request: NextRequest): boolean {
  const expected = process.env.DASHBOARD_ORIGIN;
  const origin = request.headers.get('origin');

  return !!expected && !!origin && origin === expected;
}

function validCsrf(request: NextRequest, bodyToken: unknown): boolean {
  if (typeof bodyToken !== 'string') {
    return false;
  }

  const cookieToken =
    request.cookies.get(CSRF_COOKIE)?.value;

  if (!cookieToken) {
    return false;
  }

  return cookieToken === bodyToken;
}

function isFiniteNumber(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isFinite(value)
  );
}

function isInteger(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value)
  );
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', {
      timeZone: value,
    }).format();

    return true;
  } catch {
    return false;
  }
}

function makeSchoolId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);

  const suffix = crypto.randomBytes(4).toString('hex');

  return `school-${slug || 'tenant'}-${suffix}`;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function serializeSchool(
  snapshot: FirebaseFirestore.DocumentSnapshot,
) {
  const data = snapshot.data() ?? {};

  return {
    schoolId: snapshot.id,
    name:
      typeof data.name === 'string'
        ? data.name
        : '',
    city:
      typeof data.city === 'string'
        ? data.city
        : '',
    status:
      typeof data.status === 'string'
        ? data.status
        : '',
    timezone:
      typeof data.timezone === 'string'
        ? data.timezone
        : '',
    releaseEnabled:
      data.releaseEnabled === true,
    pickupLatitude:
      typeof data.pickupLatitude === 'number'
        ? data.pickupLatitude
        : null,
    pickupLongitude:
      typeof data.pickupLongitude === 'number'
        ? data.pickupLongitude
        : null,
    pickupRadiusMeters:
      typeof data.pickupRadiusMeters === 'number'
        ? data.pickupRadiusMeters
        : null,
    pickupRequestLifetimeMinutes:
      typeof data.pickupRequestLifetimeMinutes === 'number'
        ? data.pickupRequestLifetimeMinutes
        : null,
    pickupReleaseMinutesBeforeBell:
      typeof data.pickupReleaseMinutesBeforeBell === 'number'
        ? data.pickupReleaseMinutesBeforeBell
        : null,
    pickupSessionDurationMinutes:
      typeof data.pickupSessionDurationMinutes === 'number'
        ? data.pickupSessionDurationMinutes
        : null,
  };
}

async function getAuthorizedPlatformAdmin() {
  try {
    return await requirePlatformAdmin();
  } catch {
    return null;
  }
}

export async function GET() {
  const admin = await getAuthorizedPlatformAdmin();

  if (!admin) {
    return json(
      { error: 'Platform Owner access required.' },
      401,
    );
  }

  try {
    const db = getAdminDb();

    const snapshot = await db
      .collection('schools')
      .get();

    const schools = snapshot.docs
      .map(serializeSchool)
      .sort((a, b) =>
        a.name.localeCompare(b.name),
      );

    return json({
      ok: true,
      schools,
    });
  } catch {
    return json(
      { error: 'Unable to load schools.' },
      500,
    );
  }
}

export async function POST(
  request: NextRequest,
) {
  const admin = await getAuthorizedPlatformAdmin();

  if (!admin) {
    return json(
      { error: 'Platform Owner access required.' },
      401,
    );
  }

  if (!validOrigin(request)) {
    return json(
      { error: 'Invalid request origin.' },
      403,
    );
  }

  try {
    const body = await request.json();

    if (
      !validCsrf(
        request,
        body?.csrfToken,
      )
    ) {
      return json(
        { error: 'Invalid CSRF token.' },
        403,
      );
    }

    const name = stringOrEmpty(body?.name);
    const city = stringOrEmpty(body?.city);
    const timezone = stringOrEmpty(
      body?.timezone,
    );

    if (
      name.length < 2 ||
      name.length > MAX_NAME_LENGTH
    ) {
      return json(
        {
          error:
            'School name must be between 2 and 200 characters.',
        },
        400,
      );
    }

    if (city.length > MAX_CITY_LENGTH) {
      return json(
        {
          error:
            'City must be 100 characters or fewer.',
        },
        400,
      );
    }

    if (!isValidTimezone(timezone)) {
      return json(
        {
          error:
            'timezone must be a valid IANA timezone.',
        },
        400,
      );
    }

    const releaseEnabled =
      body?.releaseEnabled;

    if (
      typeof releaseEnabled !== 'boolean'
    ) {
      return json(
        {
          error:
            'releaseEnabled must be a boolean.',
        },
        400,
      );
    }

    const pickupLatitude =
      body?.pickupLatitude;

    if (
      !isFiniteNumber(pickupLatitude) ||
      pickupLatitude < -90 ||
      pickupLatitude > 90
    ) {
      return json(
        {
          error:
            'pickupLatitude must be a number between -90 and 90.',
        },
        400,
      );
    }

    const pickupLongitude =
      body?.pickupLongitude;

    if (
      !isFiniteNumber(pickupLongitude) ||
      pickupLongitude < -180 ||
      pickupLongitude > 180
    ) {
      return json(
        {
          error:
            'pickupLongitude must be a number between -180 and 180.',
        },
        400,
      );
    }

    const pickupRadiusMeters =
      body?.pickupRadiusMeters;

    if (
      !isFiniteNumber(pickupRadiusMeters) ||
      pickupRadiusMeters <
        MIN_PICKUP_RADIUS_METERS ||
      pickupRadiusMeters >
        MAX_PICKUP_RADIUS_METERS
    ) {
      return json(
        {
          error: `pickupRadiusMeters must be between ${MIN_PICKUP_RADIUS_METERS} and ${MAX_PICKUP_RADIUS_METERS}.`,
        },
        400,
      );
    }

    const pickupRequestLifetimeMinutes =
      body?.pickupRequestLifetimeMinutes;

    if (
      !isInteger(
        pickupRequestLifetimeMinutes,
      ) ||
      pickupRequestLifetimeMinutes <
        MIN_PICKUP_REQUEST_LIFETIME_MINUTES ||
      pickupRequestLifetimeMinutes >
        MAX_PICKUP_REQUEST_LIFETIME_MINUTES
    ) {
      return json(
        {
          error: `pickupRequestLifetimeMinutes must be between ${MIN_PICKUP_REQUEST_LIFETIME_MINUTES} and ${MAX_PICKUP_REQUEST_LIFETIME_MINUTES}.`,
        },
        400,
      );
    }

    const pickupReleaseMinutesBeforeBell =
      body?.pickupReleaseMinutesBeforeBell;

    if (
      !isInteger(
        pickupReleaseMinutesBeforeBell,
      ) ||
      pickupReleaseMinutesBeforeBell <
        MIN_RELEASE_MINUTES_BEFORE_BELL ||
      pickupReleaseMinutesBeforeBell >
        MAX_RELEASE_MINUTES_BEFORE_BELL
    ) {
      return json(
        {
          error: `pickupReleaseMinutesBeforeBell must be between ${MIN_RELEASE_MINUTES_BEFORE_BELL} and ${MAX_RELEASE_MINUTES_BEFORE_BELL}.`,
        },
        400,
      );
    }

    const pickupSessionDurationMinutes =
      body?.pickupSessionDurationMinutes;

    if (
      !isInteger(
        pickupSessionDurationMinutes,
      ) ||
      pickupSessionDurationMinutes <
        MIN_SESSION_DURATION_MINUTES ||
      pickupSessionDurationMinutes >
        MAX_SESSION_DURATION_MINUTES
    ) {
      return json(
        {
          error: `pickupSessionDurationMinutes must be between ${MIN_SESSION_DURATION_MINUTES} and ${MAX_SESSION_DURATION_MINUTES}.`,
        },
        400,
      );
    }

    const db = getAdminDb();

    let schoolId = '';
    let schoolRef:
      FirebaseFirestore.DocumentReference;

    let auditRef:
      FirebaseFirestore.DocumentReference;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      schoolId = makeSchoolId(name);
      schoolRef =
        db.collection('schools').doc(schoolId);

      auditRef =
        db.collection('platformAuditLog').doc(
          crypto.randomUUID(),
        );

      try {
        await db.runTransaction(
          async (transaction) => {
            const existing =
              await transaction.get(
                schoolRef,
              );

            if (existing.exists) {
              throw new SchoolConflictError();
            }

            transaction.create(
              schoolRef,
              {
                schoolId,
                name,
                ...(city
                  ? { city }
                  : {}),
                status: 'ACTIVE',
                timezone,
                releaseEnabled,
                pickupLatitude,
                pickupLongitude,
                pickupRadiusMeters,
                pickupRequestLifetimeMinutes,
                pickupReleaseMinutesBeforeBell,
                pickupSessionDurationMinutes,
                createdAt:
                  FieldValue.serverTimestamp(),
                updatedAt:
                  FieldValue.serverTimestamp(),
              },
            );

            transaction.create(
              auditRef,
              {
                actorUid: admin.uid,
                actorEmail:
                  admin.email,
                actorName: admin.name,
                eventType:
                  'PLATFORM_SCHOOL_CREATED',
                targetType: 'SCHOOL',
                targetId: schoolId,
                schoolId,
                createdAt:
                  FieldValue.serverTimestamp(),
              },
            );
          },
        );

        break;
      } catch (error) {
        if (
          error instanceof SchoolConflictError &&
          attempt < 2
        ) {
          continue;
        }

        throw error;
      }
    }

    return json(
      {
        ok: true,
        school: {
          schoolId,
          name,
          city,
          status: 'ACTIVE',
          timezone,
          releaseEnabled,
          pickupLatitude,
          pickupLongitude,
          pickupRadiusMeters,
          pickupRequestLifetimeMinutes,
          pickupReleaseMinutesBeforeBell,
          pickupSessionDurationMinutes,
        },
      },
      201,
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(
        { error: 'Invalid JSON request.' },
        400,
      );
    }

    return json(
      { error: 'Unable to create school.' },
      500,
    );
  }
}