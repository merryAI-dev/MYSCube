import test from 'node:test';
import assert from 'node:assert/strict';
import {collectInitialObservation} from './initial-observation.mjs';
import {candidateHash} from '../qa-shared/candidate-integrity.mjs';
import {createSessionContext,verifyStoredEvidence} from './session-context.mjs';
import {evidenceRecord} from './runner-persistence.mjs';
const runBinding={tenant_id:'mysc',case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',case_input_hash:'a'.repeat(64),aggregate_version:1};
function fixture(status='available') {
  const body={source:'query_client_errors',status,observed_at:'2026-10-14T00:00:00Z',rows:[],next_cursor:'continue-here',coverage:{complete:false}};
  const hash=candidateHash(body), output={...body,content_hash:hash,evidence_id:`ev_${hash}`};
  let calls=0,checks=0;const records=[];
  const ledger=createSessionContext({runBinding,report:{text:'Actual error report'},priorEvidence:[]});
  const config={runBinding,policy:{allowedStartAt:'2026-10-12T00:00:00Z',allowedEndAt:'2026-10-13T00:00:00Z'},
    tools:{query_client_errors:{execute:async args=>{calls++;assert.deepEqual(args,{start_at:config.policy.allowedStartAt,end_at:config.policy.allowedEndAt});return output;}}},
    authorize:async()=>{checks++;},onCheckpoint:async event=>{
      assert.equal(event.origin,'initial_observation');
      const item=event.results[0].result.output;
      records.push({documentId:item.evidence_id,stored:evidenceRecord({item,runBinding,ledger,alreadyStored:false})});
    }};
  return {config,output,records,calls:()=>calls,checks:()=>checks};
}
test('provider failure leaves a resumable first observation and its cursor',async()=>{
  const f=fixture();let models=0;
  await assert.rejects(async()=>{await collectInitialObservation(f.config);models++;throw Error('provider_credit_exhausted');},/provider_credit/);
  assert.equal(models,1);assert.equal(f.checks(),2);assert.equal(f.records.length,1);
  const prior=verifyStoredEvidence({...f.records[0],runBinding}).evidence;
  assert.equal(prior.next_cursor,'continue-here');assert.equal(prior.coverage.complete,false);
  await collectInitialObservation({...f.config,priorEvidence:[prior]});assert.equal(f.calls(),1);
});
test('storage failure or post-read revocation prevents model progression',async()=>{
  for(const kind of ['storage','revocation']) {
    const f=fixture();let models=0,checks=0;
    if(kind==='storage')f.config.onCheckpoint=async()=>{throw Error('storage');};
    else f.config.authorize=async()=>{if(++checks===2)throw Error('revocation');};
    await assert.rejects(async()=>{await collectInitialObservation(f.config);models++;},new RegExp(kind));
    assert.equal(models,0);assert.equal(f.records.length,0);
  }
});
test('unavailable source is recorded without declaring no errors or preventing other investigation',async()=>{
  const f=fixture('unavailable');await collectInitialObservation(f.config);
  assert.equal(f.records[0].stored.status,'unavailable');
});
test('unrelated evidence does not skip intake while existing resumed sessions are preserved',async()=>{
  const f=fixture();await collectInitialObservation({...f.config,priorEvidence:[{...f.output,source:'other_source'}]});assert.equal(f.calls(),1);
  for(const field of ['resumeSession','pendingAnswer'])await collectInitialObservation({...f.config,[field]:{existing:true}});
  assert.equal(f.calls(),1);
});

test('actual runner checkpoint commits evidence before exposing it to the model context', async () => {
  const {readFile}=await import('node:fs/promises');
  const {runInNewContext}=await import('node:vm');
  const persistence=await import('./runner-persistence.mjs');
  const {emptyMetrics,checkpointMetrics}=await import('./metrics.mjs');
  const source=await readFile(new URL('./runner.mjs',import.meta.url),'utf8');
  const body=source.slice(source.indexOf('async function checkpoint(event)'),source.indexOf('async function validateAnswer(answer)'));
  assert.ok(source.indexOf('if (pipeline) await collectInitialObservation')<source.indexOf('investigationPlan = await planOpenAIInvestigation'));
  for(const succeeds of [true,false]) {
    const f=fixture(),writes=[];
    const context={...persistence,checkpointMetrics,checkpointCount:0,metrics:emptyMetrics(),currentStage:'preparing',toolCount:0,
      observedTools:new Set(),observedEvidence:new Map(),runBinding,runId:runBinding.run_id,runPath:'runs/test',
      sessionLedger:createSessionContext({runBinding,report:{text:'Error'},priorEvidence:[]}),
      observeRuntimeEvidence:()=>{},observeSourceEvidence:()=>{},lastStep:0,pipeline:{},startedAtMs:Date.now(),
      priorEvidence:[],priorEvidenceRecords:[],create:(path,data)=>({path,data}),update:(path,data)=>({path,data}),
      durableSession:null,durablePending:null,durableReviewReceipt:null,knownReviewReceipts:new Set(),console:{log:()=>{}},
      commit:async changes=>{if(!succeeds)throw Error('storage');writes.push(...changes);}};
    runInNewContext(body+'\nthis.runCheckpoint=checkpoint;',context);
    const promise=collectInitialObservation({...f.config,onCheckpoint:context.runCheckpoint});
    if(!succeeds) {
      await assert.rejects(promise,/storage/);assert.equal(context.priorEvidenceRecords.length,0);continue;
    }
    await promise;
    assert.equal(writes.length,3);
    assert.equal(context.priorEvidenceRecords.length,1);
    assert.equal(context.priorEvidence[0].next_cursor,'continue-here');
    const restored=createSessionContext({runBinding,report:{text:'Error'},priorEvidence:context.priorEvidenceRecords});
    assert.equal(restored.manifestPage({maxBytes:32768}).manifest_hash,context.sessionLedger.manifestPage({maxBytes:32768}).manifest_hash);
  }
});
