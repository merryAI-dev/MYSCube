import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';
import { OPERATION_KEYS, OPERATION_MODES, OUTCOMES } from '../bff/reliability-model.mjs';

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const dataset = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const memberSchema = z.object({ id, role: z.enum(['admin', 'member']), status: z.enum(['ACTIVE', 'INACTIVE']), datasetIds: z.array(dataset).max(20) }).strict();
const feedSchema = z.object({ version: z.literal(1), sourceProjectId: z.string(), tenantId: id, capturedAt: z.string().datetime(),
  sourceRevision: z.string().min(1).max(200), membershipComplete: z.literal(true), members: z.array(memberSchema).max(200) }).strict();
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export async function applyPermissionCopy({ db, env, input, now = () => new Date().toISOString() }) {
  const runtime = resolveWorkbenchRuntime(env);
  const parsed = feedSchema.safeParse(input);
  if (!parsed.success) throw createHttpError(400, '권한 사본의 전체 범위·계정·수집 시각을 확인해 주세요.', 'workbench_copy_invalid');
  const feed = parsed.data;
  if (env.WORKBENCH_COPY_ENABLED !== 'true' || db.projectId !== runtime.projectId || !env.WORKBENCH_COPY_SOURCE_PROJECT_ID
    || feed.sourceProjectId !== env.WORKBENCH_COPY_SOURCE_PROJECT_ID || feed.sourceProjectId === runtime.projectId
    || feed.tenantId !== env.WORKBENCH_TENANT_ID) throw createHttpError(403, '허용된 원본과 독립 저장소 사이에서만 사본을 갱신할 수 있습니다.', 'workbench_copy_disabled');
  const age = Date.parse(now()) - Date.parse(feed.capturedAt);
  if (age < 0 || age > 120000 || new Set(feed.members.map((member) => member.id)).size !== feed.members.length) throw createHttpError(409, '수집 시각 또는 계정 중복을 확인해 주세요. 오래된 권한을 새 권한으로 바꾸지 않았습니다.', 'workbench_copy_stale');
  const payloadHash = digest([...feed.members].map(member => ({ ...member, datasetIds: [...new Set(member.datasetIds)].sort() })).sort((a, b) => a.id.localeCompare(b.id)));
  const root = `orgs/${feed.tenantId}`;
  const marker = db.doc(`${root}/workbench_copy_state/permissions`);
  return db.runTransaction(async (tx) => {
    const [previous, members] = await Promise.all([tx.get(marker), tx.get(db.collection(`${root}/members`).limit(201))]);
    if (members.size > 200) throw createHttpError(413, '권한 사본의 계정 한도를 확인해 주세요.', 'workbench_copy_too_large');
    if (previous.exists && Date.parse(previous.data().capturedAt) > Date.parse(feed.capturedAt)) throw createHttpError(409, '새 권한 사본이 이미 반영되었습니다.', 'workbench_copy_out_of_order');
    if (previous.exists && Date.parse(previous.data().capturedAt) === Date.parse(feed.capturedAt) && previous.data().payloadHash !== payloadHash) throw createHttpError(409, '같은 수집 시각의 권한 내용이 다릅니다. 원본 권한을 다시 수집해 주세요.', 'workbench_copy_ambiguous');
    const incoming = new Map(feed.members.map((member) => [member.id, member]));
    const targets = new Set([...incoming.keys(), ...members.docs.map((doc) => doc.id)]);
    for (const actorId of targets) {
      const source = incoming.get(actorId);
      const value = { role: source?.role || 'member', status: source?.status || 'INACTIVE',
        analyticsDatasetIds: source?.status === 'ACTIVE' && source.role === 'admin' ? [...new Set(source.datasetIds)].sort() : [],
        permissionsCapturedAt: feed.capturedAt, permissionSourceProjectId: feed.sourceProjectId };
      tx.set(db.doc(`${root}/members/${actorId}`), { ...value, analyticsScopeRevision: digest([value.role, value.status, value.analyticsDatasetIds]) });
    }
    tx.set(marker, { sourceProjectId: feed.sourceProjectId, sourceRevision: feed.sourceRevision, payloadHash, capturedAt: feed.capturedAt, appliedAt: now(), accountCount: incoming.size, revokedMissing: targets.size - incoming.size });
    return { accountCount: incoming.size, revokedMissing: targets.size - incoming.size, capturedAt: feed.capturedAt };
  });
}

