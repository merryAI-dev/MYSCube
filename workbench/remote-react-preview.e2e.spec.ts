import { test, expect, type Page } from '@playwright/test';
const idA = '11111111-1111-4111-8111-111111111111', idB = '22222222-2222-4222-8222-222222222222', idC = '33333333-3333-4333-8333-333333333333';
const evidenceId = '44444444-4444-4444-8444-444444444444';
const source = "globalThis.__REMOTE_CODE_EXECUTED = true; export default function App(){return <main>서버에서만 실행</main>}";
const future = '2099-01-01T00:00:00.000Z';
async function setup(page: Page) {
  const state = { unsupported: false, posts: [] as any[], events: [] as any[], deleted: [] as string[], png: '', sequence: 1, failCreate: false, failEvent: false, eventFailureStatus: 503, holdCreate: null as Promise<void> | null, eventSequence: undefined as number | undefined, returnedId: idA, gets: 0 };
  const frame = (sequence = state.sequence) => ({ pngBase64: state.png, width: 1100, height: 700, sequence, ...(state.unsupported ? { kind: 'png', unsupported: [{ code: 'dom_element_unsupported', message: '캔버스는 직접 조작을 지원하지 않습니다.' }] } : {}) });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path.endsWith('/react-work-pages/capabilities')) return reply({ modelEnabled: false, gitEnabled: false, runtimeUrl: null, remoteRuntime: true, runtimeMode: 'remote-container', example: source });
    if (path === '/api/v1/react-work-pages/remote' && request.method() === 'POST') {
      state.posts.push(request.postDataJSON()); const id = state.returnedId;
      await state.holdCreate;
      if (state.failCreate) return reply({ message: '새 실행 화면을 완성하지 못했습니다.' }, 422);
      return reply({ sessionId: id, frame: frame(), expiresAt: future, evidence: {} });
    }
    if (/\/react-work-pages\/remote\/[a-f0-9-]+\/events$/.test(path)) {
      state.events.push(request.postDataJSON()); if (state.failEvent) return reply({ message: '실행 요청을 완료하지 못했습니다.' }, state.eventFailureStatus);
      return reply({ sessionId: path.split('/').at(-2), frame: frame(state.eventSequence ?? ++state.sequence), evidence: { main: { evidenceId } } });
    }
    if (/\/react-work-pages\/remote\/[a-f0-9-]+$/.test(path)) {
      const id = path.split('/').at(-1);
      if (request.method() === 'DELETE') { state.deleted.push(id!); return reply({ closed: true }); }
      state.gets++; return reply({ sessionId: id, frame: frame(state.sequence), evidence: { main: { evidenceId } } });
    }
    if (path.endsWith(`/html-work-pages/evidence/${evidenceId}`)) return reply({ evidenceId, columns: [{ name: 'total_amount' }, { name: 'missing_observation_count' }], rows: [{ total_amount: '730', missing_observation_count: 0 }], metadata: { asOf: '2026-09-23', completeness: '확인됨' }, semantic: { definitionVersions: { inflow: { id: 'cashflow_inflow', version: '1' } } } });
    if (path === '/api/v1/react-work-pages' || path.endsWith('/conversations') || path === '/api/v1/workbench-apis') return reply({ items: [], truncated: false });
    return reply({ message: `Unexpected mocked endpoint ${path}` }, 404);
  });
  await page.goto('/?mode=react'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await expect(page.getByLabel('React 원문')).toHaveValue(source);
  state.png = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = 1100; canvas.height = 700; const context = canvas.getContext('2d')!; context.fillStyle = '#eef6ff'; context.fillRect(0, 0, 1100, 700); context.fillStyle = '#191f28'; context.font = '30px sans-serif'; context.fillText('독립 실행 화면 HTTP 계약 검증', 40, 80); return canvas.toDataURL('image/png').split(',')[1]; });
  return state;
}

