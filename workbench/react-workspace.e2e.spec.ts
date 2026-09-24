import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createReactRuntimeServer } from '../server/workbench/react-runtime-server.mjs';

const env: Record<string, string> = { WORKBENCH_PROJECT_ID: 'demo-react-workspace-browser', PRODUCTION_PROJECT_ID: 'demo-react-workspace-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-workspace-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-react-workspace-production-model', WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_REACT_RUNTIME_URL: 'http://localhost:8792/runtime', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-only-no-provider' };
const tenantId = 'workspace-browser', actorId = 'admin-a', root = `orgs/${tenantId}`;
const now = () => '2026-09-24T07:00:00.000Z';
const helper = 'export const label = "파일 연결 확인";';
const source = { title: '여러 파일로 만든 업무 화면', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: {
  'App.tsx': 'import React from "react"; import Counter from "./components/Counter"; export default function App(){ return <main className="p-8 bg-slate-50"><h1>다중 파일 업무 화면</h1><Counter /></main>; }',
  'components/Counter.tsx': 'import React, { useState } from "react"; import { label } from "../lib/label"; export default function Counter(){ const [count,setCount]=useState(0); return <section><h2>{label}</h2><button onClick={()=>setCount(count+1)}>클릭 {count}회</button></section>; }',
  'lib/label.ts': helper,
} } };
let db: Firestore, server: any, runtime: any, base: string;
test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID }); await db.recursiveDelete(db.doc(root));
  await db.doc(`${root}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
  runtime = (await createReactRuntimeServer(env)).listen(0, '127.0.0.1'); await new Promise<void>(resolve => runtime.once('listening', resolve));
  env.WORKBENCH_REACT_RUNTIME_URL = `http://localhost:${runtime.address().port}/runtime`;
  server = createWorkbenchApp({ db, env, now, authMode: 'headers', reactCompletionFactory: () => async (input: any) => input.tools[0].function.name === 'workbench_step' ? { tool_calls: [{ function: { name: 'workbench_step', arguments: JSON.stringify({ action: 'build_screen', interpretation: { summary: '자료 없는 다중 파일 화면 만들기', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [] }, purpose: 'layout_only', request: '카운터와 파일을 분리한 화면', evidenceIds: [], bindings: [] }) } }] } : ({ tool_calls: [{ function: { name: 'render_react_source', arguments: JSON.stringify({ ...source, workspace: { ...source.workspace, files: Object.entries(source.workspace.files).map(([path, content]) => ({ path, content })) }, ...(JSON.parse(input.messages.at(-1).content).currentSource?.workspace?.files?.['Obsolete.ts'] ? { removedFiles: ['Obsolete.ts'] } : {}) }) } }] }) }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { for (const item of [server, runtime]) if (item) await new Promise<void>(resolve => item.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(root)); await db.terminate(); } });
test.beforeEach(async ({ page }) => { await page.route('**/api/**', async route => { const url = new URL(route.request().url()); const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response }); }); });
const generate = async (page: any, request = '자료 없이 카운터와 제목 컴포넌트를 여러 파일로 나눈 화면을 만들어 주세요') => { await page.getByLabel('업무 요청').fill(request); await page.getByRole('button', { name: '보내기' }).click(); await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeEnabled(); };

