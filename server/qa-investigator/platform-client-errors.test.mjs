import test from 'node:test';
import assert from 'node:assert/strict';
import { createInvestigationTools } from './tools.mjs';

const actor = 'business-actor';
const start = '2026-10-12T00:00:00.000Z';
const end = '2026-10-13T00:00:00.000Z';
const policy = {
  cloudProject: 'inner-platform-live-20260316', tenant: 'mysc',
  scopeKind: 'platform', allowedProjectIds: [], trustedActorId: actor,
  allowedStartAt: start, allowedEndAt: end,
  services: [{ name: 'innerplatform-jvm-weekly-api-live', region: 'us-central1' }],
};
const encoded = (value) => typeof value === 'string' ? { stringValue: value }
  : typeof value === 'number' ? { integerValue: String(value) }
    : { mapValue: { fields: Object.fromEntries(Object.entries(value)
      .map(([key, item]) => [key, encoded(item)])) } };
const row = (uid, requestUrl, extra = {}) => ({ document: { fields: Object.fromEntries(
  Object.entries({ actorId: uid, createdAt: start, eventType: 'exception',
    extra: { requestUrl, status: 403, errorCode: 'permission_denied', ...extra } })
    .map(([key, value]) => [key, encoded(value)])) } });
function fixture(rows = []) {
  const requests = [];
  let active = true;
  const auth = { async getClient() { return { async request(options) {
    requests.push(options);
    if (options.method === 'POST') return { data: rows };
    if (options.url.includes(`/members/${actor}?`)) {
      return { data: { fields: { status: { stringValue: active ? 'ACTIVE' : 'INACTIVE' } } } };
    }
    throw Error('Unexpected business document read');
  } }; } };
  const tools = createInvestigationTools({ auth, policy, allowDynamicScope: true });
  return { tools, requests, setActive: (value) => { active = value; } };
}

test('zero-project platform authority requires dynamic mode and a trusted actor', () => {
  for (const options of [
    { allowDynamicScope: false, policy },
    { allowDynamicScope: true, policy: { ...policy, trustedActorId: undefined } },
    { allowDynamicScope: true, policy: { ...policy, trustedActorId: 'actor/other' } },
    { allowDynamicScope: true, policy: { ...policy, scopeKind: 'project' } },
    { allowDynamicScope: true, policy: { ...policy, allowedEndAt: '2026-10-14T00:00:00.000Z' } },
  ]) assert.throws(() => createInvestigationTools({ auth: {}, ...options }),
    /Invalid trusted investigation policy/);
  assert.deepEqual(Object.keys(fixture().tools), ['query_client_errors']);
});

test('platform query filters authoritative actor before its 101-row limit and drops foreign rows', async () => {
  const f = fixture([
    row('foreign-actor', '/api/v1/projects'),
    row(actor, 'https://myscube.myscguard.app/api/v1/projects?cursor=secret'),
    row(actor, '/api/v1/persons/me/hr-profile?token=secret'),
    row(actor, '/api/v1/cashflow/p1779092105308/month-close?token=secret'),
    row(actor, '/api/v1/projects/p1779092105308/latest-request'),
  ]);
  const result = await f.tools.query_client_errors.execute({ start_at: start, end_at: end });
  const query = f.requests.find((item) => item.method === 'POST').data.structuredQuery;
  const actorFilter = query.where.compositeFilter.filters.find((filter) =>
    filter.fieldFilter.field.fieldPath === 'actorId').fieldFilter;
  assert.deepEqual(actorFilter, { field: { fieldPath: 'actorId' }, op: 'EQUAL',
    value: { stringValue: actor } });
  assert.equal(query.limit, 101);
  assert.equal(result.rows.length, 4);
  assert.deepEqual(result.rows.map((item) => item.request_path),
    ['/api/v1/projects', '/api/v1/persons/me/hr-profile', '/api/v1/cashflow/p1779092105308/month-close', '/api/v1/projects/p1779092105308/latest-request']);
  assert.ok(result.rows.every((item) => item.actor_mask === result.rows[0].actor_mask));
  assert.ok(result.rows.every((item) => item.project_id === null));
  assert.ok(result.rows.every((item) => item.correlation === 'actor_only_candidate'));
  assert.equal(result.coverage.request_metadata_authority, 'client_reported');
  assert.equal(JSON.stringify(result).includes('secret'), false);
});

test('platform query rejects caller project and out-of-window access before business reads', async () => {
  const f = fixture();
  for (const input of [
    { start_at: start, end_at: end, project_id: 'p1779092105308' },
    { start_at: '2026-10-11T00:00:00.000Z', end_at: end },
    { start_at: start, end_at: '2026-10-14T00:00:00.000Z' },
  ]) {
    const result = await f.tools.query_client_errors.execute(input);
    assert.equal(result.error_code, 'invalid_scope');
  }
  assert.equal(f.requests.length, 0);
});

test('inactive actor and actor revocation during query deny platform evidence', async () => {
  const f = fixture();
  f.setActive(false);
  const inactive = await f.tools.query_client_errors.execute({ start_at: start, end_at: end });
  assert.equal(inactive.error_code, 'no_verified_actor_scope');
  assert.equal(f.requests.filter((item) => item.method === 'POST').length, 0);

  let reads = 0;
  const auth = { async getClient() { return { async request(options) {
    if (options.method === 'POST') return { data: [row(actor, '/api/v1/projects')] };
    reads++;
    return { data: { fields: { status: { stringValue: reads === 1 ? 'ACTIVE' : 'INACTIVE' } } } };
  } }; } };
  const tools = createInvestigationTools({ auth, policy, allowDynamicScope: true });
  const revoked = await tools.query_client_errors.execute({ start_at: start, end_at: end });
  assert.equal(revoked.error_code, 'actor_scope_changed');
  assert.deepEqual(revoked.rows, []);
});

