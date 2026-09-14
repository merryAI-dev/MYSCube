import { describe, it, expect, vi } from 'vitest';
import { createSupportTools, summarizeDiagnostic, summarizeClientError } from './support-read.mjs';
import { createAgentTrace } from './agent-trace.mjs';
import { readFileSync, existsSync } from 'node:fs';

describe('read-only support harness', () => {
  it('keeps client-reported errors bounded and excludes payloads and identity', () => {
    const value = summarizeClientError({ name: 'PlatformApiError', route: '/portal/cashflow/secret-project',
      message: 'Bearer secret', stack: 'secret-stack', actorEmail: 'secret@mysc.co.kr',
      extra: { status: 409, code: 'cashflow_month_close_validation_failed', token: 'secret' } });
    expect(value).toMatchObject({ area: 'cashflow', httpStatus: 409, code: 'cashflow_month_close_validation_failed' });
    expect(JSON.stringify(value)).not.toMatch(/secret|Bearer|actorEmail|stack/);
  });
  it('exposes verified execution metadata, never source payloads or unrecognized strings', async () => {
    const records = [];
    let anchor;
    const job = { leaseId: 'lease', leaseUntil: Date.now() + 60000, status: 'succeeded',
      question: 'secret question', answer: 'secret answer', audit: [{ type: 'failure', code: 'Bearer secret' }] };
    const db = { doc: (path) => ({ path }), runTransaction: (run) => run({
      get: async () => ({ data: () => job }), create: (_ref, value) => records.push(value), set: () => {},
      update: (_ref, value) => { anchor = value.traceAnchor; },
    }) };
    const trace = createAgentTrace({ db, jobId: 'job', leaseId: 'lease' });
    await trace({ type: 'hermes_tool_result', tool: 'accounting_read', result: { token: 'secret-token', amount: 100 } });
    await trace({ type: 'answer_review', review: { supported: true, addressesRequest: false, issues: ['secret-review'] } });
    const result = summarizeDiagnostic({ ...job, traceAnchor: anchor }, records);
    expect(result.traceValid).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].review).toEqual({ supported: true, addressesRequest: false });
    expect(result.failures).toEqual(['unclassified_failure']);
    expect(JSON.stringify(result)).not.toMatch(/secret|Bearer|amount|issues/);
    records[0].event.result.amount = 999;
    expect(summarizeDiagnostic({ ...job, traceAnchor: anchor }, records)).toMatchObject({ traceValid: false, steps: [] });
  });

  it('filters other channels and threads and rejects executable or identity arguments', async () => {
    const job = { id: 'current', teamId: 'team', channelId: 'channel', threadTs: 'thread' };
    const rows = [
      { ...job, id: 'own', status: 'failed' },
      { ...job, id: 'other-channel', channelId: 'private' },
      { ...job, id: 'other-thread', threadTs: 'different' },
    ].map((value) => ({ id: value.id, data: () => value }));
    const query = { orderBy: () => query, limit: () => query, get: async () => ({ docs: rows }) };
    const authorize = vi.fn(async () => {});
    const tools = createSupportTools({ db: { collection: () => query }, job, authorize });
    const diagnostics = tools.find((tool) => tool.name === 'agent_diagnostics');
    expect(() => diagnostics.schema.parse({ scope: 'current_thread', actorRole: 'admin' })).toThrow();
    expect(() => tools[0].schema.parse({ topic: 'all', path: '/etc/passwd' })).toThrow();
    const result = await diagnostics.execute({ scope: 'current_thread', limit: 5 }, { signal: AbortSignal.timeout(1000) });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].deliveryState).toBe('failed');
    expect(authorize).toHaveBeenCalledTimes(2);
    authorize.mockRejectedValueOnce(new Error('member_inactive'));
    await expect(tools[0].execute({ topic: 'all' })).rejects.toThrow('member_inactive');
  });

  it('keeps static knowledge distinct from observed incidents', async () => {
    const [knowledge] = createSupportTools({ authorize: async () => {}, revision: 'secret' });
    const result = await knowledge.execute({ topic: 'sheet_validation' });
    expect(result.deploymentRevision).toBeNull();
    expect(result.entries).toHaveLength(1);
    expect(result.warning).toContain('현재 장애의 증거가 아닙니다');
    expect(result.entries[0].facts.join(' ')).toContain('Projection과 Actual 금액이 다르다는 의미가 아닙니다');
    for (const source of result.entries[0].sources) expect(existsSync(source.split('#')[0])).toBe(true);
    const code = readFileSync('server/bff/routes/jvm-weekly-api.mjs', 'utf8');
    expect(code).toContain('projectionRows.length !== 19 || actualRows.length !== 19');
    expect(code).toContain("typeof controls?.deposit?.matches !== 'boolean'");
  });
});
