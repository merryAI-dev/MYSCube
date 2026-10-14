import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaCaseLifecycleService } from './qa-case-lifecycle.mjs';

const caseId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const base = 'orgs/mysc';
const context = (actorId) => ({ tenantId: 'mysc', actorId, authSource: 'firebase' });
const input = (action, expected_version, rest = {}) => ({ action, expected_version, reason: '검증된 변경', ...rest });
function fixture() {
  const rows = new Map([
    [`${base}/members/owner`, { status: 'ACTIVE', role: 'MEMBER' }],
    [`${base}/members/operator`, { status: 'ACTIVE', role: 'QA_OPERATOR' }],
    [`${base}/members/assignee`, { status: 'ACTIVE', role: 'MEMBER' }],
    ...['owner', 'operator', 'assignee'].map((actor) => [`${base}/qa_actor_business_links/${actor}`,
      { status: 'ACTIVE', qa_actor_id: actor, business_actor_id: `biz-${actor}`, source: 'dual_firebase_tokens' }]),
    [`${base}/qa_cases/${caseId}`, { case_id: caseId, workspace_id: 'mysc', actor_id: 'owner',
      case_status: 'received', execution_status: 'queued', aggregate_version: 1,
      investigation_event_id: eventId, title: '로그인 문제', description: '로그인이 실패합니다.',
      investigation_scope: { authority: 'server_binding', tenant_id: 'mysc', scope_kind: 'platform', project_ids: [] } }],
  ]);
  let inTransaction = false;
  const db = { doc: (path) => ({ path }), runTransaction: async (fn) => {
    const writes = [];
    inTransaction = true;
    try {
      const value = await fn({ get: async (ref) => ({ data: () => structuredClone(rows.get(ref.path)) }),
        update: (ref, patch) => writes.push(['update', ref.path, patch]),
        create: (ref, row) => writes.push(['create', ref.path, row]) });
      for (const [kind, path, row] of writes) {
        if (kind === 'create') assert.equal(rows.has(path), false);
        rows.set(path, kind === 'update' ? { ...rows.get(path), ...structuredClone(row) } : structuredClone(row));
      }
      return value;
    } finally { inTransaction = false; }
  } };
  let calls = 0;
  const service = createQaCaseLifecycleService({ db, now: () => new Date('2026-10-13T00:00:00Z'),
    authorizeReopen: async () => { assert.equal(inTransaction, false); return { businessActorId: 'biz-owner' }; },
    authorizeCase: async () => { assert.equal(inTransaction, false); calls++; return { businessActorId: 'biz-owner' }; } });
  return { rows, service, db, get calls() { return calls; } };
}
test('operator triage and proposed assignment leave investigation input version intact', async () => {
  const f = fixture();
  const triage = await f.service.transition(context('operator'), caseId,
    input('triage', 0, { severity: 'high', priority: 'urgent',
      observed_behavior: '로그인 실패', expected_outcome: '정상 로그인' }));
  assert.equal(triage.lifecycle_version, 1);
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).aggregate_version, 1);
  await f.service.transition(context('operator'), caseId, input('propose_assignment', 1, { assignee_id: 'assignee' }));
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).assignee_id, undefined);
  await assert.rejects(f.service.transition(context('owner'), caseId, input('accept_assignment', 2)),
    { code: 'qa_lifecycle_assignee_required' });
  await f.service.transition(context('assignee'), caseId, input('accept_assignment', 2));
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).assignee_id, 'assignee');
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).aggregate_version, 1);
  assert.equal([...f.rows.keys()].filter((key) => key.includes('qa_case_lifecycle_events/')).length, 3);
});
test('owner cancellation fences case; reopen creates new input version and durable outbox atomically', async () => {
  const f = fixture();
  await f.service.transition(context('owner'), caseId, input('cancel', 0));
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).case_status, 'cancelled');
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).execution_status, 'cancelled');
  const opened = await f.service.transition(context('owner'), caseId, input('reopen', 1));
  const qa = f.rows.get(`${base}/qa_cases/${caseId}`);
  const outbox = f.rows.get(`${base}/qa_kafka_outbox/${opened.investigation_event_id}`);
  assert.equal(qa.aggregate_version, 2);
  assert.equal(qa.case_status, 'received');
  assert.equal(qa.execution_status, 'queued');
  assert.equal(outbox.aggregate_version, 2);
  assert.equal(outbox.case_id, caseId);
  assert.equal(outbox.delivery_status, 'intent_saved');
  assert.equal(f.rows.get(`${base}/qa_case_lifecycle_events/${caseId}_0000000002`).investigation_event_id,
    opened.investigation_event_id);
});
test('reporter cannot triage, unsupported transitions fail, and CAS prevents stale writes', async () => {
  const f = fixture();
  await assert.rejects(f.service.transition(context('owner'), caseId,
    input('triage', 0, { severity: 'high', priority: 'urgent', observed_behavior: '실패', expected_outcome: '성공' })),
  { code: 'qa_lifecycle_operator_required' });
  await assert.rejects(f.service.transition(context('operator'), caseId, input('deployment_pending', 0)),
    { code: 'qa_lifecycle_transition_invalid' });
  await f.service.transition(context('owner'), caseId, input('cancel', 0));
  await assert.rejects(f.service.transition(context('owner'), caseId, input('reopen', 0)),
    { code: 'qa_lifecycle_version_changed' });
});
test('authority call occurs outside transaction; concurrent link revocation blocks transition', async () => {
  const f = fixture();
  f.rows.set(`${base}/qa_dispatches/${eventId}`, { run_id: `qa-${eventId}`, case_id: caseId });
  const service = createQaCaseLifecycleService({ db: f.db,
    authorizeCase: async () => {
      f.rows.get(`${base}/qa_actor_business_links/owner`).status = 'REVOKED';
      return { businessActorId: 'biz-owner' };
    } });
  await assert.rejects(service.transition(context('operator'), caseId, input('investigating', 0)),
    { code: 'qa_lifecycle_authority_revoked' });
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).case_status, 'received');
});
test('key reordering during authority check is not a lifecycle change, while changed scope is', async () => {
  const f = fixture();
  const dispatchPath = `${base}/qa_dispatches/${eventId}`;
  f.rows.set(dispatchPath, { run_id: `qa-${eventId}`, case_id: caseId });
  const service = createQaCaseLifecycleService({ db: f.db,
    authorizeCase: async () => {
      const qa = f.rows.get(`${base}/qa_cases/${caseId}`);
      qa.investigation_scope = Object.fromEntries(Object.entries(qa.investigation_scope).reverse());
      f.rows.set(dispatchPath, Object.fromEntries(Object.entries(f.rows.get(dispatchPath)).reverse()));
      return { businessActorId: 'biz-owner' };
    } });
  const result = await service.transition(context('operator'), caseId, input('investigating', 0));
  assert.equal(result.case_status, 'investigating');

  const changed = createQaCaseLifecycleService({ db: f.db,
    authorizeCase: async () => {
      f.rows.get(`${base}/qa_cases/${caseId}`).investigation_scope.scope_kind = 'project';
      return { businessActorId: 'biz-owner' };
    } });
  await assert.rejects(changed.transition(context('operator'), caseId, input('fix_in_progress', 1)),
    { code: 'qa_lifecycle_version_changed' });
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).case_status, 'investigating');
});
test('cancelled reopen cannot create an outbox without live authority', async () => {
  const f = fixture();
  await f.service.transition(context('owner'), caseId, input('cancel', 0));
  const service = createQaCaseLifecycleService({ db: f.db });
  await assert.rejects(service.transition(context('owner'), caseId, input('reopen', 1)),
    { code: 'qa_lifecycle_authority_unavailable' });
  assert.equal([...f.rows.keys()].filter((key) => key.includes('qa_kafka_outbox/')).length, 0);
});
test('current owner can read bounded lifecycle history but another member cannot', async () => {
  const f = fixture();
  await f.service.transition(context('operator'), caseId,
    input('triage', 0, { severity: 'high', priority: 'urgent',
      observed_behavior: '실패', expected_outcome: '성공' }));
  const view = await f.service.read(context('owner'), caseId);
  assert.equal(view.events.length, 1);
  assert.equal(view.events[0].action, 'triage');
  await assert.rejects(f.service.read(context('assignee'), caseId),
    { code: 'qa_lifecycle_owner_required' });
});
test('current QA owner can cancel a queued case after business link revocation', async () => {
  const f = fixture();
  f.rows.get(`${base}/qa_actor_business_links/owner`).status = 'REVOKED';
  const result = await f.service.transition(context('owner'), caseId, input('cancel', 0));
  assert.equal(result.case_status, 'cancelled');
  assert.equal(f.rows.get(`${base}/qa_cases/${caseId}`).execution_status, 'cancelled');
});

