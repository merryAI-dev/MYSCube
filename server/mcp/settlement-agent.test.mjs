import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import { runSettlementAgent, settlementTools } from './settlement-agent.mjs';

it('formats a notice using verified names and groups weeks without inventing approvals or deadlines', () => {
  const tool = settlementTools({ projectNames: new Map([['p1', 'AXR프로젝트경비경']]) })[0];
  const result = { yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08', errors: [], items: [{ projectId: 'p1',
    settlementCycle: { health: 'OK', businessState: 'LOCKED' }, settlementStatuses: { items: [
      { period: 'WEEK_1', status: 'COMPLETED' }, { period: 'WEEK_2', status: 'COMPLETED' },
      { period: 'WEEK_3', status: 'WAITING_FOR_UPDATE' }, { period: 'WEEK_4', status: 'WAITING_FOR_UPDATE' }, { period: 'WEEK_5', status: 'WAITING_FOR_UPDATE' },
    ] } }] };
  const notice = tool.render(result);
  expect(notice).toContain('AXR프로젝트경비경');
  expect(notice).toContain('월결산: 확정');
  expect(notice).toContain('1·2주차: 승인 완료');
  expect(notice).toContain('3·4·5주차: 업데이트 대기');
  expect(notice).not.toMatch(/지연|미준수|13시|모두 완료/);
});

describe('settlement agent', () => {
  it('uses bounded multi-turn context while answering multiple queries only from fresh tools', async () => {
    let step = 0;
    const result = await runSettlementAgent({ question: '그 두 사업 지난달도?', history: [
      { role: 'user', content: 'AXR과 GGGI 9월 조회' }, { role: 'assistant', content: '이전 조회: 모두 완료' },
    ], tools: [{ name: 'status', schema: z.object({ id: z.string() }), execute: async ({ id }) => ({ id }), render: ({ id }) => `${id}: 현재 승인 대기` }],
    complete: async ({ messages }) => {
      expect(messages.some((m) => m.content === 'AXR과 GGGI 9월 조회')).toBe(true);
      return step++ ? { content: '모두 완료' } : { tool_calls: ['AXR', 'GGGI'].map((id) => ({ id, function: { name: 'status', arguments: JSON.stringify({ id }) } })) };
    } });
    expect(result.answer).toContain('AXR: 현재 승인 대기');
    expect(result.answer).toContain('GGGI: 현재 승인 대기');
    expect(result.answer).not.toContain('모두 완료');
  });
  it('renders canonical cycle state and health rather than stale month settlement', () => {
    const tool = settlementTools({})[0];
    const result = { yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08', errors: [], items: [{
      projectId: 'p1', settlementStatuses: { items: [{ period: 'MONTH', status: 'LOCKED' }, { period: 'WEEK_1', status: 'COMPLETED' }] },
      settlementCycle: { health: 'OK', businessState: 'REOPEN_REQUESTED', monthCloseSettlement: { status: 'LOCKED' } },
    }] };
    expect(tool.render(result)).toContain('재개 요청');
    result.items[0].settlementCycle.health = 'UNAVAILABLE';
    expect(tool.render(result)).toContain('확인 필요');
    expect(tool.render(result)).not.toContain('월결산: 확정');
  });
  it('executes validated tools before answering and records only metadata', async () => {
    const records = [];
    let calls = 0;
    const result = await runSettlementAgent({
      question: '9월 정산 현황',
      tools: [{ name: 'status', description: '조회', schema: z.object({}).strict(), execute: async () => ({ status: 'PENDING_APPROVAL' }), render: (result) => result.status }],
      complete: async ({ messages }) => {
        if (calls++ === 0) return { tool_calls: [{ id: 'a', type: 'function', function: { name: 'status', arguments: '{}' } }] };
        expect(messages.at(-1).content).toContain('PENDING_APPROVAL');
        return { content: '모두 승인 완료되었습니다. 999개입니다.' };
      },
      record: async (entry) => records.push(entry),
    });
    expect(result.status).toBe('answered');
    expect(result.answer).toBe('PENDING_APPROVAL');
    expect(records.at(-1)).toEqual({ step: 0, tool: 'status', outcome: 'ok' });
    expect(records[0].policy.version).toBe('binary-scope-l2-v1');
  });

  it('requires clarification on negative reviewed feedback without executing the tool', async () => {
    let executed = false;
    const result = await runSettlementAgent({ question: '조회',
      tools: [{ name: 'status', schema: z.object({}).strict(), execute: async () => { executed = true; } }],
      loadFeedback: async () => [{ id: 'reviewed-vote', value: 0 }],
      complete: async () => ({ tool_calls: [{ id: 'a', function: { name: 'status', arguments: '{}' } }] }),
    });
    expect(result.status).toBe('needs_clarification');
    expect(executed).toBe(false);
    expect(result.policy.gradient).toBeCloseTo(0, 12);
  });

  it('binds feedback to question and canonical scope; explicit confirmation permits only normal validated reads', async () => {
    let seen;
    let step = 0;
    const result = await runSettlementAgent({ question: '미완료 사업 보여줘', isScopeConfirmed: async () => true,
      tools: [{ name: 'status', schema: z.object({ projectIds: z.array(z.string()) }), execute: async () => ({ pending: true }), render: () => '서버: 승인 대기' }],
      loadFeedback: async (scope) => { seen = scope; return [{ id: 'x', value: 0 }]; },
      complete: async () => step++ ? { content: '승인 완료' } : { tool_calls: [{ id: 'a', function: { name: 'status', arguments: '{"projectIds":["b","a"]}' } }] },
    });
    expect(seen).toEqual({ question: '미완료 사업 보여줘', tool: 'status', input: { projectIds: ['a', 'b'] } });
    expect(result).toEqual({ status: 'answered', answer: '서버: 승인 대기' });
  });

  it('keeps partial failure visible and rejects malformed model calls', async () => {
    let step = 0;
    const result = await runSettlementAgent({ question: '전체 현황',
      tools: [{ name: 'status', schema: z.object({}).strict(), execute: async () => ({}), render: () => 'A: 승인 대기' }],
      complete: async () => step++ ? { content: 'A와 B 모두 승인 완료' } : { tool_calls: [
        { id: 'a', function: { name: 'status', arguments: '{}' } },
        { id: 'b', function: { name: 'forbidden', arguments: '{}' } },
      ] },
    });
    expect(result.status).toBe('partial');
    expect(result.answer).toContain('일부 조회가 실패');
    expect(result.answer).not.toContain('모두 승인 완료');
    await expect(runSettlementAgent({ question: '조회', tools: [], complete: async () => ({ tool_calls: {} }) })).rejects.toThrow();
  });

  it('does not present an unsupported model answer as verified', async () => {
    expect(await runSettlementAgent({ question: '다 끝났어?', tools: [], complete: async () => ({ content: '모두 완료' }) })).toMatchObject({ status: 'unverified' });
  });

  it('rejects arbitrary tools and ends bounded loops without executing them', async () => {
    const result = await runSettlementAgent({ question: '조회', tools: [], maxSteps: 2,
      complete: async () => ({ tool_calls: [{ id: 'x', function: { name: 'shell', arguments: '{}' } }] }),
    });
    expect(result.status).toBe('limited');
  });

  it('does not execute when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(runSettlementAgent({ question: '조회', tools: [], signal: controller.signal, complete: async () => { throw new Error('must not call'); } })).rejects.toThrow();
  });
});
