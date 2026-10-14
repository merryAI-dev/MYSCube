import test from 'node:test';
import assert from 'node:assert/strict';
import { createQaAuthorityService, scopeHash } from './service.mjs';

const id = 'p1779092105308';
const caseId = '11111111-1111-4111-8111-111111111111';
const eventId = '22222222-2222-4222-8222-222222222222';
const runId = `qa-${eventId}`;
const base = 'orgs/mysc';
const now = '2026-10-13T00:00:00.000Z';
function fakeDb(docs) {
  let sequence = Promise.resolve();
  return { doc: (path) => ({ path, get: async () => ({ data: () => docs.get(path),
    updateTime: { toDate: () => new Date(now) } }),
    set: async (value) => docs.set(path, value) }),
    runTransaction: (fn) => {
      const job = sequence.then(async () => {
        const writes = [];
        const result = await fn({ get: async (ref) => ({ data: () => docs.get(ref.path),
          updateTime: { toDate: () => new Date(now) } }),
        set: (ref, value) => writes.push([ref.path, value]),
        create: (ref, value) => { assert.equal(docs.has(ref.path), false); writes.push([ref.path, value]); } });
        for (const [path, value] of writes) docs.set(path, value);
        return result;
      });
      sequence = job.catch(() => {});
      return job;
    } };
}
function setup(kind = 'project') {
  const auth = new Map([
    ['qa-actor', { uid: 'qa-actor', email: 'a@mysc.co.kr', emailVerified: true,
      disabled: false, tokensValidAfterTime: '1970-01-01T00:00:00.000Z' }],
    ['business-actor', { uid: 'business-actor', email: 'a@mysc.co.kr', emailVerified: true,
      disabled: false, tokensValidAfterTime: '1970-01-01T00:00:00.000Z' }],
  ]);
  const scope = kind === 'project'
    ? { authority: 'server_binding', tenant_id: 'mysc', scope_kind: 'project',
      project_ids: [id], grant_source_revision: 'source-1' }
    : { authority: 'server_binding', tenant_id: 'mysc', scope_kind: 'platform', project_ids: [] };
  const qa = new Map([
    [`${base}/members/qa-actor`, { uid: 'qa-actor', status: 'ACTIVE' }],
    [`${base}/qa_actor_business_links/qa-actor`, { qa_actor_id: 'qa-actor', business_actor_id: 'business-actor',
      source: 'dual_firebase_tokens', status: 'ACTIVE', email_digest: scopeHash('a@mysc.co.kr'),
      qa_auth_time: 1791849600, business_auth_time: 1791849600 }],
    [`${base}/qa_cases/${caseId}`, { case_id: caseId, workspace_id: 'mysc', actor_id: 'qa-actor',
      case_status: 'awaiting_connection', aggregate_version: 1, investigation_scope: scope }],
    [`${base}/qa_dispatches/${eventId}`, { case_id: caseId, run_id: runId, workspace_id: 'mysc' }],
    [`${base}/qa_runs/${runId}`, { case_id: caseId, run_id: runId, case_aggregate_version:1, case_actor_id:'qa-actor' }],
    [`${base}/qa_project_grants/qa-actor_${id}`, { status: 'ACTIVE', actor_id: 'qa-actor', project_id: id,
      source_system: 'myscube_business_acl', source_revision: 'source-1', revoked_at: null }],
  ]);
  const business = new Map([
    [`${base}/members/business-actor`, { uid: 'business-actor', status: 'ACTIVE', role: 'pm', projectIds: [id] }],
    [`${base}/projects/${id}`, { id }],
  ]);
  const qaDb = fakeDb(qa), businessDb = fakeDb(business);
  return { qa, business, auth, scope, qaDb, businessDb,
    service: createQaAuthorityService({ qaDb,
    businessDb, getQaUser: async (uid) => auth.get(uid),
    getBusinessUser: async (uid) => auth.get(uid), now: () => new Date(now) }) };
}
test('dual verified user tokens link distinct UIDs and provision own project only', async () => {
  const { qa, service } = setup();
  qa.delete(`${base}/qa_actor_business_links/qa-actor`);
  const result = await service.linkOwnIdentity({ qaToken: { uid: 'qa-actor', email: 'A@MYSC.CO.KR', email_verified: true, auth_time: 1791849600 },
    businessToken: { uid: 'business-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 }, projectId: id });
  assert.equal(result.linked, true);
  assert.equal(qa.get(`${base}/qa_actor_business_links/qa-actor`).business_actor_id, 'business-actor');
  assert.equal(qa.get(`${base}/qa_project_grants/qa-actor_${id}`).source_system, 'myscube_business_acl');
});
test('first-time linked user gets only a QA MEMBER record and audit event', async () => {
  const { qa, service } = setup();
  qa.delete(`${base}/members/qa-actor`);
  qa.delete(`${base}/qa_actor_business_links/qa-actor`);
  await service.linkOwnIdentity({ qaToken: { uid: 'qa-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 },
    businessToken: { uid: 'business-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 } });
  const member = qa.get(`${base}/members/qa-actor`);
  assert.equal(member.status, 'ACTIVE');
  assert.equal(member.role, 'MEMBER');
  assert.equal(member.business_actor_id, 'business-actor');
  assert.equal([...qa.keys()].filter((path) => path.startsWith(`${base}/qa_membership_events/`)).length, 1);
});
test('existing inactive QA member cannot be reactivated by linking', async () => {
  const { qa, service } = setup();
  qa.get(`${base}/members/qa-actor`).status = 'REVOKED';
  await assert.rejects(service.linkOwnIdentity({ qaToken: { uid: 'qa-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 },
    businessToken: { uid: 'business-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 } }), /qa_member_inactive/);
  assert.equal(qa.get(`${base}/members/qa-actor`).status, 'REVOKED');
});
test('unverified, mismatched, relinked, or revoked identities are denied', async () => {
  const { qa, business, auth, service } = setup();
  const qaToken = { uid: 'qa-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 };
  await assert.rejects(service.linkOwnIdentity({ qaToken,
    businessToken: { uid: 'business-actor', email: 'b@mysc.co.kr', email_verified: true, auth_time: 1791849600 } }), /qa_identity_link_denied/);
  auth.set('other', { uid: 'other', email: 'a@mysc.co.kr', emailVerified: true,
    disabled: false, tokensValidAfterTime: '1970-01-01T00:00:00.000Z' });
  business.set(`${base}/members/other`, { uid: 'other', status: 'ACTIVE', role: 'pm' });
  await assert.rejects(service.linkOwnIdentity({ qaToken,
    businessToken: { uid: 'other', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 } }), /qa_identity_link_conflict/);
  qa.get(`${base}/qa_actor_business_links/qa-actor`).status = 'REVOKED';
  await assert.rejects(service.linkOwnIdentity({ qaToken,
    businessToken: { uid: 'business-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 } }), /qa_identity_link_conflict/);
});
test('run authorization denies business ACL change without QA grant refresh', async () => {
  const { business, service, scope } = setup();
  const request = { case_id: caseId, run_id: runId, phase: 'run' };
  const first = await service.authorizeCase(request);
  assert.equal(first.scope_hash, scopeHash(scope));
  assert.equal(first.qa_actor_id, 'qa-actor');
  assert.equal(first.business_actor_id, 'business-actor');
  business.get(`${base}/members/business-actor`).projectIds = [];
  await assert.rejects(service.authorizeCase(request), /qa_business_project_denied/);
});
test('platform case requires live business member and has no project authority', async () => {
  const { business, service, scope } = setup('platform');
  assert.equal((await service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'intake' })).scope_hash, scopeHash(scope));
  business.get(`${base}/members/business-actor`).status = 'INACTIVE';
  await assert.rejects(service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'intake' }), /qa_business_member_inactive/);
});
test('missing run is allowed only before lease; revoking QA grant stops scoped run', async () => {
  const { qa, service } = setup();
  qa.delete(`${base}/qa_runs/${runId}`);
  await service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'intake' });
  await assert.rejects(service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'run' }), /qa_case_binding_invalid/);
  qa.get(`${base}/qa_project_grants/qa-actor_${id}`).status = 'REVOKED';
  await assert.rejects(service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'intake' }), /qa_project_grant_revoked/);
});
test('disabled or revoked Auth account blocks the next tool check', async () => {
  const { auth, service } = setup();
  const request = { case_id: caseId, run_id: runId, phase: 'run' };
  await service.authorizeCase(request);
  auth.get('business-actor').disabled = true;
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
  auth.get('business-actor').disabled = false;
  auth.get('business-actor').tokensValidAfterTime = '2026-10-13T00:00:01.000Z';
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
  auth.get('business-actor').tokensValidAfterTime = '1970-01-01T00:00:00.000Z';
  auth.get('qa-actor').disabled = true;
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
});
test('changed verified email and malformed revocation metadata block next tool check', async () => {
  const { auth, service } = setup();
  const request = { case_id: caseId, run_id: runId, phase: 'run' };
  auth.get('business-actor').email = 'other@mysc.co.kr';
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
  auth.get('business-actor').email = 'a@mysc.co.kr';
  auth.get('qa-actor').tokensValidAfterTime = undefined;
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
  auth.get('qa-actor').tokensValidAfterTime = 'not-a-time';
  await assert.rejects(service.authorizeCase(request), /qa_identity_revoked/);
});
test('self-unlink revokes the stored link and the next tool check', async () => {
  const { qa, service } = setup();
  const result = await service.unlinkOwnIdentity({ qaToken: { uid: 'qa-actor',
    email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 } });
  assert.equal(result.unlinked, true);
  assert.equal(qa.get(`${base}/qa_actor_business_links/qa-actor`).status, 'REVOKED');
  await assert.rejects(service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'run' }), /qa_identity_link_required/);
});
test('concurrent unlink wins over an in-flight link refresh', async () => {
  const { qa, businessDb, service } = setup();
  let reached, release;
  const entered = new Promise((resolve) => { reached = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const original = businessDb.runTransaction;
  businessDb.runTransaction = async (...args) => { reached(); await gate; return original(...args); };
  const qaToken = { uid: 'qa-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 };
  const businessToken = { uid: 'business-actor', email: 'a@mysc.co.kr', email_verified: true, auth_time: 1791849600 };
  const refreshing = service.linkOwnIdentity({ qaToken, businessToken, projectId: id });
  await entered;
  await service.unlinkOwnIdentity({ qaToken });
  release();
  await assert.rejects(refreshing, /qa_identity_link_conflict/);
  assert.equal(qa.get(`${base}/qa_actor_business_links/qa-actor`).status, 'REVOKED');
  await assert.rejects(service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'run' }), /qa_identity_link_required/);
});

test('reopen checks current business access while allowing cancelled case binding',async()=>{
 const f=setup();f.qa.get(`${base}/qa_cases/${caseId}`).case_status='cancelled';
 await assert.rejects(f.service.authorizeCase({case_id:caseId,run_id:runId,phase:'intake'}),/qa_case_binding_invalid/);
 assert.equal((await f.service.authorizeCase({case_id:caseId,run_id:runId,phase:'reopen'})).allowed,true);
 f.business.get(`${base}/members/business-actor`).status='INACTIVE';
 await assert.rejects(f.service.authorizeCase({case_id:caseId,run_id:runId,phase:'reopen'}));
});
test('cancelled intake reopens from its exact canonical outbox before dispatch exists', async () => {
  const f = setup('platform');
  const qa = f.qa.get(`${base}/qa_cases/${caseId}`);
  qa.case_status = 'cancelled'; qa.investigation_event_id = eventId;
  f.qa.delete(`${base}/qa_dispatches/${eventId}`);
  const outboxPath = `${base}/qa_kafka_outbox/${eventId}`;
  const outbox = { event_id: eventId, schema_version: 1,
    event_type: 'qa.investigation.requested', workspace_id: 'mysc', case_id: caseId,
    aggregate_type: 'qa_case', aggregate_id: caseId, aggregate_version: 1,
    partition_key: `mysc:${caseId}`, delivery_status: 'intent_saved' };
  f.qa.set(outboxPath, outbox);
  assert.equal((await f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'reopen' })).allowed, true);
  for (const field of ['event_id', 'schema_version', 'event_type', 'workspace_id', 'case_id',
    'aggregate_type', 'aggregate_id', 'aggregate_version', 'partition_key']) {
    const original = outbox[field]; outbox[field] = field === 'aggregate_version' ? 2 : 'wrong';
    await assert.rejects(f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'reopen' }),
      /qa_case_binding_invalid/);
    outbox[field] = original;
  }
  await assert.rejects(f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'intake' }),
    /qa_case_binding_invalid/);
  await assert.rejects(f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'run' }),
    /qa_case_binding_invalid/);
  f.business.get(`${base}/members/business-actor`).status = 'INACTIVE';
  await assert.rejects(f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'reopen' }),
    /qa_business_member_inactive/);
});
test('pre-dispatch reopen does not fall back from a mismatched existing dispatch', async () => {
  const f = setup('platform');
  const qa = f.qa.get(`${base}/qa_cases/${caseId}`);
  qa.case_status = 'cancelled'; qa.investigation_event_id = eventId;
  f.qa.set(`${base}/qa_kafka_outbox/${eventId}`, { event_id: eventId, schema_version: 1,
    event_type: 'qa.investigation.requested', workspace_id: 'mysc', case_id: caseId,
    aggregate_type: 'qa_case', aggregate_id: caseId, aggregate_version: 1,
    partition_key: `mysc:${caseId}` });
  f.qa.get(`${base}/qa_dispatches/${eventId}`).case_id = 'other';
  await assert.rejects(f.service.authorizeCase({ case_id: caseId, run_id: runId, phase: 'reopen' }),
    /qa_case_binding_invalid/);
});
test('old dispatch cannot authorize a newer input generation',async()=>{
 const f=setup();const qa=f.qa.get(`${base}/qa_cases/${caseId}`);qa.aggregate_version=2;qa.investigation_event_id='33333333-3333-4333-8333-333333333333';
 await assert.rejects(f.service.authorizeCase({case_id:caseId,run_id:runId,phase:'intake'}),/qa_case_binding_invalid/);
});

