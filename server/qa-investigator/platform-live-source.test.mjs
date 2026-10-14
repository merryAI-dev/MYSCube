import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {createLiveSourceTools} from './live-source-tools.mjs';
import {createSessionContext,verifyStoredEvidence} from './session-context.mjs';
import {evidenceRecord} from './runner-persistence.mjs';
const actor='reporter',id='req_1791874000000_123456789abc',path='/api/v1/cashflow/weekly-overview',at='2026-10-13T06:46:40.000Z';
const actorMask='actor_'+createHash('sha256').update(JSON.stringify(actor)).digest('hex').slice(0,16);
const policy={repository:'MYSCube',scopeKind:'platform',trustedActorId:actor,allowedPaths:[],allowedProjectIds:[],allowedRequestPaths:[path],allowedRequestIds:[],startAt:'2026-10-13T06:40:00.000Z',endAt:'2026-10-13T06:55:00.000Z'};
const observation=(overrides={})=>{
 const body={status:'available',coverage:{scope:'trusted_actor'},rows:[{received_at:at,actor_mask:actorMask,request_path:path,reported_response_request_id:id,...overrides}]};
 const content_hash=createHash('sha256').update(JSON.stringify({tool:'query_client_errors',...body})).digest('hex');
 return{source:'query_client_errors',evidence_id:'ev_'+content_hash,content_hash,...body};
};
const log=(requestId=id,requestPath=path)=>({timestamp:at,domain:'myscube.myscguard.app',requestPath,deploymentId:'dpl_test',statusCode:504,requestMethod:'POST',logs:[{message:JSON.stringify({requestId,errorCode:'jvm_request_timeout',operation:'cashflow.weekly_overview',phase:'java_overview',statusCode:504,durationMs:60001,projectCount:70,token:'never-return'})}]});
test('stored evidence restores client-to-server anchors without changing source hash serialization',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-restore-'));
 try {
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');
  const original=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async()=>Response.json({rows:[log()],hasMoreRows:false})});
  const client={...observation(),observed_at:at};original.observeEvidence(client);
  const server=await original.query_live_vercel_request_logs.execute({request_id:id});
  assert.equal(original.requestLogAnchors(server).length,1);
  const runBinding={tenant_id:'mysc',case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',case_input_hash:'a'.repeat(64),aggregate_version:1};
  const records=[client,server].map(item=>({documentId:item.evidence_id,stored:evidenceRecord({item,runBinding,runId:runBinding.run_id})}));
  const restored=records.map(record=>verifyStoredEvidence({...record,runBinding}).evidence);
  const resumed=createLiveSourceTools({policy});restored.forEach(e=>resumed.observeEvidence(e));
  assert.deepEqual(resumed.requestLogAnchors(restored[1]),original.requestLogAnchors(server));
  const ledger=createSessionContext({runBinding,report:{title:'restore',description:'restore'},priorEvidence:records});
  const roundTrip=restored.map(e=>ledger.readEvidence({evidence_id:e.evidence_id,start_offset:0,max_bytes:16384}).envelope);
  assert.ok(roundTrip.every(Boolean));
  const later=createLiveSourceTools({policy});roundTrip.forEach(e=>later.observeEvidence(e));
  assert.deepEqual(later.requestLogAnchors(roundTrip[1]),original.requestLogAnchors(server));
  let offset=0;const chunks=[];
  do {const page=ledger.readEvidence({evidence_id:server.evidence_id,start_offset:offset,max_bytes:512});assert.equal(page.envelope,undefined);chunks.push(page.chunk);offset=page.next_offset;}while(offset!==null);
  const recovered=JSON.parse(chunks.join(''));
  assert.deepEqual(recovered,server);
  const wrongActor=createLiveSourceTools({policy:{...policy,trustedActorId:'another'}});restored.forEach(e=>wrongActor.observeEvidence(e));
  assert.deepEqual(wrongActor.requestLogAnchors(restored[1]),[]);
  const tampered=structuredClone(records[1]);tampered.stored.payload_json=JSON.stringify({...server,rows:[]});
  assert.throws(()=>verifyStoredEvidence({...tampered,runBinding}),{code:'session_stored_evidence_invalid'});
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('platform server logs require the same reporter request and retain safe timing/counts',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-source-'));try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');let calls=0;
  const tools=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async()=>{calls++;return Response.json({rows:[log(),log('req_1791874000000_aaaaaaaaaaaa'),log(id,'/api/v1/cashflow/p1779092105308/month-close')],hasMoreRows:false});}});
  for(const e of [observation({actor_mask:'actor_foreign'}),observation({received_at:'2026-10-12T00:00:00Z'}),observation({request_path:'https://foreign.invalid/api/v1/projects'}),{...observation(),coverage:{scope:'current_project_manager_candidates'}}])tools.observeEvidence(e);
  assert.equal((await tools.query_live_vercel_request_logs.execute({})).error_code,'reporter_request_unobserved');assert.equal(calls,0);
  tools.observeEvidence({source:'query_live_vercel_request_logs',status:'unavailable',error_code:'reporter_request_unobserved'});tools.observeEvidence(observation());await tools.query_live_vercel_request_logs.execute({page:-1});assert.equal(tools.requiredFollowups()[0].tool,'query_live_vercel_request_logs');const result=await tools.query_live_vercel_request_logs.execute({});tools.observeEvidence(result);assert.deepEqual(tools.requiredFollowups(),[]);tools.observeEvidence(observation({reported_response_request_id:'req_1791874000000_bbbbbbbbbbbb'}));assert.equal(tools.requiredFollowups()[0].tool,'query_live_vercel_request_logs');
  assert.equal(result.status,'available');assert.equal(result.rows.length,1);assert.equal(result.rows[0].events[0].duration_ms,60001);assert.equal(result.rows[0].events[0].project_count,70);assert.equal(result.rows[0].events[0].request_id,id);assert(!JSON.stringify(result).includes('never-return'));
  assert.equal(result.coverage.request_id_correlation,'client_claimed_request_id_matched_server_log');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('public GitHub source is explicitly checked before anonymous source access',async()=>{
 let seen=[];const tools=createLiveSourceTools({policy:{repository:'MYSCube',allowedPaths:['server/bff/app.mjs']},github:{publicRepository:true},resolveDeployedRevision:async()=>({revision:'a'.repeat(40),repository:'MYSCube'}),fetchImpl:async(url,options)=>{seen.push({url,headers:options.headers});return Response.json({full_name:'merryAI-dev/MYSCube',private:true});}});
 const result=await tools.read_live_deployed_code.execute({path:'server/bff/app.mjs',start_line:1,end_line:2});
 assert.equal(result.error_code,'source_access_denied');assert.equal(seen.length,1);assert(!seen.some(x=>x.headers.Authorization));
});

