import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createCompanyCashflowSummary, createCompanySummaryAdmission, summarizeCompanyCashflowRows, COMPANY_SUMMARY_LIMITS } from './company-cashflow-summary.mjs';
import { accountingEvidence } from '../mcp/accounting-read.mjs';
import { LINE_IDS } from './cashflow-coordinates.mjs';

const context = { tenantId: 'synthetic', actorId: 'a', actorRole: 'admin' };
export function snapshot(id = 'p1', value = 0, monthly = value) {
  const mode = () => ({ weeks: [{ weekNo: 1, amounts: { [LINE_IDS[0]]: value }, weekIn: value, weekOut: 0, net: value }], rowTotals: {}, monthTotals: { totalIn: monthly, totalOut: 0, net: monthly } });
  return { projectId: id, targetRevision: 'synthetic-r1', accountingSource: { weeklyYear: 2026 }, readModel: { months: [{ yearMonth: '2026-09', projection: mode(), actual: mode() }] } };
}
function fakeDb(ids = ['p1']) {
  let member = { uid: 'a', role: 'admin', status: 'ACTIVE' };
  let control;
  const page = () => ({ size: ids.length, readTime: { toDate: () => new Date('2026-09-28T00:00:00Z') }, docs: ids.map((id) => ({ id, exists: true, data: () => ({}) })) });
  return { setMember: (value) => { member = value; }, setIds: (value) => { ids = value; }, getControl: () => control,
    doc: (path) => ({ path, get: async () => ({ data: () => member }) }),
    collection: () => { const query = { orderBy: () => query, select: () => query, limit: () => query, get: async () => page() }; return query; },
    runTransaction: async (fn) => fn({ get: async () => ({ data: () => control }), set: (_ref, value) => { control = value; } }),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));
afterEach(() => vi.useRealTimers());

