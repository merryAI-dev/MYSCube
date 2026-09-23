import { createHttpError } from '../bff/bff-utils.mjs';
import { contribution, observationId, OPERATION_KEYS, OPERATION_MODES, OUTCOMES, seoulDay } from '../bff/reliability-model.mjs';

const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
const environments = ['live', 'preview', 'local', 'unknown'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && date(`${value}T00:00:00.000Z`) && new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
const add = (target, value) => { for (const key of Object.keys(target)) target[key] += value[key]; };

function validOperation(doc, tenantId) {
  const row = doc.data();
  return row.copySchemaVersion === 2 && row.metricVersion === 1
    && identity(row.actorId) && uuid(row.operationId) && OPERATION_KEYS.includes(row.operationKey)
    && OPERATION_MODES.includes(row.mode) && OUTCOMES.includes(row.outcome) && environments.includes(row.environment)
    && day(row.day) && date(row.createdAt) && date(row.updatedAt) && row.day === seoulDay(row.createdAt)
    && Date.parse(row.updatedAt) >= Date.parse(row.createdAt)
    && typeof row.clientStarted === 'boolean' && typeof row.serverObserved === 'boolean'
    && (!['saved', 'system_failed', 'rejected'].includes(row.outcome) || row.serverObserved === true)
    && (row.outcome !== 'validation_blocked' || row.serverObserved === false)
    && ['not_applicable', 'unconfirmed'].includes(row.followup)
    && (row.followup !== 'unconfirmed' || row.outcome === 'saved')
    && doc.id === observationId(tenantId, row.actorId, row.operationKey, row.operationId);
}

function supply(marker, expectedSource, instant, truncated, invalidRecords) {
  let status = 'unverified';
  if (marker) {
    const age = Date.parse(instant) - Date.parse(marker.capturedAt);
    const sweepAge = Date.parse(instant) - Date.parse(marker.sweepCompletedAt);
    if (!expectedSource || marker.sourceProjectId !== expectedSource || !Number.isFinite(age) || age < 0 || age > 300000) status = 'degraded';
    else if (marker.copySchemaVersion !== 2 || truncated || invalidRecords || marker.hasMore !== false || !Number.isFinite(sweepAge) || sweepAge < 0 || sweepAge > 300000 || marker.sweepCursor) status = 'partial';
    else status = 'snapshot_ready';
  }
  return { status, completeness: 'not_guaranteed', note: status === 'snapshot_ready'
    ? '복사 확인된 과거 기록만 집계합니다. 전체 서비스의 시도·오류를 모두 수집했다는 의미가 아니며 개선율이나 전체 서비스 오류율로 사용하지 않습니다.'
    : '사본이 없거나 복사가 진행 중·중단되었거나 확인할 수 없는 기록이 있습니다. 비율을 계산하지 않습니다.' };
}

export function createCopiedLogSummary({ db, env, now = () => new Date().toISOString(), authorize, maxRecords = 5000 }) {
  return async (context, days = 7) => {
    if (context.actorRole !== 'admin') throw createHttpError(403, '운영 관리자만 과거 운영 기록을 확인할 수 있습니다.', 'reliability_admin_required');
    if (![7, 14, 28].includes(days)) throw createHttpError(400, '조회 기간은 7·14·28일 중 선택해 주세요.', 'invalid_reliability_period');
    await authorize(context);
    const queriedAt = now();
    const to = seoulDay(queriedAt), from = seoulDay(new Date(Date.parse(queriedAt) - (days - 1) * 86400000).toISOString());
    const root = `orgs/${context.tenantId}`;
    // Read rows and supply markers in the same snapshot; a worker commit cannot mix generations.
    const records = await db.runTransaction(async tx => {
      const [operations, errors, operationMarker, errorMarker] = await Promise.all([
        tx.get(db.collection(`${root}/reliability_operations`).orderBy('__name__').limit(maxRecords + 1)),
        tx.get(db.collection(`${root}/client_error_events`).orderBy('__name__').limit(maxRecords + 1)),
        tx.get(db.doc(`${root}/workbench_copy_state/reliability_operations`)),
        tx.get(db.doc(`${root}/workbench_copy_state/client_error_events`)),
      ]);
      return { operations, errors, operationMarker: operationMarker.data(), errorMarker: errorMarker.data() };
    }, { readOnly: true });
    const truncated = records.operations.size > maxRecords;
    const groups = new Map(); let invalidRecords = 0;
    for (const doc of records.operations.docs.slice(0, maxRecords)) {
      if (!validOperation(doc, context.tenantId) || Date.parse(doc.data().updatedAt) > Date.parse(queriedAt)) { invalidRecords++; continue; }
      const row = doc.data();
      if (row.day < from || row.day > to) continue;
      const key = JSON.stringify([row.day, row.environment, row.operationKey, row.mode]);
      const group = groups.get(key) || { day: row.day, environment: row.environment, operationKey: row.operationKey, mode: row.mode, counts: contribution(null) };
      add(group.counts, contribution(row)); groups.set(key, group);
    }
    const sourceEnvironments = [...new Set([...groups.values()].map(row => row.environment))].sort();
    const collection = supply(records.operationMarker, env.WORKBENCH_COPY_SOURCE_PROJECT_ID, queriedAt, truncated, invalidRecords);
    const rows = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day) || a.environment.localeCompare(b.environment) || a.operationKey.localeCompare(b.operationKey) || a.mode.localeCompare(b.mode));
    const counts = contribution(null);
    for (const row of rows) {
      add(counts, row.counts);
      row.observedSystemFailureRate = collection.status === 'snapshot_ready' && row.environment !== 'unknown' && row.counts.total ? row.counts.system_failed / row.counts.total : null;
    }
    let clientCount = 0, invalidErrors = 0;
    for (const doc of records.errors.docs.slice(0, maxRecords)) {
      const row = doc.data();
      if (row.copySchemaVersion !== 2 || !date(row.createdAt) || Date.parse(row.createdAt) > Date.parse(queriedAt)) { invalidErrors++; continue; }
      const receivedDay = seoulDay(row.createdAt);
      if (receivedDay >= from && receivedDay <= to) clientCount++;
    }
    const errorTruncated = records.errors.size > maxRecords;
    const errorCollection = supply(records.errorMarker, env.WORKBENCH_COPY_SOURCE_PROJECT_ID, queriedAt, errorTruncated, invalidErrors);
    const result = { from, to, queriedAt, metricVersion: 1, measurementScope: 'logical_operation', historicalOnly: true,
      sourceEnvironments, counts, rows, invalidRecords, truncated, collection,
      source: { capturedAt: records.operationMarker?.capturedAt || null, sweepCompletedAt: records.operationMarker?.sweepCompletedAt || null, expectedSourceProjectId: env.WORKBENCH_COPY_SOURCE_PROJECT_ID || null },
      observedSystemFailureRate: collection.status === 'snapshot_ready' && sourceEnvironments.length === 1 && sourceEnvironments[0] !== 'unknown' && counts.total ? counts.system_failed / counts.total : null,
      clientErrors: { count: errorCollection.status === 'snapshot_ready' ? clientCount : null, observedCount: clientCount, invalidRecords: invalidErrors, truncated: errorTruncated, collection: errorCollection },
      httpRequests: { status: 'not_collected', rate: null, note: '현재 HTTP 전체 요청 기록은 연결되지 않았습니다. 화면 오류 건수나 과거 업무 기록으로 요청 분모·오류율을 대신 계산하지 않습니다.' },
    };
    await authorize(context);
    return result;
  };
}
