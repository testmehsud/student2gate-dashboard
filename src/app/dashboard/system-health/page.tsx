'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';

import { HEALTH_THRESHOLDS, SYSTEM_HEALTH_REFRESH_INTERVAL_MS, TIME_RANGES, type TimeRange } from '@/lib/system-health/config';
import { filterMonitoringErrors } from '@/lib/system-health/model';
import type { HealthSource, HealthState, MonitoringError, SystemHealthPayload } from '@/lib/system-health/types';
import styles from './system-health.module.css';

const RANGE_OPTIONS = Object.keys(TIME_RANGES) as TimeRange[];

function statusLabel(status: HealthState) {
  if (status === 'healthy') return 'Operational';
  if (status === 'warning') return 'Attention';
  if (status === 'critical') return 'Critical';
  return 'Unavailable';
}

function globalLabel(status: HealthState) {
  if (status === 'healthy') return 'ALL SYSTEMS OPERATIONAL';
  if (status === 'warning') return 'ATTENTION REQUIRED';
  if (status === 'critical') return 'SYSTEM ISSUE DETECTED';
  return 'MONITORING DATA UNAVAILABLE';
}

function formatNumber(value: number | null, fraction = 0) {
  if (value === null || !Number.isFinite(value)) return 'Unavailable';
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits: fraction,
    minimumFractionDigits: fraction,
  }).format(value);
}

function formatPercent(value: number | null) {
  return value === null ? 'Unavailable' : `${formatNumber(value, 2)}%`;
}

