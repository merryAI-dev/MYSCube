import { expect, test, type Page } from '@playwright/test';

const counts = (total: number | null, failed = 0) => ({ total, saved: total === null ? null : Math.max(0, total - failed), system_failed: failed, rejected: 0, validation_blocked: 0, pending: 0, unknown: 0 });
const fixture = (days = 7) => ({
  from: days === 7 ? '2026-09-17' : days === 14 ? '2026-09-10' : '2026-08-27', to: '2026-09-23', queriedAt: '2026-09-23T03:00:00.000Z',
  measurementScope: 'logical_operation', historicalOnly: true, sourceEnvironments: ['live', 'preview'], counts: counts(8, 1),
  rows: [
    { day: '2026-09-20', environment: 'live', operationKey: 'registration.submit', mode: 'manual', counts: counts(5, 1) },
    { day: '2026-09-21', environment: 'preview', operationKey: 'project-change.draft.save', mode: 'automatic', counts: counts(3) },
  ], truncated: false, invalidRecords: 0,
  collection: { status: 'partial', completeness: 'not_guaranteed', note: '수집된 일부 업무 기록입니다.' },
  source: { capturedAt: '2026-09-23T02:00:00.000Z', sweepCompletedAt: null },
  clientErrors: { count: null as number | null, truncated: false, invalidRecords: 0, collection: { status: 'unverified' } },
  httpRequests: { status: 'not_collected', rate: null, note: '전체 HTTP 요청을 아직 수집하지 않습니다.' }, observedSystemFailureRate: null as number | null,
});
const endpoint = '**/api/v1/product-operations/summary?days=*';
const open = (page: Page) => page.goto('/?mode=operations');

test('historical records, errors without a denominator and uncollected HTTP remain distinct on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const calls: string[] = [];
  await page.route(endpoint, async (route) => { calls.push(route.request().method()); await route.fulfill({ json: fixture() }); });
  await open(page);
  await expect(page.getByRole('heading', { name: '운영 기록', exact: true })).toBeVisible();
  await expect(page.getByText('과거에 수집한 업무 기록입니다.', { exact: true })).toBeVisible();
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('8');
  await expect(page.getByTestId('operations-client-error-count')).toHaveText('확인 불가');
  await expect(page.getByTestId('operations-historical-rate')).toHaveText('계산 불가');
  await expect(page.getByRole('region', { name: 'HTTP 요청 수집', exact: true })).toContainText('아직 수집하지 않음');
  await expect(page.getByRole('region', { name: '기록 수집 상태' })).toContainText('과거 기록 한 차례 확인 완료 시각');
  await page.getByLabel('원본 환경', { exact: true }).selectOption('live');
  const table = page.getByRole('region', { name: '과거 업무 기록 표' });
  await expect(table.getByRole('row')).toHaveCount(2);
  await expect(table).toContainText('운영 (live)');
  await expect(table).not.toContainText('미리보기 (preview)');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(calls).toEqual(['GET']);
});

for (const status of [401, 403, 503]) test(`refresh clears prior records immediately and keeps them hidden after HTTP ${status}`, async ({ page }) => {
  let calls = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route(endpoint, async (route) => {
    if (++calls === 1) return route.fulfill({ json: fixture() });
    await pending;
    await route.fulfill({ status, json: { error: 'permission_private_code', message: 'private server details must not appear' } });
  });
  await open(page);
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('8');
  await page.getByRole('button', { name: '운영 기록 다시 조회' }).click();
  await expect(page.getByTestId('operations-attempt-count')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '과거 업무 기록 표' })).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('현재 조회 권한');
  release();
  await expect(page.getByTestId('operations-error')).toContainText(status === 503 ? '운영 기록을 확인하지 못했습니다' : '조회 권한을 확인할 수 없습니다');
  await expect(page.getByTestId('operations-attempt-count')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('private server details');
});

test('a late response from a previous period cannot replace the selected period', async ({ page }) => {
  let release!: () => void, started!: () => void;
  const initial = new Promise<void>((resolve) => { started = resolve; });
  const delayed = new Promise<void>((resolve) => { release = resolve; });
  await page.route(endpoint, async (route) => {
    const days = Number(new URL(route.request().url()).searchParams.get('days'));
    if (days === 7) { started(); await delayed; }
    await route.fulfill({ json: { ...fixture(days), counts: counts(days === 7 ? 9876 : 140) } });
  });
  await open(page); await initial;
  await page.getByLabel('조회 기간', { exact: true }).selectOption('14');
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('140');
  const oldResponse = page.waitForResponse((response) => response.url().endsWith('/summary?days=7'));
  release(); await oldResponse;
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('140');
  await expect(page.getByRole('region', { name: '기록 수집 상태' })).toContainText('2026-09-10 ~ 2026-09-23');
});

test('only a verified single-environment historical snapshot can display its limited rate; explicit zero remains zero', async ({ page }) => {
  let calls = 0;
  await page.route(endpoint, async (route) => {
    const value = fixture();
    value.collection.status = 'snapshot_ready'; value.clientErrors = { count: 0, truncated: false, invalidRecords: 0, collection: { status: 'snapshot_ready' } };
    value.observedSystemFailureRate = 0.25; value.counts = counts(4, 1);
    if (++calls === 1) { value.sourceEnvironments = ['live']; value.rows = [{ ...value.rows[0], counts: counts(4, 1) }]; }
    await route.fulfill({ json: value });
  });
  await open(page);
  await expect(page.getByTestId('operations-historical-rate')).toHaveText('25.0%');
  await expect(page.getByTestId('operations-client-error-count')).toHaveText('0');
  await expect(page.getByRole('region', { name: '과거 업무 기록', exact: true })).toContainText('현재 서비스 오류율·감소율계산 불가');
  await page.getByRole('button', { name: '운영 기록 다시 조회' }).click();
  await expect(page.getByTestId('operations-historical-rate')).toHaveText('계산 불가');
});

test('unverified empty or malformed responses do not become zero failures', async ({ page }) => {
  let calls = 0;
  await page.route(endpoint, async (route) => {
    const value = fixture(); value.collection.status = 'unverified'; value.counts = counts(0); value.rows = []; value.sourceEnvironments = [];
    await route.fulfill({ json: ++calls === 1 ? value : { ...value, measurementScope: 'http_request' } });
  });
  await open(page);
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('확인 불가');
  await expect(page.getByTestId('operations-historical-rate')).toHaveText('계산 불가');
  await expect(page.getByText('이 기간과 환경에서 확인한 과거 업무 기록이 없습니다. 장애가 없었다는 뜻은 아닙니다.')).toBeVisible();
  await page.getByRole('button', { name: '운영 기록 다시 조회' }).click();
  await expect(page.getByTestId('operations-error')).toBeVisible();
  await expect(page.getByTestId('operations-attempt-count')).toHaveCount(0);
});
