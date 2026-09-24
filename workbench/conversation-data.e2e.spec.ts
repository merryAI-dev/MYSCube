import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);
const env = { WORKBENCH_PROJECT_ID: 'demo-conversation-browser', PRODUCTION_PROJECT_ID: 'demo-conversation-browser-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-conversation-browser-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-conversation-browser-production-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-planner-only' };
const tenantId = 'conversation-browser-it', actorId = 'admin-a', root = `orgs/${tenantId}`;
const context: { tenantId: string; actorId: string; actorRole: string; analyticsScope?: unknown } = { tenantId, actorId, actorRole: 'admin' };
const now = () => '2026-09-22T12:00:00.000Z';
const selected = { period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' }, datasetIds: ['weekly_submission'], filters: {}, evidenceIds: [] };
const interpretation = (context = selected) => ({ summary: '2026년 9월 업데이트 대기 상태', context, ambiguities: [] });
const tool = (value: unknown) => ({ tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify(value) } }] });

let db: Firestore; let analytics: ReturnType<typeof createAnalyticsService>; let core: ReturnType<typeof createIsolatedWorkbenchCore>; let server: ReturnType<ReturnType<typeof createWorkbenchApp>['listen']>; let base = ''; let phase = 'clarify';
const complete = async ({ messages }: any) => {
  if (phase === 'clarify') return tool({ action: 'clarify', interpretation: { summary: '연도 확인 필요', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [{ field: 'year', reason: '연도가 지정되지 않았습니다.', question: '어느 연도 9월인가요?', options: [{ id: '2026', label: '2026년 9월' }] }] } });
  const result = messages.findLast((message: any) => message.content.startsWith('조회 도구 결과'));
  if (!result) return tool({ action: 'query', interpretation: interpretation(), plan: { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'revision', 'submitted_at'], filters: [{ field: 'status', op: 'eq', value: 'WAITING_FOR_UPDATE' }], time: { yearMonth: '2026-09', weekScope: 'all' }, orderBy: [{ field: 'project_id', direction: 'asc' }] } });
  const evidence = JSON.parse(result.content.slice(result.content.indexOf(':') + 1));
  return tool({ action: 'render', interpretation: interpretation(), answer: '확인한 업데이트 대기 사업을 표에 연결했습니다.', title: '주정산 확인', html: '<!DOCTYPE html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>주정산 확인</title></head><body class="bg-slate-50 text-slate-900"><main class="mx-auto max-w-5xl p-5"><h1 class="text-2xl font-bold">주정산 확인</h1><section class="overflow-x-auto [&_table]:w-full [&_table]:mt-5 [&_table]:rounded-lg [&_table]:bg-white [&_th]:p-3 [&_th]:text-left [&_th]:text-sm [&_td]:p-3 [&_td]:border-t [&_p]:mt-4 [&_p]:text-xs [&_p]:leading-relaxed [&_p]:text-slate-500" data-binding="projects"></section></main></body></html>', bindings: [{ id: 'projects', evidenceId: evidence.evidenceId, kind: 'table' }] });
};

test.beforeAll(async () => {
  test.skip(!enabled, 'Firestore emulator is required for this real data browser test');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID }); analytics = createAnalyticsService({ db, now }); core = createIsolatedWorkbenchCore({ db, env, now });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers', analytics, conversationCompletionFactory: () => complete });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
test.beforeEach(async () => {
  await db.recursiveDelete(db.doc(root)); phase = 'clarify';
  delete context.analyticsScope;
  await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: 'v1' });
  await core.authorize(context);
  await analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'fixture-revision', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '합성 QA용 세 사업이며 운영 자료가 아닙니다.', expectedRows: 3 } },
      schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
      rows: [{ project_id: '업데이트 대기 사업', year_month: '2026-09', week_no: 1, status: 'WAITING_FOR_UPDATE', revision: 0, submitted_at: null, approved_at: null, health: 'OK' }, { project_id: '승인 대기 사업', year_month: '2026-09', week_no: 1, status: 'PENDING_APPROVAL', revision: 1, submitted_at: now(), approved_at: null, health: 'OK' }, { project_id: '상태 확인 필요', year_month: '2026-09', week_no: 1, status: null, revision: null, submitted_at: null, approved_at: null, health: 'UNAVAILABLE' }] });
});
test.afterAll(async () => { if (server) await new Promise<void>((resolve) => server.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });

test('real Firestore, SQL evidence, server bindings, preview and saved source survive reload', async ({ page }) => {
  await page.route('**/api/**', async (route) => {
    const request = route.request(); const url = new URL(request.url()); const headers = { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId, ...(request.method() === 'GET' ? {} : { 'idempotency-key': crypto.randomUUID() }) };
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers }); await route.fulfill({ response });
  });
  await page.goto('/?mode=html');
  await page.getByRole('button', { name: '새 대화', exact: true }).click();
  await page.getByRole('textbox', { name: '업무 대화 입력', exact: true }).fill('9월 업데이트 대기 사업 화면을 보여줘');
  await page.getByRole('button', { name: '질문 보내기', exact: true }).click();
  await expect(page.getByLabel('추가 확인').getByText('어느 연도 9월인가요?', { exact: true })).toBeVisible();
  phase = 'render'; await page.getByRole('button', { name: '2026년 9월', exact: true }).click();
  await expect(page.getByText('확인한 업데이트 대기 사업을 표에 연결했습니다.')).toBeVisible();
  await page.getByRole('button', { name: '제안 소스 검토하기', exact: true }).click();
  await expect(page.getByText('대화 제안을 편집기에 적용했습니다. 미리보기와 저장을 이어서 확인해 주세요.')).toBeVisible();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByText('업데이트 대기 사업')).toBeVisible();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByText('0', { exact: true })).toBeVisible();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByText('자료 없음', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '현재 소스 저장', exact: true }).click();
  await expect(page.locator('.notice')).toContainText('버전 1으로 저장');
  const title = '주정산 확인';
  await page.reload();
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).click();
  await page.getByRole('button', { name: '미리보기 적용', exact: true }).click();
  await expect(page.frameLocator('[data-testid="source-preview-committed"]').getByText('업데이트 대기 사업')).toBeVisible();
  await expect(page.getByRole('button', { name: '현재 소스 저장', exact: true })).toBeEnabled();
  await page.getByRole('navigation', { name: '대화 목록' }).getByRole('button').first().click();
  await expect(page.getByText('확인한 업데이트 대기 사업을 표에 연결했습니다.')).toBeVisible();
  await expect(page.getByRole('region', { name: '업무 대화' }).getByRole('columnheader', { name: /사업 식별자/ })).toBeVisible();
  await expect(page.getByTestId('bound-evidence').getByRole('columnheader', { name: '사업 식별자', exact: true })).toBeVisible();
  await expect(page.getByTestId('bound-evidence').getByRole('cell', { name: '업데이트 대기 사업', exact: true })).toBeVisible();
  await page.screenshot({ path: '/tmp/myscube-real-conversation-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-real-conversation-mobile.png', fullPage: true });
});
