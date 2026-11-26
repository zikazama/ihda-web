export type Role = 'operator' | 'viewer';
export type TenantId = 'A' | 'B';
export type VenueId = 'A1' | 'A2' | 'B1';
export type SessionId = 'operator-A' | 'viewer-A' | 'operator-B';
export type JobStatus = 'FAILED' | 'QUEUED' | 'HEALTHY';

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
}

export interface StubConfig {
  readonly delayMs: number;
  readonly delayVenueId: VenueId | null;
  readonly force500: boolean;
  readonly force500Remaining: number;
  readonly neverComplete: boolean;
}

export interface RetryResponse {
  readonly jobId: string;
  readonly status: 'QUEUED';
}

export type PollState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'polling'; readonly attempt: number; readonly maxAttempts: number }
  | { readonly kind: 'completed' }
  | { readonly kind: 'unresolved'; readonly attempts: number };

export type DashboardNotice =
  | { readonly kind: 'none' }
  | { readonly kind: 'unauthorized'; readonly message: string }
  | { readonly kind: 'forbidden'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string }
  | { readonly kind: 'info'; readonly message: string };
