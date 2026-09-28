import { describe, it, expect, vi } from 'vitest';
import { comparisonInput, createAccountingComparisonTool } from './accounting-compare.mjs';
import { runSettlementAgent } from './settlement-agent.mjs';

const input = { projectIds: ['a', 'b'], baseline: { yearMonth: '2026-08' }, current: { yearMonth: '2026-09' } };
function snapshot(projectId, yearMonth, value, net = value) {
  const mode = (amount) => ({ rowTotals: {},
    weeks: [{ weekNo: 1, amounts: { SALES_IN: amount }, weekIn: amount, weekOut: 0, net }],
    monthTotals: { totalIn: amount, totalOut: 0, net },
  });
  return { projectId, targetRevision: `${projectId}-${yearMonth}`, accountingSource: { weeklyYear: 2026, projectName: '동명 사업' },
    readModel: { months: [{ yearMonth, projection: mode(0), actual: mode(value) }] } };
}
function setup(read) {
  const readSnapshot = vi.fn(read || (async ({ params, query }) => snapshot(params.projectId, query.yearMonth,
    query.yearMonth === '2026-08' ? 0 : params.projectId === 'a' ? 40 : -10)));
  const authorize = vi.fn(async () => {});
  return { readSnapshot, authorize, tool: createAccountingComparisonTool({ readSnapshot, authorize }) };
}

