import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createUserEntry } from './user-entry.mjs';

const qaOrigin = 'https://mysc-qa-authority-1084486080400.asia-northeast3.run.app';
const intakeOrigin = 'https://mysc-qa-intake-c3pm5gv7ia-du.a.run.app';
const seconds = Math.floor(Date.now() / 1000);
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const certs = { test: publicKey.export({ type: 'spki', format: 'pem' }) };
const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(project, email = 'member@mysc.co.kr') {
  const header = encode({ alg: 'RS256', kid: 'test' });
  const payload = encode({ aud: project, iss: `https://securetoken.google.com/${project}`,
    sub: 'actor-1', iat: seconds - 10, exp: seconds + 600,
    auth_time: seconds - 60, email, email_verified: true });
  const signed = `${header}.${payload}`;
  return `Bearer ${signed}.${sign('RSA-SHA256', Buffer.from(signed), privateKey).toString('base64url')}`;
}
function setup() {
  const requests = [];
  const auth = { getIdTokenClient: async (audience) => ({ getRequestHeaders: async (url) => {
    assert.equal(url, audience);
    return new Headers({ Authorization: 'Bearer iam-token' });
  } }) };
  const fetcher = async (url, options) => {
    if (url.startsWith('https://www.googleapis.com/robot/'))
      return { ok: true, headers: new Headers({ 'cache-control': 'max-age=300' }), json: async () => certs };
    requests.push({ url, options });
    return { ok: true, json: async () => ({ case_id: '00000000-0000-4000-8000-000000000000', linked: true }) };
  };
  return { entry: createUserEntry({ auth, authorityOrigin: qaOrigin, intakeOrigin, fetcher }), requests };
}
test('dual signed identities and IAP email are required for link', async () => {
  const { entry, requests } = setup();
  const req = { method: 'POST', headers: { authorization: token('inner-platform-qa-20260310'),
    'x-business-authorization': token('inner-platform-live-20260316') } };
  const linked = await entry.handle(req, 'member@mysc.co.kr', '/api/me/link', {});
  assert.equal(linked.linked, true);
  assert.equal(requests[0].url, qaOrigin + '/user/link');
  assert.equal(requests[0].options.headers.Authorization, req.headers.authorization);
  assert.equal(requests[0].options.headers['X-Business-Authorization'], req.headers['x-business-authorization']);
  assert.equal(requests[0].options.headers['X-Serverless-Authorization'], 'Bearer iam-token');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'omit');
  await assert.rejects(entry.handle(req, 'different@mysc.co.kr', '/api/me/link', {}), { safeCode: 'identity_mismatch' });
  await assert.rejects(entry.handle({ ...req, headers: { ...req.headers,
    'x-business-authorization': token('inner-platform-qa-20260310') } },
  'member@mysc.co.kr', '/api/me/link', {}), { safeCode: 'identity_mismatch' });
  assert.equal(requests.length, 1);
});
test('malformed and wrong-project tokens fail before any downstream request', async () => {
  const { entry, requests } = setup();
  const business = token('inner-platform-live-20260316');
  for (const qa of ['Bearer malformed', token('inner-platform-live-20260316'),
    token('inner-platform-qa-20260310', 'someone-else@mysc.co.kr')]) {
    await assert.rejects(entry.handle({ method: 'POST', headers: { authorization: qa,
      'x-business-authorization': business } }, 'member@mysc.co.kr', '/api/me/link', {}));
  }
  assert.equal(requests.length, 0);
});
test('missing IAM bearer fails closed', async () => {
  let calls = 0;
  const entry = createUserEntry({
    authorityOrigin: qaOrigin, intakeOrigin,
    auth: { getIdTokenClient: async () => ({ getRequestHeaders: async () => new Headers() }) },
    fetcher: async (url) => {
      if (url.startsWith('https://www.googleapis.com/robot/'))
        return { ok: true, headers: new Headers(), json: async () => certs };
      calls += 1; throw Error('unexpected downstream');
    },
  });
  await assert.rejects(entry.handle({ method: 'GET', headers: {
    authorization: token('inner-platform-qa-20260310') } },
  'member@mysc.co.kr', '/api/me/cases/00000000-0000-4000-8000-000000000000', null),
  { safeCode: 'qa_service_unavailable' });
  assert.equal(calls, 0);
});
test('own case route forwards genuine QA token and fixed tenant only', async () => {
  const { entry, requests } = setup();
  const req = { method: 'POST', headers: { authorization: token('inner-platform-qa-20260310') } };
  await entry.handle(req, 'member@mysc.co.kr', '/api/me/cases', {
    idempotency_key: '00000000-0000-4000-8000-000000000000', platform_key: 'myscube',
    title: '문제', description: '저장 실패', investigation_target: { kind: 'platform' }, reported_context: {},
  });
  assert.equal(requests[0].url, intakeOrigin + '/api/v1/qa-cases');
  assert.equal(requests[0].options.headers['X-Tenant-Id'], 'mysc');
  assert.equal(requests[0].options.headers['Idempotency-Key'], '00000000-0000-4000-8000-000000000000');
  assert.equal(JSON.parse(requests[0].options.body).actor_id, undefined);
  await assert.rejects(entry.handle({ ...req, method: 'GET' }, 'member@mysc.co.kr',
    '/api/me/cases/not-a-uuid', null), { safeCode: 'not_found' });
});
test('intake owner denial remains a denial through the dashboard proxy', async () => {
  const entry = createUserEntry({
    authorityOrigin: qaOrigin, intakeOrigin,
    auth: { getIdTokenClient: async () => ({ getRequestHeaders: async () => new Headers({ Authorization: 'Bearer iam-token' }) }) },
    fetcher: async (url) => url.startsWith('https://www.googleapis.com/robot/')
      ? { ok: true, headers: new Headers(), json: async () => certs }
      : { ok: false, status: 404, json: async () => ({ error: 'qa_case_not_found' }) },
  });
  await assert.rejects(entry.handle({ method: 'GET', headers: {
    authorization: token('inner-platform-qa-20260310') } }, 'member@mysc.co.kr',
  '/api/me/cases/00000000-0000-4000-8000-000000000000', null),
  { status: 404, safeCode: 'qa_case_not_found' });
});
test('owner list allows only bounded pagination parameters', async () => {
  const { entry, requests } = setup();
  const req = { method: 'GET', headers: { authorization: token('inner-platform-qa-20260310') } };
  const cursor = '00000000-0000-4000-8000-000000000000';
  await entry.handle(req, 'member@mysc.co.kr', '/api/me/cases', null,
    new URLSearchParams({ limit: '50', cursor }));
  assert.equal(requests[0].url, `${intakeOrigin}/api/v1/qa-cases?limit=50&cursor=${cursor}`);
  for (const search of ['limit=51', 'limit=1&limit=2', 'cursor=../../other', 'actor_id=other']) {
    await assert.rejects(entry.handle(req, 'member@mysc.co.kr', '/api/me/cases', null,
      new URLSearchParams(search)), { safeCode: 'invalid_request' });
  }
  assert.equal(requests.length, 1);
});
test('owner result route goes to intake and carries no business token', async () => {
  const { entry, requests } = setup();
  const id = '00000000-0000-4000-8000-000000000000';
  await entry.handle({ method: 'GET', headers: {
    authorization: token('inner-platform-qa-20260310') } },
  'member@mysc.co.kr', `/api/me/cases/${id}/result`, null);
  assert.equal(requests[0].url, `${intakeOrigin}/api/v1/qa-cases/${id}/result`);
  assert.equal(requests[0].options.headers['X-Business-Authorization'], undefined);
  assert.equal(requests[0].options.headers['X-Tenant-Id'], 'mysc');
});
test('owner lifecycle read and cancel forward genuine token and idempotency', async () => {
  const { entry, requests } = setup();
  const id = '00000000-0000-4000-8000-000000000000';
  const req = { method: 'GET', headers: { authorization: token('inner-platform-qa-20260310') } };
  await entry.handle(req, 'member@mysc.co.kr', `/api/me/cases/${id}/lifecycle`, null);
  assert.equal(requests[0].url, `${intakeOrigin}/api/v1/qa-cases/${id}/lifecycle`);
  assert.equal(requests[0].options.headers.Authorization, req.headers.authorization);
  assert.equal(requests[0].options.headers['X-Business-Authorization'], undefined);
  const action = { action: 'cancel', expected_version: 2, reason: '문제가 해결되었습니다.',
    idempotency_key: '10000000-0000-4000-8000-000000000000' };
  await entry.handle({ ...req, method: 'POST' }, 'member@mysc.co.kr', `/api/me/cases/${id}/lifecycle`, action);
  assert.equal(requests[1].options.headers['Idempotency-Key'], action.idempotency_key);
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    action: 'cancel', expected_version: 2, reason: '문제가 해결되었습니다.',
  });
  assert.equal(requests[1].options.redirect, 'error');
  assert.equal(requests[1].options.credentials, 'omit');
});
test('dashboard lifecycle permits only owner cancel or reopen payloads', async () => {
  const { entry, requests } = setup();
  const id = '00000000-0000-4000-8000-000000000000';
  const req = { method: 'POST', headers: { authorization: token('inner-platform-qa-20260310') } };
  const valid = { action: 'reopen', expected_version: 3, reason: '문제가 다시 발생했습니다.',
    idempotency_key: '10000000-0000-4000-8000-000000000000' };
  await entry.handle(req, 'member@mysc.co.kr', `/api/me/cases/${id}/lifecycle`, valid);
  for (const body of [{ ...valid, action: 'triage' }, { ...valid, expected_version: -1 },
    { ...valid, actor_id: 'other' }, { ...valid, reason: '' }]) {
    await assert.rejects(entry.handle(req, 'member@mysc.co.kr', `/api/me/cases/${id}/lifecycle`, body),
      { safeCode: 'invalid_request' });
  }
  assert.equal(requests.length, 1);
});
test('owner lifecycle backend conflicts remain conflicts through dashboard', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  const entry = createUserEntry({
    authorityOrigin: qaOrigin, intakeOrigin,
    auth: { getIdTokenClient: async () => ({ getRequestHeaders: async () => new Headers({ Authorization: 'Bearer iam-token' }) }) },
    fetcher: async (url) => url.startsWith('https://www.googleapis.com/robot/')
      ? { ok: true, headers: new Headers(), json: async () => certs }
      : { ok: false, status: 409, json: async () => ({ error: 'qa_lifecycle_version_changed' }) },
  });
  await assert.rejects(entry.handle({ method: 'GET', headers: {
    authorization: token('inner-platform-qa-20260310') } }, 'member@mysc.co.kr',
  `/api/me/cases/${id}/lifecycle`, null), { status: 409, safeCode: 'qa_lifecycle_version_changed' });
});
test('known lifecycle authority outage stays distinct from generic upstream outage', async () => {
  const id = '00000000-0000-4000-8000-000000000000';
  for (const upstreamCode of ['qa_lifecycle_authority_unavailable', 'sensitive_internal_detail']) {
    const entry = createUserEntry({
      authorityOrigin: qaOrigin, intakeOrigin,
      auth: { getIdTokenClient: async () => ({ getRequestHeaders: async () => new Headers({ Authorization: 'Bearer iam-token' }) }) },
      fetcher: async (url) => url.startsWith('https://www.googleapis.com/robot/')
        ? { ok: true, headers: new Headers(), json: async () => certs }
        : { ok: false, status: 503, json: async () => ({ error: upstreamCode }) },
    });
    await assert.rejects(entry.handle({ method: 'GET', headers: {
      authorization: token('inner-platform-qa-20260310') } }, 'member@mysc.co.kr',
    `/api/me/cases/${id}/lifecycle`, null), { status: 503,
      safeCode: upstreamCode === 'qa_lifecycle_authority_unavailable'
        ? upstreamCode : 'qa_service_unavailable' });
  }
});
test('shared list and owner publication use fixed intake routes and authenticated identity',async()=>{
 const {entry,requests}=setup(), id='00000000-0000-4000-8000-000000000000';
 const req={method:'GET',headers:{authorization:token('inner-platform-qa-20260310')}};
 await entry.handle(req,'member@mysc.co.kr','/api/me/shared-cases',null,new URLSearchParams({limit:'20',cursor:id}));
 assert.equal(requests[0].url,`${intakeOrigin}/api/v1/qa-shared-cases?limit=20&cursor=${id}`);
 await entry.handle(req,'member@mysc.co.kr',`/api/me/cases/${id}/publication`,null);
 const payload={action:'publish',expected_version:0,expected_case_version:1,content:{title:'공유',impact:'영향',next_action:'확인'},idempotency_key:id};
 await entry.handle({...req,method:'POST'},'member@mysc.co.kr',`/api/me/cases/${id}/publication`,payload);
 assert.equal(requests[2].url,`${intakeOrigin}/api/v1/qa-cases/${id}/publication`);
 assert.equal(requests[2].options.headers['Idempotency-Key'],id);
 assert.equal(JSON.parse(requests[2].options.body).idempotency_key,undefined);
 assert.equal(requests[2].options.headers.Authorization,req.headers.authorization);
 await assert.rejects(entry.handle(req,'other@mysc.co.kr','/api/me/shared-cases',null),{safeCode:'identity_mismatch'});
 for(const search of ['actor_id=other','limit=51','limit=1&limit=2'])await assert.rejects(entry.handle(req,'member@mysc.co.kr','/api/me/shared-cases',null,new URLSearchParams(search)),{safeCode:'invalid_request'});
 assert.equal(requests.length,3);
});

