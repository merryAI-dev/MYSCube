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
import { loadPreviousReportSnapshots } from './grounded-answer.mjs';
import { runHermesAgent } from './hermes-harness.mjs';
import { createAccountingTools } from './accounting-read.mjs';
import { createAccountingReportTool } from './accounting-report.mjs';
import { createAccountingComparisonTool } from './accounting-compare.mjs';
import { createCfoBriefTool } from './cfo-brief.mjs';
import { resolveSettlementRequest, settlementRequestTools, isSettlementTopic } from './settlement-request.mjs';
import { createSlackProgress, readProgressJob, toolProgressStage } from './slack-progress.mjs';
import { createSettlementStatusTool } from './settlement-status-report.mjs';
import { createSupportTools } from './support-read.mjs';
import { isMerryhereRequest, runMerryhereBooking, localRoomIssue } from './merryhere-booking.mjs';
import { createMerryhereConnections, CONNECT_LINK_PLACEHOLDER } from './merryhere-connection.mjs';
import { createLocalRoomRelay, localPairCode } from './merryhere-local-relay.mjs';
import { roomRequestSchema, roomToolDescription } from './merryhere-request.mjs';
import { createMerryhereClient } from './merryhere-client.mjs';

// Weekday and minute are needed for relative dates ("다음 주 수요일") and for refusing an already-past assumed time.
export function roomClock(date) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' })
    .formatToParts(date).map(({ type, value }) => [type, value]));
  const weekday = { Mon: '월', Tue: '화', Wed: '수', Thu: '목', Fri: '금', Sat: '토', Sun: '일' }[parts.weekday];
  return `${parts.year}-${parts.month}-${parts.day}(${weekday}) ${parts.hour}:${parts.minute}`;
}
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

