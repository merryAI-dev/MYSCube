import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { createMyscubeLiveApiAdapter, MYSCUBE_LIVE_ORIGIN, requestMyscubeLiveJson } from './myscube-live-api.mjs';
import { createCashflowEvidenceQuery } from '../bff/cashflow-evidence-query.mjs';
import { createExternalApiAdapter } from './external-api.mjs';

const context = { tenantId: 'mysc', actorId: 'admin-a', actorRole: 'admin' };
const env = { WORKBENCH_MYSCUBE_LIVE_ENABLED: 'true' };
const time = '2026-09-28T06:00:00.000Z';
const page = () => ({ items: [{ id: 'p1', name: '합성 사업', status: 'UNKNOWN_NATIVE_STATUS', cic: '', contractStart: '2026-01-01', contractEnd: '', contractEndUndecided: false, updatedAt: time, email: 'private@example.invalid', staffing: [{ phone: 'private-number' }] }], count: 1, nextCursor: null });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const setup = (options = {}) => {
  const transport = vi.fn(async () => page());
  const credentialProvider = vi.fn(async () => 'Bearer synthetic-only-token');
  const authorize = vi.fn(async () => {});
  const adapter = createMyscubeLiveApiAdapter({ env: { ...env }, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }], transport, credentialProvider, now: () => time, ...options });
  return { adapter, authorize, transport: options.transport || transport, credentialProvider: options.credentialProvider || credentialProvider, invoke: (input = {}, extra = {}, ctx = context) => adapter.invoke(ctx, 'myscube-projects', 1, input, { authorize, ...extra }) };
};
async function nativeCashflow() {
  const docs = ['zero', 'empty', 'failed'].map(id => ({ id, exists: true, data: () => ({ name: `합성 ${id}`, cic: 'CIC' }) }));
  const member = { role: 'admin', status: 'ACTIVE' };
  const query = { orderBy: () => query, select: () => query, startAfter: () => query, limit: () => query, get: async () => ({ docs, size: docs.length }) };
  const read = createCashflowEvidenceQuery({ db: { doc: () => ({ get: async () => ({ data: () => member }) }), collection: () => query }, now: () => time,
    readSnapshot: async ({ params }) => {
      if (params.projectId === 'failed') throw Object.assign(new Error('secret upstream detail'), { statusCode: 503 });
      return { projectId: params.projectId, targetRevision: 'synthetic-revision', accountingSource: { weeklyYear: 2026, mirror: {} }, readModel: { months: params.projectId === 'empty' ? [] : [{ yearMonth: '2026-09',
        projection: { rowTotals: { SALES_IN: 0 }, weeks: [{ weekNo: 2, amounts: { SALES_IN: 0 }, weekIn: 0, weekOut: 0, net: 120 }], monthTotals: { totalIn: 0, totalOut: 0, net: 120 } },
        actual: { rowTotals: {}, weeks: [], monthTotals: {} } }] } };
    } });
  return read(context, { yearMonth: '2026-09' }, new AbortController().signal);
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('fixed MYSCube read adapter', () => {
  it('is disabled by default and requires the pinned admin tenant without obtaining a token for discovery', () => {
    const { adapter, credentialProvider } = setup();
    expect(createMyscubeLiveApiAdapter().list(context).items).toEqual([]);
    for (const changed of [{ ...context, tenantId: 'other' }, { ...context, actorRole: 'pm' }, { ...context, actorId: '' }]) expect(adapter.list(changed).items).toEqual([]);
    expect(adapter.list(context).items.map(item => item.id)).toEqual(['myscube-projects', 'myscube-cashflow-evidence']);
    expect(credentialProvider).not.toHaveBeenCalled();
    expect(JSON.stringify(adapter.list(context))).not.toContain('Bearer');
    expect(() => adapter.get(context, 'other', 1)).toThrow();
    expect(() => adapter.get(context, 'myscube-projects', 2)).toThrow();
  });
  it('provides schemas accepted by the existing registered external API contract', () => {
    const { adapter } = setup();
    const definitions = adapter.list(context).items.map(({ contractHash, ...value }) => ({ ...value, url: 'https://fixture.example/read', allowedTenants: ['mysc'] }));
    expect(createExternalApiAdapter({ env: { WORKBENCH_EXTERNAL_ENDPOINTS: JSON.stringify(definitions) } }).list(context).items).toHaveLength(2);
  });
  it('projects exactly 13 approved columns without PII or guessed document metadata', async () => {
    const { invoke, transport, authorize } = setup(); const result = await invoke();
    expect(Object.keys(result.data.items[0])).toHaveLength(13);
    expect(result.data.items[0]).toMatchObject({ document_id: null, project_id: 'p1', project_name: '합성 사업', contract_start: '2026-01-01', contract_end: null, contract_end_raw: '', contract_end_undecided: false, document_updated_at: null, cic: '' });
    expect(JSON.stringify(result)).not.toMatch(/private@example|private-number|synthetic-only-token/);
    expect(result.metadata).toMatchObject({ sourceKind: 'myscube-live', resultScope: 'THIS_PAGE_ONLY', asOf: time });
    expect(result.truncated).toBe(false); expect(authorize).toHaveBeenCalledTimes(3);
    expect(transport.mock.calls[0][0]).toMatchObject({ maxBytes: 256000, address: '8.8.8.8', family: 4, headers: { Authorization: 'Bearer synthetic-only-token', 'x-tenant-id': 'mysc' } });
    expect(transport.mock.calls[0][0].url.href).toBe(`${MYSCUBE_LIVE_ORIGIN}/api/v1/projects?limit=20`);
  });
  it('keeps one bounded page and encodes cursors without accepting URL, auth or extra query keys', async () => {
    const data = { ...page(), nextCursor: 'p1' }; const { invoke, transport } = setup({ transport: vi.fn(async () => data) });
    expect((await invoke({ limit: 1, cursor: 'a?x=&한글' })).truncated).toBe(true);
    expect(transport.mock.calls[0][0].url.searchParams.get('cursor')).toBe('a?x=&한글');
    for (const input of [{ limit: 21 }, { limit: 0 }, { cursor: '../x' }, { cursor: '\r' }, { url: 'http://localhost' }, { authorization: 'x' }]) await expect(invoke(input)).rejects.toMatchObject({ statusCode: 400 });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it('rejects duplicate, over-limit, invalid date, non-string and contradictory pagination responses', async () => {
    for (const change of [data => { data.items.push(data.items[0]); data.count = 2; }, data => { data.count = 3; }, data => { data.nextCursor = 'other'; }, data => { data.items[0].contractStart = '2026-02-30'; }, data => { data.items[0].name = {}; }]) {
      const raw = page(); change(raw); const { invoke } = setup({ transport: async () => raw }); await expect(invoke({ limit: 1 })).rejects.toMatchObject({ statusCode: 502 });
    }
  });
  it('uses the real BFF cashflow producer and preserves zero, absent and failed independently', async () => {
    const raw = await nativeCashflow(); const { adapter, authorize } = setup({ transport: async () => raw });
    const result = await adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize });
    expect(result.data.rows.map(row => row.status)).toEqual(['AVAILABLE', 'NOT_RECORDED', 'FAILED']);
    expect(result.data.rows[0].projection.inflow).toBe(0); expect(result.data.rows[1].projection.inflow).toBeNull(); expect(result.data.rows[2].projection).toBeNull();
    expect(result.data.rows[0].evidence.projection).toEqual(raw.rows[0].evidence.projection);
    expect(result.data.rows[0].evidence.source).toMatchObject({ authority: 'JVM', freshness: 'UNKNOWN', liveSheetVerified: false, capturedAt: null });
    expect(result.data.totals).toEqual(raw.totals); expect(result.data.totalsScope).toBe('THIS_PAGE_ONLY');
    expect(result.data.rows[0].evidence.fieldStateAvailability).toBe('NOT_EXPOSED');
    expect(JSON.stringify(result)).not.toContain('secret upstream detail');
  });
  it('compares calendar dates across every available project and does not infer a calendar from absent records', async () => {
    for (const mismatch of [false, true]) {
      const raw = await nativeCashflow();
      const second = structuredClone(raw.rows[0]); second.projectId = 'second'; second.evidence.projectId = 'second';
      if (mismatch) for (const mode of ['projection', 'actual']) second.evidence[mode][0].start = '2026-09-02';
      raw.rows.push(second); raw.accessibleInPage++; raw.available++;
      for (const mode of ['projection', 'actual', 'difference']) for (const field of ['inflow', 'outflow', 'cumulativeBalance']) {
        const amount = raw.totals[mode][field];
        if (second[mode][field] === null) amount.excluded++;
        else { amount.included++; amount.value = (amount.value ?? 0) + second[mode][field]; }
      }
      const { adapter, authorize } = setup({ transport: async () => raw });
      const result = await adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize });
      expect(result.metadata.weekCalendarUniform).toBe(!mismatch);
      expect(result.metadata.accessibleInPage).toBe(4);
    }
    const raw = await nativeCashflow(); raw.rows = []; raw.accessibleInPage = raw.available = raw.notRecorded = raw.failed = 0;
    for (const mode of Object.values(raw.totals)) for (const field of Object.values(mode)) Object.assign(field, { value: null, included: 0, excluded: 0 });
    const { adapter, authorize } = setup({ transport: async () => raw });
    const result = await adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize });
    expect(result.metadata.weekCalendarUniform).toBeNull();
  });
  it('rejects cashflow wrong period, unsafe money, inconsistent weeks and false completeness', async () => {
    const base = await nativeCashflow();
    for (const change of [data => { data.yearMonth = '2026-10'; }, data => { data.rows[0].projection.inflow = Number.MAX_SAFE_INTEGER + 1; }, data => { data.rows[0].evidence.actual[0].weekNo = 5; }, data => { data.catalogComplete = false; }, data => { data.rows[0].evidence.source.liveSheetVerified = true; }, data => { data.rows[0].missingWeeks.projection = []; }]) {
      const raw = structuredClone(base); change(raw); const { adapter, authorize } = setup({ transport: async () => raw });
      await expect(adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize })).rejects.toMatchObject({ statusCode: 502 });
    }
  });
  it('rejects any private DNS answer before retrieving credentials or making a request', async () => {
    const { invoke, transport, credentialProvider } = setup({ resolveDns: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
    await expect(invoke()).rejects.toMatchObject({ statusCode: 403 }); expect(transport).not.toHaveBeenCalled(); expect(credentialProvider).not.toHaveBeenCalled();
  });
  it('drops responses on revoked authorization and sanitizes all upstream error details', async () => {
    const { invoke, transport } = setup(); let count = 0;
    await expect(invoke({}, { authorize: async () => { if (++count === 3) throw Object.assign(new Error('secret revoke'), { statusCode: 403 }); } })).rejects.toMatchObject({ statusCode: 403 });
    expect(transport).toHaveBeenCalledTimes(1);
    for (const statusCode of [401, 403, 502]) {
      const instance = setup({ transport: async () => { throw Object.assign(new Error('SECRET bearer upstream body'), { statusCode }); } });
      try { await instance.invoke(); throw new Error('expected rejection'); } catch (error) { expect(error.statusCode).toBe(statusCode); expect(error.message).not.toContain('SECRET'); }
    }
  });
  it('limits global concurrency to two and one per actor without queuing', async () => {
    const pending = deferred(); const { invoke, transport } = setup({ transport: vi.fn(() => pending.promise) });
    const first = invoke(); await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    await expect(invoke()).rejects.toMatchObject({ statusCode: 429 });
    const second = invoke({}, {}, { ...context, actorId: 'admin-b' }); await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    await expect(invoke({}, {}, { ...context, actorId: 'admin-c' })).rejects.toMatchObject({ statusCode: 429 });
    pending.resolve(page()); await Promise.all([first, second]); await expect(invoke()).resolves.toHaveProperty('data');
  });
  it('aborts stalled DNS and credential resolution with zero GET and frees non-network capacity', async () => {
    for (const stage of ['resolveDns', 'credentialProvider']) {
      const pending = deferred(), controller = new AbortController(); const options = { [stage]: vi.fn(() => pending.promise) }; const { invoke, transport } = setup(options);
      const result = invoke({}, { signal: controller.signal }); await vi.waitFor(() => expect(options[stage]).toHaveBeenCalled()); controller.abort();
      await expect(result).rejects.toMatchObject({ statusCode: 504 }); expect(transport).not.toHaveBeenCalled();
      pending.resolve(stage === 'resolveDns' ? [{ address: '8.8.8.8', family: 4 }] : 'Bearer synthetic');
      await expect(invoke()).resolves.toHaveProperty('data');
    }
  });
  it('retains admission until an aborted network promise actually settles', async () => {
    const pending = deferred(), controller = new AbortController(); const { invoke, transport } = setup({ transport: vi.fn(() => pending.promise) });
    const result = invoke({}, { signal: controller.signal }); await vi.waitFor(() => expect(transport).toHaveBeenCalled()); controller.abort();
    await expect(result).rejects.toMatchObject({ statusCode: 504 }); expect(transport.mock.calls[0][0].signal.aborted).toBe(true);
    await expect(invoke()).rejects.toMatchObject({ statusCode: 429 }); pending.resolve(page()); await new Promise(resolve => setImmediate(resolve)); await expect(invoke()).resolves.toHaveProperty('data');
  });
  it('applies a total ten-second deadline before GET and after delayed response validation', async () => {
    vi.useFakeTimers(); const waiting = setup({ resolveDns: () => new Promise(() => {}) });
    const rejected = expect(waiting.invoke()).rejects.toMatchObject({ statusCode: 504 }); await vi.advanceTimersByTimeAsync(10000); await rejected; expect(waiting.transport).not.toHaveBeenCalled();
    vi.useRealTimers(); let clock = 0; vi.spyOn(performance, 'now').mockImplementation(() => clock);
    const late = setup({ transport: async () => { clock = 10001; return page(); } }); await expect(late.invoke()).rejects.toMatchObject({ statusCode: 504 });
  });
  it('bounds actor and global request frequency on a monotonic sliding window', async () => {
    let clock = 60000; const one = setup({ monotonicNow: () => clock });
    for (let i = 0; i < 12; i++) await one.invoke();
    await expect(one.invoke()).rejects.toMatchObject({ code: 'myscube_live_rate_limited' });
    clock = 0; await expect(one.invoke()).rejects.toMatchObject({ statusCode: 429 });
    clock = 120000; await expect(one.invoke()).resolves.toHaveProperty('data');
    const many = setup({ monotonicNow: () => 0 });
    for (let i = 0; i < 60; i++) await many.invoke({}, {}, { ...context, actorId: `actor-${i}` });
    await expect(many.invoke({}, {}, { ...context, actorId: 'actor-last' })).rejects.toMatchObject({ code: 'myscube_live_rate_limited' });
    expect(many.transport).toHaveBeenCalledTimes(60);
  });
  it('retains failed cashflow admission through the known 25-second upstream budget after user abort', async () => {
    let clock = 0; const timers = [], pending = deferred(), controller = new AbortController();
    const transport = vi.fn(() => pending.promise);
    const { adapter, authorize } = setup({ transport, monotonicNow: () => clock, schedule: (callback, delay) => { timers.push({ callback, delay }); return { unref: () => {} }; } });
    const invoke = () => adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize, signal: controller.signal });
    const result = invoke(); await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1)); clock = 10000; controller.abort();
    await expect(result).rejects.toMatchObject({ statusCode: 504, details: { sourceWorkMayContinue: true, sourceBudgetMs: 25000, retryAfterMs: 15000 } });
    pending.resolve(await nativeCashflow()); await new Promise(resolve => setImmediate(resolve)); expect(timers[0].delay).toBe(15000);
    await expect(adapter.invoke(context, 'myscube-projects', 1, {}, { authorize })).rejects.toMatchObject({ statusCode: 429 });
    clock = 24999; timers.shift().callback(); expect(timers[0].delay).toBe(1);
    clock = 25000; timers.shift().callback(); transport.mockResolvedValue(page());
    await expect(adapter.invoke(context, 'myscube-projects', 1, {}, { authorize })).resolves.toHaveProperty('data');
  });
  it.each([401, 403, 400, 404, 429, 500])('releases completed HTTP %s responses so two denials cannot block a third caller', async statusCode => {
    const schedule = vi.fn(), transport = vi.fn().mockRejectedValue(Object.assign(new Error('completed response'), { statusCode }));
    const { adapter, authorize } = setup({ schedule, transport });
    for (const actorId of ['first', 'second', 'third']) {
      const error = await adapter.invoke({ ...context, actorId }, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize }).catch(error => error);
      expect(error.code).not.toBe('myscube_live_busy'); expect(error.details).toBeUndefined();
    }
    expect(transport).toHaveBeenCalledTimes(3); expect(schedule).not.toHaveBeenCalled();
  });
  it.each([502, 503, 504, undefined])('retains the upstream budget for gateway/network status %s', async statusCode => {
    const schedule = vi.fn(), transport = vi.fn().mockRejectedValue(Object.assign(new Error('upstream uncertain'), { statusCode }));
    const { adapter, authorize } = setup({ schedule, transport, monotonicNow: () => 0 });
    const error = await adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize }).catch(error => error);
    expect(error.details).toMatchObject({ sourceWorkMayContinue: true, retryAfterMs: 25000 });
    expect(schedule).toHaveBeenCalledWith(expect.any(Function), 25000);
    await expect(adapter.invoke(context, 'myscube-projects', 1, {}, { authorize })).rejects.toMatchObject({ code: 'myscube_live_busy' });
  });
  it('releases successful cashflow without imposing the failure cooldown', async () => {
    const schedule = vi.fn(), raw = await nativeCashflow(); const { adapter, authorize } = setup({ schedule, transport: async () => raw });
    for (let i = 0; i < 2; i++) await expect(adapter.invoke(context, 'myscube-cashflow-evidence', 1, { yearMonth: '2026-09' }, { authorize })).resolves.toHaveProperty('data');
    expect(schedule).not.toHaveBeenCalled();
  });
  it('does not settle an HTTP rejection until the actual request closes', async () => {
    const req = new EventEmitter(); req.end = () => {}; let receive;
    const result = requestMyscubeLiveJson({ url: new URL(`${MYSCUBE_LIVE_ORIGIN}/api/v1/projects`), address: '8.8.8.8', family: 4, headers: {}, signal: new AbortController().signal }, (_url, _settings, callback) => { receive = callback; return req; });
    let settled = false; const observed = result.then(() => { settled = true; }, error => { settled = true; return error; });
    receive({ statusCode: 403, destroy: () => {}, headers: {} });
    await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false);
    req.emit('close'); expect(await observed).toMatchObject({ statusCode: 403 }); expect(settled).toBe(true);
  });
  it('rejects overlarge raw responses even when the selected projection would be small', async () => {
    const { invoke } = setup({ transport: async () => ({ ...page(), omitted: 'x'.repeat(256000) }) }); await expect(invoke()).rejects.toMatchObject({ statusCode: 413 });
  });
});

