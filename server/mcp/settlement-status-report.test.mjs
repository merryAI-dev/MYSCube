import { it, expect, vi } from 'vitest';
import { createSettlementStatusTool, renderSettlementStatus } from './settlement-status-report.mjs';
import { resolveSettlementRequest, settlementRequestTools } from './settlement-request.mjs';
import { memoryDb, statusOverview } from './slack-test-store.mjs';

const signal = () => AbortSignal.timeout(10000);
const context = { tenantId: 'mysc', actorId: 'agent', actorRole: 'auditor' };

it('paginates complete registered status without money or overdue filtering', async () => {
  const { db, records } = memoryDb();
  for (let i = 0; i < 105; i++) records.set(`orgs/mysc/projects/p${String(i).padStart(3, '0')}`, { name: `사업${i}` });
  records.set('orgs/mysc/projects/deleted', { name: '휴지통', trashedAt: '2026-01-01' });
  const readOverview = vi.fn(statusOverview);
  const tool = createSettlementStatusTool({ db, authorize: async () => context, readOverview });
  const result = await tool.execute({ kind: 'week', yearMonth: '2026-09' }, { signal: signal() });
  expect(readOverview).toHaveBeenCalledTimes(2);
  expect(result.rows).toHaveLength(105);
  expect(result.complete).toBe(true);
  const text = tool.render(result);
  expect(text).toContain('1주차: 승인 완료 105개');
  expect(text).toContain('2주차: 승인 대기 105개');
  expect(text).toContain('5주차: 업데이트 대기 105개');
  expect(text).toContain('사업104');
  expect(text).not.toMatch(/휴지통|입금|출금|누적잔액|월결산 대상/);
});

it('retains unavailable projects as unknown and distinguishes scoped, empty and unhealthy reads', async () => {
  const { db, records } = memoryDb();
  records.set('orgs/mysc/projects/a', { name: 'A사업' });
  records.set('orgs/mysc/projects/b', { name: 'B사업' });
  records.set('orgs/mysc/members/member', { projectIds: ['a'], status: 'ACTIVE' });
  const tool = createSettlementStatusTool({ db, authorize: async () => ({ ...context, actorId: 'member', actorRole: 'pm' }),
    readOverview: async () => { throw new Error('network'); } });
  const result = await tool.execute({ kind: 'week', yearMonth: '2026-09', projectIds: ['a', 'b'] }, { signal: signal() });
  expect(result.rows.map((row) => row.projectId)).toEqual(['a']);
  expect(result.complete).toBe(false);
  expect(tool.render(result)).toContain('1주차: 확인 필요 1개');
  expect(tool.render(result)).not.toContain('승인 완료');
  const unhealthy = createSettlementStatusTool({ db, authorize: async () => context, readOverview: async (req) => {
    const response = statusOverview(req); response.items[0].settlementCycle.health = 'UNAVAILABLE'; return response;
  } });
  expect((await unhealthy.execute({ kind: 'month', yearMonth: '2026-08' }, { signal: signal() })).rows[0].month).toBe('UNKNOWN');
});

it('converts a monthly target to its cycle month and rechecks authorization after reads', async () => {
  const { db, records } = memoryDb(); records.set('orgs/mysc/projects/a', { name: 'A' });
  const readOverview = vi.fn(statusOverview);
  let calls = 0;
  const tool = createSettlementStatusTool({ db, readOverview, authorize: async () => { if (++calls > 1) throw new Error('member_inactive'); return context; } });
  await expect(tool.execute({ kind: 'month', yearMonth: '2026-12' }, { signal: signal() })).rejects.toThrow('member_inactive');
  expect(readOverview.mock.calls[0][0].body.yearMonth).toBe('2027-01');
});

it('does not report completion from an inconsistent cycle or hide long-list omissions', async () => {
  const { db, records } = memoryDb(); records.set('orgs/mysc/projects/a', { name: 'A' });
  const tool = createSettlementStatusTool({ db, authorize: async () => context, readOverview: async (req) => {
    const value = statusOverview(req); value.items[0].settlementCycle.businessState = 'INCONSISTENT'; return value;
  } });
  const result = await tool.execute({ kind: 'week', yearMonth: '2026-09' }, { signal: signal() });
  expect(result.complete).toBe(false);
  expect(tool.render(result)).not.toContain('승인 완료');
  const long = { ...result, rows: Array.from({ length: 1000 }, (_, i) => ({ ...result.rows[0], name: `사업${i}${'가'.repeat(120)}` })) };
  const text = renderSettlementStatus(long);
  expect(text.length).toBeLessThan(31000);
  expect(text).toContain('표시 한도: 사업별 목록');
  expect(text.indexOf('자료 조회 시각')).toBeLessThan(text.indexOf('- 사업0'));
});

it('routes the reported correction independently of CFO history and defaults bare CFO to the KST month', () => {
  const now = new Date('2026-12-31T15:01:00Z');
  const request = resolveSettlementRequest('어 미안 전체 등록된 사업의 9월 주정산 결과를 여부만 이야기해줘', now);
  expect(request).toMatchObject({ direct: true, input: { kind: 'week', yearMonth: '2027-09' } });
  expect(request.notice).toContain('2027년');
  expect(resolveSettlementRequest('<@UBOT> CFO 브리핑 해줘', now)).toMatchObject({ direct: true, input: { kind: 'both', yearMonth: '2027-01' } });
  for (const text of ['A사업 9월 주정산 여부만', '전체 사업 8월과 9월 주정산', 'CIC1 전체 사업 9월 주정산', '전체 사업 작년 9월 주정산', '전체 사업의 9월 주정산 1~3주차 여부만', '전체 사업의 9월 주정산 승인 완료된 사업만']) {
    expect(resolveSettlementRequest(text, now).direct).toBe(false);
  }
  expect(resolveSettlementRequest('전체 사업의 9월 주정산 여부만, 전체 말고 A사업', now)).toBeNull();
  expect(resolveSettlementRequest('전체 사업의 9월 주정산 아니고 잔액 상태만', now)).toBeNull();
  expect(resolveSettlementRequest('A사업과 B사업 8월과 9월을 비교해서 CFO 브리핑해줘', now)).toBeNull();
  const tools = ['accounting_report', 'cfo_brief', 'accounting_compare', 'cashflow_status', 'settlement_status_report'].map((name) => ({ name }));
  expect(settlementRequestTools(tools, request).map((tool) => tool.name)).toEqual(['cashflow_status', 'settlement_status_report']);
});

