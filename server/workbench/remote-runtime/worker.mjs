import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright';
import { createDomSnapshot } from './dom-snapshot.mjs';
import { createDomEvents, checkDomEvent } from './dom-events.mjs';
import { checkArtifact, checkEvent, checkViewport, REMOTE_LIMITS } from './contract.mjs';

export async function runRendererWorker({ input = process.stdin, output = process.stdout, packageFile = new URL('./packages.json', import.meta.url), launch = (options) => chromium.launch(options) } = {}) {
  const packages = JSON.parse(await readFile(packageFile, 'utf8'));
  let browser, page, viewport, initialized = false, rendering = false, closed = false, requests = 0, sequence = 0, commands = 0, inFlight = 0;
  const pending = new Map(); let inputTotal = 0;
  let viewMode = 'png', dom, domEvents, domFrame, sessionId, sourceHash; const documentEpoch = randomUUID();
  const send = (value) => { const line = JSON.stringify(value); if (Buffer.byteLength(line) > REMOTE_LIMITS.outputBytes) throw new Error('output_limit'); if (!closed) { if (output.writableLength + Buffer.byteLength(line) > REMOTE_LIMITS.outputBytes * 2) throw new Error('output_backpressure'); output.write(`${line}\n`); } };
  const stop = async () => { if (closed) return; closed = true; clearTimeout(ttl); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('실행 공간이 종료되었습니다.')); } pending.clear(); await browser?.close().catch(() => {}); reader.close(); };
  const ttl = setTimeout(() => { void stop(); }, REMOTE_LIMITS.ttlMs); ttl.unref();
  const screenshot = async (requestId, ack = null) => {
    let unsupported;
    if (viewMode === 'dom') {
      const captured = await dom.capture(ack);
      if (captured.snapshot) {
        domFrame = { kind: 'dom', sessionId, sourceHash, documentEpoch, sequence: ++sequence, width: viewport.width, height: viewport.height, snapshot: captured.snapshot };
        send({ type: 'frame', requestId, ...domFrame }); return;
      }
      unsupported = captured.unsupported; domFrame = null;
    }
    const png = await page.screenshot({ type: 'png', timeout: 5000, animations: 'disabled' });
    send({ type: 'frame', requestId, sequence: ++sequence, width: viewport.width, height: viewport.height, pngBase64: png.toString('base64'), ...(unsupported ? { kind: 'png', sessionId, sourceHash, documentEpoch, unsupported } : {}) });
  };
  const init = async (message) => {
    if (initialized) throw new Error('already_initialized'); initialized = true;
    const artifact = checkArtifact(message.artifact); viewport = checkViewport(message.viewport);
    if (message.viewMode !== undefined && !['png', 'dom'].includes(message.viewMode)) throw new Error('view_mode_invalid');
    viewMode = message.viewMode || 'png';
    if (viewMode === 'dom') {
      if (!/^[a-f0-9-]{36}$/.test(message.sessionId || '') || !/^[a-f0-9]{64}$/.test(message.sourceHash || '')) throw new Error('dom_identity_invalid');
      sessionId = message.sessionId; sourceHash = message.sourceHash;
    }
    if (artifact.packageSetHash !== packages.packageSetHash) throw new Error('package_set_mismatch');
    browser = await launch({ headless: true, chromiumSandbox: false, args: ['--disable-dev-shm-usage', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--no-first-run', '--disable-extensions', '--disable-features=MediaRouter'] });
    const context = await browser.newContext({ viewport, acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: true });
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    context.on('page', (opened) => { if (page && opened !== page) void opened.close(); });
    page = await context.newPage(); page.setDefaultTimeout(3000);
    page.on('dialog', dialog => void dialog.dismiss()); page.on('download', download => void download.cancel());
    page.on('pageerror', (reason) => { try { send({ type: 'runtime-error', message: String(reason.message).slice(0, 500) }); } catch { void stop(); } });
    await page.exposeBinding('__axrReadApi', async (_source, apiId, body) => {
      if (closed || ++requests > REMOTE_LIMITS.apiCalls || pending.size >= REMOTE_LIMITS.pendingApi || typeof apiId !== 'string' || apiId.length > 100 || !body || typeof body !== 'object' || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 32768) throw new Error('API 요청 범위 또는 횟수를 확인해 주세요.');
      const requestId = randomUUID();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('API 응답 시간이 지났습니다.')); }, REMOTE_LIMITS.apiMs);
        pending.set(requestId, { resolve, reject, timer });
        try { send({ type: 'api-call', requestId, apiId, input: body }); } catch (error) { clearTimeout(timer); pending.delete(requestId); reject(error); void stop(); }
      });
    });
    const nonce = randomUUID();
    await page.setContent(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"></head><body><div id="root"></div></body></html>`);
    if (viewMode === 'dom') {
      const cdp = await context.newCDPSession(page), { root } = await cdp.send('DOM.getDocument');
      const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#root' });
      const { node } = await cdp.send('DOM.describeNode', { nodeId });
      const { frameTree } = await cdp.send('Page.getFrameTree');
      dom = await createDomSnapshot({ cdp, frameId: frameTree.frame.id, rootBackendNodeId: node.backendNodeId });
      domEvents = await createDomEvents({ dom, page });
    }
    await page.evaluate(({ source, nonce }) => { const script = document.createElement('script'); script.nonce = nonce; script.textContent = source; document.head.append(script); }, { source: packages.bundle, nonce });
    await page.evaluate(({ artifact, nonce }) => {
      Object.defineProperty(window, 'workbench', { value: Object.freeze({ callApi: (apiId, input = {}) => window.__axrReadApi(apiId, input) }), writable: false, configurable: false });
      const style = document.createElement('style'); style.textContent = artifact.css; document.head.append(style);
      const script = document.createElement('script'); script.nonce = nonce; script.textContent = artifact.bundle; document.head.append(script);
      const { React, ReactDOMClient } = window.AXRReactPackages;
      const App = window.AXRCompiledApp?.default;
      if (!App) throw new Error('React 기본 화면이 없습니다.');
      ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(App));
    }, { artifact, nonce });
    await page.locator('#root').waitFor({ state: 'attached' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await screenshot(message.requestId);
  };
  const command = async (message) => {
    if (message.type === 'api-result') {
      const waiting = pending.get(message.requestId); if (!waiting) return;
      pending.delete(message.requestId); clearTimeout(waiting.timer);
      if (message.ok && Buffer.byteLength(JSON.stringify(message.result)) <= 256000) waiting.resolve(message.result);
      else waiting.reject(new Error(String(message.message || 'API 조회 실패').slice(0, 500)));
      return;
    }
    if (++commands > REMOTE_LIMITS.commands) throw new Error('command_limit');
    if (message.type === 'close') { await stop(); return; }
    if (rendering) throw new Error('command_busy'); rendering = true;
    try {
      if (message.type === 'init') await init(message);
      else if (message.type === 'frame' && initialized) await screenshot(message.requestId);
      else if (message.type === 'event' && initialized) {
        const event = viewMode === 'dom' ? checkDomEvent(message.event, domFrame) : checkEvent(message.event, viewport);
        if (viewMode === 'dom') await domEvents.apply(event);
        else if (event.type === 'click') await page.mouse.click(event.x, event.y);
        else if (event.type === 'type') await page.keyboard.insertText(event.text);
        else if (event.type === 'key') await page.keyboard.press(event.key);
        else await page.mouse.wheel(event.deltaX, event.deltaY);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
        await screenshot(message.requestId, viewMode === 'dom' ? { eventId: event.eventId, ...(event.inputRevision ? { inputRevision: event.inputRevision } : {}) } : null);
      } else throw new Error('unknown_command');
    } finally { rendering = false; }
  };
  const reader = createInterface({ input, crlfDelay: Infinity });
  input.on('data', chunk => { inputTotal += chunk.length; if (chunk.length > REMOTE_LIMITS.inputBytes || inputTotal > 8000000) void stop(); });
  reader.on('line', (line) => {
    if (closed) return;
    if (Buffer.byteLength(line) > REMOTE_LIMITS.inputBytes || ++inFlight > 16) { void stop(); return; }
    let message;
    try { message = JSON.parse(line); if (!message || typeof message.requestId !== 'string' || message.requestId.length > 100) throw new Error('invalid_message'); }
    catch { void stop(); return; }
    void command(message).catch(async (error) => { if (viewMode === 'dom' && error.statusCode === 409) { send({ type: 'error', requestId: message.requestId, code: error.code, recoverable: true, message: String(error.message).slice(0, 200) }); return; }
      try { send({ type: 'error', requestId: message.requestId, message: String(error.message || '실행 오류').slice(0, 500) }); } finally { await stop(); } }).finally(() => { inFlight--; });
  });
  reader.once('close', () => { void stop(); });
  return { close: stop };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runRendererWorker().catch(() => { process.exitCode = 1; });
}
