import test from 'node:test';
import assert from 'node:assert/strict';
import { exhaustedCredit } from './provider-error.mjs';
test('only explicit 429 credit code and quota type pair classify',async()=>{
 for(const [status,code,type,expected] of [[429,'credit_balance_exhausted','insufficient_quota',true],[429,'insufficient_quota','insufficient_quota',true],[429,'rate_limit_exceeded','insufficient_quota',false],[429,'credit_balance_exhausted','unknown',false],[500,'credit_balance_exhausted','insufficient_quota',false]]){
  assert.equal(await exhaustedCredit(Response.json({error:{code,type}},{status})),expected);
 }
});
test('oversize, malformed and stream failure are unknown, never credit exhaustion',async()=>{
 for(const response of [new Response('invalid',{status:429}),Response.json({error:{code:'credit_balance_exhausted',type:'insufficient_quota',message:'가'.repeat(6000)}},{status:429}),new Response(new ReadableStream({start(c){c.error(Error('PRIVATE'));}}),{status:429})])assert.equal(await exhaustedCredit(response),false);
});
test('never-ending response read terminates and cancels without awaiting hanging cancellation',async()=>{
 let cancelled=false;
 const body=new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}});
 const start=Date.now();assert.equal(await exhaustedCredit(new Response(body,{status:429})),false);
 assert.ok(Date.now()-start<4000);assert.equal(cancelled,true);
});

test('provider telemetry emits only whitelisted metadata and cannot break requests',async()=>{
 const {observeProviderRequest}=await import('./provider-error.mjs');const lines=[];
 observeProviderRequest({model:'gpt-6-sol',outcome:'credit_exhausted',httpStatus:429,apiKey:'SECRET'},x=>lines.push(x));
 const value=JSON.parse(lines[0]);assert.equal(value.http_status,429);assert.equal(value.outcome,'credit_exhausted');assert.ok(!lines[0].includes('SECRET'));
 observeProviderRequest({model:'bad\nSECRET',outcome:'accepted_http',httpStatus:200},x=>lines.push(x));assert.equal(lines.length,1);
 assert.doesNotThrow(()=>observeProviderRequest({model:'gpt-6-sol',outcome:'network_error'},()=>{throw Error('logger failed');}));
});
