import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createProjectCopyProducer, PROJECT_COPY_DATASET } from './project-copy.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { createIsolatedWorkbenchCore } from './core.mjs';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('project source projection → isolated immutable copy → real query', () => {
  const source = new Firestore({ projectId: 'demo-project-copy-source' }), db = new Firestore({ projectId: 'demo-project-copy-target' });
  const tenantId = `project-copy-${randomUUID()}`, prefix = `orgs/${tenantId}`;
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: source.projectId, WORKBENCH_MODEL_PROJECT_ID: 'demo-project-copy-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-source-model', WORKBENCH_COPY_SOURCE_PROJECT_ID: source.projectId, WORKBENCH_TENANT_ID: tenantId, WORKBENCH_PROJECT_COPY_ENABLED: 'true', WORKBENCH_IMPORT_ENABLED: 'true' };
  const core = createIsolatedWorkbenchCore({ db, env });
  const analytics = createAnalyticsService({ db });
  const context = () => ({ tenantId, actorId: 'approved-admin', actorRole: 'admin' });
  const producer = (extra = {}) => createProjectCopyProducer({ source, db, env, authorize: core.authorize, ...extra });
  beforeEach(async () => {
    await Promise.all([source.recursiveDelete(source.doc(prefix)), db.recursiveDelete(db.doc(prefix))]);
    await db.doc(`${prefix}/members/approved-admin`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: new Date().toISOString(), analyticsDatasetIds: [PROJECT_COPY_DATASET], analyticsScopeRevision: 'approved-one-dataset' });
    await source.doc(`${prefix}/projects/doc-a`).set({ id: 'stored-other-id', name: '합성 사업', status: 'RAW_STATUS', contractStart: '2026-03-01', contractEnd: '', contractEndUndecided: false, email: 'excluded@invalid.test', accountNumber: 'excluded' });
  });
  afterAll(async () => { await Promise.all([source.recursiveDelete(source.doc(prefix)), db.recursiveDelete(db.doc(prefix))]); await Promise.all([source.terminate(), db.terminate()]); });
  it('only copies allowed fields, then queries and rereads persisted evidence while source is unchanged', async () => {
    const original = await source.doc(`${prefix}/projects/doc-a`).get();
    const ctx = context(), result = await producer().run(ctx);
    expect(result.rowCount).toBe(1); expect(result.datasetId).toBe(PROJECT_COPY_DATASET);
    const evidence = await analytics.queryPlan(ctx, { kind: 'table', datasetId: PROJECT_COPY_DATASET, select: ['document_id', 'project_id', 'contract_end_raw', 'contract_end', 'contract_end_undecided'] });
    expect(evidence.rows).toEqual([{ document_id: 'doc-a', project_id: 'stored-other-id', contract_end_raw: '', contract_end: null, contract_end_undecided: false }]);
    expect(await analytics.evidence(ctx, evidence.evidenceId)).toEqual(evidence);
    const catalog = await analytics.catalog(ctx);
    expect(catalog.items[0].schema.some((field: any) => ['email', 'accountNumber'].includes(field.name))).toBe(false);
    const after = await source.doc(`${prefix}/projects/doc-a`).get();
    expect(after.data()).toEqual(original.data()); expect(after.updateTime?.isEqual(original.updateTime!)).toBe(true);
  });
  it('keeps the last valid copy when a newer source has an invalid date', async () => {
    const ctx = context(); const before = await producer().run(ctx);
    await source.doc(`${prefix}/projects/doc-a`).update({ contractStart: '2026-02-30' });
    await expect(producer().run(ctx)).rejects.toMatchObject({ code: 'project_copy_date_invalid' });
    expect((await analytics.catalog(ctx)).items[0].version).toBe(before.version);
  });
  it('never imports when permission is revoked after reading or copy is disabled', async () => {
    const ctx = context(); let calls = 0;
    const authorize = async (c: any) => {
      if (++calls === 2) await db.doc(`${prefix}/members/approved-admin`).update({ analyticsDatasetIds: [], analyticsScopeRevision: 'revoked' });
      return core.authorize(c);
    };
    await expect(producer({ authorize }).run(ctx)).rejects.toMatchObject({ code: 'workbench_scope_changed' });
    expect((await db.collection(`${prefix}/axr_analytics`).get()).empty).toBe(true);
    await expect(producer({ env: { ...env, WORKBENCH_PROJECT_COPY_ENABLED: 'false' } }).run(context())).rejects.toMatchObject({ code: 'project_copy_disabled' });
  });
});
