import { test, expect, type Page } from '@playwright/test';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { createRemoteRuntimeBroker } from '../server/workbench/remote-runtime/broker.mjs';
import { digest } from '../server/workbench/remote-runtime/contract.mjs';

const nodeId = (value: number) => `n_${String(value).padStart(24, '0')}`;
async function mount(page: Page) {
  const state = { hold: '', held: [] as Array<() => void>, commands: [] as string[], posts: [] as string[], failures: [] as string[], denied: false, failEvent: false, failCreate: false, label: 'A' };
  const context = { tenantId: 'candidate-race', actorId: 'synthetic-admin', analyticsScope: { fingerprint: 'synthetic-scope' } };
  const broker = createRemoteRuntimeBroker({ authorize: async () => { if (state.denied) throw Object.assign(new Error('조회 권한이 바뀌었습니다.'), { statusCode: 403 }); }, callApi: async () => ({}), spawnDocker: (args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; stdin: Writable; kill: () => boolean };
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => { queueMicrotask(() => child.emit('close', 0)); return true; };
    let sequence = 0, sessionId = '', sourceHash = '', width = 1100, height = 700, value = '', selected = 'a', checked = false, title = state.label;
    const epoch = crypto.randomUUID();
    child.stdin = new Writable({ write(bytes, _encoding, done) {
      const message = JSON.parse(bytes.toString());
      if (message.type === 'init') { sessionId = message.sessionId; sourceHash = message.sourceHash; width = message.viewport.width; height = message.viewport.height; }
      const type = message.event?.type || message.type; state.commands.push(type);
      const emit = () => {
        if (type === 'input') value = message.event.value;
        if (type === 'select') selected = message.event.values[0];
        if (type === 'check') checked = message.event.checked;
        if (type === 'resize') { width = message.event.width; height = message.event.height; }
        sequence++;
        const element = (id: number, parent: number | null, tag: string, attributes: object = {}, extra: object = {}) => ({ id: nodeId(id), parentId: parent === null ? null : nodeId(parent), kind: 'element', tag, attributes: { id: nodeId(id), ...attributes }, style: {}, ...extra });
        const text = (id: number, parent: number, text: string) => ({ id: nodeId(id), parentId: nodeId(parent), kind: 'text', text });
        const frame = { type: 'frame', requestId: message.requestId, kind: 'dom', sessionId, sourceHash, documentEpoch: epoch, sequence, width, height, snapshot: { schemaVersion: 1, revision: sequence, rootNodeId: nodeId(1), focusedNodeId: null, ack: message.event ? { eventId: message.event.eventId, ...(message.event.inputRevision ? { inputRevision: message.event.inputRevision } : {}) } : null,
          nodes: [element(1, null, 'main'), element(2, 1, 'h1'), text(3, 2, title), element(4, 1, 'input', { 'aria-label': '작성 중인 값', type: 'text' }, { control: { type: 'text', value, checked: false, selectedValues: [], disabled: false, readOnly: false, selectionStart: value.length, selectionEnd: value.length } }),
            element(5, 1, 'select', { 'aria-label': '조회 종류' }, { control: { type: 'select', value: selected, checked: false, selectedValues: [selected], disabled: false, readOnly: false, selectionStart: null, selectionEnd: null } }),
            element(6, 5, 'option', { value: 'a' }), text(7, 6, '전체'), element(8, 5, 'option', { value: 'b' }), text(9, 8, '선택'),
            element(10, 1, 'input', { 'aria-label': '활성 항목', type: 'checkbox' }, { control: { type: 'checkbox', value: 'on', checked, selectedValues: [], disabled: false, readOnly: false, selectionStart: null, selectionEnd: null } })] } };
        child.stdout.write(`${JSON.stringify(frame)}\n`);
      };
      if (state.hold === type) state.held.push(emit); else queueMicrotask(emit);
      done();
    } });
    if (args[0] !== 'run') queueMicrotask(() => child.emit('close', 0));
    return child;
  } });
  await page.route('**/api/v1/react-work-pages/remote**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const reply = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    try {
      if (path.endsWith('/remote')) {
        const body = request.postDataJSON(); state.posts.push(body.source.title); state.label = body.source.title;
        if (state.failCreate) return reply({ message: '후보 실행 실패' }, 422);
        const artifact = { bundle: 'window.AXRCompiledApp={default(){return null}}', css: '', sourceHash: digest(body.source.title), packageSetHash: 'b'.repeat(64), runtimeVersion: 'react-preview-v1', bundleHash: '', cssHash: digest('') }; artifact.bundleHash = digest(artifact.bundle);
        return reply({ ...await broker.create(context, { artifact, sourceHash: artifact.sourceHash, apiBindings: [], viewMode: 'dom', viewport: body.viewport, previousSessionId: body.previousSessionId }), evidence: {} });
      }
      const parts = path.split('/'), event = parts.at(-1) === 'events', id = parts.at(event ? -2 : -1)!;
      if (request.method() === 'DELETE') return reply(await broker.close(context, id).catch(() => ({ closed: true })));
      if (event && state.failEvent) return reply({ message: '입력 응답을 확인하지 못했습니다.' }, 503);
      const frame = event ? await broker.event(context, id, request.postDataJSON()) : await broker.frame(context, id);
      return reply({ sessionId: id, frame, evidence: {} });
    } catch (error) {
      const reason = error as { statusCode?: number; code?: string; message: string };
      state.failures.push(reason.code || 'unknown'); return reply({ error: reason.code, message: reason.message }, reason.statusCode || 503);
    }
  });
  await page.route('**/candidate-drain-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="fixture"></div>' }));
  await page.goto('/candidate-drain-fixture');
  await page.evaluate(async () => {
    const RefreshRuntime = await import('/@react-refresh' as string); RefreshRuntime.default.injectIntoGlobalHook(window); (window as any).$RefreshReg$ = () => {}; (window as any).$RefreshSig$ = () => (type: unknown) => type;
    const main = await (await fetch('/main.tsx')).text();
    const React = (await import(main.match(/from "([^"]+\/react\.js[^"]*)"/)![1])).default, ReactDOM = (await import(main.match(/from "([^"]+\/react-dom_client\.js[^"]*)"/)![1])).default;
    const { RemoteReactPreview } = await import('/RemoteReactPreview.tsx' as string);
    const win = window as any, root = ReactDOM.createRoot(document.getElementById('fixture')); let key = 0;
    win.candidateResults = []; win.changeCandidate = (title: string | null) => root.render(React.createElement(RemoteReactPreview, { draft: title === null ? null : { key: ++key, source: { title, code: 'export default function App(){return null}' }, apis: [] }, onResult: (value: unknown) => win.candidateResults.push(value) }));
    win.changeCandidate('A');
  });
  await expect(page.frameLocator('iframe').getByRole('heading', { name: 'A', exact: true })).toBeVisible();
  return { state, broker, change: (title: string | null) => page.evaluate(value => (window as any).changeCandidate(value), title), release: () => { state.hold = ''; for (const emit of state.held.splice(0)) emit(); } };
}

