import { createHash } from 'node:crypto';
import { assertOverview } from './cashflow-status.mjs';
import { getMonthFinanceWeeks, resolveFinanceWeekForDate } from '../../src/app/platform/cashflow-week-core.mjs';

export const REMINDER_POLICY = 'weekly-submission-thursday-kst-v1';
export const SOURCE_CHANNEL = 'C0BQ6980HR6';
const DAY = 86400000;
const fail = (code) => { throw new Error(code); };
const text = (value) => typeof value === 'string' ? value.trim() : '';
const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validDate = (value) => typeof value === 'string' && /^20\d{2}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const safeLabel = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replace(/[\r\n]/g, ' ');
const stamp = (value) => /^\d{1,12}\.\d{1,6}$/.test(value || '');

export function normalizeReminderOrg(value) {
  const normalized = text(value);
  if (!normalized || normalized === '미지정') return '';
  const team = normalized.match(/^([a-z]{2,10})\s*team$/i);
  if (team) return `${team[1].toUpperCase()}팀`;
  return /^cic\s*\d+$/i.test(normalized) ? normalized.toUpperCase().replace(/\s+/g, '') : normalized;
}

// Calendar identity comes from the ERP contract; the reminder deadline is separate.
export function reminderWindow(now = Date.now()) {
  if (!Number.isFinite(now)) fail('invalid_clock');
  const kst = new Date(now + 9 * 3600000);
  const localMidnight = Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
  const friday = localMidnight - ((kst.getUTCDay() + 2) % 7) * DAY;
  const cutoffMs = friday - 9 * 3600000;
  if (now < cutoffMs || now - cutoffMs >= 6 * 3600000) return null;
  const thursday = new Date(friday - DAY).toISOString().slice(0, 10);
  const week = resolveFinanceWeekForDate(thursday);
  return { ...week, stage: 'weekly_submission', cutoff: new Date(cutoffMs).toISOString(),
    oldest: String(Date.parse(`${week.weekStart}T00:00:00+09:00`) / 1000), latest: String(cutoffMs / 1000) };
}

export function previewReminderWindow({ yearMonth, weekNo, asOf = Date.now() }) {
  const week = getMonthFinanceWeeks(yearMonth).find((item) => item.weekNo === weekNo);
  if (!week || !Number.isFinite(asOf)) fail('invalid_preview_window');
  const start = Date.parse(`${week.weekStart}T00:00:00Z`);
  const thursday = start + ((4 - new Date(start).getUTCDay() + 7) % 7) * DAY;
  if (new Date(thursday).toISOString().slice(0, 10) > week.weekEnd) fail('preview_period_has_no_thursday');
  const anchor = reminderWindow(thursday + 15 * 3600000);
  const result = { ...anchor, preview: true, asOf: new Date(asOf).toISOString(), latest: String(asOf / 1000) };
  assertReminderWindow(result);
  return result;
}

export function assertReminderWindow(window) {
  const week = getMonthFinanceWeeks(window?.yearMonth).find((item) => item.weekNo === window?.weekNo);
  const cutoff = Date.parse(window?.cutoff);
  const anchored = reminderWindow(cutoff);
  if (!week || !anchored || window.stage !== 'weekly_submission'
    || ['yearMonth', 'weekNo', 'weekStart', 'weekEnd', 'cutoff', 'oldest'].some((key) => anchored[key] !== window[key])) fail('invalid_reminder_window');
  if (window.preview === true) {
    const asOf = Date.parse(window.asOf);
    if (!Number.isFinite(asOf) || asOf < Number(window.oldest) * 1000 || asOf > cutoff || window.latest !== String(asOf / 1000)) fail('invalid_preview_window');
  } else if (window.latest !== anchored.latest) fail('invalid_reminder_window');
}