test('member authorization verifies both live users and business membership without a case grant', async () => {
  const f = setup();
  f.qa.delete(`${base}/qa_cases/${caseId}`);
  const result = await f.service.authorizeMember({ qa_actor_id: 'qa-actor' });
  assert.equal(result.allowed, true);
  assert.equal(result.qa_actor_id, 'qa-actor');
  assert.equal(result.business_actor_id, 'business-actor');
  assert.equal(result.link_hash, scopeHash(f.qa.get(`${base}/qa_actor_business_links/qa-actor`)));
  assert.equal(result.checked_at, now);
  assert.ok(!JSON.stringify(result).includes('a@mysc.co.kr'));
});
for (const mutation of ['qa_disabled', 'business_disabled', 'business_revoked', 'business_inactive', 'link_revoked', 'qa_inactive']) {
  test(`member authorization denies ${mutation}`, async () => {
    const f = setup();
    if (mutation === 'qa_disabled') f.auth.get('qa-actor').disabled = true;
    if (mutation === 'business_disabled') f.auth.get('business-actor').disabled = true;
    if (mutation === 'business_revoked') f.auth.get('business-actor').tokensValidAfterTime = '2026-10-14T00:00:00Z';
    if (mutation === 'business_inactive') f.business.get(`${base}/members/business-actor`).status = 'INACTIVE';
    if (mutation === 'link_revoked') f.qa.get(`${base}/qa_actor_business_links/qa-actor`).status = 'REVOKED';
    if (mutation === 'qa_inactive') f.qa.get(`${base}/members/qa-actor`).status = 'INACTIVE';
    await assert.rejects(f.service.authorizeMember({ qa_actor_id: 'qa-actor' }), { statusCode: 403 });
  });
}
test('member authorization rejects link replacement during live account lookup', async () => {
  const f = setup();
  const service = createQaAuthorityService({ qaDb: f.qaDb, businessDb: f.businessDb,
    getQaUser: async uid => f.auth.get(uid),
    getBusinessUser: async uid => {
      const link = f.qa.get(`${base}/qa_actor_business_links/qa-actor`);
      f.qa.set(`${base}/qa_actor_business_links/qa-actor`, { ...link, source_checked_at: 'changed' });
      return f.auth.get(uid);
    }, now: () => new Date(now) });
  await assert.rejects(service.authorizeMember({ qa_actor_id: 'qa-actor' }), /qa_identity_revoked/);
});

