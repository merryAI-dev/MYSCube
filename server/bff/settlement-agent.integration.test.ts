import { describe, it, expect } from 'vitest';
import { createFirestoreDb } from './firestore.mjs';
import { createSlackWorker, claimSlackJob, updateClaimedJob, saveSlackFeedback } from '../mcp/slack-runtime.mjs';
import { createHash } from 'node:crypto';

describe.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('cloud settlement worker persistence', () => {
  it('runs search and canonical status lookup, privately replies, persists and reloads feedback', async () => {
    const db = createFirestoreDb({ projectId: 'demo-agent-runtime', appName: 'agent-runtime-test' });
    const id = createHash('sha256').update(`job-${Date.now()}`).digest('hex');
    const memberId = `actor-${id}`;
    const projectId = `project-${id}`;
    const slackUserId = 'UAGENTTEST';
    const email = `${id}@mysc.co.kr`;
    const jobRef = db.doc(`settlement_agent_jobs/${id}`);
    await db.doc(`orgs/mysc/members/${memberId}`).set({ email, role: 'pm', status: 'ACTIVE' });
    await db.doc(`orgs/mysc/projects/${projectId}`).set({ name: `사업-${id}` });
    await jobRef.create({ teamId: 'T099F304GAY', channelId: 'C0BQ6980HR6', slackUserId, threadTs: '1.1', question: `2026-09 사업-${id} 조회`, status: 'queued', attempts: 0 });
    const deliveries: any[] = [];
    let lookedUp = false;
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
    const worker = createSlackWorker({ db, env: { SLACK_ALERT_BOT_TOKEN: 'fixture', GEMINI_API_KEY: 'fixture' },
      fetchImpl: async (url: string, options: any) => {
        if (url.endsWith('users.info')) return Response.json({ ok: true, user: { team_id: 'T099F304GAY', profile: { email } } });
        expect(url).toBe('https://slack.com/api/chat.postEphemeral');
        deliveries.push(JSON.parse(options.body));
        return Response.json({ ok: true, message_ts: '2.1' });
      },
      readOverview: async ({ context, body }: any) => {
        expect(context.actorId).toBe(memberId);
        expect(body.projectIds).toEqual([projectId]);
        lookedUp = true;
        return overview;
      },
      completeFactory: () => async () => {
        turn++;
        if (turn === 1) return { tool_calls: [{ id: 'a', function: { name: 'project_search', arguments: JSON.stringify({ query: id }) } }] };
        if (turn === 2) return { tool_calls: [{ id: 'b', function: { name: 'cashflow_status', arguments: JSON.stringify({ yearMonth: '2026-09', projectIds: [projectId] }) } }] };
        return { content: '허위 모델 답변: 999개 반려' };
      },
    });
    await worker();
    expect(lookedUp).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].user).toBe(slackUserId);
    expect(deliveries[0].text).toContain('월결산: 확정');
    expect(deliveries[0].text).not.toContain('999');
    const saved = (await jobRef.get()).data()!;
    expect(saved.status).toBe('succeeded');
    expect(saved.audit.length).toBeGreaterThan(0);
    await worker();
    expect(deliveries).toHaveLength(1);
    const payload = { team: { id: saved.teamId }, channel: { id: saved.channelId }, user: { id: slackUserId }, container: { message_ts: '2.1' }, actions: [{ action_id: 'settlement_scope_no', value: id, action_ts: '3.1' }] };
    expect(await saveSlackFeedback({ db, payload, teamId: saved.teamId, channelId: saved.channelId })).toBe(true);
    expect((await db.doc(`settlement_agent_feedback/${saved.scopes[0].key}`).get()).data()!.votes[0].value).toBe(0);
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
});
