import { test, expect, type Page, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';

const tenantId = 'request-recovery-browser', actorId = 'admin-a', root = `orgs/${tenantId}`;
const now = () => '2026-09-23T12:00:00.000Z';
const env = { WORKBENCH_PROJECT_ID: 'demo-request-recovery-browser', PRODUCTION_PROJECT_ID: 'demo-other-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-recovery-browser-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-other-model', WORKBENCH_AUTH_MODE: 'emulator' };
const source = "import React from 'react'; export default function App(){return <main>응답이 유실되어도 저장한 원문</main>}";
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
  await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: '1' });
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now }); const context = { tenantId, actorId, actorRole: 'admin' }; await core.authorize(context);
  await analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'recovery-browser-fixture', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '격리된 복구 검증용 사본 한 행', expectedRows: 1 } },
    schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
    rows: [{ project_id: '복구 검증용 사업', year_month: '2026-09', week_no: 1, status: 'PENDING_APPROVAL', revision: 1, submitted_at: now(), approved_at: null, health: 'OK' }] });
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });
async function loseOneResponse(page: Page, path: string) {
  let committed: any, lost = false;
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    if (!lost && request.method() === 'POST' && url.pathname === `/api/v1${path}` && response.ok()) { committed = await response.json(); lost = true; await route.abort('failed'); return; }
    await route.fulfill({ response });
  });
  return () => committed;
}

async function loadRecovered(page: Page, recovery: Locator, accept: boolean) {
  const confirmation = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.type()).toBe('confirm');
    if (accept) await dialog.accept(); else await dialog.dismiss();
  });
  await recovery.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await confirmation;
  await expect(recovery.getByRole('button', { name: '저장 결과 확인' })).toBeEnabled();
}

