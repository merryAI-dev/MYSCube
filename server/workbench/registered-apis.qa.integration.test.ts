import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createWorkbenchApp } from './app.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { buildCashflowInflowDataset } from './cashflow-inflow-copy.mjs';
import { makeInflowFixtureMatrix } from './cashflow-inflow-fixture.mjs';
import { LINE_ROWS, weekColumnFor } from '../bff/cashflow-coordinates.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('registered API independent real HTTP / Firestore / DuckDB QA', () => {
  const db = new Firestore({ projectId: 'demo-registered-api-qa' });
  const tenantId = 'registered-api-qa';
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business-api-qa', WORKBENCH_MODEL_PROJECT_ID: 'demo-model-api-qa', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model-api-qa' };
  const core = createIsolatedWorkbenchCore({ db, env, now });
  const analytics = createAnalyticsService({ db, now });
  const app = createWorkbenchApp({ db, env, now, authMode: 'headers' });
  const base = '/api/v1/workbench-apis';
  const headers = (actorId = 'admin-a', key = randomUUID()) => ({ 'x-tenant-id': tenantId, 'x-actor-id': actorId, 'idempotency-key': key });
  const member = (actorId = 'admin-a') => db.doc(`orgs/${tenantId}/members/${actorId}`);
  const definition = (measure = 'total_amount') => ({ name: '실제 입금', description: '사본의 9월 1정산주 매출과 부가세', kind: 'analytics-copy', enabled: true,
    parameters: { month: { type: 'string', required: true, label: '조회 월', example: '2026-09', enum: ['2026-09'] } },
    plan: { datasetId: 'cashflow_inflow', definitionVersion: '1', measures: [measure], time: { yearMonth: { $input: 'month' }, weekNo: 1 }, filters: [
      { field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'sales_with_vat' }, { field: 'currency', op: 'eq', value: 'KRW' },
    ] } });
  const save = (value = definition(), key = randomUUID()) => request(app).post(base).set(headers('admin-a', key)).send({ expectedVersion: 0, definition: value });
  const call = (id: string, version = 1, input: any = { month: '2026-09' }, actor = 'admin-a') => request(app).post(`${base}/${id}/test`).set(headers(actor)).send({ version, input });
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(`orgs/${tenantId}`));
    for (const actorId of ['admin-a', 'admin-b']) await member(actorId).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now(), analyticsDatasetIds: ['cashflow_inflow'], analyticsScopeRevision: 'v1' });
    const context: any = { tenantId, actorId: 'admin-a', actorRole: 'admin' }; await core.authorize(context);
    const matrix = makeInflowFixtureMatrix(2026, '0'); const col = weekColumnFor(2026, '2026-09', 1);
    matrix[LINE_ROWS.actual[3]][col] = '100'; matrix[LINE_ROWS.actual[4]][col] = '10';
    await analytics.importDataset(context, buildCashflowInflowDataset({ yearMonth: '2026-09', weekNos: [1], capturedAt: now(), targets: [
      { projectId: 'good', spreadsheetId: 'sheet-good', sheetName: '사업비', currency: 'KRW', weeklyYear: 2026, matrix },
      { projectId: 'missing', spreadsheetId: 'sheet-missing', sheetName: '사업비', currency: 'KRW', weeklyYear: 2026, failure: 'UNAVAILABLE' },
    ] }));
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(`orgs/${tenantId}`)); await db.terminate(); });

  it('persists registration, compiles the definition and returns native partial/coverage evidence without replacing missing with zero', async () => {
    const created = await save(); expect(created.status).toBe(201);
    const listed = await request(app).get(base).set(headers()); expect(listed.body.items[0].id).toBe(created.body.id);
    const response = await call(created.body.id); expect(response.status).toBe(200);
    expect(response.body.rows[0]).toMatchObject({ total_amount: null, project_count: '2', missing_observation_count: '1' });
    expect(response.body.evidenceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(response.body.metadata.resultScope).toContain('2026-09-01 ~ 2026-09-06');
    const context: any = { tenantId, actorId: 'admin-a', actorRole: 'admin' }; await core.authorize(context);
    expect((await analytics.evidence(context, response.body.evidenceId)).rows).toEqual(response.body.rows);
  });
  it('pins old definitions across edits and blocks every version after disabling latest', async () => {
    const created = await save(); const id = created.body.id;
    const edited = await request(app).put(`${base}/${id}`).set(headers()).send({ expectedVersion: 1, definition: definition('known_amount_total') });
    expect(edited.status).toBe(200); expect(edited.body.version).toBe(2);
    expect((await call(id, 1)).body.rows[0].total_amount).toBeNull();
    expect((await call(id, 2)).body.rows[0].known_amount_total).toBe('110');
    const conflict = await request(app).put(`${base}/${id}`).set(headers()).send({ expectedVersion: 1, definition: definition() }); expect(conflict.status).toBe(409);
    const disabled = await request(app).put(`${base}/${id}`).set(headers()).send({ expectedVersion: 2, definition: { ...definition(), enabled: false } }); expect(disabled.status).toBe(200);
    const response = await call(id, 1); expect(response.status).toBe(409); expect(response.body.error).toBe('registered_api_disabled');
  });
  it('does not expose owner definitions to another admin and denies revoked scope including save replay', async () => {
    const key = randomUUID(); const created = await save(definition(), key);
    const other = await request(app).get(base).set(headers('admin-b')); expect(other.body.items).toEqual([]);
    const otherCall = await call(created.body.id, 1, { month: '2026-09' }, 'admin-b'); expect(otherCall.status).toBeGreaterThanOrEqual(400); expect(otherCall.body.rows).toBeUndefined();
    await member().update({ analyticsDatasetIds: [], analyticsScopeRevision: 'v2' });
    const revoked = await call(created.body.id); expect(revoked.status).toBe(403);
    const replay = await save(definition(), key); expect(replay.status).toBeGreaterThanOrEqual(400); expect(replay.headers['x-idempotency-replayed']).toBeUndefined(); expect(replay.body.definition).toBeUndefined();
  });
  it('rejects unknown semantic metrics, input extras, wrong type and enum values before query execution', async () => {
    const invalid = await save(definition('invented_metric')); expect(invalid.status).toBe(422); expect(invalid.body.error).toBe('semantic_metric_unknown');
    const created = await save(); expect(created.status).toBe(201);
    for (const input of [{ month: 202609 }, { month: '2026-10' }, { month: '2026-09', sql: 'SELECT 1' }, {}]) {
      const response = await call(created.body.id, 1, input); expect(response.status).toBe(400); expect(response.body.error).toBe('registered_api_input_invalid');
    }
  });
});
