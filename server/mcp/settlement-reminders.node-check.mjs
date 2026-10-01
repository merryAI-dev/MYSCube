import test from 'node:test';
import assert from 'node:assert/strict';
import { REMINDER_POLICY, SOURCE_CHANNEL, reminderWindow, resolveObligations, reconcileSlackEvidence,
  readDeadlineSlackHistory, buildReminderPlan, deliverReminder, createSettlementReminderWorker, createReminderSlackClient } from './settlement-reminders.mjs';

const cutoff = Date.parse('2026-10-01T15:00:00.000Z');
const window = reminderWindow(cutoff);
const registered = [{ projectId: 'p1', name: '사업 하나', cic: 'CIC 2', department: 'CIC2' }];
const policy = { version: 1, policy: REMINDER_POLICY, yearMonth: '2026-10', weekNo: 1, reviewedBy: 'owner', reviewedAt: '2026-10-01T12:00:00Z', projects: [{ projectId: 'p1', obligation: 'required', reason: '운영 대상 확인' }] };
const clone = (value) => structuredClone(value);
function overview(ids, status = 'WAITING_FOR_UPDATE') {
  return { version: '5', yearMonth: '2026-10', monthCloseTargetYearMonth: '2026-09', monthCloseTargetLabel: '9월', errors: [],
    items: ids.map((projectId) => ({ projectId, projectionActualSummary: null, sheetCapturedAt: null,
      settlementStatuses: { projectId, yearMonth: '2026-10', items: ['MONTH', 'WEEK_1', 'WEEK_2', 'WEEK_3', 'WEEK_4', 'WEEK_5'].map((period) => ({ period, status: period === 'MONTH' ? 'WAITING_FOR_UPDATE' : status,
        revision: 0, submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '', deadlineAt: '2026-10-01T15:00:00Z', approverDeadlineAt: '2026-10-02T04:00:00Z' })) },
      settlementCycle: { cycleYearMonth: '2026-10', weeklyYearMonth: '2026-10', monthCloseTargetYearMonth: '2026-09', businessState: 'NOT_REQUESTED', health: 'OK', workflowRevision: 0, monthCloseSettlement: null, provenance: null, supersededAttempt: null,
        commandCapabilities: Object.fromEntries(['SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE', 'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE'].map((name) => [name, { allowed: false, reasonCode: 'TEST_DISABLED' }])) } })) };
}
function fakeDb(projects = registered, obligation = policy) {
  const store = new Map(); const writes = [];
  const db = { store, writes, collection(path) { assert.match(path, /^orgs\/mysc\/projects$/); let start = 0; let limit = 100;
    return { orderBy() { return this; }, select() { return this; }, startAfter(doc) { start = projects.findIndex((item) => item.projectId === doc.id) + 1; return this; }, limit(value) { limit = value; return this; }, async get() { return { docs: projects.slice(start, start + limit).map((item) => ({ id: item.projectId, data: () => item })) }; } }; },
    doc(path) { return { path, async get() { if (path.startsWith('settlement_reminder_obligations/')) return { data: () => obligation };
      return { exists: store.has(path), data: () => store.get(path) }; }, async update(patch) { writes.push(path); store.set(path, { ...store.get(path), ...patch }); } }; },
    async runTransaction(fn) { return fn({ get: (ref) => ref.get(), set(ref, data) { writes.push(ref.path); store.set(ref.path, data); } }); } };
  return db;
}
const emptySlack = async () => ({ ok: true, messages: [] });
const planArgs = () => ({ db: fakeDb(), window, slack: emptySlack, readOverview: async ({ body }) => overview(body.projectIds), now: () => cutoff });

