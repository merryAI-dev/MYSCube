import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Firestore } from '@google-cloud/firestore';
import request from 'supertest';
import { createAnalyticsService } from './analytics-service.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createWorkbenchApp } from './app.mjs';
import { validateReactScreenBindings } from './react-screen-bindings.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('typed stored-table imports, native queries, APIs and persisted evidence', () => {
  const db = new Firestore({ projectId: 'demo-table-query' });
  const businessDb = new Firestore({ projectId: 'demo-table-query-source' });
  const tenantId = `table-it-${randomUUID()}`;
  const prefix = `orgs/${tenantId}`;
  const now = () => '2026-09-24T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: businessDb.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-table-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const analytics = createAnalyticsService({ db, now });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const context = () => ({ tenantId, actorId: 'admin', actorRole: 'admin' });
  const headers = () => ({ 'x-tenant-id': tenantId, 'x-actor-id': 'admin', 'idempotency-key': randomUUID() });
  const data = () => ({ datasetId: 'projects_copy', manifest: { tableQuery: { schemaVersion: 1 }, sourceRevision: 'synthetic-source-v1', capturedAt: now(), asOf: now(), completeness: 'partial', coverage: { description: '합성 원문 투영 3행, 삭제 여부 자동 제외 없음', expectedRows: 4 } }, schema: [{ name: 'project_id', type: 'string' }, { name: 'status', type: 'string' }, { name: 'trashed_at', type: 'timestamp' }], rows: [{ project_id: 'a', status: 'RAW_A', trashed_at: null }, { project_id: 'b', status: 'RAW_A', trashed_at: '2026-09-23T00:00:00Z' }, { project_id: 'c', status: null, trashed_at: null }] });
  const tablePlan = () => ({ kind: 'table', datasetId: 'projects_copy', select: ['project_id', 'status'], orderBy: [{ field: 'project_id', direction: 'asc' }] });
  const definition = () => ({ kind: 'analytics-copy', name: '합성 원문 조회', description: '사본 원문 status 비교', enabled: true, parameters: { status: { type: 'string', required: true, label: '원문 상태', example: 'RAW_A' } }, plan: { ...tablePlan(), filters: [{ field: 'status', op: 'eq', value: { $input: 'status' } }] } });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(prefix));
    await db.doc(`${prefix}/members/admin`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['projects_copy'], analyticsScopeRevision: 'approved-v1' });
    await businessDb.doc(`${prefix}/projects/untouched`).set({ status: 'unmodified', trashedAt: null });
  });
  afterAll(async () => {
    await db.recursiveDelete(db.doc(prefix)); await businessDb.recursiveDelete(businessDb.doc(prefix));
    await Promise.all([db.terminate(), businessDb.terminate()]);
  });
  it('persists the original projection and exact version with null/deleted rows intact and source unchanged', async () => {
    const ctx = context(); await core.authorize(ctx);
    const sourceBefore = await businessDb.doc(`${prefix}/projects/untouched`).get();
    const imported = await analytics.importDataset(ctx, data());
    const catalog = await analytics.catalog(ctx);
    expect(catalog.tables.datasets.map((item: { datasetId: string }) => item.datasetId)).toEqual(['projects_copy']);
    expect(catalog.semantic.items).toEqual([]);
    const evidence = await analytics.queryPlan(ctx, tablePlan(), { datasetVersions: { projects_copy: imported.version } });
    expect(evidence.rows).toEqual([{ project_id: 'a', status: 'RAW_A' }, { project_id: 'b', status: 'RAW_A' }, { project_id: 'c', status: null }]);
    expect(evidence.completeness).toBe('partial');
    expect(evidence.semantic).toMatchObject({ kind: 'table', definitionVersions: { projects_copy: { id: 'stored_table', version: '1' } } });
    expect(evidence.datasetVersions).toEqual({ projects_copy: imported.version });
    expect(await analytics.evidence(ctx, evidence.evidenceId)).toEqual(evidence);
    const count = await analytics.queryPlan(ctx, { kind: 'table', datasetId: 'projects_copy', aggregate: { op: 'count_rows' } });
    expect(count.rows).toEqual([{ row_count: '3' }]);
    const filtered = await analytics.queryPlan(ctx, { ...tablePlan(), filters: [{ field: 'trashed_at', op: 'is_null' }] });
    expect(filtered.rows.map((row: { project_id: string }) => row.project_id)).toEqual(['a', 'c']);
    const sourceAfter = await businessDb.doc(`${prefix}/projects/untouched`).get();
    expect(sourceAfter.data()).toEqual(sourceBefore.data()); expect(sourceAfter.updateTime?.isEqual(sourceBefore.updateTime!)).toBe(true);
  });
  it('does not make ordinary imported data table-queryable and rejects mixed business/table policy', async () => {
    const ctx = context(); await core.authorize(ctx);
    const unapproved = data(); const { tableQuery: _policy, ...manifest } = unapproved.manifest;
    await analytics.importDataset(ctx, { ...unapproved, manifest });
    expect((await analytics.catalog(ctx)).tables.datasets).toEqual([]);
    await expect(analytics.queryPlan(ctx, tablePlan())).rejects.toMatchObject({ code: 'table_query_not_enabled' });
    await expect(analytics.importDataset(ctx, { ...data(), manifest: { ...data().manifest, semanticDefinitionId: 'weekly_submission', semanticDefinitionVersion: '1' } })).rejects.toMatchObject({ code: 'table_query_not_enabled' });
    const noGrant = context(); await db.doc(`${prefix}/members/admin`).update({ analyticsDatasetIds: [], analyticsScopeRevision: 'revoked' }); await core.authorize(noGrant);
    await expect(analytics.importDataset(noGrant, data())).rejects.toMatchObject({ statusCode: 403 });
    expect((await analytics.catalog(noGrant)).items).toEqual([]);
  });
  it('queries the pinned old copy after an updated projection and preserves its evidence', async () => {
    const ctx = context(); await core.authorize(ctx); const first = await analytics.importDataset(ctx, data());
    const next = data(); next.manifest.capturedAt = '2026-09-24T12:00:01.000Z'; next.manifest.sourceRevision = 'synthetic-v2'; next.rows[0].status = 'RAW_B';
    const second = await analytics.importDataset(ctx, next);
    const old = await analytics.queryPlan(ctx, tablePlan(), { datasetVersions: { projects_copy: first.version } });
    expect(old.rows[0].status).toBe('RAW_A'); expect(old.datasetVersions.projects_copy).not.toBe(second.version);
    expect((await analytics.queryPlan(ctx, tablePlan())).rows[0].status).toBe('RAW_B');
    await expect(analytics.queryPlan(ctx, tablePlan(), { datasetVersions: { other: first.version } })).rejects.toMatchObject({ code: 'analytics_input_invalid' });
    await expect(analytics.queryPlan(ctx, tablePlan(), { datasetVersions: { projects_copy: 'f'.repeat(64) } })).rejects.toMatchObject({ code: 'analytics_dataset_missing' });
  });
  it('registers and invokes the exact table plan through real HTTP, then rejects revocation without rows', async () => {
    const ctx = context(); await core.authorize(ctx); await analytics.importDataset(ctx, data());
    const created = await request(app).post('/api/v1/workbench-apis').set(headers()).send({ expectedVersion: 0, definition: definition() });
    expect(created.status).toBe(201);
    const result = await request(app).post(`/api/v1/workbench-apis/${created.body.id}/test`).set(headers()).send({ version: 1, input: { status: 'RAW_A' } });
    expect(result.status).toBe(200); expect(result.body.rows).toEqual([{ project_id: 'a', status: 'RAW_A' }, { project_id: 'b', status: 'RAW_A' }]);
    const evidence = await analytics.evidence(ctx, result.body.evidenceId);
    const binding = validateReactScreenBindings({ bindings: [{ apiId: created.body.id, apiVersion: 1, input: { status: 'RAW_A' }, evidenceId: evidence.evidenceId }], apis: [created.body], evidence: [evidence], catalog: await analytics.catalog(ctx) });
    expect(binding[0].plan.kind).toBe('table'); expect(binding[0].datasetVersions).toEqual(evidence.datasetVersions);
    await db.doc(`${prefix}/members/admin`).update({ analyticsDatasetIds: [], analyticsScopeRevision: 'revoked' });
    const denied = await request(app).post(`/api/v1/workbench-apis/${created.body.id}/test`).set(headers()).send({ version: 1, input: { status: 'RAW_A' } });
    expect(denied.status).toBe(403); expect(denied.body.rows).toBeUndefined();
  });
});