test('cashflow batch failures retain the fixed path without granting any project scope', async () => {
  const id = 'req_1791874000000_123456789abc';
  const f = fixture([row(actor, '/api/v1/cashflow/weekly-overview?secret=omit', {responseRequestId:id,projectId:'p1779092105308'})]);
  const result = await f.tools.query_client_errors.execute({start_at:start,end_at:end});
  assert.equal(result.rows[0].request_path, '/api/v1/cashflow/weekly-overview');
  assert.equal(result.rows[0].reported_response_request_id,id);
  assert.equal(result.rows[0].project_id,null);
  assert.equal(result.coverage.request_metadata_authority,'client_reported');
});

function pagedFixture(count=205){
 const prefix='projects/inner-platform-live-20260316/databases/(default)/documents/orgs/mysc/client_error_events/';
 const entries=Array.from({length:count},(_,i)=>{const e=row(actor,'/api/v1/projects');e.document.name=prefix+'e'+String(i).padStart(4,'0');return e;});
 const requests=[];let active=true;
 const auth={getClient:async()=>({request:async options=>{
  if(options.method!=='POST')return {data:{fields:{status:{stringValue:active?'ACTIVE':'INACTIVE'}}}};
  const q=options.data.structuredQuery;requests.push(q);
  assert.deepEqual(q.orderBy.map(x=>x.field.fieldPath),['createdAt','__name__']);
  const after=q.startAt?.values?.[1]?.referenceValue;
  if(after)assert.equal(q.startAt.before,false);
  return {data:entries.filter(e=>!after||e.document.name>after).slice(0,q.limit)};
 }})};
 return {tools:createInvestigationTools({auth,policy,allowDynamicScope:true}),requests,entries,setActive:v=>active=v};
}
test('equal-timestamp records continue after the raw 100th document without overlap',async()=>{
 const f=pagedFixture();let cursor,seen=0;const lengths=[];
 do{
  const result=await f.tools.query_client_errors.execute({start_at:start,end_at:end,...(cursor?{cursor}:{})});
  assert.equal(result.status,'available');lengths.push(result.rows.length);seen+=result.rows.length;
  cursor=result.next_cursor;assert.equal(result.coverage.snapshot_consistent,false);
 }while(cursor);
 assert.equal(seen,205);assert.deepEqual(lengths,[100,100,5]);
 assert.ok(f.requests[1].startAt.values[1].referenceValue.endsWith('/e0099'));
 assert.ok(f.requests[2].startAt.values[1].referenceValue.endsWith('/e0199'));
});
test('cursor retains continuation for a filtered-empty page and rejects changed scope or collection',async()=>{
 const f=pagedFixture(101);for(const e of f.entries.slice(0,100))e.document.fields.actorId={stringValue:'foreign'};
 const first=await f.tools.query_client_errors.execute({start_at:start,end_at:end});assert.equal(first.rows.length,0);assert.ok(first.next_cursor);
 const next=await f.tools.query_client_errors.execute({start_at:start,end_at:end,cursor:first.next_cursor});assert.equal(next.rows.length,1);assert.equal(next.next_cursor,null);
 const position=JSON.parse(Buffer.from(first.next_cursor,'base64url'));
 for(const changed of [{...position,name:position.name.replace('/client_error_events/','/projects/')},{...position,scope:'wrong'},{...position,created_at:end}]){
  const count=f.requests.length;
  const result=await f.tools.query_client_errors.execute({start_at:start,end_at:end,cursor:Buffer.from(JSON.stringify(changed)).toString('base64url')});
  assert.equal(result.status,'unavailable');assert.equal(f.requests.length,count);
 }
 const changedSpan=await f.tools.query_client_errors.execute({start_at:'2026-10-12T01:00:00.000Z',end_at:end,cursor:first.next_cursor});assert.equal(changedSpan.status,'unavailable');
 f.setActive(false);const denied=await f.tools.query_client_errors.execute({start_at:start,end_at:end,cursor:first.next_cursor});assert.equal(denied.status,'unavailable');
});


test('exactly one full page is exhausted and malformed cursors never query events', async () => {
  const f = pagedFixture(100);
  const page = await f.tools.query_client_errors.execute({start_at:start, end_at:end});
  assert.equal(page.rows.length, 100);
  assert.equal(page.next_cursor, null);
  assert.equal(page.coverage.page_exhausted, true);
  assert.equal(page.coverage.complete, false);
  for (const cursor of ['', 'a'.repeat(4097), 'not+a+cursor', Buffer.from('null').toString('base64url')]) {
    const count = f.requests.length;
    const result = await f.tools.query_client_errors.execute({start_at:start, end_at:end, cursor});
    assert.equal(result.status, 'unavailable');
    assert.equal(f.requests.length, count);
  }
});

test('continuation preserves stored timestamp precision', async () => {
  const f = pagedFixture(101);
  const precise = '2026-10-12T00:00:00.123456789Z';
  for (const entry of f.entries) entry.document.fields.createdAt = {stringValue:precise};
  const page = await f.tools.query_client_errors.execute({start_at:start, end_at:end});
  await f.tools.query_client_errors.execute({start_at:start, end_at:end, cursor:page.next_cursor});
  assert.equal(f.requests[1].startAt.values[0].stringValue, precise);
});
