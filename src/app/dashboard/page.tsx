'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

type Section = 'Overview' | 'Schools' | 'School Admins' | 'Audit Log';

type School = {
  name: string;
  city: string;
  status: 'ACTIVE' | 'SUSPENDED';
  admins: number;
  students: number;
};

const schools: School[] = [
  {
    name: 'Demo School',
    city: 'Islamabad',
    status: 'ACTIVE',
    admins: 2,
    students: 186,
  },
  {
    name: 'Green Valley School',
    city: 'Rawalpindi',
    status: 'ACTIVE',
    admins: 1,
    students: 124,
  },
  {
    name: 'City Public School',
    city: 'Peshawar',
    status: 'SUSPENDED',
    admins: 1,
    students: 0,
  },
];

const navItems: { label: Section; icon: string }[] = [
  { label: 'Overview', icon: '⌂' },
  { label: 'Schools', icon: '▦' },
  { label: 'School Admins', icon: '♙' },
  { label: 'Audit Log', icon: '◷' },
];

export default function Home() {
  const router = useRouter();

  const [section, setSection] = useState<Section>('Overview');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const activeSchools = useMemo(
    () => schools.filter((school) => school.status === 'ACTIVE').length,
    [],
  );

  const totalStudents = useMemo(
    () => schools.reduce((sum, school) => sum + school.students, 0),
    [],
  );

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
      const response = await fetch('/api/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
        },
      });

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
      <aside className={mobileOpen ? 'sidebar sidebar-open' : 'sidebar'}>
        <div className="brand-block">
          <div className="brand-mark">S2</div>

          <div>
            <div className="brand-name">Student2Gate</div>
            <div className="brand-subtitle">Platform Console</div>
          </div>
        </div>

        <div className="workspace-card">
          <span className="workspace-dot" />

          <div>
            <div className="workspace-label">Workspace</div>
            <div className="workspace-value">Platform Owner</div>
          </div>
        </div>

        <nav className="main-nav" aria-label="Dashboard navigation">
          <div className="nav-heading">Manage</div>

          {navItems.map((item) => (
            <button
              key={item.label}
              className={
                section === item.label
                  ? 'nav-item nav-item-active'
                  : 'nav-item'
              }
              onClick={() => navigate(item.label)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="owner-card">
            <div className="avatar">MK</div>

            <div className="owner-copy">
              <strong>Platform Owner</strong>
              <span>Administrator</span>
            </div>

            <button
              className="owner-menu"
              aria-label="Logout"
              title="Logout"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              {loggingOut ? 'Logging out...' : 'Logout'}
            </button>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <button
          className="sidebar-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <section className="content-area">
        <header className="topbar">
          <div className="topbar-left">
            <button
              className="mobile-menu-button"
              aria-label="Open navigation"
              onClick={() => setMobileOpen(true)}
            >
              ☰
            </button>

            <div>
              <div className="eyebrow">Platform management</div>
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
            onNavigate={navigate}
          />
        )}

        {section === 'Schools' && (
          <Schools onCreate={() => undefined} />
        )}

        {section === 'School Admins' && <SchoolAdmins />}

        {section === 'Audit Log' && <AuditLog />}
      </section>
    </main>
  );
}

function Overview({
  activeSchools,
  totalStudents,
  onNavigate,
}: {
  activeSchools: number;
  totalStudents: number;
  onNavigate: (section: Section) => void;
}) {
  return (
    <div className="page-stack">
      <section className="hero-panel">
        <div>
          <div className="hero-kicker">
            Student2Gate control center
          </div>

          <h2>Manage every school from one place.</h2>

          <p>
            Provision schools, manage School Admin access, and review
            operational activity from the platform console.
          </p>

          <div className="hero-actions">
            <button
              className="primary-button"
              onClick={() => onNavigate('Schools')}
            >
              Open Schools
            </button>

            <button
              className="secondary-button"
              onClick={() => onNavigate('School Admins')}
            >
              Manage Admins
            </button>
          </div>
        </div>

        <div className="hero-orb" aria-hidden="true">
          <div className="hero-orb-inner">S2G</div>
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
          value="4"
          detail="3 active · 1 inactive"
          icon="♙"
        />

        <StatCard
          label="Students"
          value={totalStudents.toLocaleString()}
          detail="Across active schools"
          icon="◉"
        />

        <StatCard
          label="Actions today"
          value="18"
          detail="Admin activity events"
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
              onClick={() => onNavigate('Schools')}
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
                  <th>Admins</th>
                  <th>Students</th>
                </tr>
              </thead>

              <tbody>
                {schools.map((school) => (
                  <tr key={school.name}>
                    <td>
                      <div className="table-primary">
                        {school.name}
                      </div>

                      <div className="table-secondary">
                        {school.city}
                      </div>
                    </td>

                    <td>
                      <StatusBadge status={school.status} />
                    </td>

                    <td>{school.admins}</td>
                    <td>{school.students}</td>
                  </tr>
                ))}
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
              onClick={() => onNavigate('Audit Log')}
            >
              Open
            </button>
          </div>

          <div className="activity-list">
            <ActivityItem
              title="School Admin provisioned"
              target="Demo School · 2 min ago"
              icon="+"
            />

            <ActivityItem
              title="School status updated"
              target="Green Valley School · 21 min ago"
              icon="↻"
            />

            <ActivityItem
              title="Password reset initiated"
              target="Demo School · 48 min ago"
              icon="↺"
            />

            <ActivityItem
              title="School Admin deactivated"
              target="City Public School · 1 hr ago"
              icon="−"
            />
          </div>
        </div>
      </section>
    </div>
  );
}

