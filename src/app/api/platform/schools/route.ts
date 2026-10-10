import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import { createManualStudentCapacity, parseManualStudentLimit } from '@/lib/student-capacity.mjs';
import { getIanaTimezoneOptions, getSchoolConfigurationIssues, serializeManageSchool } from '@/lib/school-update';

const CSRF_COOKIE = 's2g_csrf';

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

function serializeSchool(snapshot: FirebaseFirestore.DocumentSnapshot) {
  return serializeManageSchool(snapshot.id, snapshot.data() ?? {}, {
    isValidStudentLimit: (value) => parseManualStudentLimit(value) !== null,
    allowZeroRadiusWhenDisabled: true,
  });
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

    const [
      schoolSnapshot,
      adminSnapshot,
      studentSnapshot,
    ] = await Promise.all([
      db
        .collection('schools')
        .get(),

      db
        .collection('users')
        .where('role', '==', 'SCHOOL_ADMIN')
        .get(),

      db
        .collectionGroup('students')
        .get(),
    ]);

    const adminCounts = new Map<string, number>();
    const activeAdminCounts = new Map<string, number>();

    for (const snapshot of adminSnapshot.docs) {
      const data = snapshot.data() ?? {};
      const schoolId =
        typeof data.schoolId === 'string'
          ? data.schoolId
          : '';

      if (!schoolId || data.status === 'ARCHIVED') {
        continue;
      }

      adminCounts.set(
        schoolId,
        (adminCounts.get(schoolId) ?? 0) + 1,
      );

      if (data.status === 'ACTIVE') {
        activeAdminCounts.set(
          schoolId,
          (activeAdminCounts.get(schoolId) ?? 0) + 1,
        );
      }
    }

    const studentCounts = new Map<string, number>();

    for (const snapshot of studentSnapshot.docs) {
      const data = snapshot.data() ?? {};
      const schoolId =
        typeof data.schoolId === 'string'
          ? data.schoolId
          : '';

      if (
        !schoolId ||
        data.status !== 'ACTIVE'
      ) {
        continue;
      }

      studentCounts.set(
        schoolId,
        (studentCounts.get(schoolId) ?? 0) + 1,
      );
    }

    const schools = schoolSnapshot.docs
      .filter(
        (doc) => doc.data()?.status !== 'ARCHIVED',
      )
      .map((doc) => {
        const school = serializeSchool(doc);

        return {
          ...school,
          adminCount:
            adminCounts.get(school.schoolId) ?? 0,
          activeAdminCount:
            activeAdminCounts.get(school.schoolId) ?? 0,
          studentCount:
            studentCounts.get(school.schoolId) ?? 0,
        };
      })
      .sort((a, b) =>
        (a.name ?? '').localeCompare(b.name ?? ''),
      );

    return json({
      ok: true,
      schools,
      timezoneOptions: getIanaTimezoneOptions(),
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
    const settings = {
      name,
      city,
      timezone,
      studentLimit: body?.studentLimit,
      releaseEnabled: body?.releaseEnabled,
      pickupLatitude: body?.pickupLatitude,
      pickupLongitude: body?.pickupLongitude,
      pickupRadiusMeters: body?.pickupRadiusMeters,
      pickupRequestLifetimeMinutes: body?.pickupRequestLifetimeMinutes,
      pickupReleaseMinutesBeforeBell: body?.pickupReleaseMinutesBeforeBell,
      pickupSessionDurationMinutes: body?.pickupSessionDurationMinutes,
    };
    const issues = getSchoolConfigurationIssues(settings, {
      isValidStudentLimit: (value) => parseManualStudentLimit(value) !== null,
      requirePickupTiming: true,
    });
    if (issues.length > 0) {
      return json(
        {
          error: 'invalid_school',
          message: 'Correct all highlighted school settings.',
          issues,
        },
        400,
      );
    }

    const capacityFields = createManualStudentCapacity(body?.studentLimit);
    if (!capacityFields) {
      return json(
        {
          error: 'invalid_school',
          message: 'Choose an approved student capacity.',
          issues: [{
            field: 'studentLimit',
            code: 'invalid_capacity',
            message: 'Choose one of the approved school-wide student capacity limits.',
          }],
        },
        400,
      );
    }
    const releaseEnabled = settings.releaseEnabled as boolean;
    const pickupLatitude = settings.pickupLatitude as number;
    const pickupLongitude = settings.pickupLongitude as number;
    const pickupRadiusMeters = settings.pickupRadiusMeters as number;
    const pickupRequestLifetimeMinutes = settings.pickupRequestLifetimeMinutes as number;
    const pickupReleaseMinutesBeforeBell = settings.pickupReleaseMinutesBeforeBell as number;
    const pickupSessionDurationMinutes = settings.pickupSessionDurationMinutes as number;

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
                ...capacityFields,
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
          ...capacityFields,
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