test('real performance emitter preserves successful transport stages and timeout',async()=>{
 const {createCashflowPerformanceTrace}=await import('../bff/cashflow-performance.mjs');
 const dir=await mkdtemp(join(tmpdir(),'platform-perf-'));
 try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');const emitted=[];let now=0;
  const trace=createCashflowPerformanceTrace({requestId:id,operation:'read_cashflow_weekly_overview',logger:p=>emitted.push({message:JSON.stringify(p)}),now:()=>now});
  await trace.measure('auth_headers',async()=>{now+=31;});
  await assert.rejects(trace.measure('upstream_ttfb',async()=>{now+=24000;throw Object.assign(new Error('redacted'),{name:'AbortError'});}));
  await new Promise(resolve=>setImmediate(resolve));
  const tools=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async()=>Response.json({rows:[{...log(),logs:emitted}],hasMoreRows:false})});
  tools.observeEvidence(observation());const result=await tools.query_live_vercel_request_logs.execute({});
  assert.equal(result.rows[0].events.length,2);
  assert.deepEqual(result.rows[0].events.map(e=>[e.phase,e.outcome,e.duration_ms,e.error_code]),[['auth_headers','ok',31,null],['upstream_ttfb','error',24000,'AbortError']]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('a new service route reaches log correlation without adding route or operation names',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-new-route-'));
 try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');
  const newPath='/api/v1/new-module/resource-123/history';
  const event={requestId:id,operation:'new_module.history.read',errorCode:'new_module_unavailable',privateBody:'never-return'};
  const tools=createLiveSourceTools({policy:{...policy,allowedRequestPaths:[]},vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async()=>Response.json({rows:[{...log(id,newPath),logs:[{message:JSON.stringify(event)}]}],hasMoreRows:false})});
  tools.observeEvidence(observation({request_path:newPath}));
  const result=await tools.query_live_vercel_request_logs.execute({});
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].path,newPath);
  assert.equal(result.rows[0].events[0].operation,'new_module.history.read');
  assert.equal(result.rows[0].events[0].phase,null);
  assert(!JSON.stringify(result).includes('never-return'));
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('server-issued pagination stays actionable until exhausted; fabricated pages do not clear anchors',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-pages-'));
 try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');const pages=[];
  const tools=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async(url)=>{
   const page=Number(new URL(url).searchParams.get('page'));pages.push(page);
   return Response.json({rows:page===1?[log()]:[],hasMoreRows:page===0});
  }});
  tools.observeEvidence(observation());
  assert.equal((await tools.query_live_vercel_request_logs.execute({page:9})).error_code,'source_page_not_pending');
  assert.equal(tools.requiredFollowups().length,1);assert.deepEqual(pages,[]);
  const first=await tools.query_live_vercel_request_logs.execute({page:0});
  assert.equal(first.next_page,1);assert.equal(first.rows.length,0);assert.match(tools.requiredFollowups()[0].reason,/page 1/);
  assert.equal((await tools.query_live_vercel_request_logs.execute({page:2})).error_code,'source_page_not_pending');
  assert.equal(tools.requiredFollowups().length,1);
  const second=await tools.query_live_vercel_request_logs.execute({page:1});
  assert.equal(second.rows.length,1);assert.deepEqual(pages,[0,1]);
  const repeated=await tools.query_live_vercel_request_logs.execute({page:1});assert.equal(repeated.error_code,'source_page_not_pending');assert.equal(repeated.status,'unavailable');assert.deepEqual(repeated.rows,[]);assert.deepEqual(pages,[0,1]);
  assert.deepEqual(tools.requiredFollowups(),[]);
  tools.observeEvidence(observation({reported_response_request_id:'req_1791874000000_bbbbbbbbbbbb'}));
  assert.equal((await tools.query_live_vercel_request_logs.execute({page:1})).error_code,'source_page_not_pending');
  assert.match(tools.requiredFollowups()[0].reason,/page 0/);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('actual provider denial records unavailability rather than requiring endless retries',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-denial-'));
 try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');let calls=0;
  const tools=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async()=>{calls++;return new Response('',{status:403});}});
  tools.observeEvidence(observation());
  const denied=await tools.query_live_vercel_request_logs.execute({page:0});
  assert.equal(denied.status,'unavailable');assert.equal(calls,1);assert.deepEqual(tools.requiredFollowups(),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('focused application request search is observed-only and pagination belongs to its query',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'platform-search-'));
 try{
  const tokenPath=join(dir,'token');await writeFile(tokenPath,'test-only');const queries=[];
  const tools=createLiveSourceTools({policy,vercel:{teamId:'team_A7cbzLIfAhnrz35sykcSyM5L',projectId:'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0',tokenPath},fetchImpl:async(url)=>{const q=new URL(url).searchParams;queries.push(Object.fromEntries(q));return Response.json({rows:[log(),log('req_1791874000000_aaaaaaaaaaaa')],hasMoreRows:q.get('page')==='0'});}});
  tools.observeEvidence(observation());
  assert.equal((await tools.query_live_vercel_request_logs.execute({request_id:'req_1791874000000_aaaaaaaaaaaa'})).error_code,'invalid_scope');assert.equal(queries.length,0);
  const first=await tools.query_live_vercel_request_logs.execute({request_id:id});
  assert.equal(queries[0].search,id);assert.equal(queries[0].requestId,undefined);assert.equal(first.rows.length,1);
  assert.equal((await tools.query_live_vercel_request_logs.execute({page:1})).error_code,'source_page_not_pending');
  assert.equal(tools.requiredFollowups().length,1);
  await tools.query_live_vercel_request_logs.execute({request_id:id,page:1});assert.deepEqual(tools.requiredFollowups(),[]);
 }finally{await rm(dir,{recursive:true,force:true});}
});


