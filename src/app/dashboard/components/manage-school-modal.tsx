'use client';

import { FormEvent, useState } from 'react';

type ManageSchool = {
  schoolId: string;
  name: string;
  city: string;
  status: string;
  timezone: string;
  releaseEnabled: boolean;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  pickupRadiusMeters: number | null;
  pickupRequestLifetimeMinutes: number | null;
  pickupReleaseMinutesBeforeBell: number | null;
  pickupSessionDurationMinutes: number | null;
};

export default function ManageSchoolModal({
  school,
  onClose,
  onUpdated,
}: {
  school: ManageSchool;
  onClose: () => void;
  onUpdated: (school: ManageSchool) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function request(
    action:
      | 'update'
      | 'deactivate'
      | 'reactivate'
      | 'archive',
    form?: HTMLFormElement,
  ) {
    if (busy) return;

    setBusy(true);
    setError('');

    try {
      const csrfResponse = await fetch('/api/auth/csrf', {
        credentials: 'same-origin',
        cache: 'no-store',
      });

      const csrfResult =
        await csrfResponse.json().catch(() => null);

      if (
        !csrfResponse.ok ||
        typeof csrfResult?.token !== 'string'
      ) {
        throw new Error(
          'Unable to start secure school management.',
        );
      }

      const body: Record<string, unknown> = {
        csrfToken: csrfResult.token,
        action,
      };

      if (action === 'update' && form) {
        const data = new FormData(form);

        const numberValue = (name: string) => {
          const raw = String(
            data.get(name) ?? '',
          ).trim();

          return raw === '' ? null : Number(raw);
        };

        body.name = String(
          data.get('name') ?? '',
        ).trim();

        body.city = String(
          data.get('city') ?? '',
        ).trim();

        body.timezone = String(
          data.get('timezone') ?? '',
        ).trim();

        body.releaseEnabled =
          data.get('releaseEnabled') === 'on';

        body.pickupLatitude =
          numberValue('pickupLatitude');

        body.pickupLongitude =
          numberValue('pickupLongitude');

        body.pickupRadiusMeters =
          numberValue('pickupRadiusMeters');

        body.pickupRequestLifetimeMinutes =
          numberValue(
            'pickupRequestLifetimeMinutes',
          );

        body.pickupReleaseMinutesBeforeBell =
          numberValue(
            'pickupReleaseMinutesBeforeBell',
          );

        body.pickupSessionDurationMinutes =
          numberValue(
            'pickupSessionDurationMinutes',
          );
      }

      const response = await fetch(
        `/api/platform/schools/${encodeURIComponent(
          school.schoolId,
        )}`,
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify(body),
        },
      );

      const result =
        await response.json().catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof result?.error === 'string'
            ? result.error
            : 'Unable to update school.',
        );
      }

      if (!result?.school) {
        throw new Error(
          'No school data was returned.',
        );
      }

      onUpdated(
        result.school as ManageSchool,
      );
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Unable to update school.',
      );
    } finally {
      setBusy(false);
    }
  }

  const archived =
    school.status === 'ARCHIVED';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="manage-school-title"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <div className="panel-kicker">
              Tenant management
            </div>

            <h2
              id="manage-school-title"
              className="text-2xl font-bold text-slate-900"
            >
              Manage School
            </h2>

            <p className="mt-1 text-sm text-slate-600">
              Edit school settings or change its
              lifecycle status.
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

        <form
          onSubmit={(
            event: FormEvent<HTMLFormElement>,
          ) => {
            event.preventDefault();
            void request(
              'update',
              event.currentTarget,
            );
          }}
          className="space-y-6 p-6"
        >
          <section>
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
                School
              </h3>

              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-600">
                {school.status}
              </span>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  School name
                </span>

                <input
                  name="name"
                  defaultValue={school.name}
                  required
                  maxLength={200}
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  City
                </span>

                <input
                  name="city"
                  defaultValue={school.city}
                  maxLength={100}
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Timezone
                </span>

                <input
                  name="timezone"
                  defaultValue={
                    school.timezone
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Pickup area
            </h3>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Latitude
                </span>

                <input
                  name="pickupLatitude"
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  defaultValue={
                    school.pickupLatitude ?? ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Longitude
                </span>

                <input
                  name="pickupLongitude"
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  defaultValue={
                    school.pickupLongitude ?? ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Radius (meters)
                </span>

                <input
                  name="pickupRadiusMeters"
                  type="number"
                  min="1"
                  max="5000"
                  defaultValue={
                    school.pickupRadiusMeters ?? ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Pickup timing
            </h3>

            <div className="grid gap-4 md:grid-cols-3">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Request lifetime
                </span>

                <input
                  name="pickupRequestLifetimeMinutes"
                  type="number"
                  min="1"
                  max="180"
                  defaultValue={
                    school.pickupRequestLifetimeMinutes ??
                    ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Release before bell
                </span>

                <input
                  name="pickupReleaseMinutesBeforeBell"
                  type="number"
                  min="0"
                  max="60"
                  defaultValue={
                    school.pickupReleaseMinutesBeforeBell ??
                    ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Session duration
                </span>

                <input
                  name="pickupSessionDurationMinutes"
                  type="number"
                  min="1"
                  max="240"
                  defaultValue={
                    school.pickupSessionDurationMinutes ??
                    ''
                  }
                  required
                  disabled={
                    archived || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
              </label>
            </div>
          </section>

          <label className="flex items-center gap-3 rounded-xl border border-slate-200 p-4">
            <input
              name="releaseEnabled"
              type="checkbox"
              defaultChecked={
                school.releaseEnabled
              }
              disabled={
                archived || busy
              }
            />

            <span>
              <span className="block text-sm font-semibold text-slate-800">
                Pickup release enabled
              </span>

              <span className="block text-xs text-slate-500">
                Enable scheduled pickup release
                for this school.
              </span>
            </span>
          </label>

          {error && (
            <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 pt-5">
            <div className="flex flex-wrap gap-2">
              {!archived &&
                (school.status ===
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
                    onClick={() => {
                      if (
                        window.confirm(
                          'Deactivate this school?',
                        )
                      ) {
                        void request(
                          'deactivate',
                        );
                      }
                    }}
                    className="rounded-xl border border-amber-300 px-4 py-2 text-sm font-semibold text-amber-700 hover:bg-amber-50"
                  >
                    Deactivate
                  </button>
                ))}

              {!archived && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        'Archive this school? It will be hidden from normal school lists.',
                      )
                    ) {
                      void request(
                        'archive',
                      );
                    }
                  }}
                  className="rounded-xl border border-red-300 px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50"
                >
                  Archive
                </button>
              )}
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-xl border border-slate-300 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>

              {!archived && (
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded-xl bg-slate-900 px-5 py-2 text-sm font-semibold text-white hover:bg-slate-800"
                >
                  {busy
                    ? 'Saving…'
                    : 'Save changes'}
                </button>
              )}
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}