import test from 'node:test';
import assert from 'node:assert/strict';
import { MONTH_CLOSE_REMINDER_POLICY, selectMonthCloseProjects, classifyMonthClose, buildMonthCloseReminderPlan,
  deliverMonthCloseReminder, createMonthCloseReminderWorker } from './month-close-reminders.mjs';
import { SOURCE_CHANNEL } from './settlement-reminders.mjs';

const input = { yearMonth: '2026-10', submissionDeadlineAt: '2026-10-10T14:59:00Z', approvalDeadlineAt: '2026-10-13T14:59:00Z' };
const now = Date.parse('2026-10-12T00:00:00Z');
const base = { projectId: 'active-a', name: '합성 사업 A', cic: 'CIC1', department: 'CIC1', managerId: 'manager-a', status: 'IN_PROGRESS', contractEnd: '2026-12-31' };
const projects = [base, { ...base, projectId: 'ended', name: '합성 종료 사업', status: 'COMPLETED' }];

function overview(ids, stateById = {}) {
  return { version: '5', yearMonth: '2026-10', monthCloseTargetYearMonth: '2026-09', monthCloseTargetLabel: '9월', errors: [], items: ids.map((projectId) => {
    const businessState = stateById[projectId] || 'NOT_REQUESTED';
    const status = businessState === 'LOCKED' ? 'LOCKED' : businessState === 'SUBMITTED' ? 'SUBMITTED' : 'WAITING_FOR_UPDATE';
    const item = (period) => ({ period, status: period === 'MONTH' ? status : 'WAITING_FOR_UPDATE', revision: 0, submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', deadlineAt: input.submissionDeadlineAt, approverDeadlineAt: input.approvalDeadlineAt });
    return { projectId, projectionActualSummary: null, sheetCapturedAt: null,
      settlementStatuses: { projectId, yearMonth: '2026-10', items: ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map(item) },
      settlementCycle: { cycleYearMonth: '2026-10', weeklyYearMonth: '2026-10', monthCloseTargetYearMonth: '2026-09', businessState, health: 'OK', workflowRevision: 0,
        monthCloseSettlement: item('MONTH'), provenance: null, supersededAttempt: null,
        commandCapabilities: Object.fromEntries(['SUBMIT_MONTH_CLOSE','WITHDRAW_MONTH_CLOSE','APPROVE_MONTH_CLOSE','REJECT_MONTH_CLOSE','REQUEST_MONTH_REOPEN','APPROVE_MONTH_REOPEN','REJECT_MONTH_REOPEN','CANCEL_ACTIVE_CYCLE'].map((key) => [key, { allowed: false, reasonCode: 'TEST_DISABLED' }])) } };
  }) };
}

function fakeDb(rows = projects, managerNames = { 'manager-a': '담당자 A' }) {
  const store = new Map(); const writes = [];
  return { writes, store, collection(path) { let start = 0; let limit = 100; let uid = '';
    return { orderBy() { return this; }, select() { return this; }, where(_f, _o, value) { uid = value; return this; }, limit(value) { limit = value; return this; },
      startAfter(doc) { start = rows.findIndex((row) => row.projectId === doc.id) + 1; return this; }, async get() {
        if (path.endsWith('/persons')) return { docs: managerNames[uid] ? [{ id: `person-${uid}`, data: () => ({ name: managerNames[uid] }) }] : [] };
        return { docs: rows.slice(start, start + limit).map((row) => ({ id: row.projectId, data: () => row })) };
      } }; }, doc(path) { return { path, async get() { return { exists: store.has(path), data: () => store.get(path) }; }, async update(patch) { writes.push(path); store.set(path, { ...store.get(path), ...patch }); } }; },
    async runTransaction(fn) { return fn({ get: (ref) => ref.get(), set(ref, data) { writes.push(ref.path); store.set(ref.path, data); } }); } };
}

test('monthly inventory excludes ended and isolates duplicates or stale active periods', () => {
  const duplicate = [{ ...base }, { ...base, projectId: 'active-b' }];
  assert.equal(selectMonthCloseProjects(projects, '2026-09').excluded.length, 1);
  assert.equal(selectMonthCloseProjects(duplicate, '2026-09').unknown.length, 2);
  assert.equal(selectMonthCloseProjects([{ ...base, contractEnd: '2026-08-31' }], '2026-09').unknown[0].reason, 'project_period_conflict');
  const malformedEnded = { projectId: 'ended-bad', name: '합성 사업 A', status: 'COMPLETED', cic: '', department: '' };
  const selected = selectMonthCloseProjects([base, malformedEnded], '2026-09');
  assert.equal(selected.excluded.length, 1); assert.equal(selected.eligible.length, 1); assert.equal(selected.unknown.length, 0);
  for (const contractEnd of ['2026-02-30', '2026-99-99', 20260930]) {
    assert.equal(selectMonthCloseProjects([{ ...base, contractEnd }], '2026-09').unknown[0].reason, 'project_period_conflict');
  }
  assert.equal(selectMonthCloseProjects([{ ...base, contractEnd: '' }], '2026-09').eligible.length, 1);
});

test('canonical monthly state never uses weekly status', () => {
  for (const [state, expected] of [['NOT_REQUESTED', 'before_close'], ['REOPENED', 'before_close'], ['REJECTED', 'before_close'], ['WITHDRAWN', 'before_close'], ['SUBMITTED', 'approval_required'], ['LOCKED', 'complete'], ['REOPEN_REQUESTED', 'unknown']]) {
    assert.equal(classifyMonthClose(overview(['x'], { x: state }).items[0]), expected);
  }
});

test('preview covers 101 projects in 100-sized canonical pages and uses ERP managers', async () => {
  const rows = Array.from({ length: 101 }, (_, index) => ({ ...base, projectId: `p-${index}`, name: `합성 사업 ${index}` }));
  const db = fakeDb(rows); const sizes = [];
  const result = await buildMonthCloseReminderPlan({ db, input, preview: true, now: () => now,
    readOverview: async ({ body }) => { sizes.push(body.projectIds.length); return overview(body.projectIds, { 'p-100': 'SUBMITTED' }); } });
  assert.deepEqual(sizes, [100, 1]); assert.equal(result.targetYearMonth, '2026-09'); assert.equal(result.beforeClose.length, 100);
  assert.equal(result.approvalRequired.length, 1); assert.match(result.text, /합성 사업 0\(담당자 A\)/); assert.equal(db.writes.length, 0);
});

test('missing manager and unhealthy canonical state are 확인 필요 and block text', async () => {
  let plan = await buildMonthCloseReminderPlan({ db: fakeDb([base], {}), input, preview: true, now: () => now, readOverview: async ({ body }) => overview(body.projectIds) });
  assert.equal(plan.complete, false); assert.match(plan.text, /확인 필요/); assert.equal(plan.unknown[0].reason, 'manager_mapping_unknown');
  plan = await buildMonthCloseReminderPlan({ db: fakeDb([base]), input, preview: true, now: () => now, readOverview: async ({ body }) => { const result = overview(body.projectIds); result.items[0].settlementCycle.health = 'UNAVAILABLE'; return result; } });
  assert.equal(plan.complete, false); assert.equal(plan.unknown[0].reason, 'canonical_state_unknown');
});

test('preview is side-effect free and can never deliver', async () => {
  const db = fakeDb([base]); const plan = await buildMonthCloseReminderPlan({ db, input, preview: true, now: () => now, readOverview: async ({ body }) => overview(body.projectIds) });
  await assert.rejects(deliverMonthCloseReminder({ db, plan, destination: SOURCE_CHANNEL, now: () => now, slack: async () => ({}) }), /not_ready/);
  assert.equal(db.writes.length, 0);
});

test('monthly receipt is independent and suppresses uncertain retries', async () => {
  const db = fakeDb([base]); const preview = await buildMonthCloseReminderPlan({ db, input, preview: false, now: () => now, sourceRevision: 'a'.repeat(40), readOverview: async ({ body }) => overview(body.projectIds) });
  let sends = 0; const deliver = () => deliverMonthCloseReminder({ db, plan: preview, destination: SOURCE_CHANNEL, now: () => now, slack: async () => { sends++; throw new Error('accepted then timeout'); } });
  assert.equal((await deliver()).status, 'delivery_unknown'); assert.equal((await deliver()).status, 'already_reserved'); assert.equal(sends, 1);
  assert.ok(db.writes.every((path) => path.startsWith('settlement_reminder_deliveries/'))); assert.equal(preview.policy, MONTH_CLOSE_REMINDER_POLICY);
});

test('delivery freshness is rechecked after receipt reservation', async () => {
  let clock = now; let sent = false; const updates = [];
  const plan = { preview: false, complete: true, beforeClose: [base], approvalRequired: [], text: '합성 월결산 알림', checkedAt: new Date(now).toISOString(),
    request: input, targetYearMonth: '2026-09', provenance: {} };
  const ref = { async update(value) { updates.push(value); } };
  const result = await deliverMonthCloseReminder({ plan, destination: SOURCE_CHANNEL, now: () => clock,
    db: { doc: () => ref, async runTransaction() { clock += 61000; return true; } },
    slack: async () => { sent = true; return {}; } });
  assert.equal(result.status, 'blocked_stale'); assert.equal(sent, false); assert.equal(updates[0].status, 'blocked_stale');
});

test('repeating worker defaults disabled and dry-run never posts', async () => {
  assert.equal((await createMonthCloseReminderWorker({ db: null, readOverview: null, env: {} })()).status, 'disabled');
  const db = fakeDb([base]); let posts = 0;
  const worker = createMonthCloseReminderWorker({ db, now: () => now, readOverview: async ({ body }) => overview(body.projectIds),
    env: { MONTH_CLOSE_REMINDERS_ENABLED: 'true', MONTH_CLOSE_REMINDERS_CYCLE: input.yearMonth, MONTH_CLOSE_REMINDERS_SUBMISSION_DEADLINE: input.submissionDeadlineAt, MONTH_CLOSE_REMINDERS_APPROVAL_DEADLINE: input.approvalDeadlineAt, SLACK_ALERT_BOT_TOKEN: 'fixture' },
    fetchImpl: async () => { posts++; return Response.json({ ok: true }); } });
  assert.equal((await worker()).status, 'dry_run'); assert.equal(posts, 0); assert.equal(db.writes.length, 0);
});
