import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOpenAIInvestigation, reviewOpenAIInvestigation, planOpenAIInvestigation } from './openai-agent.mjs';
import { projectStages } from '../qa-dashboard/stages.mjs';
const answer = {facts:[],hypotheses:[],unknowns:[],next_actions:[],user_reply:'합성',cause_status:'not_established'};
const credit = () => new Response(JSON.stringify({error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'SECRET_DO_NOT_STORE'}}),{status:429});
const options = {apiKey:'synthetic',model:'synthetic',report:{synthetic:true},tools:{},onCheckpoint:async()=>{},validateAnswer:async()=>({accepted:true}),evidence:[],answer};
test('credit failure does not retry and reaches dashboard via actual model checkpoint',async()=>{
 const saved=globalThis.fetch;let calls=0;const events=[];
 globalThis.fetch=async()=>{calls++;return credit();};
 try {
  await assert.rejects(runOpenAIInvestigation({...options,onCheckpoint:async payload=>events.push({phase:payload.phase,payload})}),{code:'investigation_provider_credit_exhausted'});
  assert.equal(calls,1);assert.equal(events.filter(e=>e.phase.includes('retry')).length,0);
  const result=projectStages({status:'failed',error_code:'investigation_provider_credit_exhausted'},events);
  assert.match(result.failure_summary.message,/크레딧/);assert.match(result.failure_summary.next_action,/관리자/);
  assert.ok(!JSON.stringify({events,result}).includes('SECRET_DO_NOT_STORE'));
 }finally{globalThis.fetch=saved;}
});
test('review credit failure survives final-answer validation instead of becoming rejected answer',async()=>{
 const saved=globalThis.fetch;let calls=0;const events=[];
 globalThis.fetch=async()=>{
  calls++;
  if(calls>1)return credit();
  return new Response(JSON.stringify({status:'completed',output:[{type:'function_call',call_id:'final1',name:'finalize_investigation',arguments:JSON.stringify(answer)}]}));
 };
 try {
  await assert.rejects(runOpenAIInvestigation({...options,onCheckpoint:async payload=>events.push({phase:payload.phase,payload}),validateAnswer:async()=>reviewOpenAIInvestigation(options)}),{code:'investigation_provider_credit_exhausted'});
  assert.equal(calls,2);
  const failed=events.find(e=>e.phase==='failed');assert.equal(failed.payload.error_code,'investigation_provider_credit_exhausted');
  assert.ok(!JSON.stringify(events).includes('SECRET_DO_NOT_STORE'));
 }finally{globalThis.fetch=saved;}
});
test('unknown, oversized and malformed provider error bodies remain generic without exposing content',async()=>{
 for(const body of ['not-json',JSON.stringify({error:{code:'unrecognized',type:'insufficient_quota'}}),JSON.stringify({error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'x'.repeat(17000)}})]){
  const saved=globalThis.fetch;globalThis.fetch=async()=>new Response(body,{status:400});
  try{await assert.rejects(runOpenAIInvestigation(options),{code:'investigation_model_request_failed'});}finally{globalThis.fetch=saved;}
 }
});
test('persisted credit failure wins over an older transient failure checkpoint',()=>{
 const result=projectStages({status:'failed',error_code:'investigation_provider_credit_exhausted'},[{phase:'failed',payload:{error_code:'model_request_failed',provider_http_status:429}}]);
 assert.match(result.failure_summary.message,/크레딧/);assert.doesNotMatch(result.failure_summary.next_action,/대기 후/);
});
test('persisted credit failure also wins over historical exhausted checkpoint',()=>{
 const result=projectStages({status:'failed',error_code:'investigation_provider_credit_exhausted'},[{phase:'exhausted',payload:{}}]);
 assert.match(result.failure_summary.message,/크레딧/);
});

test('abort during delayed provider error body preserves cancellation rather than credit classification',async()=>{
 const saved=fetch,controller=new AbortController();let calls=0;
 const reason=Object.assign(Error('cancelled'),{code:'investigation_lease_lost'});
 globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(stream){setTimeout(()=>{controller.abort(reason);stream.enqueue(new TextEncoder().encode(JSON.stringify({error:{code:'credit_balance_exhausted',type:'insufficient_quota'}})));stream.close();},10);}}),{status:429});};
 try{await assert.rejects(planOpenAIInvestigation({...options,signal:controller.signal}),e=>e===reason);assert.equal(calls,1);}finally{globalThis.fetch=saved;}
});

test('actual request path records safe HTTP/credit/network observations but not caller cancellation',async()=>{
 const saved=fetch,info=console.info;const lines=[];console.info=line=>lines.push(JSON.parse(line));
 try{
  for(const [status,body,outcome]of [[429,{error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'SECRET'}},'credit_exhausted'],[401,{error:{message:'SECRET'}},'http_error'],[200,{status:'completed',output:[{type:'function_call',call_id:'f',name:'finalize_investigation',arguments:JSON.stringify(answer)}]},'accepted_http']]){
   lines.length=0;globalThis.fetch=async()=>new Response(JSON.stringify(body),{status});
   try{await runOpenAIInvestigation({...options,model:'gpt-6-sol'});}catch{}
   assert.equal(lines[0].outcome,outcome);assert.equal(lines[0].http_status,status);assert.ok(!JSON.stringify(lines).includes('SECRET'));
  }
  lines.length=0;globalThis.fetch=async()=>{throw Error('SECRET');};
  await assert.rejects(runOpenAIInvestigation({...options,model:'gpt-6-sol'}));assert.equal(lines[0].outcome,'network_error');
  lines.length=0;const controller=new AbortController();globalThis.fetch=async()=>{controller.abort();throw Error('cancel');};
  await assert.rejects(runOpenAIInvestigation({...options,model:'gpt-6-sol',signal:controller.signal}));assert.equal(lines.length,0);
 }finally{globalThis.fetch=saved;console.info=info;}
});
