import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createQaAuthorityApp } from './app.mjs';
import { scopeHash } from './service.mjs';

const jwt = 'abc.def.ghi';
const audience = 'https://mysc-qa-authority.example.run.app';
const workerEmail = 'qa-investigator@inner-platform-qa-20260310.iam.gserviceaccount.com';
const db = { doc: () => ({ get: async () => ({ data: () => null }) }),
  runTransaction: async (fn) => fn({ get: async () => ({ data: () => null }) }) };
function app(workerPayload) {
  return createQaAuthorityApp({ qaDb: db, businessDb: db,
    verifyQaToken: async () => { throw Error('bad QA token'); },
    verifyBusinessToken: async () => { throw Error('bad business token'); },
    getQaUser: async () => null, getBusinessUser: async () => null,
    verifyWorkerToken: async () => workerPayload,
    workerAudience: audience, workerEmails: [workerEmail] });
}
test('public user route rejects missing dual Firebase proof', async () => {
  const result = await request(app()).post('/user/link').set('authorization', `Bearer ${jwt}`).send({});
  assert.equal(result.status, 401);
});
test('internal route rejects missing or wrong-audience Google identity', async () => {
  const target = app({ iss: 'https://accounts.google.com', aud: 'https://wrong.example',
    email_verified: true, email: workerEmail });
  const missing = await request(target).post('/internal/authorize-case').send({});
  assert.equal(missing.status, 401);
  const wrong = await request(target).post('/internal/authorize-case')
    .set('authorization', `Bearer ${jwt}`).send({});
  assert.equal(wrong.status, 403);
});
test('internal caller cannot choose actor or tenant in request body', async () => {
  const target = app({ iss: 'https://accounts.google.com', aud: audience,
    email_verified: true, email: workerEmail, sub: 'worker-sub' });
  const result = await request(target).post('/internal/authorize-case')
    .set('authorization', `Bearer ${jwt}`).send({ case_id: '11111111-1111-4111-8111-111111111111',
      run_id: 'qa-22222222-2222-4222-8222-222222222222', phase: 'intake', actor_id: 'admin' });
  assert.equal(result.status, 400);
});
test('authenticated self-unlink endpoint revokes only the caller link', async () => {
  let link = { status: 'ACTIVE', qa_actor_id: 'qa-actor', business_actor_id: 'business-actor',
    email_digest: scopeHash('a@mysc.co.kr') };
  const qaDb = { doc: () => ({ get: async () => ({ data: () => link }) }),
    runTransaction: async (fn) => fn({ get: async () => ({ data: () => link }),
      set: (_ref, value) => { link = value; } }) };
  const target = createQaAuthorityApp({ qaDb, businessDb: db,
    verifyQaToken: async () => ({ uid: 'qa-actor', email: 'a@mysc.co.kr', email_verified: true }),
    verifyBusinessToken: async () => { throw Error('not used'); },
    getQaUser: async () => ({ uid: 'qa-actor', email: 'a@mysc.co.kr', emailVerified: true, disabled: false }),
    getBusinessUser: async () => null,
    verifyWorkerToken: async () => null, workerAudience: audience, workerEmails: [workerEmail] });
  const result = await request(target).delete('/user/link').set('authorization', `Bearer ${jwt}`);
  assert.equal(result.status, 200);
  assert.equal(result.body.unlinked, true);
  assert.equal(link.status, 'REVOKED');
});
test('token verifier infrastructure failure is retryable, not a user credential rejection', async () => {
  const target = createQaAuthorityApp({ qaDb:db, businessDb:db,
    verifyQaToken:async()=>{throw Object.assign(Error('private diagnostic'),{code:'auth/insufficient-permission'});},
    verifyBusinessToken:async()=>({}), getQaUser:async()=>null,getBusinessUser:async()=>null,
    verifyWorkerToken:async()=>null,workerAudience:audience,workerEmails:[workerEmail] });
  const result=await request(target).post('/user/link').set('authorization',`Bearer ${jwt}`)
    .set('x-business-authorization',`Bearer ${jwt}`).send({});
  assert.equal(result.status,503);
  assert.equal(result.body.error,'qa_authority_unavailable');
  assert.ok(!JSON.stringify(result.body).includes('private diagnostic'));
});
test('member route accepts only intake IAM identity and strict actor input',async()=>{
 const intake='mysc-qa-intake@inner-platform-qa-20260310.iam.gserviceaccount.com';
 const rows=new Map([
 ['orgs/mysc/members/qa-actor',{status:'ACTIVE'}],
 ['orgs/mysc/qa_actor_business_links/qa-actor',{qa_actor_id:'qa-actor',business_actor_id:'business-actor',source:'dual_firebase_tokens',status:'ACTIVE',email_digest:scopeHash('a@mysc.co.kr'),qa_auth_time:1791849600,business_auth_time:1791849600}],
 ]);
 const qaDb={doc:path=>({path}),runTransaction:async fn=>fn({get:async ref=>({data:()=>rows.get(ref.path)})})};
 const businessDb={doc:path=>({path}),runTransaction:async fn=>fn({get:async()=>({data:()=>({uid:'business-actor',status:'ACTIVE',role:'pm'}),updateTime:{toDate:()=>new Date('2026-10-13T00:00:00Z')}})})};
 const valid={iss:'https://accounts.google.com',aud:audience,email_verified:true,email:intake,sub:'worker-sub'};
 let payload=valid;
 const target=createQaAuthorityApp({qaDb,businessDb,getQaUser:async uid=>({uid,email:'a@mysc.co.kr',emailVerified:true,disabled:false,tokensValidAfterTime:'1970-01-01T00:00:00Z'}),getBusinessUser:async uid=>({uid,email:'a@mysc.co.kr',emailVerified:true,disabled:false,tokensValidAfterTime:'1970-01-01T00:00:00Z'}),verifyWorkerToken:async()=>payload,workerAudience:audience,workerEmails:[workerEmail,intake],memberWorkerEmails:[intake]});
 const send=body=>request(target).post('/internal/authorize-member').set('authorization',`Bearer ${jwt}`).send(body);
 const ok=await send({qa_actor_id:'qa-actor'});assert.equal(ok.status,200);assert.equal(ok.body.allowed,true);assert.equal(ok.body.business_actor_id,'business-actor');assert.equal(ok.body.email,undefined);
 for(const bad of [{...valid,email:workerEmail},{...valid,aud:'wrong'},{...valid,sub:''},{...valid,email_verified:false}]){payload=bad;assert.equal((await send({qa_actor_id:'qa-actor'})).status,403);}
 payload=valid;
 for(const body of [{qa_actor_id:'qa-actor',tenant_id:'mysc'},{qa_actor_id:'../actor'},{}])assert.equal((await send(body)).status,400);
});

test('project authority route denies unlisted workers and caller identity or phase overrides',async()=>{
 const payload={iss:'https://accounts.google.com',aud:audience,email_verified:true,email:workerEmail,sub:'worker-sub'};
 const args={qaDb:db,businessDb:db,getQaUser:async()=>null,getBusinessUser:async()=>null,verifyWorkerToken:async()=>payload,workerAudience:audience,workerEmails:[workerEmail]};
 const body={case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',project_id:'p1779092105308'};
 const send=(target,value)=>request(target).post('/internal/authorize-case-project').set('authorization',`Bearer ${jwt}`).send(value);
 assert.equal((await send(createQaAuthorityApp(args),body)).status,403);
 const target=createQaAuthorityApp({...args,projectWorkerEmails:[workerEmail]});
 for(const extra of [{actor_id:'admin'},{phase:'reopen'},{scope:{project_ids:['*']}},{project_id:'../other'}])assert.equal((await send(target,{...body,...extra})).status,400);
 assert.equal((await send(target,body)).body.error,'qa_case_binding_invalid');
});
