import { test, expect } from '@playwright/test';
import { randomUUID, createHash } from 'node:crypto';
import { compileReactPreview } from '../server/workbench/react-compiler.mjs';
import { REACT_EXAMPLE } from '../server/workbench/react-pages.mjs';
import { HTML_EXAMPLE } from '../server/workbench/html-references.mjs';
import { normalizeReactSource, ReactCurrentRevisionSchema } from '../shared/workbench-react-workspace.mjs';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-09-28T00:00:00.000Z';
test('exact saved React example explains disconnected APIs without changing source, selection or making requests', async ({ page }) => {
  const apiId = randomUUID(), secondApiId = randomUUID();
  const source = normalizeReactSource({ title: '저장된 실행 예제', code: REACT_EXAMPLE });
  const customSource = normalizeReactSource({ title: '직접 만든 화면', code: 'export default function App(){return <h1>내 업무 화면</h1>}' });
  const artifact = await compileReactPreview(source), customArtifact = await compileReactPreview(customSource);
  let saved = ReactCurrentRevisionSchema.parse({ schemaVersion: 1, id: randomUUID(), version: 2, source, sourceHash: artifact.sourceHash, artifact, apis: [], updatedAt: at, updatedBy: 'synthetic-example-notice', restoredFrom: null });
  const custom = ReactCurrentRevisionSchema.parse({ ...saved, id: randomUUID(), source: customSource, sourceHash: customArtifact.sourceHash, artifact: customArtifact, apis: [{ id: apiId, version: 1 }] });
  const mutations: Array<{ path: string; body: unknown }> = [];
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.name));
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') mutations.push({ path, body: request.postDataJSON() });
    if (path.endsWith('/capabilities')) return reply({ modelEnabled: true, gitEnabled: false, runtimeUrl: null, remoteRuntime: false, runtimeMode: 'not-configured', example: REACT_EXAMPLE });
    if (path === '/api/v1/workbench-apis') return reply({ items: [apiId, secondApiId].map((id, index) => ({ id, version: 1, definition: { name: index ? '합성 현금흐름 연결' : '합성 사업 연결', description: '실제 자료가 아닌 요청 검증용 연결', enabled: true, kind: 'external-read', endpointId: index ? 'myscube-cashflow-evidence' : 'myscube-projects', endpointVersion: 1 } })) });
    if (path.endsWith('/conversations')) return reply({ items: [] });
    if (path === '/api/v1/react-work-pages') return reply({ items: [saved, custom].map(({ id, version, source, sourceHash, updatedAt }) => ({ id, version, source: { title: source.title }, sourceHash, updatedAt })), truncated: false });
    if (path.endsWith(`/${custom.id}`)) return reply(custom);
    if (path.endsWith(`/${saved.id}`)) {
      if (request.method() === 'PUT') {
        const body = request.postDataJSON(); expect(body.source).toEqual(saved.source); expect(body.apis).toEqual([]); expect(body.expectedVersion).toBe(2);
        saved = { ...saved, version: 3 }; return reply(saved);
      }
      return reply(saved);
    }
    return reply({ message: 'Unexpected fixture request' }, 404);
  });
  await page.goto('/');
  const notice = page.getByRole('note', { name: '예제 화면 안내' });
  await expect(notice).toContainText('API 2개를 선택했지만'); expect(mutations).toEqual([]);
  await page.getByRole('button', { name: /저장된 실행 예제.*버전 2/ }).click();
  await expect(notice).toContainText('저장된 원문도 기본 예제와 같습니다');
  await expect(notice).toContainText('현재 화면에는 선택된 API가 없습니다');
  await page.getByRole('button', { name: '연결 자료 선택하기' }).click();
  const connection = page.getByRole('checkbox', { name: /합성 사업 연결/ }); await expect(connection).not.toBeChecked();
  await connection.check(); await expect(notice).toContainText('API 1개를 선택했지만');
  await connection.uncheck(); await expect(notice).toContainText('현재 화면에는 선택된 API가 없습니다');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(REACT_EXAMPLE);
  expect(mutations).toEqual([]);
  await page.getByRole('button', { name: '저장·PR 생성', exact: true }).click(); await expect(page.getByText('저장됨 · 버전 3', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: /저장된 실행 예제.*버전 3/ }).click(); await expect(notice).toContainText('저장된 원문도 기본 예제와 같습니다');
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(REACT_EXAMPLE);
  await notice.screenshot({ path: '/tmp/myscube-example-notice-react-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); await notice.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '/tmp/myscube-example-notice-react-mobile.png', fullPage: true });
  await page.getByRole('button', { name: /직접 만든 화면.*버전 2/ }).click(); await expect(notice).toHaveCount(0); await expect(page.getByLabel('React 원문')).toHaveValue(customSource.workspace.files['App.tsx']);
  await page.getByText('연결 자료 · 1개', { exact: true }).click(); await expect(connection).toBeChecked();
  await page.getByRole('button', { name: /저장된 실행 예제.*버전 3/ }).click(); await expect(notice).toBeVisible();
  await page.getByLabel('화면 제목').fill('제목만 변경'); await expect(notice).toBeVisible();
  await page.getByLabel('React 원문').fill(`${REACT_EXAMPLE} `); await expect(notice).toHaveCount(0);
  expect(mutations).toHaveLength(1); expect(errors).toEqual([]);
});

