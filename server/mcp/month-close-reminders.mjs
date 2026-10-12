import { createHash } from 'node:crypto';
import { assertOverview } from './cashflow-status.mjs';
import { SOURCE_CHANNEL, createReminderSlackClient, normalizeReminderOrg, readRegisteredProjects } from './settlement-reminders.mjs';
import { isProjectContractEnded, isRealIsoCalendarDate } from '../../src/app/platform/project-period-state.mjs';

export const MONTH_CLOSE_REMINDER_POLICY = 'month-close-prior-month-v1';
const END_STATUSES = new Set(['COMPLETED', 'COMPLETED_PENDING_PAYMENT']);
const ACTIVE_STATUSES = new Set(['CONTRACT_PENDING', 'IN_PROGRESS']);
const PRE_APPROVAL = new Set(['NOT_REQUESTED', 'REOPENED', 'REJECTED', 'WITHDRAWN']);
const text = (value) => typeof value === 'string' ? value.trim() : '';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (code) => { throw new Error(code); };
const safe = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ');
export const validCalendarDate = isRealIsoCalendarDate;
const instant = (value) => typeof value === 'string' && validCalendarDate(value.slice(0, 10)) && Number.isFinite(Date.parse(value));

export function assertMonthCloseRequest(input) {
  const yearMonth = text(input?.yearMonth);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(yearMonth)
    || !instant(input?.submissionDeadlineAt) || !instant(input?.approvalDeadlineAt)
    || Date.parse(input.submissionDeadlineAt) >= Date.parse(input.approvalDeadlineAt)) fail('month_close_request_invalid');
  return { yearMonth, submissionDeadlineAt: input.submissionDeadlineAt, approvalDeadlineAt: input.approvalDeadlineAt };
}

function projectShape(project) {
  const cic = normalizeReminderOrg(project.cic);
  const department = normalizeReminderOrg(project.department);
  const organization = cic || department;
  if (!text(project.name) || !organization || (cic && department && cic !== department)) return null;
  return { projectId: project.projectId, name: text(project.name), organization, managerId: text(project.managerId),
    status: text(project.status), contractEnd: text(project.contractEnd) };
}

export function selectMonthCloseProjects(projects, _targetYearMonth, nowIso = new Date().toISOString()) {
  const contractEndPresent = (project) => project.contractEnd !== undefined && project.contractEnd !== null && project.contractEnd !== '';
  const contractEndInvalid = (project) => contractEndPresent(project) && !validCalendarDate(project.contractEnd);
  const ended = (project) => END_STATUSES.has(text(project.status))
    || (!contractEndInvalid(project) && isProjectContractEnded(project.contractEnd, nowIso));
  const nameIds = new Map();
  for (const project of projects.filter((candidate) => !ended(candidate))) {
    const name = text(project.name);
    if (name) nameIds.set(name, new Set([...(nameIds.get(name) || []), project.projectId]));
  }
  const eligible = []; const excluded = []; const unknown = [];
  for (const project of projects) {
    if (END_STATUSES.has(text(project.status))) {
      excluded.push({ projectId: project.projectId, reason: 'ended_project' }); continue;
    }
    if (contractEndInvalid(project)) {
      const shaped = projectShape(project);
      unknown.push(shaped ? { ...shaped, reason: 'project_period_conflict' }
        : { projectId: project.projectId, name: text(project.name) || '사업명 확인 필요', organization: normalizeReminderOrg(project.cic) || normalizeReminderOrg(project.department) || '조직 확인 필요', reason: 'project_period_conflict' });
      continue;
    }
    if (isProjectContractEnded(project.contractEnd, nowIso)) {
      excluded.push({ projectId: project.projectId, reason: 'ended_project' }); continue;
    }
    const shaped = projectShape(project);
    if (!shaped) { unknown.push({ projectId: project.projectId, name: text(project.name) || '사업명 확인 필요', organization: normalizeReminderOrg(project.cic) || normalizeReminderOrg(project.department) || '조직 확인 필요', reason: 'project_mapping_unknown' }); continue; }
    if (nameIds.get(shaped.name)?.size !== 1) { unknown.push({ ...shaped, reason: 'duplicate_business_name' }); continue; }
    if (!ACTIVE_STATUSES.has(shaped.status)) { unknown.push({ ...shaped, reason: 'project_status_unknown' }); continue; }
    eligible.push(shaped);
  }
  return { eligible, excluded, unknown };
}

async function attachManagers(db, tenantId, projects) {
  const cache = new Map(); const rows = []; const unknown = [];
  for (const project of projects) {
    const uid = project.managerId;
    if (!uid || uid.includes('/')) { unknown.push({ ...project, reason: 'manager_mapping_unknown' }); continue; }
    if (!cache.has(uid)) {
      const found = await db.collection(`orgs/${tenantId}/persons`).where('uid', '==', uid).select('name').limit(2).get();
      cache.set(uid, found.docs.length === 1 && text(found.docs[0].data().name) ? text(found.docs[0].data().name) : null);
    }
    const managerName = cache.get(uid);
    if (!managerName) unknown.push({ ...project, reason: 'manager_mapping_unknown' });
    else rows.push({ ...project, managerName });
  }
  return { rows, unknown };
}

