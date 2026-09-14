import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createFirestoreDb } from './firestore.mjs';
import { createSlackWorker, saveSlackFeedback } from '../mcp/slack-runtime.mjs';
import { verifyAgentTrace } from '../mcp/agent-trace.mjs';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('Hermes worker route persistence', () => {
  it('selects Hermes, sends its reviewed reply publicly and persists feedback without changing business data', async () => {
    const db = createFirestoreDb({ projectId: 'demo-hermes-worker', appName: 'hermes-worker-test' });
    const id = randomUUID();
    const identity = { teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId: 'UHERMESTEST', threadTs: '100.1' };
    const member = { email: `${id}@mysc.co.kr`, role: 'pm', status: 'ACTIVE' };
    const project = { name: `Hermes 검증 ${id}`, cic: 'CIC1', status: 'active' };
    const memberRef = db.doc(`orgs/mysc/members/${id}`);
    const projectRef = db.doc(`orgs/mysc/projects/${id}`);
    const jobRef = db.doc(`settlement_agent_jobs/${id}`);
    const threadRef = db.doc(`settlement_agent_threads/${id}`);
    await memberRef.set(member);
    await projectRef.set(project);
    await threadRef.set({ ...identity, queue: [id], turns: [] });
    await jobRef.set({ ...identity, conversationId: id, question: '내 사업을 찾아줘',
      createdAt: new Date().toISOString(), status: 'queued', attempts: 0 });
    const deliveries: any[] = [];
    const readOverview = vi.fn();
    const answer = '🔎 요청하신 사업을 찾았어요. 다음으로 어떤 정산 기간을 확인할까요?';
    const hermesRunner = vi.fn(async ({ tools, question, history, env, loadFeedback, record, reviewAnswer, signal }: any) => {
      expect(env.SETTLEMENT_HERMES_URL).toBe('https://hermes-fixture.run.app');
      expect(question).toBe('내 사업을 찾아줘');
      expect(history).toEqual([]);
      const tool = tools.find((entry: any) => entry.name === 'project_search');
      const input = tool.schema.parse({ query: id });
      await loadFeedback({ question, tool: tool.name, input });
      const result = await tool.execute(input, { signal });
      expect(result.items).toEqual([{ projectId: id, name: project.name }]);
      const evidence = [{ tool: tool.name, input, result }];
      await record({ type: 'hermes_tool_result', ...evidence[0] });
      const review = await reviewAnswer({ question, history, answer, evidence, signal });
      expect(review.supported).toBe(true);
      return { status: 'answered', answer };
    });
    const worker = createSlackWorker({ db, readOverview, hermesRunner,
      env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture',
        SETTLEMENT_HERMES_URL: 'https://hermes-fixture.run.app' },
      completeFactory: () => async ({ messages }: any) => {
        expect(messages[0].content).toContain('독립 검토자');
        expect(JSON.parse(messages.at(-1).content).answer).toBe(answer);
        return { content: JSON.stringify({ supported: true, addressesRequest: true, issues: [] }) };
      },
      fetchImpl: async (url: string, options: any) => {
        if (new URL(url).pathname === '/api/users.info') {
          return Response.json({ ok: true, user: { team_id: identity.teamId, profile: { email: member.email } } });
        }
        expect(url).toBe('https://slack.com/api/chat.postMessage');
        deliveries.push(JSON.parse(options.body));
        return Response.json({ ok: true, ts: '200.1' });
      },
    });
    expect(await worker()).toEqual({ processed: 1 });
    expect(hermesRunner).toHaveBeenCalledTimes(1);
    expect(readOverview).not.toHaveBeenCalled();
    const saved = (await jobRef.get()).data()!;
    expect(saved.status).toBe('succeeded');
    expect(saved.answer).toContain(answer);
    expect(saved.answerTs).toBe('200.1');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ channel: identity.channelId, thread_ts: identity.threadTs });
    expect(deliveries[0].user).toBeUndefined();
    expect(deliveries[0].blocks.some((block: any) => block.type === 'actions'
      && block.elements.some((element: any) => element.action_id === 'settlement_scope_no'))).toBe(true);
    const trace = (await jobRef.collection('trace').orderBy('sequence').get()).docs.map((doc) => doc.data());
    expect(verifyAgentTrace(trace, saved.traceAnchor)).toBe(true);
    expect(trace.some((row) => row.event.type === 'run_start' && row.event.harness === 'hermes-readonly-v1')).toBe(true);
    expect((await threadRef.get()).data()).toMatchObject({ queue: [], turns: [{ jobId: id, question: '내 사업을 찾아줘', answer: saved.answer }] });
    expect(await saveSlackFeedback({ db, teamId: identity.teamId, channelId: identity.channelId, payload: {
      team: { id: identity.teamId }, channel: { id: identity.channelId }, user: { id: identity.slackUserId },
      container: { message_ts: '200.1' }, actions: [{ action_id: 'settlement_scope_no', value: id, action_ts: '201.1' }],
    } })).toBe(true);
    expect((await db.doc(`settlement_agent_feedback/${saved.scopes[0].key}`).get()).data()!.votes[0].value).toBe(0);
    expect((await memberRef.get()).data()).toEqual(member);
    expect((await projectRef.get()).data()).toEqual(project);
    expect(await worker()).toEqual({ processed: 0 });
    expect(deliveries).toHaveLength(1);
  });
});
