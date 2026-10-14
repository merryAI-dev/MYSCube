import {candidateHash} from '../qa-shared/candidate-integrity.mjs';
const fail=()=>{throw Object.assign(new Error('issue_source_proof_invalid'),{code:'issue_source_proof_invalid'});};
export function verifyIssueSourceProof({case:qa,run,dispatch,delivery,grant,checkpoints,now=Date.now()}) {
 if(!qa||!run||!dispatch||!delivery||!grant||!Array.isArray(checkpoints))fail();
 const runId=`qa-${qa.investigation_event_id}`;
 if(run.run_id!==runId||dispatch.run_id!==runId||run.case_id!==qa.case_id||delivery.case_id!==qa.case_id||delivery.run_id!==runId
   ||qa.case_status==='cancelled'||qa.execution_status!=='completed'||run.status!=='completed'||dispatch.status!=='completed'
   ||run.case_actor_id!==qa.actor_id||run.case_aggregate_version!==qa.aggregate_version
   ||run.case_input_hash!==candidateHash({actor_id:qa.actor_id,aggregate_version:qa.aggregate_version,title:qa.title,description:qa.description,investigation_scope:qa.investigation_scope})
   ||run.review?.accepted!==true||run.review.findings?.length!==0)fail();
 if(grant.case_id!==qa.case_id||grant.actor_id!==qa.actor_id||grant.status!=='ACTIVE'||grant.repository!=='merryAI-dev/MYSCube'
   ||!Number.isFinite(Date.parse(grant.expires_at))||Date.parse(grant.expires_at)<=now)fail();
 const ordered=[...checkpoints].sort((a,b)=>b.sequence-a.sequence);
 const finalized=ordered.find(c=>c.phase==='tool_completed'&&c.payload?.results?.some(r=>r.name==='finalize_investigation'&&r.result?.accepted===true));
 if(!finalized||!Number.isSafeInteger(finalized.sequence))fail();
 const calls=finalized.payload.toolCalls?.filter(c=>c.name==='finalize_investigation')||[];
 if(calls.length!==1||candidateHash(calls[0].args)!==candidateHash(run.answer))fail();
 let restoredSequence=null;
 if(finalized.payload.origin==='persisted_draft_restore') {
  const snapshotHash=finalized.payload.source_snapshot_sha256;
  const saved=ordered.find(c=>c.sequence<finalized.sequence&&c.phase==='pending_answer_saved'
    &&c.payload?.pending_answer?.snapshot_sha256===snapshotHash);
  const restored=ordered.find(c=>c.sequence<finalized.sequence&&c.phase==='pending_answer_restored'
    &&c.payload?.source_snapshot_sha256===snapshotHash);
  if(!saved||!restored||!Number.isSafeInteger(saved.sequence)||!Number.isSafeInteger(restored.sequence)||saved.sequence>=restored.sequence)fail();
  restoredSequence=restored.sequence;
  const {snapshot_sha256,...body}=saved.payload.pending_answer;
  const binding=body.context?.run_binding;
  if(candidateHash(body)!==snapshot_sha256||candidateHash(body.answer)!==candidateHash(run.answer)
    ||binding?.run_id!==run.run_id||binding?.case_id!==qa.case_id
    ||binding?.case_input_hash!==run.case_input_hash||binding?.aggregate_version!==qa.aggregate_version
    ||restored.payload.source_session_id!==body.origin?.session_id
    ||restored.payload.source_call_id!==body.origin?.call_id
    ||!Number.isSafeInteger(body.origin?.step)||body.origin.step!==restored.payload.step
    ||body.origin.step!==finalized.payload.step)fail();
 }
 const review=ordered.find(c=>c.sequence<finalized.sequence&&c.phase==='review_completed');
 if(restoredSequence!==null&&(!review||!Number.isSafeInteger(review.sequence)||review.sequence<=restoredSequence))fail();
 if(!review||review.payload?.review?.accepted!==true||candidateHash(review.payload.review)!==candidateHash(run.review))fail();
 return {answer_sha256:candidateHash(run.answer),review_sha256:candidateHash(run.review),finalized_sequence:finalized.sequence,review_sequence:review.sequence,grant_expires_at:grant.expires_at};
}
