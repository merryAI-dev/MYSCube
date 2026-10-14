import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectStages, projectRunMetrics, safeDiagnostics } from './stages.mjs';
const event=(sequence,phase,payload={})=>({sequence,phase,payload,occurred_at:'2026-10-12T08:00:00Z',model_step:sequence});
const stage=(result,id)=>result.stages.find(s=>s.id===id);
test('model failure does not label downstream sources failed or healthy',()=>{
 const r=projectStages({status:'failed',delivery_status:'not_sent'},[event(1,'started'),event(2,'failed',{error_code:'model_request_failed'})]);
 assert.equal(stage(r,'model').status,'failed');assert.equal(stage(r,'business').status,'blocked');assert.equal(stage(r,'external_delivery').status,'not_connected');assert.equal(stage(r,'receipt').status,'completed');
});
test('source failures retain counts even when another call succeeds',()=>{
 const r=projectStages({status:'running'},[event(1,'tool_completed',{results:[{name:'query_runtime_logs',result:{output:{status:'unavailable',error_code:'source_access_denied'}}}]}),event(2,'tool_completed',{results:[{name:'query_runtime_logs',result:{output:{status:'available'}}}]})]);
 assert.equal(stage(r,'server_logs').status,'partial');assert.equal(stage(r,'server_logs').available,1);assert.equal(stage(r,'server_logs').unavailable,1);assert.equal(stage(r,'client_errors').status,'waiting');
});
test('finalize checkpoint alone is not persisted result completion',()=>{
 const r=projectStages({status:'running'},[event(1,'completed')]);assert.equal(stage(r,'result_storage').status,'running');
 const done=projectStages({status:'completed',review_accepted:true,answer:{}},[event(1,'completed')]);assert.equal(stage(done,'result_storage').status,'completed');assert.equal(stage(done,'business').status,'waiting');
});
test('diagnostic adds bounded cause without exposing raw provider content',()=>{
 const r=projectStages({status:'failed'},[event(1,'diagnostic',{stage:'model',error_code:'provider_schema_invalid',provider_http_status:400,provider_error_status:'INVALID_ARGUMENT',message:'secret@example.com',headers:{Authorization:'Bearer raw'}})]);
 assert.equal(r.failure_summary.error_code,'provider_schema_invalid');assert.equal(r.failure_summary.provider_http_status,400);assert.ok(!JSON.stringify(r).includes('secret@example.com'));assert.ok(!JSON.stringify(r).includes('Bearer raw'));
});
test('code catalog is not source read; unknown phase is not stage success',()=>{
 const r=projectStages({status:'running'},[event(1,'source_catalog_ready'),event(2,'tool_completed',{results:[{name:'list_code_snapshots',result:{output:{status:'available'}}}]})],{truncated:true});assert.equal(stage(r,'code').status,'running');assert.equal(r.stage_coverage,'partial_checkpoints');assert.equal(stage(r,'evidence_validation').status,'waiting');
});

test('recovered completed run keeps historical failure only in timeline',()=>{
 const r=projectStages({status:'completed',review_accepted:true,answer:{}},[event(1,'failed',{error_code:'model_request_failed',provider_http_status:400}),event(2,'tools_requested',{toolCalls:[]}),event(3,'completed')]);
 assert.equal(stage(r,'model').status,'completed');assert.equal(stage(r,'model').provider_http_status,undefined);assert.equal(r.failure_summary,null);assert.equal(r.timeline[0].provider_http_status,400);
});

test('429 capacity failure differs from schema failure and retains retry history',()=>{
 const r=projectStages({status:'failed'},[event(1,'model_retry_scheduled',{retry_attempt:1,delay_ms:5000,provider_http_status:429,provider_error_status:'RESOURCE_EXHAUSTED'}),event(2,'failed',{error_code:'model_request_failed',provider_http_status:429,provider_error_status:'RESOURCE_EXHAUSTED'})]);
 assert.equal(stage(r,'model').status,'failed');assert.equal(r.timeline[0].retry_attempt,1);assert.match(r.failure_summary.message,/용량 제한/);assert.ok(!r.failure_summary.message.includes('출력 형식'));assert.equal(stage(r,'business').status,'blocked');
});

