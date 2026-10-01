import test from 'node:test';
import assert from 'node:assert/strict';
import {
  REMINDER_POLICY, SOURCE_CHANNEL, reminderWindow, resolveObligations,
  readDeadlineSlackHistory, reconcileSlackEvidence, deliverReminder,
} from './settlement-reminders.mjs';

const at = '2026-10-01T15:05:00.000Z';
const window = reminderWindow(Date.parse(at));
const ts = (iso) => `${Date.parse(iso) / 1000}.000001`;
const project = { projectId: 'alpha', name: '알파 사업', cic: 'AXR team' };
const eligible = [{ projectId: 'alpha', name: '알파 사업', organization: 'AXR팀' }];
const policy = { version: 1, policy: REMINDER_POLICY, yearMonth: window.yearMonth, weekNo: window.weekNo,
  reviewedBy: 'reviewer', reviewedAt: '2026-09-30T00:00:00Z',
  projects: [{ projectId: 'alpha', obligation: 'required', reason: 'Explicit weekly obligation' }] };

test('QA: incomplete or merely registered obligation inventory is blocked', () => {
  assert.throws(() => resolveObligations([project], { ...policy, projects: [] }, window), /coverage/);
  assert.throws(() => resolveObligations([project], { ...policy, projects: [{ projectId: 'alpha', reason: 'Registered only' }] }, window), /unknown/);
  assert.deepEqual(resolveObligations([project], policy, window), eligible);
  assert.deepEqual(resolveObligations([project], { ...policy, projects: [{ projectId: 'alpha', obligation: 'exempt', reason: 'Approved exemption' }] }, window), []);
});

test('QA: contradictory normalized org mapping blocks rather than guessing', () => {
  assert.throws(() => resolveObligations([{ ...project, department: 'CIC1' }], policy, window), /mapping_unknown/);
});

test('QA: submission evidence in replies to pre-window roots cannot disappear', async () => {
  const root = { ts: ts('2026-09-28T01:00:00Z'), text: '2026년 10월 1주차 알파 사업', reply_count: 1 };
  const reply = { ts: ts('2026-10-01T01:00:00Z'), thread_ts: root.ts, text: '주정산 완료' };
  const slack = async (method, body) => {
    assert.equal(body.channel, SOURCE_CHANNEL);
    if (method === 'conversations.history') return { ok: true,
      messages: Number(body.oldest || 0) > Number(root.ts) ? [] : [root] };
    if (method === 'conversations.replies') return { ok: true, messages: [root, reply] };
    throw new Error('Unexpected Slack operation');
  };
  const messages = await readDeadlineSlackHistory(slack, window);
  assert.ok(messages.some((message) => message.ts === reply.ts), 'In-window submission reply must be covered even when parent predates window');
});

test('QA: reply completion inherits identity and period, or blocks it as ambiguous', () => {
  const root = { ts: ts('2026-10-01T00:00:00Z'), text: '2026년 10월 1주차 알파 사업', reply_count: 1 };
  const reply = { ts: ts('2026-10-01T01:00:00Z'), thread_ts: root.ts, text: '주정산 완료' };
  const result = reconcileSlackEvidence([root, reply], eligible, window).get('alpha');
  assert.ok(result.submitted.length + result.ambiguous.length > 0, 'Bare thread completion cannot be ignored');
});

test('QA: unassignable completion evidence must not produce false missing-submission certainty', () => {
  const message = { ts: ts('2026-10-01T01:00:00Z'), text: '2026년 10월 1주차 주정산 완료' };
  const result = reconcileSlackEvidence([message], eligible, window).get('alpha');
  assert.ok(result.ambiguous.length > 0, 'Unidentified completion must block a confident reminder');
});

test('QA: test and edited completion evidence never authoritatively resolves submission', () => {
  for (const extra of [{ text: '2026년 10월 1주차 알파 사업 주정산 완료 테스트' },
    { text: '2026년 10월 1주차 알파 사업 주정산 완료', edited: { ts: ts('2026-10-01T01:01:00Z') } }]) {
    const result = reconcileSlackEvidence([{ ts: ts('2026-10-01T01:00:00Z'), ...extra }], eligible, window).get('alpha');
    assert.deepEqual(result.submitted, []);
    assert.equal(result.ambiguous.length, 1);
  }
});

