import test from 'node:test';import assert from 'node:assert/strict';
import {createOperationsReader,projectWorker,ageOperations,WORKERS,projectProvider} from './operations.mjs';
const now=Date.parse('2026-10-13T03:00:00Z');
const entry=(worker=WORKERS[1])=>({logName:'projects/inner-platform-qa-20260310/logs/qa-pipeline-health',timestamp:new Date(now).toISOString(),resource:{type:'gce_instance',labels:{project_id:'inner-platform-qa-20260310',zone:'asia-northeast3-a',instance_id:worker.instance}},jsonPayload:{producer:'health_forwarder_v1',phase:'worker_heartbeat',instance_id:'11111111-1111-4111-8111-111111111111',role:worker.role,ready:true,process_state:'running',observed_at:new Date(now).toISOString(),blocked_partition_count:0,dependencies:{kafka_heartbeat:{stale:false,last_success_at:new Date(now).toISOString()},outbox_poll:{stale:false,last_success_at:new Date(now).toISOString()},dispatch_tick:{stale:false,last_success_at:new Date(now).toISOString()}},lag_stale:false,lag_observed_at:new Date(now).toISOString(),partitions:[0,1,2].map(partition=>({partition,log_start_offset:'0',high_watermark:'9007199254740993',committed_next_offset:'9007199254740993',lag:'0',offset_out_of_range:false})),private:'<script>secret</script>'}});
test('independent worker/lag states and private field suppression',()=>{
 const x=projectWorker(entry(),WORKERS[1],now);assert.equal(x.status,'ready');assert.deepEqual(x.lag,{status:'caught_up',count:'0',observed_at:new Date(now).toISOString(),valid_until:new Date(now+60000).toISOString()});assert(!JSON.stringify(x).includes('secret'));
 const e=entry();e.jsonPayload.lag_stale=true;assert.equal(projectWorker(e,WORKERS[1],now).lag.status,'stale');assert.equal(projectWorker(e,WORKERS[1],now).status,'ready');
 assert.equal(projectWorker(entry(WORKERS[0]),WORKERS[0],now).lag.status,'not_applicable');
});
test('stale, future, wrong source, blocked, duplicate and range errors never become healthy Kafka',()=>{
 for(const change of [e=>{e.timestamp='2026-10-12T00:00:00Z';},e=>{e.jsonPayload.observed_at='2026-10-14T00:00:00Z';}]){const e=entry();change(e);assert.equal(projectWorker(e,WORKERS[1],now).status,'stale');}
 for(const change of [e=>e.resource.labels.instance_id='different',e=>e.jsonPayload.role='relay',e=>e.logName='other',e=>e.jsonPayload.producer='other']){const e=entry();change(e);assert.equal(projectWorker(e,WORKERS[1],now).status,'unavailable');}
 const e=entry();e.jsonPayload.partitions[1].partition=0;assert.equal(projectWorker(e,WORKERS[1],now).lag.status,'unavailable');
 const f=entry();f.jsonPayload.partitions[0].committed_next_offset='9007199254740994';f.jsonPayload.partitions[0].offset_out_of_range=true;assert.equal(projectWorker(f,WORKERS[1],now).lag.status,'out_of_range');
 const g=entry();g.jsonPayload.blocked_partition_count=1;assert.equal(projectWorker(g,WORKERS[1],now).status,'attention');
});
test('aggregate calls share readTime; source errors remain separate, counts no raw documents',async()=>{
 const requests=[];const reader=createOperationsReader({now:()=>now,request:async req=>{requests.push(req);if(req.url.includes('logging'))throw Error('403');const q=req.data.structuredAggregationQuery.structuredQuery;return [{result:{aggregateFields:{count:{integerValue:q.where?'1':'4'}}}}];}});
 const x=await reader();assert.equal(x.runs.status,'available');assert.equal(x.runs.counts.total,4);assert(x.workers.every(w=>w.status==='unavailable'));assert.equal(new Set(requests.filter(r=>r.data.readTime).map(r=>r.data.readTime)).size,1);assert(!JSON.stringify(requests).includes('title'));
 assert.equal(requests.length,22);await reader();assert.equal(requests.length,22);
});
test('missing/invalid counts never become zero; empty logging has unknown status',async()=>{
 for(const value of [undefined,'-1','9007199254740992','bad']){
 const reader=createOperationsReader({now:()=>now,request:async req=>req.url.includes('logging')?{}:[{result:{aggregateFields:{count:{integerValue:value}}}}]});const x=await reader();assert.equal(x.runs.status,'unavailable');assert.equal(x.runs.counts,undefined);assert(x.workers.every(w=>w.error_code==='not_observed'));
 }
});

