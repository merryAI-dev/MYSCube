import { it, expect, vi } from 'vitest';
import { createAccountingReportTool, summarizeAccountingRows } from './accounting-report.mjs';
import { classifyReadError } from './support-read.mjs';

function setup(count = 6, fail = new Map()) {
  const projects = Array.from({ length: count }, (_, i) => ({ id: `p${String(i).padStart(3, '0')}`,
    data: () => ({ name: '동명 사업', cic: i % 2 ? 'CIC1' : 'CIC2' }) }));
  let cursor;
  const query = { orderBy: () => { cursor = undefined; return query; }, select: () => query, startAfter: (id) => { cursor = id; return query; },
    limit: (n) => ({ get: async () => ({ docs: projects.filter((p) => !cursor || p.id > cursor).slice(0, n) }) }) };
  const db = { collection: () => query, doc: () => ({ get: async () => ({ data: () => ({ status: 'ACTIVE' }) }) }) };
  let active = 0, peak = 0;
  const readSnapshot = vi.fn(async ({ params }) => {
    active++; peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    if (fail.has(params.projectId)) throw fail.get(params.projectId);
    const mode = { rowTotals: {}, monthTotals: { totalIn: 10, totalOut: -2, net: 12 },
      weeks: [{ weekNo: 1, amounts: { SALES_IN: 10 }, weekIn: 10, weekOut: -2, net: 12 }] };
    return { projectId: params.projectId, targetRevision: 'rev', accountingSource: { weeklyYear: 2026 },
      readModel: { months: [{ yearMonth: '2026-09', projection: mode, actual: mode }] } };
  });
  const authorize = vi.fn(async () => ({ tenantId: 'mysc', actorId: 'actor', actorRole: 'auditor' }));
  return { tool: createAccountingReportTool({ db, readSnapshot, authorize }), readSnapshot, authorize, peak: () => peak };
}

it('reads all registered projects with bounded concurrency, distinct IDs and KRW sums', async () => {
  const run = setup();
  const result = await run.tool.execute({ yearMonth: '2026-09', weekNo: 1 }, { signal: AbortSignal.timeout(5000) });
  expect(result).toMatchObject({ found: 6, wholeCatalog: true, allReadsSucceeded: true, amountCurrency: 'KRW', atomicSnapshot: false });
  expect(result.totals.projection.inflow).toEqual({ value: 60, included: 6, excluded: 0 });
  expect(result.totals.actual.outflow.value).toBe(-12);
  expect(result.totals.difference.inflow.value).toBe(0);
  expect(result.groups).toHaveLength(2);
  expect(new Set(result.rows.map((row) => row.projectId)).size).toBe(6);
  expect(run.peak()).toBeLessThanOrEqual(4);
});

it('does not count failures and unrecorded periods as zero', async () => {
  const run = setup(6, new Map([
    ['p000', { statusCode: 403 }], ['p001', { statusCode: 429 }],
    ['p002', { name: 'TimeoutError' }], ['p003', { code: 'cashflow_accounting_annual_scope' }],
  ]));
  const result = await run.tool.execute({ yearMonth: '2026-09', weekNo: 2 }, { signal: AbortSignal.timeout(5000) });
  expect(result.counts).toEqual({ READ: 0, NOT_RECORDED: 2, OUT_OF_SCOPE: 1, FAILED: 3, NOT_ATTEMPTED: 0 });
  expect(Object.values(result.counts).reduce((a, b) => a + b, 0)).toBe(result.found);
  expect(result.totals.actual.inflow).toEqual({ value: null, included: 0, excluded: 6 });
  expect(result.allReadsSucceeded).toBe(false);
  expect(result.rows.slice(0, 4).map((row) => row.error.category)).toEqual(['AUTHORIZATION', 'RATE_LIMIT', 'TIMEOUT', 'UNSUPPORTED_PERIOD']);
});

