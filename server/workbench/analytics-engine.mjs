import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ANALYTICS_LIMITS, analyticsError } from './analytics-contract.mjs';

export function createAnalyticsExecutor({ spawnWorker = spawn } = {}) {
  let active = null;
  const waiting = [];
  const busy = () => analyticsError(429, 'analytics_query_busy', '다른 분석을 처리하고 있습니다. 잠시 후 다시 시도해 주세요.');
  const cancelled = () => analyticsError(499, 'analytics_query_cancelled', '분석 요청이 취소되었습니다.');
  const timedOut = () => analyticsError(504, 'analytics_query_timeout', '분석 대기와 실행 시간이 3초를 넘었습니다. 기간이나 자료 범위를 좁혀 다시 조회해 주세요.');

  function finish(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.cancel);
    const index = waiting.indexOf(job);
    if (index !== -1) waiting.splice(index, 1);
    if (job.child && !job.closed) { try { job.child.kill('SIGKILL'); } catch {} }
    if (error) job.reject(error); else job.resolve(result);
  }
  function drain() {
    if (active) return;
    while (waiting.length) {
      const job = waiting.shift();
      if (job.settled) continue;
      if (job.signal?.aborted) { finish(job, cancelled()); continue; }
      if (performance.now() >= job.deadline) { finish(job, timedOut()); continue; }
      start(job); return;
    }
  }
  function start(job) {
    if (job.signal?.aborted) { finish(job, cancelled()); drain(); return; }
    if (performance.now() >= job.deadline) { finish(job, timedOut()); drain(); return; }
    active = job;
    try {
      job.child = spawnWorker(process.execPath, ['--max-old-space-size=64', fileURLToPath(new URL('./analytics-worker.mjs', import.meta.url))], {
        stdio: ['pipe', 'pipe', 'pipe'], env: { TZ: 'UTC', LANG: 'C.UTF-8' }, windowsHide: true,
      });
    } catch {
      active = null;
      finish(job, analyticsError(503, 'analytics_engine_unavailable', '독립 분석 엔진을 시작하지 못했습니다. 기존 업무 화면은 계속 이용할 수 있습니다.'));
      drain(); return;
    }
    let output = '', outputBytes = 0;
    job.child.stdout.setEncoding('utf8');
    job.child.stdout.on('data', (chunk) => {
      if (job.settled) return;
      outputBytes += Buffer.byteLength(chunk);
      if (outputBytes > ANALYTICS_LIMITS.resultBytes + 30000) finish(job, analyticsError(413, 'analytics_result_too_large', '조회 결과가 너무 큽니다. 필요한 열이나 집계만 선택해 주세요.'));
      else output += chunk;
    });
    job.child.stderr.resume();
    job.child.once('error', () => finish(job, analyticsError(503, 'analytics_engine_unavailable', '독립 분석 엔진을 시작하지 못했습니다. 기존 업무 화면은 계속 이용할 수 있습니다.')));
    job.child.stdin.on('error', () => finish(job, analyticsError(503, 'analytics_engine_unavailable', '독립 분석 엔진에 요청을 전달하지 못했습니다. 다시 조회해 주세요.')));
    job.child.once('close', () => {
      job.closed = true;
      if (!job.settled) {
        if (performance.now() >= job.deadline) finish(job, timedOut());
        else try {
          const parsed = JSON.parse(output);
          if (performance.now() >= job.deadline) finish(job, timedOut());
          else if (!parsed.ok) finish(job, analyticsError(parsed.statusCode || 400, parsed.code || 'analytics_query_failed', parsed.message || '자료와 조회 내용을 확인해 주세요.'));
          else finish(job, null, parsed.result);
        } catch { finish(job, performance.now() >= job.deadline ? timedOut() : analyticsError(503, 'analytics_engine_failed', '독립 분석을 완료하지 못했습니다. 자료 범위를 좁혀 다시 시도해 주세요.')); }
      }
      // A cancelled promise does not prove its native worker has exited.
      if (active === job) active = null;
      drain();
    });
    if (job.signal?.aborted) { finish(job, cancelled()); return; }
    try { job.child.stdin.end(job.payload); }
    catch { finish(job, analyticsError(503, 'analytics_engine_unavailable', '독립 분석 엔진에 요청을 전달하지 못했습니다. 다시 조회해 주세요.')); }
  }
  return async function execute(input, { signal, timeoutMs = ANALYTICS_LIMITS.timeoutMs, actorKey } = {}) {
    const arrivedAt = performance.now();
    if (signal?.aborted) throw cancelled();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > ANALYTICS_LIMITS.timeoutMs) throw new Error('Invalid analytics deadline');
    if (actorKey !== undefined && (typeof actorKey !== 'string' || !/^[a-f0-9]{64}$/.test(actorKey))) throw new Error('Invalid analytics actor key');
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > ANALYTICS_LIMITS.queryBytes) throw analyticsError(413, 'analytics_query_too_large', '한 번에 분석할 수 있는 자료 6MB 한도를 넘었습니다. 자료 범위를 좁혀 주세요.');
    // Anonymous internal callers retain immediate rejection; only trusted distinct actors may wait.
    if (active && (!actorKey || !active.actorKey || active.actorKey === actorKey || waiting.length >= 1 || waiting.some(job => job.actorKey === actorKey))) throw busy();
    return new Promise((resolve, reject) => {
      const job = { actorKey, payload, signal, resolve, reject, deadline: arrivedAt + timeoutMs, settled: false, closed: false, child: null, timer: null, cancel: null };
      job.cancel = () => finish(job, cancelled());
      job.timer = setTimeout(() => finish(job, timedOut()), Math.max(0, job.deadline - performance.now()));
      signal?.addEventListener('abort', job.cancel, { once: true });
      if (signal?.aborted) { finish(job, cancelled()); return; }
      if (active) waiting.push(job); else start(job);
    });
  };
}

export const executeAnalyticsQuery = createAnalyticsExecutor();
