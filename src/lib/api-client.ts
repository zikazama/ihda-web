import type {
  IntegrationJob,
  RetryResponse,
  SessionId,
  SessionInfo,
  SimulateTickResponse,
  StubConfig,
  VenueId,
} from './types';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function parseJsonSafe(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function extractErrorMeta(payload: unknown, fallbackStatus: number): { code: string; message: string } {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const code = typeof record.error === 'string' ? record.error : `HTTP_${fallbackStatus}`;
    const message =
      typeof record.message === 'string'
        ? record.message
        : `Request failed with status ${fallbackStatus}.`;
    return { code, message };
  }
  return {
    code: `HTTP_${fallbackStatus}`,
    message: `Request failed with status ${fallbackStatus}.`,
  };
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const payload = await parseJsonSafe(res);
  if (!res.ok) {
    const { code, message } = extractErrorMeta(payload, res.status);
    throw new ApiError(res.status, code, message);
  }
  return payload as T;
}

export function fetchHealth(): Promise<{ status: string; apiHealthy: boolean }> {
  return requestJson<{ status: string; apiHealthy: boolean }>('/api/health', {
    cache: 'no-store',
  });
}

export function fetchSession(): Promise<SessionInfo> {
  return requestJson<SessionInfo>('/api/session', {
    cache: 'no-store',
  });
}

export function selectSyntheticSession(sessionId: SessionId | null): Promise<SessionInfo | { signedOut: true }> {
  return requestJson<SessionInfo | { signedOut: true }>('/api/session', {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  });
}

export function fetchJobs(venueId?: string, signal?: AbortSignal): Promise<{ items: IntegrationJob[] }> {
  const params = new URLSearchParams();
  if (venueId && venueId !== 'ALL') {
    params.set('venueId', venueId);
  }
  const query = params.toString();
  const url = query ? `/api/jobs?${query}` : '/api/jobs';
  return requestJson<{ items: IntegrationJob[] }>(url, {
    cache: 'no-store',
    signal,
  });
}

export function fetchJobDetail(jobId: string, signal?: AbortSignal): Promise<IntegrationJob> {
  return requestJson<IntegrationJob>(`/api/jobs/${encodeURIComponent(jobId)}`, {
    cache: 'no-store',
    signal,
  });
}

export function retryJob(jobId: string): Promise<RetryResponse> {
  return requestJson<RetryResponse>(`/api/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
  });
}

export function fetchStubConfig(): Promise<StubConfig> {
  return requestJson<StubConfig>('/api/stub/config', {
    cache: 'no-store',
  });
}

export function updateStubConfig(
  patch: Partial<{
    delayMs: number;
    delayVenueId: VenueId | null;
    force500: boolean;
    force500Remaining: number;
    neverComplete: boolean;
    forceRetryFail: boolean;
  }>,
): Promise<StubConfig> {
  return requestJson<StubConfig>('/api/stub/config', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}

export function resetStubFixtures(): Promise<{ status: string; config: StubConfig }> {
  return requestJson<{ status: string; config: StubConfig }>('/api/stub/reset', {
    method: 'POST',
  });
}

export function simulateLiveTick(venueId?: string, signal?: AbortSignal): Promise<SimulateTickResponse> {
  return requestJson<SimulateTickResponse>('/api/stub/simulate-tick', {
    method: 'POST',
    body: JSON.stringify({
      venueId: venueId ?? 'ALL',
      minCount: 1,
      maxCount: 3,
    }),
    signal,
  });
}