test('remote apply sends only a source snapshot, commits a decoded candidate, and preserves the previous session on failure', async ({ page }) => {
  const state = await setup(page);
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  const image = page.getByTestId('remote-react-frame'); await expect(image).toHaveAttribute('data-session', idA);
  expect(state.posts[0]).toEqual({ source: { title: '나의 업무 화면', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: { 'App.tsx': source } } }, apis: [], viewMode: 'dom', viewport: { width: expect.any(Number), height: 700 } });
  expect(await page.locator('iframe').count()).toBe(0); expect(await page.evaluate(() => (window as any).__REMOTE_CODE_EXECUTED)).toBeUndefined();
  const edited = source.replace('서버에서만 실행', '수정된 다음 화면'); await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(edited);
  await expect(page.getByText(/현재 편집 내용과 실행 중인 버전이 다릅니다/)).toBeVisible();
  expect(state.posts).toHaveLength(1);
  let release: () => void = () => {}; state.holdCreate = new Promise<void>((resolve) => { release = resolve; }); state.returnedId = idB;
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(page.getByText(/새 실행 화면을 준비하고 있습니다/)).toBeVisible(); await expect(image).toHaveAttribute('data-session', idA);
  await expect(page.getByRole('button', { name: '미리보기 적용' })).toBeDisabled();
  release(); state.holdCreate = null;
  await expect(image).toHaveAttribute('data-session', idB); await expect.poll(() => state.deleted).toContain(idA);
  expect(state.posts[1].previousSessionId).toBe(idA); expect(state.posts[1].source.workspace.files['App.tsx']).toBe(edited);
  state.failCreate = true; await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('React 원문').fill(`${edited}\n// 아직 저장하지 않은 변경`);
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(page.getByRole('region', { name: '격리된 React 실행 화면' }).getByRole('alert')).toContainText('완성하지 못했습니다');
  await expect(image).toHaveAttribute('data-session', idB); expect(state.deleted).not.toContain(idB);
  await expect(page.getByLabel('React 원문')).toHaveValue(`${edited}\n// 아직 저장하지 않은 변경`);
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('outdated frames cannot roll back pixels or evidence; failed input preserves its text and requires a fresh check', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '미리보기 적용' }).click();
  const image = page.getByTestId('remote-react-frame'); await expect(image).toHaveAttribute('data-sequence', '1');
  state.sequence = 3; await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect(image).toHaveAttribute('data-sequence', '3');
  await expect(page.getByRole('region', { name: '계산 근거', exact: true })).toContainText('730원');
  state.eventSequence = 2; await image.click({ position: { x: 30, y: 20 } }); await expect.poll(() => state.events.length).toBe(1);
  await expect(image).toHaveAttribute('data-sequence', '3'); expect(state.events[0].type).toBe('click'); expect(state.events[0].x).toBeGreaterThan(0); expect(state.events[0].x).toBeLessThan(1100);
  state.eventSequence = 4; await page.getByRole('button', { name: '아래로 이동' }).click(); await expect(image).toHaveAttribute('data-sequence', '4');
  expect(state.events[1]).toEqual({ type: 'scroll', deltaX: 0, deltaY: 500 });
  await page.getByLabel('선택한 입력칸에 보낼 글자').fill('유지할 입력'); state.failEvent = true;
  await page.getByRole('button', { name: '입력 보내기' }).click();
  await expect(page.getByRole('region', { name: '격리된 React 실행 화면' }).getByRole('alert')).toContainText('마지막 정상 화면');
  await expect(page.getByLabel('선택한 입력칸에 보낼 글자')).toHaveValue('유지할 입력'); await expect(page.getByLabel('선택한 입력칸에 보낼 글자')).toBeDisabled();
  await expect(page.getByRole('region', { name: '계산 근거', exact: true })).toHaveCount(0);
  state.sequence = 6; state.failEvent = false;
  await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect(image).toHaveAttribute('data-sequence', '6');
  await expect(page.getByLabel('선택한 입력칸에 보낼 글자')).toBeEnabled(); await expect(page.getByRole('region', { name: '계산 근거', exact: true })).toContainText('730원');
  await expect(page.getByLabel('React 원문')).toHaveValue(source);
});

test('a candidate completed after leaving the editor is closed instead of being displayed', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect(page.getByTestId('remote-react-frame')).toHaveAttribute('data-session', idA);
  let release: () => void = () => {}; state.holdCreate = new Promise<void>((resolve) => { release = resolve; }); state.returnedId = idC;
  await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect(page.getByText(/새 실행 화면을 준비하고 있습니다/)).toBeVisible();
  await page.getByRole('button', { name: '새 화면', exact: true }).click(); await expect(page.getByTestId('remote-react-frame')).toHaveCount(0);
  release(); await expect.poll(() => state.deleted).toContain(idC); expect(state.deleted).toContain(idA);
  await expect(page.getByTestId('remote-react-frame')).toHaveCount(0); await expect(page.getByLabel('React 원문')).toHaveValue(source);
});


