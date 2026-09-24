import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importHttpLogExport, httpSourceRecordId, httpRequestCorrelationHash, validateStoredHttpLogRecord } from './http-log-import.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('bounded operator Vercel exports in an isolated Firestore', () => {
  const db = new Firestore({ projectId: 'demo-http-import-target' });
  const tenant = 'http-import-test', root = `orgs/${tenant}`, now = () => '2026-09-23T18:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-http-import-prod', WORKBENCH_MODEL_PROJECT_ID: 'demo-http-import-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-http-import-prodmodel', WORKBENCH_TENANT_ID: tenant, WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'true', WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID: 'prj_http_fixture' };
  const entry = (id = 'log-a', overrides = {}) => ({ id, deploymentId: 'dpl_fixture', source: 'lambda', host: 'private.example.invalid', timestamp: Date.parse('2026-09-23T17:00:00Z'), projectId: 'prj_http_fixture', level: 'info', type: 'stdout', environment: 'production', message: JSON.stringify({ message: 'bff.request', service: 'mysc-bff', method: 'POST', path: '/api/v1/project-registration-drafts/private-project/submit?email=private@example.invalid', statusCode: 200, latencyMs: 0, tenantId: tenant, requestId: 'same-request', actorId: 'private-actor', operationKey: 'registration.submit', deployEnvironment: 'live', releaseSha: 'A'.repeat(40), ...overrides }) });
  const feed = (entries = [entry()]) => ({ schemaVersion: 1, sourceSystem: 'vercel', sourceProjectId: 'prj_http_fixture', tenantId: tenant, exportedAt: now(), period: { from: '2026-09-23T16:00:00Z', to: now() }, coverage: 'partial', entries });
  const run = input => importHttpLogExport({ db, env, input, now });
  const rows = () => db.collection(`${root}/workbench_http_requests`).get();
  const receipts = () => db.collection(`${root}/workbench_http_imports`).get();
  beforeEach(() => db.recursiveDelete(db.doc(root)));
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });

  it('persists sanitized exact records, preserves zero latency and gives repeated HTTP attempts distinct identities', async () => {
    const result = await run(feed([entry('log-a'), entry('log-b', { statusCode: 503, errorCode: 'internal_error' })]));
    expect(result).toMatchObject({ insertedCount: 2, acceptedCount: 2, ignoredCount: 0, replayed: false });
    const saved = await rows(); expect(saved.size).toBe(2);
    for (const doc of saved.docs) {
      expect(validateStoredHttpLogRecord(doc.data())).toBe(true);
      expect(doc.data()).toMatchObject({ recordId: doc.id, environment: 'live', day: '2026-09-24', operationKey: 'registration.submit', latencyMs: 0, releaseSha: 'a'.repeat(40), requestHash: httpRequestCorrelationHash(tenant, 'request', 'same-request'), provenance: 'operator_export_unverified' });
      expect(JSON.stringify(doc.data())).not.toMatch(/private-project|private@example|private-actor|same-request|private.example/);
    }
    expect(saved.docs[0].data().requestHash).toBe(saved.docs[1].data().requestHash);
    expect((await receipts()).docs[0].data()).toMatchObject({ importedAt: now(), coverage: 'partial', insertedCount: 2 });
  });
  it('canonical object key order replays without updating records or receipt timestamps; overlapping windows deduplicate', async () => {
    const input = feed(), first = await run(input), before = (await rows()).docs[0].updateTime;
    const reversed = Object.fromEntries(Object.entries(input).reverse());
    expect(await run(reversed)).toMatchObject({ importId: first.importId, replayed: true, insertedCount: 0, deduplicatedCount: 1 });
    expect((await rows()).docs[0].updateTime.isEqual(before)).toBe(true);
    expect(await run({ ...feed([entry(), entry('log-b')]), period: { from: '2026-09-23T15:00:00Z', to: now() } })).toMatchObject({ insertedCount: 1, deduplicatedCount: 1 });
    expect((await rows()).size).toBe(2); expect((await receipts()).size).toBe(2);
  });
  it('rejects an id collision atomically and does not insert the other valid attempt or receipt', async () => {
    await run(feed());
    await expect(run(feed([entry('log-new'), entry('log-a', { statusCode: 500 })]))).rejects.toMatchObject({ code: 'workbench_http_record_collision' });
    expect((await rows()).size).toBe(1); expect((await receipts()).size).toBe(1);
  });
  it('validates every entry before writes, ignores unrelated stdout, and refuses malformed bff requests', async () => {
    const unrelated = { ...entry('noise'), message: 'unrelated stdout' };
    const malformed = { ...entry('broken'), message: '{"message":"bff.request",' };
    await expect(run(feed([entry(), unrelated, malformed]))).rejects.toMatchObject({ code: 'workbench_http_export_invalid' });
    expect((await rows()).empty).toBe(true); expect((await receipts()).empty).toBe(true);
    expect(await run(feed([entry(), unrelated]))).toMatchObject({ insertedCount: 1, ignoredCount: 1 });
  });
  it('rejects tenant/project mixing, wrong service, and classifier or deployment label contradictions', async () => {
    for (const payload of [{ tenantId: 'another' }, { service: 'other-bff' }, { operationKey: 'project-change.submit' }, { operation: 'project-change.submit' }, { deployEnvironment: 'preview' }, { environment: 'preview' }, { releaseSha: 'short' }]) await expect(run(feed([entry('log-a', payload)]))).rejects.toBeDefined();
    await expect(run(feed([{ ...entry(), projectId: 'prj_wrong' }]))).rejects.toBeDefined();
    expect((await rows()).empty).toBe(true); expect((await receipts()).empty).toBe(true);
  });
  it('rejects invalid periods, future exports, invalid status and duplicate native ids', async () => {
    for (const input of [{ ...feed(), period: { from: now(), to: now() } }, { ...feed(), exportedAt: '2026-09-24T00:00:00Z' }, feed([{ ...entry(), timestamp: Date.parse(now()) }]), feed([entry('same'), entry('same')]), feed([entry('bad', { statusCode: 0 })]), feed([entry('bad', { latencyMs: -1 })])]) await expect(run(input)).rejects.toBeDefined();
    expect((await rows()).empty).toBe(true);
  });
  it('bounds inputs and does not enable imports through a wrong target, source, or flag', async () => {
    await expect(run(feed(Array.from({ length: 201 }, (_, i) => entry(`entry-${i}`))))).rejects.toBeDefined();
    await expect(run({ ...feed(), extra: 'x'.repeat(1_000_001) })).rejects.toMatchObject({ code: 'workbench_http_export_too_large' });
    for (const patch of [{ WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'false' }, { WORKBENCH_PROJECT_ID: 'demo-another-target' }, { WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID: 'prj_other' }, { WORKBENCH_PROJECT_ID: env.PRODUCTION_PROJECT_ID }]) await expect(importHttpLogExport({ db, env: { ...env, ...patch }, input: feed(), now })).rejects.toMatchObject({ code: 'workbench_http_import_disabled' });
    expect((await rows()).empty).toBe(true);
  });
  it('does not replace known native environment with unknown payload or invent classification/release', async () => {
    await run(feed([entry('one', { deployEnvironment: 'unknown', path: '/api/v1/health', operationKey: null, releaseSha: null, errorCode: 'private user details' })]));
    expect((await rows()).docs[0].data()).toMatchObject({ environment: 'live', operationKey: null, releaseSha: null, errorCode: null });
  });
  it('accepts optional native type only with a valid BFF payload and ignores explicit stderr', async () => {
    const missingType = entry('missing-type'); delete missingType.type;
    expect(await run(feed([missingType, { ...entry('stderr'), type: 'stderr' }, { ...entry('same-status'), statusCode: 200 }]))).toMatchObject({ acceptedCount: 2, ignoredCount: 1 });
    expect((await rows()).size).toBe(2);
  });
  it('rejects contradictory or invalid native HTTP status before writing any file records', async () => {
    for (const statusCode of [500, 0, -1, null, '200', 600]) {
      await expect(run(feed([entry('valid'), { ...entry('invalid'), statusCode }]))).rejects.toBeDefined();
      expect((await rows()).empty).toBe(true); expect((await receipts()).empty).toBe(true);
    }
  });
  it('deduplicates concurrent overlapping imports using the native log identity', async () => {
    await Promise.all([run(feed([entry('a'), entry('b')])), run(feed([entry('b'), entry('c')]))]);
    expect((await rows()).size).toBe(3); expect((await receipts()).size).toBe(2);
    expect((await receipts()).docs.reduce((sum, doc) => sum + doc.data().insertedCount, 0)).toBe(3);
    expect((await db.doc(`${root}/workbench_http_requests/${httpSourceRecordId('prj_http_fixture', 'b')}`).get()).exists).toBe(true);
  });
});

describe('correlation separation', () => {
  it('uses tenant and identity kind domains and refuses unsafe raw values', () => {
    expect(httpRequestCorrelationHash('tenant-a', 'request', 'id')).not.toBe(httpRequestCorrelationHash('tenant-b', 'request', 'id'));
    expect(httpRequestCorrelationHash('tenant-a', 'request', 'id')).not.toBe(httpRequestCorrelationHash('tenant-a', 'actor', 'id'));
    expect(httpRequestCorrelationHash('tenant-a', 'actor', 'private@example.invalid')).toBeNull();
  });
});
