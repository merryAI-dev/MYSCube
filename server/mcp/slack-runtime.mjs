import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { verifySlackRequest } from './slack-ingress.mjs';
import * as z from 'zod/v4';
import { createGeminiCompletion } from './gemini-model.mjs';
import { runSettlementAgent, settlementTools } from './settlement-agent.mjs';
import { assertActorRoleAllowed, ROUTE_ROLES } from '../bff/bff-utils.mjs';
import { readSettlementAgentReport } from '../bff/settlement-agent-query.mjs';
import { createAgentTrace } from './agent-trace.mjs';
import { observeConversationFeedback, validateSemanticFeedback } from './conversation-feedback.mjs';
import { createSettlementReportTools } from './settlement-reporting.mjs';
import { loadPreviousReportSnapshots, reviewGroundedAnswer } from './grounded-answer.mjs';
import { runHermesAgent } from './hermes-harness.mjs';
import { createAccountingTools } from './accounting-read.mjs';
import { createAccountingReportTool } from './accounting-report.mjs';
import { createSupportTools } from './support-read.mjs';

export function slackText(text) {
  const formatted = text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*(?:`|$))/g).map((part, index) => index % 2 ? part : part
    .replace(/^ {0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '')
    .replace(/\*\*([^\n]+?)\*\*/g, '*$1*')
    .replace(/^ {0,3}#{1,6}[ \t]+/gm, '')
    .replace(/^([ \t]*)[-*][ \t]+/gm, '$1• ')
    .replace(/\n{3,}/g, '\n\n')).join('');
  return formatted.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function selectSlackHarness(question, turns = []) {
  const tag = (text) => String(text).match(/\[(hermes|baseline)\]/i)?.[1].toLowerCase();
  const variant = tag(question) || [...turns].reverse().map((turn) => ['hermes', 'baseline'].includes(turn.experimentVariant) ? turn.experimentVariant : tag(turn.question)).find(Boolean) || 'baseline';
  return { variant, question: question.replace(/\[(?:hermes|baseline)\]/gi, '').trim() };
}
function answerBlocks(text) {
  return (slackText(text).match(/[\s\S]{1,2800}/gu) || []).map((part) => ({
    type: 'section', text: { type: 'mrkdwn', text: part, verbatim: true },
  }));
}

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

export function createSlackWorker({ db, readOverview, readSnapshot, env = process.env, fetchImpl = fetch, completeFactory = createGeminiCompletion, hermesRunner = runHermesAgent }) {
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
    const members = await db.collection(`orgs/${tenantId}/members`).where('email', '==', email).where('status', '==', 'ACTIVE').limit(2).get();
    if (members.docs.length !== 1) throw new Error('member_unverified');
    const member = members.docs[0].data();
    if (member.status !== 'ACTIVE') throw new Error('member_inactive');
    const context = { tenantId, actorId: members.docs[0].id, actorRole: member.role, actorEmail: email, actorName: member.name || '', authSource: 'slack_verified', requestId: job.id };
    assertActorRoleAllowed({ context }, ROUTE_ROLES.readCore, 'read settlement agent projects');
    return context;
  }
  async function readContextFor(job) {
    const requester = await contextFor(job);
    // This principal is private to fixed read capabilities, never a general API credential.
    return { tenantId, actorId: 'myscube-settlement-agent', actorRole: 'auditor', actorEmail: '',
      actorName: '정산 에이전트', authSource: 'settlement_agent_read', requestId: job.id,
      requestedByActorId: requester.actorId };
  }
  async function process(job) {
    const experiment = selectSlackHarness(job.question, job.turns);
    const useHermes = experiment.variant === 'hermes';
    const scopes = [];
    const audit = [];
    const projectNames = new Map();
    const reportSnapshots = [];
    const trace = createAgentTrace({ db, jobId: job.id, leaseId: job.leaseId });
    const record = async (event) => {
      const receipt = await trace(event);
      audit.push({ type: event.type || 'tool_event', ...(event.tool ? { tool: event.tool } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}), ...receipt });
    };
    let answer;
    let answerStatus;
    try {
      const actor = await contextFor(job);
      await record({ type: 'run_start', actorId: actor.actorId, actorRole: actor.actorRole,
        readPrincipal: 'myscube-settlement-agent', permissionPolicy: 'mysc-designated-channel-company-settlement-read-v1',
        question: job.question, model: 'gemini-3.6-flash', experiment: experiment.variant,
        harness: useHermes ? 'hermes-readonly-v1' : 'settlement-read-v2' });
      if (useHermes && !env.SETTLEMENT_HERMES_URL) throw new Error('hermes_not_configured');
      const previousAnswerId = job.turns?.at(-1)?.jobId || null;
      await record({ type: 'conversation_feedback', ...observeConversationFeedback({ text: job.question, previousAnswerId }) });
      if (!env.SETTLEMENT_AGENT_GEMINI_API_KEY) throw new Error('model_not_configured');
      await reserveAgentBudget(db, new Date().toISOString().slice(0, 7));
      const tools = settlementTools({ projectNames, readStatus: async (input) => {
        const context = await readContextFor(job);
        const names = await db.getAll(...input.projectIds.map((id) => db.doc(`orgs/${tenantId}/projects/${id}`)), { fieldMask: ['name'] });
        for (const doc of names) if (doc.exists && doc.data().name) projectNames.set(doc.id, doc.data().name);
        return readOverview({ context, body: input });
      } });
      tools.push({ name: 'observe_feedback', observationOnly: true,
        description: '이전 답변에 대한 사용자의 정정·범위 불만·활용 의사·모호함을 관찰 기록합니다. 현재 사용자 발화에서 근거를 그대로 인용하세요. 공손함/짜증/침묵을 정답·오답으로 해석하지 않습니다. 기록은 학습이나 정산값에 반영되지 않습니다. 기록 후 실제 질문 처리를 계속하세요.',
        schema: z.object({ kind: z.enum(['correction', 'scope_concern', 'use_intent', 'ambiguous']), quote: z.string().min(1).max(500) }).strict(),
        execute: async (input) => validateSemanticFeedback({ ...input, text: job.question, previousAnswerId }),
      });
      tools.push({ name: 'clarify_request', description: '대화 문맥으로도 대상 사업·기간·마감 기준을 정할 수 없을 때 한 번에 필요한 것만 확인합니다. 미완료/미승인/기한 내 미승인은 서로 다릅니다. 금요일이 어느 날짜인지 불명확하면 조회 전에 확인하세요.',
        schema: z.object({ missing: z.array(z.enum(['projects', 'period', 'deadline', 'status_definition'])).min(1).max(4) }).strict(),
        execute: async (input) => input, requiresReply: true,
        render: (result) => {
          const questions = { projects: '어느 사업을 확인할까요? 전체 등록 사업인지 특정 사업인지 알려주세요.',
            period: '어느 달 또는 몇 주차를 확인할까요?', deadline: '어느 날짜·시각의 마감을 말씀하시나요?',
            status_definition: '현재 승인이 안 된 건을 찾을까요, 기한 후 승인된 건도 함께 찾을까요?' };
          return ['정확히 확인하려고 조금만 여쭤볼게요.', ...[...new Set(result.missing)].map((key) => questions[key]), '편하게 답해주시면 이어서 확인할게요.'].join('\n');
        },
      });
      tools[0].schema = z.object({ yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/), projectIds: z.array(z.string().min(1).max(120).regex(/^[^/]+$/)).min(1).max(100) }).strict();
      tools[0].modelResult = (result) => ({ yearMonth: result.yearMonth, monthCloseTargetYearMonth: result.monthCloseTargetYearMonth, queriedAt: new Date().toISOString(),
        items: result.items.map((item) => ({ projectId: item.projectId, name: projectNames.get(item.projectId) || '사업명 확인 필요', month: item.settlementCycle.businessState,
          health: item.settlementCycle.health, weeks: item.settlementStatuses.items.map(({ period, status, submittedAt, approvedAt, deadlineAt, approverDeadlineAt }) =>
            ({ period, status, submittedAt, approvedAt, deadlineAt, approverDeadlineAt })) })), errors: result.errors });
      tools.push(...createSettlementReportTools({
        readReport: async (input, { signal }) => readSettlementAgentReport({ db, context: await readContextFor(job), input, readOverview, signal, record }),
        loadPreviousReports: () => loadPreviousReportSnapshots({ db, job, authorize: () => contextFor(job) }),
        saveReport: async (snapshot) => {
          snapshot = { ...snapshot, sourceJobId: snapshot.sourceJobId || job.id };
          const index = reportSnapshots.findIndex((previous) => JSON.stringify(previous.query) === JSON.stringify(snapshot.query));
          if (index < 0) reportSnapshots.push(snapshot); else reportSnapshots[index] = snapshot;
          if (reportSnapshots.length > 5 || JSON.stringify(reportSnapshots).length > 200000) throw new Error('report_snapshot_too_large');
        },
      }));
      if (readSnapshot) tools.push(...createAccountingTools({ readSnapshot: async (request) => {
        const context = await readContextFor(job);
        const result = await readSnapshot({ ...request, context });
        await contextFor(job);
        return result;
      } }));
      if (readSnapshot) tools.push(createAccountingReportTool({ db, authorize: () => readContextFor(job), readSnapshot, record }));
      tools.push(...createSupportTools({ db, job, authorize: () => contextFor(job), revision: env.VERCEL_GIT_COMMIT_SHA }));
      tools.push({ name: 'agent_capabilities', description: '데이터 조감도/catalog: 조회 가능한 데이터·필드·도구·제한을 확인합니다. 어떤 데이터가 있는지 묻거나 필요한 도구를 모를 때 사용하세요. 이미 아는 조회에 매번 호출할 필요는 없습니다. 사업명 검색으로 권한을 추정하지 않습니다.',
        schema: z.object({}).strict(), execute: async () => { await contextFor(job); return {
          channel: '0_전사_공지_08_myscube', capabilities: ['전사 등록 사업 이름 검색', '전사 주정산·월결산 상태 조회', '등록 사업 기준 미완료·기한 경과 목록과 조직장 조회'],
          dataSources: [
            { name: '프로젝트 원장', authority: 'MYSCube BFF', fields: ['사업명', 'CIC', '조직장'], tools: ['project_search', 'settlement_report'], note: '등록 사업 기준입니다. 검색 결과가 잘리면 전체 목록이 아닙니다.' },
            { name: '주정산', authority: 'JVM', fields: ['주차별 상태', '실무자 제출 시각', '조직장 승인 시각', '마감 시각'], tools: ['cashflow_status', 'settlement_report'], note: '운영 주기월 기준. 기록이 없으면 시각을 추정하지 않습니다.' },
            { name: '월결산', authority: 'JVM', fields: ['상태', '정합성', '미완료 사업', 'CIC·조직장별 집계'], tools: ['cashflow_status', 'settlement_report'], note: '대상월은 운영 주기월의 직전 월입니다.' },
            { name: '이전 조회 결과', authority: '권한 재검증된 대화 스냅샷', fields: ['원래 조회 시각', '조회 범위', 'CIC·조직장별 재구성'], tools: ['reformat_report'], note: '형식 변경 시 재사용합니다. 최신 데이터라고 표시하지 않습니다.' },
            ...(readSnapshot ? [{ name: '회계 원장', authority: 'JVM', fields: ['전체 사업·CIC별 P/A 조회·원화 합계', 'Projection·Actual 항목별 금액', '주차별 입금·출금·누적잔액', '원장 버전', '고정 시트 좌표'], tools: ['accounting_read', 'accounting_report'], note: '원장 단위는 내규상 KRW입니다. 시트에서 JVM에 반영된 금액이며 Google Sheets 실시간 값은 아닙니다.' }] : []),
            { name: '오류·QA 진단', authority: '저장된 에이전트 실행 기록과 검토된 코드 설명', fields: ['실행 단계', '오류 코드', '답변 검토', '조회 경로·조치 안내'], tools: ['agent_diagnostics', 'system_knowledge'], note: '전체 서버 로그가 아니며, 코드 설명은 실제 장애 발생 증거와 구분합니다.' },
          ],
          tools: tools.filter((tool) => !tool.observationOnly).map(({ name, description }) => ({ name, description })),
          limits: ['다른 Slack 채널의 대화는 조회하지 않습니다.', '승인·금액·파일 변경과 삭제는 할 수 없습니다.', '정산 의무 대상·종료 제외 정책은 아직 연결되지 않았습니다.', '시트 원문·수식을 직접 읽거나 시트를 새로 동기화하지 않습니다. JVM 반영 금액은 accounting_read로 조회합니다.', '임의 코드 실행·파일 접근·비밀값·전체 Cloud Logging 조회는 제공하지 않습니다.'],
        }; }, render: (result) => [`현재 ${result.channel} 채널에서 요청을 받고 있어요.`, ...result.capabilities.map((value) => `- ${value}`), ...result.limits].join('\n') });
      tools.push({ name: 'project_search', description: '사업명을 검색해 정산 조회에 사용할 프로젝트 ID를 확인합니다. 결과가 잘렸으면 전체 목록이 아닙니다.',
        schema: z.object({ query: z.string().trim().min(1).max(100) }).strict(),
        execute: async ({ query }) => {
          await contextFor(job);
          const result = await db.collection(`orgs/${tenantId}/projects`).select('name').limit(1000).get();
          const matches = result.docs.map((doc) => ({ projectId: doc.id, name: doc.data().name || '' })).filter((item) => item.name.toLowerCase().includes(query.toLowerCase()));
          for (const item of matches.slice(0, 20)) projectNames.set(item.projectId, item.name);
          return { items: matches.slice(0, 20), truncated: result.docs.length === 1000 || matches.length > 20 };
        }, render: (result) => `조회할 사업을 확인했어요${result.truncated ? ' (일부 검색 결과)' : ''}.\n${result.items.map((item) => `- ${item.name}`).join('\n') || '일치하는 사업이 없습니다. 사업명을 다시 알려주세요.'}`,
      });
      const complete = completeFactory({ apiKey: env.SETTLEMENT_AGENT_GEMINI_API_KEY, maxInputTokens: 16000,
        onUsage: async (usage) => record({ type: 'usage', phase: 'answer', input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, thinking: usage.thoughtsTokenCount || 0 }),
      });
      const reviewComplete = completeFactory({ apiKey: env.SETTLEMENT_AGENT_GEMINI_API_KEY, maxInputTokens: 16000,
        onUsage: async (usage) => record({ type: 'usage', phase: 'review', input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, thinking: usage.thoughtsTokenCount || 0 }),
      });
      const runAgent = useHermes ? hermesRunner : runSettlementAgent;
      const result = await runAgent({ env, question: experiment.question, history: (job.turns || []).flatMap((turn) => [
        { role: 'user', content: selectSlackHarness(turn.question).question }, { role: 'assistant', content: turn.answer },
      ]), tools, complete, maxSteps: 4, signal: AbortSignal.timeout(100000),
        reviewAnswer: (input) => reviewGroundedAnswer({ ...input, complete: reviewComplete }),
        loadFeedback: async (scope) => {
          scope = { ...scope, experimentVariant: experiment.variant };
          const key = feedbackScopeKey(job, scope);
          if (!scopes.some((item) => item.key === key)) scopes.push({ key, scope });
          const prior = (await db.doc(`settlement_agent_feedback/${key}`).get()).data();
          return (prior?.votes || []).map(({ id, value }) => ({ id, value }));
        }, record,
      });
      await contextFor(job);
      await record({ type: 'run_result', status: result.status, answer: result.answer });
      answerStatus = result.status;
      answer = result.answer;
    } catch (error) {
      audit.push({ type: 'failure', code: /^[a-z_]+$/.test(error.message || '') ? error.message : 'lookup_failed' });
      answer = error.message === 'hermes_not_configured'
        ? 'Hermes 실험 경로가 아직 연결되지 않았어요. 기존 실행기로 대신 처리하지 않았습니다.'
        : ['member_unverified', 'member_inactive'].includes(error.message)
        ? 'MYSCube 계정 연결을 확인하지 못했어요. 관리자에게 활성 계정과 Slack 이메일 연결을 확인해 달라고 요청해주세요.'
        : error.message === 'input_budget_exceeded'
          ? '조회할 내용이 많아 한 번에 정리하지 못했어요. 사업이나 기간을 나누어 다시 요청해주세요. 정산이 미완료라는 뜻은 아닙니다.'
        : error.message === 'budget_exhausted'
          ? '이번 달 에이전트 사용 한도에 도달했어요. MYSCube에서 직접 확인하시거나 관리자에게 문의해주세요.'
          : '조회 도중 처리를 마치지 못했어요. 정산이 미완료라는 뜻은 아닙니다. 사업과 기간을 좁혀 다시 요청해주세요. 같은 문제가 반복되면 이 스레드를 관리자에게 공유해주세요.';
    }
    const queriedAt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
    const text = `${answer.slice(0, 38000)}${answer.length > 38000 ? '\n표시 한도로 일부 내용은 생략했습니다. 사업 범위를 좁혀 조회해 주세요.' : ''}\n응답 작성: ${queriedAt} (한국시간)\n${useHermes ? '실험 B · Hermes + Gemini' : '실험 A · 기존 실행기 + Gemini'}`;
    const blocks = answerBlocks(text);
    const publicAnswer = !audit.some((entry) => entry.type === 'failure' || entry.outcome === 'rejected');
    if (publicAnswer && answerStatus === 'answered' && scopes.length) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: '정정할 내용은 댓글로 편하게 알려주세요. 아래 조회 범위 평가는 선택사항입니다.' }] }, { type: 'actions', elements: [
      { type: 'button', action_id: 'settlement_scope_yes', text: { type: 'plain_text', text: '예 · 범위가 맞아요' }, value: job.id },
      { type: 'button', action_id: 'settlement_scope_no', text: { type: 'plain_text', text: '아니요 · 범위가 달라요' }, value: job.id },
    ] });
    await updateClaimedJob({ db, job, patch: { status: 'sending', answer: text, scopes, audit, experimentVariant: experiment.variant,
      reportSnapshots: reportSnapshots.length <= 5 && JSON.stringify(reportSnapshots).length <= 200000 ? reportSnapshots : [],
      answeredAt: new Date().toISOString() } });
    try {
      const result = await slack(publicAnswer ? 'chat.postMessage' : 'chat.postEphemeral', {
        channel: channelId, ...(!publicAnswer ? { user: job.slackUserId } : {}), thread_ts: job.threadTs,
        text: slackText(text), blocks, parse: 'none', unfurl_links: false, unfurl_media: false,
      });
      await updateClaimedJob({ db, job, patch: { status: 'succeeded', answerTs: publicAnswer ? result.ts : result.message_ts } });
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

export function createFeedbackIngress({ db, secret, teamId, channelId, fetchImpl = fetch }) {
  return async (req, res) => {
    const started = performance.now();
    if (!verifySlackRequest({ body: req.body, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), secret })) return res.status(401).json({ error: 'invalid_signature' });
    let payload;
    try { payload = JSON.parse(new URLSearchParams(req.body.toString('utf8')).get('payload')); }
    catch { return res.status(400).json({ error: 'invalid_payload' }); }
    let saved = false;
    try {
      if (!await saveSlackFeedback({ db, payload, teamId, channelId })) return res.status(403).json({ error: 'feedback_not_allowed' });
      saved = true;
      const url = new URL(payload.response_url);
      if (url.origin !== 'https://hooks.slack.com' || url.username || url.password
        || !/^\/(actions|services)\/[A-Za-z0-9_\/-]+$/.test(url.pathname) || url.search || url.hash) throw new Error('invalid_response_url');
      const jobRef = db.doc(`settlement_agent_jobs/${payload.actions[0].value}`);
      const [job, vote] = await Promise.all([jobRef.get(), db.doc(`${jobRef.path}/feedback/${payload.user.id}`).get()]);
      const feedbackText = vote.data()?.value === 1
        ? '✓ 피드백을 저장했어요. 조회 범위가 맞았군요. 감사합니다!'
        : '✓ 피드백을 저장했어요. 어떤 사업·기간이 달랐나요? 원래 질문의 스레드에 알려주시면 다시 조회할게요.';
      const timeout = Math.min(800, Math.floor(2400 - (performance.now() - started)));
      if (timeout <= 0) throw new Error('feedback_display_timeout');
      const result = await fetchImpl(url.href, { method: 'POST', redirect: 'error',
        headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(timeout),
        body: JSON.stringify({ replace_original: true,
          text: slackText(`${job.data().answer}\n\n${feedbackText}`),
          blocks: [...answerBlocks(job.data().answer),
            { type: 'context', elements: [{ type: 'plain_text', text: feedbackText }] }],
        }),
      });
      if (!result.ok || (await result.text()).trim() !== 'ok') throw new Error('feedback_display_failed');
      return res.json({ ok: true });
    } catch { return res.status(503).json({ error: saved ? 'feedback_saved_display_unavailable' : 'feedback_storage_unavailable' }); }
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
    turns: status === 'succeeded' ? [...thread.turns, { jobId: job.id, question: job.question, answer: job.answer,
      ...(job.experimentVariant ? { experimentVariant: job.experimentVariant } : {}) }].slice(-6) : thread.turns });
}