test('candidate waits for an actual broker pending poll before create, without weakening previous-session guard', async ({ page }, testInfo) => {
  const f = await mount(page);
  try {
    f.state.hold = 'frame'; await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect.poll(() => f.state.held.length).toBe(1);
    await f.change('B'); await page.waitForTimeout(150);
    await testInfo.attach('actual-broker-pending-state', { body: JSON.stringify({ posts: f.state.posts, failures: f.state.failures, held: f.state.held.length }), contentType: 'application/json' });
    expect(f.state.failures).toEqual([]); expect(f.state.posts).toEqual(['A']); await expect(page.getByText(/새 실행 화면을 준비/)).toBeVisible();
    await expect(page.getByTestId('remote-dom-frame')).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.type('blocked');
    await expect(page.frameLocator('iframe').getByLabel('작성 중인 값')).toHaveValue(''); expect(f.state.commands).not.toContain('input');
    f.release(); await expect(page.frameLocator('iframe').getByRole('heading', { name: 'B', exact: true })).toBeVisible();
    expect(f.state.posts).toEqual(['A', 'B']); expect(f.state.failures).toEqual([]);
  } finally { f.release(); f.broker.shutdown(); }
});

test('queued input and IME explicitly defer replacement while preserving drafts and ACK order', async ({ page }) => {
  const f = await mount(page), input = page.frameLocator('iframe').getByLabel('작성 중인 값');
  try {
    await input.focus(); await expect.poll(() => f.state.commands.filter(value => value === 'focus').length).toBe(1);
    f.state.hold = 'input'; await input.fill('first'); await expect.poll(() => f.state.held.length).toBe(1); await input.fill('second');
    await f.change('B'); await expect(page.getByRole('alert')).toContainText('입력을 마친 뒤'); expect(f.state.posts).toEqual(['A']); await expect(input).toHaveValue('second');
    f.release(); await expect.poll(() => f.state.commands.filter(value => value === 'input').length).toBe(2); await expect(input).toHaveValue('second');
    await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
    await expect.poll(() => f.state.commands.filter(value => value === 'composition').length).toBe(1);
    await f.change('C'); await expect(page.getByRole('alert')).toContainText('입력을 마친 뒤'); expect(f.state.posts).toEqual(['A']);
    await input.evaluate(element => element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    await expect.poll(() => f.state.commands.filter(value => value === 'composition').length).toBe(2);
    await f.change('D'); await expect(page.frameLocator('iframe').getByRole('heading', { name: 'D', exact: true })).toBeVisible();
    expect(f.state.posts).toEqual(['A', 'D']);
  } finally { f.release(); f.broker.shutdown(); }
});

test('resize drains before replacement; failed candidate resumes the last good session', async ({ page }) => {
  const f = await mount(page);
  try {
    f.state.hold = 'resize'; await page.setViewportSize({ width: 800, height: 900 }); await expect.poll(() => f.state.held.length).toBe(1);
    f.state.failCreate = true; await f.change('B'); await page.waitForTimeout(100); expect(f.state.posts).toEqual(['A']);
    f.release(); await expect(page.getByRole('alert')).toContainText('후보 실행 실패');
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'A', exact: true })).toBeVisible();
    const frames = f.state.commands.filter(value => value === 'frame').length;
    await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect.poll(() => f.state.commands.filter(value => value === 'frame').length).toBeGreaterThan(frames);
    await page.frameLocator('iframe').getByLabel('작성 중인 값').fill('kept'); await expect.poll(() => f.state.commands.filter(value => value === 'input').length).toBe(1);
  } finally { f.release(); f.broker.shutdown(); }
});

