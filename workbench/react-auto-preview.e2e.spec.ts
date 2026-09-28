import { test, expect, type Page } from '@playwright/test';
import { editorIdentity, normalizeReactSource } from '../shared/workbench-react-workspace.mjs';

const conversationId = '11111111-1111-4111-8111-111111111111';
const apiId = '22222222-2222-4222-8222-222222222222';
const example = 'export default function App(){return <h1>Initial</h1>}';
const node = (n: number) => `n_${String(n).padStart(24, '0')}`;
const createdSource = (index: number) => normalizeReactSource({ title: `자동 생성 ${index}`, workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: { 'App.tsx': `import {title} from './lib/title'; export default function App(){return <h1>{title}</h1>}`, 'lib/title.ts': `export const title = '자동 생성 ${index}';` } } });
type Source = ReturnType<typeof normalizeReactSource>;
type ApiRef = { id: string; version: number };
type Result = { type: 'source'; answer: string; source: Source; apis: ApiRef[]; baseEditorIdentity: string };
async function setup(page: Page, liveDefaults = false) {
  const state = { generation: 0, turns: [] as Array<{ id: string; state: string; message: string; result: Result }>, source: null as Source | null, apis: [] as ApiRef[], creates: [] as Array<{ source: Source; apis: ApiRef[]; previousSessionId?: string; viewport: { width: number; height: number } }>, saves: 0, deletes: [] as string[], failCreate: 0, replay: false, hold: null as Promise<void> | null, arrived: false, sessions: new Map<string, ReturnType<typeof makeFrame>>() };
  function makeFrame(id: string, title: string, width: number) {
    return { kind: 'dom', sessionId: id, documentEpoch: crypto.randomUUID(), sourceHash: 'a'.repeat(64), sequence: 1, width, height: 700, snapshot: { schemaVersion: 1, revision: 1, focusedNodeId: null, ack: null, rootNodeId: node(1), nodes: [
      { id: node(1), parentId: null, kind: 'element', tag: 'main', attributes: { id: node(1) }, style: {} },
      { id: node(2), parentId: node(1), kind: 'element', tag: 'h1', attributes: { id: node(2) }, style: {} },
      { id: node(3), parentId: node(2), kind: 'text', text: title },
    ] } };
  }
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/capabilities')) return reply({ modelEnabled: true, gitEnabled: false, runtimeUrl: null, remoteRuntime: true, runtimeMode: 'remote-container', example });
    if (path === '/api/v1/workbench-apis') return reply({ items: liveDefaults ? ['myscube-projects', 'myscube-cashflow-evidence'].map((endpointId, index) => ({ id: index ? '33333333-3333-4333-8333-333333333333' : apiId, version: 2, definition: { name: endpointId, description: '합성 기본 연결', enabled: true, kind: 'external-read', endpointId, endpointVersion: 1 } })) : [{ id: apiId, version: 1, definition: { name: '합성 조회 API', description: '자동 미리보기 회귀', enabled: true } }] });
    if (path === '/api/v1/react-work-pages') { if (request.method() !== 'GET') state.saves++; return reply({ items: [], truncated: false }); }
    if (path.endsWith('/conversations')) return reply(request.method() === 'POST' ? { id: conversationId, title: '합성 자동 생성 대화', version: 0 } : { items: state.turns.length ? [{ id: conversationId, title: '합성 자동 생성 대화', version: state.turns.length }] : [] });
    if (path.endsWith(`/conversations/${conversationId}`)) return reply({ id: conversationId, title: '합성 자동 생성 대화', version: state.turns.length, turns: state.turns, reactContext: state.source ? { source: state.source, apis: state.apis } : null });
    if (path.endsWith(`/conversations/${conversationId}/turns`)) {
      const body = request.postDataJSON(), base = body.currentSource || state.source;
      const apis = body.apis || state.apis;
      const result: Result = { type: 'source', answer: '화면을 만들었습니다.', source: createdSource(++state.generation), apis, baseEditorIdentity: editorIdentity(base, apis) };
      state.source = result.source; state.apis = apis; state.turns.push({ id: crypto.randomUUID(), state: 'completed', message: body.message, result }); state.arrived = true;
      await state.hold;
      return reply({ result, replayed: state.replay, version: state.turns.length });
    }
    if (path === '/api/v1/react-work-pages/remote') {
      const body = request.postDataJSON(); state.creates.push(body);
      if (state.failCreate) return reply({ message: state.failCreate === 403 ? '조회 권한이 변경되었습니다.' : '후보 실행을 완료하지 못했습니다.' }, state.failCreate);
      const id = crypto.randomUUID(), frame = makeFrame(id, body.source.title, body.viewport.width); state.sessions.set(id, frame);
      return reply({ sessionId: id, frame, evidence: {}, expiresAt: '2099-01-01T00:00:00.000Z' });
    }
    const id = path.split('/').at(-1)!;
    if (state.sessions.has(id)) {
      if (request.method() === 'DELETE') { state.deletes.push(id); return reply({ closed: true }); }
      return reply({ sessionId: id, frame: state.sessions.get(id), evidence: {}, expiresAt: '2099-01-01T00:00:00.000Z' });
    }
    return reply({ message: 'Unexpected synthetic endpoint' }, 404);
  });
  await page.goto('/?mode=react'); await expect(page.getByLabel('업무 요청')).toBeEnabled();
  return state;
}
async function generate(page: Page, message = '화면을 만들어 주세요') { await page.getByLabel('업무 요청').fill(message); await page.getByRole('button', { name: '보내기', exact: true }).click(); }

