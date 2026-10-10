'use client';

import { FormEvent, useMemo, useRef, useState } from 'react';
import { MANUAL_STUDENT_CAPACITY_OPTIONS, parseManualStudentLimit, validateManualStudentCapacity } from '@/lib/student-capacity.mjs';
import { buildManageSchoolPatch, filterIanaTimezoneOptions, getManageSchoolInitialName, getManageSchoolInitialReleaseEnabled, getManageSchoolInitialTimezone, getSchoolConfigurationIssues, parseManageSchoolFormValues, SCHOOL_FIELD_LABELS } from '@/lib/school-update';
import IanaTimezoneCombobox from './iana-timezone-combobox';
import type { SchoolConfigurationIssue } from '@/lib/school-update';

type ManageSchool = {
  schoolId: string;
  name: string | null;
  city: string;
  status: string;
  timezone: string | null;
  releaseEnabled: boolean | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  pickupRadiusMeters: number | null;
  pickupRequestLifetimeMinutes: number | null;
  pickupReleaseMinutesBeforeBell: number | null;
  pickupSessionDurationMinutes: number | null;
  studentLimit: number | null;
  activeStudentCount: number | null;
  studentCount?: number;
  configurationIssues?: SchoolConfigurationIssue[];
};
type SchoolFieldValues = Record<string, unknown>;

