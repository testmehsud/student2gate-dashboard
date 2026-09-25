'use client';

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import ManageSchoolModal from './components/manage-school-modal';
import ManageSchoolAdminModal from './components/manage-school-admin-modal';
type Section =
  | 'Overview'
  | 'Schools'
  | 'School Admins'
  | 'Audit Log';

type LiveSchool = {
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
  studentCount?: number;
  adminCount?: number;
  activeAdminCount?: number;
};

type LiveAdmin = {
  uid: string;
  schoolId: string;
  schoolName: string;
  name: string;
  email: string;
  role: string;
  status: string;
};

type AuditEvent = {
  id: string;
  actorUid: string;
  actorName: string;
  actorEmail: string;
  eventType: string;
  targetType: string;
  targetId: string;
  schoolId: string;
  createdAt: string | null;
};

const navItems: { label: Section; icon: string }[] = [
  { label: 'Overview', icon: '⌂' },
  { label: 'Schools', icon: '▦' },
  { label: 'School Admins', icon: '♙' },
  { label: 'Audit Log', icon: '◷' },
];

export default function Home() {
  const router = useRouter();

  const [section, setSection] =
    useState<Section>('Overview');

  const [mobileOpen, setMobileOpen] =
    useState(false);

  const [loggingOut, setLoggingOut] =
    useState(false);

  const [liveSchools, setLiveSchools] =
    useState<LiveSchool[]>([]);

  const [schoolsLoading, setSchoolsLoading] =
    useState(true);

  const [schoolError, setSchoolError] =
    useState('');

  const [schoolModalOpen, setSchoolModalOpen] =
    useState(false);

  const [selectedSchool, setSelectedSchool] =
    useState<LiveSchool | null>(null);

  const activeSchools = useMemo(
    () =>
      liveSchools.filter(
        (school) => school.status === 'ACTIVE',
      ).length,
    [liveSchools],
  );

  const totalStudents = useMemo(
    () =>
      liveSchools
        .filter(
          (school) => school.status === 'ACTIVE',
        )
        .reduce(
        (sum, school) =>
            sum + (school.studentCount ?? 0),
          0,
        ),
    [liveSchools],
  );

  const totalAdmins = useMemo(
    () =>
      liveSchools.reduce(
        (sum, school) =>
          sum + (school.adminCount ?? 0),
        0,
      ),
    [liveSchools],
  );

  const activeAdminTotal = useMemo(
    () =>
      liveSchools.reduce(
        (sum, school) =>
          sum + (school.activeAdminCount ?? 0),
        0,
      ),
    [liveSchools],
  );

  const inactiveAdminTotal = Math.max(
    totalAdmins - activeAdminTotal,
    0,
  );

  const schoolsNeedingAttention = useMemo(
    () =>
      liveSchools.filter(
        (school) => school.status !== 'ACTIVE',
      ).length,
    [liveSchools],
  );

  const loadSchools = useCallback(async () => {
    setSchoolsLoading(true);
    setSchoolError('');

    try {
      const response = await fetch(
        '/api/platform/schools',
        {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        },
      );

      const result = await response
        .json()
        .catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof result?.error === 'string'
            ? result.error
            : 'Unable to load schools.',
        );
      }

      if (!Array.isArray(result?.schools)) {
        throw new Error(
          'Invalid school data received from the server.',
        );
      }

      setLiveSchools(
        result.schools as LiveSchool[],
      );
    } catch (error) {
      setSchoolError(
        error instanceof Error
          ? error.message
          : 'Unable to load schools.',
      );
    } finally {
      setSchoolsLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadSchools();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadSchools]);

  function navigate(next: Section) {
    setSection(next);
    setMobileOpen(false);
  }

  async function handleLogout() {
    if (loggingOut) {
      return;
    }

    setLoggingOut(true);

    try {
      const response = await fetch(
        '/api/auth/logout',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type':
              'application/json',
          },
        },
      );

      if (!response.ok) {
        throw new Error('Logout failed.');
      }

      router.replace('/login');
      router.refresh();
    } catch {
      setLoggingOut(false);
    }
  }

  return (
    <main className="dashboard-app">
      <aside
        className={
          mobileOpen
            ? 'sidebar sidebar-open'
            : 'sidebar'
        }
      >
        <div className="brand-block">
          <div className="brand-mark">S2</div>

          <div>
            <div className="brand-name">
              Student2Gate
            </div>

            <div className="brand-subtitle">
              Platform Console
            </div>
          </div>
        </div>

        <div className="workspace-card">
          <span className="workspace-dot" />

          <div>
            <div className="workspace-label">
              Workspace
            </div>

            <div className="workspace-value">
              Platform Owner
            </div>
          </div>
        </div>

        <nav
          className="main-nav"
          aria-label="Dashboard navigation"
        >
          <div className="nav-heading">
            Manage
          </div>

          {navItems.map((item) => (
            <button
              key={item.label}
              className={
                section === item.label
                  ? 'nav-item nav-item-active'
                  : 'nav-item'
              }
              onClick={() =>
                navigate(item.label)
              }
            >
              <span className="nav-icon">
                {item.icon}
              </span>

              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="owner-card">
            <div className="avatar">MK</div>

            <div className="owner-copy">
              <strong>
                Platform Owner
              </strong>

              <span>
                Administrator
              </span>
            </div>

            <button
              className="owner-menu"
              aria-label="Logout"
              title="Logout"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              {loggingOut
                ? 'Logging out...'
                : 'Logout'}
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() =>
            setMobileOpen(false)
          }
        />
      )}

      <section className="content-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-menu-button"
              aria-label="Open navigation"
              onClick={() =>
                setMobileOpen(true)
              }
            >
              ☰
            </button>

            <div>
              <div className="eyebrow">
                Platform management
              </div>

              <h1>{section}</h1>
            </div>
          </div>

          <div className="topbar-actions">
            <button
              className="icon-button"
              aria-label="Notifications"
            >
              ◔
            </button>

            <div className="status-chip">
              <span className="live-dot" />
              System operational
            </div>
          </div>
        </header>

        {section === 'Overview' && (
          <Overview
            activeSchools={activeSchools}
            totalStudents={totalStudents}
            totalAdmins={totalAdmins}
            activeAdminTotal={activeAdminTotal}
            inactiveAdminTotal={inactiveAdminTotal}
            schoolsNeedingAttention={
              schoolsNeedingAttention
            }
            schools={liveSchools}
            schoolsLoading={schoolsLoading}
            onNavigate={navigate}
          />
        )}

        {section === 'Schools' && (
          <Schools
            schools={liveSchools}
            loading={schoolsLoading}
            error={schoolError}
            onRefresh={loadSchools}
            onCreate={() =>
              setSchoolModalOpen(true)
            }
            onManage={(school) =>
              setSelectedSchool(school)
            }
          />
        )}

        {section === 'School Admins' && (
          <SchoolAdmins
            schools={liveSchools}
          />
        )}

        {section === 'Audit Log' && (
          <AuditLog schools={liveSchools} />
        )}
      </section>

      {selectedSchool && (
        <ManageSchoolModal
          school={selectedSchool}
          onClose={() =>
            setSelectedSchool(null)
          }
          onUpdated={(school) => {
            setLiveSchools((current) =>
              school.status === 'ARCHIVED'
                ? current.filter(
                    (item) =>
                      item.schoolId !==
                      school.schoolId,
                  )
                : current.map((item) =>
                    item.schoolId ===
                    school.schoolId
                      ? school
                      : item,
                  ),
            );

            setSelectedSchool(null);
          }}
        />
      )}

      {schoolModalOpen && (
        <CreateSchoolModal
          onClose={() =>
            setSchoolModalOpen(false)
          }
          onCreated={(school) => {
            setLiveSchools((current) =>
              [...current, school].sort(
                (a, b) =>
                  a.name.localeCompare(
                    b.name,
                  ),
              ),
            );

            setSchoolModalOpen(false);
          }}
        />
      )}
    </main>
  );
}

