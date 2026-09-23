import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';
import { buildCashflowInflowDataset } from '../server/workbench/cashflow-inflow-copy.mjs';
import { makeInflowFixtureMatrix } from '../server/workbench/cashflow-inflow-fixture.mjs';
import { weekColumnFor } from '../server/bff/cashflow-coordinates.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const env = { WORKBENCH_PROJECT_ID: 'demo-inflow-browser', PRODUCTION_PROJECT_ID: 'demo-inflow-browser-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-inflow-browser-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-inflow-browser-production-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-planner-only' };
const tenantId = 'inflow-browser-it', actorId = 'admin-a', root = `orgs/${tenantId}`;
const context: { tenantId: string; actorId: string; actorRole: string; analyticsScope?: unknown } = { tenantId, actorId, actorRole: 'admin' };
const now = () => '2026-09-22T12:00:00.000Z';
const selected = { period: { start: '2026-09-01', end: '2026-09-06', label: '2026년 9월 1주', basis: 'explicit_request' }, datasetIds: ['cashflow_inflow'], filters: { mode: 'actual', receipt_scope: 'sales_with_vat', currency: 'KRW', period_basis: 'finance_week' }, evidenceIds: [] };
const interpretation = (context = selected) => ({ summary: '2026년 9월 1주 매출·매출부가세 실제 입금', context, ambiguities: [] });
const tool = (value: unknown) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(value) } }] });

let db: Firestore; let analytics: ReturnType<typeof createAnalyticsService>; let core: ReturnType<typeof createIsolatedWorkbenchCore>; let server: ReturnType<ReturnType<typeof createWorkbenchApp>['listen']>; let base = ''; let phase = 'clarify'; let hideCoverage = false;
const complete = async ({ messages }: any) => {
  if (phase === 'clarify') return tool({ action: 'clarify', interpretation: { summary: '실제 입금 또는 예정 입금 확인', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [{ field: 'mode', reason: '실제 입금과 입금 예정은 다릅니다.', question: '실제 입금과 입금 예정 중 어느 쪽인가요?', options: [{ id: 'actual', label: '실제 입금' }, { id: 'projection', label: '입금 예정' }] }] } });
  const result = messages.findLast((message: any) => message.content.startsWith('조회 도구 결과'));
  if (!result) return tool({ action: 'query', interpretation: interpretation(), plan: { datasetId: 'cashflow_inflow', definitionVersion: '1', measures: ['total_amount', 'known_amount_total'], filters: [{ field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'sales_with_vat' }, { field: 'currency', op: 'eq', value: 'KRW' }], time: { yearMonth: '2026-09', weekNo: 1 } } });
  const evidence = JSON.parse(result.content.slice(result.content.indexOf(':') + 1));
  if (hideCoverage) return tool({ action: 'render', interpretation: interpretation(), answer: '근거가 연결된 화면을 제안했습니다.', title: '숨김 표 방어 검증',
    html: '<!DOCTYPE html><html lang="ko"><head><meta name="viewport" content="width=device-width"><title>숨김 표 방어 검증</title></head><body><h1>입금 금액</h1><section class="hidden" data-binding="coverage"></section><span data-binding="amount"></span></body></html>',
    bindings: [{ id: 'coverage', evidenceId: evidence.evidenceId, kind: 'table' }, { id: 'amount', evidenceId: evidence.evidenceId, kind: 'value', row: 0, column: 'known_amount_total' }] });
  return tool({ action: 'render', interpretation: interpretation(), answer: '조회하지 못한 사업이 있어 전체 합계는 확인할 수 없습니다. 확인된 항목 부분합은 110원입니다.', title: '입금 부분합 확인', html: '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>입금 부분합 확인</title></head><body class="bg-slate-50 text-slate-900"><main class="mx-auto max-w-5xl p-5"><h1 class="text-2xl font-bold">입금 부분합 확인</h1><section class="overflow-x-auto [&_table]:w-full [&_table]:min-w-[720px] [&_th]:whitespace-nowrap [&_table]:mt-5 [&_table]:rounded-lg [&_table]:bg-white [&_th]:p-3 [&_th]:text-left [&_th]:text-sm [&_td]:p-3 [&_td]:border-t [&_p]:mt-4 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-slate-500" data-binding="projects"></section></main></body></html>', bindings: [{ id: 'projects', evidenceId: evidence.evidenceId, kind: 'table' }] });
};

test.beforeAll(async () => {
  test.skip(!enabled, 'Firestore emulator is required for this real data browser test');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID }); analytics = createAnalyticsService({ db, now }); core = createIsolatedWorkbenchCore({ db, env, now });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers', analytics, conversationCompletionFactory: () => complete });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.beforeEach(async () => {
  await db.recursiveDelete(db.doc(root)); phase = 'clarify'; hideCoverage = false;
  delete context.analyticsScope;
  await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['cashflow_inflow'], analyticsScopeRevision: 'v1' });
  await core.authorize(context);
  const matrix = makeInflowFixtureMatrix(2026, '0');
  const column = weekColumnFor(2026, '2026-09', 1); matrix[40][column] = '100'; matrix[41][column] = '10';
  await analytics.importDataset(context, buildCashflowInflowDataset({ yearMonth: '2026-09', weekNos: [1], capturedAt: now(), targets: [
    { projectId: 'good', spreadsheetId: 'fixture-good-spreadsheet', sheetName: 'cashflow', currency: 'KRW', weeklyYear: 2026, matrix },
    { projectId: 'unavailable', spreadsheetId: 'fixture-missing-spreadsheet', sheetName: 'cashflow', currency: 'KRW', weeklyYear: 2026, failure: 'UNAVAILABLE' },
  ] }));
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });

test('offline planner → real HTTP/Firestore/DuckDB → partial inflow evidence → source save/reload', async ({ page }) => {
  const pageErrors: string[] = []; page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId, ...(request.method() === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) } });
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '업무 대화 입력', exact: true }).fill('2026년 9월 1주 매출과 부가세 입금액을 표로 보여줘');
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect(page.getByLabel('추가 확인').getByText('실제 입금과 입금 예정 중 어느 쪽인가요?', { exact: true })).toBeVisible();
  phase = 'render'; await page.getByRole('button', { name: '실제 입금', exact: true }).click();
  await expect(page.getByText('조회하지 못한 사업이 있어 전체 합계는 확인할 수 없습니다. 확인된 항목 부분합은 110원입니다.')).toBeVisible();
  await page.getByRole('button', { name: '제안 소스 검토하기', exact: true }).click();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  const frame = page.frameLocator('[data-testid="source-preview-committed"]');
  await expect(frame.getByRole('columnheader', { name: '확인된 항목 부분합', exact: true })).toBeVisible();
  await expect(frame.getByRole('cell', { name: '110', exact: true })).toBeVisible();
  await expect(frame.getByRole('cell', { name: '자료 없음', exact: true })).toBeVisible();
  await expect(frame.getByRole('cell', { name: '1', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '현재 소스 저장', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('버전 1으로 저장');
  await page.reload();
  await page.getByRole('button', { name: /^입금 부분합 확인/ }).click();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(frame.getByRole('cell', { name: '110', exact: true })).toBeVisible();
  await expect(frame.getByRole('cell', { name: '자료 없음', exact: true })).toBeVisible();
  await page.getByRole('navigation', { name: '대화 목록' }).getByRole('button').first().click();
  await expect(page.getByText('조회하지 못한 사업이 있어 전체 합계는 확인할 수 없습니다. 확인된 항목 부분합은 110원입니다.')).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-s17-inflow-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const mobileTable = frame.getByRole('table');
  await page.locator('[data-testid="source-preview-committed"]').scrollIntoViewIfNeeded();
  await mobileTable.scrollIntoViewIfNeeded();
  expect(await mobileTable.evaluate((table) => table.getBoundingClientRect().width)).toBeGreaterThanOrEqual(720);
  expect(await mobileTable.evaluate((table) => getComputedStyle(table.closest('section')!).overflowX)).toBe('auto');
  await page.screenshot({ path: '/tmp/myscube-s17-inflow-mobile.png', fullPage: true });
  expect(pageErrors).toEqual([]);
});


test('host-owned evidence stays visible when generated HTML hides its table, before and after reload', async ({ page }) => {
  hideCoverage = true; phase = 'render';
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId, ...(request.method() === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) } });
    await route.fulfill({ response });
  });
  await page.goto('/');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '업무 대화 입력', exact: true }).fill('2026년 9월 1주 정산주 기준 실제 매출과 부가세 입금 원화 합계를 보여줘');
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect(page.getByText('근거가 연결된 화면을 제안했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '제안 소스 검토하기', exact: true }).click();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  const frame = page.frameLocator('[data-testid="source-preview-committed"]');
  await expect(frame.getByRole('table')).toBeHidden();
  await expect(frame.locator('span').filter({ hasText: /^110$/ })).toBeVisible();
  const evidence = page.getByRole('region', { name: '계산 근거', exact: true });
  await expect(evidence).toBeVisible();
  await expect(evidence.getByText('계산 불가·입력 확인 필요', { exact: true })).toBeVisible();
  await expect(evidence.getByText('110원', { exact: true })).toBeVisible();
  await expect(evidence.getByText('1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '현재 소스 저장', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('버전 1으로 저장');
  await page.reload();
  await page.getByRole('button', { name: /^숨김 표 방어 검증/ }).click();
  await expect(evidence).toBeVisible();
  await expect(evidence.getByText('계산 불가·입력 확인 필요', { exact: true })).toBeVisible();
  await expect(evidence.getByText('110원', { exact: true })).toBeVisible();
  await expect(evidence.getByText('1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(frame.getByRole('table')).toBeHidden();
  await expect(frame.locator('span').filter({ hasText: /^110$/ })).toBeVisible();
  await expect(page.getByRole('button', { name: '현재 소스 저장', exact: true })).toBeEnabled();
  await page.locator('[data-testid="source-preview-committed"]').scrollIntoViewIfNeeded();
  await expect(frame.locator('span').filter({ hasText: /^110$/ })).toBeInViewport();
  await page.screenshot({ path: '/tmp/myscube-s17-host-evidence.png', fullPage: true });
  await db.doc(`${root}/members/${actorId}`).update({ analyticsDatasetIds: [], analyticsScopeRevision: 'v2' });
  const denied = page.waitForResponse((response) => response.url().includes('/html-work-pages/evidence/') && [403, 404].includes(response.status()));
  await evidence.getByRole('button', { name: '근거 다시 확인', exact: true }).click();
  await denied;
  await expect(page.getByTestId('bound-evidence-error')).toContainText('이전 금액은 표시하지 않습니다.');
  await expect(evidence.getByText('110원', { exact: true })).toHaveCount(0);
});