test('a fresh multi-file generation and followup automatically display exactly one candidate each without save or proposal clicks', async ({ page }) => {
  const state = await setup(page); await expect(page.getByRole('note', { name: '예제 화면 안내' })).toBeVisible(); expect(state.creates).toHaveLength(0); expect(state.saves).toBe(0); await generate(page);
  await expect(page.frameLocator('iframe').getByRole('heading', { name: '자동 생성 1' })).toBeVisible();
  await expect(page.getByRole('note', { name: '예제 화면 안내' })).toHaveCount(0);
  expect(state.creates).toHaveLength(1); expect(Object.keys(state.creates[0].source.workspace.files)).toHaveLength(2); expect(state.saves).toBe(0);
  await expect(page.getByRole('button', { name: '검토한 변경 적용', exact: true })).toHaveCount(0);
  await expect(page.getByText('저장하지 않은 변경', { exact: true })).toBeVisible();
  await generate(page, '제목과 배치를 수정해 주세요');
  await expect(page.frameLocator('iframe').getByRole('heading', { name: '자동 생성 2' })).toBeVisible();
  expect(state.creates).toHaveLength(2); expect(state.creates[1].previousSessionId).toBeTruthy(); expect(state.saves).toBe(0);
  await expect.poll(() => state.deletes.length).toBe(1);
  await page.reload(); await expect(page.getByRole('button', { name: '이 화면 제안 검토하기' })).toHaveCount(2);
  expect(state.creates).toHaveLength(2); await expect(page.locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: '이 화면 제안 검토하기' }).last().click();
  await expect(page.getByRole('button', { name: '검토한 변경 적용' })).toBeDisabled(); expect(state.creates).toHaveLength(2);
});

test('failed automatic candidate retains the last normal DOM and permits an explicit preview retry without saving', async ({ page }) => {
  const state = await setup(page); await generate(page); await expect(page.frameLocator('iframe').getByText('자동 생성 1')).toBeVisible();
  state.failCreate = 422; await generate(page, '후속 화면으로 바꿔 주세요');
  await expect(page.getByRole('region', { name: '격리된 React 실행 화면' }).getByRole('alert')).toContainText('후보 실행');
  await expect(page.frameLocator('iframe').getByText('자동 생성 1')).toBeVisible(); expect(state.deletes).toEqual([]); expect(state.saves).toBe(0);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('화면 제목')).toHaveValue('자동 생성 2');
  state.failCreate = 0; await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect(page.frameLocator('iframe').getByText('자동 생성 2')).toBeVisible();
  expect(state.creates).toHaveLength(3); expect(state.saves).toBe(0);
});

