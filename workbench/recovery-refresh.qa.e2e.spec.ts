import { test, expect, type Page } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';

const tenantId = 'recovery-refresh-independent', actorId = 'admin-a', root = `orgs/${tenantId}`;
const now = () => '2026-09-23T12:00:00.000Z';
const env = { WORKBENCH_PROJECT_ID: 'demo-recovery-refresh-independent', PRODUCTION_PROJECT_ID: 'demo-other-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-recovery-refresh-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model', WORKBENCH_AUTH_MODE: 'emulator' };
const source = "import React from 'react'; export default function App(){return <main>Independent recovery source</main>}";
let db: Firestore, server: any, base: string;
const pending = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem('axr:pending-writes:v1:demo-admin') || '[]'));
test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  server = createWorkbenchApp({ db, env, now, authMode: 'headers' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => {
  await db.recursiveDelete(db.doc(root));
  await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });

async function routeLostSave(page: Page, path: string) {
  let lost = false, gate: Promise<void> | undefined;
  const statuses: number[] = [];
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    if (!lost && request.method() === 'POST' && url.pathname === `/api/v1${path}` && response.ok()) { lost = true; await route.abort('failed'); return; }
    if (url.pathname.startsWith('/api/v1/workbench-requests/')) { statuses.push(response.status()); if (gate) await gate; }
    await route.fulfill({ response });
  });
  return { statuses, hold() { let release!: () => void; gate = new Promise<void>((resolve) => { release = resolve; }); return release; } };
}

async function prepare(page: Page) {
  const control = await routeLostSave(page, '/react-work-pages');
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목').fill('권한 확인이 필요한 저장본'); await page.getByLabel('React 원문').fill(source);
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다');
  await expect.poll(() => pending(page)).toHaveLength(1);
  await page.getByLabel('화면 제목').fill('유지해야 할 현재 편집 제목');
  await page.locator('summary').filter({ hasText: '저장 이력·GitHub·응답 복구' }).click();
  const region = page.getByRole('region', { name: '저장 결과 복구' });
  await region.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(region.getByRole('button', { name: '복구한 저장본 불러오기' })).toBeVisible();
  return { region, ...control };
}

test('actual refresh 403 removes previously recovered body and preserves pending write and editor', async ({ page }) => {
  const { region, statuses } = await prepare(page);
  await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
  await region.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect.poll(() => statuses.at(-1)).toBe(403);
  await expect(region.getByRole('button', { name: '저장 결과 확인' })).toBeEnabled();
  await expect(region.getByRole('button', { name: '복구한 저장본 불러오기' })).toHaveCount(0);
  await expect(page.getByLabel('화면 제목')).toHaveValue('유지해야 할 현재 편집 제목');
  expect(await pending(page)).toHaveLength(1);
  await region.screenshot({ path: '/tmp/myscube-recovery-refresh-denied-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await region.screenshot({ path: '/tmp/myscube-recovery-refresh-denied-mobile.png' });
});

test('loading refresh cannot apply the previous completed body', async ({ page }) => {
  const { region, hold } = await prepare(page); const release = hold();
  try {
    await region.getByRole('button', { name: '저장 결과 확인' }).click();
    await expect(region.getByRole('button', { name: '저장 결과 확인' })).toBeDisabled();
    const load = region.getByRole('button', { name: '복구한 저장본 불러오기' });
    await expect.poll(async () => (await load.count()) === 0 || await load.isDisabled()).toBe(true);
    expect(await pending(page)).toHaveLength(1);
    await expect(page.getByLabel('화면 제목')).toHaveValue('유지해야 할 현재 편집 제목');
  } finally { release(); }
  await expect(region.getByRole('button', { name: '저장 결과 확인' })).toBeEnabled();
});

test('clicking a previously successful result rechecks current authority before applying or acknowledging', async ({ page }) => {
  const { region, statuses } = await prepare(page);
  await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
  page.on('dialog', (dialog) => dialog.accept());
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => statuses.at(-1)).toBe(403);
  await expect(page.getByLabel('화면 제목')).toHaveValue('유지해야 할 현재 편집 제목');
  expect(await pending(page)).toHaveLength(1);
});


test('late load cannot overwrite a newly selected empty editor', async ({ page }) => {
  const { region, hold, statuses } = await prepare(page); const release = hold();
  page.on('dialog', (dialog) => dialog.accept());
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => statuses.length).toBe(2);
  await page.getByRole('button', { name: '새 화면', exact: true }).click();
  await page.getByLabel('화면 제목').fill('다른 새 화면의 편집 내용');
  release();
  await expect(region.getByRole('button', { name: '저장 결과 확인' })).toBeEnabled();
  await expect(page.getByLabel('화면 제목')).toHaveValue('다른 새 화면의 편집 내용');
  expect(await pending(page)).toHaveLength(1);
});

