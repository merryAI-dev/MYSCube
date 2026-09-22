import { randomUUID } from 'node:crypto';
import { createHttpError } from './bff-utils.mjs';
import { contribution, incidentInputSchema, mergeObservation, observationId, operationObservationSchema, publicIncident } from './reliability-model.mjs';

const emptyCounts = () => contribution(null);
const root = (tenantId, name) => `orgs/${tenantId}/reliability_${name}`;
const isAdmin = (context) => context.actorRole === 'admin';
const assertAdmin = (context) => {
  if (!isAdmin(context)) throw createHttpError(403, '서비스 운영 관리자만 확인할 수 있습니다.', 'reliability_admin_required');
};
const identifier = (value) => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) throw createHttpError(400, '항목 번호를 확인해 주세요.', 'invalid_reliability_id');
  return value;
};
const parse = (schema, input) => {
  const result = schema.safeParse(input);
  if (!result.success) throw createHttpError(400, result.error.issues[0]?.message || '입력 내용을 확인해 주세요.', 'invalid_reliability_input');
  return result.data;
};

function bucketKey(operation) {
  const shard = parseInt(operation.id.slice(0, 2), 16) % 8;
  return `${operation.day}_${operation.environment}_${operation.operationKey}_${operation.mode}_${shard}`;
}

export function createReliabilityService({ db, now = () => new Date().toISOString(), environment = 'unknown' }) {
  const lastCollectionFailure = new Map();

  async function observe(context, event) {
    const timestamp = now();
    const id = observationId(context.tenantId, context.actorId, event.operationKey, event.operationId);
    const ref = db.doc(`${root(context.tenantId, 'operations')}/${id}`);
    return db.runTransaction(async (tx) => {
      const old = (await tx.get(ref)).data() || null;
      const merged = mergeObservation(old, { ...event, actorId: context.actorId, environment }, timestamp);
      if (merged === old) return old;
      const next = { ...merged, id, metricVersion: 1 };
      const keys = [...new Set([old && bucketKey(old), bucketKey(next)].filter(Boolean))];
      const refs = keys.map((key) => db.doc(`${root(context.tenantId, 'daily')}/${key}`));
      const snapshots = await Promise.all(refs.map((item) => tx.get(item)));
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const basis = key === bucketKey(next) ? next : old;
        const counts = { ...emptyCounts(), ...(snapshots[index].data()?.counts || {}) };
        const before = contribution(old && key === bucketKey(old) ? old : null);
        const after = contribution(key === bucketKey(next) ? next : null);
        for (const name of Object.keys(counts)) counts[name] += after[name] - before[name];
        if (Object.values(counts).some((value) => !Number.isSafeInteger(value) || value < 0)) {
          throw new Error('Invalid reliability aggregate');
        }
        tx.set(refs[index], { metricVersion: 1, day: basis.day, environment: basis.environment,
          operationKey: basis.operationKey, mode: basis.mode, counts, updatedAt: timestamp });
      }
      tx.set(ref, next);
      return next;
    });
  }

  return {
    observe,
    async observeClient(context, input) {
      return observe(context, { ...parse(operationObservationSchema, input), authority: 'client' });
    },
    collectionFailed(tenantId) {
      // This process-local signal is only a lower bound; a dead instance cannot report its own failure.
      if (lastCollectionFailure.size > 1000) lastCollectionFailure.clear();
      lastCollectionFailure.set(tenantId, now());
    },
    async summary(context, days = 7) {
      assertAdmin(context);
      if (![7, 14, 28].includes(days)) throw createHttpError(400, '조회 기간은 7·14·28일 중 선택해 주세요.', 'invalid_reliability_period');
      const end = now();
      const from = new Date(Date.parse(end) + 9 * 3600000 - (days - 1) * 86400000).toISOString().slice(0, 10);
      const to = new Date(Date.parse(end) + 9 * 3600000).toISOString().slice(0, 10);
      const snapshots = await db.collection(root(context.tenantId, 'daily')).where('day', '>=', from).where('day', '<=', to).limit(5001).get();
      const truncated = snapshots.docs.length > 5000;
      const items = snapshots.docs.slice(0, 5000).map((doc) => doc.data());
      const groups = new Map();
      for (const row of items) {
        if (row.environment !== environment || row.metricVersion !== 1) continue;
        const key = `${row.day}_${row.operationKey}_${row.mode}`;
        const group = groups.get(key) || { day: row.day, operationKey: row.operationKey, mode: row.mode, counts: emptyCounts() };
        for (const name of Object.keys(group.counts)) group.counts[name] += row.counts[name] || 0;
        groups.set(key, group);
      }
      const rows = [...groups.values()].sort((a, b) => a.day.localeCompare(b.day));
      const counts = emptyCounts();
      for (const row of rows) for (const name of Object.keys(counts)) counts[name] += row.counts[name];
      return { from, to, environment, metricVersion: 1, rows, counts, truncated,
        observedSystemFailureRate: !truncated && !lastCollectionFailure.has(context.tenantId) && counts.total ? counts.system_failed / counts.total : null,
        collection: { status: lastCollectionFailure.has(context.tenantId) ? 'degraded' : (counts.total ? 'partial' : 'unverified'),
          lastKnownFailureAt: lastCollectionFailure.get(context.tenantId) || null,
          completeness: 'not_guaranteed', note: '수집된 업무 시도 기준입니다. 수집 실패·미계측 화면은 포함되지 않을 수 있습니다.' },
        queriedAt: end };
    },
    async getOperation(context, operationKey, operationId) {
      const parsed = parse(operationObservationSchema, { operationKey, operationId, mode: 'unknown', phase: 'started' });
      const id = observationId(context.tenantId, context.actorId, parsed.operationKey, parsed.operationId);
      const doc = await db.doc(`${root(context.tenantId, 'operations')}/${id}`).get();
      if (!doc.exists) return { found: false, outcome: 'unknown' };
      const value = doc.data();
      return { found: true, operationId: value.operationId, operationKey: value.operationKey, outcome: value.outcome,
        serverObserved: value.serverObserved, requestId: value.requestId, updatedAt: value.updatedAt, followup: value.followup };
    },
    async listIncidents(context, { publishedOnly = false } = {}) {
      if (!publishedOnly) assertAdmin(context);
      let query = db.collection(root(context.tenantId, 'incidents'));
      query = publishedOnly ? query.where('memberVisible', '==', true) : query.orderBy('updatedAt', 'desc');
      const docs = await query.limit(101).get();
      const records = docs.docs.slice(0, 100).map((doc) => doc.data());
      return { items: records.map((item) => publishedOnly ? publicIncident(item) : item), truncated: docs.docs.length > 100 };
    },
    async saveIncident(context, id, input) {
      assertAdmin(context);
      const data = parse(incidentInputSchema, input);
      const incidentId = id ? identifier(id) : randomUUID();
      const ref = db.doc(`${root(context.tenantId, 'incidents')}/${incidentId}`);
      return db.runTransaction(async (tx) => {
        const old = (await tx.get(ref)).data();
        if ((old?.version || 0) !== data.expectedVersion) throw createHttpError(409, '다른 관리자가 수정했습니다. 최신 내용을 다시 불러와 주세요.', 'reliability_version_conflict');
        if (id && !old) throw createHttpError(404, '사건을 찾을 수 없습니다.', 'reliability_incident_not_found');
        const { expectedVersion, ...fields } = data;
        const value = { ...fields, memberVisible: fields.published && fields.status !== 'resolved', id: incidentId, version: expectedVersion + 1, createdAt: old?.createdAt || now(),
          updatedAt: now(), updatedBy: context.actorId,
          reopenedCount: (old?.reopenedCount || 0) + Number(old?.status === 'resolved' && fields.status !== 'resolved') };
        tx.set(ref, value);
        tx.set(ref.collection('history').doc(String(value.version)), value);
        return value;
      });
    },
    async incidentHistory(context, id) {
      assertAdmin(context);
      const snapshot = await db.collection(`${root(context.tenantId, 'incidents')}/${identifier(id)}/history`).orderBy('version', 'desc').limit(51).get();
      return { items: snapshot.docs.slice(0, 50).map((doc) => doc.data()), truncated: snapshot.docs.length > 50 };
    },
  };
}

