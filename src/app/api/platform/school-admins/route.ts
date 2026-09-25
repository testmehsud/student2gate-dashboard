import crypto from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';

import { FieldValue } from 'firebase-admin/firestore';

import {
  getAdminAuth,
  getAdminDb,
} from '@/lib/firebase-admin';

import { requirePlatformAdmin } from '@/lib/platform-auth';

const CSRF_COOKIE = 's2g_csrf';

const MIN_NAME_LENGTH = 2;
const MAX_NAME_LENGTH = 120;

const MAX_EMAIL_LENGTH = 320;

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

const VALID_STATUS = new Set([
  'ACTIVE',
  'INACTIVE',
  'ARCHIVED',
]);

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

function validOrigin(
  request: NextRequest,
): boolean {
  const expected =
    process.env.DASHBOARD_ORIGIN;

  const origin =
    request.headers.get('origin');

  return (
    !!expected &&
    !!origin &&
    origin === expected
  );
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
    request.cookies.get(
      CSRF_COOKIE,
    )?.value;

  return (
    !!cookieToken &&
    cookieToken === bodyToken
  );
}

function stringOrEmpty(
  value: unknown,
): string {
  return typeof value === 'string'
    ? value.trim()
    : '';
}

function validEmail(
  value: string,
): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_EMAIL_LENGTH &&
    /^\S+@\S+\.\S+$/.test(value)
  );
}

function serializeAdmin(
  snapshot: FirebaseFirestore.QueryDocumentSnapshot,
  schoolNames: Map<string, string>,
) {
  const data =
    snapshot.data() ?? {};

  const schoolId =
    typeof data.schoolId === 'string'
      ? data.schoolId
      : '';

  return {
    uid: snapshot.id,
    schoolId,

    schoolName:
      schoolNames.get(schoolId) ?? '',

    name:
      typeof data.name === 'string'
        ? data.name
        : '',

    username:
      typeof data.username === 'string'
        ? data.username
        : '',

    email:
      typeof data.email === 'string'
        ? data.email
        : '',

    role:
      typeof data.role === 'string'
        ? data.role
        : '',

    status:
      typeof data.status === 'string'
        ? data.status
        : '',
  };
}

async function getAuthorizedPlatformAdmin() {
  try {
    return await requirePlatformAdmin();
  } catch {
    return null;
  }
}

async function loadSchoolAdmin(
  uid: string,
) {
  const db = getAdminDb();

  const userRef =
    db.collection('users').doc(uid);

  const snapshot =
    await userRef.get();

  if (!snapshot.exists) {
    return null;
  }

  const data =
    snapshot.data() ?? {};

  if (
    data.role !==
    'SCHOOL_ADMIN'
  ) {
    return null;
  }

  return {
    db,
    userRef,
    data,
  };
}

function buildAdminResponse(
  uid: string,
  data: FirebaseFirestore.DocumentData,
  schoolName: string,
) {
  return {
    uid,

    schoolId:
      typeof data.schoolId === 'string'
        ? data.schoolId
        : '',

    schoolName,

    name:
      typeof data.name === 'string'
        ? data.name
        : '',

    username:
      typeof data.username === 'string'
        ? data.username
        : '',

    email:
      typeof data.email === 'string'
        ? data.email
        : '',

    role:
      typeof data.role === 'string'
        ? data.role
        : 'SCHOOL_ADMIN',

    status:
      typeof data.status === 'string'
        ? data.status
        : '',
  };
}

