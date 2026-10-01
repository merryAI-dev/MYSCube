import { describe, expect, it } from 'vitest';
import {
  chunkCashflowExportProjectIds,
  findCashflowExportSettlementStatus,
  loadCashflowExportChunksInSequence,
  resolveCashflowExportRecentWeeks,
} from './cashflow-export-dashboard';

const settlementDeadlines = {
  deadlineAt: '2026-08-30T15:00:00.000Z',
  approverDeadlineAt: '2026-08-31T04:00:00.000Z',
};

describe('cashflow export operations dashboard', () => {
  it.each([
    ['2026-08-26', [['2026-08', 4], ['2026-08', 5]]],
    ['2026-08-31', [['2026-08', 4], ['2026-08', 5]]],
    ['2026-09-01', [['2026-08', 5], ['2026-09', 1]]],
    ['2027-01-01', [['2026-12', 5], ['2027-01', 1]]],
  ])('selects the previous and current finance week for %s', (todayIso, expected) => {
    expect(resolveCashflowExportRecentWeeks(todayIso).map(({ yearMonth, weekNo }) => [yearMonth, weekNo]))
      .toEqual(expected);
  });

  it('returns no weeks for an invalid Seoul date', () => {
    expect(resolveCashflowExportRecentWeeks('not-a-date')).toEqual([]);
  });

  it('chunks 10 projects per request without dropping the last project', () => {
    const projectIds = Array.from({ length: 71 }, (_, index) => `p${index + 1}`);
    const chunks = chunkCashflowExportProjectIds(projectIds);
    expect(chunks.map((chunk) => chunk.length)).toEqual([10, 10, 10, 10, 10, 10, 10, 1]);
    expect(chunks.flat()).toEqual(projectIds);
    expect(chunkCashflowExportProjectIds([])).toEqual([]);
  });

  it('loads chunks one at a time and keeps going after a failed chunk', async () => {
    const chunks = [['p1'], ['p2'], ['p3']];
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: Array<[string, string]> = [];
    await loadCashflowExportChunksInSequence({
      chunks,
      isActive: () => true,
      loadChunk: async (chunk) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        if (chunk[0] === 'p2') throw new Error('jvm_weekly_api_unreachable');
        return chunk[0];
      },
      onChunk: (chunk, result) => { seen.push([chunk[0], result.status]); },
    });
    expect(maxInFlight).toBe(1);
    expect(seen).toEqual([['p1', 'fulfilled'], ['p2', 'rejected'], ['p3', 'fulfilled']]);
  });

  it('stops sending and reporting once the screen scope changes', async () => {
    let active = true;
    const loaded: string[] = [];
    const reported: string[] = [];
    await loadCashflowExportChunksInSequence({
      chunks: [['p1'], ['p2'], ['p3']],
      isActive: () => active,
      loadChunk: async (chunk) => {
        loaded.push(chunk[0]);
        if (chunk[0] === 'p2') active = false;
        return chunk[0];
      },
      onChunk: (chunk) => { reported.push(chunk[0]); },
    });
    expect(loaded).toEqual(['p1', 'p2']);
    expect(reported).toEqual(['p1']);
  });

  it('joins a status only by exact project, month, and week period', () => {
    const recentWeeks = resolveCashflowExportRecentWeeks('2026-09-01');
    const results = [{
      projectId: 'project-a',
      yearMonth: '2026-08',
      items: [{
        ...settlementDeadlines,
        period: 'WEEK_5' as const,
        status: 'COMPLETED' as const,
        submittedAt: '2026-08-31T01:00:00.000Z', submittedBy: 'pm-1',
        approvedAt: '2026-08-31T02:00:00.000Z', approvedBy: 'head-1', revision: 2,
      }],
    }, {
      projectId: 'project-a',
      yearMonth: '2026-09',
      items: [{
        ...settlementDeadlines,
        period: 'WEEK_1' as const,
        status: 'PENDING_APPROVAL' as const,
        submittedAt: '2026-09-01T01:00:00.000Z', submittedBy: 'pm-1',
        approvedAt: '', approvedBy: '', revision: 1,
      }],
    }];

    expect(findCashflowExportSettlementStatus(results, 'project-a', recentWeeks[0])?.status).toBe('COMPLETED');
    expect(findCashflowExportSettlementStatus(results, 'project-a', recentWeeks[1])?.status).toBe('PENDING_APPROVAL');
    expect(findCashflowExportSettlementStatus(results, 'project-b', recentWeeks[0])).toBeNull();
    expect(findCashflowExportSettlementStatus([
      { ...results[0], projectId: 'project-b' },
      { ...results[1], yearMonth: '2026-08' },
    ], 'project-a', recentWeeks[1])).toBeNull();
  });

  it('fails closed instead of choosing between duplicate status identities', () => {
    const [week] = resolveCashflowExportRecentWeeks('2026-08-31');
    const status = {
      ...settlementDeadlines,
      period: week.period,
      status: 'COMPLETED' as const,
      submittedAt: '2026-08-25T01:00:00.000Z', submittedBy: 'pm-1',
      approvedAt: '2026-08-25T02:00:00.000Z', approvedBy: 'head-1', revision: 2,
    };
    expect(findCashflowExportSettlementStatus([
      { projectId: 'project-a', yearMonth: week.yearMonth, items: [status, { ...status }] },
    ], 'project-a', week)).toBeNull();
  });
});
