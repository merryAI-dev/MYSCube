import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifySlackRequest } from './slack-ingress.mjs';
import * as z from 'zod/v4';
import { createGeminiCompletion } from './gemini-model.mjs';
import { runSettlementAgent, settlementTools } from './settlement-agent.mjs';
import { assertActorRoleAllowed, ROUTE_ROLES } from '../bff/bff-utils.mjs';

export function verifySettlementWorkerToken({ authorization = '', secret = '', disabled = false }) {
  if (disabled || !secret || !authorization.startsWith('Bearer ')) return false;
  return timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), createHash('sha256').update(secret).digest());
}

export async function reserveAgentBudget(db, month) {
  if (!/^2026-(09|10|11|12)$/.test(month)) throw new Error('budget_policy_expired');
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`settlement_agent_budgets/${month}`);
    const budget = (await tx.get(ref)).data() || { reservedKrw: 0, attempts: 0 };
    if (!Number.isSafeInteger(budget.reservedKrw) || budget.reservedKrw < 0 || budget.reservedKrw + 500 > 30000) throw new Error('budget_exhausted');
    tx.set(ref, { reservedKrw: budget.reservedKrw + 500, attempts: budget.attempts + 1, policy: '2026-09-14-500krw-per-attempt' });
  });
}

export function createSlackWorker({ db, readOverview, env = process.env, fetchImpl = fetch, completeFactory = createGeminiCompletion }) {
  const teamId = 'T099F304GAY';
  const channelId = 'C0BQ6980HR6';
  const tenantId = 'mysc';
  async function slack(method, body) {
    const readUser = method === 'users.info';
    const response = await fetchImpl(`https://slack.com/api/${method}${readUser ? `?${new URLSearchParams(body)}` : ''}`, {
      method: readUser ? 'GET' : 'POST', headers: { authorization: `Bearer ${env.SLACK_ALERT_BOT_TOKEN}`, ...(!readUser ? { 'content-type': 'application/json' } : {}) },
      ...(!readUser ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(`slack_${['missing_scope', 'invalid_auth', 'not_in_channel', 'ratelimited', 'user_not_found'].includes(result.error) ? result.error : 'unavailable'}`);
    return result;
  }
  async function contextFor(job) {
    if (job.teamId !== teamId || job.channelId !== channelId) throw new Error('workspace_not_allowed');
    const { user } = await slack('users.info', { user: job.slackUserId });
    const email = user?.profile?.email?.trim().toLowerCase();
    if (user?.deleted || user?.is_bot || user?.is_restricted || user?.is_ultra_restricted || user?.team_id !== teamId || !email?.endsWith('@mysc.co.kr')) throw new Error('member_unverified');
    const members = await db.collection(`orgs/${tenantId}/members`).where('email', '==', email).limit(2).get();
    if (members.docs.length !== 1) throw new Error('member_unverified');
    const member = members.docs[0].data();
    if (member.status !== 'ACTIVE') throw new Error('member_inactive');
    const context = { tenantId, actorId: members.docs[0].id, actorRole: member.role, actorEmail: email, actorName: member.name || '', authSource: 'slack_verified', requestId: job.id };
    assertActorRoleAllowed({ context }, ROUTE_ROLES.readCore, 'read settlement agent projects');
    return context;
  }
  async function process(job) {
    const scopes = [];
    const audit = [];
    let answer;
    try {
      await contextFor(job);
      if (!env.SETTLEMENT_AGENT_GEMINI_API_KEY) throw new Error('model_not_configured');
      await reserveAgentBudget(db, new Date().toISOString().slice(0, 7));
      const tools = settlementTools({ readStatus: async (input) => readOverview({ context: await contextFor(job), body: input }) });
      tools[0].schema = z.object({ yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), projectIds: z.array(z.string().min(1).max(120).regex(/^[^/]+$/)).min(1).max(20) }).strict();
      tools.push({ name: 'project_search', description: '사업명을 검색해 정산 조회에 사용할 프로젝트 ID를 확인합니다. 결과가 잘렸으면 전체 목록이 아닙니다.',
        schema: z.object({ query: z.string().min(1).max(100) }).strict(),
        execute: async ({ query }) => {
          await contextFor(job);
          const result = await db.collection(`orgs/${tenantId}/projects`).select('name').limit(1000).get();
          const matches = result.docs.map((doc) => ({ projectId: doc.id, name: doc.data().name || '' })).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
          return { items: matches.slice(0, 20), truncated: result.docs.length === 1000 || matches.length > 20 };
        }, render: (result) => `사업 검색 결과${result.truncated ? ' (일부 결과)' : ''}\n${result.items.map((item) => `${item.name}: ${item.projectId}`).join('\n') || '일치하는 사업이 없습니다.'}`,
      });
      const complete = completeFactory({ apiKey: env.SETTLEMENT_AGENT_GEMINI_API_KEY, maxInputTokens: 16000,
        onUsage: async (usage) => audit.push({ type: 'usage', input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, thinking: usage.thoughtsTokenCount || 0 }),
      });
      const result = await runSettlementAgent({ question: job.question, history: (job.turns || []).flatMap((turn) => [
        { role: 'user', content: turn.question }, { role: 'assistant', content: turn.answer },
      ]), tools, complete, maxSteps: 3, signal: AbortSignal.timeout(100000),
        loadFeedback: async (scope) => {
          const key = feedbackScopeKey(job, scope);
          if (!scopes.some((item) => item.key === key)) scopes.push({ key, scope });
          const prior = (await db.doc(`settlement_agent_feedback/${key}`).get()).data();
          return (prior?.votes || []).map(({ id, value }) => ({ id, value }));
        }, record: async (record) => audit.push(record),
      });
      await contextFor(job);
      answer = result.answer;
    } catch (error) {
      audit.push({ type: 'failure', code: /^[a-z_]+$/.test(error.message || '') ? error.message : 'lookup_failed' });
      answer = '정산 정보를 확인하지 못했습니다. MYSCube 활성 계정 연결, Slack 앱 권한 또는 모델·예산 설정을 확인해야 합니다. 정산 상태를 완료나 미완료로 판단하지 않았습니다.';
    }
    const text = `${answer.slice(0, 2700)}${answer.length > 2700 ? '\n일부 내용은 생략했습니다. 사업 범위를 좁혀 조회해 주세요.' : ''}\n조회 시각: ${new Date().toISOString()} · 요청 ${job.id.slice(0, 8)}`;
    const blocks = [{ type: 'section', text: { type: 'plain_text', text } }];
    if (scopes.length) blocks.push({ type: 'section', text: { type: 'plain_text', text: '제가 조회한 사업·기간이 질문 의도와 맞나요? (정산값 자체의 정오 평가가 아닙니다)' } }, { type: 'actions', elements: [
      { type: 'button', action_id: 'settlement_scope_yes', text: { type: 'plain_text', text: '예 · 범위가 맞아요' }, value: job.id },
      { type: 'button', action_id: 'settlement_scope_no', text: { type: 'plain_text', text: '아니요 · 범위가 달라요' }, value: job.id },
    ] });
    await updateClaimedJob({ db, job, patch: { status: 'sending', answer: text, scopes, audit, answeredAt: new Date().toISOString() } });
    try {
      const result = await slack('chat.postEphemeral', { channel: channelId, user: job.slackUserId, thread_ts: job.threadTs, text, blocks });
      await updateClaimedJob({ db, job, patch: { status: 'succeeded', answerTs: result.message_ts } });
    } catch {
      await updateClaimedJob({ db, job, patch: { status: 'delivery_unknown' } });
    }
  }
  return async () => {
    if (!env.SLACK_ALERT_BOT_TOKEN) throw new Error('slack_not_configured');
    const pending = await db.collection('settlement_agent_jobs').where('status', 'in', ['queued', 'running', 'sending']).orderBy('createdAt', 'asc').limit(10).get();
    let processed = 0;
    for (const doc of pending.docs) {
      if (doc.data().status === 'sending' && doc.data().leaseUntil < Date.now()) {
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(doc.ref)).data();
          if (current?.status === 'sending' && current.leaseUntil < Date.now()) {
            await finishConversation(tx, db, { ...current, id: doc.id }, 'delivery_unknown');
            tx.update(doc.ref, { status: 'delivery_unknown' });
          }
        });
        continue;
      }
      const job = await claimSlackJob({ db, jobId: doc.id });
      if (job) { await process(job); processed++; }
      if (processed >= 1) break;
    }
    return { processed };
  };
}

