import { expect, test } from '@playwright/test';

test.describe('Integration Health Dashboard E2E', () => {
  test.beforeEach(async ({ request }) => {
    const resetRes = await request.post('/api/stub/reset');
    expect(resetRes.ok()).toBe(true);
  });

  test('1. Happy path: operator sees authorised jobs, filters by venue, retries j1 (QUEUED -> HEALTHY)', async ({
    page,
  }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Integration Health Dashboard' })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock HR', exact: true })).toBeVisible();
    await expect(page.getByText('Mock Reservations')).toHaveCount(0);
    await expect(page.getByText('2026-11-23 09:00:00 UTC').first()).toBeVisible();

    await page.getByRole('button', { name: 'A1', exact: true }).click();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock HR', exact: true })).toHaveCount(0);

    const rowJ1 = page.locator('tbody tr', { hasText: 'Mock POS' });
    await rowJ1.getByRole('button', { name: 'Retry', exact: true }).click();

    await expect(rowJ1.locator('[data-status="QUEUED"]')).toBeVisible();
    await expect(rowJ1.locator('[data-status="HEALTHY"]')).toBeVisible({ timeout: 5000 });
  });

  test('2. Viewer: no retry control in UI and direct API retry returns 403 without changing j1', async ({
    page,
    request,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await page.getByLabel('Session').selectOption('viewer-A');
    await expect(page.getByText(/Read-only viewer role/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Retry', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Retry Sync', exact: true })).toHaveCount(0);

    const directRetry = await request.post('/api/jobs/j1/retry', {
      headers: { Authorization: 'Bearer viewer-A' },
    });
    expect(directRetry.status()).toBe(403);

    const checkJob = await request.get('/api/jobs/j1', {
      headers: { Authorization: 'Bearer operator-A' },
    });
    expect(checkJob.status()).toBe(200);
    const jobBody = (await checkJob.json()) as { status: string };
    expect(jobBody.status).toBe('FAILED');
  });

  test('3. Tenant isolation: operator-A cannot list, read, or retry j3 even via URL or API parameters', async ({
    page,
    request,
  }) => {
    await page.goto('/?venueId=B1');

    await expect(page.getByText(/Access forbidden \(403\)/i)).toBeVisible();
    await expect(page.getByText('Mock Reservations')).toHaveCount(0);

    const listB1 = await request.get('/api/jobs?venueId=B1', {
      headers: { Authorization: 'Bearer operator-A' },
    });
    expect(listB1.status()).toBe(403);

    const readJ3 = await request.get('/api/jobs/j3', {
      headers: { Authorization: 'Bearer operator-A' },
    });
    expect(readJ3.status()).toBe(403);

    const retryJ3 = await request.post('/api/jobs/j3/retry', {
      headers: { Authorization: 'Bearer operator-A' },
    });
    expect(retryJ3.status()).toBe(403);

    await page.getByRole('button', { name: 'Reset to Permitted Venues' }).click();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await page.getByLabel('Session').selectOption('operator-B');
    await expect(page.getByRole('cell', { name: 'Mock Reservations', exact: true })).toBeVisible();
    await expect(page.getByText('Never (no successful sync)').first()).toBeVisible();
    await expect(page.getByText('Mock POS')).toHaveCount(0);
  });

  test('4. Fault and recovery: forced 500 recovers on retry load and never-complete stops polling safely', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Forced 500' }).click();
    const errorBanner = page.getByRole('alert').filter({ hasText: 'Server error:' });
    await expect(errorBanner).toBeVisible();
    await expect(page.getByText(/Showing stale data/i)).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await errorBanner.getByRole('button', { name: 'Retry Load' }).click();
    await expect(errorBanner).toHaveCount(0);
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Never-Complete' }).click();
    const rowJ1 = page.locator('tbody tr', { hasText: 'Mock POS' });
    await rowJ1.getByRole('button', { name: 'Retry', exact: true }).click();

    await expect(page.getByText(/Unresolved sync state/i)).toBeVisible({ timeout: 6000 });
    await expect(page.getByText(/do not assume success/i)).toBeVisible();
    await expect(rowJ1.locator('[data-status="QUEUED"]')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check Status Again' })).toBeVisible();
  });

  test('5. Race conditions: delayed A1 does not overwrite A2 and double-clicking Retry sends only one active retry', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Delay (A1)' }).click();
    await page.getByRole('button', { name: 'A1', exact: true }).click();
    await page.getByRole('button', { name: 'A2', exact: true }).click();

    await expect(page.getByRole('cell', { name: 'Mock HR', exact: true })).toBeVisible();
    await page.waitForTimeout(1600);
    await expect(page.getByRole('cell', { name: 'Mock HR', exact: true })).toBeVisible();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: 'Reset Fixtures' }).click();
    await page.getByRole('button', { name: 'All (A1, A2)' }).click();
    await expect(page.getByRole('cell', { name: 'Mock POS', exact: true })).toBeVisible();

    let retryPostCount = 0;
    page.on('request', (req) => {
      if (req.method() === 'POST' && req.url().endsWith('/api/jobs/j1/retry')) {
        retryPostCount += 1;
      }
    });

    const rowJ1 = page.locator('tbody tr', { hasText: 'Mock POS' });
    await rowJ1.getByRole('button', { name: 'Retry', exact: true }).dblclick();

    await expect(rowJ1.locator('[data-status="HEALTHY"]')).toBeVisible({ timeout: 5000 });
    expect(retryPostCount).toBe(1);
  });

  test('6. Favicon and mobile responsiveness: icon.svg returns 200 and 390x844 layout has no horizontal overflow', async ({
    page,
    request,
  }) => {
    const iconRes = await request.get('/icon.svg');
    expect(iconRes.status()).toBe(200);
    expect(iconRes.headers()['content-type'] ?? '').toMatch(/image\/svg\+xml/i);
    const svgText = await iconRes.text();
    expect(svgText).toContain('<svg');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');

    const iconLinkCount = await page.locator('head link[rel*="icon"]').count();
    expect(iconLinkCount).toBeGreaterThanOrEqual(1);

    const mockPosCell = page.getByRole('cell', { name: 'Mock POS', exact: true });
    await expect(mockPosCell).toBeVisible();

    const hasNoOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    );
    expect(hasNoOverflow).toBe(true);

    const sessionBox = await page.locator('#session-select').boundingBox();
    expect(sessionBox).not.toBeNull();
    expect((sessionBox?.x ?? 0) + (sessionBox?.width ?? 0)).toBeLessThanOrEqual(390);

    const resetBox = await page.getByRole('button', { name: 'Reset Fixtures' }).boundingBox();
    expect(resetBox).not.toBeNull();
    expect((resetBox?.x ?? 0) + (resetBox?.width ?? 0)).toBeLessThanOrEqual(390);

    const rowJ1 = page.locator('tbody tr', { hasText: 'Mock POS' });
    await rowJ1.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect(rowJ1.locator('[data-status="HEALTHY"]')).toBeVisible({ timeout: 5000 });
  });
});
