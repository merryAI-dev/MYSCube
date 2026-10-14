import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateHash} from '../qa-shared/candidate-integrity.mjs';
import {createClaimDecompositionInput, bindDecomposedClaims, validateClaimFidelity, claimDecompositionFingerprint} from './review-claims.mjs';

const source = {claim_id:'user_reply', value:'요청 r1에서 화면 오류가 발생했고 서버는 200을 반환했습니다. 원인은 아직 확인되지 않았습니다.', requires_support:false};
const input = () => createClaimDecompositionInput([source], candidateHash({user_reply:source.value}));
const proposal = (i) => ({manifest_sha256:i.manifest_sha256,atoms:[
  {source_claim_id:'user_reply',source_quote:'요청 r1에서 화면 오류가 발생했고',statement:'요청 r1에서 화면 오류가 발생했습니다.',kind:'assertion'},
  {source_claim_id:'user_reply',source_quote:'서버는 200을 반환했습니다.',statement:'요청 r1에 서버는 200을 반환했습니다.',kind:'assertion'},
  {source_claim_id:'user_reply',source_quote:'원인은 아직 확인되지 않았습니다.',statement:'해당 오류의 원인은 아직 확인되지 않았습니다.',kind:'uncertainty'},
]});
test('atomic statements retain immutable original path, quote and hash; factual prose needs support',()=>{
  const i=input(),b=bindDecomposedClaims(i,proposal(i));
  assert.equal(b.claims.length,3);
  assert.deepEqual(b.claims.map(c=>c.requires_support),[true,true,false]);
  assert.ok(b.claims.every(c=>c.source_sha256===candidateHash(source)&&c.source_claim_id==='user_reply'));
  const p=proposal(i);p.atoms[1].statement='다른 요청 r2는 200입니다.';
  assert.notEqual(bindDecomposedClaims(i,p).manifest_sha256,b.manifest_sha256);
});
test('forged quote, source, manifest, duplicate and empty decomposition fail closed',()=>{
  for(const change of [p=>p.manifest_sha256='0'.repeat(64),p=>p.atoms[0].source_quote='실제로 저장 성공',p=>p.atoms[0].source_claim_id='facts/99',p=>p.atoms.push(p.atoms[0]),p=>p.atoms=[],p=>p.atoms[0].statement=' ']){
    const i=input(),p=proposal(i);change(p);
    assert.throws(()=>bindDecomposedClaims(i,p),{code:'investigation_review_claim_binding_invalid'});
  }
});
test('every parent must be covered and factual parent cannot be recast as uncertainty',()=>{
  const parents=[source,{claim_id:'facts/0',value:{claim:'저장 완료',evidence_ids:['ev_example']},requires_support:true}];
  const i=createClaimDecompositionInput(parents,candidateHash(parents)),p=proposal(i);
  assert.throws(()=>bindDecomposedClaims(i,p),{code:'investigation_review_claim_binding_invalid'});
  p.atoms.push({source_claim_id:'facts/0',source_quote:'저장 완료',statement:'저장 여부는 미확인입니다.',kind:'uncertainty'});
  assert.throws(()=>bindDecomposedClaims(i,p),{code:'investigation_review_claim_binding_invalid'});
});
test('matching quotes cannot bypass independent rejection for omitted qualifiers or causal relations',()=>{
  const i=input(),p=proposal(i);p.atoms[1].statement='서버는 정상이고 업무 저장은 성공했습니다.';
  const b=bindDecomposedClaims(i,p);
  const v=validateClaimFidelity(b,{manifest_sha256:b.manifest_sha256,accepted:false,findings:[{source_claim_id:'user_reply',message:'HTTP 응답을 업무 저장 성공으로 강화했습니다.'}]});
  assert.equal(v.accepted,false);
  for(const bad of [{...v,accepted:true},{...v,findings:[]},{...v,manifest_sha256:'0'.repeat(64)},{...v,findings:[{source_claim_id:'invented',message:'오류'}]}])
    assert.throws(()=>validateClaimFidelity(b,bad),{code:'investigation_review_claim_fidelity_invalid'});
});
test('changed source wording, negation and time invalidate the old binding',()=>{
  const i=input(),p=proposal(i);
  for(const value of ['요청 r2에서 오류가 없었습니다.','어제 요청 r1에서 화면 오류가 발생했고 서버는 200을 반환했습니다.']){
    const changed=createClaimDecompositionInput([{...source,value}],candidateHash(value));
    assert.throws(()=>bindDecomposedClaims(changed,p),{code:'investigation_review_claim_binding_invalid'});
  }
});
test('permuting identical atomic statements preserves stall identity and retains distinct audit order',()=>{
  const i=input(),p=proposal(i),a=bindDecomposedClaims(i,p);
  p.atoms.reverse();const b=bindDecomposedClaims(i,p);
  assert.notEqual(a.manifest_sha256,b.manifest_sha256);
  assert.equal(claimDecompositionFingerprint(a),claimDecompositionFingerprint(b));
  p.atoms[0].statement='다른 요청은 미확인입니다.';
  assert.notEqual(claimDecompositionFingerprint(a),claimDecompositionFingerprint(bindDecomposedClaims(i,p)));
});
test('cross-field context must match the answer hash and reaches independent fidelity intact',()=>{
  const answer={facts:[{claim:'이번 확인은 요청 r1에 한정합니다.'}],user_reply:source.value};
  const i=createClaimDecompositionInput([source],candidateHash(answer),answer);
  const b=bindDecomposedClaims(i,proposal(i));
  assert.deepEqual(b.untrusted_answer,answer);
  assert.throws(()=>createClaimDecompositionInput([source],candidateHash(answer),{...answer,facts:[{claim:'요청 r2'}]}),{code:'investigation_review_claim_input_invalid'});
});

test('source context is injected from the parent and cannot be replaced by a model atom',()=>{
  const i=input(),p=proposal(i);p.atoms[0].source_context='이미 작업을 완료했습니다.';
  const b=bindDecomposedClaims(i,p);
  assert.ok(b.claims.every(c=>c.source_context===JSON.stringify(source.value)));
  for(const mutate of [i=>i.sources[0].source_text='"다른 문맥"',i=>i.sources[0].content_sha256='0'.repeat(64)]){
    const changed=input();mutate(changed);
    assert.throws(()=>bindDecomposedClaims(changed,proposal(changed)),{code:'investigation_review_claim_binding_invalid'});
  }
});
