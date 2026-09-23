import { createHash } from 'node:crypto';

export const REMOTE_RUNTIME_IMAGE = 'myscube-axr-renderer:1.58.2-v1';
export const REMOTE_LIMITS = Object.freeze({ ttlMs: 300000, commandMs: 8000, apiMs: 10000, inputBytes: 400000, outputBytes: 900000, totalOutputBytes: 50000000, commands: 600, apiCalls: 60, pendingApi: 8, sessions: 4, actorSessions: 1 });
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function remoteError(code, message, statusCode = 400) { return Object.assign(new Error(message), { code, statusCode, expose: true }); }
export function checkArtifact(value) {
  if (!value || typeof value.bundle !== 'string' || Buffer.byteLength(value.bundle) > 240000 || typeof value.css !== 'string' || Buffer.byteLength(value.css) > 80000
    || value.bundleHash !== digest(value.bundle) || value.cssHash !== digest(value.css) || !/^[a-f0-9]{64}$/.test(value.packageSetHash || '') || value.runtimeVersion !== 'react-preview-v1') throw remoteError('remote_artifact_invalid', '저장된 React 실행본의 버전과 검증값을 확인해 주세요.');
  return { bundle: value.bundle, css: value.css, bundleHash: value.bundleHash, cssHash: value.cssHash, packageSetHash: value.packageSetHash, runtimeVersion: value.runtimeVersion };
}
export function checkViewport(value = { width: 1280, height: 720 }) {
  if (!value || !Number.isSafeInteger(value.width) || !Number.isSafeInteger(value.height) || value.width < 320 || value.width > 1600 || value.height < 240 || value.height > 1200) throw remoteError('remote_viewport_invalid', '미리보기 크기는 가로 320~1600, 세로 240~1200 범위로 선택해 주세요.');
  return { width: value.width, height: value.height };
}
export function checkEvent(value, viewport) {
  if (!value || !['click', 'type', 'key', 'scroll'].includes(value.type)) throw remoteError('remote_event_invalid', '지원하지 않는 화면 조작입니다.');
  const allowed = value.type === 'click' ? ['type', 'x', 'y'] : value.type === 'type' ? ['type', 'text'] : value.type === 'key' ? ['type', 'key'] : ['type', 'deltaX', 'deltaY'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw remoteError('remote_event_invalid', '화면 조작 항목을 확인해 주세요.');
  if (value.type === 'click' && (![value.x, value.y].every(Number.isFinite) || value.x < 0 || value.y < 0 || value.x >= viewport.width || value.y >= viewport.height)) throw remoteError('remote_event_invalid', '화면 안의 위치를 선택해 주세요.');
  if (value.type === 'type' && (typeof value.text !== 'string' || value.text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value.text))) throw remoteError('remote_event_invalid', '입력 내용을 2,000자 이내로 확인해 주세요.');
  if (value.type === 'key' && !['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(value.key)) throw remoteError('remote_event_invalid', '지원하지 않는 키 입력입니다.');
  if (value.type === 'scroll' && (![value.deltaX, value.deltaY].every(Number.isFinite) || Math.abs(value.deltaX) > 3000 || Math.abs(value.deltaY) > 3000)) throw remoteError('remote_event_invalid', '스크롤 범위를 확인해 주세요.');
  return value;
}
export function dockerRunArguments(name) {
  if (!/^axr-render-[a-f0-9-]{36}$/.test(name)) throw new Error('Invalid container name');
  return ['run', '--pull=never', '--rm', '-i', '--name', name, '--network', 'none', '--memory', '512m', '--memory-swap', '512m', '--cpus', '1', '--pids-limit', '128',
    '--user', '10001:10001', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=128m', '--tmpfs', '/dev/shm:rw,noexec,nosuid,size=128m',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--init', '--log-driver', 'none', REMOTE_RUNTIME_IMAGE];
}