test('Thursday EOD is Friday 00:00 KST with explicit October finance intervals', () => {
  const expected = [['01', '04'], ['05', '11'], ['12', '18'], ['19', '25'], ['26', '31']];
  for (const [i, day] of ['01', '08', '15', '22', '29'].entries()) {
    const w = reminderWindow(Date.parse(`2026-10-${day}T15:00:00Z`));
    assert.equal(w.weekNo, i + 1); assert.equal(w.weekStart, `2026-10-${expected[i][0]}`); assert.equal(w.weekEnd, `2026-10-${expected[i][1]}`);
  }
  assert.equal(reminderWindow(cutoff - 1), null); assert.equal(reminderWindow(cutoff + 6 * 3600000), null);
});
test('late execution anchors cutoff, cross-month day and canonical five-slot calendar', () => {
  assert.deepEqual(reminderWindow(cutoff + 3600000), window);
  const august = reminderWindow(Date.parse('2026-08-27T15:00:00Z'));
  assert.equal(august.weekNo, 5); assert.equal(august.weekEnd, '2026-08-31');
  const boundary = reminderWindow(Date.parse('2026-04-30T15:00:00Z'));
  assert.equal(boundary.yearMonth, '2026-04'); assert.equal(boundary.weekEnd, '2026-04-30');
});
test('explicit obligations, exemptions and organization normalization; registration alone fails', () => {
  assert.equal(resolveObligations(registered, policy, window)[0].organization, 'CIC2');
  assert.throws(() => resolveObligations(registered, undefined, window), /unverified/);
  assert.throws(() => resolveObligations([...registered, { projectId: 'p2' }], policy, window), /coverage/);
  assert.throws(() => resolveObligations([{ ...registered[0], department: 'CIC3' }], policy, window), /mapping/);
  const exempt = clone(policy); exempt.projects[0].obligation = 'exempt'; assert.deepEqual(resolveObligations(registered, exempt, window), []);
});
test('full Slack pagination includes threads and rejects partial or looping cursors', async () => {
  const root = { ts: `${Number(window.oldest) + 1}.000001`, text: 'root', reply_count: 1 };
  const reply = { ts: `${Number(window.oldest) + 2}.000001`, text: 'reply' };
  const calls = [];
  const slack = async (method, body) => { calls.push({ method, body });
    if (method === 'conversations.replies') return { ok: true, messages: [root, reply] };
    return body.cursor ? { ok: true, messages: [] } : { ok: true, messages: [root], has_more: true, response_metadata: { next_cursor: 'next' } }; };
  assert.equal((await readDeadlineSlackHistory(slack, window)).length, 2);
  assert.equal(calls.length, 3); assert.ok(calls.every(({ body }) => body.latest === window.latest));
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], has_more: true }), window), /incomplete/);
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], response_metadata: { next_cursor: 'same' } }), window), /repeated/);
});
test('Slack completion is submission evidence; tests, missing years and duplicate names are ambiguous', () => {
  const projects = resolveObligations(registered, policy, window);
  let evidence = reconcileSlackEvidence([{ ts: '1.0', text: '2026년 10월 1주차 사업 하나 주정산 완료' }], projects, window);
  assert.equal(evidence.get('p1').submitted.length, 1);
  for (const suffix of ['테스트 2026년 10월 1주차', '10월 1주차', '2026년 09월 1주차']) {
    evidence = reconcileSlackEvidence([{ ts: '1.0', text: `사업 하나 주정산 완료 ${suffix}` }], projects, window);
    assert.equal(evidence.get('p1').ambiguous.length, 1);
  }
});
test('canonical WAITING only, pending/complete excluded, unknown and conflict block delivery', async () => {
  for (const state of ['WAITING_FOR_UPDATE', 'PENDING_APPROVAL', 'COMPLETED']) {
    const args = planArgs(); args.readOverview = async ({ body }) => overview(body.projectIds, state);
    const plan = await buildReminderPlan(args); assert.equal(plan.complete, true); assert.equal(plan.rows.length, state === 'WAITING_FOR_UPDATE' ? 1 : 0); assert.equal(args.db.writes.length, 0);
  }
  let args = planArgs(); args.readOverview = async ({ body }) => { const result = overview(body.projectIds); result.items[0].settlementCycle.health = 'UNAVAILABLE'; return result; };
  assert.equal((await buildReminderPlan(args)).complete, false);
  args = planArgs(); args.slack = async () => ({ ok: true, messages: [{ ts: `${Number(window.oldest) + 1}.000001`, text: '2026년 10월 1주차 사업 하나 주정산 완료' }] });
  assert.equal((await buildReminderPlan(args)).complete, false);
});
test('failed or incomplete canonical response never produces a plan', async () => {
  const args = planArgs(); args.readOverview = async () => overview([]);
  await assert.rejects(buildReminderPlan(args), /응답/);
});
test('delivery is durably reserved once; uncertainty cannot resend or mutate financial records', async () => {
  const args = planArgs(); const plan = await buildReminderPlan(args); let sends = 0;
  const deliver = () => deliverReminder({ db: args.db, plan, destination: SOURCE_CHANNEL, now: () => cutoff,
    slack: async () => { sends++; throw new Error('timeout after accepted'); } });
  assert.equal((await deliver()).status, 'delivery_unknown'); assert.equal((await deliver()).status, 'already_reserved'); assert.equal(sends, 1);
  assert.ok(args.db.writes.every((path) => path.startsWith('settlement_reminder_deliveries/')));
});
test('default disabled and enabled dry run do not send or write', async () => {
  assert.equal((await createSettlementReminderWorker({ db: null, env: {}, readOverview: null })()).status, 'disabled');
  const db = fakeDb(); let posts = 0;
  const run = createSettlementReminderWorker({ db, env: { SETTLEMENT_REMINDERS_ENABLED: 'true', SLACK_ALERT_BOT_TOKEN: 'test' }, now: () => cutoff,
    readOverview: async ({ body }) => overview(body.projectIds), fetchImpl: async (_url, options) => { if (options.method === 'POST') posts++; return new Response(JSON.stringify({ ok: true, messages: [] })); } });
  assert.equal((await run()).status, 'dry_run'); assert.equal(posts, 0); assert.equal(db.writes.length, 0);
});
test('Slack client uses GET for reads, fixed methods, bounded network timeout and no redirects', async () => {
  const calls = []; const slack = createReminderSlackClient({ token: 'test', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ ok: true, messages: [] })); } });
  await slack('conversations.history', { channel: SOURCE_CHANNEL });
  assert.equal(calls[0].options.method, 'GET'); assert.equal(calls[0].options.redirect, 'error'); assert.equal(calls[0].url.searchParams.get('channel'), SOURCE_CHANNEL);
  await assert.rejects(slack('users.admin', {}), /not_configured/);
});

