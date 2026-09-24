import { test, expect } from '@playwright/test';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from '../server/workbench/app.mjs';
import { createReactRuntimeServer } from '../server/workbench/react-runtime-server.mjs';

const env: Record<string, string> = { WORKBENCH_PROJECT_ID: 'demo-react-conversation-browser', PRODUCTION_PROJECT_ID: 'demo-react-conversation-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-react-conversation-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-react-conversation-production-model', WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_REACT_RUNTIME_URL: 'http://localhost:8792/runtime', WORKBENCH_APP_ORIGIN: 'http://127.0.0.1:4178', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-only' };
const tenantId = 'react-conversation-browser', actorId = 'admin-a';
const now = () => '2026-09-23T05:00:00.000Z';
const original = "import React from 'react'; export default function App(){return <main><h1>저장 전 편집 원문</h1></main>}";
const proposal = "import React from 'react'; export default function App(){return <main><h1>카드로 만든 후속 제안</h1></main>}";
let db: Firestore, server: any, runtime: any, base: string, inputs: any[] = [];
const tool = (name: string, value: unknown) => ({ tool_calls: [{ function: { name, arguments: JSON.stringify(value) } }] });
test.beforeAll(async () => {
  test.skip(!process.env.FIRESTORE_EMULATOR_HOST, 'Firestore emulator required');
  db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  await db.recursiveDelete(db.doc(`orgs/${tenantId}`));
  await db.doc(`orgs/${tenantId}/members/${actorId}`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: [], analyticsScopeRevision: '1' });
  runtime = (await createReactRuntimeServer(env)).listen(0, '127.0.0.1'); await new Promise<void>((resolve) => runtime.once('listening', resolve));
  env.WORKBENCH_REACT_RUNTIME_URL = `http://localhost:${runtime.address().port}/runtime`;
  server = createWorkbenchApp({ db, env, now, authMode: 'headers', reactCompletionFactory: () => async (input: any) => {
    if (input.tools[0].function.name === 'workbench_step') {
      const request = input.messages.at(-1).content;
      const interpretation = { summary: '화면 배치 확인', context: { datasetIds: [], filters: {}, evidenceIds: [] }, ambiguities: [] as any[] };
      if (request.includes('배치를 결정')) return tool('workbench_step', { action: 'clarify', interpretation: { ...interpretation, ambiguities: [{ field: 'layout', question: '표와 카드 중 어떤 배치가 좋으세요?', reason: '내용을 유지하며 배치만 정합니다.', options: [{ id: 'cards', label: '카드로 보여 주세요' }] }] } });
      return tool('workbench_step', { action: 'build_screen', interpretation, purpose: 'layout_only', request, evidenceIds: [], bindings: [] });
    }
    inputs.push(input);
    const request = JSON.parse(input.messages.at(-1).content).request;
    if (request.includes('배치를 결정')) return tool('clarify_react_request', { question: '표와 카드 중 어떤 배치가 좋으세요?', reason: '내용을 유지하며 배치만 정합니다.', options: [{ id: 'cards', label: '카드로 보여 주세요' }] });
    if (request.includes('늦은 제안')) await new Promise((resolve) => setTimeout(resolve, 700));
    return tool('render_react_source', { title: '후속 카드 제안', code: proposal });
  } }).listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
test.afterAll(async () => { for (const item of [server, runtime]) if (item) await new Promise<void>((resolve) => item.close(() => resolve())); if (db) { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); } });
test.beforeEach(async ({ page }) => { await page.route('**/api/**', async (route) => { const url = new URL(route.request().url()); const response = await route.fetch({ url: `${base}${url.pathname}${url.search}`, headers: { ...route.request().headers(), 'x-tenant-id': tenantId, 'x-actor-id': actorId } }); await route.fulfill({ response }); }); });

test('clarification preserves the live preview; reload follows persisted source context and applies a proposal only explicitly', async ({ page }) => {
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(original);
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(page.frameLocator('[data-testid="react-preview-committed"]').getByRole('heading', { name: '저장 전 편집 원문' })).toBeVisible();
  await page.getByLabel('업무 요청').fill('배치를 결정하기 전에 확인해 주세요');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByRole('region', { name: '제작 추가 확인' })).toContainText('표와 카드 중');
  await expect(page.getByLabel('React 원문')).toHaveValue(original);
  await expect(page.frameLocator('[data-testid="react-preview-committed"]').getByRole('heading', { name: '저장 전 편집 원문' })).toBeVisible();
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toHaveCount(0);
  const url = page.url(); expect(url).toContain('conversation=');
  await page.reload();
  await expect(page.getByRole('region', { name: '제작 추가 확인' })).toBeVisible();
  await expect(page.getByText('이 대화에 저장된 코드와 API 버전을 기준으로 이어갑니다.', { exact: false })).toBeVisible();
  const defaultSource = await page.getByLabel('React 원문').inputValue(); expect(defaultSource).not.toBe(original);
  await page.getByRole('button', { name: '카드로 보여 주세요', exact: true }).click();
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeVisible();
  expect(JSON.parse(inputs.at(-1).messages.at(-1).content).currentSource.workspace.files['App.tsx']).toBe(original);
  await expect(page.getByLabel('React 원문')).toHaveValue(defaultSource);
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '대화 당시 편집 내용 불러오기', exact: true }).click();
  await expect(page.getByLabel('React 원문')).toHaveValue(original);
  await page.getByRole('button', { name: '이 화면 제안 검토하기', exact: true }).click();
  await page.getByRole('button', { name: '검토한 변경 적용', exact: true }).click();
  await expect(page.getByLabel('React 원문')).toHaveValue(proposal);
  const id = new URL(page.url()).searchParams.get('conversation');
  const owner = (await import('node:crypto')).createHash('sha256').update(actorId).digest('hex');
  expect((await db.collection(`orgs/${tenantId}/axr_conversations/${owner}/sessions/${id}/turns`).get()).size).toBe(2);
});