export function classifyMonthClose(item) {
  const cycle = item?.settlementCycle;
  if (!cycle || cycle.health !== 'OK' || cycle.businessState === 'INCONSISTENT' || cycle.businessState === 'REOPEN_REQUESTED') return 'unknown';
  if (PRE_APPROVAL.has(cycle.businessState)) return 'before_close';
  if (cycle.businessState === 'SUBMITTED') return 'approval_required';
  if (cycle.businessState === 'LOCKED') return 'complete';
  return 'unknown';
}

const formatKst = (value) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(value)) + ' (한국시간)';
export function renderMonthCloseReminder({ request, targetYearMonth, beforeClose, approvalRequired, unknown, checkedAt, preview }) {
  const group = (title, rows) => rows.length ? [`\n[${title}]`, ...rows.sort((a, b) => a.organization.localeCompare(b.organization, 'ko') || a.name.localeCompare(b.name, 'ko'))
    .map((row) => `- [${safe(row.organization)}] ${safe(row.name)}(${safe(row.managerName)})`)] : [];
  return [`[${Number(targetYearMonth.slice(5))}월분 월결산 확인]`, preview ? '비공개 미리보기입니다. 실제 공지는 발송되지 않습니다.' : '월결산 제출 및 조직장 승인 대상을 안내합니다.',
    ...group('결산 전', beforeClose), ...group('조직장 승인 필요', approvalRequired),
    ...(unknown.length ? ['\n[확인 필요]', ...unknown.sort((a, b) => String(a.organization).localeCompare(String(b.organization), 'ko') || String(a.name).localeCompare(String(b.name), 'ko'))
      .map((row) => `- [${safe(row.organization || '조직 확인 필요')}] ${safe(row.name || '사업명 확인 필요')}(${safe(row.managerName || '담당자 확인 필요')}) · ${safe(row.reason)}`)] : []),
    `\n제출 마감 ${formatKst(request.submissionDeadlineAt)} · 조직장 승인 마감 ${formatKst(request.approvalDeadlineAt)}`,
    `상태 확인 ${formatKst(checkedAt)} · MYSCube canonical 월결산 기준`].join('\n');
}

export async function buildMonthCloseReminderPlan({ db, readOverview, input, tenantId = 'mysc', actorContext, now = Date.now, preview = true, sourceRevision = 'local-unreleased' }) {
  const request = assertMonthCloseRequest(input);
  const inventory = await readRegisteredProjects(db, tenantId);
  const expectedTarget = new Date(`${request.yearMonth}-01T00:00:00Z`); expectedTarget.setUTCMonth(expectedTarget.getUTCMonth() - 1);
  const targetYearMonth = expectedTarget.toISOString().slice(0, 7);
  const checkedAt = new Date(now()).toISOString();
  const selected = selectMonthCloseProjects(inventory, targetYearMonth, checkedAt);
  const managed = await attachManagers(db, tenantId, selected.eligible);
  const unknown = [...selected.unknown, ...managed.unknown];
  const beforeClose = []; const approvalRequired = []; const completeRows = []; const snapshots = [];
  for (let offset = 0; offset < managed.rows.length; offset += 100) {
    const batch = managed.rows.slice(offset, offset + 100); const projectIds = batch.map((row) => row.projectId);
    const context = actorContext
      ? { ...actorContext, tenantId, requestId: actorContext.requestId || hash([tenantId, request.yearMonth, checkedAt]) }
      : { tenantId, actorId: 'myscube-settlement-agent', actorRole: 'auditor', actorEmail: '', actorName: '월결산 알림', authSource: 'settlement_agent_read', requestId: hash([tenantId, request.yearMonth, checkedAt]) };
    const overview = assertOverview(await readOverview({ context, body: { yearMonth: request.yearMonth, projectIds } }), { yearMonth: request.yearMonth, projectIds });
    if (overview.monthCloseTargetYearMonth !== targetYearMonth) fail('month_close_target_mismatch');
    for (const row of batch) {
      const item = overview.items.find((candidate) => candidate.projectId === row.projectId); const state = classifyMonthClose(item);
      snapshots.push({ projectId: row.projectId, state, health: item.settlementCycle.health, businessState: item.settlementCycle.businessState, workflowRevision: item.settlementCycle.workflowRevision });
      if (state === 'before_close') beforeClose.push(row); else if (state === 'approval_required') approvalRequired.push(row);
      else if (state === 'complete') completeRows.push(row); else unknown.push({ ...row, reason: 'canonical_state_unknown' });
    }
  }
  const refreshed = await readRegisteredProjects(db, tenantId);
  const refreshedSelected = selectMonthCloseProjects(refreshed, targetYearMonth, checkedAt);
  const refreshedManaged = await attachManagers(db, tenantId, refreshedSelected.eligible);
  if (hash(refreshed) !== hash(inventory) || hash(refreshedManaged) !== hash(managed)) fail('roster_changed');
  const complete = unknown.length === 0;
  const plan = { policy: MONTH_CLOSE_REMINDER_POLICY, request, targetYearMonth, preview, complete, beforeClose, approvalRequired,
    completed: completeRows.length, excluded: selected.excluded, unknown, registered: inventory.length, eligible: managed.rows.length,
    checkedAt, provenance: { sourceRevision, inventoryHash: hash(inventory), managerHash: hash(managed), canonicalHash: hash(snapshots), snapshots } };
  return { ...plan, text: preview || complete ? renderMonthCloseReminder({ ...plan, checkedAt }) : null };
}

