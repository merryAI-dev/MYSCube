import { describe, it, expect } from 'vitest';
import { createFirestoreDb } from './firestore.mjs';
import { createSlackWorker, claimSlackJob, updateClaimedJob, saveSlackFeedback } from '../mcp/slack-runtime.mjs';
import { createHash } from 'node:crypto';
import { createHmac } from 'node:crypto';
import { createSlackIngress } from '../mcp/slack-ingress.mjs';
import { verifyAgentTrace } from '../mcp/agent-trace.mjs';
import { buildJavaWeeklyTrustedHeaders } from './java-weekly-auth.mjs';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('cloud settlement worker persistence', () => {
  it('runs search and canonical status lookup, publicly replies, keeps errors private and reloads feedback', async () => {
    const db = createFirestoreDb({ projectId: 'demo-agent-runtime', appName: 'agent-runtime-test' });
    const id = createHash('sha256').update(`job-${Date.now()}`).digest('hex');
    const memberId = `actor-${id}`;
    const projectId = `project-${id}`;
    const slackUserId = 'UAGENTTEST';
    const email = `${id}@mysc.co.kr`;
    await db.doc(`orgs/mysc/members/${memberId}`).set({ email, role: 'pm', status: 'ACTIVE' });
    await db.doc(`orgs/mysc/members/${memberId}-historical`).set({ email, role: 'admin', status: 'INACTIVE' });
    await db.doc(`orgs/mysc/projects/${projectId}`).set({ name: `사업-${id}` });
    const timestamp = String(Math.floor(Date.now() / 1000));
    const threadTs = `${timestamp}.1`;
    const ingress = createSlackIngress({ db, secret: 'fixture', teamId: 'T099F304GAY' });
    const enqueue = async (type: string, ts: string, text: string) => {
      const body = Buffer.from(JSON.stringify({ type: 'event_callback', team_id: 'T099F304GAY', event_id: ts,
        event: { type, user: slackUserId, channel: 'C0BQ6980HR6', ts, thread_ts: threadTs, text } }));
      const signature = `v0=${createHmac('sha256', 'fixture').update(`v0:${timestamp}:`).update(body).digest('hex')}`;
      const res = { status: (code: number) => { throw new Error(`ingress ${code}`); }, json: (value: any) => { expect(value.ignored).not.toBe(true); } };
      await ingress({ body, get: (name: string) => name.endsWith('timestamp') ? timestamp : signature }, res);
      return db.doc(`settlement_agent_jobs/${createHash('sha256').update(`T099F304GAY:C0BQ6980HR6:${ts}`).digest('hex')}`);
    };
    const firstRef = await enqueue('app_mention', threadTs, `2026-09 사업-${id} 조회`);
    const secondRef = await enqueue('message', `${timestamp}.2`, '그 사업 다시 확인해줘');
    expect(await claimSlackJob({ db, jobId: secondRef.id })).toBeNull();
    const deliveries: any[] = [];
    let lookups = 0;
    let turn = 0;
    const status = (period: string) => ({ period, status: period === 'MONTH' ? 'LOCKED' : 'COMPLETED', revision: 1,
      submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', deadlineAt: '2026-09-01T00:00:00Z', approverDeadlineAt: '2026-09-02T00:00:00Z' });
    const overview = { version: '5', yearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08', monthCloseTargetLabel: '8월', errors: [], items: [{ projectId,
      settlementStatuses: { projectId, yearMonth: '2026-09', items: ['MONTH','WEEK_1','WEEK_2','WEEK_3','WEEK_4','WEEK_5'].map(status) },
      projectionActualSummary: null, sheetCapturedAt: null,
      settlementCycle: { cycleYearMonth: '2026-09', weeklyYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08', businessState: 'LOCKED', health: 'OK', workflowRevision: 1,
        monthCloseSettlement: status('MONTH'), provenance: null, supersededAttempt: null,
        commandCapabilities: Object.fromEntries(['SUBMIT_MONTH_CLOSE','WITHDRAW_MONTH_CLOSE','APPROVE_MONTH_CLOSE','REJECT_MONTH_CLOSE','REQUEST_MONTH_REOPEN','APPROVE_MONTH_REOPEN','REJECT_MONTH_REOPEN','CANCEL_ACTIVE_CYCLE'].map((key) => [key, { allowed: false, reasonCode: 'NOT_ALLOWED' }])) },
    }] };
    const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', SETTLEMENT_AGENT_GEMINI_API_KEY: 'fixture' },
      fetchImpl: async (url: string, options: any) => {
        if (new URL(url).pathname === '/api/users.info') {
          expect(options.method).toBe('GET');
          expect(new URL(url).searchParams.get('user')).toBe(slackUserId);
          expect(options.body).toBeUndefined();
          return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email } } });
        }
        expect(url).toBe(`https://slack.com/api/${deliveries.length < 2 ? 'chat.postMessage' : 'chat.postEphemeral'}`);
        deliveries.push(JSON.parse(options.body));
        return Response.json({ ok: true, message_ts: '2.1', ts: '2.1' });
      },
      readOverview: async ({ context, body }: any) => {
        expect(context).toMatchObject({ actorId: 'myscube-settlement-agent', actorRole: 'auditor',
          actorEmail: '', requestedByActorId: memberId, authSource: 'settlement_agent_read' });
        const headers = await buildJavaWeeklyTrustedHeaders({ context, serviceToken: 'fixture', authMode: 'internal_saas_workspace' });
        expect(headers['x-actor-role']).toBe('auditor');
        expect(headers['x-actor-id']).toBe('myscube-settlement-agent');
        expect(body.projectIds).toEqual([projectId]);
        lookups++;
        return overview;
      },
      completeFactory: () => async ({ messages }: any) => {
        turn++;
        if (turn === 4) {
          expect(messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)).toEqual([`2026-09 사업-${id} 조회`, '그 사업 다시 확인해줘']);
          return { tool_calls: [{ id: 'c', function: { name: 'cashflow_status', arguments: JSON.stringify({ yearMonth: '2026-09', projectIds: [projectId] }) } }] };
        }
        if (turn === 1) return { tool_calls: [{ id: 'a', function: { name: 'project_search', arguments: JSON.stringify({ query: id }) } }] };
        if (turn === 2) return { tool_calls: [{ id: 'b', function: { name: 'cashflow_status', arguments: JSON.stringify({ yearMonth: '2026-09', projectIds: [projectId] }) } }] };
        return { content: '허위 모델 답변: 999개 반려' };
      },
    });
    await worker();
    expect(lookups).toBe(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].user).toBeUndefined();
    expect(deliveries[0].channel).toBe('C0BQ6980HR6');
    expect(deliveries[0].thread_ts).toBeDefined();
    expect(deliveries[0].text).toContain('월결산: 확정');
    expect(deliveries[0].text).not.toContain('999');
    const saved = (await firstRef.get()).data()!;
    expect(saved.status).toBe('succeeded');
    expect(saved.audit.length).toBeGreaterThan(0);
    const trace = (await firstRef.collection('trace').orderBy('sequence').get()).docs.map((doc) => doc.data());
    expect(verifyAgentTrace(trace, saved.traceAnchor)).toBe(true);
    expect(trace.some((row) => row.event.type === 'tool_result')).toBe(true);
    await worker();
    expect(deliveries).toHaveLength(2);
    expect(lookups).toBe(2);
    expect(deliveries[1].text).toContain('월결산: 확정');
    expect((await secondRef.get()).data()!.status).toBe('succeeded');
    const followupTrace = (await secondRef.collection('trace').get()).docs.map((doc) => doc.data());
    expect(followupTrace.find((row) => row.event.type === 'conversation_feedback')?.event).toMatchObject({ previousAnswerId: firstRef.id, trainingEligible: false });
    const conversation = (await db.doc(`settlement_agent_threads/${saved.conversationId}`).get()).data()!;
    expect(conversation.queue).toEqual([]);
    expect(conversation.turns).toHaveLength(2);
    await worker();
    expect(deliveries).toHaveLength(2);
    const payload = { team: { id: saved.teamId }, channel: { id: saved.channelId }, user: { id: slackUserId }, container: { message_ts: '2.1' }, actions: [{ action_id: 'settlement_scope_no', value: firstRef.id, action_ts: '3.1' }] };
    expect(await saveSlackFeedback({ db, payload, teamId: saved.teamId, channelId: saved.channelId })).toBe(true);
    expect((await db.doc(`settlement_agent_feedback/${saved.scopes[0].key}`).get()).data()!.votes[0].value).toBe(0);
    await db.doc(`orgs/mysc/members/${memberId}-duplicate`).set({ email, role: 'admin', status: 'ACTIVE' });
    const deniedRef = await enqueue('message', `${timestamp}.3`, '다시 조회');
    await worker();
    expect(lookups).toBe(2);
    expect((await deniedRef.get()).data()!.audit).toContainEqual({ type: 'failure', code: 'member_unverified' });
    expect(deliveries[2].user).toBe(slackUserId);
  });

  it('permits only one concurrent claimant and rejects a replaced lease', async () => {
    const db = createFirestoreDb({ projectId: 'demo-agent-runtime', appName: 'agent-runtime-test' });
    const jobId = `lease-${Date.now()}`;
    const ref = db.doc(`settlement_agent_jobs/${jobId}`);
    await ref.set({ status: 'queued', attempts: 0 });
    const jobs = await Promise.all([claimSlackJob({ db, jobId }), claimSlackJob({ db, jobId })]);
    expect(jobs.filter(Boolean)).toHaveLength(1);
    const old = jobs.find(Boolean)!;
    await ref.update({ leaseUntil: Date.now() - 1 });
    const next = await claimSlackJob({ db, jobId });
    expect(next.leaseId).not.toBe(old.leaseId);
    await expect(updateClaimedJob({ db, job: old, patch: { status: 'succeeded' } })).rejects.toThrow('lease');
    await updateClaimedJob({ db, job: next, patch: { status: 'succeeded' } });
    await expect(updateClaimedJob({ db, job: next, patch: { status: 'failed' } })).rejects.toThrow('lease');
  });

  it('releases a failed conversation head without copying its answer into history', async () => {
    const db = createFirestoreDb({ projectId: 'demo-agent-runtime', appName: 'agent-runtime-test' });
    const conversationId = `failed-${Date.now()}`;
    const identity = { conversationId, teamId: 'T1', channelId: 'C1', slackUserId: 'U1', threadTs: '1.1' };
    const first = `${conversationId}-1`, second = `${conversationId}-2`;
    const threadRef = db.doc(`settlement_agent_threads/${conversationId}`);
    await threadRef.set({ ...identity, queue: [first, second], turns: [] });
    for (const id of [first, second]) await db.doc(`settlement_agent_jobs/${id}`).set({ ...identity, status: 'queued', attempts: 0 });
    const job = await claimSlackJob({ db, jobId: first });
    await updateClaimedJob({ db, job, patch: { status: 'failed' } });
    expect((await threadRef.get()).data()).toMatchObject({ queue: [second], turns: [] });
    expect((await claimSlackJob({ db, jobId: second })).turns).toEqual([]);
  });
});
