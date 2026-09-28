import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import { createAnalyticsService } from './analytics-service.mjs';
import { sha256 } from './analytics-contract.mjs';
import { importAnalyticsSnapshot } from './analytics-import.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('isolated copied datasets and persisted analytics evidence', () => {
  const db = new Firestore({ projectId: 'demo-html-workbench' });
  const businessDb = new Firestore({ projectId: 'demo-analytics-business' });
  const context = { tenantId: `analytics-it-${randomUUID()}`, actorId: 'admin-a', actorRole: 'admin', analyticsScope: { fingerprint: sha256('admin-a-grant-v1'), datasetIds: ['sales'] } };
  const prefix = `orgs/${context.tenantId}`;
  const scope = `${prefix}/axr_analytics/${context.analyticsScope.fingerprint}`;
  const now = () => '2026-09-22T15:00:00.000Z';
  const service = () => createAnalyticsService({ db, now });
  const dataset = () => ({ datasetId: 'sales', manifest: { sourceRevision: 'fixture-1', asOf: '2026-09-22T12:00:00.000Z', capturedAt: '2026-09-22T13:00:00.000Z', completeness: 'complete', coverage: { description: '2026년 승인된 사업', expectedRows: 3, periodStart: '2026-01-01', periodEnd: '2026-12-31' }, semantics: '계약과 원가, 미확인 값은 null', grain: '사업 한 건' }, schema: [{ name: 'id', type: 'integer' }, { name: 'contract', type: 'decimal', scale: 2 }, { name: 'cost', type: 'integer' }], rows: [{ id: 1, contract: '100.50', cost: null }, { id: 2, contract: '0', cost: 0 }, { id: 3, contract: '20.25', cost: 10 }] });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(prefix));
    await businessDb.doc(`${prefix}/projects/live`).set({ amount: 9876, revision: 'untouched' });
  });
  afterAll(async () => {
    await db.recursiveDelete(db.doc(prefix));
    await businessDb.recursiveDelete(businessDb.doc(prefix));
    await Promise.all([db.terminate(), businessDb.terminate()]);
  });
  it('imports immutable data, catalogs real coverage, queries native SQL, and reloads saved evidence', async () => {
    const version = await service().importDataset(context, dataset());
    const catalog = await service().catalog(context);
    expect(catalog.items[0]).toMatchObject({ version: version.version, rowCount: 3, grain: '사업 한 건', columnCoverage: { cost: { missing: 1, confirmedZero: 1 } } });
    const evidence = await service().query(context, { sql: 'select sum(contract) as amount, count(cost) as confirmed from sales' });
    expect(evidence.rows).toEqual([{ amount: '120.75', confirmed: '2' }]);
    expect(evidence.datasetVersions).toEqual({ sales: version.version });
    expect(evidence.coverage[0].sourceRevision).toBe('fixture-1');
    expect(evidence.metadata).toMatchObject({ provenance: '분석용 사본', capturedAt: '2026-09-22T13:00:00.000Z', asOf: '2026-09-22T12:00:00.000Z', completeness: '완료' });
    expect(evidence.queriedAt).toBe(now());
    expect(evidence.capturedAt).not.toBe(evidence.queriedAt);
    expect(evidence.normalizedSql).toContain('sum');
    expect(await service().evidence(context, evidence.evidenceId)).toEqual(evidence);
    expect((await businessDb.doc(`${prefix}/projects/live`).get()).data()).toEqual({ amount: 9876, revision: 'untouched' });
  });
  it('replays an identical import without duplicate revisions and queries an older version after new import', async () => {
    const first = await service().importDataset(context, dataset());
    expect((await service().importDataset(context, dataset())).version).toBe(first.version);
    const next = dataset(); next.manifest.sourceRevision = 'fixture-2'; next.manifest.capturedAt = '2026-09-22T14:00:00.000Z'; next.rows[0].contract = '200.50';
    const second = await service().importDataset(context, next);
    expect(second.version).not.toBe(first.version);
    expect((await service().importDataset(context, dataset())).version).toBe(first.version);
    expect((await service().catalog(context)).items[0].version).toBe(second.version);
    expect((await service().query(context, { sql: 'select sum(contract) as total from sales', datasetVersions: { sales: first.version } })).rows[0].total).toBe('120.75');
    expect((await service().query(context, { sql: 'select sum(contract) as total from sales' })).rows[0].total).toBe('220.75');
    expect((await db.collection(`${scope}/datasets/sales/versions`).get()).size).toBe(2);
  });
  it('preserves separate source times and versions for a cross-dataset query', async () => {
    const grant = { ...context, analyticsScope: { fingerprint: sha256('admin-two-datasets'), datasetIds: ['sales', 'regions', 'not_ready'] } };
    const first = await service().importDataset(grant, dataset());
    const region: any = dataset(); region.datasetId = 'regions'; region.manifest.sourceRevision = 'regions-1'; region.manifest.capturedAt = '2026-09-22T13:00:00.500Z'; region.manifest.asOf = '2026-09-22T11:00:00Z'; region.schema = [{ name: 'id', type: 'integer' }, { name: 'team', type: 'string' }]; region.rows = [{ id: 1, team: 'A' }, { id: 2, team: 'B' }, { id: 3, team: 'A' }];
    const second = await service().importDataset(grant, region);
    const evidence = await service().query(grant, { sql: 'select r.team,sum(s.contract) as total from sales s join regions r using(id) group by r.team order by r.team' });
    expect(evidence.rows).toEqual([{ team: 'A', total: '120.75' }, { team: 'B', total: '0.00' }]);
    expect(evidence.datasetVersions).toEqual({ sales: first.version, regions: second.version });
    expect(evidence.sourceTimes.capturedAt).toEqual({ from: '2026-09-22T13:00:00.000Z', to: '2026-09-22T13:00:00.500Z' });
    expect(evidence.sourceTimes.asOf.from).toBe('2026-09-22T11:00:00Z');
    expect((await service().catalog(grant)).missingDatasetIds).toEqual(['not_ready']);
  });
  it.each(Array.from({ length: 20 }, (_, index) => index + 1))('commits a concurrent duplicate import as one immutable revision (race %i)', async () => {
    const outcomes = await Promise.allSettled([service().importDataset(context, dataset()), service().importDataset(context, dataset())]);
    for (const outcome of outcomes) if (outcome.status === 'rejected') throw outcome.reason;
    const [first, second] = outcomes.map((outcome) => {
      if (outcome.status !== 'fulfilled') throw new Error('Both duplicate imports must succeed.');
      return outcome.value;
    });
    expect(first.version).toBe(second.version);
    const head = await db.doc(`${scope}/datasets/sales`).get();
    const versions = await db.collection(`${scope}/datasets/sales/versions`).get();
    expect(versions.size).toBe(1);
    expect(versions.docs[0].id).toBe(first.version);
    expect(head.data()).toEqual(versions.docs[0].data());
    const chunks = await versions.docs[0].ref.collection('chunks').get();
    expect(chunks.size).toBe(1);
    expect(chunks.docs[0].id).toBe('0000');
    const rowsJson = chunks.docs[0].get('rowsJson');
    expect(JSON.parse(rowsJson)).toEqual(dataset().rows);
    expect(chunks.docs[0].get('hash')).toBe(sha256(rowsJson));
    expect(head.get('chunkHashes')).toEqual([sha256(rowsJson)]);
    expect(head.get('manifest.sourceRevision')).toBe(dataset().manifest.sourceRevision);
    expect((await service().query(context, { sql: 'select count(*) as n from sales' })).rows).toEqual([{ n: '3' }]);
    expect((await businessDb.doc(`${prefix}/projects/live`).get()).data()).toEqual({ amount: 9876, revision: 'untouched' });
  });
  it('blocks absent scope, non-admin, another actor, tenant, scope revision and ungranted datasets', async () => {
    await service().importDataset(context, dataset());
    const evidence = await service().query(context, { sql: 'select * from sales' });
    await expect(service().catalog({ ...context, analyticsScope: undefined })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service().catalog({ ...context, actorRole: 'member' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service().catalog({ ...context, actorId: 'admin-b' })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service().evidence({ ...context, tenantId: 'other-tenant' }, evidence.evidenceId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().evidence({ ...context, analyticsScope: { ...context.analyticsScope, fingerprint: sha256('new-grant') } }, evidence.evidenceId)).rejects.toMatchObject({ statusCode: 404 });
    await expect(service().query(context, { sql: 'select * from private', datasetVersions: { private: sha256('x') } })).rejects.toMatchObject({ statusCode: 403 });
  });
  it('refuses missing fields, coerced numbers, decimal precision loss, invalid dates and false complete coverage', async () => {
    const missing: any = dataset(); delete missing.rows[0].cost;
    await expect(service().importDataset(context, missing)).rejects.toMatchObject({ code: 'analytics_row_missing' });
    const amount: any = dataset(); amount.rows[0].contract = 100.5;
    await expect(service().importDataset(context, amount)).rejects.toMatchObject({ code: 'analytics_value_invalid' });
    const precision = dataset(); precision.rows[0].contract = '100.501';
    await expect(service().importDataset(context, precision)).rejects.toMatchObject({ code: 'analytics_value_invalid' });
    const incomplete = dataset(); incomplete.manifest.coverage.expectedRows = 4;
    await expect(service().importDataset(context, incomplete)).rejects.toMatchObject({ code: 'analytics_coverage_invalid' });
    const invalidDate: any = dataset(); invalidDate.schema[0].type = 'date'; invalidDate.rows[0].id = '2026-02-30';
    await expect(service().importDataset(context, invalidDate)).rejects.toMatchObject({ code: 'analytics_value_invalid' });
    expect((await db.collection(`${scope}/datasets`).get()).empty).toBe(true);
  });
  it('declares partial source coverage and prevents stale imports from moving the current pointer', async () => {
    const partial = dataset(); partial.manifest.completeness = 'partial'; partial.manifest.coverage.expectedRows = 10;
    const first = await service().importDataset(context, partial);
    expect((await service().query(context, { sql: 'select count(*) as n from sales' })).completeness).toBe('partial');
    const older = dataset(); older.manifest.capturedAt = '2026-09-22T12:00:00.000Z';
    await expect(service().importDataset(context, older)).rejects.toMatchObject({ code: 'analytics_import_stale' });
    const conflicting = dataset(); conflicting.rows[0].contract = '999';
    await expect(service().importDataset(context, conflicting)).rejects.toMatchObject({ code: 'analytics_import_conflict' });
    expect((await service().catalog(context)).items[0].version).toBe(first.version);
  });
  it('detects tampered copy chunks before execution and rejects tampered persisted evidence', async () => {
    const version = await service().importDataset(context, dataset());
    const evidence = await service().query(context, { sql: 'select * from sales' });
    await db.doc(`${scope}/datasets/sales/versions/${version.version}/chunks/0000`).update({ rowsJson: '[{"cost":0}]' });
    await expect(service().query(context, { sql: 'select * from sales' })).rejects.toMatchObject({ code: 'analytics_copy_corrupt' });
    await db.doc(`${scope}/evidence/${evidence.evidenceId}`).update({ payloadJson: '{}' });
    await expect(service().evidence(context, evidence.evidenceId)).rejects.toMatchObject({ code: 'analytics_evidence_corrupt' });
  });
  it('refuses malformed chunk manifests before allocating or loading unbounded data', async () => {
    await service().importDataset(context, dataset());
    await db.doc(`${scope}/datasets/sales`).update({ chunkCount: 100000000 });
    await expect(service().query(context, { sql: 'select * from sales' })).rejects.toMatchObject({ code: 'analytics_copy_corrupt' });
  });
  it('distinguishes an intentionally empty copied dataset from a missing copy', async () => {
    const empty = dataset(); empty.rows = []; empty.manifest.coverage.expectedRows = 0;
    await service().importDataset(context, empty);
    expect((await service().query(context, { sql: 'select sum(contract) as total,count(*) as n from sales' })).rows).toEqual([{ total: null, n: '0' }]);
  });
  it('enforces source byte limits before any Firestore write', async () => {
    const large: any = dataset(); large.schema = [{ name: 'content', type: 'string' }]; large.rows = Array.from({ length: 600 }, () => ({ content: 'a'.repeat(9000) })); large.manifest.coverage.expectedRows = 600;
    await expect(service().importDataset(context, large)).rejects.toMatchObject({ code: 'analytics_dataset_too_large' });
    expect((await db.collection(`${scope}/datasets`).get()).empty).toBe(true);
  });
  it('persists QA evidence across turns in the same scoped envelope', async () => {
    const value = await service().recordEvidence(context, { kind: 'qa', qa: { facts: [{ id: 'fact-1', observed: true }], logs: [], unknowns: ['아직 확인되지 않은 범위'] }, coverage: { description: '복사된 로그' }, queriedAt: now() });
    expect((await service().evidence(context, value.evidenceId)).qa).toEqual(value.qa);
    expect(value.completeness).toBe('unknown');
  });
  it('returns missing dataset information without fabricating zero values', async () => {
    expect(await service().catalog(context)).toMatchObject({ items: [], missingDatasetIds: ['sales'] });
    await expect(service().query(context, { sql: 'select sum(contract) from sales' })).rejects.toMatchObject({ code: 'analytics_dataset_missing' });
  });
  it('gates offline snapshot imports with isolated configuration and authorization before and after', async () => {
    const env = { WORKBENCH_PROJECT_ID: 'demo-html-workbench', PRODUCTION_PROJECT_ID: 'demo-main-platform', WORKBENCH_MODEL_PROJECT_ID: 'demo-workbench-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-production-model', WORKBENCH_IMPORT_ENABLED: 'true' };
    let calls = 0;
    const authorize = async () => { calls++; };
    await expect(importAnalyticsSnapshot({ env: { ...env, WORKBENCH_IMPORT_ENABLED: 'false' }, db, authorize, context, input: dataset(), now })).rejects.toMatchObject({ code: 'analytics_import_disabled' });
    await expect(importAnalyticsSnapshot({ env: { ...env, WORKBENCH_PROJECT_ID: env.PRODUCTION_PROJECT_ID }, db, authorize, context, input: dataset(), now })).rejects.toThrow('must not share production');
    await expect(importAnalyticsSnapshot({ env, db, authorize: async () => { throw new Error('revoked'); }, context, input: dataset(), now })).rejects.toThrow('revoked');
    expect((await service().catalog(context)).items).toEqual([]);
    const result = await importAnalyticsSnapshot({ env, db, authorize, context, input: dataset(), now });
    expect(result.rowCount).toBe(3);
    expect(calls).toBe(2);
    expect((await businessDb.doc(`${prefix}/projects/live`).get()).data().revision).toBe('untouched');
  });
});