describe('actual local HTTPS fixture through the fixed adapter transport', () => {
  let folder, server, ca, port, reply; const calls = [];
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'axr-myscube-live-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=myscube.myscguard.app', '-addext', 'subjectAltName=DNS:myscube.myscguard.app', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem')], { stdio: 'ignore' });
    ca = await readFile(join(folder, 'cert.pem')); server = https.createServer({ key: await readFile(join(folder, 'key.pem')), cert: ca }, (req, res) => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, tenant: req.headers['x-tenant-id'] }); reply(req, res);
    }).listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); port = server.address().port;
  });
  afterAll(async () => { server?.closeAllConnections(); if (server) await new Promise(resolve => server.close(resolve)); if (folder) await rm(folder, { recursive: true, force: true }); });
  const fixture = () => setup({ transport: options => requestMyscubeLiveJson(options, (url, settings, callback) => {
    expect(url.origin).toBe(MYSCUBE_LIVE_ORIGIN); expect(settings.servername).toBe('myscube.myscguard.app');
    return https.request(new URL(`${url.pathname}${url.search}`, `https://myscube.myscguard.app:${port}`), { ...settings, ca, lookup: (_host, lookupOptions, done) => lookupOptions?.all ? done(null, [{ address: '127.0.0.1', family: 4 }]) : done(null, '127.0.0.1', 4) }, callback);
  }) });
  it('reads projected GET JSON with validated TLS hostname and no credential in the result', async () => {
    reply = (_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(page())); };
    expect((await fixture().invoke()).data.items[0].project_id).toBe('p1'); expect(calls.at(-1)).toEqual({ method: 'GET', url: '/api/v1/projects?limit=20', auth: 'Bearer synthetic-only-token', tenant: 'mysc' });
  });
  it('preserves real upstream 401/403 status and never exposes HTML bodies or follows redirects', async () => {
    for (const status of [401, 403, 302, 500]) {
      const before = calls.length; reply = (_req, res) => { res.writeHead(status, { 'content-type': 'text/html', location: 'http://169.254.169.254/latest' }); res.end('PRIVATE HTML DATA'); };
      try { await fixture().invoke(); throw new Error('expected rejection'); } catch (error) { expect(error.statusCode).toBe([401, 403].includes(status) ? status : 502); expect(error.message).not.toContain('PRIVATE'); }
      expect(calls.length).toBe(before + 1);
    }
  });
  it('rejects streamed oversized bodies, invalid JSON and unexpected content type', async () => {
    for (const [type, body] of [['application/json', JSON.stringify({ value: 'x'.repeat(260000) })], ['application/json', '{'], ['text/html', '<html>PRIVATE</html>']]) {
      reply = (_req, res) => { res.writeHead(200, { 'content-type': type }); res.end(body); };
      await expect(fixture().invoke()).rejects.toMatchObject({ statusCode: 502 });
    }
  });
});