it('groups the production-shaped 70-project result by stored CIC with exact incomplete counts', async () => {
  const { db, records } = memoryDb();
  for (let i = 0; i < 70; i++) records.set(`orgs/mysc/projects/p${String(i).padStart(2, '0')}`, { name: `사업${i}`, cic: i < 8 ? ' CIC1 ' : 'CIC2' });
  const tool = createSettlementStatusTool({ db, authorize: async () => context, readOverview: async (req) => {
    const value = statusOverview(req);
    value.items.forEach((item, i) => { item.settlementStatuses.items.find((s) => s.period === 'WEEK_4').status = i < 8 ? 'PENDING_APPROVAL' : 'WAITING_FOR_UPDATE'; });
    return value;
  } });
  const result = await tool.execute({ kind: 'week', yearMonth: '2026-09', weekNo: 4, groupBy: 'cic', statusFilter: 'incomplete' }, { signal: signal() });
  const text = tool.render(result);
  expect(result.complete).toBe(true);
  expect(text).toContain('4주차: 승인 대기 8개 · 업데이트 대기 62개');
  expect(text).toContain('[CIC1] 8개 사업 · 미완료 8개 · 확인 필요 0개');
  expect(text).toContain('[CIC2] 62개 사업 · 미완료 62개 · 확인 필요 0개');
  expect(text.split('\n').filter((s) => s.startsWith('- '))).toHaveLength(70);
});

it('excludes completed projects but retains unknown separately without guessing CIC', async () => {
  const { db, records } = memoryDb();
  ['done', 'pending', 'unknown'].forEach((id) => records.set(`orgs/mysc/projects/${id}`, { name: id, cic: id === 'pending' ? 'CIC4' : 123 }));
  const tool = createSettlementStatusTool({ db, authorize: async () => context, readOverview: async (req) => {
    const value = statusOverview(req);
    for (const item of value.items) {
      if (item.projectId === 'unknown') item.settlementCycle.health = 'UNAVAILABLE';
      if (item.projectId === 'pending') item.settlementStatuses.items.find((s) => s.period === 'WEEK_1').status = 'PENDING_APPROVAL';
    }
    return value;
  } });
  const result = await tool.execute({ kind: 'week', yearMonth: '2026-09', weekNo: 1, groupBy: 'cic', statusFilter: 'incomplete' }, { signal: signal() });
  const text = tool.render(result);
  expect(result.complete).toBe(false);
  expect(text).not.toContain('- done:');
  expect(text).toContain('[CIC 미지정] 1개 사업 · 미완료 0개 · 확인 필요 1개');
  expect(text).toContain('- unknown: 1주 확인 필요');
  expect(text).toContain('미완료 사업 1개 · 확인 필요 사업 1개');
  const monthly = await tool.execute({ kind: 'month', yearMonth: '2026-08', groupBy: 'cic', statusFilter: 'incomplete', projectIds: ['done'] }, { signal: signal() });
  expect(tool.render(monthly)).toContain('미완료·확인 필요 사업이 없습니다');
  expect(monthly.complete).toBe(true);
});

it('routes explicit CIC grouping and incomplete requests while preserving restricted scopes', () => {
  const now = new Date('2026-09-28T05:00:00Z');
  expect(resolveSettlementRequest('전체 등록 사업의 8월 주정산 상태를 정리해서 답해주세요 CIC별로', now))
    .toMatchObject({ direct: true, input: { yearMonth: '2026-08', groupBy: 'cic' } });
  expect(resolveSettlementRequest('전체 등록 사업의 9월 4주차 주정산 미완료 기업만 리스트업 해줘 조직 구분인 CIC별로', now))
    .toMatchObject({ direct: true, input: { yearMonth: '2026-09', weekNo: 4, groupBy: 'cic', statusFilter: 'incomplete' } });
  expect(resolveSettlementRequest('CIC1 전체 사업 9월 주정산 미완료만 CIC별로', now).direct).toBe(false);
  const request = resolveSettlementRequest('9월 4주차 주정산 미완료 기업만 리스트업 해줘 조직 구분인 CIC별로', now);
  expect(request.direct).toBe(false);
  expect(settlementRequestTools([{ name: 'settlement_report' }, { name: 'settlement_status_report' }], request)).toEqual([{ name: 'settlement_status_report' }]);
});

it('enforces explicit CIC and incomplete presentation in validated model arguments', () => {
  const { db } = memoryDb();
  const tool = createSettlementStatusTool({ db, authorize: async () => context, readOverview: statusOverview });
  const request = resolveSettlementRequest('9월 4주차 주정산 미완료 기업만 리스트업 해줘 조직 구분인 CIC별로');
  const [scoped] = settlementRequestTools([tool], request);
  expect(scoped.schema.parse({ kind: 'week', yearMonth: '2026-09', weekNo: 4 }))
    .toMatchObject({ groupBy: 'cic', statusFilter: 'incomplete' });
  expect(() => scoped.schema.parse({ kind: 'week', yearMonth: '2026-09', statusFilter: 'all' })).toThrow();
});