export async function readPermissionCopy({ source, env, now = () => new Date().toISOString() }) {
  if (source.projectId !== env.WORKBENCH_COPY_SOURCE_PROJECT_ID || !/^[a-zA-Z0-9_-]{1,128}$/.test(env.WORKBENCH_TENANT_ID || '')) throw new Error('Invalid permission source.');
  const grants = JSON.parse(env.WORKBENCH_COPY_DATASET_GRANTS || '{}');
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw new Error('Explicit copy dataset grants are required.');
  const capturedAt = now();
  const records = await source.collection(`orgs/${env.WORKBENCH_TENANT_ID}/members`).where('role', '==', 'admin').select('role', 'status').limit(201).get();
  if (records.size > 200) throw createHttpError(413, '권한 원본의 계정 한도를 넘었습니다. 일부 계정으로 전체 사본을 대체하지 않았습니다.', 'workbench_copy_too_large');
  const members = records.docs.map((doc) => ({ id: doc.id, role: doc.data().role === 'admin' ? 'admin' : 'member', status: doc.data().status === 'ACTIVE' ? 'ACTIVE' : 'INACTIVE', datasetIds: grants[doc.id] || [] }));
  return { version: 1, sourceProjectId: source.projectId, tenantId: env.WORKBENCH_TENANT_ID, capturedAt, sourceRevision: digest(members), membershipComplete: true, members };
}

const safeId = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,150}$/.test(value) ? value : null;
const safeDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19) ? value : null;
const safeCode = (value) => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value) ? value : null;
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
const safeDay = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value ? value : null;
const safeBoolean = value => typeof value === 'boolean' ? value : null;
const safeStatus = value => Number.isInteger(value) && (value === 0 || value >= 100 && value <= 599) ? value : null;
const safeOperationId = value => typeof value === 'string' && z.string().uuid().safeParse(value).success ? value : null;
const enumValue = (value, choices) => choices.includes(value) ? value : null;
export const LOG_COPY_SCHEMA_VERSION = 2;
export function sanitizeCopiedLog(kind, input) {
  const row = input && typeof input === 'object' ? input : {};
  const invalidFields = [], ambiguousFields = [];
  const checked = (name, value, sanitize) => { const result = sanitize(value); if (value != null && result === null) invalidFields.push(name); return result; };
  const alias = (name, first, second, sanitize) => {
    const left = checked(`extra.${name}`, first, sanitize), right = checked(`extra.${name === 'code' ? 'errorCode' : 'statusCode'}`, second, sanitize);
    const presentLeft = first != null, presentRight = second != null;
    const ambiguous = presentLeft && presentRight && (left === null || right === null || left !== right);
    if (ambiguous) ambiguousFields.push(`extra.${name}`);
    return { value: ambiguous ? null : left ?? right, ambiguous, candidates: ambiguous ? [...new Set([left, right].filter(value => value !== null))] : [] };
  };
  let value;
  if (kind === 'client_error_events') {
    const code = alias('code', row.extra?.code, row.extra?.errorCode, safeCode), status = alias('status', row.extra?.status, row.extra?.statusCode, safeStatus);
    value = { actorId: checked('actorId', row.actorId, safeId), createdAt: checked('createdAt', row.createdAt, safeDate), occurredAt: checked('occurredAt', row.occurredAt, safeDate), clientRequestId: checked('clientRequestId', row.clientRequestId, safeId), requestId: checked('requestId', row.requestId, safeId), release: checked('release', row.release, sha), ingestRelease: checked('ingestRelease', row.ingestRelease, sha), name: checked('name', row.name, safeCode),
      extra: { code: code.value, status: status.value, codeAmbiguous: code.ambiguous, statusAmbiguous: status.ambiguous, codeCandidates: code.candidates, statusCandidates: status.candidates } };
  } else if (kind === 'reliability_operations') {
    const createdAt = checked('createdAt', row.createdAt, safeDate); let day = checked('day', row.day, safeDay);
    if (day && createdAt && day !== new Date(Date.parse(createdAt) + 9 * 3600000).toISOString().slice(0, 10)) { day = null; invalidFields.push('day'); }
    value = { operationId: checked('operationId', row.operationId, safeOperationId), actorId: checked('actorId', row.actorId, safeId), requestId: checked('requestId', row.requestId, safeId),
      operationKey: checked('operationKey', row.operationKey, value => enumValue(value, OPERATION_KEYS)), mode: checked('mode', row.mode, value => enumValue(value, OPERATION_MODES)),
      environment: checked('environment', row.environment, value => enumValue(value, ['local', 'preview', 'live', 'isolated', 'unknown'])),
      day, createdAt, metricVersion: checked('metricVersion', row.metricVersion, value => Number.isSafeInteger(value) && value >= 1 && value <= 1000 ? value : null),
      outcome: checked('outcome', row.outcome, value => enumValue(value, OUTCOMES)), errorCode: checked('errorCode', row.errorCode, safeCode), releaseSha: checked('releaseSha', row.releaseSha, sha), updatedAt: checked('updatedAt', row.updatedAt, safeDate),
      serverObserved: checked('serverObserved', row.serverObserved, safeBoolean), clientStarted: checked('clientStarted', row.clientStarted, safeBoolean),
      followup: checked('followup', row.followup, value => enumValue(value, ['not_applicable', 'unconfirmed', 'confirmed', 'unknown'])) };
  } else throw new Error('Unsupported log copy kind.');
  return { ...value, copySchemaVersion: LOG_COPY_SCHEMA_VERSION, copyValidation: { invalidFields, ambiguousFields } };
}