test('HTML saved example remains labelled through explicit save/reload and edited HTML is not classified', async ({ page }) => {
  const id = randomUUID(), mutations: string[] = [];
  let saved = { id, version: 1, source: { title: '저장된 HTML 예제', html: HTML_EXAMPLE }, contentHash: hash(HTML_EXAMPLE), referenceIds: [], updatedAt: at, updatedBy: 'synthetic-example-notice' };
  await page.route('**/api/v1/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() !== 'GET') mutations.push(path);
    if (path.endsWith('/capabilities')) return reply({ modelEnabled: false, message: '' });
    if (path.endsWith('/references')) return reply({ references: [], example: HTML_EXAMPLE });
    if (path.endsWith('/workbench-conversations')) return reply({ items: [] });
    if (path === '/api/v1/html-work-pages') return reply({ items: [{ id, title: saved.source.title, version: saved.version, updatedAt: saved.updatedAt }], truncated: false });
    if (path.endsWith(`/${id}`)) {
      if (request.method() === 'PUT') { const body = request.postDataJSON(); expect(body.source).toEqual(saved.source); expect(body.referenceIds).toEqual([]); saved = { ...saved, version: 2 }; }
      return reply(saved);
    }
    return reply({ message: 'Unexpected fixture request' }, 404);
  });
  await page.goto('/?mode=html'); const notice = page.getByRole('note', { name: '예제 화면 안내' });
  await expect(notice).toContainText('실제 자료가 아닌 기본 예제');
  await page.getByRole('button', { name: /저장된 HTML 예제.*버전 1/ }).click(); await expect(notice).toContainText('저장된 원문도 기본 예제');
  expect(mutations).toEqual([]); await expect(page.getByRole('textbox', { name: 'HTML 원문', exact: true })).toHaveValue(HTML_EXAMPLE);
  await page.getByRole('button', { name: '현재 소스 저장' }).click(); await expect(page.getByText('저장됨 · 버전 2', { exact: true })).toBeVisible();
  await page.reload(); await page.getByRole('button', { name: /저장된 HTML 예제.*버전 2/ }).click(); await expect(notice).toBeVisible();
  await notice.screenshot({ path: '/tmp/myscube-example-notice-html.png' });
  await page.getByRole('textbox', { name: 'HTML 원문', exact: true }).fill(`${HTML_EXAMPLE}\n`); await expect(notice).toHaveCount(0);
  expect(mutations).toEqual([`/api/v1/html-work-pages/${id}`]);
});
