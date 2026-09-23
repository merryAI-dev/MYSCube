import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { createHttpError } from '../bff/bff-utils.mjs';
import { safeDiagnosticCode, seoulDay } from '../bff/reliability-model.mjs';
import { classifyProjectOperation } from '../../shared/product-operations.mjs';

export const HTTP_LOG_IMPORT_MAX_BYTES = 1_000_000;
const id = z.string().regex(/^[A-Za-z0-9_-]{1,150}$/);
const instant = z.iso.datetime({ offset: true });
const method = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'CONNECT', 'TRACE']);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const operation = z.enum(['registration.draft.create', 'registration.draft.save', 'registration.submit', 'project-change.draft.open', 'project-change.draft.save', 'project-change.submit', 'project.executive-review']);
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = (code = 'workbench_http_export_invalid', status = 400) => createHttpError(status, 'HTTP 기록을 등록하지 않았습니다. 승인된 내보내기 형식·기간·프로젝트·기록 내용을 확인해 주세요.', code);
const envelopeSchema = z.object({ id, deploymentId: id, source: z.enum(['build', 'edge', 'lambda', 'static', 'external', 'firewall', 'redirect']), host: z.string().min(1).max(500), timestamp: z.number().int().nonnegative().safe(), projectId: id, level: z.enum(['info', 'warning', 'error', 'fatal']), type: z.string().max(100).optional(), environment: z.enum(['production', 'preview']).optional(), message: z.string().max(262144).optional() }).passthrough();
const exportSchema = z.object({ schemaVersion: z.literal(1), sourceSystem: z.literal('vercel'), sourceProjectId: id, tenantId: id, exportedAt: instant, period: z.object({ from: instant, to: instant }).strict(), coverage: z.enum(['partial', 'sampled', 'unknown']), entries: z.array(envelopeSchema).max(200) }).strict();
const payloadSchema = z.object({ message: z.literal('bff.request'), service: z.literal('mysc-bff'), method, path: z.string().min(1).max(4096).regex(/^\/[^\r\n\u0000]*$/), statusCode: z.number().int().min(100).max(599), latencyMs: z.number().nonnegative().finite(), tenantId: id }).passthrough();
const recordSchema = z.object({ schemaVersion: z.literal(1), sourceSystem: z.literal('vercel'), sourceProjectId: id, recordId: hash, sourceRecordHash: hash, eventAt: z.iso.datetime(), day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), environment: z.enum(['live', 'preview', 'unknown']), method, operationKey: operation.nullable(), statusCode: z.number().int().min(100).max(599), latencyMs: z.number().nonnegative().finite(), errorCode: z.string().regex(/^[a-z][a-z0-9_]{0,99}$/).nullable(), releaseSha: z.string().regex(/^[a-f0-9]{40}$/).nullable(), requestHash: hash.nullable(), actorHash: hash.nullable(), provenance: z.literal('operator_export_unverified') }).strict();

export function httpSourceRecordId(sourceProjectId, nativeId) {
  if (!id.safeParse(sourceProjectId).success || !id.safeParse(nativeId).success) throw fail();
  return digest(['vercel-http-record-v1', sourceProjectId, nativeId]);
}
export function httpRequestCorrelationHash(tenantId, kind, value) {
  if (!id.safeParse(tenantId).success || !['request', 'actor'].includes(kind)) throw fail();
  if (!id.safeParse(value).success) return null;
  return digest(['tenant-http-correlation-v1', tenantId, kind, value]);
}
export function httpLogRecordDigest(record) {
  const { sourceRecordHash: _ignored, ...body } = record;
  return digest(body);
}
export function validateStoredHttpLogRecord(record) {
  const result = recordSchema.safeParse(record);
  return result.success && record.day === seoulDay(record.eventAt) && record.sourceRecordHash === httpLogRecordDigest(record);
}

function sanitizeEntry(entry, feed) {
  if (entry.source !== 'lambda' || entry.type != null && entry.type !== 'stdout') return null;
  let payload;
  try { payload = JSON.parse(entry.message || 'null'); } catch {
    if (entry.message?.includes('bff.request')) throw fail();
    return null;
  }
  if (payload?.message !== 'bff.request') return null;
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success || payload.tenantId !== feed.tenantId) throw fail();
  if (Object.hasOwn(entry, 'statusCode') && (!Number.isInteger(entry.statusCode) || entry.statusCode < 100 || entry.statusCode > 599 || entry.statusCode !== payload.statusCode)) throw fail();
  const operationKey = classifyProjectOperation(payload.method, payload.path);
  for (const key of ['operation', 'operationKey']) if (Object.hasOwn(payload, key) && payload[key] !== operationKey) throw fail();
  const environment = entry.environment === 'production' ? 'live' : entry.environment === 'preview' ? 'preview' : 'unknown';
  for (const key of ['environment', 'deployEnvironment']) {
    if (!Object.hasOwn(payload, key)) continue;
    if (!['live', 'preview', 'local', 'isolated', 'unknown'].includes(payload[key]) || payload[key] !== 'unknown' && payload[key] !== environment) throw fail();
  }
  if (payload.releaseSha != null && (typeof payload.releaseSha !== 'string' || !/^[a-f0-9]{40}$/i.test(payload.releaseSha))) throw fail();
  const eventAt = new Date(entry.timestamp).toISOString();
  const record = { schemaVersion: 1, sourceSystem: 'vercel', sourceProjectId: feed.sourceProjectId, recordId: httpSourceRecordId(feed.sourceProjectId, entry.id), eventAt, day: seoulDay(eventAt), environment, method: payload.method, operationKey, statusCode: payload.statusCode, latencyMs: payload.latencyMs, errorCode: safeDiagnosticCode(payload.errorCode), releaseSha: payload.releaseSha?.toLowerCase() || null, requestHash: httpRequestCorrelationHash(feed.tenantId, 'request', payload.requestId), actorHash: httpRequestCorrelationHash(feed.tenantId, 'actor', payload.actorId), provenance: 'operator_export_unverified' };
  return { ...record, sourceRecordHash: httpLogRecordDigest(record) };
}

