'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  fetchHealth,
  fetchJobDetail,
  fetchJobs,
  fetchSession,
  fetchStubConfig,
  resetStubFixtures,
  retryJob,
  selectSyntheticSession,
  updateStubConfig,
} from '@/lib/api-client';
import { formatUtcTimestamp } from '@/lib/format';
import type {
  DashboardNotice,
  IntegrationJob,
  PollState,
  SessionId,
  SessionInfo,
  StubConfig,
} from '@/lib/types';
import { StatusBadge } from './StatusBadge';

export const POLL_INTERVAL_MS = 350;
export const MAX_POLL_ATTEMPTS = 5;

const DEFAULT_STUB_CONFIG: StubConfig = {
  delayMs: 0,
  delayVenueId: null,
  force500: false,
  force500Remaining: 0,
  neverComplete: false,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getInitialVenueParam(): string {
  if (typeof window === 'undefined') {
    return 'ALL';
  }
  const param = new URLSearchParams(window.location.search).get('venueId');
  return param && param.trim().length > 0 ? param.trim() : 'ALL';
}

type StubPreset = 'normal' | 'delay' | 'forced500' | 'neverComplete';

function getActivePreset(config: StubConfig): StubPreset {
  if (config.force500 || config.force500Remaining > 0) {
    return 'forced500';
  }
  if (config.neverComplete) {
    return 'neverComplete';
  }
  if (config.delayMs > 0) {
    return 'delay';
  }
  return 'normal';
}

export function IntegrationDashboard() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [apiHealthy, setApiHealthy] = useState<boolean | null>(null);
  const [stubConfig, setStubConfig] = useState<StubConfig>(DEFAULT_STUB_CONFIG);
  const [selectedVenue, setSelectedVenue] = useState<string>('ALL');

  const [jobs, setJobs] = useState<IntegrationJob[] | null>(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string | null>(null);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [notice, setNotice] = useState<DashboardNotice>({ kind: 'none' });
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const [submittingJobIds, setSubmittingJobIds] = useState<ReadonlySet<string>>(new Set());
  const [pollStates, setPollStates] = useState<Record<string, PollState>>({});

  const jobsRequestSeqRef = useRef<number>(0);
  const jobsAbortRef = useRef<AbortController | null>(null);
  const retryInFlightRef = useRef<Set<string>>(new Set());
  const pollGenerationRef = useRef<Record<string, number>>({});
  const mountedRef = useRef<boolean>(true);

  const cancelAllPolls = useCallback(() => {
    for (const jobId of Object.keys(pollGenerationRef.current)) {
      pollGenerationRef.current[jobId] = (pollGenerationRef.current[jobId] ?? 0) + 1;
    }
    setPollStates({});
  }, []);

  const loadHealth = useCallback(async () => {
    try {
      const health = await fetchHealth();
      if (mountedRef.current) {
        setApiHealthy(health.apiHealthy);
      }
    } catch {
      if (mountedRef.current) {
        setApiHealthy(false);
      }
    }
  }, []);

  const loadJobs = useCallback(async (venueFilter: string, options?: { clearPrevious?: boolean }) => {
    jobsRequestSeqRef.current += 1;
    const requestSeq = jobsRequestSeqRef.current;

    jobsAbortRef.current?.abort();
    const controller = new AbortController();
    jobsAbortRef.current = controller;

    if (options?.clearPrevious) {
      setJobs(null);
      setIsInitialLoading(true);
      setIsRefreshing(false);
    } else {
      setIsRefreshing(true);
    }
    setNotice({ kind: 'none' });

    try {
      const res = await fetchJobs(venueFilter, controller.signal);
      if (!mountedRef.current || requestSeq !== jobsRequestSeqRef.current || controller.signal.aborted) {
        return;
      }

      setJobs(res.items);
      setLastUpdatedAt(new Date().toISOString());
      setSelectedJobId((prev) => {
        if (prev && res.items.some((item) => item.id === prev)) {
          return prev;
        }
        return res.items[0]?.id ?? null;
      });
      setIsInitialLoading(false);
      setIsRefreshing(false);
    } catch (err) {
      if (!mountedRef.current || requestSeq !== jobsRequestSeqRef.current || controller.signal.aborted) {
        return;
      }

      setIsInitialLoading(false);
      setIsRefreshing(false);

      if (err instanceof ApiError) {
        if (err.status === 401) {
          setJobs([]);
          setSelectedJobId(null);
          setNotice({ kind: 'unauthorized', message: err.message });
          return;
        }
        if (err.status === 403) {
          setNotice({ kind: 'forbidden', message: err.message });
          return;
        }
        setNotice({ kind: 'server_error', message: err.message });
        return;
      }

      setNotice({
        kind: 'server_error',
        message: 'Unexpected error loading integration jobs.',
      });
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const initialVenue = getInitialVenueParam();
    setSelectedVenue(initialVenue);

    async function bootstrap(): Promise<void> {
      void loadHealth();
      try {
        const config = await fetchStubConfig();
        if (mountedRef.current) {
          setStubConfig(config);
        }
      } catch {
        // Non-fatal if stub config endpoint fails on initial mount
      }

      let activeSession: SessionInfo | null = null;
      try {
        activeSession = await fetchSession();
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          const created = await selectSyntheticSession('operator-A');
          if ('sessionId' in created) {
            activeSession = created;
          }
        } else if (mountedRef.current) {
          setIsInitialLoading(false);
          setNotice({
            kind: 'server_error',
            message: 'Unable to reach API session endpoint.',
          });
          return;
        }
      }

      if (!mountedRef.current || !activeSession) {
        return;
      }

      setSession(activeSession);
      await loadJobs(initialVenue, { clearPrevious: true });
    }

    void bootstrap();

    return () => {
      mountedRef.current = false;
      jobsAbortRef.current?.abort();
      for (const jobId of Object.keys(pollGenerationRef.current)) {
        pollGenerationRef.current[jobId] = (pollGenerationRef.current[jobId] ?? 0) + 1;
      }
    };
  }, [loadHealth, loadJobs]);

  const applyJobUpdate = useCallback((updated: IntegrationJob) => {
    setJobs((prev) => {
      if (!prev) {
        return [updated];
      }
      const exists = prev.some((item) => item.id === updated.id);
      if (!exists) {
        return prev;
      }
      return prev.map((item) => (item.id === updated.id ? updated : item));
    });
    setLastUpdatedAt(new Date().toISOString());
  }, []);

  const startBoundedPolling = useCallback(
    async (jobId: string) => {
      const nextGeneration = (pollGenerationRef.current[jobId] ?? 0) + 1;
      pollGenerationRef.current[jobId] = nextGeneration;

      for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt += 1) {
        if (!mountedRef.current || pollGenerationRef.current[jobId] !== nextGeneration) {
          return;
        }

        setPollStates((prev) => ({
          ...prev,
          [jobId]: { kind: 'polling', attempt, maxAttempts: MAX_POLL_ATTEMPTS },
        }));

        await sleep(POLL_INTERVAL_MS);

        if (!mountedRef.current || pollGenerationRef.current[jobId] !== nextGeneration) {
          return;
        }

        try {
          const detail = await fetchJobDetail(jobId);
          if (!mountedRef.current || pollGenerationRef.current[jobId] !== nextGeneration) {
            return;
          }

          applyJobUpdate(detail);

          if (detail.status === 'HEALTHY') {
            setPollStates((prev) => ({ ...prev, [jobId]: { kind: 'completed' } }));
            setLiveAnnouncement(`Job ${jobId} is now HEALTHY.`);
            return;
          }

          if (detail.status === 'FAILED') {
            setPollStates((prev) => ({ ...prev, [jobId]: { kind: 'idle' } }));
            return;
          }
        } catch (err) {
          if (!mountedRef.current || pollGenerationRef.current[jobId] !== nextGeneration) {
            return;
          }
          const message = err instanceof Error ? err.message : 'Status poll failed.';
          setNotice({ kind: 'server_error', message });
          setPollStates((prev) => ({ ...prev, [jobId]: { kind: 'unresolved', attempts: attempt } }));
          return;
        }
      }

      if (mountedRef.current && pollGenerationRef.current[jobId] === nextGeneration) {
        setPollStates((prev) => ({
          ...prev,
          [jobId]: { kind: 'unresolved', attempts: MAX_POLL_ATTEMPTS },
        }));
        setLiveAnnouncement(
          `Job ${jobId} remained QUEUED after ${MAX_POLL_ATTEMPTS} checks; polling stopped.`,
        );
      }
    },
    [applyJobUpdate],
  );

  const handleSessionChange = useCallback(
    async (value: string) => {
      cancelAllPolls();
      retryInFlightRef.current.clear();
      setSubmittingJobIds(new Set());
      setSelectedVenue('ALL');
      setSelectedJobId(null);

      if (value === 'signed-out') {
        await selectSyntheticSession(null);
        setSession(null);
        await loadJobs('ALL', { clearPrevious: true });
        return;
      }

      const nextSessionId = value as SessionId;
      const result = await selectSyntheticSession(nextSessionId);
      if ('sessionId' in result) {
        setSession(result);
        setLiveAnnouncement(`Switched session to ${result.sessionId} (Tenant ${result.tenantId}, ${result.role}).`);
        await loadJobs('ALL', { clearPrevious: true });
      }
    },
    [cancelAllPolls, loadJobs],
  );

  const handleVenueChange = useCallback(
    async (venue: string) => {
      setSelectedVenue(venue);
      await loadJobs(venue);
    },
    [loadJobs],
  );

  const handleRetry = useCallback(
    async (jobId: string) => {
      if (retryInFlightRef.current.has(jobId)) {
        return;
      }
      const existingPoll = pollStates[jobId];
      if (existingPoll?.kind === 'polling') {
        return;
      }

      retryInFlightRef.current.add(jobId);
      setSubmittingJobIds(new Set(retryInFlightRef.current));
      setNotice({ kind: 'none' });

      try {
        await retryJob(jobId);
        setJobs((prev) =>
          prev
            ? prev.map((item) =>
                item.id === jobId ? { ...item, status: 'QUEUED' } : item,
              )
            : prev,
        );
        setLiveAnnouncement(`Retry queued for job ${jobId}.`);
        void startBoundedPolling(jobId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setJobs((prev) =>
            prev
              ? prev.map((item) =>
                  item.id === jobId ? { ...item, status: 'QUEUED' } : item,
                )
              : prev,
          );
          setNotice({ kind: 'info', message: err.message });
          if (pollStates[jobId]?.kind !== 'polling') {
            void startBoundedPolling(jobId);
          }
        } else if (err instanceof ApiError) {
          setNotice({
            kind: err.status === 403 ? 'forbidden' : 'server_error',
            message: err.message,
          });
        } else {
          setNotice({ kind: 'server_error', message: 'Failed to queue job retry.' });
        }
      } finally {
        retryInFlightRef.current.delete(jobId);
        if (mountedRef.current) {
          setSubmittingJobIds(new Set(retryInFlightRef.current));
        }
      }
    },
    [pollStates, startBoundedPolling],
  );

  const handleCheckStatusOnce = useCallback(
    async (jobId: string) => {
      setNotice({ kind: 'none' });
      try {
        const detail = await fetchJobDetail(jobId);
        applyJobUpdate(detail);
        if (detail.status === 'HEALTHY') {
          setPollStates((prev) => ({ ...prev, [jobId]: { kind: 'completed' } }));
          setLiveAnnouncement(`Job ${jobId} is now HEALTHY.`);
        } else if (detail.status === 'QUEUED') {
          setPollStates((prev) => ({
            ...prev,
            [jobId]: { kind: 'unresolved', attempts: MAX_POLL_ATTEMPTS },
          }));
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unable to check job status.';
        setNotice({ kind: 'server_error', message });
      }
    },
    [applyJobUpdate],
  );

  const handleSelectStubPreset = useCallback(
    async (preset: StubPreset) => {
      setNotice({ kind: 'none' });
      let patch: Partial<StubConfig>;
      if (preset === 'normal') {
        patch = { delayMs: 0, delayVenueId: null, force500: false, force500Remaining: 0, neverComplete: false };
      } else if (preset === 'delay') {
        patch = { delayMs: 1200, delayVenueId: 'A1', force500: false, force500Remaining: 0, neverComplete: false };
      } else if (preset === 'forced500') {
        patch = { delayMs: 0, delayVenueId: null, force500: false, force500Remaining: 1, neverComplete: false };
      } else {
        patch = { delayMs: 0, delayVenueId: null, force500: false, force500Remaining: 0, neverComplete: true };
      }

      const nextConfig = await updateStubConfig(patch);
      if (!mountedRef.current) {
        return;
      }
      setStubConfig(nextConfig);

      if (preset === 'forced500') {
        await loadJobs(selectedVenue);
      }
    },
    [loadJobs, selectedVenue],
  );

  const handleResetFixtures = useCallback(async () => {
    cancelAllPolls();
    retryInFlightRef.current.clear();
    setSubmittingJobIds(new Set());
    const result = await resetStubFixtures();
    if (!mountedRef.current) {
      return;
    }
    setStubConfig(result.config);
    setLiveAnnouncement('Fixtures and stub controls reset.');
    await loadJobs(selectedVenue);
  }, [cancelAllPolls, loadJobs, selectedVenue]);

  const selectedJob = useMemo(() => {
    if (!jobs || jobs.length === 0) {
      return null;
    }
    return jobs.find((item) => item.id === selectedJobId) ?? jobs[0] ?? null;
  }, [jobs, selectedJobId]);

  const activePreset = getActivePreset(stubConfig);
  const selectedJobPoll: PollState = selectedJob ? (pollStates[selectedJob.id] ?? { kind: 'idle' }) : { kind: 'idle' };
  const isViewer = session?.role === 'viewer';
  const showStaleBanner = jobs !== null && (isRefreshing || notice.kind === 'server_error');

  return (
    <div className="page-shell">
      <div className="sr-only" aria-live="polite" role="status">
        {liveAnnouncement}
      </div>

      <header className="top-header">
        <div className="top-header__inner">
          <div className="brand-group">
            <h1 className="brand-title">Integration Health Dashboard</h1>
          </div>

          <div className="header-controls">
            <div className="session-control">
              <label htmlFor="session-select" className="session-label">
                Session
              </label>
              <select
                id="session-select"
                className="select-input"
                value={session?.sessionId ?? 'signed-out'}
                onChange={(e) => void handleSessionChange(e.target.value)}
              >
                <option value="operator-A">operator-A (Tenant A · Operator)</option>
                <option value="viewer-A">viewer-A (Tenant A · Viewer)</option>
                <option value="operator-B">operator-B (Tenant B · Operator)</option>
                <option value="signed-out">Signed Out (401 test)</option>
              </select>
            </div>

            <span
              className={`health-pill ${apiHealthy === false ? 'health-pill--down' : 'health-pill--ok'}`}
              aria-label={apiHealthy === false ? 'API Degraded' : 'API Healthy'}
            >
              <span className="health-pill__dot" aria-hidden="true" />
              {apiHealthy === false ? 'API Degraded' : 'API Healthy'}
            </span>
          </div>
        </div>
      </header>

      <section className="stub-bar" aria-label="Deterministic stub test controls">
        <div className="stub-bar__inner">
          <div className="stub-bar__modes" role="group" aria-label="Stub Mode">
            <span className="stub-bar__label">Stub Mode:</span>
            <button
              type="button"
              className={`chip-btn ${activePreset === 'normal' ? 'chip-btn--active' : ''}`}
              aria-pressed={activePreset === 'normal'}
              onClick={() => void handleSelectStubPreset('normal')}
            >
              Normal
            </button>
            <button
              type="button"
              className={`chip-btn ${activePreset === 'delay' ? 'chip-btn--active' : ''}`}
              aria-pressed={activePreset === 'delay'}
              onClick={() => void handleSelectStubPreset('delay')}
            >
              Delay (A1)
            </button>
            <button
              type="button"
              className={`chip-btn ${activePreset === 'forced500' ? 'chip-btn--active' : ''}`}
              aria-pressed={activePreset === 'forced500'}
              onClick={() => void handleSelectStubPreset('forced500')}
            >
              Forced 500
            </button>
            <button
              type="button"
              className={`chip-btn ${activePreset === 'neverComplete' ? 'chip-btn--active' : ''}`}
              aria-pressed={activePreset === 'neverComplete'}
              onClick={() => void handleSelectStubPreset('neverComplete')}
            >
              Never-Complete
            </button>
          </div>

          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void handleResetFixtures()}
          >
            Reset Fixtures
          </button>
        </div>
      </section>

      <main className="main-grid">
        <section className="card" aria-label="Sync Jobs List">
          <div className="filter-bar">
            <div className="venue-group" role="group" aria-label="Venue filter">
              <span className="filter-label">Venue:</span>
              <button
                type="button"
                className={`seg-btn ${selectedVenue === 'ALL' ? 'seg-btn--active' : ''}`}
                aria-pressed={selectedVenue === 'ALL'}
                disabled={!session}
                onClick={() => void handleVenueChange('ALL')}
              >
                All {session ? `(${session.venueIds.join(', ')})` : ''}
              </button>
              {session?.venueIds.map((venue) => (
                <button
                  key={venue}
                  type="button"
                  className={`seg-btn ${selectedVenue === venue ? 'seg-btn--active' : ''}`}
                  aria-pressed={selectedVenue === venue}
                  onClick={() => void handleVenueChange(venue)}
                >
                  {venue}
                </button>
              ))}
            </div>

            <button
              type="button"
              className="btn btn--secondary"
              disabled={isInitialLoading}
              onClick={() => void loadJobs(selectedVenue)}
            >
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>

          {showStaleBanner && (
            <div className="banner banner--stale" role="status">
              <div className="banner__body">
                <strong>
                  {isRefreshing
                    ? 'Refreshing latest status — showing last known data'
                    : 'Showing stale data — last refresh failed'}
                </strong>
                {lastUpdatedAt && (
                  <span className="banner__meta">Last updated {formatUtcTimestamp(lastUpdatedAt)}</span>
                )}
              </div>
              {!isRefreshing && (
                <button type="button" className="btn-link" onClick={() => void loadJobs(selectedVenue)}>
                  Retry Load
                </button>
              )}
            </div>
          )}

          {notice.kind === 'server_error' && (
            <div className="banner banner--error" role="alert">
              <div className="banner__body">
                <strong>Server error:</strong> {notice.message}
              </div>
              <button
                type="button"
                className="btn btn--danger-outline"
                onClick={() => void loadJobs(selectedVenue)}
              >
                Retry Load
              </button>
            </div>
          )}

          {notice.kind === 'forbidden' && (
            <div className="banner banner--error" role="alert">
              <div className="banner__body">
                <strong>Access forbidden (403):</strong> {notice.message}
              </div>
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void handleVenueChange('ALL')}
              >
                Reset to Permitted Venues
              </button>
            </div>
          )}

          {notice.kind === 'unauthorized' && (
            <div className="banner banner--error" role="alert">
              <div className="banner__body">
                <strong>Unauthorised (401):</strong> {notice.message}
              </div>
              <button
                type="button"
                className="btn btn--primary"
                onClick={() => void handleSessionChange('operator-A')}
              >
                Sign in as operator-A
              </button>
            </div>
          )}

          {notice.kind === 'info' && (
            <div className="banner banner--info" role="status">
              <div className="banner__body">{notice.message}</div>
            </div>
          )}

          <div className="table-header-row">
            <h2 className="section-title">Sync Jobs</h2>
            {session && (
              <span className="tenant-pill">
                Tenant {session.tenantId} · {session.role}
              </span>
            )}
          </div>

          {isInitialLoading ? (
            <div className="state-box" role="status">
              Loading sync jobs...
            </div>
          ) : jobs && jobs.length === 0 ? (
            <div className="state-box" role="status">
              <p>No integration jobs found for this selection.</p>
              {session && (
                <button
                  type="button"
                  className="btn btn--secondary"
                  onClick={() => void loadJobs(selectedVenue)}
                >
                  Refresh
                </button>
              )}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="jobs-table" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <th scope="col" role="columnheader">Job ID</th>
                    <th scope="col" role="columnheader">Venue</th>
                    <th scope="col" role="columnheader">Provider</th>
                    <th scope="col" role="columnheader">Status</th>
                    <th scope="col" role="columnheader">Last Success (UTC)</th>
                    <th scope="col" role="columnheader">Action</th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {jobs?.map((job) => {
                    const isSelected = selectedJob?.id === job.id;
                    const jobPoll = pollStates[job.id];
                    const isBusy =
                      submittingJobIds.has(job.id) ||
                      job.status === 'QUEUED' ||
                      jobPoll?.kind === 'polling';

                    return (
                      <tr
                        key={job.id}
                        role="row"
                        className={isSelected ? 'jobs-row jobs-row--selected' : 'jobs-row'}
                      >
                        <td role="cell" data-label="Job ID">
                          <button
                            type="button"
                            className="job-select-btn"
                            aria-pressed={isSelected}
                            aria-label={`Select job ${job.id} (${job.provider})`}
                            onClick={() => setSelectedJobId(job.id)}
                          >
                            {job.id}
                          </button>
                        </td>
                        <td role="cell" data-label="Venue" className="mono">{job.venueId}</td>
                        <td role="cell" data-label="Provider">{job.provider}</td>
                        <td role="cell" data-label="Status">
                          <StatusBadge status={job.status} />
                        </td>
                        <td role="cell" data-label="Last Success (UTC)" className="mono">{formatUtcTimestamp(job.lastSuccessAt)}</td>
                        <td role="cell" data-label="Action">
                          {!isViewer && job.status === 'FAILED' ? (
                            <button
                              type="button"
                              className="btn btn--primary btn--sm"
                              disabled={isBusy}
                              onClick={() => void handleRetry(job.id)}
                            >
                              {submittingJobIds.has(job.id) ? 'Queueing...' : 'Retry'}
                            </button>
                          ) : !isViewer && job.status === 'QUEUED' ? (
                            <span className="muted-text">Pending</span>
                          ) : (
                            <span aria-label="No action available">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <aside className="card detail-panel" aria-label="Selected Job Details">
          {selectedJob ? (
            <>
              <div className="detail-header">
                <h2 className="section-title">Job Detail: {selectedJob.id}</h2>
                <StatusBadge status={selectedJob.status} />
              </div>

              <dl className="detail-meta">
                <div className="detail-meta__row">
                  <dt>Tenant</dt>
                  <dd>Tenant {session?.tenantId ?? '—'}</dd>
                </div>
                <div className="detail-meta__row">
                  <dt>Venue</dt>
                  <dd className="mono">{selectedJob.venueId}</dd>
                </div>
                <div className="detail-meta__row">
                  <dt>Provider</dt>
                  <dd>{selectedJob.provider}</dd>
                </div>
                <div className="detail-meta__row">
                  <dt>Last Success</dt>
                  <dd className="mono">{formatUtcTimestamp(selectedJob.lastSuccessAt)}</dd>
                </div>
              </dl>

              {selectedJob.lastError && (
                <div className="error-box" role="region" aria-label="Sync Error">
                  <div className="error-box__title">Sync Error</div>
                  <p className="error-box__text">{selectedJob.lastError}</p>
                </div>
              )}

              {selectedJobPoll.kind === 'polling' && (
                <div className="poll-box poll-box--active" role="status">
                  <strong>Sync queued — checking status</strong>
                  <span>
                    Poll {selectedJobPoll.attempt} of {selectedJobPoll.maxAttempts} (max {selectedJobPoll.maxAttempts} checks).
                  </span>
                </div>
              )}

              {selectedJobPoll.kind === 'unresolved' && (
                <div className="poll-box poll-box--unresolved" role="alert">
                  <strong>Unresolved sync state</strong>
                  <p>
                    Sync is still QUEUED after {selectedJobPoll.attempts} status checks. The job has not completed yet — do not assume success.
                  </p>
                  <div className="poll-box__actions">
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void handleCheckStatusOnce(selectedJob.id)}
                    >
                      Check Status Again
                    </button>
                    <button
                      type="button"
                      className="btn btn--secondary btn--sm"
                      onClick={() => void loadJobs(selectedVenue)}
                    >
                      Refresh Jobs
                    </button>
                  </div>
                </div>
              )}

              {selectedJobPoll.kind === 'completed' && selectedJob.status === 'HEALTHY' && (
                <div className="poll-box poll-box--done" role="status">
                  Sync completed. Status is now HEALTHY.
                </div>
              )}

              <div className="detail-actions">
                {!isViewer ? (
                  selectedJob.status === 'FAILED' ? (
                    <button
                      type="button"
                      className="btn btn--primary btn--full"
                      disabled={submittingJobIds.has(selectedJob.id) || selectedJobPoll.kind === 'polling'}
                      onClick={() => void handleRetry(selectedJob.id)}
                    >
                      {submittingJobIds.has(selectedJob.id) ? 'Queueing Retry...' : 'Retry Sync'}
                    </button>
                  ) : selectedJob.status === 'QUEUED' ? (
                    <button type="button" className="btn btn--secondary btn--full" disabled>
                      Sync Queued (Pending)
                    </button>
                  ) : (
                    <p className="muted-note">Integration is healthy. No retry needed.</p>
                  )
                ) : (
                  <p className="muted-note">
                    Read-only viewer role: retry controls are disabled and blocked by the server.
                  </p>
                )}
              </div>

              <div className="flow-strip" aria-label="Expected retry lifecycle">
                <span>FAILED</span>
                <span aria-hidden="true">-&gt;</span>
                <span>202 QUEUED</span>
                <span aria-hidden="true">-&gt;</span>
                <span>Poll (1/2, 2/2)</span>
                <span aria-hidden="true">-&gt;</span>
                <span>HEALTHY</span>
              </div>
            </>
          ) : (
            <div className="state-box">
              Select a sync job from the table to inspect details and error context.
            </div>
          )}
        </aside>
      </main>
    </div>
  );
}
