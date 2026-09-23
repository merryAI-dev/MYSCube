import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { analyticsError } from './analytics-contract.mjs';
export { getReactPackageSet, REACT_RUNTIME_VERSION } from './react-compiler-packages.mjs';

let active = 0;
export async function compileReactPreview({ title, code } = {}, { signal, timeoutMs = 3000 } = {}) {
  if (typeof title !== 'string' || !title.trim() || title.length > 80 || typeof code !== 'string' || !code.trim() || code.length > 160000 || Buffer.byteLength(code) > 180000) throw analyticsError(400, 'react_source_invalid', '제목은 80자, React 소스는 160,000자와 180KB 이내로 작성해 주세요.');
  if (signal?.aborted) throw analyticsError(499, 'react_compile_cancelled', '미리보기 만들기가 취소되었습니다.');
  if (active >= 1) throw analyticsError(429, 'react_compile_busy', '다른 React 화면을 만들고 있습니다. 잠시 후 다시 시도해 주세요.');
  active++;
  return new Promise((resolve, reject) => {
    let child; let timer; let done = false; let output = '';
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (child?.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} }
      active--; if (error) reject(error); else resolve(value);
    };
    const abort = () => finish(analyticsError(499, 'react_compile_cancelled', '미리보기 만들기가 취소되었습니다.'));
    try { child = spawn(process.execPath, ['--max-old-space-size=96', fileURLToPath(new URL('./react-compiler-worker.mjs', import.meta.url))], { env: { TZ: 'UTC', LANG: 'C.UTF-8' }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(analyticsError(503, 'react_compile_unavailable', '독립 컴파일 환경을 시작하지 못했습니다.')); return; }
    timer = setTimeout(() => finish(analyticsError(422, 'react_compile_timeout', 'React 화면을 만드는 시간이 한도를 넘었습니다. 화면 구성을 나누어 주세요.')), Math.max(1, Math.min(Number(timeoutMs) || 3000, 3000)));
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => finish(analyticsError(503, 'react_compile_unavailable', '독립 컴파일 환경을 시작하지 못했습니다.')));
    child.stdout.on('data', (chunk) => { output += chunk; if (Buffer.byteLength(output) > 400000) finish(analyticsError(413, 'react_bundle_too_large', '실행본이 저장 한도를 넘었습니다. 화면 구성을 나누어 주세요.')); });
    child.on('close', (status) => {
      if (done) return;
      let result; try { result = JSON.parse(output); } catch {}
      if (status !== 0 || !result?.ok) finish(analyticsError(422, 'react_compile_failed', `React 화면을 완성하지 못했습니다. ${String(result?.message || '컴파일 자원 한도를 확인해 주세요.').slice(0, 300)}`));
      else finish(null, result.artifact);
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ code }));
  });
}