function Overview({
  activeSchools,
  totalStudents,
  totalAdmins,
  activeAdminTotal,
  inactiveAdminTotal,
  schoolsNeedingAttention,
  schools,
  schoolsLoading,
  onNavigate,
}: {
  activeSchools: number;
  totalStudents: number;
  totalAdmins: number;
  activeAdminTotal: number;
  inactiveAdminTotal: number;
  schoolsNeedingAttention: number;
  schools: LiveSchool[];
  schoolsLoading: boolean;
  onNavigate: (
    section: Section,
  ) => void;
}) {
  const [recentEvents, setRecentEvents] =
    useState<AuditEvent[]>([]);
  const [recentActivityLoading, setRecentActivityLoading] =
    useState(true);
  const [recentActivityError, setRecentActivityError] =
    useState('');

  const loadRecentActivity = useCallback(
    async () => {
      setRecentActivityLoading(true);
      setRecentActivityError('');

      try {
        const response = await fetch(
          '/api/platform/audit-log',
          {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
          },
        );

        const result = await response
          .json()
          .catch(() => null);

        if (!response.ok) {
          throw new Error(
            typeof result?.error === 'string'
              ? result.error
              : 'Unable to load recent activity.',
          );
        }

        if (!Array.isArray(result?.events)) {
          throw new Error(
            'Invalid activity data received from the server.',
          );
        }

        setRecentEvents(
          (result.events as AuditEvent[]).slice(0, 5),
        );
      } catch (error) {
        setRecentActivityError(
          error instanceof Error
            ? error.message
            : 'Unable to load recent activity.',
        );
      } finally {
        setRecentActivityLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadRecentActivity();
    }, 0);

    return () =>
      window.clearTimeout(timer);
  }, [loadRecentActivity]);

  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <div className="hero-kicker">
            Student2Gate control center
          </div>

          <h2>
            Manage every school from one place.
          </h2>

          <p>
            Provision schools, manage School Admin
            access, and review operational activity
            from the platform console.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={() =>
                onNavigate('Schools')
              }
            >
              Open Schools
            </button>

            <button
              className="secondary-button"
              onClick={() =>
                onNavigate('School Admins')
              }
            >
              Manage Admins
            </button>
          </div>
        </div>

        <div
          className="hero-orb"
          aria-hidden="true"
        >
          <div className="hero-orb-inner">
            S2G
          </div>
        </div>
      </section>

      <section className="stats-grid">
        <StatCard
          label="Active schools"
          value={String(activeSchools)}
          detail="Across the platform"
          icon="▦"
        />

        <StatCard
          label="School Admins"
          value={String(totalAdmins)}
          detail={`${activeAdminTotal} active · ${inactiveAdminTotal} inactive`}
          icon="♙"
        />

        <StatCard
          label="Students"
          value={totalStudents.toLocaleString()}
          detail="Across active schools"
          icon="◉"
        />

        <StatCard
          label="Schools needing attention"
          value={String(schoolsNeedingAttention)}
          detail="Non-active schools"
          icon="↗"
        />
      </section>

      <section className="content-grid">
        <div className="panel panel-large">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">
                School portfolio
              </div>

              <h3>Schools</h3>
            </div>

            <button
              className="text-button"
              onClick={() =>
                onNavigate('Schools')
              }
            >
              View all
            </button>
          </div>

          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>School</th>
                  <th>Status</th>
                  <th>Active Admins</th>
                  <th>Active Students</th>
                </tr>
              </thead>

              <tbody>
                {schoolsLoading && (
                  <tr>
                    <td colSpan={4}>
                      Loading schools…
                    </td>
                  </tr>
                )}

                {!schoolsLoading &&
                  schools.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      No schools have been created yet.
                    </td>
                  </tr>
                )}

                {!schoolsLoading &&
                  schools.map((school) => {
                    const badgeStatus:
                      | 'ACTIVE'
                      | 'SUSPENDED' =
                      school.status === 'ACTIVE'
                        ? 'ACTIVE'
                        : 'SUSPENDED';

                    return (
                      <tr key={school.schoolId}>
                        <td>
                          <div className="table-primary">
                            {school.name}
                          </div>

                          <div className="table-secondary">
                            {school.city || 'No city metadata'}
                          </div>
                        </td>

                        <td>
                          <StatusBadge
                            status={badgeStatus}
                          />
                        </td>

                        <td>
                          {school.activeAdminCount ?? 0}
                        </td>

                        <td>
                          {school.studentCount ?? 0}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="panel">
          <div className="panel-heading">
            <div>
              <div className="panel-kicker">
                Recent activity
              </div>

              <h3>Audit Log</h3>
            </div>

            <button
              className="text-button"
              onClick={() =>
                onNavigate('Audit Log')
              }
            >
              Open
            </button>
          </div>

          <div className="activity-list">
            {recentActivityLoading && (
              <p className="table-secondary">
                Loading recent activity…
              </p>
            )}

            {!recentActivityLoading &&
              recentActivityError && (
                <p className="table-secondary">
                  {recentActivityError}
                </p>
              )}

            {!recentActivityLoading &&
              !recentActivityError &&
              recentEvents.length === 0 && (
                <p className="table-secondary">
                  No audit events are available yet.
                </p>
              )}

            {!recentActivityLoading &&
              !recentActivityError &&
              recentEvents.map((event) => (
                <div
                  className="activity-item"
                  key={event.id}
                >
                  <div className="activity-dot" />

                  <div>
                    <strong>
                      {formatAuditEventType(
                        event.eventType,
                      )}
                    </strong>

                    <span className="table-secondary">
                      {event.actorName ||
                        event.actorEmail ||
                        event.actorUid}
                    </span>
                  </div>

                  <time>
                    {formatAuditTimestamp(
                      event.createdAt,
                    )}
                  </time>
                </div>
              ))}
          </div>
        </div>
      </section>
    </div>
  );
}

function Schools({
  schools,
  loading,
  error,
  onRefresh,
  onCreate,
  onManage,
}: {
  schools: LiveSchool[];
  loading: boolean;
  error: string;
  onRefresh: () => Promise<void>;
  onCreate: () => void;
  onManage: (school: LiveSchool) => void;
}) {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Tenant management
          </div>

          <h2>Schools</h2>

          <p>
            Create and manage the schools using
            Student2Gate.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={onCreate}
        >
          + Add school
        </button>
      </section>

      {error && (
        <section className="info-banner">
          <div className="info-icon">
            !
          </div>

          <div>
            <strong>
              Unable to load schools
            </strong>

            <p>{error}</p>

            <button
              className="text-button"
              onClick={() =>
                void onRefresh()
              }
            >
              Retry
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="toolbar">
          <input
            className="search-input"
            placeholder="Search schools…"
            aria-label="Search schools"
          />

          <button className="filter-button">
            All statuses ▾
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>School</th>
                <th>Status</th>
                <th>Timezone</th>
                <th>Pickup</th>
                <th>Release</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={6}>
                    Loading schools…
                  </td>
                </tr>
              )}

              {!loading &&
                schools.length === 0 && (
                  <tr>
                    <td colSpan={6}>
                      No schools have been
                      created yet.
                    </td>
                  </tr>
                )}

              {!loading &&
                schools.map((school) => {
                  const badgeStatus:
                    | 'ACTIVE'
                    | 'SUSPENDED' =
                    school.status ===
                    'ACTIVE'
                      ? 'ACTIVE'
                      : 'SUSPENDED';

                  return (
                    <tr
                      key={school.schoolId}
                    >
                      <td>
                        <div className="table-primary">
                          {school.name}
                        </div>

                        <div className="table-secondary">
                          {school.city ||
                            'No city metadata'}
                          {' · '}
                          {school.schoolId}
                        </div>
                      </td>

                      <td>
                        <StatusBadge
                          status={
                            badgeStatus
                          }
                        />
                      </td>

                      <td>
                        {school.timezone ||
                          '—'}
                      </td>

                      <td>
                        {school
                          .pickupRadiusMeters ??
                          '—'}
                        m ·{' '}
                        {school
                          .pickupRequestLifetimeMinutes ??
                          '—'}
                        min
                      </td>

                      <td>
                        {school.releaseEnabled
                          ? 'Enabled'
                          : 'Disabled'}
                      </td>

                      <td>
                        <button
                          className="row-action"
                          onClick={() =>
                            onManage(school)
                          }
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CreateSchoolModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (
    school: LiveSchool,
  ) => void;
}) {
  const [name, setName] =
    useState('');

  const [city, setCity] =
    useState('');

  const [timezone, setTimezone] =
    useState('Asia/Karachi');

  const [releaseEnabled, setReleaseEnabled] =
    useState(false);

  const [
    pickupLatitude,
    setPickupLatitude,
  ] = useState('');

  const [
    pickupLongitude,
    setPickupLongitude,
  ] = useState('');

  const [
    pickupRadiusMeters,
    setPickupRadiusMeters,
  ] = useState('');

  const [
    pickupRequestLifetimeMinutes,
    setPickupRequestLifetimeMinutes,
  ] = useState('');

  const [
    pickupReleaseMinutesBeforeBell,
    setPickupReleaseMinutesBeforeBell,
  ] = useState('');

  const [
    pickupSessionDurationMinutes,
    setPickupSessionDurationMinutes,
  ] = useState('');

  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState('');

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (busy) {
      return;
    }

    setError('');
    setBusy(true);

    try {
      const csrfResponse =
        await fetch(
          '/api/auth/csrf',
          {
            method: 'GET',
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
          'Unable to start secure school creation.',
        );
      }

      const response = await fetch(
        '/api/platform/schools',
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            csrfToken:
              csrfResult.token,

            name:
              name.trim(),

            city:
              city.trim(),

            timezone:
              timezone.trim(),

            releaseEnabled,

            pickupLatitude:
              Number(
                pickupLatitude,
              ),

            pickupLongitude:
              Number(
                pickupLongitude,
              ),

            pickupRadiusMeters:
              Number(
                pickupRadiusMeters,
              ),

            pickupRequestLifetimeMinutes:
              Number(
                pickupRequestLifetimeMinutes,
              ),

            pickupReleaseMinutesBeforeBell:
              Number(
                pickupReleaseMinutesBeforeBell,
              ),

            pickupSessionDurationMinutes:
              Number(
                pickupSessionDurationMinutes,
              ),
          }),
        },
      );

      const result =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        throw new Error(
          typeof result?.error ===
            'string'
            ? result.error
            : 'Unable to create school.',
        );
      }

      if (!result?.school) {
        throw new Error(
          'School was created but no school data was returned.',
        );
      }

      onCreated(
        result.school as LiveSchool,
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to create school.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-3xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-school-title"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <div className="panel-kicker">
              Tenant management
            </div>

            <h2
              id="create-school-title"
              className="text-2xl font-bold text-slate-900"
            >
              Create School
            </h2>

            <p className="mt-1 text-sm text-slate-600">
              Create the school with its
              operational pickup configuration.
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
          onSubmit={handleSubmit}
          className="space-y-6 p-6"
        >
          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              School
            </h3>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  School name
                </span>

                <input
                  value={name}
                  onChange={(event) =>
                    setName(
                      event.target.value,
                    )
                  }
                  required
                  maxLength={200}
                  placeholder="Example School"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  City
                  <span className="ml-1 text-slate-400">
                    optional
                  </span>
                </span>

                <input
                  value={city}
                  onChange={(event) =>
                    setCity(
                      event.target.value,
                    )
                  }
                  maxLength={100}
                  placeholder="Islamabad"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block md:col-span-2">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Timezone
                </span>

                <input
                  value={timezone}
                  onChange={(event) =>
                    setTimezone(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="Asia/Karachi"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>
            </div>
          </section>

          <section>
            <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">
              Pickup area
            </h3>

            <div className="grid gap-4 md:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Pickup latitude
                </span>

                <input
                  type="number"
                  step="any"
                  min="-90"
                  max="90"
                  value={pickupLatitude}
                  onChange={(event) =>
                    setPickupLatitude(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="33.6844"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Pickup longitude
                </span>

                <input
                  type="number"
                  step="any"
                  min="-180"
                  max="180"
                  value={pickupLongitude}
                  onChange={(event) =>
                    setPickupLongitude(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="73.0479"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Pickup radius (meters)
                </span>

                <input
                  type="number"
                  min="1"
                  max="5000"
                  value={pickupRadiusMeters}
                  onChange={(event) =>
                    setPickupRadiusMeters(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="100"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
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
                  Request lifetime (minutes)
                </span>

                <input
                  type="number"
                  min="1"
                  max="180"
                  value={
                    pickupRequestLifetimeMinutes
                  }
                  onChange={(event) =>
                    setPickupRequestLifetimeMinutes(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="30"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Release before bell (minutes)
                </span>

                <input
                  type="number"
                  min="0"
                  max="60"
                  value={
                    pickupReleaseMinutesBeforeBell
                  }
                  onChange={(event) =>
                    setPickupReleaseMinutesBeforeBell(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="5"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>

              <label className="block">
                <span className="mb-1 block text-sm font-medium text-slate-700">
                  Session duration (minutes)
                </span>

                <input
                  type="number"
                  min="1"
                  max="240"
                  value={
                    pickupSessionDurationMinutes
                  }
                  onChange={(event) =>
                    setPickupSessionDurationMinutes(
                      event.target.value,
                    )
                  }
                  required
                  placeholder="30"
                  className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
                />
              </label>
            </div>
          </section>

          <section>
            <label className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-4">
              <input
                type="checkbox"
                checked={releaseEnabled}
                onChange={(event) =>
                  setReleaseEnabled(
                    event.target.checked,
                  )
                }
                className="h-4 w-4"
              />

              <span>
                <strong className="block text-sm text-slate-800">
                  Enable pickup release
                </strong>

                <span className="block text-sm text-slate-500">
                  The school may accept parent
                  pickup-release requests when
                  this is enabled.
                </span>
              </span>
            </label>
          </section>

          {error && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="secondary-button"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={busy}
              className="primary-button"
            >
              {busy
                ? 'Creating…'
                : 'Create school'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SchoolAdmins({
  schools,
}: {
  schools: LiveSchool[];
}) {
  const [admins, setAdmins] =
    useState<LiveAdmin[]>([]);

  const [loading, setLoading] =
    useState(true);

  const [error, setError] =
    useState('');

  const [modalOpen, setModalOpen] =
    useState(false);

  const [selectedAdmin, setSelectedAdmin] =
    useState<LiveAdmin | null>(null);

  const [search, setSearch] =
    useState('');

  const [schoolFilter, setSchoolFilter] =
    useState('ALL');

  const [statusFilter, setStatusFilter] =
    useState('ALL');

  const loadAdmins = useCallback(
    async () => {
      setLoading(true);
      setError('');

      try {
        const response =
          await fetch(
            '/api/platform/school-admins',
            {
              method: 'GET',
              credentials: 'same-origin',
              cache: 'no-store',
            },
          );

        const result =
          await response
            .json()
            .catch(() => null);

        if (!response.ok) {
          throw new Error(
            typeof result?.error ===
              'string'
              ? result.error
              : 'Unable to load School Admins.',
          );
        }

        if (
          !Array.isArray(
            result?.admins,
          )
        ) {
          throw new Error(
            'Invalid School Admin data received from the server.',
          );
        }

        setAdmins(
          result.admins as LiveAdmin[],
        );
      } catch (error) {
        setError(
          error instanceof Error
            ? error.message
            : 'Unable to load School Admins.',
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAdmins();
    }, 0);

    return () => window.clearTimeout(timer);
  }, [loadAdmins]);

  const filteredAdmins =
    useMemo(() => {
      const query =
        search.trim().toLowerCase();

      return admins.filter(
        (admin) => {
          const matchesSearch =
            query.length === 0 ||
            admin.name
              .toLowerCase()
              .includes(query) ||
            admin.email
              .toLowerCase()
              .includes(query) ||
            admin.schoolName
              .toLowerCase()
              .includes(query);

          const matchesSchool =
            schoolFilter === 'ALL' ||
            admin.schoolId ===
              schoolFilter;

          const matchesStatus =
            statusFilter === 'ALL' ||
            admin.status ===
              statusFilter;

          return (
            matchesSearch &&
            matchesSchool &&
            matchesStatus
          );
        },
      );
    }, [
      admins,
      search,
      schoolFilter,
      statusFilter,
    ]);

  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Privileged access
          </div>

          <h2>School Admins</h2>

          <p>
            Provision and manage the administrators
            responsible for each school.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={() =>
            setModalOpen(true)
          }
          disabled={
            schools.length === 0
          }
          title={
            schools.length === 0
              ? 'Create a school first.'
              : undefined
          }
        >
          + Create School Admin
        </button>
      </section>

      <section className="info-banner">
        <div className="info-icon">
          i
        </div>

        <div>
          <strong>
            Secure provisioning
          </strong>

          <p>
            School Admin accounts are created
            server-side with Firebase Authentication
            and a matching Student2Gate profile.
          </p>
        </div>
      </section>

      {error && (
        <section className="info-banner">
          <div className="info-icon">
            !
          </div>

          <div>
            <strong>
              Unable to load School Admins
            </strong>

            <p>{error}</p>

            <button
              className="text-button"
              onClick={() =>
                void loadAdmins()
              }
            >
              Retry
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="toolbar">
          <input
            className="search-input"
            placeholder="Search administrators"
            aria-label="Search administrators"
            value={search}
            onChange={(event) =>
              setSearch(
                event.target.value,
              )
            }
          />

          <select
            className="filter-button"
            aria-label="Filter by school"
            value={schoolFilter}
            onChange={(event) =>
              setSchoolFilter(
                event.target.value,
              )
            }
          >
            <option value="ALL">
              All schools
            </option>

            {schools.map((school) => (
              <option
                key={school.schoolId}
                value={school.schoolId}
              >
                {school.name}
              </option>
            ))}
          </select>

          <select
            className="filter-button"
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) =>
              setStatusFilter(
                event.target.value,
              )
            }
          >
            <option value="ALL">
              All statuses
            </option>

            <option value="ACTIVE">
              ACTIVE
            </option>

            <option value="INACTIVE">
              INACTIVE
            </option>
          </select>

          <button
            className="filter-button"
            onClick={() =>
              void loadAdmins()
            }
            disabled={loading}
          >
            {loading
              ? 'Loading'
              : 'Refresh'}
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Administrator</th>
                <th>School</th>
                <th>Status</th>
                <th>Role</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {loading && (
                <tr>
                  <td colSpan={5}>
                    Loading School Admins
                  </td>
                </tr>
              )}

              {!loading &&
                filteredAdmins.length ===
                  0 && (
                  <tr>
                    <td colSpan={5}>
                      No School Admins match
                      the current filters.
                    </td>
                  </tr>
                )}

              {!loading &&
                filteredAdmins.map(
                  (admin) => (
                    <tr
                      key={admin.uid}
                    >
                      <td>
                        <div className="table-primary">
                          {admin.name}
                        </div>

                        <div className="table-secondary">
                          {admin.email}
                        </div>
                      </td>

                      <td>
                        <div className="table-primary">
                          {admin.schoolName ||
                            'Unknown school'}
                        </div>

                        <div className="table-secondary">
                          {admin.schoolId}
                        </div>
                      </td>

                      <td>
                        <StatusBadge
                          status={
                            admin.status ===
                            'ACTIVE'
                              ? 'ACTIVE'
                              : 'SUSPENDED'
                          }
                        />
                      </td>

                      <td>
                        {admin.role}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 shadow-sm hover:bg-slate-50"
                          onClick={() =>
                            setSelectedAdmin(admin)
                          }
                        >
                          Manage
                        </button>
                      </td>
                    </tr>
                  ),
                )}
            </tbody>
          </table>
        </div>
      </section>

      {modalOpen && (
        <CreateSchoolAdminModal
          schools={schools}
          onClose={() =>
            setModalOpen(false)
          }
          onCreated={(
            createdAdmin,
          ) => {
            setAdmins((current) =>
              [
                createdAdmin,
                ...current.filter(
                  (admin) =>
                    admin.uid !==
                    createdAdmin.uid,
                ),
              ].sort((a, b) =>
                a.name.localeCompare(
                  b.name,
                ),
              ),
            );

            setModalOpen(false);
          }}
        />
      )}
      {selectedAdmin && (
        <ManageSchoolAdminModal
          admin={selectedAdmin}
          schools={schools}
          onClose={() =>
            setSelectedAdmin(null)
          }
          onUpdated={(updatedAdmin) => {
            if (
              updatedAdmin.status ===
              'ARCHIVED'
            ) {
              setAdmins((current) =>
                current.filter(
                  (admin) =>
                    admin.uid !==
                    updatedAdmin.uid,
                ),
              );
            } else {
              setAdmins((current) =>
                current.map(
                  (admin) =>
                    admin.uid ===
                    updatedAdmin.uid
                      ? updatedAdmin
                      : admin,
                ),
              );
            }

            setSelectedAdmin(null);
          }}
        />
      )}
    </div>
  );
}

function CreateSchoolAdminModal({
  schools,
  onClose,
  onCreated,
}: {
  schools: LiveSchool[];
  onClose: () => void;
  onCreated: (
    admin: LiveAdmin,
  ) => void;
}) {
  const [name, setName] =
    useState('');

  const [email, setEmail] =
    useState('');

  const [schoolId, setSchoolId] =
    useState(
      schools[0]?.schoolId ?? '',
    );

  const [password, setPassword] =
    useState('');

  const [confirmPassword, setConfirmPassword] =
    useState('');

  const [busy, setBusy] =
    useState(false);

  const [error, setError] =
    useState('');

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    if (busy) {
      return;
    }

    setError('');
    setBusy(true);

    try {
      const csrfResponse =
        await fetch(
          '/api/auth/csrf',
          {
            method: 'GET',
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
          'Unable to start secure School Admin creation.',
        );
      }

      const response =
        await fetch(
          '/api/platform/school-admins',
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: {
              'Content-Type':
                'application/json',
            },
            body: JSON.stringify({
              csrfToken:
                csrfResult.token,
              name:
                name.trim(),
              email:
                email.trim(),
              schoolId:
                schoolId.trim(),
              password,
              confirmPassword,
            }),
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
              : 'Unable to create School Admin.',
        );
      }

      if (!result?.admin) {
        throw new Error(
          'School Admin was created but no account data was returned.',
        );
      }

      onCreated(
        result.admin as LiveAdmin,
      );
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'Unable to create School Admin.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        className="w-full max-w-2xl rounded-2xl bg-white shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-school-admin-title"
      >
        <div className="flex items-start justify-between border-b border-slate-200 px-6 py-5">
          <div>
            <div className="panel-kicker">
              Privileged access
            </div>

            <h2
              id="create-school-admin-title"
              className="text-2xl font-bold text-slate-900"
            >
              Create School Admin
            </h2>

            <p className="mt-1 text-sm text-slate-600">
              Set the administrator&apos;s school,
              email, and initial password.
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
          onSubmit={handleSubmit}
          className="space-y-5 p-6"
        >
          <label className="block">
            <span className="mb-1 block text-sm font-medium text-slate-700">
              School
            </span>

            <select
              value={schoolId}
              onChange={(event) =>
                setSchoolId(
                  event.target.value,
                )
              }
              required
              className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
            >
              {schools.map((school) => (
                <option
                  key={school.schoolId}
                  value={school.schoolId}
                >
                  {school.name}
                  {school.city
                    ? `  ${school.city}`
                    : ''}
                </option>
              ))}
            </select>
          </label>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Full name
              </span>

              <input
                value={name}
                onChange={(event) =>
                  setName(
                    event.target.value,
                  )
                }
                required
                minLength={2}
                maxLength={120}
                autoComplete="name"
                placeholder="School Administrator"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
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
                  setEmail(
                    event.target.value,
                  )
                }
                required
                maxLength={320}
                autoComplete="username"
                placeholder="admin@school.example"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
              />
            </label>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-sm font-medium text-slate-700">
                Initial password
              </span>

              <input
                type="password"
                value={password}
                onChange={(event) =>
                  setPassword(
                    event.target.value,
                  )
                }
                required
                minLength={8}
                maxLength={128}
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
                value={confirmPassword}
                onChange={(event) =>
                  setConfirmPassword(
                    event.target.value,
                  )
                }
                required
                minLength={8}
                maxLength={128}
                autoComplete="new-password"
                placeholder="Re-enter password"
                className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
              />
            </label>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
            The initial password is set by the
            Platform Owner. Student2Gate does not
            require a first-login password change.
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <div className="flex justify-end gap-3 border-t border-slate-200 pt-5">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="secondary-button"
            >
              Cancel
            </button>

            <button
              type="submit"
              disabled={
                busy ||
                schools.length === 0
              }
              className="primary-button"
            >
              {busy
                ? 'Creating...'
                : 'Create School Admin'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function AuditLog({
  schools,
}: {
  schools: LiveSchool[];
}) {
  const [events, setEvents] =
    useState<AuditEvent[]>([]);
  const [loading, setLoading] =
    useState(true);
  const [error, setError] =
    useState('');

  const loadAuditEvents = useCallback(
    async () => {
      setLoading(true);
      setError('');

      try {
        const response = await fetch(
          '/api/platform/audit-log',
          {
            method: 'GET',
            credentials: 'same-origin',
            cache: 'no-store',
          },
        );

        const result = await response
          .json()
          .catch(() => null);

        if (!response.ok) {
          throw new Error(
            typeof result?.error === 'string'
              ? result.error
              : 'Unable to load audit events.',
          );
        }

        if (!Array.isArray(result?.events)) {
          throw new Error(
            'Invalid audit data received from the server.',
          );
        }

        setEvents(
          result.events as AuditEvent[],
        );
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : 'Unable to load audit events.',
        );
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadAuditEvents();
    }, 0);

    return () =>
      window.clearTimeout(timer);
  }, [loadAuditEvents]);

  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Immutable platform history
          </div>

          <h2>Audit Log</h2>

          <p>
            Review privileged actions performed
            across Student2Gate.
          </p>
        </div>

        <button
          type="button"
          className="secondary-button"
          onClick={() =>
            void loadAuditEvents()
          }
          disabled={loading}
        >
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </section>

      {error && (
        <section className="info-banner">
          <div className="info-icon">!</div>

          <div>
            <strong>
              Unable to load audit events
            </strong>

            <p>{error}</p>
          </div>
        </section>
      )}

      <section className="panel">
        <div className="audit-list">
          {loading && (
            <p className="table-secondary">
              Loading live audit events…
            </p>
          )}

          {!loading &&
            events.length === 0 && (
              <p className="table-secondary">
                No audit events are available yet.
              </p>
            )}

          {!loading &&
            events.map((event) => {
              const schoolName =
                schools.find(
                  (school) =>
                    school.schoolId ===
                    event.schoolId,
                )?.name ?? event.schoolId;

              const target =
                event.targetType === 'SCHOOL'
                  ? schoolName
                  : event.targetId ||
                    event.targetType;

              return (
                <div
                  className="audit-row"
                  key={event.id}
                >
                  <div className="audit-marker" />

                  <div className="audit-main">
                    <strong>
                      {formatAuditEventType(
                        event.eventType,
                      )}
                    </strong>

                    <span>
                      {event.actorName ||
                        event.actorEmail ||
                        event.actorUid}{' '}
                      → {target}
                    </span>
                  </div>

                  <time
                    dateTime={
                      event.createdAt ??
                      undefined
                    }
                  >
                    {formatAuditTimestamp(
                      event.createdAt,
                    )}
                  </time>
                </div>
              );
            })}
        </div>
      </section>
    </div>
  );
}

function formatAuditEventType(
  eventType: string,
): string {
  const labels: Record<string, string> = {
    PLATFORM_SCHOOL_CREATED:
      'School created',
    PLATFORM_SCHOOL_DEACTIVATED:
      'School deactivated',
    PLATFORM_SCHOOL_REACTIVATED:
      'School reactivated',
    PLATFORM_SCHOOL_ADMIN_CREATED:
      'School Admin created',
    PLATFORM_SCHOOL_ADMIN_UPDATED:
      'School Admin updated',
    PLATFORM_SCHOOL_ADMIN_DEACTIVATED:
      'School Admin deactivated',
    PLATFORM_SCHOOL_ADMIN_REACTIVATED:
      'School Admin reactivated',
    PLATFORM_SCHOOL_ADMIN_ARCHIVED:
      'School Admin archived',
    PLATFORM_SCHOOL_ADMIN_PASSWORD_RESET:
      'School Admin password reset',
  };

  return (
    labels[eventType] ??
    eventType
      .replace(/^PLATFORM_/, '')
      .replace(/_/g, ' ')
      .toLowerCase()
  );
}

function formatAuditTimestamp(
  value: string | null,
): string {
  if (!value) {
    return 'Time unavailable';
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
function StatCard({
  label,
  value,
  detail,
  icon,
}: {
  label: string;
  value: string;
  detail: string;
  icon: string;
}) {
  return (
    <div className="stat-card">
      <div className="stat-topline">
        <span>{label}</span>

        <span className="stat-icon">
          {icon}
        </span>
      </div>

      <div className="stat-value">
        {value}
      </div>

      <div className="stat-detail">
        {detail}
      </div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status:
    | 'ACTIVE'
    | 'SUSPENDED';
}) {
  return (
    <span
      className={
        status === 'ACTIVE'
          ? 'status-badge status-active'
          : 'status-badge status-suspended'
      }
    >
      <span />
      {status}
    </span>
  );
}