test('effective-dated obligation registry covers future weeks without weekly edits', () => {
  const dated = { ...policy, yearMonth: undefined, weekNo: undefined, effectiveFrom: '2026-10-01', effectiveThrough: '2026-12-31' };
  assert.equal(resolveObligations(registered, dated, window).length, 1);
  const later = reminderWindow(Date.parse('2026-10-29T15:00:00Z'));
  assert.equal(resolveObligations(registered, dated, later).length, 1);
  assert.throws(() => resolveObligations(registered, { ...dated, effectiveThrough: '2026-10-30' }, later), /unverified/);
});

test('pre-deadline preview is clearly labelled and cannot be delivered', async () => {
  const { previewReminderWindow } = await import('./settlement-reminders.mjs');
  const asOf = Date.parse('2026-10-01T05:00:00Z');
  const preview = previewReminderWindow({ yearMonth: '2026-10', weekNo: 1, asOf });
  assert.equal(preview.latest, String(asOf / 1000));
  const args = planArgs(); args.db = fakeDb(registered, { ...policy, reviewedAt: '2026-10-01T04:00:00Z' }); args.window = preview; args.now = () => asOf;
  const plan = await buildReminderPlan(args);
  assert.match(plan.text, /마감 전 미리보기/);
  assert.match(plan.text, /한국시간/);
  await assert.rejects(deliverReminder({ db: args.db, plan, destination: SOURCE_CHANNEL, now: () => asOf }), /not_ready/);
  assert.equal(args.db.writes.length, 0);
});

test('crossed-month Slack completion labels cannot override canonical waiting state', async () => {
  const args = planArgs();
  args.slack = async () => ({ ok: true, messages: [
    { ts: `${Number(window.oldest) + 100}.000001`, text: '2026년 10월 1주차 사업 하나 주정산 완료' },
    { ts: `${Number(window.oldest) + 101}.000001`, text: '2026년 09월 5주차 사업 하나 주정산 완료' },
  ] });
  const result = await buildReminderPlan(args);
  assert.equal(result.complete, false); assert.deepEqual(result.conflicts, ['p1']); assert.equal(result.text, null);
});

test('Slack retention-limited history and malformed cursors cannot certify coverage', async () => {
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], is_limited: true }), window), /incomplete/);
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], response_metadata: { next_cursor: 123 } }), window), /incomplete/);
});

test('Firebase pages and canonical batches preserve all 101 project identities', async () => {
  const projects = Array.from({ length: 101 }, (_, index) => ({ ...registered[0], projectId: `p${String(index).padStart(3, '0')}`, name: `사업 ${index}` }));
  const obligations = { ...policy, projects: projects.map(({ projectId }) => ({ projectId, obligation: 'required', reason: 'confirmed' })) };
  const args = planArgs(); args.db = fakeDb(projects, obligations); const sizes = [];
  args.readOverview = async ({ body }) => { sizes.push(body.projectIds.length); return overview(body.projectIds); };
  const plan = await buildReminderPlan(args); assert.deepEqual(sizes, [100, 1]); assert.equal(plan.rows.length, 101); assert.equal(plan.complete, true);
});

test('receipt keeps durable policy and canonical evidence tied to the source revision', async () => {
  const args = planArgs(); args.sourceRevision = 'a'.repeat(40);
  const plan = await buildReminderPlan(args);
  assert.equal(plan.provenance.sourceRevision, args.sourceRevision);
  assert.deepEqual(plan.provenance.policySnapshot, policy);
  assert.equal(plan.provenance.canonicalSnapshots[0].state, 'WAITING_FOR_UPDATE');
  for (const field of ['policyHash', 'inventoryHash', 'slackHash', 'canonicalHash']) assert.match(plan.provenance[field], /^[a-f0-9]{64}$/);
  const result = await deliverReminder({ db: args.db, plan, destination: SOURCE_CHANNEL, now: () => cutoff,
    slack: async () => ({ ok: true, channel: SOURCE_CHANNEL, ts: '1790866800.000001' }) });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual([...args.db.store.values()][0].provenance, plan.provenance);
});