test('editing while current-authority load is pending uses the latest dirty confirmation and cancellation preserves pending', async ({ page }) => {
  const { region, hold, statuses } = await prepare(page); const release = hold();
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => statuses.length).toBe(2);
  await page.getByLabel('화면 제목').fill('조회 중 새로 입력한 제목');
  const dialogSeen = page.waitForEvent('dialog');
  release();
  const dialog = await dialogSeen; await dialog.dismiss();
  await expect(region.getByRole('button', { name: '저장 결과 확인' })).toBeEnabled();
  await expect(page.getByLabel('화면 제목')).toHaveValue('조회 중 새로 입력한 제목');
  expect(await pending(page)).toHaveLength(1);
});

test('a parent save attempt invalidates an earlier recovery load even after the parent is idle again', async ({ page }) => {
  const { region, hold, statuses } = await prepare(page); const release = hold();
  page.on('dialog', (dialog) => dialog.accept());
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => statuses.length).toBe(2);
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByRole('button', { name: '저장·PR 생성' })).toBeEnabled();
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByLabel('화면 제목')).toHaveValue('유지해야 할 현재 편집 제목');
  expect(await pending(page)).toHaveLength(1);
});


test('HTML new-to-new editor selection rejects a late successful recovery load', async ({ page }) => {
  const control = await routeLostSave(page, '/html-work-pages');
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>보관할 HTML</h1></body></html>';
  await page.goto('/?mode=html'); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목', { exact: true }).fill('복구 대상 HTML'); await page.getByLabel('HTML 원문').fill(html);
  await page.getByRole('button', { name: '현재 소스 저장' }).click();
  await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다');
  const region = page.getByRole('region', { name: '저장 결과 복구' });
  await region.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(region.getByRole('button', { name: '복구한 저장본 불러오기' })).toBeVisible();
  const release = control.hold();
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => control.statuses.length).toBe(2);
  page.on('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '새 화면', exact: true }).click();
  await page.getByLabel('화면 제목', { exact: true }).fill('새 HTML 편집 내용');
  const delivered = page.waitForResponse((response) => response.url().includes('/workbench-requests/'));
  release(); await (await delivered).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('새 HTML 편집 내용');
  expect(await pending(page)).toHaveLength(1);
});

test('API new-to-new connection selection rejects a late successful recovery load', async ({ page }) => {
  await db.doc(`${root}/members/${actorId}`).update({ analyticsDatasetIds: ['weekly_submission'] });
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now });
  const context = { tenantId, actorId, actorRole: 'admin' }; await core.authorize(context);
  await analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'recovery-independent-fixture', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '독립 복구 테스트용 한 행', expectedRows: 1 } },
    schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
    rows: [{ project_id: '합성 QA 사업', year_month: '2026-09', week_no: 1, status: 'PENDING_APPROVAL', revision: 1, submitted_at: now(), approved_at: null, health: 'OK' }] });
  const control = await routeLostSave(page, '/workbench-apis');
  await page.goto('/?mode=react'); await page.getByRole('button', { name: 'API 등록·관리', exact: true }).click();
  const registry = page.getByRole('region', { name: 'API 연결 관리', exact: true });
  await registry.getByLabel('연결할 사본').selectOption('weekly_submission'); page.once('dialog', (dialog) => dialog.accept());
  await registry.getByRole('button', { name: '선택한 사본의 예제로 시작' }).click();
  await registry.getByLabel('연결 이름', { exact: true }).fill('복구 대상 API');
  await registry.getByRole('button', { name: '연결 등록', exact: true }).click();
  await expect(registry.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다');
  const region = registry.getByRole('region', { name: '저장 결과 복구' });
  await region.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(region.getByRole('button', { name: '복구한 저장본 불러오기' })).toBeVisible();
  const release = control.hold();
  await region.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect.poll(() => control.statuses.length).toBe(2);
  page.on('dialog', (dialog) => dialog.accept());
  await registry.getByRole('button', { name: '새 연결', exact: true }).click();
  await registry.getByLabel('연결 이름', { exact: true }).fill('새 API 편집 내용');
  const delivered = page.waitForResponse((response) => response.url().includes('/workbench-requests/'));
  release(); await (await delivered).finished();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.unrouteAll({ behavior: 'wait' });
  await expect(registry.getByLabel('연결 이름', { exact: true })).toHaveValue('새 API 편집 내용');
  expect(await pending(page)).toHaveLength(1);
});