export async function readRegisteredProjects(db, tenantId) {
  let cursor;
  const projects = [];
  for (let pages = 0; pages < 100; pages++) {
    let query = db.collection(`orgs/${tenantId}/projects`).orderBy('__name__').select('name', 'cic', 'department', 'trashedAt');
    if (cursor) query = query.startAfter(cursor);
    const page = await query.limit(100).get();
    for (const doc of page.docs) if (!doc.data().trashedAt) projects.push({ ...doc.data(), projectId: doc.id });
    if (page.docs.length < 100) return projects;
    cursor = page.docs.at(-1);
  }
  fail('project_inventory_incomplete');
}

export function resolveObligations(projects, policy, window) {
  assertReminderWindow(window);
  const periodCovered = policy?.yearMonth === window.yearMonth && policy?.weekNo === window.weekNo;
  const datedCoverage = validDate(policy?.effectiveFrom) && validDate(policy?.effectiveThrough)
    && policy.effectiveFrom <= window.weekStart && policy.effectiveThrough >= window.weekEnd;
  if (policy?.version !== 1 || policy?.policy !== REMINDER_POLICY || (!periodCovered && !datedCoverage) || !text(policy.reviewedBy) || !Number.isFinite(Date.parse(policy.reviewedAt))
    || Date.parse(policy.reviewedAt) > Date.parse(window.preview ? window.asOf : window.cutoff)
    || !Array.isArray(policy.projects)) fail('obligation_policy_unverified');
  const entries = new Map(policy.projects.map((entry) => [entry.projectId, entry]));
  const ids = new Set(projects.map((project) => project.projectId));
  if (entries.size !== policy.projects.length || ids.size !== projects.length || entries.size !== ids.size
    || [...entries.keys()].some((id) => !ids.has(id))) fail('obligation_coverage_mismatch');
  return projects.flatMap((project) => {
    const entry = entries.get(project.projectId);
    if (!entry || !['required', 'exempt'].includes(entry.obligation) || !text(entry.reason)) fail('obligation_unknown');
    if (entry.obligation === 'exempt') return [];
    const cic = normalizeReminderOrg(project.cic);
    const department = normalizeReminderOrg(project.department);
    const organization = cic || department;
    if (!organization || (cic && department && cic !== department) || !text(project.name)
      || !/^[^/]{1,120}$/.test(project.projectId)) fail('project_mapping_unknown');
    return [{ projectId: project.projectId, name: text(project.name), organization }];
  });
}

