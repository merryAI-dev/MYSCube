import { describe, it, expect, vi } from 'vitest';
import * as z from 'zod/v4';
import { runSettlementAgent } from './settlement-agent.mjs';
import { createSettlementReportTools, reportEvidence, renderSettlementReport } from './settlement-reporting.mjs';
import { loadPreviousReportSnapshots, reviewGroundedAnswer } from './grounded-answer.mjs';

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

  it('delivers API-generated prose and emoji rather than replacing it with the fixed renderer', async () => {
    const generated = '📌 8월 월결산을 CIC별로 정리했어요.\nCIC1 · 강신일(봄날): 2026 CMK — ⏳ 요청 전';
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', { ...query, presentation: { groupBy: ['cic'] } }))
      .mockResolvedValueOnce({ content: generated });
    const reviewAnswer = vi.fn().mockResolvedValue(approved);
    const result = await runSettlementAgent({ question: '월결산만 CIC별로 리포팅해줘', tools: makeTools(), complete, reviewAnswer });
    expect(result).toEqual({ status: 'answered', answer: generated });
    expect(reviewAnswer.mock.calls[0][0].evidence[0].result.groups[0]).toMatchObject({ name: 'CIC1', count: 1 });
    expect(complete.mock.calls[1][0].messages.some((message) => message.role === 'system' && message.content.includes('이모지'))).toBe(true);
  });

  it('corrects only the format using a monthly snapshot, without adding weekly results or refreshing the timestamp', async () => {
    const readReport = vi.fn();
    const saveReport = vi.fn();
    const complete = vi.fn().mockResolvedValueOnce(call('reformat_report', { kind: 'month_incomplete', presentation: { groupBy: ['cic'] } }))
      .mockResolvedValueOnce({ content: '📌 CIC별로 다시 정리했어요. 기존 조회 자료 기준입니다.' });
    const reviewAnswer = vi.fn().mockResolvedValue(approved);
    const tools = makeTools({ readReport, saveReport, loadPreviousReports: async () => [
      { query, report }, { query: { ...query, kind: 'week_overdue' }, report: { ...report, kind: 'week_overdue' } },
    ] });
    const result = await runSettlementAgent({ question: '피드백: 지금 CIC별로 정리하달라고 했는데, 월결산 대상으로만 나왔어. 답변 형식 오류',
      history: [{ role: 'user', content: '월결산만 CIC별로 정리해서 리포팅하듯이 이야기해줘' }, { role: 'assistant', content: '이전 평면 목록' }],
      tools, complete, reviewAnswer });
    expect(result.status).toBe('answered');
    expect(readReport).not.toHaveBeenCalled();
    expect(saveReport).toHaveBeenCalledTimes(1);
    const snapshots = reviewAnswer.mock.calls[0][0].evidence[0].result.snapshots;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].report.queriedAt).toBe(report.queriedAt);
    expect(snapshots[0].report.groups[1].name).toBe('CIC4');
  });

  it('repairs unsupported prose once and never posts the rejected draft', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', query))
      .mockResolvedValueOnce({ content: '✅ 999개 사업 승인 완료' }).mockResolvedValueOnce({ content: '🔎 확인이 필요한 사업이 있습니다.' });
    const reviewAnswer = vi.fn().mockResolvedValueOnce({ supported: false, addressesRequest: false, issues: ['999와 완료는 근거 없음'] })
      .mockResolvedValueOnce(approved);
    const record = vi.fn();
    const result = await runSettlementAgent({ question: '월결산 현황', tools: makeTools(), complete, reviewAnswer, record });
    expect(result.answer).toBe('🔎 확인이 필요한 사업이 있습니다.');
    expect(complete.mock.calls[2][0].messages.at(-1).role).toBe('user');
    expect(record.mock.calls.some(([event]) => event.type === 'answer_review' && event.method === 'model_assessment_not_proof')).toBe(true);
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

  it('never reports success when the model fails to produce final prose', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', query)).mockResolvedValue({ content: '' });
    const result = await runSettlementAgent({ question: 'CIC별 요약', tools: makeTools(), complete, reviewAnswer: async () => approved });
    expect(result.status).toBe('partial');
    expect(result.answer).toContain('형식의 답변을 작성하지 못해');
  });

  it('reserves the final step for prose and allows feedback observation only once without privatizing a valid answer', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', query))
      .mockResolvedValueOnce(call('observe_feedback', {})).mockResolvedValueOnce({ content: '📌 CIC별로 다시 정리했어요.' });
    const record = vi.fn();
    const result = await runSettlementAgent({ question: '형식 오류, CIC별로', maxSteps: 3,
      tools: [...makeTools(), { name: 'observe_feedback', observationOnly: true, schema: z.object({}),
        execute: async () => { throw new Error('unverified_quote'); } }], complete, record, reviewAnswer: async () => approved });
    expect(result.status).toBe('answered');
    expect(complete.mock.calls[2][0].tools).toEqual([]);
    expect(record.mock.calls.some(([event]) => event.outcome === 'rejected')).toBe(false);
  });

  it('rejects internal IDs before invoking the semantic reviewer', async () => {
    const complete = vi.fn();
    const result = await reviewGroundedAnswer({ complete, question: '목록', answer: '사업 ID p1772676088818',
      evidence: [{ result: { projectId: 'p1772676088818' } }] });
    expect(result.supported).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it('falls back to verified rows and partial warnings when independent review fails', async () => {
    const complete = vi.fn().mockResolvedValueOnce(call('settlement_report', { ...query, presentation: { groupBy: ['cic'] } }))
      .mockResolvedValue({ content: '✅ 모두 승인 완료' });
    const result = await runSettlementAgent({ question: 'CIC별 현황', maxSteps: 3,
      tools: makeTools({ readReport: async () => ({ ...report, complete: false }) }), complete,
      reviewAnswer: async () => { throw new Error('review unavailable'); } });
    expect(result.status).toBe('partial');
    expect(result.answer).not.toContain('모두 승인 완료');
    expect(result.answer).toContain('CIC1: 1개 사업');
    expect(result.answer).toContain('전체 결과가 아닙니다');
  });

  it('passes exact evidence and current request to the independent reviewer and rejects malformed judgments', async () => {
    const complete = vi.fn().mockResolvedValueOnce({ content: JSON.stringify(approved) }).mockResolvedValueOnce({ content: 'sure' });
    const args = { complete, question: '월결산만 CIC별로', answer: '📌 요약', evidence: [{ report }] };
    expect(await reviewGroundedAnswer(args)).toEqual(approved);
    expect(complete.mock.calls[0][0].tools).toEqual([]);
    expect(JSON.parse(complete.mock.calls[0][0].messages.at(-1).content)).toMatchObject({ evidence: [{ report }], question: args.question });
    await expect(reviewGroundedAnswer(args)).rejects.toThrow();
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
