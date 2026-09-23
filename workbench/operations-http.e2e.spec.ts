import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createReliabilityService } from '../server/bff/reliability-service.mjs';
import { copyLogPage } from '../server/workbench/copy-feed.mjs';

const tenantId = 'operations-browser', actorId = 'admin-a', root = `orgs/${tenantId}`;
const now = () => '2026-09-23T12:00:00.000Z';
const env = {
  WORKBENCH_PROJECT_ID: 'demo-operations-browser', PRODUCTION_PROJECT_ID: 'demo-operations-original',
  WORKBENCH_MODEL_PROJECT_ID: 'demo-operations-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-operations-original-model',
  WORKBENCH_COPY_SOURCE_PROJECT_ID: 'demo-operations-original', WORKBENCH_COPY_ENABLED: 'true', WORKBENCH_TENANT_ID: tenantId,
  WORKBENCH_AUTH_MODE: 'emulator',
};
let db: Firestore, source: Firestore, server: any, base: string;
test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Synthetic Firestore emulator data required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID }); source = new Firestore({ projectId: env.WORKBENCH_COPY_SOURCE_PROJECT_ID });
  await Promise.all([db.recursiveDelete(db.doc(root)), source.recursiveDelete(source.doc(root))]);
  await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
  const history = createReliabilityService({ db: source, now: () => '2026-09-22T03:00:00.000Z', environment: 'live' });
  for (const [operationId, outcome] of [['10000000-0000-4000-8000-000000000001', 'saved'], ['10000000-0000-4000-8000-000000000002', 'system_failed']]) {
    await history.observe({ tenantId, actorId, actorRole: 'admin' }, { authority: 'server', operationId, operationKey: 'registration.submit', mode: 'manual', outcome,
      requestId: `request-${outcome}`, releaseSha: 'a'.repeat(40), errorCode: outcome === 'system_failed' ? 'synthetic_failure' : null });
  }
  await source.doc(`${root}/client_error_events/synthetic-error`).set({ actorId, createdAt: '2026-09-22T03:00:01.000Z', occurredAt: '2026-09-22T03:00:00.000Z', extra: { errorCode: 'synthetic_failure', status: 500 } });
  for (const kind of ['reliability_operations', 'client_error_events']) await copyLogPage({ source, db, env, kind, now });
  server = createWorkbenchApp({ db, env, now, authMode: 'headers' }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => {
  if (server) await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeIdleConnections?.(); });
  if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); }
  if (source) { await source.recursiveDelete(source.doc(root)); await source.terminate(); }
});

test('real historical copy → HTTP summary → browser stays read-only and clears records after permission revocation', async ({ page }, testInfo) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    await route.fulfill({ response });
  });
  const original = (await source.collection(`${root}/reliability_operations`).get()).docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const received = page.waitForResponse((response) => response.url().endsWith('/product-operations/summary?days=7'));
  await page.setViewportSize({ width: 1380, height: 1100 }); await page.goto('/?mode=operations');
  const response = await received; expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ measurementScope: 'logical_operation', historicalOnly: true, counts: { total: 2, saved: 1, system_failed: 1 }, clientErrors: { count: 1 }, httpRequests: { status: 'not_collected', rate: null } });
  await expect(page.getByTestId('operations-attempt-count')).toHaveText('2');
  await expect(page.getByTestId('operations-client-error-count')).toHaveText('1');
  await expect(page.getByTestId('operations-historical-rate')).toHaveText('50.0%');
  await expect(page.getByRole('region', { name: '과거 업무 기록 표' })).toContainText('2026-09-22');
  await page.screenshot({ path: testInfo.outputPath('operations-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('operations-mobile.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect((await source.collection(`${root}/reliability_operations`).get()).docs.map((doc) => ({ id: doc.id, data: doc.data() }))).toEqual(original);
  expect((await db.collection(`${root}/reliability_operations`).get()).size).toBe(2);
  await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
  const rejected = page.waitForResponse((value) => value.url().endsWith('/product-operations/summary?days=7'));
  await page.getByRole('button', { name: '운영 기록 다시 조회' }).click();
  expect((await rejected).status()).toBe(403);
  await expect(page.getByTestId('operations-error')).toContainText('조회 권한을 확인할 수 없습니다');
  await expect(page.getByTestId('operations-attempt-count')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '과거 업무 기록 표' })).toHaveCount(0);
  expect((await db.collection(`${root}/reliability_operations`).get()).size).toBe(2);
});