test('real HTTP and Firestore: generate, multi-file diff, apply, helper edit, preview, save, reopen and restore', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('새 파일 경로').fill('Obsolete.ts'); await page.getByRole('button', { name: '파일 추가', exact: true }).click();
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill('export const old = true;');
  await generate(page, '자료 없이 카운터와 제목 컴포넌트를 여러 파일로 나눈 화면을 만들어 주세요. 더 이상 사용하지 않는 Obsolete.ts 파일은 삭제해 주세요.');
  await expect(page.getByRole('region', { name: 'React 파일 변경 제안' })).toContainText('삭제 · Obsolete.ts');
  await expect(page.getByLabel('Obsolete.ts 변경 내용')).toContainText('− export const old = true;');
  await expect(page.getByLabel('components/Counter.tsx 변경 내용')).toContainText('useState');
  await page.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Obsolete.ts', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('tab', { name: 'lib/label.ts', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(helper);
  const editedHelper = 'export const label = "실무자 편집 반영";'; await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(editedHelper);
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  const frame = page.frameLocator('[data-testid="react-preview-committed"]');
  await expect(frame.getByRole('heading', { name: '실무자 편집 반영' })).toBeVisible();
  await frame.getByRole('button', { name: '클릭 0회' }).click(); await expect(frame.getByRole('button', { name: '클릭 1회' })).toBeVisible();
  await page.getByRole('button', { name: '저장·PR 생성' }).click(); await expect(page.getByText(/버전 1으로 저장했습니다/)).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('button', { name: /여러 파일로 만든 업무 화면.*버전 1/ }).click();
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('tab', { name: 'lib/label.ts', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(editedHelper);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill('export const label = "두 번째 버전";');
  await page.getByRole('button', { name: '저장·PR 생성' }).click(); await expect(page.getByText(/버전 2으로 저장했습니다/)).toBeVisible();
  await page.getByText('저장 이력·GitHub·응답 복구', { exact: true }).click(); await page.getByRole('button', { name: '버전 이력' }).click();
  const row = page.locator('.history-row').filter({ hasText: '버전 1' }); await row.getByRole('button', { name: '버전 복원' }).click();
  await expect(page.getByText(/새 버전 3으로 복원/)).toBeVisible(); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('tab', { name: 'lib/label.ts', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(editedHelper);
  const list = await (await fetch(`${base}/api/v1/react-work-pages`, { headers: { 'x-tenant-id': tenantId, 'x-actor-id': actorId } })).json();
  const stored = await (await fetch(`${base}/api/v1/react-work-pages/${list.items[0].id}`, { headers: { 'x-tenant-id': tenantId, 'x-actor-id': actorId } })).json();
  expect(stored.version).toBe(3); expect(stored.source.workspace.files['lib/label.ts']).toBe(editedHelper); expect(Object.keys(stored.source.workspace.files)).toHaveLength(3);
  await page.screenshot({ path: '/tmp/myscube-workspace-real-persistence.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
});

test('stale title and hidden file block atomic apply; compiler diagnostics preserve last good preview', async ({ page }) => {
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue(''); await generate(page);
  const before = await page.getByLabel('React 원문').inputValue();
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('제안 뒤 직접 바꾼 제목');
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeDisabled(); await expect(page.getByLabel('React 원문')).toHaveValue(before);
  await page.getByRole('button', { name: '제안 닫기', exact: true }).click(); await generate(page); await page.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await page.getByRole('button', { name: '미리보기 적용' }).click(); const frame = page.frameLocator('[data-testid="react-preview-committed"]');
  await expect(frame.getByRole('heading', { name: '파일 연결 확인' })).toBeVisible();
  await generate(page); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('tab', { name: 'lib/label.ts', exact: true }).click(); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill('export const label: string = 12;');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByRole('tab', { name: 'App.tsx · 시작', exact: true }).click();
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(page.getByRole('region', { name: 'React 파일 오류' })).toContainText('lib/label.ts');
  await expect(frame.getByRole('heading', { name: '파일 연결 확인' })).toBeVisible();
  await page.getByRole('button', { name: /lib\/label.ts · 1행/ }).click();
  await expect(page.getByRole('tab', { name: 'lib/label.ts', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(page.getByLabel('React 원문')).toBeFocused();
});

test('long file deletion can be reviewed fully before applying any proposal', async ({ page }) => {
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  const old = Array.from({ length: 1400 }, (_, index) => `export const previous${index} = ${index};`).join('\n') + '\nexport default function App(){return null;}';
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(old); await generate(page);
  const diff = page.getByLabel('App.tsx 변경 내용');
  await expect(diff).not.toContainText('previous1399');
  await page.getByRole('button', { name: '변경 내용 1,200줄 더 보기 · App.tsx', exact: true }).click();
  await expect(diff).toContainText('− export const previous1399 = 1399;');
  await expect(page.getByLabel('React 원문')).toHaveValue(old);
});

test('default workspace has one conversation; a late compiled response cannot overwrite newer edits or the last good frame', async ({ page }) => {
  await page.goto('/'); await expect(page.getByRole('heading', { name: '나의 업무 공간', exact: true })).toBeVisible();
  await expect(page.getByLabel('제작 대화 요청 종류')).toHaveCount(0); await expect(page.getByLabel('업무 요청')).toBeVisible();
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByLabel('React 원문').fill('export default function App(){return <h1>이전 정상 결과</h1>}');
  await page.getByRole('button', { name: '미리보기 적용' }).click(); const frame = page.frameLocator('[data-testid="react-preview-committed"]'); await expect(frame.getByText('이전 정상 결과')).toBeVisible();
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let arrived = false;
  await page.route('**/api/v1/react-work-pages/preview', async route => {
    const response = await route.fetch({ url: `${base}/api/v1/react-work-pages/preview`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); arrived = true; await held; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill('export default function App(){return <h1>늦은 후보 결과</h1>}');
  await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect.poll(() => arrived).toBe(true);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('요청 중에 바꾼 제목'); release();
  await expect(page.getByRole('alert')).toContainText('편집 내용이 바뀌었습니다'); await expect(page.getByLabel('화면 제목')).toHaveValue('요청 중에 바꾼 제목');
  await page.getByRole('button', { name: '미리보기', exact: true }).click(); await expect(frame.getByText('이전 정상 결과')).toBeVisible(); await expect(frame.getByText('늦은 후보 결과')).toHaveCount(0);
});

test('actual persisted save response preserves edits made while awaiting the acknowledgement', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByLabel('화면 제목').fill('요청 시점의 제목'); await page.getByLabel('React 원문').fill('export default function App(){return <h1>실제 저장본</h1>}');
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let committed: any;
  await page.route('**/api/v1/react-work-pages', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const response = await route.fetch({ url: `${base}/api/v1/react-work-pages`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); committed = await response.json(); await held; await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '저장·PR 생성' }).click(); await expect.poll(() => committed?.version).toBe(1);
  await page.getByLabel('화면 제목').fill('응답 대기 중 편집한 제목'); release();
  await expect(page.getByText(/버전 1으로 저장했습니다/)).toBeVisible(); await expect(page.getByLabel('화면 제목')).toHaveValue('응답 대기 중 편집한 제목');
  await expect(page.getByText('저장하지 않은 변경', { exact: true })).toBeVisible();
  const stored = await (await fetch(`${base}/api/v1/react-work-pages/${committed.id}`, { headers: { 'x-tenant-id': tenantId, 'x-actor-id': actorId } })).json();
  expect(stored.source.title).toBe('요청 시점의 제목'); expect(stored.version).toBe(1);
  await page.getByRole('button', { name: '미리보기', exact: true }).click(); await page.setViewportSize({ width: 1440, height: 960 });
  await page.screenshot({ path: '/tmp/myscube-stage2-studio-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 }); await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '/tmp/myscube-stage2-studio-mobile.png', fullPage: true });
});
