import { describe, it, expect } from 'vitest';
import * as z from 'zod/v4';
import { runSettlementAgent } from './settlement-agent.mjs';

describe('settlement agent', () => {
  it('executes validated tools before answering and records only metadata', async () => {
    const records = [];
    let calls = 0;
    const result = await runSettlementAgent({
      question: '9월 정산 현황',
      tools: [{ name: 'status', description: '조회', schema: z.object({}).strict(), execute: async () => ({ status: 'PENDING_APPROVAL' }) }],
      complete: async ({ messages }) => {
        if (calls++ === 0) return { tool_calls: [{ id: 'a', type: 'function', function: { name: 'status', arguments: '{}' } }] };
        expect(messages.at(-1).content).toContain('PENDING_APPROVAL');
        return { content: '조직장 승인 대기입니다.' };
      },
      record: async (entry) => records.push(entry),
    });
    expect(result.status).toBe('answered');
    expect(records).toEqual([{ step: 0, tool: 'status', outcome: 'ok' }]);
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
