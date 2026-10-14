import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateHash} from '../qa-shared/candidate-integrity.mjs';
import {createEvidenceJoinInput,validateEvidenceJoin} from './review-evidence-join.mjs';

const id=n=>'ev_'+String(n).repeat(64);
function fixture({status='available',counter=false}={}) {
  const claim={claim_id:'atom_x',source_claim_id:'facts/0',source_sha256:'a'.repeat(64),value:'요청 r1의 화면 오류와 서버 200이 함께 관측됐습니다.',requires_support:true};
  const raw=[{evidence_id:id(1),status,request_id:'r1',time:'2026-10-13T08:00:00Z',client_error:true},
    {evidence_id:id(2),status,request_id:'r1',time:'2026-10-13T08:00:00Z',status_code:200}];
  const observations=raw.map(raw=>({evidence_id:raw.evidence_id,content_sha256:candidateHash(raw),raw}));
  const assessments=observations.map((e,i)=>({claim_id:claim.claim_id,evidence_id:e.evidence_id,part_index:0,relation:counter&&i===1?'counter':'unknown',support_kind:'none',note:'단일 자료만으로 결합은 미확인'}));
  const options={claim,observations,assessments,answer:{facts:[{claim:claim.value}]},report:{title:'목록 오류'},verificationRecords:[]};
  const input=createEvidenceJoinInput(options);
  const anchor=evidence_id=>({evidence_id,json_pointer:'/request_id',quote:'"r1"'});
  const result={manifest_sha256:input.manifest_sha256,claim_id:claim.claim_id,accepted:true,
    inspected_evidence_ids:[id(1),id(2)],supporting_evidence_ids:[id(1),id(2)],supporting_anchors:[anchor(id(1)),anchor(id(2))],
    claim_fidelity:'faithful',connection_explanation:'두 원본의 요청 r1 및 시각이 같습니다.',
    gaps:input.unresolved.map(a=>({assessment_sha256:a.assessment_sha256,resolution:'resolved_by_evidence',evidence_ids:[id(1),id(2)],anchors:[anchor(id(1)),anchor(id(2))],condition:'동일 요청의 클라이언트와 서버 관측 연결',explanation:'같은 요청 식별자로 연결했습니다.'})),findings:[]};
  return {input,result,options};
}
const rejects=(input,result)=>assert.throws(()=>validateEvidenceJoin(input,result),{code:'investigation_review_join_binding_invalid'});

test('two locally unknown sources are eligible for joint verification with full originals',()=>{
  const {input,result}=fixture();
  assert.ok(input.local_assessments.every(a=>a.relation==='unknown'));
  assert.equal(validateEvidenceJoin(input,result).accepted,true);
  assert.equal(input.evidence[0].raw.client_error,true);
  assert.equal(input.evidence[1].raw.status_code,200);
});
test('unavailable observations and counterevidence cannot be approved by a join',()=>{
  for(const options of [{status:'unavailable'},{counter:true}]){
    const {input,result}=fixture(options);rejects(input,result);
  }
});
test('every unknown must have one bound disposition; all not_required cannot replace missing factual support',()=>{
  for(const mutate of [r=>r.gaps.pop(),r=>r.gaps.push(r.gaps[0]),r=>r.gaps[0].assessment_sha256='0'.repeat(64),r=>r.gaps[0].resolution='unresolved',r=>{r.gaps.forEach(g=>{g.resolution='not_required';g.evidence_ids=[];g.anchors=[];});r.supporting_evidence_ids=[];r.supporting_anchors=[];}]){
    const {input,result}=fixture();mutate(result);rejects(input,result);
  }
});
test('foreign or missing observations, forged pointers, changed quotes and reused verdicts fail',()=>{
  for(const mutate of [r=>r.claim_id='another',r=>r.manifest_sha256='0'.repeat(64),r=>r.inspected_evidence_ids.pop(),r=>r.inspected_evidence_ids.push(id(1)),r=>r.supporting_evidence_ids.push(id(3)),r=>r.supporting_anchors[0].json_pointer='/missing',r=>r.supporting_anchors[0].quote='"r2"',r=>r.gaps[0].anchors=[]]){
    const {input,result}=fixture();mutate(result);rejects(input,result);
  }
});
test('request, time, response and raw hash changes cannot reuse a prior join',()=>{
  for(const field of ['request_id','time','status_code']){
    const {input,result}=fixture();input.evidence[1].raw[field]='changed';rejects(input,result);
  }
  const {options,input,result}=fixture();options.observations[1].raw.request_id='r2';
  options.observations[1].content_sha256=candidateHash(options.observations[1].raw);
  const changed=createEvidenceJoinInput(options);
  assert.notEqual(changed.manifest_sha256,input.manifest_sha256);rejects(changed,result);
});
test('whole original context is preserved and incomplete original fragment coverage fails before model calls',()=>{
  const {options}=fixture();options.reviewManifestHash='a'.repeat(64);
  options.parts=options.observations.flatMap(o=>[0,1].map(i=>({evidence_id:o.evidence_id,content_sha256:o.content_sha256,part_index:i,part_count:2,part_id:o.evidence_id+':'+i})));
  const full=createEvidenceJoinInput(options);
  assert.equal(full.manifest.parts.length,4);
  options.parts.pop();assert.throws(()=>createEvidenceJoinInput(options),{code:'investigation_review_join_binding_invalid'});
});
test('an honest unresolved conclusion remains rejected with its original evidence references',()=>{
  const {input,result}=fixture();result.accepted=false;result.supporting_evidence_ids=[];result.supporting_anchors=[];
  result.gaps.forEach(g=>g.resolution='unresolved');result.findings=[{message:'같은 실행인지 확인할 정보가 부족합니다.',evidence_ids:[id(1),id(2)]}];
  assert.equal(validateEvidenceJoin(input,result).accepted,false);
});
test('source context and source hash are bound to the join and cannot reuse a prior verdict',()=>{
  for(const field of ['source_context','source_sha256']){
    const {input,result}=fixture();input.claim[field]='changed';rejects(input,result);
  }
  const {input,result}=fixture();result.claim_fidelity='decomposition_error';rejects(input,result);
});
test('an indirectly relevant trace mapping remains available even when local audit called it irrelevant',()=>{
  const {options}=fixture();
  const raw={evidence_id:id(3),status:'available',trace_id:'T',execution_id:'U',request_id:'r1'};
  options.observations.push({evidence_id:id(3),content_sha256:candidateHash(raw),raw});
  options.assessments.push({claim_id:options.claim.claim_id,evidence_id:id(3),part_index:0,relation:'irrelevant',support_kind:'none',note:'직접 오류 또는200 기록은 아닙니다.'});
  const input=createEvidenceJoinInput(options);
  assert.equal(input.evidence.length,3);
  assert.equal(input.evidence.find(e=>e.evidence_id===id(3)).raw.execution_id,'U');
  assert.equal(input.local_assessments.find(a=>a.evidence_id===id(3)).relation,'irrelevant');
});
