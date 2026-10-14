import test from 'node:test';
import assert from 'node:assert/strict';
import {createDiscoveredProjectTools} from './discovered-project-tools.mjs';
const binding={tenant_id:'mysc',case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',case_input_hash:'a'.repeat(64),aggregate_version:1};
const id='p1779092105308',other='p1779092105309';
const evidence=(project=id)=>({evidence_id:`ev_${(project===id?'a':'b').repeat(64)}`,source:'query_live_vercel_request_logs',status:'available',observed_at:'2026-10-14T00:00:00Z',...binding,project});
function setup(){
 const reads=[],checks=[],instances=[];let denied=false,afterRead=()=>{};
 const adapter=createDiscoveredProjectTools({runBinding:binding,
  requestLogAnchors:e=>e.source==='query_live_vercel_request_logs'?[{path:`/api/v1/cashflow/${e.project}/month-close`}]:[],
  authorizeProject:async project=>{checks.push(project);if(denied)throw Error('revoked');},
  createSources(project){const state={project,pages:0};instances.push(state);return {tools:{read_project_state:{description:'read project',parameters:{type:'object',additionalProperties:false,required:['project_id'],properties:{project_id:{type:'string',enum:[project]}}},execute:async args=>{assert.equal(args.project_id,project);reads.push(project);state.pages++;await afterRead();return {project,page:state.pages};}}}};},
 });
 return {adapter,reads,checks,instances,deny:()=>denied=true,allow:()=>denied=false,after:fn=>afterRead=fn};
}
test('unobserved project and client-only claims cannot trigger authority or data reads',async()=>{
 const f=setup();f.adapter.observeEvidence({...evidence(),source:'query_client_errors'});
 await assert.rejects(f.adapter.tools.read_project_state.execute({project_id:id}),/unobserved/);
 assert.deepEqual(f.reads,[]);assert.deepEqual(f.checks,[]);
 assert.throws(()=>f.adapter.observeEvidence({...evidence(),run_id:'qa-33333333-3333-4333-8333-333333333333'}),/binding_mismatch/);
});
test('server-discovered project uses matching source policy and checks authority before and after every read',async()=>{
 const f=setup();f.adapter.observeEvidence(evidence());
 assert.deepEqual(await f.adapter.tools.read_project_state.execute({project_id:id}),{project:id,page:1});
 assert.deepEqual(f.checks,[id,id]);
 assert.equal(JSON.stringify(f.adapter.tools.read_project_state.parameters).includes('p0000000000'),false);
 f.deny();await assert.rejects(f.adapter.tools.read_project_state.execute({project_id:id}),/revoked/);
 assert.equal(f.reads.length,1);
});
test('post-read revocation discards output and cached source, resumed access rechecks authority',async()=>{
 const f=setup();f.adapter.observeEvidence(evidence());f.after(()=>f.deny());
 await assert.rejects(f.adapter.tools.read_project_state.execute({project_id:id}),/revoked/);
 f.allow();f.after(()=>{});
 assert.deepEqual(await f.adapter.tools.read_project_state.execute({project_id:id}),{project:id,page:1});
});
test('concurrent distinct project reads preserve separate policy and pagination',async()=>{
 const f=setup();f.adapter.observeEvidence(evidence());f.adapter.observeEvidence(evidence(other));
 const read=project_id=>f.adapter.tools.read_project_state.execute({project_id});
 assert.deepEqual(await Promise.all([read(id),read(other)]),[{project:id,page:1},{project:other,page:1}]);
 assert.deepEqual(await read(id),{project:id,page:2});
 await assert.rejects(f.adapter.tools.read_project_state.execute({project_id:id,other_project:other}),/unobserved/);
});

test('pre-read denial invalidates previously successful pagination before reauthorization',async()=>{
 const f=setup();f.adapter.observeEvidence(evidence());
 await f.adapter.tools.read_project_state.execute({project_id:id});
 f.deny();await assert.rejects(f.adapter.tools.read_project_state.execute({project_id:id}),/revoked/);
 f.allow();assert.deepEqual(await f.adapter.tools.read_project_state.execute({project_id:id}),{project:id,page:1});
});
test('nonenumerable trace dependency resolver survives the wrapper without source reads',()=>{
 const adapter=createDiscoveredProjectTools({runBinding:binding,requestLogAnchors:()=>[{path:`/api/v1/cashflow/${id}/month-close`}],authorizeProject:()=>assert.fail('no network'),createSources(project){
  const tool={description:'trace',parameters:{type:'object',properties:{project_id:{type:'string',enum:[project]}}},execute:()=>assert.fail('no reads')};
  Object.defineProperty(tool,'blockedBy',{value:()=>({reason_code:'trace_missing',evidence_ids:[evidence().evidence_id]})});
  return {tools:{query_trace:tool}};
 }});
 assert.equal(adapter.tools.query_trace.blockedBy({evidence:new Map()}),null);
 adapter.observeEvidence(evidence());
 assert.deepEqual(adapter.tools.query_trace.blockedBy({evidence:new Map()}),{reason_code:'trace_missing',evidence_ids:[evidence().evidence_id]});
});
