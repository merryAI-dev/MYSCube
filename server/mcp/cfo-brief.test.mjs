import { it, expect, vi } from 'vitest';
import { createCfoBriefTool } from './cfo-brief.mjs';

const input = { projectIds: ['a', 'b', 'c', 'd'], baseline: { yearMonth: '2026-08' }, current: { yearMonth: '2026-09' } };
function snapshot({ params, query }) {
  const value = query.yearMonth === '2026-08' ? 0 : 20;
  const mode = (money) => ({ rowTotals: {}, weeks: [{ weekNo: 1, amounts: { SALES_IN: money }, weekIn: money, weekOut: 0, net: -5 }], monthTotals: { totalIn: money, totalOut: 0, net: -5 } });
  return { projectId: params.projectId, targetRevision: 'source-revision', accountingSource: { weeklyYear: 2026, projectName: `사업 ${params.projectId}` },
    readModel: { months: [{ yearMonth: query.yearMonth, projection: mode(0), actual: mode(value) }] } };
}

it('executes comparison, selects bounded investigations, reuses snapshots and keeps proposals unexecuted', async () => {
  const readSnapshot = vi.fn(async (request) => snapshot(request));
  const record = vi.fn(async () => {});
  const tool = createCfoBriefTool({ readSnapshot, authorize: async () => {}, record });
  const result = await tool.execute(input);
  expect(readSnapshot).toHaveBeenCalledTimes(8);
  expect(result.investigationScope).toEqual({ candidates: 4, inspected: 3, remaining: 1, maxProjects: 3 });
  expect(result.investigations[0].differences[0]).toMatchObject({ weekNo: 1, lineId: 'SALES_IN', projection: 0, actual: 20, difference: 20,
    coordinate: { rowIndex: 40, columnIndex: 44, indexBase: 0 } });
  expect(result.investigations[0].unknownCells).toBeGreaterThan(0);
  expect(result.actionStatus).toBe('PROPOSED_NOT_ASSIGNED');
  expect(result.stages.at(-1)).toMatchObject({ name: 'PROPOSE_FOLLOW_UP', outcome: 'SUCCEEDED', executedBusinessActions: 0 });
  expect(record).toHaveBeenCalledTimes(5);
  expect(tool.render(result)).toContain('계획 0원 / 실적 20원 / 차이 20원');
  expect(tool.render(result)).toContain('저장·배정·실행되지 않았습니다');
  expect(tool.render(result)).not.toContain('source-revision');
});

it('does not invent investigations on total failure and stops on revoked permissions', async () => {
  const failed = createCfoBriefTool({ readSnapshot: async () => { throw { statusCode: 503 }; }, authorize: async () => {} });
  const result = await failed.execute(input);
  expect(result.investigations).toEqual([]);
  expect(result.comparison.totals.actual.inflow.change).toBeNull();
  expect(result.stages[1].outcome).toBe('PARTIAL');
  const authorize = vi.fn(async () => {});
  const readSnapshot = vi.fn(async (request) => { authorize.mockRejectedValue(new Error('member_inactive')); return snapshot(request); });
  const revoked = createCfoBriefTool({ readSnapshot, authorize });
  await expect(revoked.execute(input)).rejects.toThrow('member_inactive');
  expect(readSnapshot).toHaveBeenCalledTimes(1);
});

it('uses the current snapshot version for same-month weekly investigations', async () => {
  let reads = 0;
  const readSnapshot = vi.fn(async (request) => {
    const value = snapshot(request);
    value.targetRevision = `revision-${++reads}`;
    const current = value.readModel.months[0];
    current.projection.weeks.push({ weekNo: 2, amounts: { SALES_IN: 0 }, weekIn: 0, weekOut: 0, net: -5 });
    current.actual.weeks.push({ weekNo: 2, amounts: { SALES_IN: reads * 100 }, weekIn: reads * 100, weekOut: 0, net: -5 });
    return value;
  });
  const tool = createCfoBriefTool({ readSnapshot, authorize: async () => {} });
  const result = await tool.execute({ projectIds: ['a'], baseline: { yearMonth: '2026-09', weekNo: 1 }, current: { yearMonth: '2026-09', weekNo: 2 } });
  expect(readSnapshot).toHaveBeenCalledTimes(2);
  expect(result.investigations[0].source.targetRevision).toBe('revision-2');
  expect(result.investigations[0].differences[0]).toMatchObject({ weekNo: 2, actual: 200, difference: 200 });
});