test('platform investigation can authorize an existing permitted project without changing scope or grants',async()=>{
 const f=setup('platform');f.qa.get(`${base}/qa_runs/${runId}`).status='running';
 const before=structuredClone([...f.qa]);
 const result=await f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id});
 assert.equal(result.project_id,id);assert.equal(result.purpose,'investigation_read');
 assert.equal(result.scope_hash,scopeHash(f.scope));assert.equal(result.aggregate_version,1);
 assert.equal(result.event_id,eventId);assert.deepEqual([...f.qa],before);
 f.business.get(`${base}/members/business-actor`).projectIds=[];
 await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}),/qa_business_project_denied/);
});
test('project read authorization denies missing, foreign and inactive-run sources',async()=>{
 for(const mode of ['missing','foreign','failed','cancelled','revoked']){
  const f=setup('platform');f.qa.get(`${base}/qa_runs/${runId}`).status='running';
  if(mode==='missing')f.business.delete(`${base}/projects/${id}`);
  if(mode==='foreign')f.business.get(`${base}/members/business-actor`).projectIds=[];
  if(mode==='failed')f.qa.get(`${base}/qa_runs/${runId}`).status='failed';
  if(mode==='cancelled')f.qa.get(`${base}/qa_cases/${caseId}`).case_status='cancelled';
  if(mode==='revoked')f.qa.get(`${base}/qa_actor_business_links/qa-actor`).status='REVOKED';
  const before=structuredClone([...f.qa]);
  await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}));
  assert.deepEqual([...f.qa],before);
 }
});
test('case cancellation, reintake or link revocation during project ACL read invalidates receipt',async()=>{
 for(const mutate of [f=>f.qa.get(`${base}/qa_cases/${caseId}`).case_status='cancelled',f=>f.qa.get(`${base}/qa_cases/${caseId}`).aggregate_version++,f=>f.qa.get(`${base}/qa_actor_business_links/qa-actor`).status='REVOKED']){
  const f=setup('platform');f.qa.get(`${base}/qa_runs/${runId}`).status='running';
  const original=f.businessDb.runTransaction;let count=0;
  f.businessDb.runTransaction=async(...args)=>{const result=await original(...args);if(++count===2)mutate(f);return result;};
  await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}));
 }
});
test('project-scoped case retains grant restrictions for dynamic project reads',async()=>{
 const f=setup();f.qa.get(`${base}/qa_runs/${runId}`).status='running';
 f.qa.get(`${base}/qa_project_grants/qa-actor_${id}`).status='REVOKED';
 await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}),/qa_project_grant_revoked/);
});

test('business project ACL revoked during authorization prevents project receipt',async()=>{
 const f=setup('platform');f.qa.get(`${base}/qa_runs/${runId}`).status='running';
 const original=f.businessDb.runTransaction;let count=0;
 f.businessDb.runTransaction=async(...args)=>{const result=await original(...args);if(++count===2)f.business.get(`${base}/members/business-actor`).projectIds=[];return result;};
 await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}),/qa_business_project_denied/);
});

test('initial stale or missing run generation and reporter binding never authorize project reads',async()=>{
 for(const change of [{case_aggregate_version:0},{case_aggregate_version:undefined},{case_actor_id:'other'}]){
  const f=setup('platform');Object.assign(f.qa.get(`${base}/qa_runs/${runId}`),{status:'running',...change});
  await assert.rejects(f.service.authorizeCaseProject({case_id:caseId,run_id:runId,project_id:id}),/qa_case_binding_invalid/);
 }
});