function relativeTime(value: string | null, now: number) {
  if (!value) return 'No sample time';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'No sample time';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formattedDate(value: string | null) {
  if (!value) return 'Unavailable';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'Unavailable';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(timestamp);
}

function StatePill({ source }: { source: HealthSource }) {
  return (
    <span className={`${styles.statePill} ${styles[`state_${source.status}`]}`}>
      <span className={styles.stateDot} aria-hidden="true" />
      {statusLabel(source.status)}
    </span>
  );
}

function ServiceCard({
  title,
  subtitle,
  source,
  children,
}: {
  title: string;
  subtitle: string;
  source: HealthSource;
  children?: React.ReactNode;
}) {
  return (
    <article className={styles.serviceCard}>
      <div className={styles.serviceHeader}>
        <div>
          <p className={styles.cardEyebrow}>{subtitle}</p>
          <h3>{title}</h3>
        </div>
        <StatePill source={source} />
      </div>
      <p className={styles.serviceDetail}>{source.detail}</p>
      {children}
    </article>
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
    <article className={styles.statCard}>
      <div className={styles.statHead}>
        <span>{label}</span>
        <span className={styles.statIcon} aria-hidden="true">{icon}</span>
      </div>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default function SystemHealthPage() {
  const router = useRouter();
  const [range, setRange] = useState<TimeRange>('5m');
  const [payload, setPayload] = useState<SystemHealthPayload | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const [serviceFilter, setServiceFilter] = useState('all');
  const [severityFilter, setSeverityFilter] = useState('all');
  const [sortNewestFirst, setSortNewestFirst] = useState(true);
  const [selectedError, setSelectedError] = useState<MonitoringError | null>(null);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch(`/api/platform/system-health?range=${range}`, {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const result = await response.json().catch(() => null);

      if (response.status === 401) {
        setPayload(null);
        router.replace('/login');
        return;
      }
      if (!response.ok || !result?.ok) {
        throw new Error('Monitoring data temporarily unavailable.');
      }

      setPayload(result as SystemHealthPayload);
      setRefreshError(false);
    } catch {
      setRefreshError(true);
    } finally {
      setInitialLoading(false);
      setRefreshing(false);
    }
  }, [range, router]);

  useEffect(() => {
    const kickoff = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), SYSTEM_HEALTH_REFRESH_INTERVAL_MS);
    return () => {
      window.clearTimeout(kickoff);
      window.clearInterval(timer);
    };
  }, [load]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);

  const displayedErrors = useMemo(() => {
    const filtered = filterMonitoringErrors(
      payload?.errors ?? [],
      serviceFilter,
      severityFilter,
    );
    return sortNewestFirst
      ? filtered
      : [...filtered].reverse();
  }, [payload?.errors, serviceFilter, severityFilter, sortNewestFirst]);

  const relativeNow = now ?? (payload ? Date.parse(payload.generatedAt) : 0);
  const monitoringAge = payload ? relativeTime(payload.generatedAt, relativeNow) : 'Waiting for first response';
  const dataRange = payload ? TIME_RANGES[payload.range].label : TIME_RANGES[range].label;
  const hasPreviousRange = payload !== null && payload.range !== range;

  return (
    <main className={styles.page}>
      <header className={styles.pageHeader}>
        <div>
          <Link className={styles.backLink} href="/dashboard">← Platform management</Link>
          <p className={styles.eyebrow}>Platform operations</p>
          <h1>System Health</h1>
          <p className={styles.subtitle}>Live operational status for Student2Gate infrastructure and services.</p>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.updated}>
            {payload ? `Updated ${monitoringAge}` : 'Not yet updated'}
          </span>
          <button className={styles.refreshButton} type="button" onClick={() => void load()} disabled={refreshing}>
            <span aria-hidden="true">↻</span> {refreshing ? 'Refreshing' : 'Refresh'}
          </button>
        </div>
      </header>

      {refreshError && (
        <div className={styles.refreshNotice} role="status">
          <strong>Monitoring data temporarily unavailable.</strong>
          {payload
            ? ` Showing the last successful ${TIME_RANGES[payload.range].label} snapshot from ${formattedDate(payload.generatedAt)}.`
            : ' Waiting for a successful monitoring response.'}
        </div>
      )}

      {initialLoading && !payload ? (
        <section className={styles.loadingPanel} aria-live="polite">
          <span className={styles.loadingMark} aria-hidden="true">S2</span>
          <div><strong>Connecting to monitoring sources</strong><p>Checking authenticated service status and available metrics.</p></div>
        </section>
      ) : payload ? (
        <>
          <section className={`${styles.healthBanner} ${styles[`banner_${payload.globalStatus}`]}`} aria-live="polite">
            <span className={styles.bannerMark} aria-hidden="true">
              {payload.globalStatus === 'healthy' ? '✓' : payload.globalStatus === 'critical' ? '×' : '!'}
            </span>
            <div className={styles.bannerCopy}>
              <strong>{globalLabel(payload.globalStatus)}</strong>
              <p>{payload.statusReason}</p>
              <small>Selected period: {dataRange} · snapshot generated {monitoringAge}</small>
            </div>
            <div className={styles.bannerMeta}>
              {refreshing && <span className={styles.refreshingLabel}>Refreshing in background</span>}
              {hasPreviousRange && <span>Showing {dataRange} while {TIME_RANGES[range].label} loads</span>}
            </div>
          </section>

          <section className={styles.serviceGrid} aria-label="Service status">
            <ServiceCard title="Web dashboard" subtitle="WEB" source={payload.sources.web}>
              <div className={styles.cardFootnote}>This view is being served by the current dashboard runtime.</div>
            </ServiceCard>
            <ServiceCard title="Student2Gate Worker" subtitle="WORKER API" source={payload.sources.worker}>
              <div className={styles.miniMetrics}>
                <span><b>{formatNumber(payload.metrics.worker.requests)}</b> requests</span>
                <span><b>{formatPercent(payload.metrics.worker.errorRatePercent)}</b> error rate</span>
              </div>
            </ServiceCard>
            <ServiceCard title="Firestore" subtitle="DATABASE" source={payload.sources.firestoreMetrics}>
              <div className={styles.miniMetrics}>
                <span><b>{formatNumber(payload.metrics.firestore.reads)}</b> reads</span>
                <span><b>{formatNumber(payload.metrics.firestore.writes)}</b> writes</span>
              </div>
            </ServiceCard>
            <ServiceCard title="Firebase Authentication" subtitle="AUTH" source={payload.sources.firebaseAuth}>
              <div className={styles.cardFootnote}>Session verification only; Firebase Auth does not provide usage metrics through this check.</div>
            </ServiceCard>
            <ServiceCard title="Production deployment" subtitle="VERCEL" source={payload.sources.vercel}>
              <div className={styles.cardFootnote}>
                {payload.deployment.commit ? `Commit ${payload.deployment.commit.slice(0, 12)}` : 'Commit unavailable'}
                {payload.deployment.deployedAt ? ` · deployed ${formattedDate(payload.deployment.deployedAt)}` : ' · deploy time unavailable'}
              </div>
            </ServiceCard>
          </section>

          <section className={styles.panel} aria-labelledby="load-heading">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.eyebrow}>Operational metrics</p>
                <h2 id="load-heading">Load &amp; traffic</h2>
                <p className={styles.sectionDescription}>Provider totals for the selected period. Values marked unavailable have no usable sample.</p>
              </div>
              <div className={styles.rangeControl} role="group" aria-label="Monitoring time range">
                {RANGE_OPTIONS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={range === option}
                    className={range === option ? styles.rangeActive : ''}
                    onClick={() => setRange(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
            <div className={styles.statGrid}>
              <StatCard label="Worker requests" value={formatNumber(payload.metrics.worker.requests)} detail={`${formatNumber(payload.metrics.worker.requestsPerMinute, 1)} requests/min average`} icon="↗" />
              <StatCard label="Worker success rate" value={formatPercent(payload.metrics.worker.requests === null || payload.metrics.worker.successes === null || payload.metrics.worker.requests === 0 ? null : (payload.metrics.worker.successes / payload.metrics.worker.requests) * 100)} detail={`${formatNumber(payload.metrics.worker.successes)} successful requests`} icon="✓" />
              <StatCard label="Worker failures" value={formatNumber(payload.metrics.worker.errors)} detail={`${formatPercent(payload.metrics.worker.errorRatePercent)} of requests`} icon="!" />
              <StatCard label="Firestore reads" value={formatNumber(payload.metrics.firestore.reads)} detail="Document read operations" icon="↓" />
              <StatCard label="Firestore writes" value={formatNumber(payload.metrics.firestore.writes)} detail="Document write operations" icon="↑" />
              <StatCard label="Firestore deletes" value={formatNumber(payload.metrics.firestore.deletes)} detail="Document delete operations" icon="−" />
              <StatCard label="Firestore API errors" value={formatNumber(payload.metrics.firestore.apiErrors)} detail={`${formatPercent(payload.metrics.firestore.errorRatePercent)} of API calls`} icon="!" />
              <StatCard label="Firestore p95 latency" value={payload.metrics.firestore.p95LatencyMs === null ? 'Unavailable' : `${formatNumber(payload.metrics.firestore.p95LatencyMs, 1)} ms`} detail="Cloud Monitoring request latency" icon="◷" />
            </div>
            <p className={styles.dataCaveat}>Firestore metrics are sampled every 60 seconds and may arrive up to 4 minutes late. They are operational counts, not exact billing totals.</p>
          </section>

          <section className={styles.panel} aria-labelledby="errors-heading">
            <div className={styles.sectionHeader}>
              <div>
                <p className={styles.eyebrow}>Incident signals</p>
                <h2 id="errors-heading">Errors</h2>
                <p className={styles.sectionDescription}>Recent provider error groups in the selected period. Status means observed; no resolution system is connected.</p>
              </div>
              <div className={styles.errorTotals}>
                <span className={styles.criticalCount}>{payload.errors.filter((item) => item.severity === 'critical').length} critical</span>
                <span className={styles.warningCount}>{payload.errors.filter((item) => item.severity === 'warning').length} warning</span>
              </div>
            </div>
            <div className={styles.filters}>
              <label>Service
                <select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}>
                  <option value="all">All services</option>
                  <option value="Student2Gate Worker">Worker</option>
                  <option value="Firestore">Firestore</option>
                </select>
              </label>
              <label>Severity
                <select value={severityFilter} onChange={(event) => setSeverityFilter(event.target.value)}>
                  <option value="all">All severities</option>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                  <option value="info">Info</option>
                </select>
              </label>
              <span className={styles.resultLimit}>Maximum 25 recent groups · {dataRange}</span>
            </div>
            <div className={styles.tableScroll}>
              <table className={styles.errorTable}>
                <thead><tr>
                  <th><button type="button" className={styles.sortButton} onClick={() => setSortNewestFirst((value) => !value)}>Time {sortNewestFirst ? '↓' : '↑'}</button></th>
                  <th>Service</th><th>Severity</th><th>Error</th><th>Count</th><th>Status</th>
                </tr></thead>
                <tbody>
                  {displayedErrors.length === 0 ? (
                    <tr><td colSpan={6} className={styles.emptyCell}>
                      {payload.errors.length === 0
                        ? 'No sanitized error samples were returned by the connected sources in this period.'
                        : 'No error groups match these filters.'}
                    </td></tr>
                  ) : displayedErrors.map((error) => (
                    <tr key={error.id}>
                      <td><time dateTime={error.lastOccurrence ?? undefined}>{relativeTime(error.lastOccurrence, relativeNow)}</time></td>
                      <td>{error.service}</td>
                      <td><span className={`${styles.severity} ${styles[`severity_${error.severity}`]}`}>{error.severity}</span></td>
                      <td><button type="button" className={styles.errorLink} onClick={() => setSelectedError(error)}>{error.message}</button></td>
                      <td>{formatNumber(error.count)}</td>
                      <td><span className={styles.observed}>Observed</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={styles.issueSourceNote}>
              <strong>Cloudflare Issues and logs are unavailable.</strong>
              <span>{payload.sources.cloudflareIssues.detail}</span>
            </div>
          </section>

          <div className={styles.lowerGrid}>
            <section className={styles.panel} aria-labelledby="deployment-heading">
              <div className={styles.sectionHeader}>
                <div><p className={styles.eyebrow}>Release context</p><h2 id="deployment-heading">Current production</h2></div>
              </div>
              <dl className={styles.detailList}>
                <div><dt>Environment</dt><dd>{payload.deployment.environment ?? 'Unavailable'}</dd></div>
                <div><dt>Application commit</dt><dd className={styles.mono}>{payload.deployment.commit ?? 'Unavailable'}</dd></div>
                <div><dt>Vercel deployment</dt><dd className={styles.mono}>{payload.deployment.deploymentId ?? 'Unavailable'}</dd></div>
                <div><dt>Deployment time</dt><dd>{formattedDate(payload.deployment.deployedAt)}</dd></div>
                <div><dt>Worker version</dt><dd>{payload.deployment.workerVersion ?? 'Unavailable'}</dd></div>
              </dl>
              <p className={styles.dataCaveat}>{payload.sources.vercel.detail}</p>
            </section>

            <section className={styles.panel} aria-labelledby="limits-heading">
              <div className={styles.sectionHeader}>
                <div><p className={styles.eyebrow}>Abuse controls</p><h2 id="limits-heading">Rate limit health</h2></div>
                <span className={styles.statePill + ' ' + styles.state_unavailable}>Rejections unavailable</span>
              </div>
              <p className={styles.sectionDescription}>Checked-in Worker configuration snapshot; values are not fetched from the deployed Worker.</p>
              <div className={styles.limitList}>
                {payload.configuredRateLimits.map((limit) => (
                  <div key={limit.name}><span>{limit.name}</span><strong>{limit.requests} / {limit.periodSeconds}s</strong></div>
                ))}
              </div>
              <p className={styles.dataCaveat}>Recent rejected requests and live deployed limits are not exposed by the currently connected metrics source.</p>
            </section>
          </div>

          <section className={styles.panel} aria-labelledby="architecture-heading">
            <div className={styles.sectionHeader}>
              <div><p className={styles.eyebrow}>Platform map</p><h2 id="architecture-heading">Infrastructure snapshot</h2></div>
            </div>
            <div className={styles.architectureGrid}>
              <ArchitectureItem label="WEB" source={payload.sources.web} detail="Next.js Platform Console" />
              <ArchitectureItem label="WORKER" source={payload.sources.worker} detail="student2gate-api" />
              <ArchitectureItem label="FIRESTORE" source={payload.sources.firestoreMetrics} detail="Operations via Cloud Monitoring" />
              <ArchitectureItem label="AUTH" source={payload.sources.firebaseAuth} detail="Session verification" />
              <ArchitectureItem label="DURABLE OBJECT" source={payload.sources.worker} detail="Teacher mutation coordination" />
              <ArchitectureItem label="KV &amp; LIMITERS" source={payload.sources.worker} detail="KV-backed limits · 7 configured limiters" />
            </div>
          </section>

          <section className={styles.thresholdPanel} aria-labelledby="threshold-heading">
            <div><p className={styles.eyebrow}>Server-side alert rules</p><h2 id="threshold-heading">Monitoring thresholds</h2></div>
            <ul>
              <li>Worker error rate above {HEALTH_THRESHOLDS.worker.warningErrorRatePercent}% for 5 minutes → warning</li>
              <li>Worker error rate above {HEALTH_THRESHOLDS.worker.criticalErrorRatePercent}% for 5 minutes → critical</li>
              <li>Worker failures ≥ {HEALTH_THRESHOLDS.worker.warningFailures} / {HEALTH_THRESHOLDS.worker.criticalFailures} in 5 minutes → warning / critical</li>
              <li>Firestore service errors ≥ {HEALTH_THRESHOLDS.firestore.warningFailures} / {HEALTH_THRESHOLDS.firestore.criticalFailures} in 5 minutes → warning / critical</li>
              <li>Firestore p95 latency ≥ {HEALTH_THRESHOLDS.firestore.warningP95LatencyMs} / {HEALTH_THRESHOLDS.firestore.criticalP95LatencyMs} ms → warning / critical</li>
            </ul>
            <p>Worker and database thresholds are distinct from missing-source states. An unavailable source can never produce an all-systems-operational banner.</p>
          </section>
        </>
      ) : (
        <section className={styles.emptyState} role="status">
          <strong>Monitoring data temporarily unavailable</strong>
          <p>The last request did not return a safe monitoring snapshot. Automatic refresh continues every 30 seconds.</p>
        </section>
      )}

      {selectedError && (
        <div className={styles.modalBackdrop} role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSelectedError(null);
        }}>
          <section className={styles.errorModal} role="dialog" aria-modal="true" aria-labelledby="error-detail-title">
            <div className={styles.modalHead}>
              <div><p className={styles.eyebrow}>Sanitized provider sample</p><h2 id="error-detail-title">Error details</h2></div>
              <button type="button" className={styles.modalClose} onClick={() => setSelectedError(null)} aria-label="Close error details">×</button>
            </div>
            <dl className={styles.detailList}>
              <div><dt>Service</dt><dd>{selectedError.service}</dd></div>
              <div><dt>Severity</dt><dd><span className={`${styles.severity} ${styles[`severity_${selectedError.severity}`]}`}>{selectedError.severity}</span></dd></div>
              <div><dt>Error type</dt><dd>{selectedError.errorType}</dd></div>
              <div><dt>Message</dt><dd>{selectedError.message}</dd></div>
              <div><dt>First sampled</dt><dd>{formattedDate(selectedError.firstOccurrence)}</dd></div>
              <div><dt>Last sampled</dt><dd>{formattedDate(selectedError.lastOccurrence)}</dd></div>
              <div><dt>Occurrence count</dt><dd>{formatNumber(selectedError.count)}</dd></div>
              <div><dt>Status</dt><dd>Observed in provider metrics; resolution state unavailable.</dd></div>
            </dl>
            <p className={styles.dataCaveat}>Raw logs, stack traces, request IDs, and user data are not included in this detail view.</p>
          </section>
        </div>
      )}
    </main>
  );
}

function ArchitectureItem({ label, detail, source }: { label: string; detail: string; source: HealthSource }) {
  return (
    <article className={styles.architectureItem}>
      <div className={styles.architectureTitle}><span>{label}</span><StatePill source={source} /></div>
      <p>{detail}</p>
    </article>
  );
}


