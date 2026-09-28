import { it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { createSlackIngress } from './slack-ingress.mjs';
import { createSlackWorker } from './slack-runtime.mjs';
import { verifyAgentTrace } from './agent-trace.mjs';

function memoryDb() {
  const records = new Map();
  const snap = (ref) => ({ id: ref.path.split('/').at(-1), ref, exists: records.has(ref.path), data: () => structuredClone(records.get(ref.path)) });
  const db = {
    doc: (path) => ({ path, get: async () => snap(db.doc(path)) }),
    collection: (path) => {
      const filters = [];
      let limit = Infinity;
      const query = {
        where: (field, op, value) => { filters.push([field, op, value]); return query; },
        orderBy: () => query,
        limit: (value) => { limit = value; return query; },
        get: async () => ({ docs: [...records].filter(([key, data]) => key.startsWith(`${path}/`) && !key.slice(path.length + 1).includes('/')
          && filters.every(([field, op, value]) => op === 'in' ? value.includes(data[field]) : data[field] === value))
          .slice(0, limit).map(([key]) => snap(db.doc(key))) }),
      };
      return query;
    },
    runTransaction: async (fn) => {
      const pending = [];
      const value = await fn({ get: async (ref) => snap(ref),
        set: (ref, value) => pending.push(() => records.set(ref.path, structuredClone(value))),
        create: (ref, value) => { if (records.has(ref.path)) throw new Error('already_exists'); pending.push(() => records.set(ref.path, structuredClone(value))); },
        update: (ref, value) => pending.push(() => records.set(ref.path, { ...records.get(ref.path), ...structuredClone(value) })),
      });
      pending.forEach((write) => write());
      return value;
    },
  };
  return { db, records };
}

it.each(['accounting_compare', 'cfo_brief'])('runs %s through signed ingress and worker authorization, audit and Slack delivery', async (toolName) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-28T00:00:00Z'));
  try {
    const { db, records } = memoryDb();
    records.set('orgs/mysc/members/cfo', { email: 'cfo@mysc.co.kr', role: 'finance', status: 'ACTIVE' });
    const timestamp = String(Date.now() / 1000);
    const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T099F304GAY', event_id: 'EV1', event: {
      type: 'app_mention', user: 'UCFO', channel: 'C0BQ6980HR6', ts: `${timestamp}.1`, text: '선택 사업 8월과 9월을 비교해 CFO 브리핑을 작성해줘',
    } }));
    const signature = `v0=${createHmac('sha256', 'fixture').update(`v0:${timestamp}:`).update(body).digest('hex')}`;
    const ingress = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY' });
    await ingress({ body, get: (name) => name.endsWith('timestamp') ? timestamp : signature }, {
      status: (status) => { throw new Error(`ingress ${status}`); }, json: (value) => expect(value.ok).toBe(true),
    });
    const deliveries = [];
    let identityChecks = 0;
    const readSnapshot = vi.fn(async ({ context, params, query }) => {
      expect(context).toMatchObject({ actorId: 'myscube-settlement-agent', actorRole: 'auditor', requestedByActorId: 'cfo', actorEmail: '' });
      const value = query.yearMonth === '2026-08' ? 10 : 25;
      const mode = { rowTotals: {}, weeks: [{ weekNo: 1, amounts: { SALES_IN: value }, weekIn: value, weekOut: 0, net: value }], monthTotals: { totalIn: value, totalOut: 0, net: value } };
      return { projectId: params.projectId, targetRevision: 'fixture-version', accountingSource: { weeklyYear: 2026, projectName: '대표 사업' },
        readModel: { months: [{ yearMonth: query.yearMonth, projection: mode, actual: mode }] } };
    });
    const worker = createSlackWorker({ db, readSnapshot,
      env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture' },
      fetchImpl: async (url, options) => {
        if (new URL(url).pathname === '/api/users.info') {
          identityChecks++;
          return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email: 'cfo@mysc.co.kr' } } });
        }
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        deliveries.push(JSON.parse(options.body));
        return Response.json({ ok: true, ts: '123.1' });
      },
      completeFactory: () => async ({ messages, tools }) => {
        if (messages.some((message) => message.role === 'tool')) return { content: '999개 승인 완료. 변동 원인은 횡령. 지급 실행 완료.' };
        expect(tools.some((tool) => tool.function.name === toolName)).toBe(true);
        return { tool_calls: [{ id: 'cfo', function: { name: toolName, arguments: JSON.stringify({ projectIds: ['a'], baseline: { yearMonth: '2026-08' }, current: { yearMonth: '2026-09' } }) } }] };
      },
    });
    expect(await worker()).toEqual({ processed: 1 });
    expect(readSnapshot).toHaveBeenCalledTimes(2);
    expect(identityChecks).toBeGreaterThanOrEqual(6);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channel: 'C0BQ6980HR6', thread_ts: `${timestamp}.1` });
    expect(deliveries[0].text).toContain('변화 15원');
    expect(deliveries[0].text).toContain('기록된 JVM 주차');
    expect(deliveries[0].text).not.toContain('fixture-version');
    const [path, saved] = [...records].find(([path]) => /^settlement_agent_jobs\/[^/]+$/.test(path));
    expect(saved.status).toBe('succeeded');
    expect(saved.answer).not.toMatch(/999|횡령|지급 실행/);
    expect(deliveries[0].text).not.toMatch(/999|횡령|지급 실행/);
    expect(records.get('settlement_agent_budgets/2026-09')).toMatchObject({ reservedKrw: 500, attempts: 1 });
    const trace = [...records].filter(([key]) => key.startsWith(`${path}/trace/`)).map(([, data]) => data).sort((a, b) => a.sequence - b.sequence);
    expect(verifyAgentTrace(trace, saved.traceAnchor)).toBe(true);
    expect(trace.some((entry) => entry.event.type === 'tool_result' && entry.event.tool === toolName)).toBe(true);
    if (toolName === 'cfo_brief') expect(trace.some((entry) => entry.event.type === 'cfo_workflow_stage')).toBe(true);
    expect(await worker()).toEqual({ processed: 0 });
    expect(deliveries).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
