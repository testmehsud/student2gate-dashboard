import crypto from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { FieldValue } from 'firebase-admin/firestore';

import { getAdminDb } from '@/lib/firebase-admin';
import { requirePlatformAdmin } from '@/lib/platform-auth';
import { parseManualStudentLimit, validateManualStudentCapacity } from '@/lib/student-capacity.mjs';
import { getSchoolConfigurationIssues, mergeManageSchoolPatch, selectManageSchoolPatch, serializeManageSchool } from '@/lib/school-update';

const CSRF_COOKIE = 's2g_csrf';

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
            issues: [{
              field: 'status',
              code: 'invalid_status',
              message: 'The saved school status is not recognized. This lifecycle value cannot be repaired in Manage School.',
            }],
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
          const schoolUpdate = mergeManageSchoolPatch(current, body);
          const issues = getSchoolConfigurationIssues(
            { ...schoolUpdate, schoolId: current.schoolId, status: current.status },
            {
              isValidStudentLimit: (value) => parseManualStudentLimit(value) !== null,
              allowZeroRadiusWhenDisabled: true,
              expectedSchoolId: normalizedSchoolId,
            },
          );
          if (issues.length > 0) {
            return { kind: 'invalid_school' as const, issues };
          }

          const studentLimit = parseManualStudentLimit(schoolUpdate.studentLimit);
          let activeStudentCount = current.activeStudentCount;
          const currentLimit = current.studentLimit;
          const consistent = Number.isSafeInteger(currentLimit) && currentLimit > 0 && Number.isSafeInteger(activeStudentCount) && activeStudentCount >= 0 && activeStudentCount <= currentLimit;
          if (!consistent) {
            const activeStudents = await transaction.get(schoolRef.collection('students').where('status', '==', 'ACTIVE'));
            activeStudentCount = activeStudents.size;
          }
          const capacity = validateManualStudentCapacity(studentLimit, activeStudentCount);
          if (!capacity.ok) return { kind: 'capacity_invalid' as const, activeStudentCount };
          updateData = {
            ...selectManageSchoolPatch(body),
            studentLimit: capacity.studentLimit,
            activeStudentCount: capacity.activeStudentCount,
            updatedAt: FieldValue.serverTimestamp(),
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

    if (result.kind === 'invalid_school') {
      return json(
        { error: 'invalid_school', message: 'Correct all highlighted school settings.', issues: result.issues },
        400,
      );
    }

    if (result.kind === 'invalid_status') {
      return json(
        {
          error: 'invalid_school_status',
          message: 'The saved school status is not recognized.',
          issues: result.issues,
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

    if (result.kind === 'capacity_invalid') {
      return json(
        {
          error: 'invalid_student_capacity',
          message: 'Student capacity must be at least the current active student count (' + result.activeStudentCount + ').',
          issues: [{
            field: 'studentLimit',
            code: 'below_active_student_count',
            message: 'Choose a limit that is at least the current active student count (' + result.activeStudentCount + ').',
          }],
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
