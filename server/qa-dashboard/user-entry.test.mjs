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
function token(project, email = 'member@mysc.co.kr', sub = 'actor-1') {
  const header = encode({ alg: 'RS256', kid: 'test' });
  const payload = encode({ aud: project, iss: `https://securetoken.google.com/${project}`,
    sub, iat: seconds - 10, exp: seconds + 600,
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

function mcpEntry(handler) {
  const requests=[];
  const entry=createUserEntry({authorityOrigin:qaOrigin,intakeOrigin,
    auth:{getIdTokenClient:async()=>({getRequestHeaders:async()=>new Headers({Authorization:'Bearer service-identity'})})},
    fetcher:async(url,options)=>{
      if(url.startsWith('https://www.googleapis.com/robot/'))return new Response(JSON.stringify(certs),{headers:{'content-type':'application/json'}});
      requests.push({url,options});return handler(url,options);
    }});
  return {entry,requests};
}
const rpc=(id=1)=>({jsonrpc:'2.0',id,method:'tools/list',params:{}});
const mcpReq=(headers={})=>({method:'POST',headers:{authorization:token('inner-platform-qa-20260310'),...headers}});

test('MCP bridge preserves protocol response and notification 202 without forwarding caller authority',async()=>{
 const {entry,requests}=mcpEntry(async(_url,options)=>{
  const body=JSON.parse(options.body);
  return Object.hasOwn(body,'id')?Response.json({jsonrpc:'2.0',id:body.id,result:{isError:true,content:[]}}):new Response(null,{status:202});
 });
 const response=await entry.handle(mcpReq({origin:'https://dashboard.invalid','x-tenant-id':'other','x-serverless-authorization':'attacker','mcp-protocol-version':'2025-03-26'}),'member@mysc.co.kr','/api/me/mcp',rpc('read-1'));
 assert.deepEqual(response,{status:200,body:{jsonrpc:'2.0',id:'read-1',result:{isError:true,content:[]}}});
 const upstream=requests[0];assert.equal(upstream.url,intakeOrigin+'/api/v1/mcp');
 assert.equal(upstream.options.headers['X-Tenant-Id'],'mysc');
 assert.equal(upstream.options.headers['X-Serverless-Authorization'],'Bearer service-identity');
 assert.equal(upstream.options.headers.Origin,undefined);assert.equal(upstream.options.headers.origin,undefined);
 assert.equal(upstream.options.headers['MCP-Protocol-Version'],'2025-03-26');
 assert.equal(upstream.options.headers.Accept,'application/json, text/event-stream');
 const notification=await entry.handle(mcpReq(),'member@mysc.co.kr','/api/me/mcp',{jsonrpc:'2.0',method:'notifications/initialized'});
 assert.deepEqual(notification,{status:202,body:null});
});

test('MCP bridge rejects malformed envelopes, sessions and identity mismatch before forwarding',async()=>{
 const {entry,requests}=mcpEntry(()=>{throw Error('must not forward');});
 for(const [req,body] of [[mcpReq(),[rpc()]],[mcpReq({'mcp-session-id':'foreign'}),rpc()],
 [mcpReq(),{...rpc(),actor_id:'other'}],[mcpReq(),{...rpc(),id:null}],
 [mcpReq({'mcp-protocol-version':'bad'}),rpc()],[mcpReq(),{...rpc(),params:{text:'x'.repeat(8192)}}]])
  await assert.rejects(entry.handle(req,'member@mysc.co.kr','/api/me/mcp',body),{safeCode:'invalid_request'});
 await assert.rejects(entry.handle(mcpReq(),'other@mysc.co.kr','/api/me/mcp',rpc()),{safeCode:'identity_mismatch'});
 await assert.rejects(entry.handle({...mcpReq(),method:'GET'},'member@mysc.co.kr','/api/me/mcp',null),{status:405});
 assert.equal(requests.length,0);
});

test('MCP bridge keeps concurrent identities separate and rejects oversized or mismatched responses',async()=>{
 const {entry,requests}=mcpEntry(async(_url,options)=>Response.json({jsonrpc:'2.0',id:JSON.parse(options.body).id,result:{tools:[]}}));
 await Promise.all(['a','b'].map((actor,i)=>entry.handle(mcpReq({authorization:token('inner-platform-qa-20260310',actor+'@mysc.co.kr',actor)}),actor+'@mysc.co.kr','/api/me/mcp',rpc(i))));
 assert.notEqual(requests[0].options.headers.Authorization,requests[1].options.headers.Authorization);
 for(const response of [Response.json({jsonrpc:'2.0',id:999,result:{}}),Response.json({jsonrpc:'2.0',id:1,result:{text:'x'.repeat(1048576)}}),new Response(null,{status:202})]){
  const {entry:bad}=mcpEntry(()=>response);
  await assert.rejects(bad.handle(mcpReq(),'member@mysc.co.kr','/api/me/mcp',rpc()),{safeCode:'qa_service_unavailable'});
 }
 for(const status of [401,403,503]){
  const {entry:bad}=mcpEntry(()=>new Response('private error',{status}));
  await assert.rejects(bad.handle(mcpReq(),'member@mysc.co.kr','/api/me/mcp',rpc()),{status,safeCode:'qa_mcp_upstream_denied'});
 }
});

test('SDK through authenticated bridge and HTTP intake preserves report replay and owner-only reads',async()=>{
 const [{default:express},{once},{mountQaMcpRoutes},{createIdempotencyService},{Client},{StreamableHTTPClientTransport}]=await Promise.all([
  import('express'),import('node:events'),import('../bff/qa-mcp.mjs'),import('../bff/idempotency.mjs'),
  import('@modelcontextprotocol/sdk/client/index.js'),import('@modelcontextprotocol/sdk/client/streamableHttp.js')]);
 const docs=new Map();for(const actor of ['a','b']){
  docs.set(`orgs/mysc/members/${actor}`,{status:'ACTIVE',role:'pm'});
  docs.set(`orgs/mysc/qa_actor_business_links/${actor}`,{status:'ACTIVE',qa_actor_id:actor,source:'dual_firebase_tokens'});
 }
 let tail=Promise.resolve();
 const db={doc:path=>({path}),runTransaction(fn){const task=tail.then(async()=>{
  const writes=[];const result=await fn({get:async ref=>({exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))}),
   create:(ref,value)=>{assert(!docs.has(ref.path));writes.push([ref.path,value]);},set:(ref,value)=>writes.push([ref.path,value])});
  for(const [key,value]of writes)docs.set(key,structuredClone(value));return result;
 });tail=task.catch(()=>{});return task;}};
 const app=express();app.use(express.json());app.use((req,_res,next)=>{
  assert.equal(req.header('x-serverless-authorization'),'Bearer service-identity');
  assert.equal(req.header('origin'),undefined);
  const payload=JSON.parse(Buffer.from(req.header('authorization').split('.')[1],'base64url'));
  req.context={tenantId:'mysc',actorId:payload.sub,authSource:'firebase'};next();
 });
 mountQaMcpRoutes(app,{db,idempotencyService:createIdempotencyService(db),authorizeCase:async()=>{},asyncHandler:fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next)});
 app.use((_error,_req,res,_next)=>res.status(500).json({error:'unexpected'}));
 const server=app.listen(0,'127.0.0.1');await once(server,'listening');const clients=[];let notifications=0;
 const {entry}=mcpEntry((_url,options)=>fetch(`http://127.0.0.1:${server.address().port}/api/v1/mcp`,options));
 async function connect(actor){
  const client=new Client({name:'bridge-test',version:'1'});clients.push(client);
  await client.connect(new StreamableHTTPClientTransport(new URL('https://dashboard.invalid/api/me/mcp'),{
   fetch:async(_url,options)=>{
    try{
     const request={method:options.method||'GET',headers:{...Object.fromEntries(new Headers(options.headers)),authorization:token('inner-platform-qa-20260310',actor+'@mysc.co.kr',actor)}};
     const response=await entry.handle(request,actor+'@mysc.co.kr','/api/me/mcp',options.body?JSON.parse(options.body):null);
     if(response.status===202){notifications++;return new Response(null,{status:202});}
     return Response.json(response.body,{status:response.status});
    }catch(e){return Response.json({error:e.safeCode},{status:e.status||500});}
   }
  }));return client;
 }
 try{
  const [a,b]=await Promise.all([connect('a'),connect('b')]);assert.equal(notifications,2);
  assert.equal((await a.listTools()).tools.length,5);
  const args={idempotency_key:'bridge-repeat',report:{platform_key:'myscube',title:'현금흐름 조회 오류',description:'확인 중 이후 오류'}};
  const responses=await Promise.all([a.callTool({name:'qa_report',arguments:args}),a.callTool({name:'qa_report',arguments:args})]);
  for(const response of responses)assert.notEqual(response.isError,true,JSON.stringify(response));
  const values=responses.map(r=>JSON.parse(r.content[0].text));assert.equal(values[0].case.case_id,values[1].case.case_id);
  assert.equal(values.filter(v=>v.replayed).length,1);
  assert.equal([...docs.keys()].filter(k=>k.includes('/qa_kafka_outbox/')).length,1);
  const case_id=values[0].case.case_id;
  assert.notEqual((await a.callTool({name:'qa_read',arguments:{case_id}})).isError,true);
  assert.equal((await b.callTool({name:'qa_read',arguments:{case_id}})).isError,true);
  assert.equal((await a.callTool({name:'qa_read',arguments:{case_id,actorId:'b'}})).isError,true);
 }finally{for(const client of clients)await client.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
