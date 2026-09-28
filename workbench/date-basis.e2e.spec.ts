import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';

const env = { WORKBENCH_PROJECT_ID: 'demo-date-basis-browser', PRODUCTION_PROJECT_ID: 'demo-date-basis-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-date-basis-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-date-basis-production-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-only' };
const tenantId = 'date-basis-browser', actorId = 'admin-a', datasetId = 'project_dates';
const now = () => '2026-09-28T01:00:00.000Z';
const context: any = { tenantId, actorId, actorRole: 'admin' };
const tool = (value: unknown) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(value) } }] });
let db: Firestore, server: any, base: string, phase = 'clarify';
const queries: any[] = [], requests: any[] = [];
const understood = () => ({ summary: '선택한 계약 종료일 기준', context: { datasetIds: [datasetId], filters: {}, evidenceIds: [], ...(phase === 'clarify' ? {} : { period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' } }) }, ambiguities: [] });

test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  await db.recursiveDelete(db.doc(`orgs/${tenantId}`));
  await db.doc(`orgs/${tenantId}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: [datasetId], analyticsScopeRevision: '1' });
  const core = createIsolatedWorkbenchCore({ db, env, now }); await core.authorize(context);
  const analytics = createAnalyticsService({ db, now });
  await analytics.importDataset(context, { datasetId, manifest: { sourceRevision: 'synthetic-date-basis', asOf: now(), capturedAt: now(), completeness: 'complete', tableQuery: { schemaVersion: 1 }, coverage: { expectedRows: 2, description: '합성 날짜 검증용 두 행' } }, schema: [{ name: 'name', type: 'string', label: '사업명' }, { name: 'contract_start', type: 'date', label: '계약 시작일' }, { name: 'contract_end', type: 'date', label: '계약 종료일' }], rows: [{ name: '9월 종료 사업', contract_start: '2026-03-01', contract_end: '2026-09-30' }, { name: '9월 시작 사업', contract_start: '2026-09-01', contract_end: '2026-12-31' }] });
  const recorded = { ...analytics, queryPlan: async (...args: any[]) => { queries.push(args[1]); return (analytics.queryPlan as any)(...args); } };
  const completionFactory = () => async ({ messages }: any) => {
    if (phase === 'clarify') return tool({ action: 'clarify_date_column', datasetId, interpretation: understood() });
    const result = messages.findLast((message: any) => typeof message.content === 'string' && message.content.startsWith('조회 도구 결과'));
    if (!result) return tool({ action: 'query_table', interpretation: understood(), plan: { kind: 'table', datasetId, select: ['name'], filters: [{ field: phase === 'wrong' ? 'contract_start' : 'contract_end', op: 'gte', value: '2026-09-01' }, { field: phase === 'wrong' ? 'contract_start' : 'contract_end', op: 'lte', value: '2026-09-30' }] } });
    const evidence = JSON.parse(result.content.slice(result.content.indexOf(':') + 1));
    return tool({ action: 'answer', interpretation: understood(), answer: '선택한 날짜 기준으로 조회한 자료입니다.', evidenceIds: [evidence.evidenceId] });
  };
  server = createWorkbenchApp({ db, env, now, authMode: 'headers', analytics: recorded, reactCompletionFactory: completionFactory, conversationCompletionFactory: completionFactory }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.beforeEach(async () => { await db.doc(`orgs/${tenantId}/html_generation_usage/${now().slice(0, 10)}`).delete(); });
test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(resolve)); if (db) { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); } });

test('server-issued date choice persists through reload and constrains actual SQL after a wrong model plan', async ({ page }) => {
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (req.method() === 'POST' && url.pathname.endsWith('/turns')) requests.push(req.postDataJSON());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...req.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response });
  });
  await page.goto('/?mode=react');
  await page.getByLabel('업무 요청').fill('2026년 9월 계약 사업을 알려줘'); await page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.getByRole('button', { name: '계약 종료일', exact: true })).toBeVisible();
  expect(queries).toHaveLength(0);
  await page.reload();
  phase = 'correct'; await page.getByLabel('업무 요청').fill('계약 종료일'); await page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.locator('.conversation-turn').last().getByRole('button', { name: '계약 종료일', exact: true })).toBeEnabled();
  expect(requests.at(-1).selection).toBeUndefined(); expect(queries).toHaveLength(0);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  const unchangedSource = await page.getByLabel('React 원문').inputValue();
  phase = 'wrong'; await page.locator('.conversation-turn').last().getByRole('button', { name: '계약 종료일', exact: true }).click();
  await expect(page.getByText('선택한 날짜 기준: 계약 종료일.', { exact: false })).toBeVisible();
  expect(requests.at(-1).selection).toEqual({ clarificationId: requests.at(-1).clarificationId, optionId: expect.any(String) });
  await expect(page.getByRole('button', { name: '보내기', exact: true })).toBeVisible();
  await expect(page.locator('.conversation-turn').last().getByRole('alert')).toBeVisible();
  expect(queries).toHaveLength(0);
  await expect(page.getByLabel('React 원문')).toHaveValue(unchangedSource);
  await page.reload();
  await expect(page.getByText('선택한 날짜 기준: 계약 종료일.', { exact: false })).toBeVisible();
  phase = 'correct'; await page.getByLabel('업무 요청').fill('같은 2026년 9월을 다시 조회해줘'); await page.getByRole('button', { name: '보내기', exact: true }).click();
  await expect(page.getByText('선택한 날짜 기준으로 조회한 자료입니다.', { exact: true })).toBeVisible();
  await page.getByText('확인한 자료와 조회 범위', { exact: true }).last().click();
  await expect(page.getByRole('cell', { name: '9월 종료 사업', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: '9월 시작 사업', exact: true })).toHaveCount(0);
  expect(queries).toHaveLength(1); expect(queries[0].filters.every((filter: any) => filter.field === 'contract_end')).toBe(true);
  await page.reload(); await expect(page.getByText('이 답변의 날짜 기준: 계약 종료일', { exact: true })).toBeVisible();
  await page.getByText('확인한 자료와 조회 범위', { exact: true }).last().click();
  await expect(page.getByRole('cell', { name: '9월 종료 사업', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-date-basis-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('cell', { name: '9월 종료 사업', exact: true }).scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-date-basis-mobile.png', fullPage: true });
});

test('HTML conversation uses the same server choice and persisted date basis', async ({ page }) => {
  phase = 'clarify';
  const before = queries.length;
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...req.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response });
  });
  await page.goto('/?mode=html');
  await page.getByLabel('업무 대화 입력', { exact: true }).fill('2026년 9월 계약 사업 조회'); await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect(page.getByRole('button', { name: '계약 종료일', exact: true })).toBeVisible(); expect(queries).toHaveLength(before);
  phase = 'correct'; await page.getByRole('button', { name: '계약 종료일', exact: true }).click();
  await expect(page.getByRole('cell', { name: '9월 종료 사업', exact: true })).toBeVisible();
  await expect(page.getByText('이 답변의 날짜 기준: 계약 종료일', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '계약 종료일', exact: true })).toBeDisabled();
  expect(queries).toHaveLength(before + 1);
  await page.reload(); await page.getByRole('navigation', { name: '대화 목록' }).getByRole('button').filter({ hasText: '2026년 9월 계약 사업 조회' }).click();
  await expect(page.getByText('선택한 날짜 기준: 계약 종료일.', { exact: false })).toBeVisible();
  await expect(page.getByRole('cell', { name: '9월 종료 사업', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-date-basis-html.png', fullPage: true });
});