test('response and cached records age beyond sixty seconds',async()=>{
 let at=now;
 const reader=createOperationsReader({now:()=>at,request:async req=>{
  if(!req.url.includes('logging'))return [{result:{aggregateFields:{count:{integerValue:'0'}}}}];
  const w=WORKERS.find(w=>req.data.filter.includes(w.instance));return {entries:[entry(w)]};
 }});
 const first=await reader();assert.equal(first.workers[1].status,'ready');
 const expired=ageOperations(first,now+60001);assert.equal(expired.workers[1].status,'stale');assert.equal(expired.workers[1].lag.status,'stale');
 at=now+65000;const second=await reader();assert.equal(second.workers[1].status,'stale');
});

test('durable quarantine counts survive healthy zero lag; state and reason summaries exclude raw source',async()=>{
 const requests=[];
 const reader=createOperationsReader({now:()=>now,request:async req=>{
   requests.push(req);
   if(req.url.includes('logging'))return{entries:[entry(WORKERS.find(w=>req.data.filter.includes(w.instance)))]};
   const query=req.data.structuredAggregationQuery.structuredQuery;
   const filter=query.where?.fieldFilter;
   const value=query.from[0].collectionId==='qa_pipeline_quarantines'?
     (!filter?'3':filter.value.stringValue==='dead_lettered'?'2':filter.value.stringValue==='blocked'?'1':filter.value.stringValue==='invalid_message'?'2':filter.value.stringValue==='dispatch_http_rejected'?'1':'0'):'0';
   return[{result:{aggregateFields:{count:{integerValue:value}}}}];
 }});
 const data=await reader();assert.equal(data.workers[1].lag.status,'caught_up');assert.equal(data.quarantine.status,'available');
 assert.deepEqual(data.quarantine.counts,{total:3,blocked:1,dead_lettered:2,replay_authorized:0});
 assert.equal(data.quarantine.reasons.invalid_message,2);assert.equal(data.quarantine.other,0);assert.equal(data.quarantine.other_reasons,0);
 assert(requests.filter(r=>r.url.includes('firestore')).every(r=>r.url.endsWith(':runAggregationQuery')));
 assert(!JSON.stringify(data).includes('value_base64'));
});

test('provider observations enforce source, status, timestamp and cached aging without private data',()=>{
 const make=()=>({logName:'projects/inner-platform-qa-20260310/logs/run.googleapis.com%2Fstdout',timestamp:new Date(now).toISOString(),resource:{type:'cloud_run_job',labels:{project_id:'inner-platform-qa-20260310',job_name:'qa-investigator-pipeline',location:'asia-northeast3'}},jsonPayload:{producer:'qa_provider_observer_v1',phase:'provider_request_observed',provider:'openai',model:'gpt-6-sol',observed_at:new Date(now).toISOString(),outcome:'credit_exhausted',http_status:429,api_key:'SECRET'}});
 const p=projectProvider(make(),now);assert.equal(p.outcome,'credit_exhausted');assert.equal(p.status,'observed');assert.ok(!JSON.stringify(p).includes('SECRET'));
 assert.equal(ageOperations({provider:p},now+900001).provider.status,'stale');
 assert.equal(projectProvider(make(),now+900000).status,'observed');
 for(const mutate of [e=>e.resource.labels.job_name='other',e=>e.resource.labels.project_id='other',e=>e.resource.labels.location='other',e=>e.logName='other',e=>e.jsonPayload.producer='other',e=>e.timestamp=new Date(now+5001).toISOString(),e=>e.jsonPayload.http_status=200]){const e=make();mutate(e);assert.equal(projectProvider(e,now).status,'unavailable');}
 for(const [outcome,http_status]of [['accepted_http',200],['http_error',429],['http_error',500],['network_error',null]]){const e=make();Object.assign(e.jsonPayload,{outcome,http_status});assert.equal(projectProvider(e,now).outcome,outcome);}
 assert.equal(projectProvider(undefined,now).error_code,'not_observed');
});
