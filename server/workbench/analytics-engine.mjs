import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_LIMITS, analyticsError, jsonBytes } from './analytics-contract.mjs';

let active = 0;
export async function executeAnalyticsQuery(input, { signal, timeoutMs = ANALYTICS_LIMITS.timeoutMs } = {}) {
  if (signal?.aborted) throw analyticsError(499, 'analytics_query_cancelled', '분석 요청이 취소되었습니다.');
  if (active >= 1) throw analyticsError(429, 'analytics_query_busy', '다른 분석을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  if (jsonBytes(input) > ANALYTICS_LIMITS.queryBytes) throw analyticsError(413, 'analytics_query_too_large', '한 번에 분석할 수 있는 자료 6MB 한도를 넘었습니다. 자료 범위를 좁혀 주세요.');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ANALYTICS_LIMITS.timeoutMs) throw new Error('Invalid analytics deadline');
  active++;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--max-old-space-size=64', fileURLToPath(new URL('./analytics-worker.mjs', import.meta.url))], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { TZ: 'UTC', LANG: 'C.UTF-8' }, windowsHide: true,
    });
    let output = '';
    let outputBytes = 0;
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      child.kill('SIGKILL');
      if (error) reject(error); else resolve(result);
    };
    const cancel = () => finish(analyticsError(499, 'analytics_query_cancelled', '분석 요청이 취소되었습니다.'));
    const timer = setTimeout(() => finish(analyticsError(504, 'analytics_query_timeout', '분석 시간이 3초를 넘었습니다. 기간이나 자료 범위를 좁혀 다시 조회해 주세요.')), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > ANALYTICS_LIMITS.resultBytes + 30000) finish(analyticsError(413, 'analytics_result_too_large', '조회 결과가 너무 큽니다. 필요한 열이나 집계만 선택해 주세요.'));
      else output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => finish(analyticsError(503, 'analytics_engine_unavailable', '독립 분석 엔진을 시작하지 못했습니다. 기존 업무 화면은 계속 이용할 수 있습니다.')));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      active--;
      if (settled) return;
      try {
        const parsed = JSON.parse(output);
        if (!parsed.ok) finish(analyticsError(parsed.statusCode || 400, parsed.code || 'analytics_query_failed', parsed.message || '자료와 조회 내용을 확인해 주세요.'));
        else finish(null, parsed.result);
      } catch { finish(analyticsError(503, 'analytics_engine_failed', '독립 분석을 완료하지 못했습니다. 자료 범위를 좁혀 다시 시도해 주세요.')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