test('assignment inbox fixes recipient on server and forwards only cursor and acceptance', async () => {
  const {entry, requests}=setup(), id='00000000-0000-4000-8000-000000000000';
  const req={method:'GET',headers:{authorization:token('inner-platform-qa-20260310')}};
  await entry.handle(req,'member@mysc.co.kr','/api/me/assignment-inbox',null,new URLSearchParams({cursor:id}));
  assert.equal(requests[0].url,`${intakeOrigin}/api/v1/qa-assignment-inbox?cursor=${id}`);
  for(const query of ['actor_id=other','cursor=invalid','cursor='+id+'&cursor='+id])
    await assert.rejects(entry.handle(req,'member@mysc.co.kr','/api/me/assignment-inbox',null,new URLSearchParams(query)),{safeCode:'invalid_request'});
  const body={action:'accept_assignment',expected_version:1,reason:'담당 수락',idempotency_key:id};
  await entry.handle({...req,method:'POST'},'member@mysc.co.kr',`/api/me/cases/${id}/lifecycle`,body);
  assert.equal(JSON.parse(requests[1].options.body).action,'accept_assignment');
  await assert.rejects(entry.handle({...req,method:'POST'},'member@mysc.co.kr',`/api/me/cases/${id}/lifecycle`,{...body,assignee_id:'other'}),{safeCode:'invalid_request'});
  assert.equal(requests.length,2);
});

test('proposal proxy requires exactly target code and lifecycle fields without trusting client role',async()=>{
  const {entry,requests}=setup(),id='00000000-0000-4000-8000-000000000000';
  const req={method:'POST',headers:{authorization:token('inner-platform-qa-20260310')}};
  const body={action:'propose_assignment',assignee_id:'recipient',expected_version:1,reason:'처리 요청',idempotency_key:id};
  await entry.handle(req,'member@mysc.co.kr',`/api/me/cases/${id}/lifecycle`,body);
  assert.equal(JSON.parse(requests[0].options.body).assignee_id,'recipient');
  for(const extra of [{role:'QA_OPERATOR'},{assignee_id:'../other'},{actor_id:'other'}])
    await assert.rejects(entry.handle(req,'member@mysc.co.kr',`/api/me/cases/${id}/lifecycle`,{...body,...extra}),{safeCode:'invalid_request'});
  assert.equal(requests.length,1);
});