export async function deliverMonthCloseReminder({ db, slack, plan, destination, tenantId = 'mysc', now = Date.now }) {
  if (plan.preview || !plan.complete || destination !== SOURCE_CHANNEL || !plan.text || (!plan.beforeClose.length && !plan.approvalRequired.length)) fail('month_close_delivery_not_ready');
  if (now() - Date.parse(plan.checkedAt) > 60000 || now() < Date.parse(plan.checkedAt)) fail('stale_final_validation');
  const id = hash([MONTH_CLOSE_REMINDER_POLICY, tenantId, destination, plan.request.yearMonth, plan.targetYearMonth]);
  const ref = db.doc(`settlement_reminder_deliveries/${id}`);
  const reserved = await db.runTransaction(async (tx) => { if ((await tx.get(ref)).exists) return false;
    tx.set(ref, { status: 'sending', policy: MONTH_CLOSE_REMINDER_POLICY, tenantId, destination, cycleYearMonth: plan.request.yearMonth,
      targetYearMonth: plan.targetYearMonth, payloadHash: hash(plan.text), provenance: plan.provenance, createdAt: new Date(now()).toISOString() }); return true; });
  if (!reserved) return { status: 'already_reserved', id };
  if (now() - Date.parse(plan.checkedAt) > 60000 || now() < Date.parse(plan.checkedAt)) {
    await ref.update({ status: 'blocked_stale', updatedAt: new Date(now()).toISOString() });
    return { status: 'blocked_stale', id };
  }
  try {
    const response = await slack('chat.postMessage', { channel: destination, text: plan.text, mrkdwn: false, parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false });
    if (response.ok !== true || response.channel !== destination || !/^\d{1,12}\.\d{1,6}$/.test(response.ts || '')) fail('delivery_response_unknown');
    await ref.update({ status: 'succeeded', ts: response.ts, updatedAt: new Date(now()).toISOString() }); return { status: 'succeeded', id };
  } catch { await ref.update({ status: 'delivery_unknown', updatedAt: new Date(now()).toISOString() }); return { status: 'delivery_unknown', id }; }
}

export function createMonthCloseReminderWorker({ db, readOverview, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const slack = createReminderSlackClient({ token: env.SLACK_ALERT_BOT_TOKEN, fetchImpl });
  return async ({ preview = false, input, actorContext, tenantId } = {}) => {
    if (!preview && env.MONTH_CLOSE_REMINDERS_ENABLED !== 'true') return { status: 'disabled' };
    const configured = input || { yearMonth: env.MONTH_CLOSE_REMINDERS_CYCLE, submissionDeadlineAt: env.MONTH_CLOSE_REMINDERS_SUBMISSION_DEADLINE, approvalDeadlineAt: env.MONTH_CLOSE_REMINDERS_APPROVAL_DEADLINE };
    const plan = await buildMonthCloseReminderPlan({ db, readOverview, input: configured, actorContext, tenantId, now, preview, sourceRevision: env.SLACK_SERVICE_RELEASE || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || 'local-unreleased' });
    if (preview) return { status: plan.complete ? 'preview' : 'blocked_incomplete', plan };
    const summary = { complete: plan.complete, beforeClose: plan.beforeClose.length, approvalRequired: plan.approvalRequired.length, unknown: plan.unknown.length };
    if (!plan.complete) return { status: 'blocked_incomplete', ...summary };
    if (env.MONTH_CLOSE_REMINDERS_SEND !== 'true') return { status: 'dry_run', ...summary };
    if (env.MONTH_CLOSE_REMINDERS_POLICY_APPROVED !== MONTH_CLOSE_REMINDER_POLICY || env.MONTH_CLOSE_REMINDERS_DESTINATION !== SOURCE_CHANNEL) fail('activation_unapproved');
    return { ...await deliverMonthCloseReminder({ db, slack, plan, destination: env.MONTH_CLOSE_REMINDERS_DESTINATION, now }), ...summary };
  };
}
