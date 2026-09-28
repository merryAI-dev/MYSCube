import { describe, it, expect, vi } from 'vitest';
import * as z from 'zod/v4';
import { runSettlementAgent } from './settlement-agent.mjs';
import { createSettlementReportTools, reportEvidence, renderSettlementReport } from './settlement-reporting.mjs';
import { loadPreviousReportSnapshots } from './grounded-answer.mjs';

const report = { kind: 'month_incomplete', yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
  queriedAt: '2026-09-14T06:20:00.000Z', coverage: 'accessible_registered_projects', checked: 4, complete: true,
  warning: '등록 사업 기준이며 정산 의무 대상 미준수 명단은 아닙니다.', rows: [
    { projectId: 'p1', name: '2026 CMK', cic: 'CIC1', leaderId: 'leader1', leader: '강신일(봄날)', state: 'NOT_REQUESTED' },
    { projectId: 'p2', name: '2026 더큰 제주', cic: 'CIC4', leaderId: 'leader2', leader: '정지연(모모)', state: 'NOT_REQUESTED' },
    { projectId: 'p3', name: '이름 확인 중', cic: '', leaderId: 'leader3', leader: '조직장 확인 필요', state: 'UNKNOWN' },
    { projectId: 'p4', name: '미설정 사업', cic: '', leaderId: '', leader: '조직장 확인 필요', state: 'SUBMITTED' },
  ] };
const query = { kind: 'month_incomplete', yearMonth: '2026-09' };
const call = (name, args) => ({ tool_calls: [{ id: 'call', function: { name, arguments: JSON.stringify(args) } }] });
const makeTools = (options = {}) => createSettlementReportTools({ readReport: async () => structuredClone(report),
  loadPreviousReports: async () => [{ report, query }], saveReport: async () => {}, ...options });
const approved = { supported: true, addressesRequest: true, issues: [] };