export async function GET() {
  const admin =
    await getAuthorizedPlatformAdmin();

  if (!admin) {
    return json(
      {
        error:
          'Platform Owner access required.',
      },
      401,
    );
  }

  try {
    const db = getAdminDb();

    const [
      schoolSnapshot,
      adminSnapshot,
    ] = await Promise.all([
      db
        .collection('schools')
        .get(),

      db
        .collection('users')
        .where(
          'role',
          '==',
          'SCHOOL_ADMIN',
        )
        .get(),
    ]);

    const schoolNames =
      new Map<string, string>();

    for (
      const school
      of schoolSnapshot.docs
    ) {
      const data =
        school.data() ?? {};

      schoolNames.set(
        school.id,
        typeof data.name === 'string'
          ? data.name
          : '',
      );
    }

    const admins =
      adminSnapshot.docs
        .map((snapshot) =>
          serializeAdmin(
            snapshot,
            schoolNames,
          ),
        )
        .filter(
          (item) =>
            item.status !== 'ARCHIVED',
        )
        .sort((a, b) => {
          const nameCompare =
            a.name.localeCompare(
              b.name,
            );

          if (nameCompare !== 0) {
            return nameCompare;
          }

          return a.email.localeCompare(
            b.email,
          );
        });

    return json({
      ok: true,
      admins,
    });
  } catch {
    return json(
      {
        error:
          'Unable to load School Admins.',
      },
      500,
    );
  }
}

