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
  simulateLiveTick,
  updateStubConfig,
} from '@/lib/api-client';
import { formatUtcTimestamp } from '@/lib/format';
import {
  MAX_RETRY_ATTEMPTS,
  POLL_BACKOFF_SCHEDULE_MS,
  RETRY_BACKOFF_SCHEDULE_MS,
  type DashboardNotice,
  type IntegrationJob,
  type PollState,
  type ScheduledRetryState,
  type SessionId,
  type SessionInfo,
  type StubConfig,
} from '@/lib/types';
import { StatusBadge } from './StatusBadge';

export const LIVE_SIM_TICK_MS = 1000;
export const JOBS_PAGE_SIZE = 50;
export const MAX_POLL_ATTEMPTS = POLL_BACKOFF_SCHEDULE_MS.length;
const MAX_CONCURRENT_AUTO_RETRIES = 3;

const DEFAULT_STUB_CONFIG: StubConfig = {
  delayMs: 0,
  delayVenueId: null,
  force500: false,
  force500Remaining: 0,
  neverComplete: false,
  forceRetryFail: false,
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

function formatDelayLabel(delayMs: number | null | undefined): string {
  if (!delayMs || delayMs <= 0) {
    return '0s';
  }
  return delayMs >= 1000 ? `${delayMs / 1000}s` : `${delayMs}ms`;
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
  const [currentPage, setCurrentPage] = useState<number>(1);

  const [isInitialLoading, setIsInitialLoading] = useState<boolean>(true);
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [notice, setNotice] = useState<DashboardNotice>({ kind: 'none' });
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>('');

  const [submittingJobIds, setSubmittingJobIds] = useState<ReadonlySet<string>>(new Set());
  const [pollStates, setPollStates] = useState<Record<string, PollState>>({});

  // Live frontend-only simulation & escalating 3x auto-retry states
  const [liveSimEnabled, setLiveSimEnabled] = useState<boolean>(true);
  const [autoRetryEnabled, setAutoRetryEnabled] = useState<boolean>(true);
  const [isPageVisible, setIsPageVisible] = useState<boolean>(true);
  const [lastTickCount, setLastTickCount] = useState<number>(0);
  const [totalSimulated, setTotalSimulated] = useState<number>(0);
  const [scheduledRetries, setScheduledRetries] = useState<Record<string, ScheduledRetryState>>({});

  const jobsRequestSeqRef = useRef<number>(0);
  const jobsAbortRef = useRef<AbortController | null>(null);
  const simAbortRef = useRef<AbortController | null>(null);
  const retryInFlightRef = useRef<Set<string>>(new Set());
  const pollGenerationRef = useRef<Record<string, number>>({});
  const pollStatesRef = useRef<Record<string, PollState>>({});
  const autoRetryTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const mountedRef = useRef<boolean>(true);
  const isRefreshingRef = useRef<boolean>(false);

  pollStatesRef.current = pollStates;
  isRefreshingRef.current = isRefreshing;

  const clearScheduledAutoRetry = useCallback((jobId: string) => {
    const existingTimer = autoRetryTimersRef.current.get(jobId);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      autoRetryTimersRef.current.delete(jobId);
    }
    setScheduledRetries((prev) => {
      if (!(jobId in prev)) {
        return prev;
      }
      const next = { ...prev };
      delete next[jobId];
      return next;
    });
  }, []);

  const clearAllAutoRetries = useCallback(() => {
    for (const timer of autoRetryTimersRef.current.values()) {
      clearTimeout(timer);
    }
    autoRetryTimersRef.current.clear();
    setScheduledRetries({});
  }, []);

  const cancelAllPolls = useCallback(() => {
    for (const jobId of Object.keys(pollGenerationRef.current)) {
      pollGenerationRef.current[jobId] = (pollGenerationRef.current[jobId] ?? 0) + 1;
    }
    setPollStates({});
    clearAllAutoRetries();
  }, [clearAllAutoRetries]);

  // Track browser visibility and teardown so simulation runs ONLY while page is open & visible.
  useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }
    setIsPageVisible(document.visibilityState === 'visible');

    const handleVisibilityChange = () => {
      const visible = document.visibilityState === 'visible';
      setIsPageVisible(visible);
      if (!visible) {
        simAbortRef.current?.abort();
        clearAllAutoRetries();
      }
    };

    const handleUnloadOrHide = () => {
      setIsPageVisible(false);
      simAbortRef.current?.abort();
      clearAllAutoRetries();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleUnloadOrHide);
    window.addEventListener('beforeunload', handleUnloadOrHide);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleUnloadOrHide);
      window.removeEventListener('beforeunload', handleUnloadOrHide);
    };
  }, [clearAllAutoRetries]);

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
      simAbortRef.current?.abort();
      for (const jobId of Object.keys(pollGenerationRef.current)) {
        pollGenerationRef.current[jobId] = (pollGenerationRef.current[jobId] ?? 0) + 1;
      }
      for (const timer of autoRetryTimersRef.current.values()) {
        clearTimeout(timer);
      }
      autoRetryTimersRef.current.clear();
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

        const backoffMs =
          POLL_BACKOFF_SCHEDULE_MS[attempt - 1] ?? 2400;

        setPollStates((prev) => ({
          ...prev,
          [jobId]: {
            kind: 'polling',
            attempt,
            maxAttempts: MAX_POLL_ATTEMPTS,
            backoffMs,
          },
        }));

        await sleep(backoffMs);

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
            setLiveAnnouncement(
              `Retry ${detail.retryCount ?? 1}/${detail.maxRetries ?? MAX_RETRY_ATTEMPTS} failed for job ${jobId}.`,
            );
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
      simAbortRef.current?.abort();
      retryInFlightRef.current.clear();
      setSubmittingJobIds(new Set());
      setSelectedVenue('ALL');
      setSelectedJobId(null);
      setCurrentPage(1);

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
      simAbortRef.current?.abort();
      clearAllAutoRetries();
      setSelectedVenue(venue);
      setCurrentPage(1);
      await loadJobs(venue);
    },
    [clearAllAutoRetries, loadJobs],
  );

  const handleRetry = useCallback(
    async (jobId: string) => {
      clearScheduledAutoRetry(jobId);

      if (retryInFlightRef.current.has(jobId)) {
        return;
      }
      const existingPoll = pollStatesRef.current[jobId];
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
            ? prev.map((item) => {
                if (item.id !== jobId) {
                  return item;
                }
                const nextRetryCount = Math.min(
                  (item.retryCount ?? 0) + 1,
                  item.maxRetries ?? MAX_RETRY_ATTEMPTS,
                );
                return {
                  ...item,
                  status: 'QUEUED',
                  retryCount: nextRetryCount,
                  nextRetryDelayMs: null,
                };
              })
            : prev,
        );
        setLiveAnnouncement(`Retry queued for job ${jobId}.`);
        void startBoundedPolling(jobId);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'MAX_RETRIES_EXCEEDED') {
          setJobs((prev) =>
            prev
              ? prev.map((item) =>
                  item.id === jobId
                    ? {
                        ...item,
                        status: 'FAILED',
                        retryCount: MAX_RETRY_ATTEMPTS,
                        maxRetries: MAX_RETRY_ATTEMPTS,
                        nextRetryDelayMs: null,
                      }
                    : item,
                )
              : prev,
          );
          setNotice({ kind: 'info', message: err.message });
        } else if (err instanceof ApiError && err.status === 409) {
          setJobs((prev) =>
            prev
              ? prev.map((item) =>
                  item.id === jobId ? { ...item, status: 'QUEUED' } : item,
                )
              : prev,
          );
          setNotice({ kind: 'info', message: err.message });
          if (pollStatesRef.current[jobId]?.kind !== 'polling') {
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
    [clearScheduledAutoRetry, startBoundedPolling],
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
      simAbortRef.current?.abort();
      clearAllAutoRetries();
      setNotice({ kind: 'none' });
      let patch: Partial<StubConfig>;
      if (preset === 'normal') {
        patch = {
          delayMs: 0,
          delayVenueId: null,
          force500: false,
          force500Remaining: 0,
          neverComplete: false,
          forceRetryFail: false,
        };
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
    [clearAllAutoRetries, loadJobs, selectedVenue],
  );

  const handleResetFixtures = useCallback(async () => {
    simAbortRef.current?.abort();
    cancelAllPolls();
    retryInFlightRef.current.clear();
    setSubmittingJobIds(new Set());
    setLastTickCount(0);
    setTotalSimulated(0);
    setCurrentPage(1);
    const result = await resetStubFixtures();
    if (!mountedRef.current) {
      return;
    }
    setStubConfig(result.config);
    setLiveAnnouncement('Fixtures and stub controls reset.');
    await loadJobs(selectedVenue);
  }, [cancelAllPolls, loadJobs, selectedVenue]);

  const activePreset = getActivePreset(stubConfig);
  const canRunLiveSim =
    liveSimEnabled &&
    isPageVisible &&
    session !== null &&
    activePreset === 'normal' &&
    notice.kind === 'none' &&
    !isInitialLoading;

  // Live simulation loop: creates 1-3 random jobs/sec strictly while frontend tab is open & visible.
  useEffect(() => {
    if (!canRunLiveSim) {
      simAbortRef.current?.abort();
      return;
    }

    let cancelled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;

    const runTick = async () => {
      if (cancelled || !mountedRef.current) {
        return;
      }

      const hasActivePoll = Object.values(pollStatesRef.current).some((state) => state.kind === 'polling');
      if (isRefreshingRef.current || retryInFlightRef.current.size > 0 || hasActivePoll) {
        if (!cancelled) {
          timerId = setTimeout(() => void runTick(), LIVE_SIM_TICK_MS);
        }
        return;
      }

      const tickSeq = jobsRequestSeqRef.current;
      const controller = new AbortController();
      simAbortRef.current = controller;

      try {
        const res = await simulateLiveTick(selectedVenue, controller.signal);
        if (cancelled || !mountedRef.current || controller.signal.aborted || tickSeq !== jobsRequestSeqRef.current) {
          return;
        }

        setJobs((prev) => {
          const prevMap = new Map((prev ?? []).map((item) => [item.id, item]));
          return res.items.map((item) => {
            const existing = prevMap.get(item.id);
            const activePoll = pollStatesRef.current[item.id]?.kind === 'polling';
            if ((retryInFlightRef.current.has(item.id) || activePoll) && existing) {
              return existing;
            }
            return item;
          });
        });
        setLastUpdatedAt(new Date().toISOString());
        setLastTickCount(res.generatedCount);
        setTotalSimulated((prev) => prev + res.generatedCount);
      } catch (err) {
        if (controller.signal.aborted || cancelled) {
          return;
        }
        // Ignore 404 from unit-test mocks that only stub baseline endpoints.
        if (err instanceof ApiError && err.status !== 404) {
          if (err.status === 401) {
            setNotice({ kind: 'unauthorized', message: err.message });
            return;
          }
          if (err.status === 403) {
            setNotice({ kind: 'forbidden', message: err.message });
            return;
          }
        }
      } finally {
        if (!cancelled && mountedRef.current) {
          timerId = setTimeout(() => void runTick(), LIVE_SIM_TICK_MS);
        }
      }
    };

    timerId = setTimeout(() => void runTick(), LIVE_SIM_TICK_MS);

    return () => {
      cancelled = true;
      if (timerId !== null) {
        clearTimeout(timerId);
      }
      simAbortRef.current?.abort();
    };
  }, [canRunLiveSim, selectedVenue]);

  // Escalating Auto-Retry Scheduler (1s -> 2s -> 4s, max 3x) for simulated FAILED jobs when operator & live sim active.
  useEffect(() => {
    const canAutoRetry =
      canRunLiveSim && autoRetryEnabled && session?.role === 'operator' && jobs !== null;

    if (!canAutoRetry) {
      clearAllAutoRetries();
      return;
    }

    const activeIds = new Set(jobs.map((job) => job.id));
    for (const scheduledId of Array.from(autoRetryTimersRef.current.keys())) {
      const target = jobs.find((item) => item.id === scheduledId);
      if (
        !activeIds.has(scheduledId) ||
        !target ||
        target.status !== 'FAILED' ||
        (target.retryCount ?? 0) >= (target.maxRetries ?? MAX_RETRY_ATTEMPTS)
      ) {
        clearScheduledAutoRetry(scheduledId);
      }
    }

    let queuedOrScheduled = autoRetryTimersRef.current.size;

    for (const job of jobs) {
      if (!job.isSimulated || job.status !== 'FAILED') {
        continue;
      }
      const attemptsSoFar = job.retryCount ?? 0;
      const maxAttempts = job.maxRetries ?? MAX_RETRY_ATTEMPTS;
      if (attemptsSoFar >= maxAttempts) {
        continue;
      }
      if (
        retryInFlightRef.current.has(job.id) ||
        pollStatesRef.current[job.id]?.kind === 'polling' ||
        autoRetryTimersRef.current.has(job.id)
      ) {
        continue;
      }
      if (queuedOrScheduled >= MAX_CONCURRENT_AUTO_RETRIES) {
        break;
      }

      const delayMs =
        job.nextRetryDelayMs ??
        RETRY_BACKOFF_SCHEDULE_MS[attemptsSoFar] ?? 4000;
      const nextAttempt = attemptsSoFar + 1;
      const dueAt = Date.now() + delayMs;

      const timer = setTimeout(() => {
        autoRetryTimersRef.current.delete(job.id);
        setScheduledRetries((prev) => {
          if (!(job.id in prev)) {
            return prev;
          }
          const copy = { ...prev };
          delete copy[job.id];
          return copy;
        });
        if (mountedRef.current) {
          void handleRetry(job.id);
        }
      }, delayMs);

      autoRetryTimersRef.current.set(job.id, timer);
      queuedOrScheduled += 1;
      setScheduledRetries((prev) => ({
        ...prev,
        [job.id]: { attempt: nextAttempt, delayMs, dueAt },
      }));
    }
  }, [
    autoRetryEnabled,
    canRunLiveSim,
    clearAllAutoRetries,
    clearScheduledAutoRetry,
    handleRetry,
    jobs,
    session?.role,
  ]);

  const selectedJob = useMemo(() => {
    if (!jobs || jobs.length === 0) {
      return null;
    }
    return jobs.find((item) => item.id === selectedJobId) ?? jobs[0] ?? null;
  }, [jobs, selectedJobId]);

  const stats = useMemo(() => {
    const list = jobs ?? [];
    return {
      total: list.length,
      healthy: list.filter((j) => j.status === 'HEALTHY').length,
      failed: list.filter((j) => j.status === 'FAILED').length,
      queued: list.filter((j) => j.status === 'QUEUED').length,
    };
  }, [jobs]);

  const totalJobs = jobs?.length ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalJobs / JOBS_PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const pageStartIndex = (safePage - 1) * JOBS_PAGE_SIZE;
  const paginatedJobs = useMemo(() => {
    if (!jobs) {
      return [];
    }
    return jobs.slice(pageStartIndex, pageStartIndex + JOBS_PAGE_SIZE);
  }, [jobs, pageStartIndex]);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const selectedJobPoll: PollState = selectedJob ? (pollStates[selectedJob.id] ?? { kind: 'idle' }) : { kind: 'idle' };
  const selectedScheduledRetry = selectedJob ? scheduledRetries[selectedJob.id] : undefined;
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

          <div className="live-controls">
            <button
              type="button"
              className={`chip-btn live-btn ${canRunLiveSim ? 'live-btn--on' : ''}`}
              aria-pressed={liveSimEnabled}
              onClick={() => {
                setLiveSimEnabled((prev) => {
                  const next = !prev;
                  if (!next) {
                    simAbortRef.current?.abort();
                    clearAllAutoRetries();
                  }
                  return next;
                });
              }}
            >
              <span className={`live-dot ${canRunLiveSim ? 'live-dot--active' : ''}`} aria-hidden="true" />
              {liveSimEnabled
                ? canRunLiveSim
                  ? `Live Sim: ON${lastTickCount > 0 ? ` (+${lastTickCount}/s)` : ''}`
                  : 'Live Sim: AUTO-PAUSED'
                : 'Live Sim: PAUSED'}
            </button>

            {!isViewer && (
              <button
                type="button"
                className={`chip-btn ${autoRetryEnabled ? 'chip-btn--active' : ''}`}
                aria-pressed={autoRetryEnabled}
                onClick={() =>
                  setAutoRetryEnabled((prev) => {
                    const next = !prev;
                    if (!next) {
                      clearAllAutoRetries();
                    }
                    return next;
                  })
                }
              >
                Auto-Retry 3x: {autoRetryEnabled ? 'ON' : 'OFF'}
              </button>
            )}

            <button
              type="button"
              className="btn btn--secondary btn--sm"
              onClick={() => void handleResetFixtures()}
            >
              Reset Fixtures
            </button>
          </div>
        </div>
      </section>

      <main className="main-grid">
        <section className="card" aria-label="Sync Jobs List">
          <div className="kpi-grid" aria-label="Integration job summary">
            <div className="kpi-card">
              <span className="kpi-card__label">Total</span>
              <strong className="kpi-card__value">{stats.total}</strong>
            </div>
            <div className="kpi-card kpi-card--healthy">
              <span className="kpi-card__label">Healthy</span>
              <strong className="kpi-card__value">{stats.healthy}</strong>
            </div>
            <div className="kpi-card kpi-card--failed">
              <span className="kpi-card__label">Failed</span>
              <strong className="kpi-card__value">{stats.failed}</strong>
            </div>
            <div className="kpi-card kpi-card--queued">
              <span className="kpi-card__label">Queued</span>
              <strong className="kpi-card__value">{stats.queued}</strong>
            </div>
          </div>

          <p className="sim-caption">
            {canRunLiveSim
              ? `Live feed active while tab is open (1–3 random jobs/s · generated ${totalSimulated}) · Backoff 1s → 2s → 4s (max 3x)`
              : 'Live feed paused · Auto-retry backoff 1s → 2s → 4s (max 3x)'}
          </p>

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
                  {paginatedJobs.map((job) => {
                    const isSelected = selectedJob?.id === job.id;
                    const jobPoll = pollStates[job.id];
                    const scheduled = scheduledRetries[job.id];
                    const retryCount = job.retryCount ?? 0;
                    const maxRetries = job.maxRetries ?? MAX_RETRY_ATTEMPTS;
                    const isExhausted = retryCount >= maxRetries && job.status === 'FAILED';
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
                          <div className="action-cell">
                            {!isViewer && job.status === 'FAILED' ? (
                              isExhausted ? (
                                <span className="badge--exhausted" title="Maximum 3/3 retries reached">
                                  Max 3/3
                                </span>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="btn btn--primary btn--sm"
                                    disabled={isBusy}
                                    onClick={() => void handleRetry(job.id)}
                                  >
                                    {submittingJobIds.has(job.id) ? 'Queueing...' : 'Retry'}
                                  </button>
                                  <span className="retry-meta">
                                    {scheduled
                                      ? `Auto ${scheduled.attempt}/${maxRetries} · ${formatDelayLabel(scheduled.delayMs)}`
                                      : retryCount > 0
                                        ? `${retryCount}/${maxRetries} · Next ${formatDelayLabel(job.nextRetryDelayMs)}`
                                        : `0/${maxRetries}`}
                                  </span>
                                </>
                              )
                            ) : !isViewer && job.status === 'QUEUED' ? (
                              <span className="muted-text">
                                Pending ({retryCount}/{maxRetries})
                              </span>
                            ) : (
                              <span aria-label="No action available">—</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {!isInitialLoading && totalJobs >= JOBS_PAGE_SIZE && (
            <nav className="pagination-bar" aria-label="Jobs pagination">
              <span className="pagination-bar__info">
                Showing {pageStartIndex + 1}–{Math.min(pageStartIndex + JOBS_PAGE_SIZE, totalJobs)} of {totalJobs} · Page {safePage} of {totalPages}
              </span>
              <div className="pagination-bar__controls">
                <button
                  type="button"
                  className="btn btn--secondary btn--sm page-btn"
                  disabled={safePage <= 1}
                  onClick={() => setCurrentPage((prev) => Math.max(1, prev - 1))}
                >
                  Previous
                </button>
                {Array.from({ length: totalPages }, (_, index) => {
                  const pageNumber = index + 1;
                  const isActive = pageNumber === safePage;
                  return (
                    <button
                      key={pageNumber}
                      type="button"
                      className={`page-btn ${isActive ? 'page-btn--active' : ''}`}
                      aria-current={isActive ? 'page' : undefined}
                      onClick={() => setCurrentPage(pageNumber)}
                    >
                      {pageNumber}
                    </button>
                  );
                })}
                <button
                  type="button"
                  className="btn btn--secondary btn--sm page-btn"
                  disabled={safePage >= totalPages}
                  onClick={() => setCurrentPage((prev) => Math.min(totalPages, prev + 1))}
                >
                  Next
                </button>
              </div>
            </nav>
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
                <div className="detail-meta__row">
                  <dt>Retries</dt>
                  <dd className="mono">
                    {selectedJob.retryCount ?? 0} / {selectedJob.maxRetries ?? MAX_RETRY_ATTEMPTS}
                    {selectedScheduledRetry
                      ? ` (Auto #${selectedScheduledRetry.attempt} in ${formatDelayLabel(selectedScheduledRetry.delayMs)})`
                      : selectedJob.nextRetryDelayMs
                        ? ` (Next backoff: ${formatDelayLabel(selectedJob.nextRetryDelayMs)})`
                        : ''}
                  </dd>
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
                    Poll {selectedJobPoll.attempt} of {selectedJobPoll.maxAttempts} · Interval{' '}
                    {selectedJobPoll.backoffMs}ms (300ms → 600ms → 1200ms → 2400ms).
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
                    (selectedJob.retryCount ?? 0) >= (selectedJob.maxRetries ?? MAX_RETRY_ATTEMPTS) ? (
                      <button type="button" className="btn btn--secondary btn--full" disabled>
                        Max Retries Reached (3/3)
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn btn--primary btn--full"
                        disabled={submittingJobIds.has(selectedJob.id) || selectedJobPoll.kind === 'polling'}
                        onClick={() => void handleRetry(selectedJob.id)}
                      >
                        {submittingJobIds.has(selectedJob.id) ? 'Queueing Retry...' : 'Retry Sync'}
                      </button>
                    )
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
                <span>Backoff: 1s → 2s → 4s (Max 3x)</span>
                <span aria-hidden="true">|</span>
                <span>Poll: 0.3s → 0.6s → 1.2s → 2.4s</span>
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