test('page-state failure survives the actual MCP transport without becoming an auth failure',async()=>{
 const {Client}=await import('@modelcontextprotocol/sdk/client/index.js');
 const {InMemoryTransport}=await import('@modelcontextprotocol/sdk/inMemory.js');
 const {createInvestigationMcpSourceServer}=await import('./mcp-source-server.mjs');
 const tools=createLiveSourceTools({policy});tools.observeEvidence(observation());
 const binding='b'.repeat(64);let permitted=true;
 const server=createInvestigationMcpSourceServer({runBinding:{tenant_id:'mysc',case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',case_input_hash:'a'.repeat(64),aggregate_version:1},sources:{tools:{query_live_vercel_request_logs:tools.query_live_vercel_request_logs}},authorityBinding:binding,authorize:async()=>{if(!permitted)throw Error('revoked');return binding;},synchronizeEvidence:async()=>{}});
 const client=new Client({name:'test',version:'1'}),[a,b]=InMemoryTransport.createLinkedPair();
 await server.connect(b);await client.connect(a);
 try {
 const result=await client.callTool({name:'query_live_vercel_request_logs',arguments:{page:1}});
 assert.match(JSON.stringify(result),/source_page_not_pending/);assert.doesNotMatch(JSON.stringify(result),/source_auth_unavailable/);
 permitted=false;await assert.rejects(client.callTool({name:'query_live_vercel_request_logs',arguments:{page:1}}),/request_denied/);
 }finally{await client.close();await server.close();}
});
