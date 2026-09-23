import { createHttpError } from '../bff/bff-utils.mjs';
import { httpRequestCorrelationHash, validateStoredHttpLogRecord } from './http-log-import.mjs';

const count = () => ({ total: 0, status2xx: 0, status4xx: 0, status5xx: 0, other: 0 });
const add = (counts, status) => {
  counts.total++;
  counts[status >= 500 ? 'status5xx' : status >= 400 ? 'status4xx' : status >= 200 && status < 300 ? 'status2xx' : 'other']++;
};
const areas = {
  draft: ['registration.draft.create', 'registration.draft.save', 'project-change.draft.open', 'project-change.draft.save'],
  approval: ['registration.submit', 'project-change.submit', 'project.executive-review'], cashflow: [], frontend: [],
};
const missing = () => ({ status: 'not_collected', measurementScope: 'http_response_log', completeness: 'not_guaranteed',
  provenance: 'operator_export_unverified', rate: null, overallRate: null,
  note: '현재 HTTP 전체 요청 기록은 연결되지 않았습니다. 화면 오류 건수나 과거 업무 기록으로 요청 분모·오류율을 대신 계산하지 않습니다.' });

export function createHttpLogEvidence({ db, env, now = () => new Date().toISOString(), authorize, maxRecords = 5000 }) {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > 5000) throw new Error('Invalid HTTP log read limit.');
  const guard = async context => {
    if (context.actorRole !== 'admin') throw createHttpError(403, '운영 관리자만 HTTP 기록을 확인할 수 있습니다.', 'qa_admin_required');
    await authorize(context);
  };
  const valid = (row, instant) => validateStoredHttpLogRecord(row) && row.sourceProjectId === env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID
    && Date.parse(row.eventAt) <= Date.parse(instant);
  return {
    async summary(context, { from, to, queriedAt }) {
      await guard(context);
      if (!env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID) return missing();
      const start = new Date(`${from}T00:00:00+09:00`).toISOString();
      const end = new Date(Date.parse(`${to}T00:00:00+09:00`) + 86400000).toISOString();
      const root = `orgs/${context.tenantId}`;
      const { records, imports } = await db.runTransaction(async tx => {
        const [records, imports] = await Promise.all([
          tx.get(db.collection(`${root}/workbench_http_requests`).where('eventAt', '>=', start).where('eventAt', '<', end).orderBy('eventAt').limit(maxRecords + 1)),
          tx.get(db.collection(`${root}/workbench_http_imports`).orderBy('importedAt', 'desc').limit(1)),
        ]);
        return { records, imports };
      }, { readOnly: true });
      const receipt = imports.docs[0]?.data();
      const lastImportedAt = receipt?.sourceProjectId === env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID
        && typeof receipt.importedAt === 'string' && Number.isFinite(Date.parse(receipt.importedAt))
        && Date.parse(receipt.importedAt) <= Date.parse(queriedAt) ? receipt.importedAt : null;
      const truncated = records.size > maxRecords;
      let invalidRecords = 0;
      const groups = new Map(), counts = count();
      for (const doc of records.docs.slice(0, maxRecords)) {
        const row = doc.data();
        if (doc.id !== row.recordId || !valid(row, queriedAt)) { invalidRecords++; continue; }
        const key = JSON.stringify([row.day, row.environment, row.operationKey]);
        const group = groups.get(key) || { day: row.day, environment: row.environment, operationKey: row.operationKey, counts: count() };
        add(group.counts, row.statusCode); add(counts, row.statusCode); groups.set(key, group);
      }
      await guard(context);
      if (!records.size && !lastImportedAt) return missing();
      return { status: truncated || invalidRecords ? 'partial' : 'imported_sample', measurementScope: 'http_response_log',
        completeness: 'not_guaranteed', provenance: 'operator_export_unverified', rate: null, overallRate: null,
        counts, rows: [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.environment.localeCompare(b.environment) || String(a.operationKey).localeCompare(String(b.operationKey))),
        invalidRecords, truncated, lastImportedAt,
        note: '운영자가 가져온 응답 완료 로그만 집계합니다. 파일의 진위·누락·필터·표본 추출 여부를 독립적으로 보장하지 않습니다. 연결 중단·미완료 요청과 실시간 수집은 포함하지 않으며 전체 서비스 오류율·감소율을 계산하지 않습니다.' };
    },
    async findRequest(context, { requestId, actorId, receivedAt, area, expectedStatus, signal }) {
      await guard(context);
      const empty = { records: [], candidates: [], truncated: false, invalidRecords: 0, provenance: 'operator_export_unverified' };
      if (!env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID || !requestId) return empty;
      const requestHash = httpRequestCorrelationHash(context.tenantId, 'request', requestId);
      if (!requestHash) return empty;
      signal?.throwIfAborted();
      const docs = (await db.collection(`orgs/${context.tenantId}/workbench_http_requests`).where('requestHash', '==', requestHash).limit(11).get()).docs;
      const actorHash = actorId ? httpRequestCorrelationHash(context.tenantId, 'actor', actorId) : null;
      const records = [], candidates = [];
      let invalidRecords = 0;
      for (const doc of docs.slice(0, 10)) {
        const row = doc.data();
        if (doc.id !== row.recordId || !valid(row, now())) { invalidRecords++; continue; }
        const record = { id: doc.id, at: row.eventAt, operationKey: row.operationKey, httpStatus: row.statusCode,
          code: row.errorCode, release: row.releaseSha, environment: row.environment, provenance: row.provenance };
        records.push(record);
        if (actorHash && row.actorHash === actorHash && areas[area]?.includes(row.operationKey)
          && Number.isFinite(Date.parse(receivedAt)) && Math.abs(Date.parse(row.eventAt) - Date.parse(receivedAt)) <= 120000
          && (!Number.isInteger(expectedStatus) || expectedStatus === row.statusCode)) {
          candidates.push({ ...record, outcome: row.statusCode >= 500 ? 'server_error' : row.statusCode >= 400 ? 'request_rejected' : row.statusCode === 202 ? 'accepted_pending' : 'http_acknowledged' });
        }
      }
      signal?.throwIfAborted();
      await guard(context);
      return { records, candidates: docs.length > 10 || invalidRecords ? [] : candidates, truncated: docs.length > 10, invalidRecords, provenance: 'operator_export_unverified' };
    },
  };
}
