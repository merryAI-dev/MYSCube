import { Firestore } from '@google-cloud/firestore';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { importHttpLogExport } from './http-log-import.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('independent offline HTTP import atomicity and identity', () => {
  const db = new Firestore({ projectId: 'demo-http-import-qa' }), tenantId = 'http-import-qa', root = `orgs/${tenantId}`;
  const now = () => '2026-09-23T12:00:00.000Z';
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business-http-qa',
    WORKBENCH_MODEL_PROJECT_ID: 'demo-http-model-qa', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model-qa',
    WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'true', WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID: 'prj_http_fixture', WORKBENCH_TENANT_ID: tenantId };
  function entry(id: string, overrides: Record<string, unknown> = {}) {
    return { id, deploymentId: 'dpl_test', source: 'lambda', host: 'fixture.invalid', timestamp: Date.parse('2026-09-22T15:00:00.000Z'),
      projectId: env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID, level: 'info', type: 'stdout', environment: 'production',
      message: JSON.stringify({ message: 'bff.request', service: 'mysc-bff', method: 'POST', path: '/api/v1/project-registration-drafts/private-email%40example.test/submit',
        statusCode: 200, latencyMs: 0, tenantId, requestId: 'private-request-sentinel', actorId: 'private-actor-sentinel', ...overrides }) };
  }
  const input = (entries: any[]) => ({ schemaVersion: 1, sourceSystem: 'vercel', sourceProjectId: env.WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID,
    tenantId, exportedAt: now(), period: { from: '2026-09-22T00:00:00.000Z', to: now() }, coverage: 'partial', entries });
  const run = (value: any, configuration = env) => importHttpLogExport({ db, env: configuration, input: value, now });
  async function stored() {
    const [rows, receipts] = await Promise.all([db.collection(`${root}/workbench_http_requests`).get(), db.collection(`${root}/workbench_http_imports`).get()]);
    return { rows: rows.docs.map(doc => doc.data()), receipts: receipts.docs.map(doc => doc.data()) };
  }
  beforeEach(async () => { await db.recursiveDelete(db.doc(root)); });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('deduplicates overlapping export records while preserving distinct attempts with the same caller request ID', async () => {
    const first = input([entry('log-a')]); await run(first); await run(first);
    await run(input([entry('log-a'), entry('log-b', { statusCode: 500 })]));
    const result = await stored(); expect(result.rows).toHaveLength(2);
    const text = JSON.stringify(result);
    for (const secret of ['private-request-sentinel', 'private-actor-sentinel', 'private-email', '/api/v1/project-registration-drafts/']) expect(text).not.toContain(secret);
  });
  it('rolls back a new record when another source identity conflicts with an existing record', async () => {
    await run(input([entry('log-a')])); const before = await stored();
    await expect(run(input([entry('new-record'), entry('log-a', { statusCode: 500 })]))).rejects.toBeDefined();
    expect(await stored()).toEqual(before);
  });
  it('rejects the entire file when its final record belongs to another tenant', async () => {
    await expect(run(input([entry('valid'), entry('wrong-tenant', { tenantId: 'another-tenant' })]))).rejects.toBeDefined();
    expect(await stored()).toEqual({ rows: [], receipts: [] });
  });
  it('rejects missing native identity, future time, and the exclusive end boundary before writes', async () => {
    for (const bad of [{ ...entry('missing'), id: undefined }, { ...entry('future'), timestamp: Date.parse(now()) + 1 }, { ...entry('end'), timestamp: Date.parse(now()) }]) {
      await expect(run(input([bad]))).rejects.toBeDefined();
      expect(await stored()).toEqual({ rows: [], receipts: [] });
    }
  });
  it('rejects source mismatches, disabled imports and production target configuration', async () => {
    await expect(run({ ...input([entry('a')]), sourceProjectId: 'another-project' })).rejects.toBeDefined();
    await expect(run(input([entry('a')]), { ...env, WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'false' })).rejects.toBeDefined();
    await expect(run(input([entry('a')]), { ...env, PRODUCTION_PROJECT_ID: db.projectId })).rejects.toBeDefined();
    expect(await stored()).toEqual({ rows: [], receipts: [] });
  });
  it('keeps concurrent identical imports at one immutable observation', async () => {
    const value = input([entry('a')]); const results = await Promise.allSettled([run(value), run(value)]);
    expect(results.every(result => result.status === 'fulfilled')).toBe(true);
    expect((await stored()).rows).toHaveLength(1); expect((await stored()).receipts).toHaveLength(1);
  });
});