describe('bounded company cashflow summary', () => {
  it('uses native monthly values, preserves zero/null and never invents month from weeks', async () => {
    const readSnapshot = vi.fn(async ({ params }) => snapshot(params.projectId, 0, 99));
    const result = await createCompanyCashflowSummary({ db: fakeDb(), readSnapshot })(context, { yearMonth: '2026-09' });
    expect(result.totals.actual.inflow).toEqual({ value: 99, partialValue: 99, included: 1, excluded: 0, complete: true });
    expect(result.weeks[0].totals.actual.inflow.value).toBe(0);
    expect(result.weeks[1].totals.actual.inflow).toMatchObject({ value: null, partialValue: null, included: 0, excluded: 1 });
    expect(result).toMatchObject({ catalogComplete: true, readWindow: { atomicSnapshot: false }, liveSheetVerified: false });
  });
  it('turns failed or outside-year projects into exclusions, never zero or whole totals', async () => {
    const query = createCompanyCashflowSummary({ db: fakeDb(['p1', 'p2', 'p3']), readSnapshot: async ({ params }) => {
      if (params.projectId === 'p2') throw new Error('private source message');
      const data = snapshot(params.projectId); if (params.projectId === 'p3') data.accountingSource.weeklyYear = 2025; return data;
    } });
    const result = await query(context, { yearMonth: '2026-09' });
    expect(result.counts).toMatchObject({ available: 1, failed: 1, outOfScope: 1 });
    expect(result.totals.actual.inflow).toMatchObject({ value: null, partialValue: 0, included: 1, excluded: 2, complete: false });
    expect(JSON.stringify(result)).not.toContain('private source');
  });
  it('makes only the mismatched week totals null and does not alter native month totals', () => {
    const evidence = accountingEvidence(snapshot(), { projectId: 'p1', yearMonth: '2026-09' });
    evidence.actual[0].start = '2026-09-03';
    const result = summarizeCompanyCashflowRows({ rows: [{ evidence, weeklyYear: 2026 }], yearMonth: '2026-09', catalogComplete: true });
    expect(result.weekCalendarUniform).toBe(false); expect(result.weeks[0].totals).toBeNull();
    expect(result.weeks[1].weekCalendarUniform).toBe(true); expect(result.totals.actual.inflow.value).toBe(0);
  });
  it('rejects duplicate/missing calendar evidence and unsafe aggregate overflow', () => {
    const evidence = accountingEvidence(snapshot('p1', Number.MAX_SAFE_INTEGER), { projectId: 'p1', yearMonth: '2026-09' });
    expect(() => summarizeCompanyCashflowRows({ rows: [{ evidence, weeklyYear: 2026 }, { evidence, weeklyYear: 2026 }], yearMonth: '2026-09', catalogComplete: true })).toThrow('지원 범위');
    evidence.actual.push(evidence.actual[0]);
    expect(summarizeCompanyCashflowRows({ rows: [{ evidence, weeklyYear: 2026 }], yearMonth: '2026-09', weekNo: 1, catalogComplete: true }).totals).toBeNull();
  });
  it('validates period and role before any source call; absent months remain unrecorded', async () => {
    const readSnapshot = vi.fn(async () => ({ ...snapshot(), readModel: { months: [] } })); const query = createCompanyCashflowSummary({ db: fakeDb(), readSnapshot });
    for (const input of [{ yearMonth: '2026-13' }, { yearMonth: '2026-09', weekNo: '6' }, { yearMonth: '2026-09', url: 'secret' }]) await expect(query(context, input)).rejects.toMatchObject({ statusCode: 400 });
    await expect(query({ ...context, actorRole: 'finance' }, { yearMonth: '2026-09' })).rejects.toMatchObject({ statusCode: 403 });
    expect(readSnapshot).not.toHaveBeenCalled();
    const result = await query(context, { yearMonth: '2026-09' }); expect(result.counts.notRecorded).toBe(1); expect(result.totals.actual.inflow.partialValue).toBeNull();
  });
  it('stops starting new reads at 20s but waits the current read and validates final authority', async () => {
    let clock = 0; const db = fakeDb(['p1', 'p2']); const readSnapshot = vi.fn(async ({ params }) => { clock = 21000; return snapshot(params.projectId); });
    const result = await createCompanyCashflowSummary({ db, readSnapshot, clock: () => clock })(context, { yearMonth: '2026-09' });
    expect(readSnapshot).toHaveBeenCalledTimes(1); expect(result.counts.notAttempted).toBe(1); expect(result.totals.actual.inflow.value).toBeNull(); expect(db.getControl().active).toHaveLength(0);
  });
  it('retains admission after timed-out HTTP until the real read settles; never starts next read', async () => {
    vi.useFakeTimers(); let settle; const db = fakeDb(['p1', 'p2']);
    const readSnapshot = vi.fn(() => new Promise((resolve) => { settle = resolve; }));
    const pending = createCompanyCashflowSummary({ db, readSnapshot, responseBudgetMs: 50 })(context, { yearMonth: '2026-09' });
    const rejected = expect(pending).rejects.toMatchObject({ statusCode: 504 });
    await vi.advanceTimersByTimeAsync(51); await rejected;
    expect(db.getControl().active).toHaveLength(1); expect(readSnapshot).toHaveBeenCalledTimes(1);
    settle(snapshot()); await vi.advanceTimersByTimeAsync(0);
    expect(db.getControl().active).toHaveLength(0); expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
  it('aborting while membership is pending never acquires/starts a source read', async () => {
    const db = fakeDb(); let finish; db.doc = () => ({ get: () => new Promise((resolve) => { finish = resolve; }) });
    const readSnapshot = vi.fn(); const controller = new AbortController(); const query = createCompanyCashflowSummary({ db, readSnapshot });
    const pending = query(context, { yearMonth: '2026-09' }, controller.signal); const caught = pending.catch((error) => error);
    controller.abort(new Error('test abort')); finish({ data: () => ({ role: 'admin', status: 'ACTIVE' }) }); await caught; await tick(); expect(readSnapshot).not.toHaveBeenCalled();
  });
  it('revocation or catalog mutation never produces a complete total', async () => {
    const db = fakeDb(); const query = createCompanyCashflowSummary({ db, readSnapshot: async () => { db.setMember({ role: 'pm', status: 'ACTIVE' }); return snapshot(); } });
    await expect(query(context, { yearMonth: '2026-09' })).rejects.toMatchObject({ statusCode: 403 }); expect(db.getControl().active).toHaveLength(0);
    const changed = fakeDb(); const result = await createCompanyCashflowSummary({ db: changed, readSnapshot: async () => { changed.setIds(['p1', 'p2']); return snapshot(); } })(context, { yearMonth: '2026-09' });
    expect(result.catalogComplete).toBe(false); expect(result.totals.actual.inflow.value).toBeNull();
  });
  it('201st catalog document forbids complete claims and remains outside the bounded worker', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`); const readSnapshot = vi.fn(async ({ params }) => snapshot(params.projectId));
    const result = await createCompanyCashflowSummary({ db: fakeDb(ids), readSnapshot })(context, { yearMonth: '2026-09' });
    expect(readSnapshot).toHaveBeenCalledTimes(200); expect(result.catalog).toMatchObject({ complete: false, knownTotal: null, enumeratedCount: 200 });
    expect(result.totals.actual.inflow).toMatchObject({ value: null, partialValue: 0, included: 200, excluded: 0, complete: false });
  });
  it('200 compact maximum-length ASCII rows remain bounded; oversized Unicode evidence rejects the entire output', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `p${String(i).padStart(3, '0')}${'x'.repeat(96)}`);
    const readSnapshot = async ({ params }) => ({ ...snapshot(params.projectId, 1234567890), targetRevision: 'r'.repeat(200) });
    const result = await createCompanyCashflowSummary({ db: fakeDb(ids), readSnapshot })(context, { yearMonth: '2026-09' });
    expect(result.rows).toHaveLength(200); expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(256000);
    expect(result.rows[0]).not.toHaveProperty('actual'); expect(result.rows[0].periodTotals.difference).not.toHaveProperty('weekNo');
    const huge = Array.from({ length: 200 }, (_, i) => `${String(i).padStart(3, '0')}${'한'.repeat(97)}`);
    const db = fakeDb(huge);
    await expect(createCompanyCashflowSummary({ db, readSnapshot: async ({ params }) => ({ ...snapshot(params.projectId), targetRevision: '한'.repeat(200) }) })(context, { yearMonth: '2026-09' })).rejects.toMatchObject({ code: 'company_summary_response_too_large' });
    expect(db.getControl().active).toHaveLength(0);
  });
  it('week rows use only the three money keys and unknown weeks never turn into monthly values', async () => {
    const result = await createCompanyCashflowSummary({ db: fakeDb(), readSnapshot: async () => snapshot('p1', 7, 99) })(context, { yearMonth: '2026-09', weekNo: '1' });
    expect(result.totals.actual.inflow.value).toBe(7); expect(Object.keys(result.rows[0].periodTotals.difference)).toEqual(['inflow', 'outflow', 'cumulativeBalance']);
  });
  it('uses separate bounded shared admission, exact 360s expiry, no early release on clock rewind', async () => {
    const db = fakeDb(); let at = 0; const admission = createCompanySummaryAdmission({ db, clock: () => at });
    const first = await admission.acquire(context); await expect(admission.acquire(context)).rejects.toMatchObject({ statusCode: 429 });
    await admission.acquire({ ...context, actorId: 'b' });
    at = -100; await expect(admission.acquire({ ...context, actorId: 'c' })).rejects.toMatchObject({ statusCode: 429 });
    at = 359999; await expect(admission.acquire({ ...context, actorId: 'c' })).rejects.toMatchObject({ statusCode: 429 });
    at = 360000; await admission.acquire({ ...context, actorId: 'c' }); await first.release(); expect(db.getControl().active).toHaveLength(1);
  });
  it('normal release is immediate, rate reservations remain bounded separately', async () => {
    const db = fakeDb(); const admission = createCompanySummaryAdmission({ db, clock: () => 0 });
    for (let i = 0; i < 2; i++) { const lease = await admission.acquire(context); await lease.release(); }
    expect(db.getControl().active).toHaveLength(0); await expect(admission.acquire(context)).rejects.toMatchObject({ statusCode: 429 });
    expect(db.getControl().recent).toHaveLength(2);
  });
  it('pins the deployed function maximum shorter than the fallback admission lifetime', () => {
    const config = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
    expect(config.functions['api/bff.js'].maxDuration).toBe(300); expect(COMPANY_SUMMARY_LIMITS.leaseMs).toBeGreaterThan(300000);
  });
});