export async function POST(
  request: NextRequest,
) {
  const admin =
    await getAuthorizedPlatformAdmin();

  if (!admin) {
    return json(
      {
        error:
          'Platform Owner access required.',
      },
      401,
    );
  }

  if (!validOrigin(request)) {
    return json(
      {
        error:
          'Invalid request origin.',
      },
      403,
    );
  }

  try {
    const body =
      await request.json();

    if (
      !validCsrf(
        request,
        body?.csrfToken,
      )
    ) {
      return json(
        {
          error:
            'Invalid CSRF token.',
        },
        403,
      );
    }

    const name =
      stringOrEmpty(body?.name);

    const email =
      stringOrEmpty(body?.email)
        .toLowerCase();

    const password =
      typeof body?.password ===
      'string'
        ? body.password
        : '';

    const confirmPassword =
      typeof body?.confirmPassword ===
      'string'
        ? body.confirmPassword
        : '';

    const schoolId =
      stringOrEmpty(
        body?.schoolId,
      );

    if (
      name.length <
        MIN_NAME_LENGTH ||
      name.length >
        MAX_NAME_LENGTH
    ) {
      return json(
        {
          error:
            'Name must be between 2 and 120 characters.',
        },
        400,
      );
    }

    if (!validEmail(email)) {
      return json(
        {
          error:
            'A valid email address is required.',
        },
        400,
      );
    }

    if (
      password.length <
        MIN_PASSWORD_LENGTH ||
      password.length >
        MAX_PASSWORD_LENGTH
    ) {
      return json(
        {
          error:
            `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
        },
        400,
      );
    }

    if (
      password !==
      confirmPassword
    ) {
      return json(
        {
          error:
            'Password and confirmation must match.',
        },
        400,
      );
    }

    if (
      schoolId.length < 1 ||
      schoolId.length > 128
    ) {
      return json(
        {
          error:
            'A valid school is required.',
        },
        400,
      );
    }

    const db = getAdminDb();

    const schoolRef =
      db
        .collection('schools')
        .doc(schoolId);

    const schoolSnapshot =
      await schoolRef.get();

    if (!schoolSnapshot.exists) {
      return json(
        {
          error:
            'school_not_found',
          message:
            'The selected school does not exist.',
        },
        404,
      );
    }

    const schoolData =
      schoolSnapshot.data() ?? {};

    if (
      schoolData.status !==
      'ACTIVE'
    ) {
      return json(
        {
          error:
            'school_not_active',
          message:
            'School Admins can only be created for an active school.',
        },
        409,
      );
    }

    let createdUid = '';

    try {
      const created =
        await getAdminAuth()
          .createUser({
            email,
            password,
            displayName: name,
            disabled: false,
          });

      createdUid =
        created.uid;

      const userRef =
        db
          .collection('users')
          .doc(createdUid);

      const auditRef =
        db
          .collection(
            'platformAuditLog',
          )
          .doc(
            crypto.randomUUID(),
          );

      await db.runTransaction(
        async (transaction) => {
          const [
            existingUser,
            currentSchool,
          ] = await Promise.all([
            transaction.get(
              userRef,
            ),

            transaction.get(
              schoolRef,
            ),
          ]);

          if (
            existingUser.exists
          ) {
            throw new Error(
              'USER_PROFILE_ALREADY_EXISTS',
            );
          }

          if (
            !currentSchool.exists ||
            currentSchool.data()
              ?.status !== 'ACTIVE'
          ) {
            throw new Error(
              'SCHOOL_NOT_ACTIVE',
            );
          }

          transaction.create(
            userRef,
            {
              uid: createdUid,
              schoolId,
              role: 'SCHOOL_ADMIN',
              name,
              email,
              status: 'ACTIVE',

              createdByUid:
                admin.uid,

              createdAt:
                FieldValue.serverTimestamp(),

              updatedAt:
                FieldValue.serverTimestamp(),
            },
          );

          transaction.create(
            auditRef,
            {
              actorUid:
                admin.uid,

              actorEmail:
                admin.email,

              actorName:
                admin.name,

              eventType:
                'PLATFORM_SCHOOL_ADMIN_CREATED',

              targetType:
                'USER',

              targetId:
                createdUid,

              schoolId,

              createdAt:
                FieldValue.serverTimestamp(),
            },
          );
        },
      );
    } catch (error) {
      if (createdUid) {
        try {
          await getAdminAuth()
            .deleteUser(
              createdUid,
            );
        } catch {
          // Avoid masking the original provisioning error.
        }
      }

      const code =
        typeof error === 'object' &&
        error !== null &&
        'code' in error
          ? String(
              (
                error as {
                  code?: unknown;
                }
              ).code ?? '',
            )
          : '';

      if (
        code ===
        'auth/email-already-exists'
      ) {
        return json(
          {
            error:
              'email_already_exists',
            message:
              'A Firebase account already uses this email address.',
          },
          409,
        );
      }

      if (
        code ===
        'auth/invalid-password'
      ) {
        return json(
          {
            error:
              'invalid_password',
            message:
              `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
          },
          400,
        );
      }

      if (
        code ===
        'auth/invalid-email'
      ) {
        return json(
          {
            error:
              'invalid_email',
            message:
              'A valid email address is required.',
          },
          400,
        );
      }

      if (
        error instanceof Error &&
        error.message ===
          'SCHOOL_NOT_ACTIVE'
      ) {
        return json(
          {
            error:
              'school_not_active',
            message:
              'School Admins can only be created for an active school.',
          },
          409,
        );
      }

      if (
        error instanceof Error &&
        error.message ===
          'USER_PROFILE_ALREADY_EXISTS'
      ) {
        return json(
          {
            error:
              'admin_profile_exists',
            message:
              'This Firebase user already has a Student2Gate profile.',
          },
          409,
        );
      }

      throw error;
    }

    const schoolName =
      typeof schoolData.name ===
      'string'
        ? schoolData.name
        : '';

    return json(
      {
        ok: true,

        admin: {
          uid: createdUid,
          schoolId,
          schoolName,
          name,
          email,
          role:
            'SCHOOL_ADMIN',
          status: 'ACTIVE',
        },
      },
      201,
    );
  } catch (error) {
    if (
      error instanceof SyntaxError
    ) {
      return json(
        {
          error:
            'Invalid JSON request.',
        },
        400,
      );
    }

    return json(
      {
        error:
          'Unable to create School Admin.',
      },
      500,
    );
  }
}