export async function importHttpLogExport({ db, env, input, now = () => new Date().toISOString() }) {
  let runtime;
  try { runtime = resolveWorkbenchRuntime(env); } catch { throw fail('workbench_http_import_disabled', 403); }
  if (env.WORKBENCH_HTTP_LOG_IMPORT_ENABLED !== 'true' || db.projectId !== runtime.projectId || !id.safeParse(env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID).success || !id.safeParse(env.WORKBENCH_TENANT_ID).success) throw fail('workbench_http_import_disabled', 403);
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw fail(); }
  if (bytes > HTTP_LOG_IMPORT_MAX_BYTES) throw fail('workbench_http_export_too_large', 413);
  const parsed = exportSchema.safeParse(input);
  if (!parsed.success) throw fail();
  const feed = parsed.data, importedAt = now();
  if (feed.sourceProjectId !== env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID || feed.tenantId !== env.WORKBENCH_TENANT_ID) throw fail('workbench_http_import_disabled', 403);
  if (!instant.safeParse(importedAt).success) throw fail();
  const from = Date.parse(feed.period.from), to = Date.parse(feed.period.to), exported = Date.parse(feed.exportedAt), clock = Date.parse(importedAt);
  if (!(from < to && to <= exported && exported <= clock)) throw fail();
  const seen = new Set(), records = [];
  for (const entry of feed.entries) {
    if (entry.projectId !== feed.sourceProjectId || entry.timestamp < from || entry.timestamp >= to || entry.timestamp > clock || seen.has(entry.id)) throw fail();
    seen.add(entry.id);
    const record = sanitizeEntry(entry, feed);
    if (record) records.push({ id: httpSourceRecordId(feed.sourceProjectId, entry.id), record });
  }
  const period = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
  const importId = digest(['vercel-http-export-v1', { ...feed, period, exportedAt: new Date(exported).toISOString(), entries: [...feed.entries].sort((a, b) => a.id.localeCompare(b.id)) }]);
  const root = `orgs/${feed.tenantId}`, receiptRef = db.doc(`${root}/workbench_http_imports/${importId}`);
  const refs = records.map(({ id: recordId }) => db.doc(`${root}/workbench_http_requests/${recordId}`));
  const counts = { acceptedCount: records.length, ignoredCount: feed.entries.length - records.length };
  return db.runTransaction(async tx => {
    const snapshots = await Promise.all([tx.get(receiptRef), ...refs.map(ref => tx.get(ref))]);
    const existing = snapshots.slice(1);
    for (let i = 0; i < existing.length; i += 1) if (existing[i].exists && (!validateStoredHttpLogRecord(existing[i].data()) || httpLogRecordDigest(existing[i].data()) !== records[i].record.sourceRecordHash)) throw fail('workbench_http_record_collision', 409);
    if (snapshots[0].exists) {
      if (existing.some(snapshot => !snapshot.exists)) throw fail('workbench_http_receipt_inconsistent', 409);
      return { importId, replayed: true, insertedCount: 0, deduplicatedCount: records.length, ...counts, coverage: feed.coverage, period };
    }
    const insertedCount = existing.filter(snapshot => !snapshot.exists).length, deduplicatedCount = records.length - insertedCount;
    for (let i = 0; i < existing.length; i += 1) if (!existing[i].exists) tx.create(refs[i], records[i].record);
    tx.create(receiptRef, { schemaVersion: 1, sourceSystem: 'vercel', sourceProjectId: feed.sourceProjectId, tenantId: feed.tenantId, exportedAt: new Date(exported).toISOString(), importedAt: new Date(clock).toISOString(), period, coverage: feed.coverage, provenance: 'operator_export_unverified', recordIds: records.map(record => record.id), ...counts, insertedCount, deduplicatedCount });
    return { importId, replayed: false, insertedCount, deduplicatedCount, ...counts, coverage: feed.coverage, period };
  });
}
