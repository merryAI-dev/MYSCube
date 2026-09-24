import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { analyticsError } from './analytics-contract.mjs';
import { ReactSourceSchema, ReactDiagnosticSchema, ReactCompiledArtifactSchema, MAX_REACT_DIAGNOSTICS, normalizeReactSource, canonicalWorkspace, reactSourceIdentity } from '../../shared/workbench-react-workspace.mjs';
export { getReactPackageSet, REACT_RUNTIME_VERSION } from './react-compiler-packages.mjs';

let active = 0;
const hash = (value) => createHash('sha256').update(value).digest('hex');
/** @returns {Promise<import('zod/v4').infer<typeof ReactCompiledArtifactSchema>>} */
export async function compileReactPreview(source, { signal, timeoutMs = 8000, apis = [] } = {}) {
  let parsed;
  try { parsed = ReactSourceSchema.parse(source); normalizeReactSource(parsed); } catch { throw analyticsError(400, 'react_source_invalid', '제목은 80자, React 파일은 32개와 전체 180KB 이내로 작성해 주세요. 파일 경로와 시작 파일도 확인해 주세요.'); }
  if (!Array.isArray(apis) || apis.length > 12 || Buffer.byteLength(JSON.stringify(apis)) > 256000) throw analyticsError(400, 'react_api_types_invalid', '연결 API의 입력·응답 형식을 확인해 주세요.');
  if (signal?.aborted) throw analyticsError(499, 'react_compile_cancelled', '미리보기 만들기가 취소되었습니다.');
  if (active >= 1) throw analyticsError(429, 'react_compile_busy', '다른 React 화면을 만들고 있습니다. 잠시 후 다시 시도해 주세요.');
  active++;
  return new Promise((resolve, reject) => {
    let child; let timer; let done = false; let output = ''; let failure;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      active--; if (error) reject(error); else resolve(value);
    };
    const stop = (error) => {
      if (done || failure) return; failure = error;
      if (child?.pid) { try { process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch {} }
    };
    const abort = () => stop(analyticsError(499, 'react_compile_cancelled', '미리보기 만들기가 취소되었습니다.'));
    try { child = spawn(process.execPath, ['--max-old-space-size=256', fileURLToPath(new URL('./react-compiler-worker.mjs', import.meta.url))], { env: { TZ: 'UTC', LANG: 'C.UTF-8' }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] }); }
    catch { finish(analyticsError(503, 'react_compile_unavailable', '독립 컴파일 환경을 시작하지 못했습니다.')); return; }
    timer = setTimeout(() => stop(analyticsError(422, 'react_compile_timeout', 'React 타입 검사와 화면 만들기가 8초 이내의 실행 한도를 넘었습니다. 화면 구성을 나누어 주세요.')), Math.max(1, Math.min(Number(timeoutMs) || 8000, 8000)));
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', () => stop(analyticsError(503, 'react_compile_unavailable', '독립 컴파일 환경을 시작하지 못했습니다.')));
    child.stdout.on('data', (chunk) => { if (failure) return; output += chunk; if (Buffer.byteLength(output) > 400000) stop(analyticsError(413, 'react_bundle_too_large', '실행본이 저장 한도를 넘었습니다. 화면 구성을 나누어 주세요.')); });
    child.on('close', (status) => {
      if (done) return;
      if (failure) { finish(failure); return; }
      let result; try { result = JSON.parse(output); } catch {}
      if (status !== 0 || !result?.ok) {
        const error = analyticsError(422, 'react_compile_failed', `React 화면을 완성하지 못했습니다. ${String(result?.message || '컴파일 자원 한도를 확인해 주세요.').slice(0, 300)}`);
        const diagnostics = ReactDiagnosticSchema.array().max(MAX_REACT_DIAGNOSTICS).safeParse(result?.details?.diagnostics);
        if (diagnostics.success && ['policy', 'type', 'bundle'].includes(result.details.stage)) error.details = { stage: result.details.stage, diagnostics: diagnostics.data, truncated: result.details.truncated === true };
        finish(error);
      }
      else {
        const artifact = ReactCompiledArtifactSchema.safeParse(result.artifact);
        if (!artifact.success || artifact.data.sourceHash !== hash(reactSourceIdentity(parsed))
          || artifact.data.workspaceHash !== hash(canonicalWorkspace(normalizeReactSource(parsed).workspace))
          || artifact.data.bundleHash !== hash(artifact.data.bundle) || artifact.data.cssHash !== hash(artifact.data.css)) finish(analyticsError(422, 'react_compile_artifact_invalid', '컴파일 실행본의 버전과 검사 결과를 확인하지 못했습니다. 기존 화면은 유지합니다.'));
        else finish(null, artifact.data);
      }
    });
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify({ source: parsed, apis }));
    if (signal?.aborted) abort();
  });
}