describe('flexible Slack answers with server-owned facts', () => {
  it('counts and groups from real fields without guessing missing CIC or unresolved leader identity', () => {
    const result = reportEvidence(report, { groupBy: ['cic', 'leader'], leaderOnly: true });
    expect(result.matches).toBe(3);
    expect(result.excludedUnsetLeader).toBe(1);
    expect(result.states).toEqual({ NOT_REQUESTED: 2, UNKNOWN: 1 });
    expect(result.groups.map(({ name, count }) => [name, count])).toEqual([['CIC1', 1], ['CIC4', 1], ['CIC 확인 필요', 1]]);
    expect(result.groups[2].groups[0]).toMatchObject({ key: 'leader3', count: 1 });
    const sameName = { ...report, rows: report.rows.slice(2) };
    expect(reportEvidence(sameName, { groupBy: ['leader'] }).groups).toHaveLength(2);
    const fallback = renderSettlementReport(report, { groupBy: ['cic'], detail: 'summary' });
    expect(fallback).toContain('CIC1: 1개 사업');
    expect(fallback).not.toContain('2026 CMK');
    expect(fallback).toContain('사업명 목록은 생략');
  });

  it('discards fabricated prose even when a supplied reviewer approves it', async () => {
    const fabricated = '999개 승인 완료. 매출 하락 원인은 횡령이며 지급을 실행했습니다.';
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', { ...query, presentation: { groupBy: ['cic'] } }))
      .mockResolvedValueOnce({ content: fabricated });
    const reviewAnswer = vi.fn().mockResolvedValue(approved);
    const result = await runSettlementAgent({ question: '월결산 CIC별 보고', tools: makeTools(), complete, reviewAnswer });
    expect(result.status).toBe('answered');
    expect(result.answer).toContain('CIC1: 1개 사업');
    expect(result.answer).not.toMatch(/999|횡령|지급을 실행/);
    expect(reviewAnswer).not.toHaveBeenCalled();
  });

  it('reformats authorized stored evidence without refreshing or synthesizing facts', async () => {
    const readReport = vi.fn();
    const saveReport = vi.fn();
    const tools = makeTools({ readReport, saveReport });
    const complete = vi.fn().mockResolvedValueOnce(call('reformat_report', { kind: 'month_incomplete', presentation: { groupBy: ['cic'] } }))
      .mockResolvedValueOnce({ content: '모두 완료입니다.' });
    const result = await runSettlementAgent({ question: 'CIC별로 다시', tools, complete });
    expect(result.answer).toContain('정산을 새로 조회한 결과가 아니라');
    expect(result.answer).toContain('CIC1: 1개 사업');
    expect(readReport).not.toHaveBeenCalled();
    expect(saveReport.mock.calls[0][0].report.queriedAt).toBe(report.queriedAt);
  });

  it('preserves earlier leader-only scope on a grouping-only correction', async () => {
    const tool = makeTools({ loadPreviousReports: async () => [{ query, report,
      presentation: { groupBy: ['leader'], detail: 'compact', leaderOnly: true } }] })[1];
    const input = tool.schema.parse({ presentation: { groupBy: ['cic'] } });
    expect(input.presentation).toEqual({ groupBy: ['cic'] });
    const evidence = tool.modelResult(await tool.execute(input));
    expect(evidence.snapshots[0].report.matches).toBe(3);
    expect(evidence.snapshots[0].report.presentation).toEqual({ groupBy: ['cic'], detail: 'compact', leaderOnly: true });
  });

  it('does not require model prose or a model reviewer for a verified answer', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', query)).mockResolvedValue({ content: '' });
    const reviewAnswer = vi.fn(async () => { throw new Error('review unavailable'); });
    const result = await runSettlementAgent({ question: '월결산 현황', tools: makeTools(), complete, reviewAnswer });
    expect(result.status).toBe('answered');
    expect(result.answer).toContain('조회 4개 사업');
    expect(reviewAnswer).not.toHaveBeenCalled();
  });

  it('retains partial data warnings regardless of confident model conclusions', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', { ...query, presentation: { groupBy: ['cic'] } }))
      .mockResolvedValue({ content: '모두 승인 완료' });
    const result = await runSettlementAgent({ question: 'CIC별 현황',
      tools: makeTools({ readReport: async () => ({ ...report, complete: false }) }), complete });
    expect(result.answer).not.toContain('모두 승인 완료');
    expect(result.answer).toContain('전체 결과가 아닙니다');
  });

  it('requires evidence and a valid renderer, even with a permissive reviewer', async () => {
    const noEvidence = await runSettlementAgent({ question: '완료됐어?', tools: [], complete: async () => ({ content: '완료' }), reviewAnswer: async () => approved });
    expect(noEvidence.status).toBe('unverified');
    const broken = { name: 'broken', schema: z.object({}), execute: async () => ({ money: 100 }), render: () => { throw new Error('broken'); } };
    const complete = vi.fn().mockResolvedValueOnce(call('broken', {})).mockResolvedValue({ content: '지급 완료 999원' });
    const result = await runSettlementAgent({ question: '지급 확인', tools: [broken], complete });
    expect(result.status).toBe('unverified');
    expect(result.answer).not.toContain('999');
  });

  it('reauthorizes snapshot reuse and rejects cross-user, deleted-project and malformed snapshot sources', async () => {
    const job = { teamId: 'T1', channelId: 'C1', slackUserId: 'U1', threadTs: '1.1', turns: [{ jobId: 'old' }] };
    let source = { ...job, status: 'succeeded', reportSnapshots: [{ query, report }] };
    const authorize = vi.fn();
    const db = { doc: (path) => ({ path, get: async () => ({ data: () => source }) }),
      getAll: vi.fn(async (...refs) => refs.slice(0, -1).map(() => ({ exists: true, data: () => ({}) }))) };
    expect((await loadPreviousReportSnapshots({ db, job, authorize }))[0].report.queriedAt).toBe(report.queriedAt);
    expect(authorize).toHaveBeenCalledTimes(1);
    source = { ...source, slackUserId: 'OTHER' };
    expect(await loadPreviousReportSnapshots({ db, job, authorize })).toEqual([]);
    source = { ...source, slackUserId: 'U1' };
    db.getAll.mockResolvedValueOnce([{ exists: true, data: () => ({ trashedAt: 'yesterday' }) }]);
    await expect(loadPreviousReportSnapshots({ db, job, authorize })).rejects.toThrow('report_snapshot_unavailable');
    await expect(loadPreviousReportSnapshots({ db, job, authorize: async () => { throw new Error('denied'); } })).rejects.toThrow('denied');
    source.reportSnapshots = [{ query, report: { ...report, queriedAt: 'invalid' } }];
    await expect(loadPreviousReportSnapshots({ db, job, authorize })).rejects.toThrow('report_snapshot_unavailable');
  });
});
