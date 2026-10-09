'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  nextDataDeletionStatuses,
  type DataDeletionStatus,
} from '@/lib/data-deletion';
import styles from './data-deletion-requests.module.css';

type RequestRow = {
  requestId: string;
  requestReference: string;
  email: string;
  accountRole: string;
  school: string;
  status: DataDeletionStatus;
  submittedAt: string | null;
  updatedAt: string | null;
};
type HistoryEvent = {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  actorType: string;
  actorUid: string;
  actorName: string;
  changedAt: string | null;
};
const labels: Record<DataDeletionStatus, string> = {
  RECEIVED: 'Received',
  VERIFICATION_REQUIRED: 'Verification required',
  IN_PROGRESS: 'In progress',
  UNABLE_TO_COMPLETE: 'Unable to complete / retention exception',
};
function displayDate(value: string | null): string {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString();
}

export default function DataDeletionRequests() {
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, DataDeletionStatus>>({});
  const [history, setHistory] = useState<Record<string, HistoryEvent[] | undefined>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const loadRequests = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/platform/data-deletion-requests', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(result?.requests)) {
        throw new Error('Unable to load deletion requests.');
      }
      const rows = result.requests as RequestRow[];
      setRequests(rows);
      setDraftStatuses(Object.fromEntries(rows.map((row) => [row.requestId, row.status])));
    } catch {
      setError('Deletion requests could not be loaded. Refresh and try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadRequests(); }, 0);
    return () => window.clearTimeout(timer);
  }, [loadRequests]);

  async function saveStatus(row: RequestRow) {
    const status = draftStatuses[row.requestId];
    if (!status || status === row.status || saving) return;
    setSaving(row.requestId);
    setError('');
    setNotice('');
    try {
      const csrfResponse = await fetch('/api/auth/csrf', {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const csrfResult = await csrfResponse.json().catch(() => null);
      if (!csrfResponse.ok || typeof csrfResult?.token !== 'string') {
        throw new Error('Unable to start a secure update.');
      }
      const response = await fetch(
        '/api/platform/data-deletion-requests/' + encodeURIComponent(row.requestId),
        {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ csrfToken: csrfResult.token, status }),
        },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !result?.request) throw new Error('Unable to update this request.');
      const updated = result.request as RequestRow;
      setRequests((current) => current.map((item) => item.requestId === updated.requestId ? updated : item));
      setDraftStatuses((current) => ({ ...current, [updated.requestId]: updated.status }));
      setNotice('Review status saved. Contact the requester separately using the account email when a response is needed.');
      setHistory((current) => ({ ...current, [row.requestId]: undefined }));
    } catch {
      setError('The status was not saved. Refresh and try again.');
    } finally {
      setSaving(null);
    }
  }

  async function toggleHistory(row: RequestRow) {
    const nextExpanded = !expanded[row.requestId];
    setExpanded((current) => ({ ...current, [row.requestId]: nextExpanded }));
    if (!nextExpanded || history[row.requestId]) return;
    try {
      const response = await fetch(
        '/api/platform/data-deletion-requests/' + encodeURIComponent(row.requestId),
        { credentials: 'same-origin', cache: 'no-store' },
      );
      const result = await response.json().catch(() => null);
      if (!response.ok || !Array.isArray(result?.events)) throw new Error('Unable to load history.');
      setHistory((current) => ({ ...current, [row.requestId]: result.events as HistoryEvent[] }));
    } catch {
      setError('Request history could not be loaded.');
    }
  }

  return (
    <section className={styles.section} aria-labelledby='deletion-requests-heading'>
      <div className={styles.intro}>
        <div>
          <h2 id='deletion-requests-heading'>Account deletion requests</h2>
          <p>Review requests, verify the requester, and record the current review status.</p>
        </div>
        <button className={styles.refresh} type='button' onClick={() => void loadRequests()} disabled={loading}>
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>
      <div className={styles.notice}>
        <strong>Review tracking only.</strong> This dashboard does not erase accounts or records. Do not mark a request completed here. No completed status is available until a verified, authorized erasure process exists.
      </div>
      {notice && <p className={styles.statusMessage} role='status' aria-live='polite'>{notice}</p>}
      {error && <p className={styles.errorMessage} role='alert'>{error}</p>}
      {loading && <p role='status'>Loading requests...</p>}
      {!loading && !error && requests.length === 0 && <p className={styles.empty}>No deletion requests have been received.</p>}
      {!loading && requests.length > 0 && (
        <div className={styles.list}>
          <p className={styles.caption}>Showing the latest {requests.length} requests (maximum 100).</p>
          {requests.map((row) => {
            const nextStatuses = nextDataDeletionStatuses(row.status);
            return (
              <article className={styles.card} key={row.requestId}>
                <div className={styles.cardHeader}>
                  <div>
                    <p className={styles.reference}>{row.requestReference}</p>
                    <h3>{row.email}</h3>
                  </div>
                  <span className={styles.badge}>{labels[row.status]}</span>
                </div>
                <dl className={styles.details}>
                  <div><dt>Submitted</dt><dd>{displayDate(row.submittedAt)}</dd></div>
                  <div><dt>Account role</dt><dd>{row.accountRole.replaceAll('_', ' ')}</dd></div>
                  {row.school && <div><dt>School / organization</dt><dd>{row.school}</dd></div>}
                </dl>
                <div className={styles.actions}>
                  <label>
                    Review status
                    <select
                      value={draftStatuses[row.requestId] ?? row.status}
                      onChange={(event) => setDraftStatuses((current) => ({ ...current, [row.requestId]: event.target.value as DataDeletionStatus }))}
                      disabled={saving === row.requestId || nextStatuses.length === 0}
                    >
                      {[row.status, ...nextStatuses].map((status) => (
                        <option value={status} key={status}>{labels[status]}</option>
                      ))}
                    </select>
                  </label>
                  <button type='button' className={styles.save} onClick={() => void saveStatus(row)} disabled={saving === row.requestId || draftStatuses[row.requestId] === row.status || nextStatuses.length === 0}>
                    {saving === row.requestId ? 'Saving...' : 'Save review status'}
                  </button>
                  <a className={styles.contact} href={'mailto:' + encodeURIComponent(row.email) + '?subject=' + encodeURIComponent('Student2Gate request ' + row.requestReference)}>
                    Contact requester
                  </a>
                  <button type='button' className={styles.historyButton} onClick={() => void toggleHistory(row)} aria-expanded={expanded[row.requestId] === true}>
                    {expanded[row.requestId] ? 'Hide history' : 'View history'}
                  </button>
                </div>
                {expanded[row.requestId] && (
                  <ol className={styles.history} aria-label={'Status history for ' + row.requestReference}>
                    {(history[row.requestId] ?? []).map((event) => (
                      <li key={event.id}>
                        <span>{event.fromStatus ? labels[event.fromStatus as DataDeletionStatus] ?? event.fromStatus : 'Submitted'} to {labels[event.toStatus as DataDeletionStatus] ?? event.toStatus}</span>
                        <small>{displayDate(event.changedAt)} · {event.actorName || event.actorType}</small>
                      </li>
                    ))}
                    {history[row.requestId]?.length === 0 && <li>No status changes recorded.</li>}
                  </ol>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
