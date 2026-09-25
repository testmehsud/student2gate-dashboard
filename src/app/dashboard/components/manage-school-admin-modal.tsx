'use client';

import { type FormEvent, useState } from 'react';

type ManageSchoolAdmin = {
  uid: string;
  schoolId: string;
  schoolName: string;
  username: string;
  name: string;
  email: string;
  role: string;
  status: string;
};

type SchoolOption = {
  schoolId: string;
  name: string;
  status: string;
};

type AdminAction =
  | 'update'
  | 'deactivate'
  | 'reactivate'
  | 'archive'
  | 'reset_password';

export default function ManageSchoolAdminModal({
  admin,
  schools,
  onClose,
  onUpdated,
}: {
  admin: ManageSchoolAdmin;
  schools: SchoolOption[];
  onClose: () => void;
  onUpdated: (admin: ManageSchoolAdmin) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [resetMode, setResetMode] = useState(false);
  const [name, setName] = useState(admin.name);
  const [email, setEmail] = useState(admin.email);
  const [schoolId, setSchoolId] = useState(admin.schoolId);

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] =
    useState('');

  const archived =
    admin.status === 'ARCHIVED';

  async function request(
    action: AdminAction,
    updates?: {
      name?: string;
      email?: string;
      schoolId?: string;
    },
  ) {
    if (busy || archived) {
      return;
    }

    setBusy(true);
    setError('');

    try {
      const csrfResponse = await fetch(
        '/api/auth/csrf',
        {
          credentials: 'same-origin',
          cache: 'no-store',
        },
      );

      const csrfResult =
        await csrfResponse
          .json()
          .catch(() => null);

      if (
        !csrfResponse.ok ||
        typeof csrfResult?.token !==
          'string'
      ) {
        throw new Error(
          'Unable to start secure School Admin management.',
        );
      }

      const body: Record<
        string,
        unknown
      > = {
        csrfToken:
          csrfResult.token,
        uid: admin.uid,
        action,
      };

      if (
        action ===
        'update' &&
        updates
      ) {
        body.name =
          updates.name ?? name.trim();
        body.email =
          updates.email ?? email.trim();
        body.schoolId =
          updates.schoolId ?? schoolId.trim();
      }

      if (
        action ===
        'reset_password'
      ) {
        body.password = password;
        body.confirmPassword =
          confirmPassword;
      }

      const response =
        await fetch(
          '/api/platform/school-admins',
          {
            method: 'PATCH',
            credentials:
              'same-origin',
            headers: {
              'Content-Type':
                'application/json',
            },
            body:
              JSON.stringify(body),
          },
        );

      const result =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof result?.message ===
            'string'
            ? result.message
            : typeof result?.error ===
                'string'
              ? result.error
              : 'Unable to manage School Admin.',
        );
      }

      if (!result?.admin) {
        throw new Error(
          'No School Admin data was returned.',
        );
      }

      setPassword('');
      setConfirmPassword('');
      setResetMode(false);

      onUpdated(
        result.admin as ManageSchoolAdmin,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to manage School Admin.',
      );
    } finally {
      setBusy(false);
    }
  }

  function confirmAction(
    action:
      | 'deactivate'
      | 'archive',
  ) {
    if (action === 'deactivate') {
      if (
        window.confirm(
          `Deactivate ${admin.name}? They will no longer be able to sign in.`,
        )
      ) {
        void request('deactivate');
      }

      return;
    }

    if (
      window.confirm(
        `Archive ${admin.name}? The account will be hidden from normal School Admin lists.`,
      )
    ) {
      void request('archive');
    }
  }

  function handleResetSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();
    void request('reset_password');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-school-admin-title"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <div className="panel-kicker">
              Privileged access
            </div>

            <h2
              id="manage-school-admin-title"
              className="text-2xl font-bold text-slate-900"
            >
              Manage School Admin
            </h2>

            <p className="mt-1 text-sm text-slate-600">
              Manage access for this School Admin.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3 py-2 text-slate-500 hover:bg-slate-100"
            aria-label="Close"
          >
            ×
          </button>
        </div>

        <div className="space-y-6 p-6">
          <section>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                Account details
              </h3>

              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {admin.status}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Name
                </span>
                <input
                  type="text"
                  value={name}
                  onChange={(event) =>
                    setName(event.target.value)
                  }
                  maxLength={120}
                  required
                  disabled={busy}
                  autoComplete="name"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Email
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(event) =>
                    setEmail(event.target.value)
                  }
                  maxLength={320}
                  required
                  disabled={busy}
                  autoComplete="email"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 text-slate-900 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  School
                </span>
                <select
                  value={schoolId}
                  onChange={(event) =>
                    setSchoolId(event.target.value)
                  }
                  required
                  disabled={busy}
                  className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3 text-slate-900 outline-none focus:border-slate-500"
                >
                  {schools
                    .filter(
                      (school) =>
                        school.status === 'ACTIVE' ||
                        school.schoolId === admin.schoolId,
                    )
                    .map((school) => (
                      <option
                        key={school.schoolId}
                        value={school.schoolId}
                      >
                        {school.name}
                      </option>
                    ))}
                </select>
              </label>

              <div>
                <div className="text-xs font-medium uppercase tracking-wide text-slate-400">
                  Role
                </div>
                <div className="mt-1 text-sm font-semibold text-slate-800">
                  {admin.role}
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                disabled={busy || archived}
                onClick={() =>
                  void request('update', {
                    name: name.trim(),
                    email: email.trim(),
                    schoolId: schoolId.trim(),
                  })
                }
                className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {busy ? 'Saving...' : 'Save changes'}
              </button>
            </div>
          </section>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          {!archived && (
            <section>
              <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
                Account actions
              </h3>

              <div className="flex flex-wrap gap-2">
                {admin.status ===
                'INACTIVE' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void request(
                        'reactivate',
                      )
                    }
                    className="rounded-xl border border-emerald-300 px-4 py-2 text-sm font-semibold text-emerald-700 hover:bg-emerald-50"
                  >
                    Reactivate
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      confirmAction(
                        'deactivate',
                      )
                    }
                    className="rounded-xl border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-50"
                  >
                    Deactivate
                  </button>
                )}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setError('');
                    setResetMode(
                      (current) =>
                        !current,
                    );
                  }}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
                >
                  Reset password
                </button>

                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    confirmAction(
                      'archive',
                    )
                  }
                  className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  Archive
                </button>
              </div>
            </section>
          )}

          {resetMode && !archived && (
            <form
              onSubmit={
                handleResetSubmit
              }
              className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5"
            >
              <div>
                <h3 className="text-sm font-semibold text-slate-800">
                  Reset password
                </h3>

                <p className="mt-1 text-xs text-slate-500">
                  Set a new password for this
                  School Admin.
                </p>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">
                    New password
                  </span>

                  <input
                    type="password"
                    value={password}
                    onChange={(event) =>
                      setPassword(
                        event.target
                          .value,
                      )
                    }
                    minLength={8}
                    maxLength={128}
                    required
                    disabled={busy}
                    autoComplete="new-password"
                    placeholder="At least 8 characters"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  />
                </label>

                <label className="block">
                  <span className="mb-1 block text-sm font-medium text-slate-700">
                    Confirm password
                  </span>

                  <input
                    type="password"
                    value={
                      confirmPassword
                    }
                    onChange={(event) =>
                      setConfirmPassword(
                        event.target
                          .value,
                      )
                    }
                    minLength={8}
                    maxLength={128}
                    required
                    disabled={busy}
                    autoComplete="new-password"
                    placeholder="Re-enter password"
                    className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                  />
                </label>
              </div>

              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setResetMode(
                      false,
                    );
                    setPassword('');
                    setConfirmPassword(
                      '',
                    );
                  }}
                  className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-white"
                >
                  Cancel
                </button>

                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  {busy
                    ? 'Saving...'
                    : 'Set new password'}
                </button>
              </div>
            </form>
          )}

          {archived && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
              This School Admin is archived and
              cannot be changed.
            </div>
          )}

          <div className="flex justify-end border-t border-slate-200 pt-5">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}