for (const change of ['title', 'hidden-file', 'api', 'page'] as const) test(`a delayed generated result preserves a newer ${change} change and never creates a candidate`, async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '원문·파일', exact: true }).click();
  let release!: () => void; state.hold = new Promise<void>(resolve => { release = resolve; });
  await generate(page); await expect.poll(() => state.arrived).toBe(true);
  if (change === 'title') await page.getByLabel('화면 제목').fill('내가 바꾼 제목');
  if (change === 'hidden-file') { await page.getByLabel('새 파일 경로').fill('Hidden.ts'); await page.getByRole('button', { name: '파일 추가', exact: true }).click(); await page.getByLabel('React 원문').fill('export const mine = 1;'); await page.getByRole('tab', { name: 'App.tsx · 시작' }).click(); }
  if (change === 'api') { await page.getByText('연결 자료 · 0개', { exact: true }).click(); await page.getByRole('checkbox').check(); }
  if (change === 'page') await page.getByRole('button', { name: '새 화면', exact: true }).click();
  const source = await page.getByLabel('React 원문').inputValue(); release();
  await expect(page.getByRole('button', { name: '이 화면 제안 검토하기' })).toBeVisible();
  await expect(page.getByLabel('React 원문')).toHaveValue(source); expect(state.creates).toHaveLength(0); expect(state.saves).toBe(0);
  if (change === 'title') await expect(page.getByLabel('화면 제목')).toHaveValue('내가 바꾼 제목');
  if (change === 'hidden-file') { await page.getByRole('tab', { name: 'Hidden.ts', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue('export const mine = 1;'); }
  if (change === 'api') await expect(page.getByRole('checkbox')).toBeChecked();
});

test('a replayed response remains a reviewable proposal and permission denial removes an already visible frame', async ({ page }) => {
  const state = await setup(page); state.replay = true; await generate(page);
  await expect(page.getByRole('button', { name: '검토한 변경 적용' })).toBeEnabled(); expect(state.creates).toHaveLength(0);
  state.replay = false; await page.getByRole('button', { name: '새 대화' }).click(); await generate(page);
  await expect(page.frameLocator('iframe').getByText('자동 생성 2')).toBeVisible(); state.failCreate = 403;
  await generate(page, '권한 확인과 함께 변경해 주세요');
  await expect(page.getByRole('alert')).toContainText('조회 권한을 확인하지 못해 실행 화면과 계산 근거를 숨겼습니다');
  await expect(page.locator('iframe')).toHaveCount(0); await expect.poll(() => state.deletes.length).toBe(1); expect(state.saves).toBe(0);
});


test('approved live defaults need no checkbox click; explicit deselection is retained in the next generated request', async ({ page }) => {
  const state = await setup(page, true);
  await expect(page.getByText('새 화면', { exact: true }).first()).toBeVisible(); await expect(page.getByText('저장하지 않은 변경', { exact: true })).toHaveCount(0);
  await expect(page.getByText('연결 자료 · 2개', { exact: true })).toBeVisible();
  await generate(page); await expect(page.frameLocator('iframe').getByText('자동 생성 1')).toBeVisible();
  expect(state.creates[0].apis).toEqual([{ id: apiId, version: 2 }, { id: '33333333-3333-4333-8333-333333333333', version: 2 }]);
  await page.getByText('연결 자료 · 2개', { exact: true }).click(); await page.getByRole('checkbox', { name: /myscube-projects/ }).uncheck();
  await generate(page, '선택한 연결만 사용해 다시 만들어 주세요'); await expect(page.frameLocator('iframe').getByText('자동 생성 2')).toBeVisible();
  expect(state.creates[1].apis).toEqual([{ id: '33333333-3333-4333-8333-333333333333', version: 2 }]);
  page.once('dialog', dialog => dialog.accept()); await page.getByRole('button', { name: '새 화면', exact: true }).click();
  await expect(page.getByText('연결 자료 · 2개', { exact: true })).toBeVisible(); await expect(page.getByText('저장하지 않은 변경', { exact: true })).toHaveCount(0); expect(state.saves).toBe(0);
});