export default function ManageSchoolModal({
  school,
  timezoneOptions,
  onClose,
  onUpdated,
}: {
  school: ManageSchool;
  timezoneOptions: string[];
  onClose: () => void;
  onUpdated: (school: ManageSchool) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [fieldIssues, setFieldIssues] = useState<SchoolConfigurationIssue[]>(school.configurationIssues ?? []);
  const [releaseEnabledValue, setReleaseEnabledValue] = useState(() => getManageSchoolInitialReleaseEnabled(school.releaseEnabled));
  const [name, setName] = useState(() => getManageSchoolInitialName(school));
  const initialTimezone = getManageSchoolInitialTimezone(school);
  const [timezone, setTimezone] = useState(initialTimezone);
  const [pickupLatitude, setPickupLatitude] = useState(() => school.pickupLatitude?.toString() ?? '');
  const [pickupLongitude, setPickupLongitude] = useState(() => school.pickupLongitude?.toString() ?? '');
  const [pickupRadiusMeters, setPickupRadiusMeters] = useState(() => school.pickupRadiusMeters?.toString() ?? '');
  const summaryRef = useRef<HTMLDivElement>(null);
  const fieldElements = useRef<Record<string, HTMLElement | null>>({});
  const selectableTimezones = useMemo(() => {
    const options = [...timezoneOptions];
    if (initialTimezone && !options.includes(initialTimezone)) options.push(initialTimezone);
    return filterIanaTimezoneOptions(options, '');
  }, [timezoneOptions, initialTimezone]);

  function clearFieldIssue(field: string) {
    setFieldIssues((current) => current.filter((issue) => issue.field !== field));
  }

  function issuesFor(field: string) {
    return fieldIssues.filter((issue) => issue.field === field);
  }

  function fieldError(field: string) {
    const issues = issuesFor(field);
    if (issues.length === 0) return null;
    return (
      <ul id={field + '-error'} className="mt-1 space-y-1 text-sm text-red-700">
        {issues.map((issue) => <li key={issue.code}>{issue.message}</li>)}
      </ul>
    );
  }

  function focusFirstIssue(issues: SchoolConfigurationIssue[]) {
    const firstControlIssue = issues.find((issue) => fieldElements.current[issue.field]);
    window.requestAnimationFrame(() => {
      const target = firstControlIssue ? fieldElements.current[firstControlIssue.field] : summaryRef.current;
      target?.focus();
      target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  async function request(
    action: 'update' | 'deactivate' | 'reactivate' | 'archive',
    form?: HTMLFormElement,
  ) {
    if (busy) return;

    let submittedValues: SchoolFieldValues | null = null;
    if (action === 'update' && form) {
      submittedValues = parseManageSchoolFormValues(Object.fromEntries(new FormData(form).entries()));
      const issues = getSchoolConfigurationIssues(
        { ...school, ...submittedValues },
        {
          isValidStudentLimit: (value) => parseManualStudentLimit(value) !== null,
          allowZeroRadiusWhenDisabled: true,
          expectedSchoolId: school.schoolId,
        },
      );
      const requestedLimit = parseManualStudentLimit(submittedValues.studentLimit);
      const activeCount = school.activeStudentCount ?? school.studentCount;
      if (requestedLimit !== null && Number.isSafeInteger(activeCount) && !validateManualStudentCapacity(requestedLimit, activeCount).ok) {
        issues.push({
          field: 'studentLimit',
          code: 'below_active_student_count',
          message: 'Choose a limit that is at least the current active student count (' + activeCount + ').',
        });
      }
      if (issues.length > 0) {
        setError('');
        setFieldIssues(issues);
        focusFirstIssue(issues);
        return;
      }
      setFieldIssues([]);
    }

    setBusy(true);
    setError('');

    try {
      const csrfResponse = await fetch('/api/auth/csrf', { credentials: 'same-origin', cache: 'no-store' });
      const csrfResult = await csrfResponse.json().catch(() => null);
      if (!csrfResponse.ok || typeof csrfResult?.token !== 'string') {
        throw new Error('Unable to start secure school management.');
      }

      const body: Record<string, unknown> = { csrfToken: csrfResult.token, action };
      if (action === 'update' && submittedValues) {
        Object.assign(body, buildManageSchoolPatch(school, submittedValues));
      }

      const response = await fetch(
        '/api/platform/schools/' + encodeURIComponent(school.schoolId),
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      const result = await response.json().catch(() => null);

      if (!response.ok) {
        if (Array.isArray(result?.issues)) {
          const issues = result.issues as SchoolConfigurationIssue[];
          setFieldIssues(issues);
          focusFirstIssue(issues);
          if (result.error === 'invalid_school' || result.error === 'invalid_student_capacity') return;
        }
        throw new Error(
          typeof result?.message === 'string'
            ? result.message
            : typeof result?.error === 'string'
              ? result.error
              : 'Unable to update school.',
        );
      }

      if (!result?.school) throw new Error('No school data was returned.');
      onUpdated(result.school as ManageSchool);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update school.');
    } finally {
      setBusy(false);
    }
  }

  const archived =
    school.status === 'ARCHIVED';
  const invalidStatus = !['ACTIVE', 'INACTIVE', 'SUSPENDED', 'ARCHIVED'].includes(school.status);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl dashboard-modal"
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
            className="rounded-lg px-3 py-2 text-slate-500 hover:bg-slate-100 dashboard-modal-close"
            aria-label="Close"
          >
            <svg
              className="icon-svg"
              viewBox="0 0 24 24"
              aria-hidden="true"
              focusable="false"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </div>

        <form
          noValidate
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
          {fieldIssues.length > 0 && (
            <div ref={summaryRef} tabIndex={-1} role="alert" aria-live="polite" className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <p className="font-semibold">Correct these school settings before saving:</p>
              <ul className="mt-2 list-disc space-y-1 pl-5">
                {fieldIssues.map((issue) => (
                  <li key={issue.field + '-' + issue.code}><strong>{SCHOOL_FIELD_LABELS[issue.field] ?? issue.field}:</strong> {issue.message}</li>
                ))}
              </ul>
            </div>
          )}
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
                  id="name"
                  name="name"
                  ref={(element) => { fieldElements.current.name = element; }}
                  value={name}
                  onChange={(event) => { setName(event.target.value); clearFieldIssue('name'); }}
                  aria-invalid={issuesFor('name').length > 0}
                  aria-describedby={issuesFor('name').length > 0 ? 'name-error' : undefined}
                  required
                  maxLength={200}
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
                {fieldError('name')}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  City <span className="ml-1 text-slate-400">optional</span>
                </span>

                <input
                  id="city"
                  name="city"
                  ref={(element) => { fieldElements.current.city = element; }}
                  defaultValue={school.city}
                  onChange={() => clearFieldIssue('city')}
                  aria-invalid={issuesFor('city').length > 0}
                  aria-describedby={issuesFor('city').length > 0 ? 'city-error' : undefined}
                  maxLength={100}
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
                {fieldError('city')}
              </label>

              <div className="block md:col-span-2">
                <label htmlFor="timezone" className="mb-1 block text-sm font-medium text-slate-700">Timezone</label>
                <IanaTimezoneCombobox
                  id="timezone"
                  name="timezone"
                  value={timezone}
                  options={selectableTimezones}
                  required
                  disabled={archived || invalidStatus || busy}
                  invalid={issuesFor('timezone').length > 0}
                  describedBy={'timezone-help' + (issuesFor('timezone').length > 0 ? ' timezone-error' : '')}
                  inputRef={(element) => { fieldElements.current.timezone = element; }}
                  onChange={(value) => { setTimezone(value); clearFieldIssue('timezone'); }}
                />
                <p id="timezone-help" className="mt-2 text-sm text-slate-500">Search the server-validated IANA list, or type to filter and use the arrow keys and Enter. Asia/Karachi is pinned at the top; the selected identifier is saved as shown.</p>
                {initialTimezone === '' && <p role="status" className="mt-2 text-sm text-amber-800">The saved timezone is missing or invalid. Choose a timezone to repair it; no timezone has been preselected.</p>}
                {selectableTimezones.length === 0 && <p role="status" className="mt-2 text-sm text-amber-800">Timezone options are unavailable. Refresh the school list before repairing this school.</p>}
                {fieldError('timezone')}
              </div>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Student capacity
            </h3>
            {school.studentLimit === null && <p className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Student capacity is not configured. Set it here before School Admins add students.</p>}
            <label className="block max-w-md">
              <span className="mb-1 block text-sm font-medium text-slate-700">Maximum active students</span>
              <select id="studentLimit" name="studentLimit" ref={(element) => { fieldElements.current.studentLimit = element; }} defaultValue={school.studentLimit?.toString() ?? ''} onChange={() => clearFieldIssue('studentLimit')} aria-invalid={issuesFor('studentLimit').length > 0} aria-describedby={issuesFor('studentLimit').length > 0 ? 'studentLimit-error' : undefined} required disabled={archived || invalidStatus || busy} className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3">
                <option value="" disabled>Choose a capacity</option>
                {MANUAL_STUDENT_CAPACITY_OPTIONS.map((capacity) => (
                  <option key={capacity} value={capacity}>{capacity.toLocaleString()} students</option>
                ))}
              </select>
              <span className="mt-2 block text-sm text-slate-500">Approved choices: 100 to 1,000 in 100-student steps. School-wide active-student limit. Current active count: {Number.isSafeInteger(school.activeStudentCount ?? school.studentCount) ? (school.activeStudentCount ?? school.studentCount)?.toLocaleString() : 'checked securely when saved'}.</span>
              {fieldError('studentLimit')}
            </label>
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
                  id="pickupLatitude"
                  ref={(element) => { fieldElements.current.pickupLatitude = element; }}
                  value={pickupLatitude}
                  onChange={(event) => { setPickupLatitude(event.target.value); clearFieldIssue('pickupLatitude'); }}
                  aria-invalid={issuesFor('pickupLatitude').length > 0}
                  aria-describedby={issuesFor('pickupLatitude').length > 0 ? 'pickupLatitude-error' : undefined}
                  required
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                <span className="mt-1 block text-xs text-slate-500">Range: minus 90 to 90. Enter the real pickup latitude when release is enabled.</span>
                {fieldError('pickupLatitude')}
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
                  id="pickupLongitude"
                  ref={(element) => { fieldElements.current.pickupLongitude = element; }}
                  value={pickupLongitude}
                  onChange={(event) => { setPickupLongitude(event.target.value); clearFieldIssue('pickupLongitude'); }}
                  aria-invalid={issuesFor('pickupLongitude').length > 0}
                  aria-describedby={issuesFor('pickupLongitude').length > 0 ? 'pickupLongitude-error' : undefined}
                  required
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                <span className="mt-1 block text-xs text-slate-500">Range: minus 180 to 180. Enter the real pickup longitude when release is enabled.</span>
                {fieldError('pickupLongitude')}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Radius (meters)
                </span>

                <input
                  name="pickupRadiusMeters"
                  type="number"
                  min={releaseEnabledValue === 'false' ? 0 : 1}
                  max="5000"
                  id="pickupRadiusMeters"
                  ref={(element) => { fieldElements.current.pickupRadiusMeters = element; }}
                  value={pickupRadiusMeters}
                  onChange={(event) => { setPickupRadiusMeters(event.target.value); clearFieldIssue('pickupRadiusMeters'); }}
                  aria-invalid={issuesFor('pickupRadiusMeters').length > 0}
                  aria-describedby={issuesFor('pickupRadiusMeters').length > 0 ? 'pickupRadiusMeters-error' : undefined}
                  required
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                <span className="mt-1 block text-xs text-slate-500">{releaseEnabledValue === 'false' ? 'Range: 0 to 5,000 m while disabled.' : 'Range: 1 to 5,000 m while enabled.'}</span>
                {fieldError('pickupRadiusMeters')}
              </label>
            </div>
            {releaseEnabledValue === 'false' && (
              <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
                <p>With pickup release disabled, the existing Worker setup uses 0, 0 coordinates and a 0 m radius as inactive sentinels. This is not a real school location.</p>
                <button type="button" disabled={busy || archived || invalidStatus} onClick={() => { setPickupLatitude('0'); setPickupLongitude('0'); setPickupRadiusMeters('0'); clearFieldIssue('pickupLatitude'); clearFieldIssue('pickupLongitude'); clearFieldIssue('pickupRadiusMeters'); }} className="mt-2 rounded-lg border border-slate-300 bg-white px-3 py-2 font-semibold text-slate-700 hover:bg-slate-100">Use disabled-release values (0, 0; 0 m)</button>
              </div>
            )}
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
                  id="pickupRequestLifetimeMinutes"
                  name="pickupRequestLifetimeMinutes"
                  ref={(element) => { fieldElements.current.pickupRequestLifetimeMinutes = element; }}
                  type="number"
                  min="1"
                  max="180"
                  defaultValue={
                    school.pickupRequestLifetimeMinutes ??
                    ''
                  }
                  required
                  onChange={() => clearFieldIssue('pickupRequestLifetimeMinutes')}
                  aria-invalid={issuesFor('pickupRequestLifetimeMinutes').length > 0}
                  aria-describedby={issuesFor('pickupRequestLifetimeMinutes').length > 0 ? 'pickupRequestLifetimeMinutes-error' : undefined}
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                <span className="mt-1 block text-xs text-slate-500">Whole number from 1 to 180 minutes.</span>
                {fieldError('pickupRequestLifetimeMinutes')}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Release before bell
                </span>
                <span className="mt-1 block text-xs text-slate-500">Optional. If unset, the Worker uses its configured 5-minute default.</span>

                <input
                  id="pickupReleaseMinutesBeforeBell"
                  name="pickupReleaseMinutesBeforeBell"
                  ref={(element) => { fieldElements.current.pickupReleaseMinutesBeforeBell = element; }}
                  type="number"
                  min="1"
                  max="60"
                  defaultValue={
                    school.pickupReleaseMinutesBeforeBell ??
                    ''
                  }
                  onChange={() => clearFieldIssue('pickupReleaseMinutesBeforeBell')}
                  aria-invalid={issuesFor('pickupReleaseMinutesBeforeBell').length > 0}
                  aria-describedby={issuesFor('pickupReleaseMinutesBeforeBell').length > 0 ? 'pickupReleaseMinutesBeforeBell-error' : undefined}
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                {fieldError('pickupReleaseMinutesBeforeBell')}
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Session duration
                </span>
                <span className="mt-1 block text-xs text-slate-500">Optional. If unset, the Worker uses its configured 30-minute default.</span>

                <input
                  id="pickupSessionDurationMinutes"
                  name="pickupSessionDurationMinutes"
                  ref={(element) => { fieldElements.current.pickupSessionDurationMinutes = element; }}
                  type="number"
                  min="1"
                  max="240"
                  defaultValue={
                    school.pickupSessionDurationMinutes ??
                    ''
                  }
                  onChange={() => clearFieldIssue('pickupSessionDurationMinutes')}
                  aria-invalid={issuesFor('pickupSessionDurationMinutes').length > 0}
                  aria-describedby={issuesFor('pickupSessionDurationMinutes').length > 0 ? 'pickupSessionDurationMinutes-error' : undefined}
                  disabled={
                    archived || invalidStatus || busy
                  }
                  className="w-full rounded-xl border border-slate-300 px-4 py-3"
                />
                {fieldError('pickupSessionDurationMinutes')}
              </label>
            </div>
          </section>

          <label className="block max-w-md">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              Pickup release enabled
            </span>
            <select
              id="releaseEnabled"
              name="releaseEnabled"
              ref={(element) => { fieldElements.current.releaseEnabled = element; }}
              value={releaseEnabledValue}
              onChange={(event) => { setReleaseEnabledValue(event.target.value); clearFieldIssue('releaseEnabled'); }}
              aria-invalid={issuesFor('releaseEnabled').length > 0}
              aria-describedby={issuesFor('releaseEnabled').length > 0 ? 'releaseEnabled-error' : undefined}
              required
              disabled={archived || invalidStatus || busy}
              className="w-full rounded-xl border border-slate-300 bg-white px-4 py-3"
            >
              <option value="" disabled>Choose enabled or disabled</option>
              <option value="true">Enabled</option>
              <option value="false">Disabled</option>
            </select>
            <span className="mt-2 block text-xs text-slate-500">
              When enabled, enter the real school pickup coordinates and choose a radius from 1 to 5,000 meters. Disabled-release sentinel coordinates cannot be used while enabled.
            </span>
            {fieldError('releaseEnabled')}
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
                    disabled={busy || invalidStatus}
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
                    disabled={busy || invalidStatus}
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
                  disabled={busy || invalidStatus}
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
                  disabled={busy || invalidStatus}
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