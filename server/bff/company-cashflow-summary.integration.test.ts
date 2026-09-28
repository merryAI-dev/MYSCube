import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { createCompanyCashflowSummary, createCompanySummaryAdmission, COMPANY_SUMMARY_ADMISSION_PATH } from './company-cashflow-summary.mjs';
import { mountJvmWeeklyApiRoutes } from './routes/jvm-weekly-api.mjs';
import { LINE_IDS } from './cashflow-coordinates.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('company summary main BFF and persisted source boundaries', () => {
  const db = createFirestoreDb({ projectId: 'demo-company-summary-main', appName: 'company-summary-main' });
  const context = { tenantId: 'summary-main', actorId: 'admin-a', actorRole: 'admin' };
  const base = `orgs/${context.tenantId}`;
  const control = db.doc(COMPANY_SUMMARY_ADMISSION_PATH);
  const headers = { 'x-tenant-id': context.tenantId, 'x-actor-id': context.actorId, 'x-actor-role': 'admin' };
  function source(id: string, amount: number | null = 0) {
    const mode = () => ({ weeks: [{ weekNo: 1, amounts: amount === null ? {} : { [LINE_IDS[0]]: amount }, weekIn: amount, weekOut: 0, net: amount }], rowTotals: {}, monthTotals: { totalIn: amount, totalOut: 0, net: amount } });
    return { projectId: id, targetRevision: 'fixture-revision', accountingSource: { weeklyYear: 2026 }, readModel: { months: [{ yearMonth: '2026-09', projection: mode(), actual: mode() }] } };
  }
  async function seed(id = 'p1', weeklyYear = 2026) {
    await db.doc(`${base}/projects/${id}`).set({ name: '합성 사업', id: 'untrusted-stored-id', privateField: 'private-never-copy' });
    await db.doc(`${base}/cashflow_sheet_mirrors/${id}`).set({ projectId: id, weeklyYear });
  }
  const options = { db, projectId: 'demo-company-summary-main', authMode: 'headers', jvmWeeklyApiBaseUrl: 'https://jvm.synthetic.invalid', jvmWeeklyApiServiceToken: 'fixture-token', env: { PRODUCT_WORKBENCH_AI_ENABLED: 'false' } };
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(base)); await control.delete();
    await db.doc(`${base}/members/${context.actorId}`).set({ uid: context.actorId, role: 'admin', status: 'ACTIVE' });
    await db.doc(`${base}/members/admin-b`).set({ uid: 'admin-b', role: 'admin', status: 'ACTIVE' });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(base)); await control.delete(); });

  it('actual main route gets native JVM amounts and leaves project/mirror source bytes and updateTime unchanged', async () => {
    await seed(); const paths = [`${base}/projects/p1`, `${base}/cashflow_sheet_mirrors/p1`];
    const before = await Promise.all(paths.map((path) => db.doc(path).get()));
    const fetchImpl = vi.fn(async (url: string, init: any) => {
      expect(new URL(url).pathname).toBe('/api/v1/cashflow/p1'); expect(init.method).toBe('GET'); expect(init.body).toBeUndefined(); return Response.json(source('p1'));
    });
    const res = await request(createBffApp({ ...options, fetchImpl })).get('/api/v1/company-cashflow-summary?yearMonth=2026-09').set(headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200); expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.totals.actual.inflow).toEqual({ value: 0, partialValue: 0, included: 1, excluded: 0, complete: true });
    expect(res.body.rows[0].projectId).toBe('p1'); expect(res.body.rows[0]).not.toHaveProperty('projection');
    expect(JSON.stringify(res.body)).not.toMatch(/private-never-copy|untrusted-stored-id|fixture-token/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const after = await Promise.all(paths.map((path) => db.doc(path).get()));
    after.forEach((doc, i) => { expect(doc.data()).toEqual(before[i].data()); expect(doc.updateTime?.isEqual(before[i].updateTime!)).toBe(true); });
    expect((await control.get()).data()?.active).toHaveLength(0);
  });
  it('rejects nonadmin, missing auth, invalid periods without contacting JVM', async () => {
    await seed(); const fetchImpl = vi.fn(); const api = request(createBffApp({ ...options, fetchImpl }));
    expect((await api.get('/api/v1/company-cashflow-summary?yearMonth=2026-09').set({ ...headers, 'x-actor-role': 'pm' })).status).toBe(403);
    expect((await api.get('/api/v1/company-cashflow-summary?yearMonth=2026-99').set(headers)).status).toBe(400);
    expect((await api.get('/api/v1/company-cashflow-summary?yearMonth=2026-09&weekNo=6').set(headers)).status).toBe(400);
    const unauth = await request(createBffApp({ ...options, authMode: 'firebase_required', fetchImpl })).get('/api/v1/company-cashflow-summary?yearMonth=2026-09'); expect([401, 403]).toContain(unauth.status);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('checks authority after actual upstream returns; revoked results and evidence do not escape', async () => {
    await seed(); const fetchImpl = vi.fn(async () => { await db.doc(`${base}/members/${context.actorId}`).update({ role: 'pm' }); return Response.json(source('p1', 777)); });
    const res = await request(createBffApp({ ...options, fetchImpl })).get('/api/v1/company-cashflow-summary?yearMonth=2026-09').set(headers);
    expect(res.status).toBe(403); expect(JSON.stringify(res.body)).not.toMatch(/777|fixture-revision/); expect(res.body).not.toHaveProperty('rows');
    expect((await control.get()).data()?.active).toHaveLength(0);
  });
  it('coordinate unsupported year and empty native values remain distinct from explicit zero', async () => {
    await seed('p1'); await seed('p2'); await seed('p3', 2025);
    const fetchImpl = vi.fn(async (url: string) => Response.json(source(new URL(url).pathname.split('/').at(-1)!, url.endsWith('/p2') ? null : 0)));
    const res = await request(createBffApp({ ...options, fetchImpl })).get('/api/v1/company-cashflow-summary?yearMonth=2026-09').set(headers);
    expect(res.status, JSON.stringify(res.body)).toBe(200); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(res.body.counts).toMatchObject({ available: 1, notRecorded: 1, outOfScope: 1 });
    expect(res.body.totals.actual.inflow).toMatchObject({ value: null, partialValue: 0, included: 1, excluded: 2, complete: false });
  });
  it('catalog 201 scan cap through real Firestore cannot yield a company total', async () => {
    const batch = db.batch(); for (let i = 0; i < 201; i++) batch.set(db.doc(`${base}/projects/p${String(i).padStart(3, '0')}`), { name: 'synthetic' }); await batch.commit();
    let at = 0; const query = createCompanyCashflowSummary({ db, clock: () => at, readSnapshot: async ({ params }: any) => { at = 21000; return source(params.projectId); } });
    const result = await query(context, { yearMonth: '2026-09' });
    expect(result.catalog).toMatchObject({ complete: false, knownTotal: null, enumeratedCount: 200 }); expect(result.counts.notAttempted).toBe(199);
    expect(result.totals.actual.inflow.value).toBeNull(); expect(result.totals.actual.inflow.partialValue).toBe(0);
  });
  it('two service instances share the separate global2 lease and same-actor restriction', async () => {
    const a = createCompanySummaryAdmission({ db }); const b = createCompanySummaryAdmission({ db });
    const first = await a.acquire(context); const second = await b.acquire({ ...context, actorId: 'admin-b' });
    await expect(a.acquire({ ...context, actorId: 'admin-c' })).rejects.toMatchObject({ statusCode: 429 });
    await expect(b.acquire(context)).rejects.toMatchObject({ statusCode: 429 });
    await first.release(); const third = await b.acquire({ ...context, actorId: 'admin-c' }); await third.release(); await second.release();
    expect((await control.get()).data()?.active).toHaveLength(0);
    expect((await db.doc(`${base}/personal_work_pages/_admission/leases/active`).get()).exists).toBe(false);
  });
  it('late read after HTTP deadline keeps its persisted lease until actual settlement, with zero next reads', async () => {
    await seed('p1'); await seed('p2'); let resolve!: (value: any) => void; let entered!: () => void;
    const started = new Promise<void>((done) => { entered = done; });
    const readSnapshot = vi.fn(() => new Promise((done) => { resolve = done; entered(); }));
    const query = createCompanyCashflowSummary({ db, readSnapshot, responseBudgetMs: 250 });
    const pending = query(context, { yearMonth: '2026-09' }); const outcome = pending.catch((error) => error); await started;
    expect((await outcome).statusCode).toBe(504); expect((await control.get()).data()?.active).toHaveLength(1);
    resolve(source('p1')); await vi.waitFor(async () => expect((await control.get()).data()?.active).toHaveLength(0)); expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
  it('aborted awaited project/mirror read cannot dispatch a later JVM request in the actual read port', async () => {
    await seed(); const controller = new AbortController(); let entered!: () => void; let release!: () => void;
    const ready = new Promise<void>((done) => { entered = done; }); const wait = new Promise<void>((done) => { release = done; });
    const delayedDb = { doc(path: string) { const ref = db.doc(path); return { get: async () => { if (path === `${base}/cashflow_sheet_mirrors/p1`) { entered(); await wait; } return ref.get(); } }; } };
    const fetchImpl = vi.fn(); const app = express();
    const port = mountJvmWeeklyApiRoutes(app, { ...options, db: delayedDb, fetchImpl });
    const pending = port.readCashflowSnapshot({ context, params: { projectId: 'p1' }, query: { yearMonth: '2026-09' }, signal: controller.signal });
    const outcome = pending.catch((error: any) => error); await ready; controller.abort(new Error('synthetic cancelled')); release();
    expect((await outcome).message).toBe('synthetic cancelled'); expect(fetchImpl).not.toHaveBeenCalled();
  });
});