it('pages beyond 100 without claiming a page is the full catalog, and rejects actor injection', async () => {
  const run = setup(103);
  const first = await run.tool.execute({ yearMonth: '2026-09' }, { signal: AbortSignal.timeout(5000) });
  expect(first).toMatchObject({ found: 100, nextCursor: expect.any(String), wholeCatalog: false });
  expect(JSON.stringify(run.tool.modelResult(first)).length).toBeLessThan(100000);
  const last = await run.tool.execute({ yearMonth: '2026-09', cursor: first.nextCursor }, { signal: AbortSignal.timeout(5000) });
  expect(last).toMatchObject({ found: 103, pageFound: 3, nextCursor: null, wholeCatalog: true });
  expect(last.totals.projection.inflow.value).toBe(1030);
  expect(run.readSnapshot).toHaveBeenCalledTimes(103);
  await expect(run.tool.execute({ yearMonth: '2026-09', cursor: first.nextCursor }, { signal: AbortSignal.timeout(5000) })).rejects.toThrow('accounting_report_cursor_invalid');
  await expect(run.tool.execute({ yearMonth: '2026-09', actorRole: 'admin' }, { signal: AbortSignal.timeout(5000) })).rejects.toThrow();
  const denied = setup();
  denied.authorize.mockRejectedValue(new Error('inactive'));
  await expect(denied.tool.execute({ yearMonth: '2026-09' }, { signal: AbortSignal.timeout(5000) })).rejects.toThrow('inactive');
  expect(denied.readSnapshot).not.toHaveBeenCalled();
});

it('preserves signed zero and null; rejects unsafe totals and stops on cancellation', async () => {
  expect(summarizeAccountingRows([{ actual: { inflow: 0 } }, {}]).actual.inflow).toEqual({ value: 0, included: 1, excluded: 1 });
  expect(() => summarizeAccountingRows([{ actual: { inflow: Number.MAX_SAFE_INTEGER } }, { actual: { inflow: 1 } }])).toThrow('accounting_amount_invalid');
  const run = setup();
  await expect(run.tool.execute({ yearMonth: '2026-09' }, { signal: AbortSignal.abort() })).rejects.toThrow();
  expect(run.readSnapshot).not.toHaveBeenCalled();
  const clock = vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(60000);
  try {
    const timed = await run.tool.execute({ yearMonth: '2026-09' }, { signal: AbortSignal.timeout(5000) });
    expect(timed.counts.NOT_ATTEMPTED).toBe(6);
    expect(run.readSnapshot).not.toHaveBeenCalled();
    expect(timed.wholeCatalog).toBe(false);
    clock.mockRestore();
    const resumed = await run.tool.execute({ yearMonth: '2026-09', cursor: timed.nextCursor }, { signal: AbortSignal.timeout(5000) });
    expect(resumed).toMatchObject({ found: 6, wholeCatalog: true, counts: { READ: 6, NOT_ATTEMPTED: 0 } });
    expect(resumed.totals.projection.inflow.value).toBe(60);
  } finally { clock.mockRestore(); }
});

it('classifies observed failures without leaking messages or guessing unknown causes', () => {
  for (const [error, category] of [
    [{ statusCode: 401 }, 'AUTHORIZATION'], [{ statusCode: 503, upstreamStatus: 504 }, 'TIMEOUT'],
    [{ statusCode: 503 }, 'UPSTREAM'], [{ code: 'jvm_weekly_api_unreachable' }, 'CONNECTION'],
    [{ code: 'jvm_weekly_api_unconfigured' }, 'CONFIGURATION'], [{ code: 'jvm_weekly_project_mismatch' }, 'INVALID_DATA'],
    [{ statusCode: 404 }, 'NOT_FOUND'], [{ message: 'Bearer secret' }, 'UNKNOWN'],
    [{ statusCode: 409 }, 'CONFLICT'], [{ code: 'SHEET_VALUE_INVALID' }, 'SHEET_VALIDATION'],
  ]) {
    expect(classifyReadError(error).category).toBe(category);
    expect(JSON.stringify(classifyReadError(error))).not.toContain('secret');
  }
});