export async function PATCH(
  request: NextRequest,
) {
  const admin =
    await getAuthorizedPlatformAdmin();

  if (!admin) {
    return json(
      {
        error:
          'Platform Owner access required.',
      },
      401,
    );
  }

  if (!validOrigin(request)) {
    return json(
      {
        error:
          'Invalid request origin.',
      },
      403,
    );
  }

  try {
    const body =
      await request.json();

    if (
      !validCsrf(
        request,
        body?.csrfToken,
      )
    ) {
      return json(
        {
          error:
            'Invalid CSRF token.',
        },
        403,
      );
    }

    const uid =
      stringOrEmpty(
        body?.uid,
      );

    if (
      uid.length < 1 ||
      uid.length > 128
    ) {
      return json(
        {
          error:
            'A valid School Admin is required.',
        },
        400,
      );
    }

    const action =
      typeof body?.action ===
      'string'
        ? body.action
            .trim()
            .toLowerCase()
        : '';

    const allowedActions =
      new Set([
        'update',
        'deactivate',
        'reactivate',
        'archive',
        'reset_password',
      ]);

    if (
      !allowedActions.has(action)
    ) {
      return json(
        {
          error:
            'invalid_action',
          message:
            'Use update, deactivate, reactivate, archive, or reset_password.',
        },
        400,
      );
    }

    const loaded =
      await loadSchoolAdmin(uid);

    if (!loaded) {
      return json(
        {
          error:
            'school_admin_not_found',
          message:
            'The selected School Admin does not exist.',
        },
        404,
      );
    }

    const {
      db,
      userRef,
      data,
    } = loaded;

    const currentStatus =
      typeof data.status ===
      'string'
        ? data.status
        : '';

    if (
      !VALID_STATUS.has(
        currentStatus,
      )
    ) {
      return json(
        {
          error:
            'invalid_school_admin_status',
          message:
            `School Admin has unsupported status "${currentStatus}".`,
        },
        409,
      );
    }

    if (
      currentStatus ===
      'ARCHIVED'
    ) {
      return json(
        {
          error:
            'school_admin_archived',
          message:
            'Archived School Admins cannot be changed.',
        },
        409,
      );
    }

    const schoolId =
      typeof data.schoolId ===
      'string'
        ? data.schoolId
        : '';

    if (!schoolId) {
      return json(
        {
          error:
            'school_missing',
          message:
            'The School Admin is not linked to a school.',
        },
        409,
      );
    }

    const schoolRef =
      db
        .collection('schools')
        .doc(schoolId);

    const schoolSnapshot =
      await schoolRef.get();

    if (!schoolSnapshot.exists) {
      return json(
        {
          error:
            'school_not_found',
          message:
            'The School Admin school does not exist.',
        },
        404,
      );
    }

    const schoolData =
      schoolSnapshot.data() ?? {};

    const schoolName =
      typeof schoolData.name ===
      'string'
        ? schoolData.name
        : '';

    const firebaseAuth =
      getAdminAuth();

    if (
      action ===
      'update'
    ) {
      const name =
        typeof body?.name === 'string'
          ? body.name.trim()
          : '';

      const email =
        typeof body?.email === 'string'
          ? body.email.trim().toLowerCase()
          : '';

      const nextSchoolId =
        typeof body?.schoolId === 'string'
          ? body.schoolId.trim()
          : '';

      if (
        name.length < MIN_NAME_LENGTH ||
        name.length > MAX_NAME_LENGTH
      ) {
        return json(
          {
            error: 'invalid_name',
            message:
              `Name must be ${MIN_NAME_LENGTH}-${MAX_NAME_LENGTH} characters.`,
          },
          400,
        );
      }

      if (
        email.length < 3 ||
        email.length > MAX_EMAIL_LENGTH ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return json(
          {
            error: 'invalid_email',
            message: 'A valid email address is required.',
          },
          400,
        );
      }

      if (
        nextSchoolId.length < 1 ||
        nextSchoolId.length > 128
      ) {
        return json(
          {
            error: 'invalid_school',
            message: 'A valid school is required.',
          },
          400,
        );
      }

      const nextSchoolRef =
        db
          .collection('schools')
          .doc(nextSchoolId);

      const nextSchoolSnapshot =
        await nextSchoolRef.get();

      if (!nextSchoolSnapshot.exists) {
        return json(
          {
            error: 'school_not_found',
            message: 'The selected school does not exist.',
          },
          404,
        );
      }

      const nextSchoolData =
        nextSchoolSnapshot.data() ?? {};

      if (
        nextSchoolData.status !==
        'ACTIVE'
      ) {
        return json(
          {
            error: 'school_not_active',
            message:
              'School Admins can only be assigned to an active school.',
          },
          409,
        );
      }

      const firebaseAuth =
        getAdminAuth();

      const emailOwner =
        await firebaseAuth
          .getUserByEmail(email)
          .catch((error) => {
            const code =
              typeof error === 'object' &&
              error !== null &&
              'code' in error
                ? String(
                    (
                      error as {
                        code?: unknown;
                      }
                    ).code ?? '',
                  )
                : '';

            if (
              code ===
              'auth/user-not-found'
            ) {
              return null;
            }

            throw error;
          });

      if (
        emailOwner &&
        emailOwner.uid !== uid
      ) {
        return json(
          {
            error: 'email_already_exists',
            message:
              'Another Firebase account already uses this email address.',
          },
          409,
        );
      }

      const currentAuthUser =
        await firebaseAuth.getUser(uid);

      const previousEmail =
        currentAuthUser.email ?? '';

      try {
        await firebaseAuth.updateUser(
          uid,
          {
            displayName: name,
            email,
          },
        );

        const auditRef =
          db
            .collection('platformAuditLog')
            .doc(
              crypto.randomUUID(),
            );

        await db.runTransaction(
          async (transaction) => {
            const current =
              await transaction.get(
                userRef,
              );

            if (!current.exists) {
              throw new Error(
                'ADMIN_NOT_FOUND',
              );
            }

            const currentData =
              current.data() ?? {};

            if (
              currentData.role !==
              'SCHOOL_ADMIN'
            ) {
              throw new Error(
                'INVALID_ADMIN_ROLE',
              );
            }

            if (
              currentData.status ===
              'ARCHIVED'
            ) {
              throw new Error(
                'ADMIN_ALREADY_ARCHIVED',
              );
            }

            transaction.update(
              userRef,
              {
                name,
                email,
                schoolId:
                  nextSchoolId,
                updatedAt:
                  FieldValue.serverTimestamp(),
              },
            );

            transaction.create(
              auditRef,
              {
                actorUid:
                  admin.uid,
                actorEmail:
                  admin.email,
                actorName:
                  admin.name,
                eventType:
                  'PLATFORM_SCHOOL_ADMIN_UPDATED',
                targetType:
                  'USER',
                targetId:
                  uid,
                previousSchoolId:
                  typeof currentData.schoolId === 'string'
                    ? currentData.schoolId
                    : '',
                schoolId:
                  nextSchoolId,
                changedName:
                  currentData.name !== name,
                changedEmail:
                  currentData.email !== email,
                createdAt:
                  FieldValue.serverTimestamp(),
              },
            );
          },
        );
      } catch (error) {
        try {
          const rollback: {
            displayName?: string;
            email?: string;
          } = {};

          if (currentAuthUser.displayName !== null) {
            rollback.displayName =
              currentAuthUser.displayName;
          }

          if (previousEmail) {
            rollback.email =
              previousEmail;
          }

          await firebaseAuth.updateUser(
            uid,
            rollback,
          );
        } catch {
          // Avoid masking the original update error.
        }

        if (error instanceof Error) {
          if (
            error.message ===
            'ADMIN_NOT_FOUND'
          ) {
            return json(
              {
                error:
                  'school_admin_not_found',
                message:
                  'The selected School Admin no longer exists.',
              },
              404,
            );
          }

          if (
            error.message ===
            'INVALID_ADMIN_ROLE'
          ) {
            return json(
              {
                error:
                  'invalid_admin_role',
                message:
                  'The selected account is not a School Admin.',
              },
              409,
            );
          }

          if (
            error.message ===
            'ADMIN_ALREADY_ARCHIVED'
          ) {
            return json(
              {
                error:
                  'school_admin_archived',
                message:
                  'Archived School Admins cannot be changed.',
              },
              409,
            );
          }
        }

        throw error;
      }

      return json({
        ok: true,
        action,
        admin:
          buildAdminResponse(
            uid,
            {
              ...data,
              name,
              email,
              schoolId:
                nextSchoolId,
            },
            typeof nextSchoolData.name === 'string'
              ? nextSchoolData.name
              : '',
          ),
      });
    }
    if (
      action ===
      'reset_password'
    ) {
      const password =
        typeof body?.password ===
        'string'
          ? body.password
          : '';

      const confirmPassword =
        typeof body?.confirmPassword ===
        'string'
          ? body.confirmPassword
          : '';

      if (
        password.length <
          MIN_PASSWORD_LENGTH ||
        password.length >
          MAX_PASSWORD_LENGTH
      ) {
        return json(
          {
            error:
              'invalid_password',
            message:
              `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
          },
          400,
        );
      }

      if (
        password !==
        confirmPassword
      ) {
        return json(
          {
            error:
              'password_mismatch',
            message:
              'Password and confirmation must match.',
          },
          400,
        );
      }

      try {
        await firebaseAuth.updateUser(
          uid,
          {
            password,
          },
        );
      } catch (error) {
        const code =
          typeof error === 'object' &&
          error !== null &&
          'code' in error
            ? String(
                (
                  error as {
                    code?: unknown;
                  }
                ).code ?? '',
              )
            : '';

        if (
          code ===
          'auth/user-not-found'
        ) {
          return json(
            {
              error:
                'firebase_user_not_found',
              message:
                'The Firebase account for this School Admin does not exist.',
            },
            404,
          );
        }

        if (
          code ===
          'auth/invalid-password'
        ) {
          return json(
            {
              error:
                'invalid_password',
              message:
                `Password must be ${MIN_PASSWORD_LENGTH}-${MAX_PASSWORD_LENGTH} characters.`,
            },
            400,
          );
        }

        throw error;
      }

      const auditRef =
        db
          .collection(
            'platformAuditLog',
          )
          .doc(
            crypto.randomUUID(),
          );

      try {
        await db.runTransaction(
          async (transaction) => {
            const current =
              await transaction.get(
                userRef,
              );

            if (!current.exists) {
              throw new Error(
                'ADMIN_NOT_FOUND_AFTER_PASSWORD_RESET',
              );
            }

            transaction.update(
              userRef,
              {
                updatedAt:
                  FieldValue.serverTimestamp(),
              },
            );

            transaction.create(
              auditRef,
              {
                actorUid:
                  admin.uid,

                actorEmail:
                  admin.email,

                actorName:
                  admin.name,

                eventType:
                  'PLATFORM_SCHOOL_ADMIN_PASSWORD_RESET',

                targetType:
                  'USER',

                targetId:
                  uid,

                schoolId,

                createdAt:
                  FieldValue.serverTimestamp(),
              },
            );
          },
        );
      } catch (error) {
        throw error;
      }

      return json({
        ok: true,
        action,
        admin:
          buildAdminResponse(
            uid,
            data,
            schoolName,
          ),
      });
    }

    let nextStatus =
      currentStatus;

    let eventType =
      '';

    let firebaseDisabled =
      false;

    if (
      action ===
      'deactivate'
    ) {
      if (
        currentStatus ===
        'INACTIVE'
      ) {
        return json(
          {
            error:
              'school_admin_already_inactive',
            message:
              'The School Admin is already inactive.',
          },
          409,
        );
      }

      nextStatus =
        'INACTIVE';

      eventType =
        'PLATFORM_SCHOOL_ADMIN_DEACTIVATED';

      firebaseDisabled =
        true;
    } else if (
      action ===
      'reactivate'
    ) {
      if (
        currentStatus ===
        'ACTIVE'
      ) {
        return json(
          {
            error:
              'school_admin_already_active',
            message:
              'The School Admin is already active.',
          },
          409,
        );
      }

      if (
        schoolData.status !==
        'ACTIVE'
      ) {
        return json(
          {
            error:
              'school_not_active',
            message:
              'A School Admin cannot be reactivated while the school is not active.',
          },
          409,
        );
      }

      nextStatus =
        'ACTIVE';

      eventType =
        'PLATFORM_SCHOOL_ADMIN_REACTIVATED';

      firebaseDisabled =
        false;
    } else {
      nextStatus =
        'ARCHIVED';

      eventType =
        'PLATFORM_SCHOOL_ADMIN_ARCHIVED';

      firebaseDisabled =
        true;
    }

    const authUser =
      await firebaseAuth.getUser(
        uid,
      );

    const previousDisabled =
      authUser.disabled;

    try {
      await firebaseAuth.updateUser(
        uid,
        {
          disabled:
            firebaseDisabled,
        },
      );

      const auditRef =
        db
          .collection(
            'platformAuditLog',
          )
          .doc(
            crypto.randomUUID(),
          );

      await db.runTransaction(
        async (transaction) => {
          const current =
            await transaction.get(
              userRef,
            );

          if (!current.exists) {
            throw new Error(
              'ADMIN_NOT_FOUND',
            );
          }

          const currentData =
            current.data() ?? {};

          if (
            currentData.role !==
            'SCHOOL_ADMIN'
          ) {
            throw new Error(
              'INVALID_ADMIN_ROLE',
            );
          }

          if (
            currentData.status ===
            'ARCHIVED'
          ) {
            throw new Error(
              'ADMIN_ALREADY_ARCHIVED',
            );
          }

          transaction.update(
            userRef,
            {
              status:
                nextStatus,

              updatedAt:
                FieldValue.serverTimestamp(),
            },
          );

          transaction.create(
            auditRef,
            {
              actorUid:
                admin.uid,

              actorEmail:
                admin.email,

              actorName:
                admin.name,

              eventType,

              targetType:
                'USER',

              targetId:
                uid,

              schoolId,

              createdAt:
                FieldValue.serverTimestamp(),
            },
          );
        },
      );
    } catch (error) {
      try {
        await firebaseAuth.updateUser(
          uid,
          {
            disabled:
              previousDisabled,
          },
        );
      } catch {
        // Avoid masking the original state-change error.
      }

      if (
        error instanceof Error
      ) {
        if (
          error.message ===
          'ADMIN_NOT_FOUND'
        ) {
          return json(
            {
              error:
                'school_admin_not_found',
              message:
                'The selected School Admin no longer exists.',
            },
            404,
          );
        }

        if (
          error.message ===
          'INVALID_ADMIN_ROLE'
        ) {
          return json(
            {
              error:
                'invalid_admin_role',
              message:
                'The selected account is not a School Admin.',
            },
            409,
          );
        }

        if (
          error.message ===
          'ADMIN_ALREADY_ARCHIVED'
        ) {
          return json(
            {
              error:
                'school_admin_archived',
              message:
                'Archived School Admins cannot be changed.',
            },
            409,
          );
        }
      }

      throw error;
    }

    const updatedData = {
      ...data,
      status:
        nextStatus,
    };

    return json({
      ok: true,
      action,
      admin:
        buildAdminResponse(
          uid,
          updatedData,
          schoolName,
        ),
    });
  } catch (error) {
    if (
      error instanceof SyntaxError
    ) {
      return json(
        {
          error:
            'Invalid JSON request.',
        },
        400,
      );
    }

    return json(
      {
        error:
          'Unable to manage School Admin.',
      },
      500,
    );
  }
}