test('a late source proposal cannot replace a newly selected editor page', async ({ page }) => {
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(original);
  await page.getByLabel('업무 요청').fill('늦은 제안으로 카드 화면을 만들어 주세요');
  await page.getByRole('button', { name: '보내기' }).click();
  await expect(page.getByRole('button', { name: '대화를 처리하고 있습니다…' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '새 화면', exact: true }).click();
  const resetSource = await page.getByLabel('React 원문').inputValue();
  await expect(page.getByRole('button', { name: '이 화면 제안 검토하기' })).toBeVisible();
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('React 원문')).toHaveValue(resetSource);
});

test('current permission denial removes saved conversation evidence and the live frame while preserving the editor', async ({ page }) => {
  await page.goto('/'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).not.toHaveValue('');
  await page.getByLabel('React 원문').fill(original); await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect(page.frameLocator('[data-testid="react-preview-committed"]').getByText('저장 전 편집 원문')).toBeVisible();
  await page.getByLabel('업무 요청').fill('카드로 보여 주세요'); await page.getByRole('button', { name: '보내기', exact: true }).click(); await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toBeVisible();
  const sourceBefore = await page.getByLabel('React 원문').inputValue();
  await db.doc(`orgs/${tenantId}/members/${actorId}`).update({ status: 'INACTIVE' });
  try {
    await page.getByRole('button', { name: '저장된 대화 다시 확인', exact: true }).click();
    await expect(page.getByRole('region', { name: '업무 대화' }).getByRole('alert')).toContainText('이전 대화와 근거를 숨겼습니다');
    await expect(page.getByRole('button', { name: '이 화면 제안 검토하기' })).toHaveCount(0); await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toHaveCount(0);
    await expect(page.getByTestId('react-preview-committed')).toHaveCount(0); await expect(page.getByLabel('React 원문')).toHaveValue(sourceBefore);
  } finally { await db.doc(`orgs/${tenantId}/members/${actorId}`).update({ status: 'ACTIVE' }); }
});
