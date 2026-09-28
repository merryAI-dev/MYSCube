import { buildCashflowInflowDataset } from './cashflow-inflow-copy.mjs';
import { importAnalyticsSnapshot } from './analytics-import.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { analyticsError } from './analytics-contract.mjs';

export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
export const SHEETS_COPY_LIMITS = Object.freeze({ targets: 100, concurrency: 2, requestMs: 10000, totalMs: 120000, responseBytes: 1000000, totalBytes: 16000000 });
const error = (code, message, status = 422) => analyticsError(status, code, message);
const abortError = () => error('sheets_copy_timeout', '전체 수집을 중단해 새 사본을 등록하지 않았습니다. 이전 정상 자료를 유지합니다.', 504);
const exactKeys = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
function checkedManifest(value) {
  if (!exactKeys(value, ['targets']) || !Array.isArray(value.targets) || !value.targets.length || value.targets.length > SHEETS_COPY_LIMITS.targets) throw error('sheets_manifest_invalid', '서버에서 승인한 1~100개 사업 연결 목록이 필요합니다.');
  for (const target of value.targets) if (!exactKeys(target, ['projectId', 'spreadsheetId', 'sheetName', 'weeklyYear', 'currency'])) throw error('sheets_manifest_invalid', '사업 연결 목록에는 승인한 시트 식별 정보만 지정해 주세요.');
  return structuredClone(value);
}
function deadline(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  let listener;
  const stopped = new Promise((_resolve, reject) => { listener = () => reject(abortError()); signal.addEventListener('abort', listener, { once: true }); });
  return Promise.race([promise, stopped]).finally(() => signal.removeEventListener('abort', listener));
}
async function boundedJson(response, signal, cap, consume) {
  if (!response.ok || !/^application\/json\b/i.test(response.headers.get('content-type') || '') || !response.body) throw error('sheets_source_unavailable', '승인한 원본 자료를 읽지 못했습니다.', 503);
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > cap) throw error('sheets_source_too_large', '원본 응답이 허용 크기를 넘었습니다.', 413);
  const reader = response.body.getReader(); const chunks = []; let size = 0;
  try {
    while (true) {
      const part = await deadline(reader.read(), signal); if (part.done) break;
      size += part.value.byteLength; consume(part.value.byteLength);
      if (size > cap) throw error('sheets_source_too_large', '원본 응답이 허용 크기를 넘었습니다.', 413);
      chunks.push(Buffer.from(part.value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function createSheetsCopyProducer({ env, db, manifest, authorize, getToken, fetchImpl = fetch, now = () => new Date().toISOString(), limits = {} }) {
  const approved = checkedManifest(manifest);
  const cap = Object.fromEntries(Object.entries(SHEETS_COPY_LIMITS).map(([key, value]) => [key, Number.isFinite(limits[key]) && limits[key] > 0 ? Math.min(value, limits[key]) : value]));
  return {
    async run(context, { yearMonth, weekNos }, { signal } = {}) {
      const runtime = resolveWorkbenchRuntime(env);
      if (env.WORKBENCH_SHEETS_COPY_ENABLED !== 'true' || env.WORKBENCH_IMPORT_ENABLED !== 'true' || db.projectId !== runtime.projectId || typeof authorize !== 'function' || typeof getToken !== 'function') throw error('sheets_copy_disabled', '독립 분석 저장소의 읽기 전용 시트 연결이 활성화되어야 합니다.', 403);
      const authorizeBounded = async () => {
        const controller = new AbortController(); const cancel = () => controller.abort();
        signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
        const timeout = setTimeout(cancel, cap.requestMs); timeout.unref();
        try { await deadline(Promise.resolve().then(() => authorize(context)), controller.signal); }
        finally { clearTimeout(timeout); signal?.removeEventListener('abort', cancel); }
      };
      await authorizeBounded();
      const targets = approved.targets.map(target => ({ ...target, failure: 'UNAVAILABLE' }));
      buildCashflowInflowDataset({ yearMonth, weekNos, capturedAt: now(), targets });
      const total = new AbortController(); const stop = () => total.abort(); signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
      const timer = setTimeout(stop, cap.totalMs); timer.unref(); let bytes = 0, cursor = 0;
      try {
        const worker = async () => {
          while (cursor < targets.length) {
            const index = cursor++; if (total.signal.aborted) continue;
            await deadline(authorizeBounded(), total.signal);
            const target = approved.targets[index]; const local = new AbortController(); const cancel = () => local.abort();
            total.signal.addEventListener('abort', cancel, { once: true }); if (total.signal.aborted) cancel();
            const timeout = setTimeout(cancel, cap.requestMs); timeout.unref();
            try {
              const token = await deadline(Promise.resolve().then(() => getToken({ scope: SHEETS_READONLY_SCOPE, signal: local.signal })), local.signal);
              if (typeof token !== 'string' || !token || /[\r\n]/.test(token)) throw error('sheets_token_unavailable', '읽기 전용 연결 인증을 확인해 주세요.', 503);
              const range = `'${target.sheetName.replaceAll("'", "''")}'!A1:BT60`;
              const url = new URL(`https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(target.spreadsheetId)}/values/${encodeURIComponent(range)}`);
              url.searchParams.set('valueRenderOption', 'FORMATTED_VALUE'); url.searchParams.set('majorDimension', 'ROWS');
              const response = await deadline(fetchImpl(url, { method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: local.signal }), local.signal);
              const body = await boundedJson(response, local.signal, cap.responseBytes, count => { bytes += count; if (bytes > cap.totalBytes) { total.abort(); throw error('sheets_total_too_large', '전체 원본 응답이 허용 크기를 넘었습니다.', 413); } });
              if (!body || typeof body !== 'object' || (body.majorDimension !== undefined && body.majorDimension !== 'ROWS') || (body.values !== undefined && !Array.isArray(body.values))) throw error('sheets_response_invalid', '원본 시트 응답 형식이 올바르지 않습니다.');
              targets[index] = { ...target, matrix: body.values || [], capturedAt: now() };
            } catch { /* A failed source remains explicit UNAVAILABLE, never zero. */ }
            finally { clearTimeout(timeout); total.signal.removeEventListener('abort', cancel); }
            await deadline(authorizeBounded(), total.signal);
          }
        };
        await Promise.all(Array.from({ length: Math.min(cap.concurrency, targets.length) }, worker));
        if (signal?.aborted) throw abortError();
        await authorizeBounded();
        const input = { yearMonth, weekNos, capturedAt: now(), targets };
        buildCashflowInflowDataset(input);
        if (total.signal.aborted || signal?.aborted) throw abortError();
        const imported = await importAnalyticsSnapshot({ env, db, authorize: authorizeBounded, context, input, now, format: 'sheets-inflow' });
        await authorizeBounded();
        return { ...imported, sources: targets.map(target => ({ projectId: target.projectId, status: target.failure || 'OK', capturedAt: target.capturedAt || null })) };
      } finally { clearTimeout(timer); total.abort(); signal?.removeEventListener('abort', stop); }
    },
  };
}
