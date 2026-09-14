import { EventEmitter } from 'node:events';
import { it, expect, vi } from 'vitest';
import * as z from 'zod/v4';
import { runHermesAgent } from './hermes-harness.mjs';

const usage = { input: 100, output: 20, thinking: 5 };
const final = (extra = {}) => ({ type: 'final', answer: '📌 조회한 사업은 승인 대기입니다.', usage, partial: false, ...extra });
const call = (extra = {}) => ({ type: 'tool_call', id: 'read1', name: 'settlement_report', arguments: { yearMonth: '2026-09' }, ...extra });

function scenario(reply, overrides = {}) {
  const socket = new EventEmitter();
  socket.send = vi.fn((raw) => queueMicrotask(() => reply(JSON.parse(raw), socket)));
  socket.close = vi.fn(() => socket.emit('close'));
  const execute = vi.fn(async () => ({ rows: [{ name: 'AXR', state: 'SUBMITTED' }] }));
  const read = { name: 'settlement_report', description: '정산 조회',
    schema: z.object({ yearMonth: z.string() }).strict(), execute };
  const record = vi.fn(async () => {});
  const reviewAnswer = vi.fn(async () => ({ supported: true, addressesRequest: true, issues: [] }));
  const getToken = vi.fn(async () => 'test-identity-token');
  const connect = vi.fn(async () => socket);
  const promise = runHermesAgent({ question: '9월 정산 현황', history: [], tools: [read],
    signal: AbortSignal.timeout(2000), record, reviewAnswer, getToken, connect,
    env: { SETTLEMENT_HERMES_URL: 'https://hermes-test.run.app' }, ...overrides });
  return { promise, socket, execute, record, reviewAnswer, connect, getToken };
}

const emit = (socket, message) => socket.emit('message', Buffer.from(JSON.stringify(message)), false);

it('executes only the fixed validated read capability and reviews exact source evidence', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') emit(socket, final());
  });
  expect(await run.promise).toEqual({ status: 'answered', answer: final().answer });
  expect(run.execute).toHaveBeenCalledTimes(1);
  expect(run.reviewAnswer.mock.calls[0][0].evidence).toEqual([{ tool: 'settlement_report',
    input: { yearMonth: '2026-09' }, result: { rows: [{ name: 'AXR', state: 'SUBMITTED' }] } }]);
  expect(run.connect.mock.calls[0][0]).toMatchObject({ url: 'wss://hermes-test.run.app/run',
    headers: { Authorization: 'Bearer test-identity-token' } });
  expect(JSON.stringify(run.record.mock.calls)).not.toContain('test-identity-token');
  expect(run.socket.close).toHaveBeenCalledTimes(1);
});

it('trims oldest whole history pairs instead of rejecting a valid long reporting thread', async () => {
  const latest = [{ role: 'user', content: '월결산만 CIC별로 정리해줘' },
    { role: 'assistant', content: '8월 월결산 CIC별 조회 자료입니다.' }];
  const history = [{ role: 'user', content: '지난 주정산 전사 명단' },
    { role: 'assistant', content: '이전 주정산 결과 '.repeat(3500) }, ...latest];
  const original = structuredClone(history);
  let sentHistory;
  const run = scenario((message, socket) => {
    if (message.type === 'start') { sentHistory = message.history; emit(socket, call()); }
    if (message.type === 'tool_result') emit(socket, final());
  }, { question: '아까 그 월결산을 조직장별로 바꿔줘', history });
  expect((await run.promise).status).toBe('answered');
  expect(sentHistory).toEqual(latest);
  expect(run.reviewAnswer.mock.calls[0][0].history).toEqual(latest);
  expect(history).toEqual(original);
});

it('never advertises or executes write tools even if a caller supplies them', async () => {
  const write = vi.fn();
  const run = scenario((message, socket) => {
    if (message.type === 'start') {
      expect(message.tools.map((tool) => tool.name)).toEqual(['agent_capabilities']);
      emit(socket, call({ name: 'delete_project' }));
    }
  }, { tools: [{ name: 'agent_capabilities', schema: z.object({}).strict(), execute: async () => ({ readonly: true }) },
    { name: 'delete_project', schema: z.object({}), execute: write }] });
  await expect(run.promise).rejects.toThrow('hermes_tool_denied');
  expect(write).not.toHaveBeenCalled();
});

it('rejects authority fields smuggled through model arguments before executing reads', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call({ arguments: { yearMonth: '2026-09', actorRole: 'admin', tenantId: 'other' } }));
  });
  await expect(run.promise).rejects.toThrow();
  expect(run.execute).not.toHaveBeenCalled();
});

it('rejects replayed call IDs without executing a second read', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start' || message.type === 'tool_result') emit(socket, call());
  });
  await expect(run.promise).rejects.toThrow('hermes_call_invalid');
  expect(run.execute).toHaveBeenCalledTimes(1);
});