export function mountReliabilityRoutes(app, { service, asyncHandler, createMutatingRoute, idempotencyService }) {
  const prefix = '/api/v1/product-operations';
  const adminBeforeReplay = asyncHandler(async (req, _res, next) => { assertAdmin(req.context); next(); });
  app.post(`${prefix}/observations`, asyncHandler(async (req, res) => {
    await service.observeClient(req.context, req.body);
    res.json({ ok: true });
  }));
  app.get(`${prefix}/summary`, asyncHandler(async (req, res) => res.json(await service.summary(req.context, Number(req.query.days || 7)))));
  app.get(`${prefix}/operation`, asyncHandler(async (req, res) => res.json(await service.getOperation(req.context, req.query.operationKey, req.query.operationId))));
  app.get(`${prefix}/guidance`, asyncHandler(async (req, res) => res.json(await service.listIncidents(req.context, { publishedOnly: true }))));
  app.get(`${prefix}/incidents`, asyncHandler(async (req, res) => res.json(await service.listIncidents(req.context))));
  app.post(`${prefix}/incidents`, adminBeforeReplay, createMutatingRoute(idempotencyService, async (req) => ({ status: 201, body: await service.saveIncident(req.context, null, req.body) })));
  app.put(`${prefix}/incidents/:incidentId`, adminBeforeReplay, createMutatingRoute(idempotencyService, async (req) => ({ status: 200, body: await service.saveIncident(req.context, req.params.incidentId, req.body) })));
  app.get(`${prefix}/incidents/:incidentId/history`, asyncHandler(async (req, res) => res.json(await service.incidentHistory(req.context, req.params.incidentId))));
}
