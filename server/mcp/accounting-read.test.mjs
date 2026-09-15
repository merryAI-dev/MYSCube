import { describe, expect, it, vi } from 'vitest';
import { accountingEvidence, accountingInput, createAccountingTools } from './accounting-read.mjs';

const input = { projectId: 'project-a', yearMonth: '2026-09', weekNo: 2 };
function source() {
  return {
    projectId: 'project-a', targetRevision: 'rev-1',
    accountingSource: { weeklyYear: 2026, projectName: '에코', projectCurrency: 'KRW', mirror: {
      status: 'FRESH', capturedAt: '2026-09-01T00:00:00Z', appliedTargetRevision: 'rev-old', secret: 'do-not-pass',
    } },
    readModel: { months: [{ yearMonth: '2026-09',
      projection: { rowTotals: { SALES_IN: 0 }, weeks: [{ weekNo: 2, amounts: { SALES_IN: 0 }, weekIn: 0, weekOut: 0, net: 120 }],
        monthTotals: { totalIn: 0, totalOut: 0, net: 120 } },
      actual: { rowTotals: {}, weeks: [], monthTotals: { totalIn: 0, totalOut: 0, net: 0 } },
    }] },
  };
}

describe('accounting read evidence', () => {
  it('keeps known zero, missing null, unknown cell states, source age and coordinate contract', () => {
    const result = accountingEvidence(source(), { ...input, detail: 'lines' }, '2026-09-14T10:00:00Z');
    const sales = result.projection[0].lines.find((line) => line.lineId === 'SALES_IN');
    expect(sales.amount).toBe(0);
    expect(sales.coordinate).toEqual({ rowIndex: 17, columnIndex: 45, indexBase: 0 });
    expect(result.actual[0].lines.every((line) => line.amount === null)).toBe(true);
    expect(result.actual[0].totals).toEqual({ inflow: null, outflow: null, cumulativeBalance: null });
    expect(result.fieldStateAvailability).toBe('NOT_EXPOSED');
    expect(result.amountCurrency).toBe('KRW');
    expect(result.currencyAuthority).toBe('MYSC_LEDGER_POLICY');
    expect(result.source.capturedAt).toBeNull();
    expect(result.source.sheetMirror.matchesJvmRevision).toBe(false);
    expect(result.source.sheetMirror.secret).toBeUndefined();
    expect(result.source.sheetMirror.status).toBeUndefined();
    expect(result.source).toMatchObject({ freshness: 'UNKNOWN', liveSheetVerified: false });
    const matched = source();
    matched.accountingSource.mirror.appliedTargetRevision = matched.targetRevision;
    expect(accountingEvidence(matched, input).source).toMatchObject({ freshness: 'UNKNOWN', liveSheetVerified: false,
      sheetMirror: { matchesJvmRevision: true } });
    expect(result.currentWeek).toMatchObject({ yearMonth: '2026-09', weekNo: 3 });
    expect(result.projection[0]).toMatchObject({ start: '2026-09-07', end: '2026-09-13' });
  });
  it('defaults to compact summaries and only uses recorded JVM totals', () => {
    const result = accountingEvidence(source(), { projectId: input.projectId, yearMonth: input.yearMonth });
    expect(result.projection[0].lines).toBeUndefined();
    expect(result.monthlyTotals.projection).toEqual({ inflow: 0, outflow: 0, cumulativeBalance: 120 });
    expect(result.monthlyTotals.actual.inflow).toBeNull();
    expect(JSON.stringify(result).length).toBeLessThan(5000);
  });
  it('rejects scope mismatches, unsafe amounts and duplicate weeks without guessing', () => {
    expect(() => accountingEvidence({ ...source(), projectId: 'other' }, input)).toThrow();
    expect(() => accountingEvidence(source(), { ...input, yearMonth: '2027-09' })).toThrow();
    const invalid = source();
    invalid.readModel.months[0].projection.weeks[0].weekIn = Number.MAX_SAFE_INTEGER + 1;
    expect(() => accountingEvidence(invalid, input)).toThrow('accounting_amount_invalid');
    const invalidLine = source();
    invalidLine.readModel.months[0].projection.weeks[0].amounts.SALES_IN = '1,000';
    expect(() => accountingEvidence(invalidLine, { ...input, detail: 'summary' })).toThrow('accounting_amount_invalid');
    const duplicate = source();
    duplicate.readModel.months[0].projection.weeks.push(duplicate.readModel.months[0].projection.weeks[0]);
    expect(() => accountingEvidence(duplicate, input)).toThrow('accounting_week_invalid');
    expect(() => accountingInput.parse({ ...input, action: 'delete' })).toThrow();
  });
  it('calculates Actual minus Projection in code and leaves missing comparisons unknown', () => {
    const snapshot = source();
    expect(accountingEvidence(snapshot, input).difference.weeks[0].inflow).toBeNull();
    snapshot.readModel.months[0].actual.weeks = [{ weekNo: 2, amounts: { SALES_IN: 40 }, weekIn: 40, weekOut: 5, net: 155 }];
    const evidence = accountingEvidence(snapshot, input);
    expect(evidence.difference).toMatchObject({ derivedBy: 'BFF_FROM_JVM', direction: 'ACTUAL_MINUS_PROJECTION',
      weeks: [{ weekNo: 2, inflow: 40, outflow: 5, cumulativeBalance: 35 }] });
    snapshot.readModel.months[0].projection.weeks[0].weekIn = -Number.MAX_SAFE_INTEGER;
    expect(() => accountingEvidence(snapshot, input)).toThrow('accounting_amount_invalid');
  });
  it('validates before read, forwards cancellation and reads through only the supplied port', async () => {
    const readSnapshot = vi.fn(async () => source());
    const [tool] = createAccountingTools({ readSnapshot });
    await expect(tool.execute({ ...input, weekNo: 6 })).rejects.toThrow();
    expect(readSnapshot).not.toHaveBeenCalled();
    const controller = new AbortController();
    await tool.execute(input, { signal: controller.signal });
    expect(readSnapshot).toHaveBeenCalledWith({ params: { projectId: input.projectId }, query: { yearMonth: input.yearMonth }, signal: controller.signal });
    controller.abort();
    await expect(tool.execute(input, { signal: controller.signal })).rejects.toThrow();
    expect(readSnapshot).toHaveBeenCalledTimes(1);
  });
});