test('incomplete critic response fails reviewer stage, not completed model or evidence validation',()=>{
 const r=projectStages({status:'failed'},[event(1,'tools_requested',{toolCalls:[]}),event(2,'answer_validation_started'),event(3,'review_started'),event(4,'failed',{error_code:'answer_validation_failed',provider_incomplete_reason:'max_output_tokens'})]);
 assert.equal(stage(r,'ai_review').status,'failed');assert.equal(stage(r,'model').status,'completed');assert.equal(stage(r,'evidence_validation').status,'completed');assert.match(r.failure_summary.message,/AI 검토.*출력 한도/);assert.equal(stage(r,'result_storage').status,'blocked');
});
test('main model content filtering differs from unknown incomplete response without exposing arbitrary reason',()=>{
 for(const [reason,word] of [['content_filter','콘텐츠 필터'],['unknown','세부 이유']]){
  const r=projectStages({status:'failed'},[event(1,'started'),event(2,'failed',{error_code:'model_request_failed',provider_incomplete_reason:reason})]);
  assert.equal(stage(r,'model').status,'failed');assert.match(r.failure_summary.message,new RegExp(word));assert.equal(stage(r,'ai_review').status,'blocked');
 }
 const bad=projectStages({status:'failed'},[event(1,'failed',{error_code:'model_request_failed',provider_incomplete_reason:'private-sensitive-text'})]);assert.ok(!JSON.stringify(bad).includes('private-sensitive-text'));
});

test('application turn exhaustion is not provider quota or a failed model API',()=>{
 const r=projectStages({status:'failed',error_code:'investigation_step_limit'},[event(1,'tools_requested',{toolCalls:[]}),event(2,'exhausted',{error_code:'step_limit'})]);
 assert.equal(stage(r,'model').status,'completed');assert.equal(stage(r,'evidence_validation').status,'blocked');assert.equal(r.failure_summary.error_code,'investigation_step_limit');assert.equal(r.failure_summary.stage,null);assert.match(r.failure_summary.message,/조사 횟수 한도/);assert.equal(r.failure_summary.provider_http_status,undefined);
});
test('persisted parent exhaustion code is sufficient even when checkpoints are truncated',()=>{
 const r=projectStages({status:'failed',error_code:'investigation_step_limit'},[],{truncated:true});
 assert.equal(r.failure_summary.error_code,'investigation_step_limit');assert.equal(r.stage_coverage,'partial_checkpoints');assert.equal(stage(r,'model').status,'blocked');
});

test('metrics distinguish missing historical data from recorded zero and exclude unrelated fields',()=>{
 const old=projectRunMetrics({});assert.equal(old.count_policy,null);assert.equal(old.elapsed_ms,null);assert.ok(Object.values(old.metrics).every(value=>value===null));
 const fresh=projectRunMetrics({count_policy:'unset',elapsed_ms:0,metrics:{model_response_count:2,review_response_count:0,retry_count:1,reported_usage_response_count:2,total_tokens:400,raw:'private'}});
 assert.equal(fresh.count_policy,'unset');assert.equal(fresh.elapsed_ms,0);assert.equal(fresh.metrics.review_response_count,0);assert.equal(fresh.metrics.total_tokens,400);assert.equal(fresh.metrics.raw,undefined);
});
test('metrics reject negative fractional and unsafe counts without inventing zeros',()=>{
 const result=projectRunMetrics({count_policy:'arbitrary',elapsed_ms:-1,metrics:{total_tokens:Number.MAX_SAFE_INTEGER+1,retry_count:1.5,model_response_count:'10'}});
 assert.equal(result.count_policy,null);assert.equal(result.elapsed_ms,null);assert.equal(result.metrics.total_tokens,null);assert.equal(result.metrics.retry_count,null);assert.equal(result.metrics.model_response_count,null);
});

test('independent action-commitment review withholds answer even after stored completion',()=>{
 const r=projectStages({status:'needs_review',review_accepted:true,answer:null},[event(1,'review_completed',{review:{accepted:true}}),event(2,'completed'),event(3,'diagnostic',{stage:'ai_review',error_code:'unsupported_action_commitment'})]);
 assert.equal(stage(r,'ai_review').status,'failed');assert.equal(r.failure_summary.error_code,'unsupported_action_commitment');assert.match(r.failure_summary.message,/후속 행동 약속/);assert.notEqual(stage(r,'result_storage').status,'completed');
});
test('invalid code range then actual read is partial, while only unavailable remains failed',()=>{
 const bad=event(1,'tool_completed',{results:[{name:'read_code',result:{output:{status:'unavailable',error_code:'invalid_code_request'}}}]});
 const good=event(2,'tool_completed',{results:[{name:'read_code',result:{output:{status:'available'}}}]});
 const r=projectStages({status:'running'},[bad,good]);assert.equal(stage(r,'code').status,'partial');assert.equal(stage(r,'code').available,1);assert.equal(stage(r,'code').unavailable,1);assert.equal(stage(r,'code').source_read_observed,true);
 assert.equal(stage(projectStages({status:'running'},[bad]),'code').status,'failed');
});

