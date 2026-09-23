import { REACT_RUNTIME_VERSION } from './react-compiler-packages.mjs';

function checkRuntimeOptions({ nonce, parentOrigin }) {
  if (typeof nonce !== 'string' || !/^[A-Za-z0-9+/_=-]{16,128}$/.test(nonce)) throw new Error('A runtime nonce is required.');
  const url = new URL(parentOrigin);
  if (!['https:', 'http:'].includes(url.protocol) || url.origin !== parentOrigin || url.username || url.password) throw new Error('An exact parent origin is required.');
}
export function reactRuntimeCsp({ nonce, parentOrigin }) {
  checkRuntimeOptions({ nonce, parentOrigin });
  return `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; font-src 'none'; media-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors ${parentOrigin}, script-src 'self' 'unsafe-inline'`;
}

function runtimeBootstrap(config) {
  'use strict';
  const channelId = new URLSearchParams(location.search).get('channel');
  const nonce = document.currentScript.nonce;
  const packages = globalThis.AXRReactPackages;
  let port; let connected = false; let failed = false; let initialized = false; let apiCount = 0;
  const pending = new Map(); const encoder = new TextEncoder();
  const byteLength = (value) => encoder.encode(JSON.stringify(value)).byteLength;
  const send = (message) => { if (port) port.postMessage({ ...message, channelId }); };
  const reportError = (message) => { failed = true; send({ type: 'error', message: String(message || 'React 화면 실행에 실패했습니다.').slice(0, 500) }); };
  const hash = async (value) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))), (byte) => byte.toString(16).padStart(2, '0')).join('');
  addEventListener('error', (event) => reportError(event.message));
  addEventListener('unhandledrejection', (event) => reportError(event.reason?.message || '화면 처리 중 오류가 발생했습니다.'));
  const callApi = (apiId, input = {}) => new Promise((resolve, reject) => {
    if (failed || !port || pending.size >= 8 || ++apiCount > 60 || typeof apiId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(apiId)) { reject(new Error('API 호출 범위 또는 횟수를 확인해 주세요.')); return; }
    let size; try { size = byteLength(input); } catch { reject(new Error('API 입력은 JSON으로 전달해 주세요.')); return; }
    if (size > 32768) { reject(new Error('API 입력은 32KB 이내로 전달해 주세요.')); return; }
    const requestId = crypto.randomUUID();
    const timeout = setTimeout(() => { pending.delete(requestId); reject(new Error('API 응답을 기다리는 시간이 한도를 넘었습니다.')); }, 12000);
    pending.set(requestId, { resolve, reject, timeout });
    send({ type: 'api-call', requestId, apiId, input });
  });
  Object.defineProperty(window, 'workbench', { value: Object.freeze({ callApi }), writable: false, configurable: false });
  async function render(artifact) {
    if (initialized) return; initialized = true;
    if (!packages?.React || !packages?.ReactDOMClient || artifact?.runtimeVersion !== config.runtimeVersion || artifact?.packageSetHash !== config.packageSetHash
      || typeof artifact.bundle !== 'string' || encoder.encode(artifact.bundle).byteLength > 240000 || typeof artifact.css !== 'string' || encoder.encode(artifact.css).byteLength > 80000
      || await hash(artifact.bundle) !== artifact.bundleHash || await hash(artifact.css) !== artifact.cssHash) throw new Error('React 실행본의 버전 또는 내용이 일치하지 않습니다.');
    const style = document.createElement('style'); style.textContent = artifact.css; document.head.append(style);
    const script = document.createElement('script'); script.nonce = nonce; script.textContent = artifact.bundle; document.head.append(script); script.remove();
    if (failed) return;
    const App = globalThis.AXRCompiledApp?.default;
    if (typeof App !== 'function' && typeof App !== 'object') throw new Error('기본으로 내보낸 React 화면이 없습니다.');
    const React = packages.React;
    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { error: false }; }
      static getDerivedStateFromError() { return { error: true }; }
      componentDidCatch(error) { reportError(error?.message); }
      render() { return this.state.error ? null : this.props.children; }
    }
    function Painted() {
      React.useEffect(() => { const ready = setTimeout(() => { if (!failed) send({ type: 'ready' }); }, 0); return () => clearTimeout(ready); }, []);
      return React.createElement(App);
    }
    packages.ReactDOMClient.createRoot(document.getElementById('root')).render(React.createElement(Boundary, null, React.createElement(Painted)));
  }
  addEventListener('message', (event) => {
    if (connected || event.source !== parent || event.origin !== config.parentOrigin || event.data?.type !== 'axr-react-connect' || event.data?.channelId !== channelId || event.ports.length !== 1) return;
    connected = true; port = event.ports[0];
    port.onmessage = (message) => {
      const data = message.data;
      if (data?.channelId !== channelId) return;
      if (data.type === 'api-result') {
        const request = pending.get(data.requestId); if (!request) return;
        pending.delete(data.requestId); clearTimeout(request.timeout);
        if (byteLength(data) > 262144) request.reject(new Error('API 응답 크기가 한도를 넘었습니다.'));
        else if (!data.ok) request.reject(new Error(String(data.message || 'API 요청을 완료하지 못했습니다.').slice(0, 500)));
        else request.resolve(data.result);
      }
    };
    port.start(); void render(event.data.artifact).catch((error) => reportError(error.message));
  });
  addEventListener('pagehide', () => { port?.close(); for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('미리보기가 종료되었습니다.')); } pending.clear(); });
  parent.postMessage({ type: 'axr-react-runtime-ready', channelId }, config.parentOrigin);
}

export function createReactRuntimeDocument({ nonce, parentOrigin, packageSetHash }) {
  checkRuntimeOptions({ nonce, parentOrigin });
  if (!/^[a-f0-9]{64}$/.test(packageSetHash)) throw new Error('A pinned package set is required.');
  const config = JSON.stringify({ parentOrigin, packageSetHash, runtimeVersion: REACT_RUNTIME_VERSION }).replaceAll('<', '\\u003c');
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>React 미리보기 실행 공간</title><script nonce="${nonce}" src="/packages/${packageSetHash}.js" crossorigin="anonymous" referrerpolicy="no-referrer"></script></head><body><div id="root"></div><script nonce="${nonce}">(${runtimeBootstrap.toString()})(${config});</script></body></html>`;
}
