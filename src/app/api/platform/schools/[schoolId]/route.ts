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

const VALID_STATUS = new Set([
  'ACTIVE',
  'INACTIVE',
  'SUSPENDED',
  'ARCHIVED',
]);

function json(body: unknown, status = 200): NextResponse {
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

function validCsrf(
  request: NextRequest,
  bodyToken: unknown,
): boolean {
  if (
    typeof bodyToken !== 'string' ||
    bodyToken.length < 32 ||
    bodyToken.length > 128
  ) {
    return false;
  }

  const cookieToken =
    request.cookies.get(CSRF_COOKIE)?.value;

  return !!cookieToken && cookieToken === bodyToken;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string'
    ? value.trim()
    : '';
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

function validateEditableFields(body: Record<string, unknown>) {
  const name = stringOrEmpty(body.name);
  const city = stringOrEmpty(body.city);
  const timezone = stringOrEmpty(body.timezone);
  const releaseEnabled = body.releaseEnabled;

  if (
    name.length < 2 ||
    name.length > MAX_NAME_LENGTH
  ) {
    return 'School name must be between 2 and 200 characters.';
  }

  if (city.length > MAX_CITY_LENGTH) {
    return 'City must be 100 characters or fewer.';
  }

  if (!isValidTimezone(timezone)) {
    return 'timezone must be a valid IANA timezone.';
  }

  if (typeof releaseEnabled !== 'boolean') {
    return 'releaseEnabled must be a boolean.';
  }

  const pickupLatitude = body.pickupLatitude;
  if (
    !isFiniteNumber(pickupLatitude) ||
    pickupLatitude < -90 ||
    pickupLatitude > 90
  ) {
    return 'pickupLatitude must be a number between -90 and 90.';
  }

  const pickupLongitude = body.pickupLongitude;
  if (
    !isFiniteNumber(pickupLongitude) ||
    pickupLongitude < -180 ||
    pickupLongitude > 180
  ) {
    return 'pickupLongitude must be a number between -180 and 180.';
  }

  const pickupRadiusMeters = body.pickupRadiusMeters;
  if (
    !isFiniteNumber(pickupRadiusMeters) ||
    pickupRadiusMeters < MIN_PICKUP_RADIUS_METERS ||
    pickupRadiusMeters > MAX_PICKUP_RADIUS_METERS
  ) {
    return `pickupRadiusMeters must be between ${MIN_PICKUP_RADIUS_METERS} and ${MAX_PICKUP_RADIUS_METERS}.`;
  }

  const pickupRequestLifetimeMinutes =
    body.pickupRequestLifetimeMinutes;
  if (
    !isInteger(pickupRequestLifetimeMinutes) ||
    pickupRequestLifetimeMinutes <
      MIN_PICKUP_REQUEST_LIFETIME_MINUTES ||
    pickupRequestLifetimeMinutes >
      MAX_PICKUP_REQUEST_LIFETIME_MINUTES
  ) {
    return `pickupRequestLifetimeMinutes must be between ${MIN_PICKUP_REQUEST_LIFETIME_MINUTES} and ${MAX_PICKUP_REQUEST_LIFETIME_MINUTES}.`;
  }

  const pickupReleaseMinutesBeforeBell =
    body.pickupReleaseMinutesBeforeBell;
  if (
    !isInteger(pickupReleaseMinutesBeforeBell) ||
    pickupReleaseMinutesBeforeBell <
      MIN_RELEASE_MINUTES_BEFORE_BELL ||
    pickupReleaseMinutesBeforeBell >
      MAX_RELEASE_MINUTES_BEFORE_BELL
  ) {
    return `pickupReleaseMinutesBeforeBell must be between ${MIN_RELEASE_MINUTES_BEFORE_BELL} and ${MAX_RELEASE_MINUTES_BEFORE_BELL}.`;
  }

  const pickupSessionDurationMinutes =
    body.pickupSessionDurationMinutes;
  if (
    !isInteger(pickupSessionDurationMinutes) ||
    pickupSessionDurationMinutes <
      MIN_SESSION_DURATION_MINUTES ||
    pickupSessionDurationMinutes >
      MAX_SESSION_DURATION_MINUTES
  ) {
    return `pickupSessionDurationMinutes must be between ${MIN_SESSION_DURATION_MINUTES} and ${MAX_SESSION_DURATION_MINUTES}.`;
  }

  return null;
}

export async function PATCH(
  request: NextRequest,
  context: {
    params: Promise<{ schoolId: string }>;
  },
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

    if (!validCsrf(request, body?.csrfToken)) {
      return json(
        { error: 'Invalid CSRF token.' },
        403,
      );
    }

    const { schoolId } = await context.params;
    const normalizedSchoolId = stringOrEmpty(schoolId);

    if (
      normalizedSchoolId.length < 1 ||
      normalizedSchoolId.length > 128
    ) {
      return json(
        { error: 'A valid school is required.' },
        400,
      );
    }

    const action =
      typeof body?.action === 'string'
        ? body.action.trim().toLowerCase()
        : 'update';

    const allowedActions = new Set([
      'update',
      'deactivate',
      'reactivate',
      'archive',
    ]);

    if (!allowedActions.has(action)) {
      return json(
        {
          error: 'invalid_action',
          message:
            'Use update, deactivate, reactivate, or archive.',
        },
        400,
      );
    }

    const db = getAdminDb();
    const schoolRef = db
      .collection('schools')
      .doc(normalizedSchoolId);

    const auditRef = db
      .collection('platformAuditLog')
      .doc(crypto.randomUUID());

    const editableError =
      action === 'update'
        ? validateEditableFields(
            body as Record<string, unknown>,
          )
        : null;

    if (editableError) {
      return json(
        { error: 'invalid_school', message: editableError },
        400,
      );
    }

    const result = await db.runTransaction(
      async (transaction) => {
        const schoolSnapshot =
          await transaction.get(schoolRef);

        if (!schoolSnapshot.exists) {
          return {
            kind: 'not_found' as const,
          };
        }

        const current =
          schoolSnapshot.data() ?? {};
        const currentStatus =
          typeof current.status === 'string'
            ? current.status
            : '';

        if (!VALID_STATUS.has(currentStatus)) {
          return {
            kind: 'invalid_status' as const,
            currentStatus,
          };
        }

        if (
          action === 'update' &&
          currentStatus === 'ARCHIVED'
        ) {
          return {
            kind: 'archived' as const,
          };
        }

        if (
          action === 'deactivate' &&
          currentStatus === 'ARCHIVED'
        ) {
          return {
            kind: 'archived' as const,
          };
        }

        if (
          action === 'reactivate' &&
          currentStatus === 'ARCHIVED'
        ) {
          return {
            kind: 'archived' as const,
          };
        }

        if (
          action === 'archive' &&
          currentStatus === 'ARCHIVED'
        ) {
          return {
            kind: 'already_archived' as const,
          };
        }

        let updateData:
          | Record<string, unknown>
          | null = null;
        let eventType = '';

        if (action === 'update') {
          updateData = {
            name: stringOrEmpty(body.name),
            city: stringOrEmpty(body.city),
            timezone: stringOrEmpty(body.timezone),
            releaseEnabled: body.releaseEnabled,
            pickupLatitude: body.pickupLatitude,
            pickupLongitude: body.pickupLongitude,
            pickupRadiusMeters: body.pickupRadiusMeters,
            pickupRequestLifetimeMinutes:
              body.pickupRequestLifetimeMinutes,
            pickupReleaseMinutesBeforeBell:
              body.pickupReleaseMinutesBeforeBell,
            pickupSessionDurationMinutes:
              body.pickupSessionDurationMinutes,
            updatedAt:
              FieldValue.serverTimestamp(),
          };
          eventType = 'PLATFORM_SCHOOL_UPDATED';
        } else if (action === 'deactivate') {
          updateData = {
            status: 'INACTIVE',
            updatedAt:
              FieldValue.serverTimestamp(),
          };
          eventType = 'PLATFORM_SCHOOL_DEACTIVATED';
        } else if (action === 'reactivate') {
          updateData = {
            status: 'ACTIVE',
            updatedAt:
              FieldValue.serverTimestamp(),
          };
          eventType = 'PLATFORM_SCHOOL_REACTIVATED';
        } else {
          updateData = {
            status: 'ARCHIVED',
            updatedAt:
              FieldValue.serverTimestamp(),
          };
          eventType = 'PLATFORM_SCHOOL_ARCHIVED';
        }

        transaction.update(
          schoolRef,
          updateData,
        );

        transaction.create(
          auditRef,
          {
            actorUid: admin.uid,
            actorEmail: admin.email,
            actorName: admin.name,
            eventType,
            targetType: 'SCHOOL',
            targetId: normalizedSchoolId,
            schoolId: normalizedSchoolId,
            createdAt:
              FieldValue.serverTimestamp(),
          },
        );

        return {
          kind: 'success' as const,
          eventType,
          status:
            typeof updateData.status === 'string'
              ? updateData.status
              : currentStatus,
        };
      },
    );

    if (result.kind === 'not_found') {
      return json(
        {
          error: 'school_not_found',
          message: 'The selected school does not exist.',
        },
        404,
      );
    }

    if (result.kind === 'invalid_status') {
      return json(
        {
          error: 'invalid_school_status',
          message:
            `School has unsupported status "${result.currentStatus}".`,
        },
        409,
      );
    }

    if (result.kind === 'archived') {
      return json(
        {
          error: 'school_archived',
          message:
            'Archived schools cannot be changed.',
        },
        409,
      );
    }

    if (result.kind === 'already_archived') {
      return json(
        {
          error: 'school_already_archived',
          message:
            'The school is already archived.',
        },
        409,
      );
    }

    const refreshed =
      await schoolRef.get();

    return json({
      ok: true,
      action,
      school: serializeSchool(refreshed),
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(
        { error: 'Invalid JSON request.' },
        400,
      );
    }

    return json(
      { error: 'Unable to update school.' },
      500,
    );
  }
}