test('assignment proposal rejects missing, inactive or unlinked recipients without any write', async () => {
  for (const revoke of [
    f => f.rows.delete(`${base}/members/assignee`),
    f => { f.rows.get(`${base}/members/assignee`).status = 'INACTIVE'; },
    f => f.rows.delete(`${base}/qa_actor_business_links/assignee`),
    f => { f.rows.get(`${base}/qa_actor_business_links/assignee`).status = 'REVOKED'; },
    f => { f.rows.get(`${base}/qa_actor_business_links/assignee`).qa_actor_id = 'someone-else'; },
    f => { f.rows.get(`${base}/qa_actor_business_links/assignee`).source = 'client_claim'; },
    f => { f.rows.get(`${base}/qa_actor_business_links/assignee`).business_actor_id = ''; },
  ]) {
    const f = fixture(); revoke(f);
    const before = structuredClone([...f.rows]);
    await assert.rejects(f.service.transition(context('operator'), caseId,
      input('propose_assignment', 0, { assignee_id: 'assignee' })),
    { code: 'qa_lifecycle_assignee_unavailable' });
    assert.deepEqual([...f.rows], before);
  }
});

test('recipient revocation during the authority call prevents proposal and audit creation', async () => {
  for (const kind of ['members', 'qa_actor_business_links']) {
    const f = fixture();
    f.rows.set(`${base}/qa_dispatches/${eventId}`, { run_id: `qa-${eventId}`, case_id: caseId });
    const originalCase = structuredClone(f.rows.get(`${base}/qa_cases/${caseId}`));
    const service = createQaCaseLifecycleService({ db: f.db, authorizeCase: async () => {
      f.rows.get(`${base}/${kind}/assignee`).status = 'REVOKED';
      return { businessActorId: 'biz-owner' };
    } });
    await assert.rejects(service.transition(context('operator'), caseId,
      input('propose_assignment', 0, { assignee_id: 'assignee' })),
    { code: 'qa_lifecycle_assignee_unavailable' });
    assert.deepEqual(f.rows.get(`${base}/qa_cases/${caseId}`), originalCase);
    assert.equal([...f.rows.keys()].filter(key => key.includes('qa_case_lifecycle_events/')).length, 0);
  }
});

test('assignment acceptance does not grant access to private lifecycle history', async () => {
  const f = fixture();
  await f.service.transition(context('operator'), caseId, input('propose_assignment', 0, { assignee_id: 'assignee' }));
  await assert.rejects(f.service.read(context('assignee'), caseId), { code: 'qa_lifecycle_owner_required' });
  await f.service.transition(context('assignee'), caseId, input('accept_assignment', 1));
  await assert.rejects(f.service.read(context('assignee'), caseId), { code: 'qa_lifecycle_owner_required' });
});
