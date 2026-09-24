import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createReactRuntimeServer } from '../server/workbench/react-runtime-server.mjs';
import { createAnalyticsService } from '../server/workbench/analytics-service.mjs';
import { createIsolatedWorkbenchCore } from '../server/workbench/core.mjs';

const env: Record<string, string> = { WORKBENCH_PROJECT_ID: 'demo-react-studio-browser', PRODUCTION_PROJECT_ID: 'demo-react-studio-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-studio-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-react-studio-production-model',
  WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_REACT_RUNTIME_URL: 'http://localhost:8792/runtime', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-only-no-provider' };
const tenantId = 'react-studio-it', actorId = 'admin-a', root = `orgs/${tenantId}`;
const now = () => '2026-09-23T05:00:00.000Z';
let db: Firestore, server: any, runtimeServer: any, base: string, registeredId: string;
const code = () => `import React, { useState } from 'react';
export default function App() {
 const [count,setCount]=useState(0); const [answer,setAnswer]=useState('아직 조회하지 않았습니다');
 const query=async()=>{try{const result=await window.workbench.callApi('${registeredId}',{yearMonth:'2026-09',weekNo:1});setAnswer(String(result.rows[0].project_id))}catch(error){setAnswer(error instanceof Error ? error.message : "조회 실패")}};
 return <main className="p-8 bg-slate-50 min-h-screen"><h1 className="text-2xl font-bold">나의 프로젝트 현황</h1><button onClick={()=>setCount(count+1)}>클릭 {count}회</button><button onClick={query}>사업 조회</button><p role="status">{answer}</p></main>;
}`;
test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  await db.recursiveDelete(db.doc(root));
  await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['weekly_submission'], analyticsScopeRevision: 'v1' });
  const core = createIsolatedWorkbenchCore({ db, env, now }), analytics = createAnalyticsService({ db, now });
  const context = { tenantId, actorId, actorRole: 'admin' }; await core.authorize(context);
  await analytics.importDataset(context, { datasetId: 'weekly_submission', manifest: { semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1', sourceRevision: 'react-browser-fixture', asOf: now(), capturedAt: now(), completeness: 'complete', coverage: { description: '실제 사업이 아닌 격리 QA용 한 행', expectedRows: 1 } },
    schema: [{ name: 'project_id', type: 'string' }, { name: 'year_month', type: 'string' }, { name: 'week_no', type: 'integer' }, { name: 'status', type: 'string' }, { name: 'revision', type: 'integer' }, { name: 'submitted_at', type: 'timestamp' }, { name: 'approved_at', type: 'timestamp' }, { name: 'health', type: 'string' }],
    rows: [{ project_id: '격리된 테스트 사업', year_month: '2026-09', week_no: 1, status: 'WAITING_FOR_UPDATE', revision: 0, submitted_at: null, approved_at: null, health: 'OK' }] });
  const runtimeApp = await createReactRuntimeServer(env);
  runtimeServer = runtimeApp.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => runtimeServer.once('listening', resolve));
  env.WORKBENCH_REACT_RUNTIME_URL = `http://localhost:${runtimeServer.address().port}/runtime`;
  const app = createWorkbenchApp({ db, env, now, analytics, authMode: 'headers', reactCompletionFactory: () => async (input: any) => {
    const tool = (name: string, args: any) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] });
    if (input.tools[0].function.name === 'workbench_step') {
      const interpretation = { summary: '2026년 9월 1주 사업 현황', context: { datasetIds: ['weekly_submission'], period: { start: '2026-09-01', end: '2026-09-30', label: '2026년 9월', basis: 'explicit_request' }, filters: {}, evidenceIds: [] }, ambiguities: [] };
      const evidenceMessage = input.messages.findLast((item: any) => item.content.startsWith('조회 도구 결과'));
      if (!evidenceMessage) return tool('workbench_step', { action: 'query', interpretation, plan: { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id','status','health'], time: { yearMonth: '2026-09', weekNo: 1 } } });
      const evidence = JSON.parse(evidenceMessage.content.slice(evidenceMessage.content.indexOf(':') + 1));
      return tool('workbench_step', { action: 'build_screen', interpretation, purpose: 'connected', request: '확인한 사업 현황을 버튼으로 조회하는 화면', evidenceIds: [evidence.evidenceId], bindings: [{ apiId: registeredId, apiVersion: 1, input: { yearMonth: '2026-09', weekNo: 1 }, evidenceId: evidence.evidenceId }] });
    }
    return ({ tool_calls: [{ function: { name: 'render_react_source', arguments: JSON.stringify({ title: '나의 React QA 화면', code: code() }) } }] }); } });
  server = app.listen(0, '127.0.0.1'); await new Promise<void>((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { for (const item of [server, runtimeServer]) if (item) await new Promise<void>((resolve) => item.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });

test('register API → generate React → real state and API bridge → immutable save/reload → disable blocks existing page', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/**', async (route) => {
    const request = route.request(), url = new URL(request.url());
    const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...request.headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } });
    if (request.method() === 'POST' && url.pathname === '/api/v1/workbench-apis' && response.ok()) registeredId = (await response.json()).id;
    await route.fulfill({ response });
  });
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  await expect(page.getByRole('heading', { name: '나의 업무 공간', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'API 등록·관리', exact: true }).click();
  await page.getByLabel('연결할 사본').selectOption('weekly_submission');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '선택한 사본의 예제로 시작' }).click();
  await page.getByRole('button', { name: '연결 등록', exact: true }).click();
  await expect(page.getByRole('heading', { name: '저장 버전 v1 테스트' })).toBeVisible();
  await page.getByRole('button', { name: '저장한 연결 테스트' }).click();
  await expect(page.getByRole('region', { name: 'API 테스트 결과' })).toContainText('격리된 테스트 사업');
  await page.getByRole('button', { name: '업무 만들기', exact: true }).click();
  await page.getByText('연결 자료 · 0개', { exact: true }).click(); await page.getByRole('checkbox', { name: /주정산 상태 확인/ }).check();
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByRole('button', { name: '검토한 변경 적용' })).toBeVisible();
  await page.getByRole('button', { name: '검토한 변경 적용' }).click();
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  const frame = page.frameLocator('[data-testid="react-preview-committed"]');
  await expect(frame.getByRole('heading', { name: '나의 프로젝트 현황' })).toBeVisible();
  await frame.getByRole('button', { name: '클릭 0회' }).click();
  await expect(frame.getByRole('button', { name: '클릭 1회' })).toBeVisible();
  await frame.getByRole('button', { name: '사업 조회' }).click();
  await expect(frame.getByRole('status')).toHaveText('격리된 테스트 사업');
  await page.setViewportSize({ width: 1440, height: 960 }); await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: '/tmp/myscube-stage2-auto-live-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(frame.getByRole('heading', { name: '나의 프로젝트 현황' })).toBeVisible();
  await expect(frame.getByRole('button', { name: '클릭 1회' })).toBeVisible();
  await expect(frame.getByRole('status')).toHaveText('격리된 테스트 사업');
  await frame.getByRole('button', { name: '클릭 1회' }).click();
  await expect(frame.getByRole('button', { name: '클릭 2회' })).toBeVisible();
  await page.locator('[data-testid="react-preview-committed"]').scrollIntoViewIfNeeded();
  await frame.locator('body').evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-stage2-auto-live-mobile-preview.png' });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/myscube-stage2-auto-live-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByText(/버전 1으로 저장했습니다/)).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: /나의 React QA 화면.*버전 1/ }).click();
  await expect(page.getByLabel('React 원문')).toHaveValue(code());
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(frame.getByRole('button', { name: '클릭 0회' })).toBeVisible();
  const disabled = await fetch(`${base}/api/v1/workbench-apis/${registeredId}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': crypto.randomUUID() }, body: JSON.stringify({ expectedVersion: 1, definition: { ...(await (await fetch(`${base}/api/v1/workbench-apis`, { headers: { 'x-tenant-id': tenantId, 'x-actor-id': actorId } })).json()).items[0].definition, enabled: false } }) });
  expect(disabled.status).toBe(200);
  await frame.getByRole('button', { name: '사업 조회' }).click();
  await expect(frame.getByRole('status')).toContainText('사용이 중지');
  await page.screenshot({ path: '/tmp/myscube-react-studio-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-react-studio-mobile.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: /나의 React QA 화면.*버전 1/ }).click();
  await page.getByText('연결 자료 · 1개', { exact: true }).click();
  const stopped = page.getByRole('checkbox', { name: /주정산 상태 확인.*사용 중지/ });
  await expect(stopped).toBeEnabled();
  await stopped.uncheck();
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByRole('region', { name: 'React 파일 오류' })).toContainText('App.tsx');
  await expect(page.getByText(/버전 2으로 저장했습니다/)).toHaveCount(0);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill('import React from "react"; export default function App(){return <main><h1>API 연결을 해제한 화면</h1></main>}');
  await page.getByRole('button', { name: '저장·PR 생성' }).click();
  await expect(page.getByText(/버전 2으로 저장했습니다/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('a successful save arriving after another request denied access cannot repopulate private metadata', async ({ page }) => {
  const headers = { 'content-type': 'application/json', 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': crypto.randomUUID() };
  const created = await fetch(`${base}/api/v1/workbench-apis`, { method: 'POST', headers, body: JSON.stringify({ expectedVersion: 0, definition: { name: '권한 회수 검증 연결', description: '합성 자료', kind: 'analytics-copy', enabled: true, parameters: { yearMonth: { type: 'string', required: true, label: '월', example: '2026-09' }, weekNo: { type: 'integer', required: true, label: '주차', example: 1 } }, plan: { datasetId: 'weekly_submission', definitionVersion: '1', select: ['project_id','status','health'], time: { yearMonth: { $input: 'yearMonth' }, weekNo: { $input: 'weekNo' } } } } }) }); expect(created.status).toBe(201); registeredId = (await created.json()).id;
  await page.route('**/api/**', async route => { const url = new URL(route.request().url()); const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response }); });
  await page.goto('/'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByText('연결 자료 · 0개', { exact: true }).click(); await page.getByRole('checkbox', { name: /권한 회수 검증 연결/ }).check();
  await page.getByLabel('화면 제목').fill('권한 회수 전 저장 요청'); await page.getByLabel('React 원문').fill(code());
  await page.getByRole('button', { name: '미리보기 적용' }).click(); const frame = page.frameLocator('[data-testid="react-preview-committed"]'); await expect(frame.getByRole('button', { name: '사업 조회' })).toBeVisible();
  let release!: () => void; const hold = new Promise<void>(resolve => { release = resolve; }); let stored: any;
  await page.route('**/api/v1/react-work-pages', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch({ url: `${base}/api/v1/react-work-pages`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); stored = await response.json(); await hold; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '저장·PR 생성' }).click(); await expect.poll(() => stored?.version).toBe(1);
  await db.doc(`${root}/members/${actorId}`).update({ status: 'INACTIVE' });
  try {
    await frame.getByRole('button', { name: '사업 조회' }).click(); await expect(page.getByRole('alert')).toContainText('조회 권한을 확인하지 못해 실행 화면과 계산 근거를 숨겼습니다');
    const reply = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/v1/react-work-pages'); release(); await (await reply).finished(); await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))); await expect(page.getByRole('button', { name: '저장·PR 생성' })).toBeEnabled(); await expect(page.getByTestId('react-preview-committed')).toHaveCount(0);
    await expect(page.locator('.page-item')).toHaveCount(0); await expect(page.getByText(/버전 1으로 저장했습니다/)).toHaveCount(0); await expect(page.getByLabel('화면 제목')).toHaveValue('권한 회수 전 저장 요청');
    await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('axr:pending-writes:v1:')).flatMap(key => JSON.parse(sessionStorage.getItem(key) || '[]')).length)).toBe(1);
    expect((await db.collection(`${root}/react_work_pages/${(await import('node:crypto')).createHash('sha256').update(actorId).digest('hex')}/pages/${stored.id}/versions`).get()).size).toBe(1);
  } finally { release(); await db.doc(`${root}/members/${actorId}`).update({ status: 'ACTIVE' }); }
});