export async function copyLogPage({ source, db, env, kind, now = () => new Date().toISOString() }) {
  const runtime = resolveWorkbenchRuntime(env);
  if (env.WORKBENCH_COPY_ENABLED !== 'true' || source.projectId !== env.WORKBENCH_COPY_SOURCE_PROJECT_ID || db.projectId !== runtime.projectId
    || source.projectId === db.projectId || !/^[a-zA-Z0-9_-]{1,128}$/.test(env.WORKBENCH_TENANT_ID || '') || !['client_error_events', 'reliability_operations'].includes(kind)) throw new Error('Invalid log copy boundary.');
  const root = `orgs/${env.WORKBENCH_TENANT_ID}`;
  const marker = db.doc(`${root}/workbench_copy_state/${kind}`);
  const previous = (await marker.get()).data();
  const field = kind === 'client_error_events' ? 'createdAt' : 'updatedAt';
  let query = source.collection(`${root}/${kind}`).orderBy(field).orderBy('__name__');
  if (previous?.cursor) query = query.startAfter(previous.cursor.at, previous.cursor.id);
  let sweep = source.collection(`${root}/${kind}`).orderBy('__name__');
  if (previous?.sweepCursor) sweep = sweep.startAfter(previous.sweepCursor);
  const [page, historical] = await Promise.all([query.limit(100).get(), sweep.limit(100).get()]);
  const compareRevision = (a, b) => a.seconds === b.seconds ? a.nanoseconds - b.nanoseconds : a.seconds - b.seconds;
  const documents = new Map();
  for (const doc of [...page.docs, ...historical.docs]) {
    if (!safeId(doc.id)) throw new Error('Unsupported log identifier.');
    const existing = documents.get(doc.id);
    if (!existing || compareRevision(doc.updateTime, existing.updateTime) >= 0) documents.set(doc.id, doc);
  }
  return db.runTransaction(async (tx) => {
    const current = (await tx.get(marker)).data();
    if ((current?.generation || 0) !== (previous?.generation || 0)) throw createHttpError(409, '다른 복사 작업이 먼저 완료되었습니다. 다음 실행에서 이어받습니다.', 'workbench_copy_concurrent');
    const refs = [...documents.keys()].map(docId => db.doc(`${root}/${kind}/${docId}`));
    const stored = refs.length ? await tx.getAll(...refs) : [];
    let count = 0;
    for (const target of stored) {
      const doc = documents.get(target.id), value = target.data();
      if (value?.copySchemaVersion > LOG_COPY_SCHEMA_VERSION) continue;
      if (value?.copySourceUpdatedAt?.isEqual(doc.updateTime) && value.copySchemaVersion === LOG_COPY_SCHEMA_VERSION) continue;
      if (value?.copySourceUpdatedAt && compareRevision(value.copySourceUpdatedAt, doc.updateTime) > 0) continue;
      tx.set(target.ref, { ...sanitizeCopiedLog(kind, doc.data()), copySourceUpdatedAt: doc.updateTime }); count++;
    }
    const last = page.docs.at(-1), historicalLast = historical.docs.at(-1);
    const hasMore = page.size === 100 || historical.size === 100;
    tx.set(marker, { sourceProjectId: source.projectId, capturedAt: now(), copiedThisPage: count, hasMore, copySchemaVersion: LOG_COPY_SCHEMA_VERSION,
      generation: (previous?.generation || 0) + 1,
      cursor: last ? { at: last.data()[field], id: last.id } : previous?.cursor || null,
      sweepCursor: historical.size === 100 ? historicalLast.id : null,
      sweepStartedAt: previous?.sweepCursor ? previous.sweepStartedAt : now(),
      sweepCompletedAt: historical.size < 100 ? now() : previous?.sweepCompletedAt || null });
    return { count, hasMore };
  });
}