it('rejects malformed, oversized and binary frames without business access', async () => {
  for (const [raw, binary] of [[Buffer.from('{bad'), false], [Buffer.alloc(200001), false], [Buffer.from('{}'), true]]) {
    const run = scenario((message, socket) => { if (message.type === 'start') socket.emit('message', raw, binary); });
    await expect(run.promise).rejects.toThrow();
    expect(run.execute).not.toHaveBeenCalled();
  }
});

it('rejects untrusted endpoints and already-cancelled runs before identity or connection', async () => {
  for (const url of ['http://hermes-test.run.app', 'https://hermes-test.run.app.evil.test',
    'https://user:password@hermes-test.run.app', 'https://hermes-test.run.app/path', 'https://hermes-test.run.app?target=evil']) {
    const run = scenario(() => {}, { env: { SETTLEMENT_HERMES_URL: url } });
    await expect(run.promise).rejects.toThrow('hermes_endpoint_invalid');
    expect(run.getToken).not.toHaveBeenCalled();
    expect(run.connect).not.toHaveBeenCalled();
  }
  const run = scenario(() => {}, { signal: AbortSignal.abort(new Error('cancelled')) });
  await expect(run.promise).rejects.toThrow('cancelled');
  expect(run.getToken).not.toHaveBeenCalled();
});

it('does not execute a queued tool when cancellation arrives', async () => {
  const controller = new AbortController();
  const run = scenario((message, socket) => {
    if (message.type === 'start') { emit(socket, call()); controller.abort(new Error('cancelled')); }
  }, { signal: controller.signal });
  await expect(run.promise).rejects.toThrow('cancelled');
  expect(run.execute).not.toHaveBeenCalled();
});

it('does not start a read after the transport closes during its audit await', async () => {
  let run;
  run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
  }, { record: async (event) => { if (event.type === 'hermes_tool_start') run.socket.emit('close'); } });
  await expect(run.promise).rejects.toThrow('hermes_disconnected');
  await new Promise((resolve) => setImmediate(resolve));
  expect(run.execute).not.toHaveBeenCalled();
});

it('never returns a draft rejected by the grounded reviewer', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') emit(socket, final({ answer: '999개 사업 승인 완료' }));
  }, { reviewAnswer: async () => ({ supported: false, addressesRequest: false, issues: ['unverified'] }) });
  await expect(run.promise).rejects.toThrow('hermes_answer_unverified');
});

it('revises a rejected draft once with the same evidence and no additional tools', async () => {
  for (const accepted of [true, false]) {
    const complete = vi.fn(async () => ({ content: '📌 확인된 자료만 안내합니다.' }));
    const reviewAnswer = vi.fn().mockResolvedValueOnce({ supported: false, addressesRequest: false, issues: ['내부 식별자 제거'] })
      .mockResolvedValue({ supported: accepted, addressesRequest: accepted, issues: [] });
    const run = scenario((message, socket) => {
      if (message.type === 'start') emit(socket, call());
      if (message.type === 'tool_result') emit(socket, final());
    }, { complete, reviewAnswer });
    if (accepted) expect((await run.promise).answer).toBe('📌 확인된 자료만 안내합니다.');
    else await expect(run.promise).rejects.toThrow('hermes_answer_unverified');
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0].tools).toEqual([]);
    expect(run.execute).toHaveBeenCalledTimes(1);
    expect(reviewAnswer).toHaveBeenCalledTimes(2);
    expect(reviewAnswer.mock.calls[1][0].evidence).toEqual(reviewAnswer.mock.calls[0][0].evidence);
  }
});

it('finishes grounded review when the service closes normally after its final frame', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') {
      emit(socket, final());
      setImmediate(() => socket.emit('close'));
    }
  }, { reviewAnswer: async () => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    return { supported: true, addressesRequest: true, issues: [] };
  } });
  expect((await run.promise).status).toBe('answered');
});

it('retains host read failures as partial even when final prose passes review', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') {
      expect(message.result).toMatchObject({ error: 'lookup_failed' });
      emit(socket, final({ answer: '🔎 조회에 실패해 확인하지 못했습니다.' }));
    }
  }, { tools: [{ name: 'settlement_report', schema: z.object({ yearMonth: z.string() }).strict(),
    execute: async () => { throw new Error('secret upstream detail'); } }] });
  const result = await run.promise;
  expect(result.status).toBe('partial');
  expect(JSON.stringify(run.socket.send.mock.calls)).not.toContain('secret upstream detail');
});

it('does not label a service-declared incomplete result as answered', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') emit(socket, final({ partial: true }));
  });
  const result = await run.promise;
  expect(result.status).toBe('partial');
});

it('does not let usage metadata overwrite audit event type or phase', async () => {
  const run = scenario((message, socket) => {
    if (message.type === 'start') emit(socket, call());
    if (message.type === 'tool_result') emit(socket, final({ usage: { ...usage, type: 'forged_event', phase: 'forged_phase' } }));
  });
  await run.promise.catch(() => {});
  expect(run.record.mock.calls.some(([event]) => event.type === 'forged_event' || event.phase === 'forged_phase')).toBe(false);
});