class SlackDeliveryError extends Error {
  constructor({ method, code, httpStatus = null, definitive = false, retryAfterSeconds = null }) {
    super(`slack_${code}`);
    this.name = 'SlackDeliveryError';
    this.method = method;
    this.code = code;
    this.httpStatus = httpStatus;
    this.definitive = definitive;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const slackErrorCodes = new Set(['invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'msg_too_long',
  'invalid_blocks_format', 'rate_limited',
  'cant_update_message', 'message_not_found', 'channel_not_found', 'not_in_channel', 'missing_scope',
  'invalid_auth', 'account_inactive', 'token_revoked', 'ratelimited', 'request_timeout',
  'service_unavailable', 'internal_error', 'fatal_error', 'user_not_found']);
const safeSlackCode = (value) => typeof value === 'string' && slackErrorCodes.has(value) ? value : 'unavailable';
const deliveryFailure = (error, method) => ({
  method: error instanceof SlackDeliveryError ? error.method : method,
  code: error instanceof SlackDeliveryError ? error.code : 'transport_error',
  httpStatus: error instanceof SlackDeliveryError ? error.httpStatus : null,
  definitive: error instanceof SlackDeliveryError && error.definitive,
  retryAfterSeconds: error instanceof SlackDeliveryError ? error.retryAfterSeconds : null,
  recordedAt: new Date().toISOString(),
});
const retryablePayloadRejection = (error) => error instanceof SlackDeliveryError && error.definitive
  && ['invalid_arguments', 'invalid_arg_name', 'invalid_blocks', 'invalid_blocks_format'].includes(error.code);

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
  const channelIds = new Set(['C0BQ6980HR6', 'C0AAC4AHTN1']);
  const tenantId = 'mysc';
  async function slack(method, body, timeoutMs = 10000) {
    const readUser = method === 'users.info';
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}${readUser ? `?${new URLSearchParams(body)}` : ''}`, {
        method: readUser ? 'GET' : 'POST', headers: { authorization: `Bearer ${env.SLACK_ALERT_BOT_TOKEN}`, ...(!readUser ? { 'content-type': 'application/json' } : {}) },
        ...(!readUser ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new SlackDeliveryError({ method, code: 'transport_error' });
    }
    let result;
    try { result = await response.json(); }
    catch { throw new SlackDeliveryError({ method, code: 'invalid_response', httpStatus: response.status }); }
    if (!response.ok || !result.ok) {
      const code = safeSlackCode(result.error);
      const ambiguous = code === 'unavailable' || ['internal_error', 'fatal_error', 'request_timeout', 'service_unavailable'].includes(code)
        || response.status === 408 || response.status >= 500;
      const retryAfter = Number(response.headers.get('retry-after'));
      throw new SlackDeliveryError({ method, code, httpStatus: response.status,
        definitive: !ambiguous && (response.ok || (response.status >= 400 && response.status < 500)),
        retryAfterSeconds: Number.isSafeInteger(retryAfter) && retryAfter >= 0 && retryAfter <= 3600 ? retryAfter : null });
    }
    return result;
  }
  async function contextFor(job) {
    if (job.teamId !== teamId || !channelIds.has(job.channelId)) throw new Error('workspace_not_allowed');
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
  async function finishProgress(job, status) {
    if (job.teamId !== teamId || !channelIds.has(job.channelId) || !/^\d{1,12}\.\d{1,6}$/.test(job.progressTs || '')) return;
    let failure;
    for (let attempt = 0; attempt < 2; attempt++) {
      let current;
      try { current = await readProgressJob(db, job.id); }
      catch { return null; }
      if (current?.status !== status || current?.leaseId !== job.leaseId) return null;
      const text = status === 'succeeded'
        ? current.answerDelivery === 'private'
          ? '요청 처리가 끝났습니다. 자세한 안내는 요청자에게만 표시됩니다.'
          : '✅ 요청 처리가 끝났습니다. 결과는 아래 답변에서 확인해주세요.'
        : status === 'failed'
          ? '⚠️ 답변 전달이 Slack에서 거부되었습니다. 정산 완료 여부와는 무관하며, 관리자에게 이 스레드 확인을 요청해주세요.'
          : '⚠️ 답변 전달 여부를 확인하지 못했습니다. 정산 완료 여부와는 무관하며, 관리자에게 이 스레드 확인을 요청해주세요.';
      try {
        await slack('chat.update', attempt ? { channel: job.channelId, ts: job.progressTs, text }
          : { channel: job.channelId, ts: job.progressTs, text, blocks: [], parse: 'none' }, 3000);
        failure = null;
        break;
      } catch (error) {
        failure = deliveryFailure(error, 'chat.update');
        if (failure.definitive && !retryablePayloadRejection(error)) break;
        if (failure.code === 'ratelimited') break;
      }
    }
    try {
      await db.runTransaction(async (tx) => {
        const ref = db.doc(`settlement_agent_jobs/${job.id}`);
        const current = (await tx.get(ref)).data();
        if (current?.status !== status || current?.leaseId !== job.leaseId) return;
        tx.update(ref, failure ? { receiptStatus: 'failed', receiptFailure: failure,
          receiptRepairAttempts: Math.min(3, (Number.isSafeInteger(current.receiptRepairAttempts) ? current.receiptRepairAttempts : 0) + 1) }
          : { receiptStatus: 'succeeded', receiptFailure: null, receiptUpdatedAt: new Date().toISOString() });
      });
    } catch { /* Receipt observability must not change the terminal business delivery state. */ }
    return failure;
  }
  async function process(job) {
    const experiment = selectSlackHarness(job.question, job.turns);
    const roomText = experiment.question.replace(/<@[A-Z0-9]+>/g, '').trim();
    const localRelay = env.MERRYHERE_EXECUTION_MODE === 'local' ? createLocalRoomRelay({ db }) : null;
    const pairCode = localRelay && localPairCode(roomText);
    const disconnectLocal = localRelay && roomText === '회의실 로컬 연결 해제';
    const connections = localRelay ? null : createMerryhereConnections({ db, env });
    const connectAccount = !localRelay && roomText === '회의실 계정 연결';
    const disconnectAccount = !localRelay && roomText === '회의실 계정 연결 해제';
    const accountCommand = connectAccount || disconnectAccount;
    const previousBooking = job.turns?.findLast(turn => turn.bookingContext)?.bookingContext || null;
    const roomConfirm = /^\s*(?:회의실\s*)?예약\s*확정\s+[a-f0-9]{24}\s*$/.test(roomText);
    const settlementRequest = resolveSettlementRequest(experiment.question);
    const pendingRoom = previousBooking?.missing?.some(key => key !== 'intent');
    const roomRequest = roomConfirm || isMerryhereRequest(roomText) || (pendingRoom && !isSettlementTopic(roomText));
    const request = roomRequest ? null : settlementRequest;
    const useHermes = experiment.variant === 'hermes' && !request?.direct && !roomRequest && !previousBooking;
    const scopes = [];
    const audit = [];
    const projectNames = new Map();
    const reportSnapshots = [];
    const progress = createSlackProgress({ job, db, send: (body) => slack('chat.update', body, 800) });
    const trace = createAgentTrace({ db, jobId: job.id, leaseId: job.leaseId });
    const record = async (event) => {
      const receipt = await trace(event);
      if (event.type === 'cfo_workflow_stage' && event.outcome === 'STARTED') {
        progress.show(event.name === 'INSPECT_CURRENT_VARIANCE' ? 'INSPECT_VARIANCE' : 'COMPARE_PERIODS');
      }
      audit.push({ type: event.type || 'tool_event', ...(event.tool ? { tool: event.tool } : {}),
        ...(event.outcome ? { outcome: event.outcome } : {}), ...receipt });
    };
    let answer;
    let answerStatus;
    let bookingContext = null;
    let connectLink = null;
    let privateAnswer = false;
    try {
      const actor = await contextFor(job);
      const localConnection = localRelay && roomRequest && !pairCode && !disconnectLocal ? await localRelay.connection(actor) : null;
      const serverRoomIssue = async () => {
        if (!connections.available) return localRoomIssue('connect_unavailable');
        const status = await connections.status(actor);
        return status === 'ACTIVE' ? null : localRoomIssue(status === 'LOGIN_FAILED' ? 'login_failed' : 'account_not_connected');
      };
      const roomAuthIssue = roomRequest && !pairCode && !disconnectLocal && !accountCommand
        ? localRelay ? localConnection.issue ? localRoomIssue(localConnection.issue) : null : await serverRoomIssue() : null;
      progress.show('INTERPRET_REQUEST');
      await record({ type: 'run_start', actorId: actor.actorId, actorRole: actor.actorRole,
        readPrincipal: 'myscube-settlement-agent', permissionPolicy: 'mysc-designated-channel-company-settlement-read-v1',
        question: job.question, model: request?.direct || roomConfirm || roomAuthIssue || pairCode || disconnectLocal || accountCommand ? null : 'gemini-3.6-flash', experiment: experiment.variant,
        harness: request?.direct ? 'settlement-status-direct-v1' : useHermes ? 'hermes-readonly-v1' : 'settlement-read-v2' });
      if (useHermes && !env.SETTLEMENT_HERMES_URL) throw new Error('hermes_not_configured');
      const previousAnswerId = job.turns?.at(-1)?.jobId || null;
      await record({ type: 'conversation_feedback', ...observeConversationFeedback({ text: job.question, previousAnswerId }) });
      if (!request?.direct && !roomConfirm && !roomAuthIssue && !pairCode && !disconnectLocal && !accountCommand) {
        if (!env.SETTLEMENT_AGENT_GEMINI_API_KEY) throw new Error('model_not_configured');
        await reserveAgentBudget(db, new Date().toISOString().slice(0, 7));
      }
      const tools = settlementTools({ projectNames, readStatus: async (input) => {
        const context = await readContextFor(job);
        const names = await db.getAll(...input.projectIds.map((id) => db.doc(`orgs/${tenantId}/projects/${id}`)), { fieldMask: ['name'] });
        for (const doc of names) if (doc.exists && doc.data().name) projectNames.set(doc.id, doc.data().name);
        return readOverview({ context, body: input });
      } });
      const booking = async (input) => {
        progress.show('READ_ROOMS');
        const connection = localRelay ? localConnection || await localRelay.connection(actor) : null;
        if (connection?.issue) return localRoomIssue(connection.issue);
        let credentials;
        if (!localRelay) {
          try { credentials = await connections.credentials(actor); }
          catch (error) { return localRoomIssue(error.code === 'login_failed' ? 'login_failed' : 'account_not_connected'); }
        }
        const result = await runMerryhereBooking({ db, actor: await contextFor(job), job, text: roomText, input,
          previous: previousBooking, localConnection: connection, credentials,
          clientFactory: credentials => localRelay ? localRelay.client(connection) : createMerryhereClient({ ...credentials, fetchImpl }) });
        bookingContext = result.bookingContext || previousBooking;
        if (!localRelay && ['login_failed', 'login_required'].includes(result.code)) await connections.markLoginFailed(actor);
        if (result.code === 'page_changed') {
          try {
            const alertRef = db.doc('merryhere_provider_alerts/page_changed');
            const stamp = Date.now();
            const claimed = await db.runTransaction(async tx => {
              const prior = (await tx.get(alertRef)).data();
              if (prior?.nextAttemptAt > stamp) return false;
              tx.set(alertRef, { jobId: job.id, status: 'pending', nextAttemptAt: stamp + 15 * 60000 });
              return true;
            });
            if (claimed) {
              let status = 'sent';
              try {
                if (!env.SLACK_ALERT_CHANNEL_ID) throw new Error('alert_not_configured');
                await slack('chat.postMessage', { channel: env.SLACK_ALERT_CHANNEL_ID,
                  text: 'Merryhere 예약 화면 형식 변경이 감지되었습니다. 회의실 가용 여부를 추정하지 않고 처리를 중단했습니다. 관리자 점검이 필요합니다. 오류: page_changed',
                  unfurl_links: false, unfurl_media: false }, 5000);
              } catch { status = 'failed'; }
              await db.runTransaction(async tx => {
                if ((await tx.get(alertRef)).data()?.jobId === job.id) tx.update(alertRef, { status, nextAttemptAt: stamp + (status === 'sent' ? 15 : 1) * 60000 });
              });
              await record({ type: 'provider_alert', provider: 'merryhere', code: 'page_changed', status });
            }
          } catch { console.error('Merryhere page_changed: operational alert could not be recorded'); }
        }
        return result;
      };
      tools.push({ name: 'merryhere_rooms', description: `${roomToolDescription}\n현재 한국 시각: ${roomClock(new Date())}\n서버에 저장된 현재 요청자의 회의실 조건: ${JSON.stringify(previousBooking || null)}`, schema: roomRequestSchema,
        requiresReply: true, execute: booking, render: result => result.answer });
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
      if (readSnapshot) tools.push(createCfoBriefTool({ authorize: () => contextFor(job), record,
        readSnapshot: async (request) => readSnapshot({ ...request, context: await readContextFor(job) }),
      }));
      if (readSnapshot) tools.push(createAccountingComparisonTool({ authorize: () => contextFor(job),
        readSnapshot: async (request) => readSnapshot({ ...request, context: await readContextFor(job) }),
      }));
      if (readSnapshot) tools.push(createAccountingReportTool({ db, authorize: () => readContextFor(job), readSnapshot, record }));
      tools.push(createSettlementStatusTool({ db, authorize: () => readContextFor(job), readOverview, record, onProgress: (stage) => progress.show(stage) }));
      tools.push(...createSupportTools({ db, job, authorize: () => contextFor(job), revision: env.VERCEL_GIT_COMMIT_SHA }));
      tools.push({ name: 'agent_capabilities', description: '데이터 조감도/catalog: 조회 가능한 데이터·필드·도구·제한을 확인합니다. 어떤 데이터가 있는지 묻거나 필요한 도구를 모를 때 사용하세요. 이미 아는 조회에 매번 호출할 필요는 없습니다. 사업명 검색으로 권한을 추정하지 않습니다.',
        schema: z.object({}).strict(), execute: async () => { await contextFor(job); return {
          channel: '0_전사_공지_08_myscube', capabilities: ['전사 등록 사업 이름 검색', '전사 주정산·월결산 상태 조회', '등록 사업 기준 미완료·기한 경과 목록과 조직장 조회'],
          dataSources: [
            { name: '프로젝트 원장', authority: 'MYSCube BFF', fields: ['사업명', 'CIC', '조직장'], tools: ['project_search', 'settlement_report'], note: '등록 사업 기준입니다. 검색 결과가 잘리면 전체 목록이 아닙니다.' },
            { name: '주정산', authority: 'JVM', fields: ['주차별 상태', '실무자 제출 시각', '조직장 승인 시각', '마감 시각'], tools: ['cashflow_status', 'settlement_report'], note: '운영 주기월 기준. 기록이 없으면 시각을 추정하지 않습니다.' },
            { name: '월결산', authority: 'JVM', fields: ['상태', '정합성', '미완료 사업', 'CIC·조직장별 집계'], tools: ['cashflow_status', 'settlement_report'], note: '대상월은 운영 주기월의 직전 월입니다.' },
            { name: '이전 조회 결과', authority: '권한 재검증된 대화 스냅샷', fields: ['원래 조회 시각', '조회 범위', 'CIC·조직장별 재구성'], tools: ['reformat_report'], note: '형식 변경 시 재사용합니다. 최신 데이터라고 표시하지 않습니다.' },
            ...(readSnapshot ? [{ name: '회계 원장', authority: 'JVM', fields: ['전체 사업·CIC별 P/A 조회·원화 합계', 'Projection·Actual 항목별 금액', '주차별 입금·출금·누적잔액', '원장 버전', '고정 시트 좌표', '항목별 계획 대비 실적 차이', '음수 잔액·미기록 주차', '조회 범위 내 사업별 차액 순위', '선택 사업 기간 비교·후속 조치안', 'CFO 브리핑·변동 사업 추가 분석'], tools: ['accounting_read', 'accounting_report', 'accounting_compare', 'cfo_brief'], note: '원장 단위는 내규상 KRW입니다. 시트에서 JVM에 반영된 금액이며 Google Sheets 실시간 값은 아닙니다.' }] : []),
            { name: '오류·QA 진단', authority: '저장된 에이전트 실행 기록과 검토된 코드 설명', fields: ['실행 단계', '오류 코드', '답변 검토', '조회 경로·조치 안내'], tools: ['agent_diagnostics', 'system_knowledge'], note: '전체 서버 로그가 아니며, 코드 설명은 실제 장애 발생 증거와 구분합니다.' },
          ],
          tools: tools.filter((tool) => !tool.observationOnly).map(({ name, description }) => ({ name, description })),
          limits: ['다른 Slack 채널의 대화는 조회하지 않습니다.', '승인·금액·파일 변경과 삭제는 할 수 없습니다.', '정산 의무 대상·종료 제외 정책은 아직 연결되지 않았습니다.', '시트 원문·수식을 직접 읽거나 시트를 새로 동기화하지 않습니다. JVM 반영 금액은 accounting_read로 조회합니다.', '임의 코드 실행·파일 접근·비밀값·전체 Cloud Logging 조회는 제공하지 않습니다.'],
        }; }, render: (result) => [`현재 ${result.channel} 채널에서 요청을 받고 있어요.`, ...result.capabilities.map((value) => `- ${value}`), ...result.dataSources.map((source) => `- ${source.name}: ${source.fields.join(' · ')}. ${source.note}`), ...result.limits].join('\n') });
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
      for (const tool of tools) {
        const execute = tool.execute;
        tool.execute = async (...args) => {
          progress.show(toolProgressStage[tool.name]);
          return execute(...args);
        };
      }
      let result;
      if (pairCode || disconnectLocal) {
        try {
          if (disconnectLocal) await localRelay.disconnect(actor);
          else await localRelay.pair(actor, pairCode);
          result = { status: 'answered', answer: disconnectLocal ? '로컬 회의실 연결을 해제했습니다.'
            : '로컬 연결 승인을 요청했습니다. 컴퓨터에서 npm run merryhere:local -- run 을 실행하고 표시된 이름·이메일이 본인인지 확인해 승인해주세요. 승인 후 원래 질문을 다시 보내주세요. 로그인 세션은 컴퓨터에만 저장됩니다.' };
        } catch { result = localRoomIssue('local_pair_expired'); }
      } else if (accountCommand) {
        if (disconnectAccount) await connections.disconnect(actor);
        result = disconnectAccount
          ? { status: 'answered', answer: 'Merryhere 계정 연결을 해제했습니다. 서버에 보관한 로그인 정보를 삭제했습니다.' }
          : connections.available
            ? { status: 'answered', answer: `Merryhere 계정 연결 링크입니다. 아래 링크에서 아이디와 비밀번호를 한 번 입력하면 연결됩니다.\n${CONNECT_LINK_PLACEHOLDER}\n링크는 요청하신 분에게만 보이며 15분 동안 한 번 사용할 수 있습니다. 비밀번호는 Slack에 보내지 마세요.` }
            : localRoomIssue('connect_unavailable');
        bookingContext = previousBooking;
        await record({ type: 'tool_result', tool: disconnectAccount ? 'merryhere_account_disconnect' : 'merryhere_account_connect_link', result: { status: result.status } });
      } else if (roomAuthIssue) {
        result = roomAuthIssue;
        bookingContext = previousBooking;
        await record({ type: 'tool_result', tool: 'merryhere_auth_preflight', result });
      } else if (roomConfirm) {
        result = await booking();
        await record({ type: 'tool_result', tool: 'merryhere_booking_confirmation', result });
      } else if (request?.direct) {
        const tool = tools.find((tool) => tool.name === 'settlement_status_report');
        const input = tool.schema.parse(request.input);
        const evidence = await tool.execute(input, { signal: AbortSignal.timeout(100000) });
        await record({ type: 'tool_result', tool: tool.name, input, result: evidence });
        result = { status: evidence.complete ? 'answered' : 'partial', answer: [request.notice, tool.render(evidence)].filter(Boolean).join('\n\n') };
      } else {
        const complete = completeFactory({ apiKey: env.SETTLEMENT_AGENT_GEMINI_API_KEY, maxInputTokens: 16000,
          onUsage: async (usage) => record({ type: 'usage', phase: 'answer', input: usage.promptTokenCount || 0, output: usage.candidatesTokenCount || 0, thinking: usage.thoughtsTokenCount || 0 }),
        });
        const runAgent = useHermes ? hermesRunner : runSettlementAgent;
        result = await runAgent({ env, question: experiment.question, history: (job.turns || []).flatMap((turn) => [
          { role: 'user', content: selectSlackHarness(turn.question).question }, { role: 'assistant', content: turn.answer },
        ]), tools: roomRequest ? tools.filter(t => t.name === 'merryhere_rooms') : settlementRequestTools(tools, request), complete, maxSteps: 4, signal: AbortSignal.timeout(100000),
          loadFeedback: async (scope) => {
            scope = { ...scope, experimentVariant: experiment.variant };
            const key = feedbackScopeKey(job, scope);
            if (!scopes.some((item) => item.key === key)) scopes.push({ key, scope });
            const prior = (await db.doc(`settlement_agent_feedback/${key}`).get()).data();
            return (prior?.votes || []).map(({ id, value }) => ({ id, value }));
          }, record,
        });
      }
      progress.show('PREPARE_ANSWER');
      await contextFor(job);
      if (result.answer?.includes(CONNECT_LINK_PLACEHOLDER)) {
        // The one-time link is delivered only to the requester and never stored in job, trace or thread records.
        connectLink = connections?.available ? await connections.issueLink(actor, job.id) : null;
        privateAnswer = true;
      }
      await record({ type: 'run_result', status: result.status, answer: result.answer, answerPolicy: 'server_evidence_only' });
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
    } finally {
      await progress.close();
    }
    const queriedAt = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short' }).format(new Date());
    const text = `${answer.slice(0, 38000)}${answer.length > 38000 ? '\n표시 한도로 일부 내용은 생략했습니다. 사업 범위를 좁혀 조회해 주세요.' : ''}\n응답 작성: ${queriedAt} (한국시간)\n${roomRequest || bookingContext ? 'Merryhere 회의실 도구' : request?.direct ? '정산 상태 직접 조회' : useHermes ? '실험 B · Hermes + Gemini' : '실험 A · 기존 실행기 + Gemini'}`;
    const storedText = text.replaceAll(CONNECT_LINK_PLACEHOLDER, '[일회용 연결 링크 · 요청자에게만 전송]');
    const deliveredText = connectLink ? text.replaceAll(CONNECT_LINK_PLACEHOLDER, connectLink) : storedText;
    const blocks = answerBlocks(deliveredText);
    const publicAnswer = !privateAnswer && !audit.some((entry) => entry.type === 'failure' || entry.outcome === 'rejected');
    if (publicAnswer && answerStatus === 'answered' && scopes.length) blocks.push({ type: 'context', elements: [{ type: 'plain_text', text: '정정할 내용은 댓글로 편하게 알려주세요. 아래 조회 범위 평가는 선택사항입니다.' }] }, { type: 'actions', elements: [
      { type: 'button', action_id: 'settlement_scope_yes', text: { type: 'plain_text', text: '예 · 범위가 맞아요' }, value: job.id },
      { type: 'button', action_id: 'settlement_scope_no', text: { type: 'plain_text', text: '아니요 · 범위가 달라요' }, value: job.id },
    ] });
    const answerDelivery = publicAnswer ? 'public' : 'private';
    const method = publicAnswer ? 'chat.postMessage' : 'chat.postEphemeral';
    await updateClaimedJob({ db, job, patch: { status: 'sending', answerDelivery, deliveryMethod: method, answer: storedText, scopes, audit, experimentVariant: experiment.variant,
      bookingContext,
      reportSnapshots: reportSnapshots.length <= 5 && JSON.stringify(reportSnapshots).length <= 200000 ? reportSnapshots : [],
      answeredAt: new Date().toISOString() } });
    const body = {
      channel: job.channelId, ...(!publicAnswer ? { user: job.slackUserId } : {}), thread_ts: job.threadTs,
      text: slackText(deliveredText), blocks,
    };
    let result;
    let fallbackFailure;
    try {
      try { result = await slack(method, body); }
      catch (error) {
        if (!retryablePayloadRejection(error)) throw error;
        fallbackFailure = deliveryFailure(error, method);
        result = await slack(method, { channel: job.channelId, ...(!publicAnswer ? { user: job.slackUserId } : {}),
          thread_ts: job.threadTs, text: slackText(deliveredText) });
      }
      const answerTs = publicAnswer ? result.ts : result.message_ts;
      if (!/^\d{1,12}\.\d{1,6}$/.test(answerTs || '')) throw new SlackDeliveryError({ method, code: 'invalid_response' });
    } catch (error) {
      const failure = deliveryFailure(error, method);
      const status = failure.definitive ? 'failed' : 'delivery_unknown';
      await updateClaimedJob({ db, job, patch: { status, deliveryFailure: failure } });
      await finishProgress(job, status);
      return;
    }
    await updateClaimedJob({ db, job, patch: { status: 'succeeded', answerTs: publicAnswer ? result.ts : result.message_ts,
      ...(fallbackFailure ? { deliveryFallback: fallbackFailure } : {}) } });
    await finishProgress(job, 'succeeded');
  }
  async function repairTerminalReceipts() {
    try {
      const recent = await db.collection('settlement_agent_jobs').orderBy('createdAt', 'desc').limit(20).get();
      const repairable = recent.docs.filter((doc) => {
        const value = doc.data();
        return value?.teamId === teamId && channelIds.has(value.channelId)
          && ['succeeded', 'delivery_unknown', 'failed'].includes(value.status)
          && ['chat.postMessage', 'chat.postEphemeral'].includes(value.deliveryMethod)
          && value.receiptStatus !== 'succeeded' && value.receiptFailure?.definitive !== true
          && (!Number.isSafeInteger(value.receiptRepairAttempts) || value.receiptRepairAttempts < 3)
          && /^\d{1,12}\.\d{1,6}$/.test(value.progressTs || '');
      }).slice(0, 5);
      for (const doc of repairable) await finishProgress({ ...doc.data(), id: doc.id }, doc.data().status);
    } catch { /* Receipt repair is best effort and must never block queued business work. */ }
  }
  return async ({ jobId } = {}) => {
    if (env.BFF_WORKERS_ENABLED === 'false' || env.BFF_MAINTENANCE_READ_ONLY === 'true' || env.BFF_SCHEDULER_OWNER === 'disabled') return { processed: 0 };
    if (!env.SLACK_ALERT_BOT_TOKEN) throw new Error('slack_not_configured');
    const started = Date.now();
    if (!jobId) await repairTerminalReceipts();
    const pending = jobId ? { docs: [await db.doc(`settlement_agent_jobs/${jobId}`).get()] }
      : await db.collection('settlement_agent_jobs').where('status', 'in', ['queued', 'running', 'sending']).orderBy('createdAt', 'asc').limit(10).get();
    let processed = 0;
    for (const doc of pending.docs) {
      if (!doc.data()) continue;
      if (doc.data().status === 'sending' && doc.data().leaseUntil < Date.now()) {
        await db.runTransaction(async (tx) => {
          const current = (await tx.get(doc.ref)).data();
          if (current?.status === 'sending' && current.leaseUntil < Date.now()) {
            await finishConversation(tx, db, { ...current, id: doc.id }, 'delivery_unknown');
            tx.update(doc.ref, { status: 'delivery_unknown' });
          }
        });
        await finishProgress({ ...doc.data(), id: doc.id }, 'delivery_unknown');
        continue;
      }
      const job = await claimSlackJob({ db, jobId: doc.id });
      if (job) {
        await process(job); processed++;
        if (job.conversationId) {
          // Continue queued replies while there is room for another bounded run in this invocation.
          while (processed < 10 && Date.now() - started < 110000) {
            const thread = (await db.doc(`settlement_agent_threads/${job.conversationId}`).get()).data();
            const nextId = thread?.queue[0];
            if (!nextId) break;
            const next = await claimSlackJob({ db, jobId: nextId });
            if (!next) break;
            await process(next); processed++;
          }
        }
      }
      if (!job) await finishProgress({ ...doc.data(), id: doc.id }, 'failed');
      if (processed >= 1) break;
    }
    return { processed };
  };
}

export async function saveSlackFeedback({ db, payload, teamId, channelIds }) {
  const action = payload?.actions?.[0];
  if (payload?.team?.id !== teamId || !channelIds.has(payload?.channel?.id)
    || payload.actions?.length !== 1 || !['settlement_scope_yes', 'settlement_scope_no'].includes(action?.action_id)
    || !/^[a-zA-Z0-9_-]{1,100}$/.test(action?.value || '')
    || !/^\d{1,12}\.\d{1,6}$/.test(action?.action_ts || '')) return false;
  return db.runTransaction(async (tx) => {
    const jobRef = db.doc(`settlement_agent_jobs/${action.value}`);
    const job = (await tx.get(jobRef)).data();
    if (job?.status !== 'succeeded' || job.slackUserId !== payload.user?.id
      || job.teamId !== teamId || job.channelId !== payload?.channel?.id || job.answerTs !== payload.container?.message_ts
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

export function createFeedbackIngress({ db, secret, teamId, channelIds = ['C0BQ6980HR6'], fetchImpl = fetch }) {
  const allowedChannels = new Set(channelIds);
  return async (req, res) => {
    const started = performance.now();
    if (!verifySlackRequest({ body: req.body, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), secret })) return res.status(401).json({ error: 'invalid_signature' });
    let payload;
    try { payload = JSON.parse(new URLSearchParams(req.body.toString('utf8')).get('payload')); }
    catch { return res.status(400).json({ error: 'invalid_payload' }); }
    let saved = false;
    try {
      if (!await saveSlackFeedback({ db, payload, teamId, channelIds: allowedChannels })) return res.status(403).json({ error: 'feedback_not_allowed' });
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
      ...(job.bookingContext ? { bookingContext: job.bookingContext } : {}),
      ...(job.experimentVariant ? { experimentVariant: job.experimentVariant } : {}) }].slice(-6) : thread.turns });
}