export async function saveSlackFeedback({ db, payload, teamId, channelId }) {
  const action = payload?.actions?.[0];
  if (payload?.team?.id !== teamId || payload?.channel?.id !== channelId
    || payload.actions?.length !== 1 || !['settlement_scope_yes', 'settlement_scope_no'].includes(action?.action_id)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(action?.value || '')
    || !/^\d{1,12}\.\d{1,6}$/.test(action?.action_ts || '')) return false;
  return db.runTransaction(async (tx) => {
    const jobRef = db.doc(`settlement_agent_jobs/${action.value}`);
    const job = (await tx.get(jobRef)).data();
    if (job?.status !== 'succeeded' || job.slackUserId !== payload.user?.id
      || job.teamId !== teamId || job.channelId !== channelId || job.answerTs !== payload.container?.message_ts
      || !job.scopes?.length) return false;
    const refs = job.scopes.map(({ key }) => db.doc(`settlement_agent_feedback/${key}`));
    const snapshots = await Promise.all(refs.map((ref) => tx.get(ref)));
    const voteRef = db.doc(`settlement_agent_jobs/${action.value}/feedback/${payload.user.id}`);
    const previousVote = (await tx.get(voteRef)).data();
    if (previousVote && Number(previousVote.actionTs) >= Number(action.action_ts)) return true;
    const value = action.action_id === 'settlement_scope_yes' ? 1 : 0;
    for (const [index, ref] of refs.entries()) {
      const previous = snapshots[index].data() || {};
      const votes = previous.votes || [];
      const old = votes.find((vote) => vote.id === action.value);
      if (old && Number(old.actionTs) >= Number(action.action_ts)) continue;
      // ponytail: last 100 distinct answers per scope; full history remains on each job.
      tx.set(ref, { value, votes: [...votes.filter((v) => v.id !== action.value), { id: action.value, value, actionTs: action.action_ts }].slice(-100), updatedAt: new Date().toISOString() });
    }
    tx.set(voteRef, { value, actionTs: action.action_ts });
    return true;
  });
}