for (const operation of ['frame', 'resize']) test(`permission revocation during ${operation} drain discards the candidate and clears the old frame`, async ({ page }) => {
  const f = await mount(page);
  try {
    f.state.hold = operation;
    if (operation === 'resize') await page.setViewportSize({ width: 800, height: 900 });
    else await page.getByRole('button', { name: '실행 상태 다시 확인' }).click();
    await expect.poll(() => f.state.held.length).toBe(1);
    await f.change('B'); f.state.denied = true; f.release();
    await expect(page.getByTestId('remote-dom-frame')).toHaveCount(0); expect(f.state.posts).toEqual(['A']);
  } finally { f.release(); f.broker.shutdown(); }
});

test('only the latest waiting candidate is created; leaving cancels a waiting candidate', async ({ page }) => {
  const f = await mount(page);
  try {
    f.state.hold = 'frame'; await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect.poll(() => f.state.held.length).toBe(1);
    await f.change('B'); await f.change('C'); f.release();
    await expect(page.frameLocator('iframe').getByRole('heading', { name: 'C', exact: true })).toBeVisible(); expect(f.state.posts).toEqual(['A', 'C']);
    f.state.hold = 'frame'; await page.getByRole('button', { name: '실행 상태 다시 확인' }).click(); await expect.poll(() => f.state.held.length).toBe(1);
    await f.change('D'); await f.change(null); f.release(); await expect(page.getByTestId('remote-dom-frame')).toHaveCount(0);
    expect(f.state.posts).toEqual(['A', 'C']);
  } finally { f.release(); f.broker.shutdown(); }
});

test('manual resync remains available after failed focus and checks permission before draining into a candidate', async ({ page }) => {
  const f = await mount(page);
  try {
    f.state.failEvent = true; await page.frameLocator('iframe').getByLabel('작성 중인 값').focus();
    const resync = page.getByRole('button', { name: '원격 상태 다시 불러오기' }); await expect(resync).toBeEnabled();
    f.state.failEvent = false; f.state.hold = 'frame'; page.once('dialog', dialog => dialog.accept()); await resync.click();
    await expect.poll(() => f.state.held.length).toBe(1); await f.change('B');
    f.state.denied = true; f.release(); await expect(page.getByTestId('remote-dom-frame')).toHaveCount(0);
    expect(f.state.posts).toEqual(['A']);
  } finally { f.release(); f.broker.shutdown(); }
});

for (const label of ['작성 중인 값', '조회 종류', '활성 항목']) test(`candidate preparation blocks native editing of ${label} and failure preserves its value`, async ({ page }) => {
  const f = await mount(page), frame = page.frameLocator('iframe'), control = frame.getByLabel(label);
  try {
    await control.focus(); await expect.poll(() => f.state.commands.filter(value => value === 'focus').length).toBe(1);
    await expect(page.getByText('표의 글자를 선택하고 입력칸과 버튼을 직접 사용할 수 있습니다.')).toBeVisible();
    const box = await control.boundingBox(); expect(box).not.toBeNull();
    f.state.failCreate = true; f.state.hold = 'frame'; await page.getByRole('button', { name: '실행 상태 다시 확인' }).evaluate(element => element.click());
    await expect.poll(() => f.state.held.length).toBe(1); await f.change('B');
    await expect.poll(() => page.locator('iframe').evaluate((element: HTMLIFrameElement) => element.inert && element.contentDocument!.body.inert)).toBe(true);
    await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space'); await page.keyboard.type('blocked');
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Space');
    await expect(frame.getByLabel('작성 중인 값')).toHaveValue(''); await expect(frame.getByLabel('조회 종류')).toHaveValue('a'); await expect(frame.getByLabel('활성 항목')).not.toBeChecked();
    expect(f.state.commands.filter(value => ['input', 'select', 'check'].includes(value))).toEqual([]);
    f.release(); await expect(page.getByRole('alert')).toContainText('후보 실행 실패');
    await expect.poll(() => page.locator('iframe').evaluate((element: HTMLIFrameElement) => !element.inert && !element.contentDocument!.body.inert)).toBe(true);
    await expect(frame.getByLabel('작성 중인 값')).toHaveValue(''); await expect(frame.getByLabel('조회 종류')).toHaveValue('a'); await expect(frame.getByLabel('활성 항목')).not.toBeChecked();
  } finally { f.release(); f.broker.shutdown(); }
});
