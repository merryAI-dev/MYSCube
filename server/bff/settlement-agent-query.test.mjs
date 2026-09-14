import { it, expect } from 'vitest';
import { selectSettlementIssue } from './settlement-agent-query.mjs';

it('uses canonical states and deadlines, retaining unknowns and distinguishing late approval', () => {
  const item = { settlementCycle: { health: 'OK', businessState: 'LOCKED' }, settlementStatuses: { items: [
    { period: 'WEEK_2', status: 'COMPLETED', approverDeadlineAt: '2026-09-11T04:00:00Z', approvedAt: '2026-09-11T03:59:59Z' },
  ] } };
  const weekly = { kind: 'week_overdue', weekNo: 2, cutoff: '2026-09-11T04:00:00Z' };
  expect(selectSettlementIssue(item, { kind: 'month_incomplete' })).toBeNull();
  expect(selectSettlementIssue(item, weekly)).toBeNull();
  item.settlementStatuses.items[0].approvedAt = '2026-09-11T04:00:01Z';
  expect(selectSettlementIssue(item, weekly).state).toBe('LATE_APPROVED');
  expect(selectSettlementIssue(item, { ...weekly, includeLateApproved: false })).toBeNull();
  item.settlementStatuses.items[0].status = 'PENDING_APPROVAL';
  expect(selectSettlementIssue(item, weekly).state).toBe('PENDING_APPROVAL');
  expect(selectSettlementIssue(item, { ...weekly, cutoff: '2026-09-11T03:59:00Z' })).toBeNull();
  item.settlementCycle.health = 'UNAVAILABLE';
  expect(selectSettlementIssue(item, weekly).state).toBe('UNKNOWN');
});
