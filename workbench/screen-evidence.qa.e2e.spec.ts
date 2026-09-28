import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createReactRuntimeServer } from '../server/workbench/react-runtime-server.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';
import { createRegisteredApiService } from '../server/workbench/registered-apis.mjs';
import { buildEvaluationDatasets } from '../server/workbench/evaluation/acceptance-cases.mjs';

const tenantId = 'screen-evidence-independent', actorId = 'qa', root = `orgs/${tenantId}`;
const now = () => '2026-09-24T10:00:00.000Z';
const env: Record<string, string> = { WORKBENCH_PROJECT_ID: 'demo-screen-evidence-independent', PRODUCTION_PROJECT_ID: 'demo-screen-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-screen-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-screen-other-model', WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_REACT_RUNTIME_URL: 'http://localhost:8792/runtime', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'offline-fixture-only' };
let db: Firestore, server: any, runtime: any, base: string, api: any;
const plan = { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id', 'status'], filters: [{ field: 'status', op: 'eq', value: 'WAITING_FOR_UPDATE' }], time: { yearMonth: '2026-09', weekScope: 'all' } };
const interpretation = { summary: '2026년 9월 업데이트 대기', context: { datasetIds: ['weekly_submission'], period: { start: '2026-09-01', end: '2026-09-30', label: '9월', basis: 'explicit_request' }, filters: {}, evidenceIds: [] }, ambiguities: [] };
const tool = (name: string, value: any) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] });

test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID }); await db.recursiveDelete(db.doc(root));
  await db.doc(`${root}/members/${actorId}`).set({ role: 'admin', status: 'ACTIVE', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: '1' });
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now });
  const context: any = { tenantId, actorId, actorRole: 'admin', idempotencyKey: crypto.randomUUID() }; await core.authorize(context);
  await analytics.importDataset(context, buildEvaluationDatasets()[0]);
  api = await createRegisteredApiService({ db, analytics, authorize: core.authorize, env, now }).save(context, null, { expectedVersion: 0, definition: {
    name: '월별 업데이트 대기', description: '9월과 10월 실제 조건 대조', kind: 'analytics-copy', enabled: true,
    parameters: { month: { type: 'string', required: true, label: '정산 월', example: '2026-09', enum: ['2026-09', '2026-10'] } }, plan: { ...plan, time: { yearMonth: { $input: 'month' }, weekScope: 'all' } },
  } });
  runtime = (await createReactRuntimeServer(env)).listen(0, '127.0.0.1'); await new Promise<void>(resolve => runtime.once('listening', resolve));
  env.WORKBENCH_REACT_RUNTIME_URL = `http://localhost:${runtime.address().port}/runtime`;
  server = createWorkbenchApp({ db, env, now, authMode: 'headers', reactCompletionFactory: () => async (input: any) => {
    if (input.tools[0].function.name === 'workbench_step') {
      const message = input.messages.findLast((item: any) => item.content.startsWith('조회 도구 결과'));
      if (!message) return tool('workbench_step', { action: 'query', interpretation, plan });
      const evidence = JSON.parse(message.content.slice(message.content.indexOf(':') + 1));
      return tool('workbench_step', { action: 'build_screen', interpretation, purpose: 'connected', request: '9월 조회 화면', evidenceIds: [evidence.evidenceId], bindings: [{ apiId: api.id, apiVersion: api.version, input: { month: '2026-09' }, evidenceId: evidence.evidenceId }] });
    }
    return tool('render_react_source', { title: '잘못된 초기 조건 반증', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: [{
      path: 'App.tsx', content: `import React,{useState,useEffect} from 'react';export default function App(){const[rows,setRows]=useState<Array<Record<string,unknown>>>([]);const load=(month:'2026-09'|'2026-10')=>window.workbench.callApi('${api.id}',{month}).then(r=>setRows(r.rows));useEffect(()=>{void load('2026-10')},[]);return <main><h1>실제 API 결과</h1>{rows.map((r,i)=><p key={i}>{String(r.project_id)}</p>)}<button onClick={()=>{void load('2026-09')}}>9월로 변경</button></main>}`,
    }] } });
  } }).listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { for (const item of [server, runtime]) if (item) await new Promise<void>(resolve => item.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });

test('September proposal executing October displays actual October evidence plus mismatch, then replaces it on a real filter change and clears after revocation', async ({ page }) => {
  const actualInputs: unknown[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.pathname.endsWith('/call')) actualInputs.push(req.postDataJSON().input);
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...req.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response });
  });
  await page.goto('/');
  await page.locator('summary').filter({ hasText: '연결 자료' }).click(); await page.getByLabel(/월별 업데이트 대기/).check();
  await page.getByLabel('업무 요청').fill('2026년 9월 전체 정산주 업데이트 대기 사업을 조회하고 같은 조건의 화면으로 만들어줘');
  const compiled = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/react-work-pages/preview') && response.request().method() === 'POST');
  await page.getByRole('button', { name: '보내기', exact: true }).click();
  expect((await compiled).status()).toBe(200);
  const frame = page.frameLocator('[data-testid="react-preview-committed"]');
  await expect(frame.getByText('synthetic-october', { exact: true })).toBeVisible();
  const host = page.getByTestId('bound-evidence');
  await expect(host).toContainText('요청한 조회 조건과 실제 화면의 조회 조건이 다릅니다');
  await expect(host).toContainText('2026-10'); await expect(host).toContainText('synthetic-october'); await expect(host).not.toContainText('synthetic-waiting');
  expect(actualInputs).toContainEqual({ month: '2026-10' });
  await frame.getByRole('button', { name: '9월로 변경' }).click();
  await expect(host).toContainText('synthetic-waiting'); await expect(host).not.toContainText('synthetic-october');
  await expect(host.getByRole('alert')).toHaveCount(0);
  expect(actualInputs).toContainEqual({ month: '2026-09' });
  await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
  await host.getByRole('button', { name: '근거 다시 확인' }).click();
  await expect(page.getByTestId('bound-evidence')).toHaveCount(0);
  await expect(page.locator('[data-testid="react-preview-committed"]')).toHaveCount(0);
  await expect(page.getByText('조회 권한을 확인하지 못해 실행 화면과 계산 근거를 숨겼습니다. 편집 내용과 확인하지 않은 저장 요청은 유지됩니다.')).toBeVisible();
  await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  await expect(page.getByLabel('화면 제목')).toHaveValue('잘못된 초기 조건 반증');
});

test('live API host evidence uses actual persisted October input and warns against the September expectation', async ({ page }) => {
  await db.doc(`${root}/members/${actorId}`).update({ status: 'ACTIVE' });
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now });
  const context: any = { tenantId, actorId, actorRole: 'admin' }; await core.authorize(context);
  const apiId = crypto.randomUUID(), definitionHash = 'a'.repeat(64), endpointHash = 'b'.repeat(64);
  const makeEvidence = (yearMonth: string) => analytics.recordApiEvidence(context, { apiId, apiVersion: 1, definitionHash, endpointHash,
    input: { yearMonth }, data: { yearMonth, catalogComplete: false, accessibleInPage: 1, rows: [{ projection: null, actual: 0, status: 'FAILED' }] },
    metadata: { weekCalendarUniform: false, source: '합성 MYSCube 실시간 근거', resultScope: 'THIS_PAGE_ONLY', asOf: now(), limitations: ['이번 페이지 결과이며 전체 사업 합계가 아닙니다.', '실패·누락은 0원이 아닙니다.'] }, truncated: true, queriedAt: now() });
  const october = await makeEvidence('2026-10'), september = await makeEvidence('2026-09');
  const received: string[] = [];
  await page.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...req.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    if (url.pathname.includes('/evidence/')) received.push(url.pathname.split('/').at(-1)!);
    await route.fulfill({ response });
  });
  await page.route('**/live-evidence-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="fixture"></div>' }));
  await page.goto('/live-evidence-fixture');
  await page.evaluate(async ({ apiId, definitionHash, endpointHash, october, september }) => {
    const refresh = await import('/@react-refresh' as string); refresh.default.injectIntoGlobalHook(window); (window as any).$RefreshReg$ = () => {}; (window as any).$RefreshSig$ = () => (type: any) => type;
    const main = await (await fetch('/main.tsx')).text();
    const React = (await import(main.match(/from "([^"]+\/react\.js[^"]*)"/)![1])).default, ReactDOM = (await import(main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)![1])).default;
    const { BoundEvidence } = await import('/BoundEvidence.tsx' as string);
    const root = ReactDOM.createRoot(document.getElementById('fixture'));
    const expected = { apiId, apiVersion: 1, input: { yearMonth: '2026-09' }, evidenceId: september, datasetVersions: {}, definitionVersions: {}, plan: { kind: 'external-read', endpointId: 'myscube-cashflow-evidence', endpointVersion: 1, definitionHash, endpointHash, input: { yearMonth: '2026-09' } } };
    const render = (evidenceId: string) => root.render(React.createElement(BoundEvidence, { bindings: { [apiId]: { evidenceId } }, expectedQueries: [expected] }));
    (window as any).showSeptember = () => render(september); render(october);
  }, { apiId, definitionHash, endpointHash, october: october.evidenceId, september: september.evidenceId });
  const host = page.getByTestId('bound-evidence');
  await expect(host).toContainText('요청한 조회 조건과 실제 화면의 조회 조건이 다릅니다');
  await expect(host).toContainText('yearMonth: 2026-10'); await expect(host).not.toContainText('yearMonth: 2026-09');
  await expect(host).toContainText('THIS_PAGE_ONLY'); await expect(host).toContainText('실패·누락은 0원이 아닙니다');
  await expect(host).not.toContainText('이 결과의 조회 기준을 확인하지 못했습니다');
  await expect(host.getByTestId('page-only-scope')).toContainText('이번 페이지 1개 사업 합계');
  await expect(host.getByTestId('page-only-scope')).toContainText('전사 합계는 확인 필요');
  await expect(host.getByTestId('week-calendar-mismatch')).toContainText('합산할 수 없습니다');
  expect(received).toContain(october.evidenceId);
  await page.evaluate(() => (window as any).showSeptember());
  await expect(host).toContainText('yearMonth: 2026-09'); await expect(host).not.toContainText('yearMonth: 2026-10');
  await expect(host.getByRole('alert')).toHaveCount(0); expect(received).toContain(september.evidenceId);
});