test('QA: repeated pagination cursor and unproven final page fail closed', async () => {
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], has_more: true }), window), /incomplete/);
  await assert.rejects(readDeadlineSlackHistory(async () => ({ ok: true, messages: [], response_metadata: { next_cursor: 'again' } }), window), /cursor_repeated/);
});

test('QA: malformed validation timestamp must be rejected before any delivery reservation', async () => {
  let transactionCalled = false;
  await assert.rejects(deliverReminder({
    db: { doc: () => ({}), runTransaction: async () => { transactionCalled = true; return false; } },
    slack: async () => { throw new Error('Must not send'); },
    plan: { complete: true, rows: eligible, text: 'Reminder', checkedAt: 'not-a-date', window },
    destination: SOURCE_CHANNEL, now: () => Date.parse(at),
  }), /stale_final_validation|invalid/);
  assert.equal(transactionCalled, false);
});

test('QA: known uncertain delivery reservation suppresses all automatic resends', async () => {
  let sent = false;
  const result = await deliverReminder({
    db: { doc: () => ({}), runTransaction: async (callback) => callback({ get: async () => ({ exists: true }), set: () => { throw new Error('Do not overwrite'); } }) },
    slack: async () => { sent = true; throw new Error('Must not send'); },
    plan: { complete: true, rows: eligible, text: 'Reminder', checkedAt: at, window }, destination: SOURCE_CHANNEL, now: () => Date.parse(at),
  });
  assert.equal(result.status, 'already_reserved');
  assert.equal(sent, false);
});

test('QA: month-crossing cutoff belongs to Thursday finance month and does not fabricate WEEK_6', () => {
  assert.equal(reminderWindow(Date.parse('2026-07-30T15:01:00Z')).yearMonth, '2026-07');
  const six = reminderWindow(Date.parse('2026-08-27T15:01:00Z'));
  assert.equal(six.weekNo, 5);
  assert.equal(six.weekStart, '2026-08-24');
  assert.equal(six.weekEnd, '2026-08-31');
  assert.equal(reminderWindow(Date.parse('2026-10-01T14:59:59Z')), null);
  assert.equal(reminderWindow(Date.parse('2026-10-01T21:00:00Z')), null);
});

test('QA: delivery freshness is rechecked after a delayed reservation transaction', async () => {
  let clock = Date.parse(at);
  let sent = false;
  const ref = { update: async () => {} };
  const result = await deliverReminder({
    db: { doc: () => ref, runTransaction: async () => { clock += 61000; return true; } },
    slack: async () => { sent = true; return { ok: true, channel: SOURCE_CHANNEL, ts: '1790867161.000001' }; },
    plan: { complete: true, rows: eligible, text: 'Reminder', checkedAt: at, window }, destination: SOURCE_CHANNEL, now: () => clock,
  }).catch((error) => ({ status: error.message }));
  assert.equal(sent, false, `Stale state was sent after reservation delay; result: ${result.status}`);
});

test('QA: a known in-window latest reply must be present before history is complete', async () => {
  const root = { ts: ts('2026-09-28T01:00:00Z'), text: '2026년 10월 1주차 알파 사업', reply_count: 1,
    latest_reply: ts('2026-10-01T01:00:00Z') };
  await assert.rejects(readDeadlineSlackHistory(async (method) => ({ ok: true,
    messages: method === 'conversations.history' ? [root] : [] }), window), /incomplete|coverage/);
});

test('QA: impossible effective dates cannot certify obligation coverage', () => {
  const invalid = { ...policy, yearMonth: undefined, weekNo: undefined,
    effectiveFrom: '2026-00-00', effectiveThrough: '2099-99-99' };
  assert.throws(() => resolveObligations([project], invalid, window), /unverified|date/);
});

test('QA: provenance limit counts UTF-8 bytes before any Firestore reservation', async () => {
  let transactionCalled = false;
  const provenance = { policySnapshot: { reason: '한'.repeat(350000) } };
  assert.ok(JSON.stringify(provenance).length < 400000);
  assert.ok(Buffer.byteLength(JSON.stringify(provenance), 'utf8') > 1000000);
  await assert.rejects(deliverReminder({
    db: { doc: () => ({}), runTransaction: async () => { transactionCalled = true; return false; } },
    slack: async () => { throw new Error('Must not send'); },
    plan: { complete: true, rows: eligible, text: 'Reminder', checkedAt: at, window, provenance },
    destination: SOURCE_CHANNEL, now: () => Date.parse(at),
  }), /provenance_too_large/);
  assert.equal(transactionCalled, false);
});