describe('CFO accounting comparison', () => {
  it('compares the same projects, keeps zero/signs, and produces grounded unexecuted follow-up actions', async () => {
    const { tool, readSnapshot, authorize } = setup();
    const result = await tool.execute(input);
    expect(result.totals.actual.inflow).toEqual({ baseline: 0, current: 30, change: 30, paired: 2, excluded: 0 });
    expect(result.totals.variance.inflow.change).toBe(30);
    expect(result.complete).toBe(false);
    expect(tool.render(result)).toContain('기준 2026-08');
    expect(tool.render(result)).toContain('계획 미기록');
    expect(tool.render(result)).toContain('JVM 조회');
    expect(result.drivers.inflow.items.map((row) => row.projectId)).toEqual(['a', 'b']);
    expect(result.proposedActions).toContainEqual(expect.objectContaining({ kind: 'REVIEW_BALANCE', projectId: 'b', status: 'PROPOSED' }));
    expect(result.proposedActions).toContainEqual(expect.objectContaining({ kind: 'VERIFY_MISSING' }));
    expect(result.rows[0].baseline.source.targetRevision).toBe('a-2026-08');
    expect(result.rows[0].current.source.liveSheetVerified).toBe(false);
    expect(readSnapshot).toHaveBeenCalledTimes(4);
    expect(authorize).toHaveBeenCalledTimes(6);
    expect(tool.render(result)).toContain('실적 입금: 0원 → 30원 / 변화 30원');
    expect(tool.render(result)).toContain('미배정·미실행');
    expect(tool.render(result)).toContain('전사 전체 비교가 아닙니다');
    expect(tool.render(result)).not.toContain('a-2026-08');
  });

  it('excludes both sides of an unpaired value and retains known current risks', async () => {
    const { tool } = setup(async ({ params, query }) => {
      if (params.projectId === 'a' && query.yearMonth === '2026-08') throw { statusCode: 503 };
      return snapshot(params.projectId, query.yearMonth, 10, -20);
    });
    const result = await tool.execute(input);
    expect(result.complete).toBe(false);
    expect(result.rows[0].baseline).toMatchObject({ status: 'FAILED', error: { category: 'UPSTREAM' } });
    expect(result.rows[0].changes.actual.inflow).toBeNull();
    expect(result.totals.actual.inflow).toEqual({ baseline: 10, current: 10, change: 0, paired: 1, excluded: 1 });
    expect(result.proposedActions).toContainEqual(expect.objectContaining({ projectId: 'a', kind: 'VERIFY_SOURCE' }));
    expect(result.proposedActions).toContainEqual(expect.objectContaining({ projectId: 'a', kind: 'REVIEW_BALANCE' }));
    const empty = setup(async () => { throw new Error('private details'); });
    const failed = await empty.tool.execute(input);
    expect(failed.totals.actual.inflow).toEqual({ baseline: null, current: null, change: null, paired: 0, excluded: 2 });
    expect(JSON.stringify(failed)).not.toContain('private details');
  });

  it('preserves unrecorded weeks, validates scope before reads and refuses annual inference', async () => {
    const { tool, readSnapshot } = setup();
    for (const invalid of [
      { ...input, projectIds: ['a', 'a'] }, { ...input, actorRole: 'admin' },
      { ...input, baseline: input.current, current: input.baseline },
      { ...input, current: input.baseline }, { ...input, current: { ...input.current, weekNo: 2 } },
      { ...input, projectIds: Array.from({ length: 11 }, (_, i) => `p${i}`) },
    ]) await expect(tool.execute(invalid)).rejects.toThrow();
    expect(readSnapshot).not.toHaveBeenCalled();
    const weekly = await tool.execute({ ...input, baseline: { ...input.baseline, weekNo: 2 }, current: { ...input.current, weekNo: 2 } });
    expect(weekly.totals.actual.inflow.change).toBeNull();
    const annual = await tool.execute({ ...input, baseline: { yearMonth: '2025-08' } });
    expect(annual.complete).toBe(false);
    expect(annual.rows[0].baseline.status).toBe('OUT_OF_SCOPE');
    expect(annual.totals.actual.inflow.paired).toBe(0);
  });

  it('fails closed on membership revocation, API authorization failure and cancellation', async () => {
    const run = setup();
    run.authorize.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('member_inactive'));
    await expect(run.tool.execute(input)).rejects.toThrow('member_inactive');
    expect(run.readSnapshot).not.toHaveBeenCalled();
    for (const failure of [{ statusCode: 403 }, new Error('member_unverified')]) {
      const denied = setup(async () => { throw failure; });
      await expect(denied.tool.execute(input)).rejects.toBe(failure);
      expect(denied.readSnapshot).toHaveBeenCalledTimes(1);
    }
    const aborted = setup();
    await expect(aborted.tool.execute(input, { signal: AbortSignal.abort() })).rejects.toThrow();
    expect(aborted.readSnapshot).not.toHaveBeenCalled();
  });

  it('rejects unsafe period deltas and paired aggregate overflow', async () => {
    const overflow = setup(async ({ params, query }) => snapshot(params.projectId, query.yearMonth,
      query.yearMonth === '2026-08' ? -Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER));
    await expect(overflow.tool.execute(input)).rejects.toThrow('accounting_amount_invalid');
    const sum = setup(async ({ params, query }) => snapshot(params.projectId, query.yearMonth, Number.MAX_SAFE_INTEGER));
    await expect(sum.tool.execute(input)).rejects.toThrow('accounting_amount_invalid');
  });

  it('uses the real comparison tool in an agent workflow and preserves verified data on model failure', async () => {
    const { tool, readSnapshot } = setup();
    const complete = vi.fn().mockResolvedValueOnce({ tool_calls: [{ id: 'comparison', function: {
      name: 'accounting_compare', arguments: JSON.stringify(input),
    } }] }).mockRejectedValueOnce(new Error('model unavailable'));
    const result = await runSettlementAgent({ question: '선택 사업의 8월과 9월을 비교하고 후속 조치를 알려줘', tools: [tool], complete });
    expect(result.status).toBe('partial');
    expect(result.answer).toContain('2026-08 → 2026-09');
    expect(result.answer).toContain('변화 30원');
    expect(result.answer).toContain('확인된 일부 결과');
    expect(readSnapshot).toHaveBeenCalledTimes(4);
  });
});