test('React save committed before a lost HTTP response is recovered after reload without replacing dirty input until confirmed', async ({ page }) => {
  const committed = await loseOneResponse(page, '/react-work-pages');
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('응답 유실 저장본'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(source);
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다'); expect(committed().version).toBe(1);
  const owner = createHash('sha256').update(actorId).digest('hex'), collection = db.collection(`${root}/react_work_pages/${owner}/pages`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
  await expect.poll(() => pending(page)).toHaveLength(1);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('아직 저장하지 않은 새 제목');
  await page.getByText('저장 이력·GitHub·응답 복구', { exact: true }).click(); const recovery = page.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await loadRecovered(page, recovery, false);
  await expect(page.getByLabel('화면 제목')).toHaveValue('아직 저장하지 않은 새 제목'); expect((await pending(page)).length).toBe(1);
  await page.reload(); await page.getByText('저장 이력·GitHub·응답 복구', { exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  expect((await pending(page)).length).toBe(1); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('재접속 후 편집 중인 제목');
  await recovery.getByRole('button', { name: '저장 결과 확인' }).click(); await loadRecovered(page, recovery, true);
  await expect(page.getByLabel('화면 제목')).toHaveValue('응답 유실 저장본'); await expect(page.getByLabel('React 원문')).toHaveValue(source); await expect.poll(() => pending(page)).toHaveLength(0);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
});

test('API recovery filters its own result, retains the request when replacement is cancelled, and restores one immutable API version', async ({ page }) => {
  const committed = await loseOneResponse(page, '/workbench-apis');
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('button', { name: 'API 등록·관리', exact: true }).click();
  const registry = page.getByRole('region', { name: 'API 연결 관리', exact: true });
  await registry.getByLabel('연결할 사본').selectOption('weekly_submission'); page.once('dialog', (dialog) => dialog.accept());
  await registry.getByRole('button', { name: '선택한 사본의 예제로 시작' }).click(); await registry.getByLabel('연결 이름', { exact: true }).fill('응답 유실 API');
  await registry.getByRole('button', { name: '연결 등록', exact: true }).click();
  await expect(registry.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다'); expect(committed().version).toBe(1);
  const owner = createHash('sha256').update(JSON.stringify(actorId)).digest('hex'), collection = db.collection(`${root}/workbench_api_owners/${owner}/apis`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
  await registry.getByLabel('연결 이름', { exact: true }).fill('복구 전 편집 중인 API');
  const recovery = registry.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await loadRecovered(page, recovery, false);
  await expect(registry.getByLabel('연결 이름', { exact: true })).toHaveValue('복구 전 편집 중인 API'); expect((await pending(page)).length).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: 'API 등록·관리', exact: true })).toBeVisible();
  await page.getByText('저장 이력·GitHub·응답 복구', { exact: true }).click(); const reactRecovery = page.getByRole('region', { name: '저장 결과 복구' }); await reactRecovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(reactRecovery).toContainText('확인하지 않은 저장 요청이 없습니다'); expect((await pending(page)).length).toBe(1);
  await page.getByRole('button', { name: 'API 등록·관리', exact: true }).click(); await expect(registry.getByLabel('연결할 사본')).toBeEnabled();
  await registry.getByLabel('연결 이름', { exact: true }).fill('다시 열린 편집 입력'); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await loadRecovered(page, recovery, true);
  await expect(registry.getByRole('heading', { name: '저장 버전 v1 테스트' })).toBeVisible(); await expect(registry.getByLabel('연결 이름', { exact: true })).toHaveValue('응답 유실 API');
  await expect.poll(() => pending(page)).toHaveLength(0); expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
});

test('HTML save response loss survives reload and restores the confirmed source only after explicit replacement', async ({ page }) => {
  const committed = await loseOneResponse(page, '/html-work-pages');
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><main><h1>복구할 HTML 원문</h1></main></body></html>';
  await page.goto('/?mode=html'); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목', { exact: true }).fill('HTML 응답 유실 저장본'); await page.getByLabel('HTML 원문').fill(html);
  await page.getByRole('button', { name: '현재 소스 저장' }).click();
  await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다'); expect(committed().version).toBe(1);
  const owner = createHash('sha256').update(actorId).digest('hex'), collection = db.collection(`${root}/html_work_pages/${owner}/pages`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
  await page.getByLabel('화면 제목', { exact: true }).fill('아직 보관할 편집 내용');
  const recovery = page.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await loadRecovered(page, recovery, false);
  await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('아직 보관할 편집 내용'); expect((await pending(page)).length).toBe(1);
  await page.reload(); await expect(page.getByLabel('HTML 원문')).not.toHaveValue(''); await page.getByLabel('화면 제목', { exact: true }).fill('재접속 후 편집 내용');
  await recovery.getByRole('button', { name: '저장 결과 확인' }).click(); await loadRecovered(page, recovery, true);
  await page.getByRole('tab', { name: '소스', exact: true }).click(); await expect(page.getByLabel('HTML 원문')).toHaveValue(html); await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('HTML 응답 유실 저장본');
  await expect.poll(() => pending(page)).toHaveLength(0); expect((await collection.get()).size).toBe(1); expect((await collection.doc(committed().id).collection('versions').get()).size).toBe(1);
});

test('HTML restore response loss recovers its new immutable revision rather than creating another restoration', async ({ page }) => {
  await loseOneResponse(page, '/does-not-match');
  const original = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>첫 HTML 버전</h1></body></html>';
  await page.goto('/?mode=html'); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  await page.getByLabel('HTML 원문').fill(original); await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByText(/버전 1으로 저장했습니다/)).toBeVisible(); await page.getByRole('tab', { name: '소스', exact: true }).click();
  await page.getByLabel('HTML 원문').fill(original.replace('첫 HTML 버전', '두 번째 HTML 버전')); await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByText(/버전 2으로 저장했습니다/)).toBeVisible();
  let restored: any;
  await page.route('**/api/v1/html-work-pages/*/restore', async (route) => {
    const response = await route.fetch({ url: `${base}${new URL(route.request().url()).pathname}`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    restored = await response.json(); expect(response.ok()).toBe(true); await route.abort('failed');
  });
  await page.getByRole('button', { name: '버전 이력', exact: true }).click(); await page.getByRole('button', { name: '복원', exact: true }).last().click();
  await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다'); expect(restored.version).toBe(3); expect(restored.restoredFrom).toBe(1);
  await page.reload(); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  const recovery = page.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await recovery.getByRole('button', { name: '복구한 저장본 불러오기' }).click();
  await expect(page.getByText('확인한 HTML 저장 결과를 불러왔습니다.', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: '소스', exact: true }).click();
  await expect(page.getByLabel('HTML 원문')).toHaveValue(original); await expect.poll(() => pending(page)).toHaveLength(0);
  const owner = createHash('sha256').update(actorId).digest('hex'), collection = db.collection(`${root}/html_work_pages/${owner}/pages`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(restored.id).collection('versions').get()).size).toBe(3); expect((await collection.doc(restored.id).get()).data()?.version).toBe(3);
});

test('a legacy receipt after permission changes cannot become a new save or reveal its source and keeps its recovery key', async ({ page }) => {
  const committed = await loseOneResponse(page, '/html-work-pages');
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>권한 변경 전 작성 원문</h1></body></html>';
  await page.goto('/?mode=html'); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목', { exact: true }).fill('권한 변경 전 저장'); await page.getByLabel('HTML 원문').fill(html);
  await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다');
  const saved = committed(); expect(saved.version).toBe(1); const originalPending = await pending(page); expect(originalPending).toHaveLength(1);
  const receipts = await db.collection(`${root}/workbench_mutation_results`).get();
  const { operationPayloadHash: _legacyOmitted, ...legacyReceipt } = receipts.docs[0].data(); await receipts.docs[0].ref.set(legacyReceipt);
  await db.doc(`${root}/members/${actorId}`).update({ analyticsScopeRevision: '2' });
  const retry = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/html-work-pages');
  await page.getByRole('button', { name: '현재 소스 저장' }).click(); const rejected = await retry;
  expect(rejected.status()).toBe(409); expect((await rejected.json()).error).toBe('workbench_operation_scope_changed');
  await expect(page.getByRole('alert')).toContainText('중복 저장을 막기 위해 새로 저장하지 않았습니다');
  await expect(page.getByLabel('HTML 원문')).toHaveValue(html); expect((await pending(page))[0].key).toBe(originalPending[0].key);
  const recovery = page.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(recovery.getByRole('alert')).toContainText('조회 권한이 바뀌어 이전 저장 결과를 확인할 수 없습니다');
  await expect(recovery.getByRole('button', { name: '복구한 저장본 불러오기' })).toHaveCount(0);
  await page.reload(); await expect(page.getByLabel('HTML 원문')).not.toHaveValue(''); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(recovery).toContainText('조회 권한 변경 · 저장 요청 보존 중'); expect((await pending(page))[0].key).toBe(originalPending[0].key);
  const owner = createHash('sha256').update(actorId).digest('hex'), collection = db.collection(`${root}/html_work_pages/${owner}/pages`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(saved.id).collection('versions').get()).size).toBe(1);
});

test('current permission revalidation unlocks a lost save only through an explicit confirmed load without another write', async ({ page }) => {
  const committed = await loseOneResponse(page, '/html-work-pages');
  const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><h1>현재 권한으로 다시 확인한 원문</h1></body></html>';
  await page.goto('/?mode=html'); await expect(page.getByLabel('HTML 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목', { exact: true }).fill('권한 재확인 복구본'); await page.getByLabel('HTML 원문').fill(html);
  await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByRole('alert')).toContainText('저장 결과를 아직 확인할 수 없습니다');
  const saved = committed(), originalKey = (await pending(page))[0].key;
  await db.doc(`${root}/members/${actorId}`).update({ analyticsScopeRevision: '2' });
  await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByRole('alert')).toContainText('중복 저장을 막기 위해 새로 저장하지 않았습니다');
  await page.getByLabel('화면 제목', { exact: true }).fill('현재 편집을 유지합니다');
  const recovery = page.getByRole('region', { name: '저장 결과 복구' }); await recovery.getByRole('button', { name: '저장 결과 확인' }).click();
  await expect(recovery).toContainText('현재 권한으로 다시 확인한 저장본'); await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('현재 편집을 유지합니다');
  await loadRecovered(page, recovery, false);
  expect((await pending(page))[0].key).toBe(originalKey); await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('현재 편집을 유지합니다');
  await page.reload(); await expect(page.getByLabel('HTML 원문')).not.toHaveValue(''); await page.getByLabel('화면 제목', { exact: true }).fill('재접속 후 편집 중');
  await recovery.getByRole('button', { name: '저장 결과 확인' }).click(); await expect(recovery).toContainText('현재 권한으로 다시 확인한 저장본');
  await loadRecovered(page, recovery, true);
  await page.getByRole('tab', { name: '소스', exact: true }).click(); await expect(page.getByLabel('HTML 원문')).toHaveValue(html);
  await expect(page.getByLabel('화면 제목', { exact: true })).toHaveValue('권한 재확인 복구본'); await expect.poll(() => pending(page)).toHaveLength(0);
  const owner = createHash('sha256').update(actorId).digest('hex'), collection = db.collection(`${root}/html_work_pages/${owner}/pages`);
  expect((await collection.get()).size).toBe(1); expect((await collection.doc(saved.id).collection('versions').get()).size).toBe(1);
});