function Schools({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Tenant management
          </div>

          <h2>Schools</h2>

          <p>
            Create and manage the schools using Student2Gate.
          </p>
        </div>

        <button
          className="primary-button"
          onClick={onCreate}
        >
          + Add school
        </button>
      </section>

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
                <th>School Admins</th>
                <th>Students</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              {schools.map((school) => (
                <tr key={school.name}>
                  <td>
                    <div className="table-primary">
                      {school.name}
                    </div>

                    <div className="table-secondary">
                      {school.city}
                    </div>
                  </td>

                  <td>
                    <StatusBadge status={school.status} />
                  </td>

                  <td>{school.admins}</td>
                  <td>{school.students}</td>

                  <td>
                    <button className="row-action">
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function SchoolAdmins() {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Privileged access
          </div>

          <h2>School Admins</h2>

          <p>
            Provision and manage the administrators responsible
            for each school.
          </p>
        </div>

        <button className="primary-button">
          + Create School Admin
        </button>
      </section>

      <section className="info-banner">
        <div className="info-icon">i</div>

        <div>
          <strong>Secure provisioning</strong>

          <p>
            Account creation will be server-controlled. The
            dashboard will create the Firebase Authentication
            account and the matching trusted Student2Gate profile
            together.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="toolbar">
          <input
            className="search-input"
            placeholder="Search administrators…"
            aria-label="Search administrators"
          />

          <button className="filter-button">
            All schools ▾
          </button>

          <button className="filter-button">
            All statuses ▾
          </button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Administrator</th>
                <th>School</th>
                <th>Status</th>
                <th>Last activity</th>
                <th>Action</th>
              </tr>
            </thead>

            <tbody>
              <tr>
                <td>
                  <div className="table-primary">
                    Demo Administrator
                  </div>

                  <div className="table-secondary">
                    admin@demoschool.example
                  </div>
                </td>

                <td>Demo School</td>

                <td>
                  <StatusBadge status="ACTIVE" />
                </td>

                <td>Today, 15:42</td>

                <td>
                  <button className="row-action">
                    Manage
                  </button>
                </td>
              </tr>

              <tr>
                <td>
                  <div className="table-primary">
                    School Office
                  </div>

                  <div className="table-secondary">
                    office@greenvalley.example
                  </div>
                </td>

                <td>Green Valley School</td>

                <td>
                  <StatusBadge status="ACTIVE" />
                </td>

                <td>Today, 14:18</td>

                <td>
                  <button className="row-action">
                    Manage
                  </button>
                </td>
              </tr>

              <tr>
                <td>
                  <div className="table-primary">
                    Former Admin
                  </div>

                  <div className="table-secondary">
                    former@citypublic.example
                  </div>
                </td>

                <td>City Public School</td>

                <td>
                  <StatusBadge status="SUSPENDED" />
                </td>

                <td>Yesterday, 09:12</td>

                <td>
                  <button className="row-action">
                    Manage
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function AuditLog() {
  return (
    <div className="page-stack">
      <section className="section-intro">
        <div>
          <div className="panel-kicker">
            Immutable platform history
          </div>

          <h2>Audit Log</h2>

          <p>
            Review privileged actions performed across
            Student2Gate.
          </p>
        </div>
      </section>

      <section className="panel">
        <div className="audit-list">
          <AuditRow
            action="School Admin provisioned"
            actor="Platform Owner"
            target="Demo School"
            time="2 min ago"
          />

          <AuditRow
            action="School status updated"
            actor="Platform Owner"
            target="Green Valley School"
            time="21 min ago"
          />

          <AuditRow
            action="Password reset initiated"
            actor="Platform Owner"
            target="Demo School"
            time="48 min ago"
          />

          <AuditRow
            action="School Admin deactivated"
            actor="Platform Owner"
            target="City Public School"
            time="1 hr ago"
          />

          <AuditRow
            action="School created"
            actor="Platform Owner"
            target="City Public School"
            time="Yesterday"
          />
        </div>
      </section>
    </div>
  );
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
        <span className="stat-icon">{icon}</span>
      </div>

      <div className="stat-value">{value}</div>

      <div className="stat-detail">{detail}</div>
    </div>
  );
}

function StatusBadge({
  status,
}: {
  status: 'ACTIVE' | 'SUSPENDED';
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

function ActivityItem({
  title,
  target,
  icon,
}: {
  title: string;
  target: string;
  icon: string;
}) {
  return (
    <div className="activity-item">
      <div className="activity-icon">{icon}</div>

      <div className="activity-copy">
        <strong>{title}</strong>
        <span>{target}</span>
      </div>
    </div>
  );
}

function AuditRow({
  action,
  actor,
  target,
  time,
}: {
  action: string;
  actor: string;
  target: string;
  time: string;
}) {
  return (
    <div className="audit-row">
      <div className="audit-marker" />

      <div className="audit-main">
        <strong>{action}</strong>
        <span>
          {actor} → {target}
        </span>
      </div>

      <time>{time}</time>
    </div>
  );
}