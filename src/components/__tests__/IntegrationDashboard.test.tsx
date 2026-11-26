import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatUtcTimestamp } from '@/lib/format';
import { IntegrationDashboard } from '../IntegrationDashboard';

function mockJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('formatUtcTimestamp', () => {
  it('formats ISO string with explicit UTC label and handles null', () => {
    expect(formatUtcTimestamp('2026-11-23T09:00:00Z')).toBe('2026-11-23 09:00:00 UTC');
    expect(formatUtcTimestamp(null)).toBe('Never (no successful sync)');
  });
});

describe('IntegrationDashboard component states', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hides retry controls for viewer-A and keeps viewer read-only', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/health')) {
        return Promise.resolve(mockJsonResponse({ status: 'ok', apiHealthy: true }));
      }
      if (url.endsWith('/api/stub/config')) {
        return Promise.resolve(
          mockJsonResponse({
            delayMs: 0,
            delayVenueId: null,
            force500: false,
            force500Remaining: 0,
            neverComplete: false,
          }),
        );
      }
      if (url.endsWith('/api/session')) {
        return Promise.resolve(
          mockJsonResponse({
            sessionId: 'viewer-A',
            tenantId: 'A',
            venueIds: ['A1', 'A2'],
            role: 'viewer',
          }),
        );
      }
      if (url.includes('/api/jobs')) {
        return Promise.resolve(
          mockJsonResponse({
            items: [
              {
                id: 'j1',
                venueId: 'A1',
                provider: 'Mock POS',
                status: 'FAILED',
                lastSuccessAt: '2026-11-23T09:00:00Z',
                lastError: 'POS sync timed out',
              },
            ],
          }),
        );
      }
      return Promise.resolve(mockJsonResponse({}, 404));
    });

    render(<IntegrationDashboard />);

    await screen.findByRole('cell', { name: 'Mock POS' });
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Sync' })).not.toBeInTheDocument();
    expect(screen.getByText(/Read-only viewer role/i)).toBeInTheDocument();
  });

  it('renders empty state when backend returns zero jobs', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/health')) {
        return Promise.resolve(mockJsonResponse({ status: 'ok', apiHealthy: true }));
      }
      if (url.endsWith('/api/stub/config')) {
        return Promise.resolve(
          mockJsonResponse({
            delayMs: 0,
            delayVenueId: null,
            force500: false,
            force500Remaining: 0,
            neverComplete: false,
          }),
        );
      }
      if (url.endsWith('/api/session')) {
        return Promise.resolve(
          mockJsonResponse({
            sessionId: 'operator-A',
            tenantId: 'A',
            venueIds: ['A1', 'A2'],
            role: 'operator',
          }),
        );
      }
      if (url.includes('/api/jobs')) {
        return Promise.resolve(mockJsonResponse({ items: [] }));
      }
      return Promise.resolve(mockJsonResponse({}, 404));
    });

    render(<IntegrationDashboard />);
    expect(await screen.findByText(/No integration jobs found/i)).toBeInTheDocument();
  });

  it('keeps last known good data visible with stale banner during refresh and shows 401 state on sign out', async () => {
    let resolveDelayedRefresh!: (res: Response) => void;
    let jobsCallCount = 0;

    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith('/api/health')) {
        return Promise.resolve(mockJsonResponse({ status: 'ok', apiHealthy: true }));
      }
      if (url.endsWith('/api/stub/config')) {
        return Promise.resolve(
          mockJsonResponse({
            delayMs: 0,
            delayVenueId: null,
            force500: false,
            force500Remaining: 0,
            neverComplete: false,
          }),
        );
      }
      if (url.endsWith('/api/session') && init?.method === 'POST') {
        return Promise.resolve(mockJsonResponse({ signedOut: true }));
      }
      if (url.endsWith('/api/session')) {
        return Promise.resolve(
          mockJsonResponse({
            sessionId: 'operator-A',
            tenantId: 'A',
            venueIds: ['A1', 'A2'],
            role: 'operator',
          }),
        );
      }
      if (url.includes('/api/jobs')) {
        jobsCallCount += 1;
        if (jobsCallCount === 1) {
          return Promise.resolve(
            mockJsonResponse({
              items: [
                {
                  id: 'j1',
                  venueId: 'A1',
                  provider: 'Mock POS',
                  status: 'FAILED',
                  lastSuccessAt: '2026-11-23T09:00:00Z',
                  lastError: 'Timed out',
                },
              ],
            }),
          );
        }
        if (jobsCallCount === 2) {
          return new Promise<Response>((resolve) => {
            resolveDelayedRefresh = resolve;
          });
        }
        return Promise.resolve(
          mockJsonResponse({ error: 'UNAUTHORIZED', message: 'Valid synthetic session required.' }, 401),
        );
      }
      return Promise.resolve(mockJsonResponse({}, 404));
    });

    const user = userEvent.setup();
    render(<IntegrationDashboard />);

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Mock POS')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText(/Refreshing latest status — showing last known data/i)).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getByText('Mock POS')).toBeInTheDocument();

    resolveDelayedRefresh(
      mockJsonResponse({
        items: [
          {
            id: 'j1',
            venueId: 'A1',
            provider: 'Mock POS',
            status: 'FAILED',
            lastSuccessAt: '2026-11-23T09:00:00Z',
            lastError: 'Timed out',
          },
        ],
      }),
    );

    await waitFor(() => {
      expect(screen.queryByText(/Refreshing latest status/i)).not.toBeInTheDocument();
    });

    await user.selectOptions(screen.getByLabelText('Session'), 'signed-out');
    expect(await screen.findByText(/Unauthorised \(401\)/i)).toBeInTheDocument();
  });
});
