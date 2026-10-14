import test from 'node:test';
import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js';
import {createQaMcpServer} from './qa-mcp.mjs';
const id='11111111-1111-4111-8111-111111111111';
async function session(actorId){
 let active=true;const calls=[];
 const server=createQaMcpServer({context:{tenantId:'mysc',actorId,authSource:'firebase',requestId:'test'},
 authorize:async ctx=>{assert.equal(ctx.actorId,actorId);if(!active)throw Error('PRIVATE_CREDENTIAL');},
 cases:{get:async(ctx,caseId)=>{calls.push(ctx);return {case_id:caseId,actor_id:ctx.actorId};}},results:{}});
 const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);
 return {client,calls,revoke:()=>{active=false;},close:async()=>{await client.close();await server.close();}};
}
test('actual SDK isolates caller identity and rejects caller-supplied actor',async()=>{
 const a=await session('actor-a'),b=await session('actor-b');
 try{
 const results=await Promise.all([a,b].map(s=>s.client.callTool({name:'qa_read',arguments:{case_id:id}})));
 assert.equal(JSON.parse(results[0].content[0].text).actor_id,'actor-a');assert.equal(JSON.parse(results[1].content[0].text).actor_id,'actor-b');
 const forged=await a.client.callTool({name:'qa_read',arguments:{case_id:id,actorId:'actor-b'}});assert.equal(forged.isError,true);assert.equal(a.calls.length,1);
 }finally{await a.close();await b.close();}
});
test('revoked access blocks service invocation and hides internal errors through SDK',async()=>{
 const s=await session('actor-a');try{s.revoke();const result=await s.client.callTool({name:'qa_read',arguments:{case_id:id}});assert.equal(result.isError,true);assert.match(result.content[0].text,/qa_mcp_request_failed/);assert.doesNotMatch(result.content[0].text,/PRIVATE_CREDENTIAL/);assert.equal(s.calls.length,0);}finally{await s.close();}
});

test('MCP report uses real case and idempotency services, rereads storage and enforces ownership',async()=>{
 const {createQaCaseService,requireQaMember}=await import('./qa-cases.mjs');
 const {createIdempotencyService}=await import('./idempotency.mjs');
 const docs=new Map();for(const actor of ['a','b']){docs.set(`orgs/mysc/members/${actor}`,{status:'ACTIVE',role:'pm'});docs.set(`orgs/mysc/qa_actor_business_links/${actor}`,{status:'ACTIVE',qa_actor_id:actor,source:'dual_firebase_tokens'});}
 let tail=Promise.resolve();
 const db={doc:path=>({path}),runTransaction(fn){const task=tail.then(async()=>{const writes=[];const result=await fn({get:async ref=>({exists:docs.has(ref.path),data:()=>structuredClone(docs.get(ref.path))}),create:(ref,value)=>{assert(!docs.has(ref.path));writes.push([ref.path,value]);},set:(ref,value)=>writes.push([ref.path,value])});for(const [key,value]of writes)docs.set(key,structuredClone(value));return result;});tail=task.catch(()=>{});return task;}};
 const cases=createQaCaseService({db,idempotencyService:createIdempotencyService(db)}),sessions=[];
 async function connect(actorId){const server=createQaMcpServer({context:{tenantId:'mysc',actorId,authSource:'firebase',requestId:'test'},cases,results:{},authorize:ctx=>db.runTransaction(tx=>requireQaMember(tx,db,ctx))});const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();await server.connect(b);await client.connect(a);sessions.push({server,client});return client;}
 try{
 const a=await connect('a'),b=await connect('b'),args={idempotency_key:'qa-mcp-repeat',report:{platform_key:'myscube',title:'현금흐름 조회 오류',description:'확인 중 표시 이후 오류가 발생합니다.'}};
 const replies=await Promise.all([1,2].map(()=>a.callTool({name:'qa_report',arguments:args})));
 for(const r of replies)assert.notEqual(r.isError,true,JSON.stringify(r));
 const values=replies.map(r=>JSON.parse(r.content[0].text));assert.equal(values[0].case.case_id,values[1].case.case_id);assert.equal(values[1].replayed,true);assert.equal(values[0].confirms,'qa_intake_persisted');
 assert.equal([...docs.keys()].filter(k=>/^orgs\/mysc\/qa_cases\/[^/]+$/.test(k)).length,1);assert.equal([...docs.keys()].filter(k=>k.includes('/qa_kafka_outbox/')).length,1);
 const denied=await b.callTool({name:'qa_read',arguments:{case_id:values[0].case.case_id}});assert.equal(denied.isError,true);assert.doesNotMatch(denied.content[0].text,/확인 중/);
 const changed=await a.callTool({name:'qa_report',arguments:{...args,report:{...args.report,title:'다른 신고 내용'}}});assert.equal(changed.isError,true);assert.equal(JSON.parse(changed.content[0].text).error,'idempotency_conflict');assert.equal([...docs.keys()].filter(k=>/^orgs\/mysc\/qa_cases\/[^/]+$/.test(k)).length,1);
 }finally{for(const {client,server}of sessions){await client.close();await server.close();}}
});
