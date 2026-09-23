import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { Firestore } from '@google-cloud/firestore';
import { createSheetsCopyProducer, SHEETS_READONLY_SCOPE } from './sheets-copy.mjs';
import { makeInflowFixtureMatrix } from './cashflow-inflow-fixture.mjs';
import { LINE_ROWS, weekColumnFor } from '../bff/cashflow-coordinates.mjs';
import { createAnalyticsService } from './analytics-service.mjs';
import { sha256 } from './analytics-contract.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('readonly Sheets producer: actual synthetic HTTP → independent persisted inflow evidence', () => {
  const db = new Firestore({ projectId: 'demo-sheets-copy-producer' });
  const env = { WORKBENCH_PROJECT_ID: db.projectId, PRODUCTION_PROJECT_ID: 'demo-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_IMPORT_ENABLED: 'true', WORKBENCH_SHEETS_COPY_ENABLED: 'true' };
  const context = { tenantId: 'sheets-qa', actorId: 'admin', actorRole: 'admin', analyticsScope: { fingerprint: sha256('sheets-qa'), datasetIds: ['cashflow_inflow'] } };
  const now = () => '2026-09-23T12:00:00.000Z';
  const target = (id = 'good') => ({ projectId: id, spreadsheetId: `sheet-${id}`, sheetName: "사업비 '원본'", weeklyYear: 2026, currency: 'KRW' });
  const period = { yearMonth: '2026-09', weekNos: [1] };
  const plan = { datasetId: 'cashflow_inflow', definitionVersion: '1', measures: ['total_amount', 'known_amount_total'], time: { yearMonth: '2026-09', weekNo: 1 }, filters: [{ field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'sales_with_vat' }, { field: 'currency', op: 'eq', value: 'KRW' }] };
  let server: any, origin: string, handler: any; const received: any[] = [];
  const fetchImpl = (url: any, options: any) => { received.push({ url: String(url), method: options.method, redirect: options.redirect }); return fetch(`${origin}${new URL(url).pathname}${new URL(url).search}`, options); };
  const matrix = () => { const values = makeInflowFixtureMatrix(2026, '0'); const column = weekColumnFor(2026, '2026-09', 1); values[LINE_ROWS.actual[3]][column] = '100'; values[LINE_ROWS.actual[4]][column] = '0'; return values; };
  const create = (extra: any = {}) => createSheetsCopyProducer({ env, db, manifest: { targets: [target()] }, authorize: async () => {}, getToken: async ({ scope }: any) => { expect(scope).toBe(SHEETS_READONLY_SCOPE); return 'synthetic-token'; }, fetchImpl, now, ...extra });
  const service = () => createAnalyticsService({ db, now });
  beforeAll(async () => { server = http.createServer((req, res) => handler(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`; });
  beforeEach(async () => { received.length = 0; await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`)); handler = (req: any, res: any) => { expect(req.method).toBe('GET'); expect(req.headers.authorization).toBe('Bearer synthetic-token'); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ majorDimension: 'ROWS', values: matrix() })); }; });
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(resolve)); await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`)); await db.terminate(); });

  it('reads the fixed escaped range only, persists exact zero and missing-source null and exposes partial evidence', async () => {
    const original = handler; handler = (req: any, res: any) => { if (req.url.includes('sheet-unavailable')) { res.writeHead(503).end(); } else original(req, res); };
    const result = await create({ manifest: { targets: [target(), target('unavailable')] } }).run(context, period);
    expect(result.rowCount).toBe(12); expect(result.sources.map((item: any) => item.status)).toEqual(['OK', 'UNAVAILABLE']);
    const url = new URL(received[0].url); expect(url.origin).toBe('https://sheets.googleapis.com'); expect(decodeURIComponent(url.pathname)).toBe("/v4/spreadsheets/sheet-good/values/'사업비 ''원본'''!A1:BT60");
    expect(Object.fromEntries(url.searchParams)).toEqual({ valueRenderOption: 'FORMATTED_VALUE', majorDimension: 'ROWS' }); expect(received.every(item => item.method === 'GET' && item.redirect === 'error')).toBe(true);
    const evidence = await service().queryPlan(context, plan);
    expect(evidence.rows[0]).toMatchObject({ total_amount: null, known_amount_total: '100', project_count: '2', missing_observation_count: '1' });
    const raw = await service().queryPlan(context, { ...plan, measures: undefined, select: ['project_id', 'source_cells', 'source_status'] });
    expect(JSON.parse(raw.rows.find((row: any) => row.project_id === 'good').source_cells)[1]).toMatchObject({ amount: '0', state: 'ZERO' });
    expect(raw.rows.find((row: any) => row.project_id === 'unavailable').source_status).toBe('UNAVAILABLE');
  });
  it('rejects disabled, extra URL, duplicate and outside-year manifests before token or HTTP work', async () => {
    const getToken = vi.fn();
    await expect(create({ env: { ...env, WORKBENCH_SHEETS_COPY_ENABLED: 'false' }, getToken }).run(context, period)).rejects.toMatchObject({ code: 'sheets_copy_disabled' });
    expect(() => create({ manifest: { targets: [{ ...target(), url: 'https://evil.test' }] } })).toThrow();
    await expect(create({ getToken, manifest: { targets: [target(), target()] } }).run(context, period)).rejects.toMatchObject({ code: 'inflow_duplicate_source' });
    await expect(create({ getToken }).run(context, { yearMonth: '2027-09', weekNos: [1] })).rejects.toThrow();
    expect(getToken).not.toHaveBeenCalled(); expect(received).toHaveLength(0);
  });
  it('rejects template mismatch without replacing a prior valid persisted version', async () => {
    await create().run(context, period); const before = await service().catalog(context);
    handler = (_req: any, res: any) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ values: [['wrong template']] })); };
    await expect(create().run(context, period)).rejects.toThrow();
    expect((await service().catalog(context)).items[0].version).toBe(before.items[0].version);
    expect((await service().queryPlan(context, plan)).rows[0].total_amount).toBe('100');
  });
  it('bounds hung authentication, response bytes and redirects and preserves unavailable rather than zero', async () => {
    const hung = await create({ getToken: () => new Promise(() => {}), limits: { requestMs: 20 } }).run(context, period);
    expect(hung.sources[0].status).toBe('UNAVAILABLE'); expect(received).toHaveLength(0);
    handler = (_req: any, res: any) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ values: [['x'.repeat(300)]] })); };
    const large = await create({ limits: { responseBytes: 100 } }).run(context, period); expect(large.sources[0].status).toBe('UNAVAILABLE');
    handler = (_req: any, res: any) => { res.writeHead(302, { location: `${origin}/redirect-destination` }); res.end(); };
    const redirected = await create().run(context, period); expect(redirected.sources[0].status).toBe('UNAVAILABLE');
    const evidence = await service().queryPlan(context, plan); expect(evidence.rows[0]).toMatchObject({ total_amount: null, known_amount_total: null });
  });
  it('bounds total collection and caller cancellation without importing an unfinished run', async () => {
    handler = (_req: any, _res: any) => {};
    await expect(create({ limits: { totalMs: 30, requestMs: 100 } }).run(context, period)).rejects.toMatchObject({ code: 'sheets_copy_timeout' });
    expect((await service().catalog(context)).items).toHaveLength(0);
    const controller = new AbortController(); controller.abort();
    await expect(create().run(context, period, { signal: controller.signal })).rejects.toMatchObject({ code: 'sheets_copy_timeout' });
    await expect(create({ authorize: () => new Promise(() => {}), limits: { requestMs: 20 } }).run(context, period)).rejects.toMatchObject({ code: 'sheets_copy_timeout' });
  });
  it('uses at most two concurrent requests and prevents import if authorization is revoked after reading', async () => {
    let active = 0, maxActive = 0;
    handler = (_req: any, res: any) => { maxActive = Math.max(maxActive, ++active); setTimeout(() => { active--; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ values: matrix() })); }, 20); };
    await create({ manifest: { targets: [target('a'), target('b'), target('c'), target('d')] } }).run(context, period); expect(maxActive).toBe(2);
    await db.recursiveDelete(db.doc(`orgs/${context.tenantId}`)); let grants = 0;
    await expect(create({ authorize: async () => { if (++grants >= 3) throw Object.assign(new Error('revoked'), { statusCode: 403 }); } }).run(context, period)).rejects.toThrow('revoked');
    expect((await service().catalog(context)).items).toHaveLength(0);
  });
});
