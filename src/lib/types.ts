export type Role = 'operator' | 'viewer';
export type TenantId = 'A' | 'B';
export type VenueId = 'A1' | 'A2' | 'B1';
export type SessionId = 'operator-A' | 'viewer-A' | 'operator-B';
export type JobStatus = 'FAILED' | 'QUEUED' | 'HEALTHY';

export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BACKOFF_SCHEDULE_MS = [1000, 2000, 4000] as const;
export const POLL_BACKOFF_SCHEDULE_MS = [300, 600, 1200, 2400] as const;

export interface SessionInfo {
  readonly sessionId: SessionId;
  readonly tenantId: TenantId;
  readonly venueIds: readonly VenueId[];
  readonly role: Role;
}

export interface IntegrationJob {
  readonly id: string;
  readonly venueId: VenueId;
  readonly provider: string;
  readonly status: JobStatus;
  readonly lastSuccessAt: string | null;
  readonly lastError: string | null;
  readonly pollCount?: number;
  readonly retryCount?: number;
  readonly maxRetries?: number;
  readonly nextRetryDelayMs?: number | null;
  readonly isSimulated?: boolean;
}

export interface StubConfig {
  readonly delayMs: number;
  readonly delayVenueId: VenueId | null;
  readonly force500: boolean;
  readonly force500Remaining: number;
  readonly neverComplete: boolean;
  readonly forceRetryFail?: boolean;
}

export interface RetryResponse {
  readonly jobId: string;
  readonly status: 'QUEUED';
}

export interface SimulationStats {
  readonly total: number;
  readonly healthy: number;
  readonly failed: number;
  readonly queued: number;
}

export interface SimulateTickResponse {
  readonly generatedCount: number;
  readonly generated: IntegrationJob[];
  readonly items: IntegrationJob[];
  readonly stats: SimulationStats;
}

export interface ScheduledRetryState {
  readonly attempt: number;
  readonly delayMs: number;
  readonly dueAt: number;
}

export type PollState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'polling'; readonly attempt: number; readonly maxAttempts: number; readonly backoffMs: number }
  | { readonly kind: 'completed' }
  | { readonly kind: 'unresolved'; readonly attempts: number };

export type DashboardNotice =
  | { readonly kind: 'none' }
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string }
  | { readonly kind: 'info'; readonly message: string };