test('an invalid candidate image is refused and closed without replacing the decoded last good frame', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '미리보기 적용' }).click();
  const image = page.getByTestId('remote-react-frame'); await expect(image).toHaveAttribute('data-session', idA);
  const originalPixels = await image.getAttribute('src');
  state.returnedId = idB; state.png = 'https://untrusted.invalid/image.png';
  await page.getByRole('button', { name: '미리보기 적용' }).click();
  await expect(page.getByRole('region', { name: '격리된 React 실행 화면' }).getByRole('alert')).toContainText('이미지와 버전');
  await expect(image).toHaveAttribute('data-session', idA); await expect(image).toHaveAttribute('src', originalPixels!);
  await expect.poll(() => state.deleted).toContain(idB); expect(state.deleted).not.toContain(idA);
});


test('a permission failure hides the previous pixels and evidence and retires the live session', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '미리보기 적용' }).click();
  const image = page.getByTestId('remote-react-frame'); await expect(image).toHaveAttribute('data-session', idA);
  state.sequence = 3; await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect(image).toHaveAttribute('data-sequence', '3');
  await expect(page.getByRole('region', { name: '계산 근거', exact: true })).toContainText('730원');
  state.failEvent = true; state.eventFailureStatus = 403; await page.getByRole('button', { name: '아래로 이동' }).click();
  await expect(page.getByRole('alert')).toContainText('조회 권한을 확인하지 못해 실행 화면과 계산 근거를 숨겼습니다');
  await expect(image).toHaveCount(0); await expect(page.getByRole('region', { name: '계산 근거', exact: true })).toHaveCount(0);
  await expect.poll(() => state.deleted).toContain(idA); await expect(page.getByLabel('React 원문')).toHaveValue(source);
});

test('editing the title during candidate creation rejects its commit and keeps the previous remote session', async ({ page }) => {
  const state = await setup(page); await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect(page.getByTestId('remote-react-frame')).toHaveAttribute('data-session', idA);
  let release!: () => void; state.holdCreate = new Promise<void>(resolve => { release = resolve; }); state.returnedId = idB;
  await page.getByRole('button', { name: '미리보기 적용' }).click(); await expect.poll(() => state.posts.length).toBe(2);
  await page.getByRole('button', { name: '원문·파일', exact: true }).click(); await page.getByLabel('화면 제목').fill('실행 준비 중 바꾼 제목'); release();
  await expect.poll(() => state.deleted.includes(idB)).toBe(true); expect(state.deleted).not.toContain(idA);
  await page.getByRole('button', { name: '미리보기', exact: true }).click(); await expect(page.getByTestId('remote-react-frame')).toHaveAttribute('data-session', idA);
  await expect(page.getByRole('button', { name: '미리보기 적용' })).toBeEnabled();
});

test('unsupported DOM candidates preserve the previous session and initial fallback is read-only', async ({page}) => {
  const state=await setup(page);state.unsupported=true;await page.getByRole('button',{name:'미리보기 적용'}).click();
  await expect(page.getByRole('alert')).toContainText('확인용 이미지');await expect(page.getByLabel('선택한 입력칸에 보낼 글자')).toBeDisabled();await page.getByTestId('remote-react-frame').click();expect(state.events).toHaveLength(0);
  state.unsupported=false;state.returnedId=idB;await page.getByRole('button',{name:'미리보기 적용'}).click();await expect(page.getByTestId('remote-react-frame')).toHaveAttribute('data-session',idB);
  state.unsupported=true;state.returnedId=idC;await page.getByRole('button',{name:'미리보기 적용'}).click();await expect(page.getByRole('region',{name:'격리된 React 실행 화면'}).getByRole('alert')).toContainText('이전 정상 화면을 유지');await expect(page.getByTestId('remote-react-frame')).toHaveAttribute('data-session',idB);await expect.poll(()=>state.deleted).toContain(idC);expect(state.deleted).not.toContain(idB);
});