export function createFeedbackIngress({ db, secret, teamId, channelId }) {
  return async (req, res) => {
    if (!verifySlackRequest({ body: req.body, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), secret })) return res.status(401).json({ error: 'invalid_signature' });
    let payload;
    try { payload = JSON.parse(new URLSearchParams(req.body.toString('utf8')).get('payload')); }
    catch { return res.status(400).json({ error: 'invalid_payload' }); }
    try {
      if (!await saveSlackFeedback({ db, payload, teamId, channelId })) return res.status(403).json({ error: 'feedback_not_allowed' });
      return res.json({ ok: true });
    } catch { return res.status(503).json({ error: 'feedback_storage_unavailable' }); }
  };
}

export function feedbackScopeKey({ teamId, slackUserId }, scope) {
  return createHash('sha256').update(JSON.stringify([teamId, slackUserId, scope])).digest('hex');
}

export async function claimSlackJob({ db, jobId, now = Date.now() }) {
  const ref = db.doc(`settlement_agent_jobs/${jobId}`);
  return db.runTransaction(async (tx) => {
    const job = (await tx.get(ref)).data();
    if (!job || !['queued', 'running'].includes(job.status) || (job.status === 'running' && job.leaseUntil > now)) return null;
    const thread = job.conversationId ? (await tx.get(db.doc(`settlement_agent_threads/${job.conversationId}`))).data() : null;
    if (job.conversationId && (!thread || thread.queue[0] !== jobId || thread.slackUserId !== job.slackUserId || thread.teamId !== job.teamId || thread.channelId !== job.channelId || thread.threadTs !== job.threadTs)) return null;
    if (job.attempts >= 3) { await finishConversation(tx, db, { ...job, id: jobId }, 'failed'); tx.update(ref, { status: 'failed', reason: 'attempt_limit' }); return null; }
    const leaseId = randomUUID();
    tx.update(ref, { status: 'running', leaseId, leaseUntil: now + 180_000, attempts: job.attempts + 1 });
    return { ...job, id: jobId, leaseId, turns: thread?.turns || [] };
  });
}

export async function updateClaimedJob({ db, job, patch }) {
  return db.runTransaction(async (tx) => {
    const ref = db.doc(`settlement_agent_jobs/${job.id}`);
    const current = (await tx.get(ref)).data();
    if (!['running', 'sending'].includes(current?.status) || current?.leaseId !== job.leaseId || current.leaseUntil < Date.now()) throw new Error('job_lease_lost');
    if (['succeeded', 'delivery_unknown', 'failed'].includes(patch.status)) await finishConversation(tx, db, { ...current, id: job.id }, patch.status);
    tx.update(ref, patch);
  });
}

async function finishConversation(tx, db, job, status) {
  if (!job.conversationId) return;
  const ref = db.doc(`settlement_agent_threads/${job.conversationId}`);
  const thread = (await tx.get(ref)).data();
  if (!thread || thread.queue[0] !== job.id) throw new Error('conversation_order_lost');
  tx.update(ref, { queue: thread.queue.slice(1),
    turns: status === 'succeeded' ? [...thread.turns, { question: job.question, answer: job.answer }].slice(-6) : thread.turns });
}