test('historical investigations retain exactly the original ten stages',()=>{
 const expected=['receipt','model','business','server_logs','client_errors','code','evidence_validation','ai_review','result_storage','external_delivery'];
 for(const run of [{status:'running'},{status:'failed'},{status:'completed',review_accepted:true,answer:{},tool_names:['read_code','query_runtime_logs']}]){
  const r=projectStages(run,[event(1,'tool_completed',{results:[{name:'read_code',result:{output:{status:'available'}}}]})]);
  assert.deepEqual(r.stages.map(s=>s.id),expected);assert.equal(stage(r,'deployment'),undefined);
 }
});

test('parent deployment tool names add a waiting stage without inventing an observation',()=>{
 for(const name of ['read_public_deployment_identity','read_deployment_observation_snapshot']){
  const r=projectStages({status:'running',tool_names:[name]},[],{truncated:true});
  assert.equal(r.stages.length,11);assert.equal(stage(r,'deployment').label,'배포 정보 확인');
  assert.equal(stage(r,'deployment').status,'waiting');assert.equal(stage(r,'deployment').attempts,0);
  assert.equal(r.stage_coverage,'partial_checkpoints');
 }
 const unknown=projectStages({status:'running',tool_names:['read_deployment_secret']},[]);
 assert.equal(unknown.stages.length,10);
});

test('requested or completed deployment checkpoints discover the stage without parent tool_names',()=>{
 const pending=projectStages({status:'running'},[event(1,'tools_requested',{toolCalls:[{name:'read_public_deployment_identity',arguments:{}}]})]);
 assert.equal(pending.stages.length,11);assert.equal(stage(pending,'deployment').status,'running');
 const done=projectStages({status:'running'},[event(1,'tool_completed',{results:[{name:'read_deployment_observation_snapshot',result:{output:{status:'available'}}}]})]);
 assert.equal(done.stages.length,11);assert.equal(stage(done,'deployment').status,'completed');
 assert.equal(stage(done,'deployment').available,1);assert.equal(stage(done,'deployment').attempts,1);
});

test('health denial and available deployment snapshot are partial in either order, without failing the run',()=>{
 const denied={name:'read_public_deployment_identity',result:{output:{status:'unavailable',error_code:'source_access_denied',http_status:403}}};
 const available={name:'read_deployment_observation_snapshot',result:{output:{status:'available',rows:[{private:'hidden-observation',headers:{Authorization:'Bearer hidden-credential'}}]}}};
 for(const results of [[denied,available],[available,denied]]){
  const r=projectStages({status:'completed',review_accepted:true,answer:{},delivery_status:'not_sent'},results.map((item,i)=>event(i+1,'tool_completed',{results:[item]})));
  assert.equal(stage(r,'deployment').status,'partial');assert.equal(stage(r,'deployment').available,1);
  assert.equal(stage(r,'deployment').unavailable,1);assert.equal(stage(r,'deployment').attempts,2);
  assert.equal(stage(r,'deployment').error_code,'source_access_denied');assert.equal(r.failure_summary,null);
  assert.equal(stage(r,'result_storage').status,'completed');assert.equal(stage(r,'external_delivery').status,'not_connected');
  assert.deepEqual(r.timeline.map(t=>t.stage),['deployment','deployment']);
  assert.ok(!JSON.stringify(r).includes('hidden-observation'));assert.ok(!JSON.stringify(r).includes('hidden-credential'));
 }
});

test('only failed deployment observations stay failed without implying another source failed',()=>{
 const r=projectStages({status:'running'},[event(1,'tool_completed',{results:[{name:'read_public_deployment_identity',result:{output:{status:'unavailable',error_code:'deployment_non_json'}}}]})]);
 assert.equal(stage(r,'deployment').status,'failed');assert.equal(stage(r,'deployment').error_code,'deployment_non_json');
 assert.equal(stage(r,'business').status,'waiting');assert.equal(stage(r,'server_logs').status,'waiting');assert.equal(r.failure_summary,null);
});

test('deployment diagnostics expose only known codes and omit raw response details',()=>{
 for(const error_code of ['source_timeout','invalid_deployment_request','invalid_deployment_observation','deployment_redirect','deployment_non_json','deployment_invalid_schema','deployment_response_too_large','deployment_invalid_json']){
  const diagnostics=safeDiagnostics({error_code,message:'private-message',response:{headers:{Authorization:'Bearer private-token'}},url:'https://private.invalid'});
  assert.deepEqual(diagnostics,{error_code});
 }
 assert.deepEqual(safeDiagnostics({error_code:'deployment_private_dynamic_error'}),{});
 const r=projectStages({status:'failed',tool_names:['read_public_deployment_identity']},[event(1,'diagnostic',{stage:'deployment',error_code:'deployment_invalid_schema',message:'private-message'})]);
 assert.equal(r.failure_summary.stage,'deployment');assert.equal(r.failure_summary.error_code,'deployment_invalid_schema');
 assert.equal(stage(r,'deployment').status,'failed');assert.ok(!JSON.stringify(r).includes('private-message'));
});