export function createReminderSlackClient({ token, fetchImpl = fetch }) {
  return async (method, body) => {
    if (!token || !['conversations.history', 'conversations.replies', 'chat.postMessage'].includes(method)) fail('slack_not_configured');
    const read = method !== 'chat.postMessage';
    const url = new URL(`https://slack.com/api/${method}`);
    if (read) url.search = new URLSearchParams(body).toString();
    const response = await fetchImpl(url, { method: read ? 'GET' : 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${token}`, ...(!read ? { 'content-type': 'application/json' } : {}) },
      ...(!read ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    if (!response.ok) fail('slack_request_failed');
    const result = await response.json();
    if (result.ok !== true) fail('slack_request_failed');
    return result;
  };
}

async function readSlackPages(slack, method, body) {
  const seen = new Set();
  const messages = [];
  let cursor = '';
  for (let page = 0; page < 200; page++) {
    const result = await slack(method, { ...body, limit: 100, ...(cursor ? { cursor } : {}) });
    if (result.ok !== true || result.is_limited === true || !Array.isArray(result.messages)
      || (result.response_metadata?.next_cursor !== undefined && typeof result.response_metadata.next_cursor !== 'string')) fail('slack_history_incomplete');
    if (result.messages.some((message) => !stamp(message.ts))) fail('slack_history_invalid');
    messages.push(...result.messages);
    const next = text(result.response_metadata?.next_cursor);
    if (!next) {
      if (result.has_more) fail('slack_history_incomplete');
      return messages;
    }
    if (seen.has(next)) fail('slack_cursor_repeated');
    seen.add(next); cursor = next;
  }
  fail('slack_history_incomplete');
}

export async function readDeadlineSlackHistory(slack, window) {
  const body = { channel: SOURCE_CHANNEL, oldest: window.oldest, latest: window.latest, inclusive: true };
  // Slack history is indexed by parent creation time, not reply time. Enumerate older
  // parents so an in-period submission on an old thread cannot silently disappear.
  const roots = await readSlackPages(slack, 'conversations.history', { ...body, oldest: '0' });
  const messages = roots.filter((root) => Number(root.ts) >= Number(window.oldest));
  for (const root of roots) {
    if (Number(root.ts) > Number(window.latest)) fail('slack_window_mismatch');
    if (!Number.isSafeInteger(root.reply_count ?? 0) || (root.reply_count ?? 0) < 0) fail('slack_thread_coverage_unknown');
    if (root.reply_count > 0 && (!stamp(root.latest_reply) || Number(root.latest_reply) >= Number(window.oldest))) {
      const replies = await readSlackPages(slack, 'conversations.replies', { ...body, ts: root.ts });
      if (stamp(root.latest_reply) && Number(root.latest_reply) >= Number(window.oldest) && Number(root.latest_reply) <= Number(window.latest)
        && !replies.some((reply) => reply.ts === root.latest_reply)) fail('slack_thread_incomplete');
      if (!replies.length && !stamp(root.latest_reply)) fail('slack_thread_coverage_unknown');
      for (const reply of replies) {
        if (Number(reply.ts) > Number(window.latest)) fail('slack_window_mismatch');
        if (Number(reply.ts) >= Number(window.oldest)) messages.push({ ...reply, thread_ts: root.ts,
          parentText: root.text || '', parentEdited: Boolean(root.edited) });
      }
    }
  }
  const unique = new Map();
  for (const message of messages) {
    if (unique.has(message.ts) && unique.get(message.ts).text !== message.text) fail('slack_message_changed');
    unique.set(message.ts, message);
  }
  return [...unique.values()];
}

// Free-form Slack text cannot resolve identity or period by itself. It is evidence, never authority.
export function reconcileSlackEvidence(messages, projects, window) {
  const result = new Map(projects.map((project) => [project.projectId, { submitted: [], ambiguous: [] }]));
  const names = new Map();
  for (const project of projects) names.set(project.name, [...(names.get(project.name) || []), project.projectId]);
  for (const message of messages) {
    const ownText = typeof message.text === 'string' ? message.text : '';
    if (!/주정산\s*완료/.test(ownText)) continue;
    const parent = message.thread_ts && message.thread_ts !== message.ts ? messages.find((item) => item.ts === message.thread_ts) : null;
    const content = `${message.parentText || parent?.text || ''}\n${ownText}`;
    const matched = projects.filter((project) => content.includes(project.name));
    const month = content.match(/(20\d{2})[년.\-/ ]+\s*(\d{1,2})\s*월?/);
    const week = content.match(/([1-5])\s*주차/);
    const periodMatches = month && week && `${month[1]}-${month[2].padStart(2, '0')}` === window.yearMonth && Number(week[1]) === window.weekNo;
    const ambiguous = matched.length !== 1 || /test|테스트|실험|샘플/i.test(content) || !periodMatches
      || message.subtype === 'message_changed' || Boolean(message.edited) || Boolean(message.parentEdited) || Boolean(parent?.edited) || !content;
    for (const project of matched.length ? matched : projects) result.get(project.projectId)[ambiguous || names.get(project.name).length !== 1 ? 'ambiguous' : 'submitted'].push(message.ts);
  }
  return result;
}

const formatKst = (instant) => new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'short', hourCycle: 'h23' }).format(new Date(instant)) + ' (한국시간)';

export function renderReminder({ window, rows, checkedAt }) {
  const groups = new Map();
  for (const row of rows) groups.set(row.organization, [...(groups.get(row.organization) || []), row]);
  return [`[주정산 제출 확인] ${window.yearMonth} ${window.weekNo}주차 (${window.weekStart}~${window.weekEnd})`,
    window.preview ? '마감 전 미리보기: 현재 업데이트 대기인 사업이며 기한 위반 명단이 아닙니다.' : '목요일 마감 이후 현재 정산 상태가 업데이트 대기인 사업입니다.',
    ...[...groups].sort(([a], [b]) => a.localeCompare(b, 'ko')).flatMap(([org, group]) => [`\n[${safeLabel(org)}]`, ...group.sort((a, b) => a.name.localeCompare(b.name, 'ko')).map((row) => `- ${safeLabel(row.name)}`)]),
    `\n상태 확인: ${formatKst(checkedAt)} · 마감 ${formatKst(window.cutoff)}`,
    '조회 시점 기준이며 과거 마감 시점의 미준수 판정이 아닙니다.'].join('\n');
}

export async function buildReminderPlan({ db, tenantId = 'mysc', window, readOverview, slack, now = Date.now, sourceRevision = 'local-unreleased' }) {
  assertReminderWindow(window);
  const projects = await readRegisteredProjects(db, tenantId);
  const policyRef = db.doc(`settlement_reminder_obligations/${tenantId}`);
  const policy = (await policyRef.get()).data();
  const eligible = resolveObligations(projects, policy, window);
  const messages = await readDeadlineSlackHistory(slack, window);
  const evidence = reconcileSlackEvidence(messages, eligible, window);
  const rows = [];
  const unknown = [];
  const conflicts = [];
  const canonicalReadStarted = now();
  const canonicalSnapshots = [];
  for (let offset = 0; offset < eligible.length; offset += 100) {
    const batch = eligible.slice(offset, offset + 100);
    const projectIds = batch.map((project) => project.projectId);
    const overview = assertOverview(await readOverview({ context: { tenantId, actorId: 'myscube-settlement-agent', actorRole: 'auditor',
      actorEmail: '', actorName: '정산 알림', authSource: 'settlement_agent_read', requestId: hash([tenantId, window.cutoff]) },
    body: { yearMonth: window.yearMonth, projectIds } }), { yearMonth: window.yearMonth, projectIds });
    for (const project of batch) {
      const item = overview.items.find((entry) => entry.projectId === project.projectId);
      const status = item.settlementStatuses.items.find((entry) => entry.period === `WEEK_${window.weekNo}`);
      const state = status.status;
      canonicalSnapshots.push({ projectId: project.projectId, period: status.period, state, revision: status.revision,
        health: item.settlementCycle.health, businessState: item.settlementCycle.businessState, workflowRevision: item.settlementCycle.workflowRevision });
      if (item.settlementCycle.health !== 'OK' || item.settlementCycle.businessState === 'INCONSISTENT') unknown.push(project.projectId);
      else if (state === 'WAITING_FOR_UPDATE') {
        const slackEvidence = evidence.get(project.projectId);
        if (slackEvidence.submitted.length || slackEvidence.ambiguous.length) conflicts.push(project.projectId);
        else rows.push(project);
      }
    }
  }
  // Inventory and eligibility may change while external reads are in flight.
  if (hash(await readRegisteredProjects(db, tenantId)) !== hash(projects) || hash((await policyRef.get()).data()) !== hash(policy)) fail('roster_changed');
  const checkedAt = new Date(canonicalReadStarted).toISOString();
  const complete = unknown.length === 0 && conflicts.length === 0;
  return { window, rows, unknown, conflicts, complete, checkedAt, registered: projects.length, eligible: eligible.length,
    historyCount: messages.length, provenance: { sourceRevision, policyHash: hash(policy), inventoryHash: hash(projects),
      slackHash: hash(messages), canonicalHash: hash(canonicalSnapshots), policySnapshot: policy,
      canonicalSnapshots, slackEvidence: Object.fromEntries(evidence), cutoff: window.cutoff, checkedAt }, text: complete ? renderReminder({ window, rows, checkedAt }) : null };
}

export async function deliverReminder({ db, slack, plan, destination, tenantId = 'mysc', now = Date.now }) {
  if (plan.window?.preview || destination !== SOURCE_CHANNEL || !plan.complete || !plan.rows.length || !plan.text || plan.text.length > 30000) fail('delivery_not_ready');
  assertReminderWindow(plan.window);
  if (Buffer.byteLength(JSON.stringify(plan.provenance || {}), 'utf8') > 400000) fail('provenance_too_large');
  if (!Number.isFinite(Date.parse(plan.checkedAt)) || now() - Date.parse(plan.checkedAt) > 60000 || now() < Date.parse(plan.checkedAt)) fail('stale_final_validation');
  const id = hash([REMINDER_POLICY, tenantId, destination, plan.window.yearMonth, plan.window.weekNo, plan.window.stage, plan.window.cutoff]);
  const ref = db.doc(`settlement_reminder_deliveries/${id}`);
  const reserved = await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return false;
    tx.set(ref, { status: 'sending', policy: REMINDER_POLICY, tenantId, destination, cutoff: plan.window.cutoff,
      yearMonth: plan.window.yearMonth, weekNo: plan.window.weekNo, provenance: plan.provenance || null, payloadHash: hash(plan.text), createdAt: new Date(now()).toISOString() });
    return true;
  });
  if (!reserved) return { status: 'already_reserved', id };
  if (now() - Date.parse(plan.checkedAt) > 60000 || now() < Date.parse(plan.checkedAt)) {
    await ref.update({ status: 'blocked_stale', updatedAt: new Date(now()).toISOString() });
    return { status: 'blocked_stale', id };
  }
  let response;
  try {
    response = await slack('chat.postMessage', { channel: destination, text: plan.text, mrkdwn: false,
      parse: 'none', link_names: false, unfurl_links: false, unfurl_media: false, client_msg_id: `${id.slice(0, 8)}-${id.slice(8, 12)}-4${id.slice(13, 16)}-a${id.slice(17, 20)}-${id.slice(20, 32)}` });
    if (response.ok !== true || !stamp(response.ts) || response.channel !== destination) fail('delivery_response_unknown');
  } catch {
    await ref.update({ status: 'delivery_unknown', updatedAt: new Date(now()).toISOString() });
    return { status: 'delivery_unknown', id };
  }
  // A failed receipt write leaves 'sending', which is intentionally never automatically retried.
  await ref.update({ status: 'succeeded', ts: response.ts, updatedAt: new Date(now()).toISOString() });
  return { status: 'succeeded', id };
}

export function createSettlementReminderWorker({ db, readOverview, env = process.env, fetchImpl = fetch, now = Date.now }) {
  const readSlack = createReminderSlackClient({ token: env.SETTLEMENT_REMINDERS_SLACK_READ_TOKEN || env.SLACK_ALERT_BOT_TOKEN, fetchImpl });
  const writeSlack = createReminderSlackClient({ token: env.SLACK_ALERT_BOT_TOKEN, fetchImpl });
  return async () => {
    if (env.SETTLEMENT_REMINDERS_ENABLED !== 'true') return { status: 'disabled' };
    const window = reminderWindow(now());
    if (!window) return { status: 'outside_window' };
    const plan = await buildReminderPlan({ db, readOverview, slack: readSlack, window, now, sourceRevision: env.SLACK_SERVICE_RELEASE || env.VERCEL_GIT_COMMIT_SHA || env.GITHUB_SHA || 'local-unreleased' });
    const summary = { complete: plan.complete, eligible: plan.eligible, candidates: plan.rows.length, unknown: plan.unknown.length,
      conflicts: plan.conflicts.length, cutoff: window.cutoff };
    if (!plan.complete) return { status: 'blocked_incomplete', ...summary };
    if (env.SETTLEMENT_REMINDERS_SEND !== 'true') return { status: 'dry_run', ...summary };
    if (!/^[a-f0-9]{40}$/.test(plan.provenance.sourceRevision)) fail('release_revision_unverified');
    if (env.SETTLEMENT_REMINDERS_POLICY_APPROVED !== REMINDER_POLICY || env.SETTLEMENT_REMINDERS_DESTINATION !== SOURCE_CHANNEL) fail('activation_unapproved');
    if (!plan.rows.length) return { status: 'no_candidates', ...summary };
    return { ...await deliverReminder({ db, slack: writeSlack, plan, destination: env.SETTLEMENT_REMINDERS_DESTINATION, now }), ...summary };
  };
}
