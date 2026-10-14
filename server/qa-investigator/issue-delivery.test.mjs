import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {deliverReviewedIssue,validateIssueDraft} from './issue-delivery.mjs';
const caseId='9acdd105-b571-48c1-8cd8-e12ee618a224';
const qa={case_id:caseId,actor_id:'actor',aggregate_version:1,title:'제목',description:'내용',investigation_scope:{scope_kind:'platform'}};
const {case_id,...hashInput}=qa;
function fixture(){
 let data=null,version=0,issues=[],creates=0,loseResponse=false,revoked=false;
 const f={caseId,store:{read:async()=>data?{value:structuredClone(data),version}:null,compareAndSet:async(v,d)=>{if(v!==(data?version:null))return false;data=structuredClone(d);version++;return true;}},
 authorize:async()=>{if(revoked)throw Error('revoked');return{case:qa,run:{case_id:caseId,case_actor_id:qa.actor_id,case_aggregate_version:1,case_input_hash:candidateHash(hashInput),run_id:'qa-test',status:'completed',review:{accepted:true},answer:{cause_status:'not_established'}}};},
 generateDraft:async()=>({title:'현금흐름 목록 조회 실패',body:'현금흐름 목록이 오류로 바뀝니다. 원인은 아직 확정되지 않았습니다. 관련 실행 기록을 대조해야 합니다.'}),
 reviewDraft:async()=>({accepted:true,public_safe:true,findings:[]}),
 github:{find:async marker=>issues.find(x=>x.body.includes(marker)),get:async n=>issues.find(x=>x.number===n),create:async d=>{creates++;const i={...d,number:creates,html_url:`https://github.com/merryAI-dev/MYSCube/issues/${creates}`};issues.push(i);if(loseResponse)throw Error('lost');return i;}},
 setLost:v=>loseResponse=v,setRevoked:v=>revoked=v,creates:()=>creates,record:()=>data};return f;
}
test('publishes verified reviewed result and repeated execution never duplicates',async()=>{const f=fixture();assert.equal((await deliverReviewedIssue(f)).status,'published');assert.equal(f.record().status,'published');await deliverReviewedIssue(f);assert.equal(f.creates(),1);});
test('lost create response reconciles server issue without repeating create',async()=>{const f=fixture();f.setLost(true);await assert.rejects(deliverReviewedIssue(f));assert.equal(f.record().status,'posting');f.setLost(false);assert.equal((await deliverReviewedIssue(f)).status,'published');assert.equal(f.creates(),1);});
test('concurrent publishers race through CAS to one mutation',async()=>{const f=fixture();await Promise.all([deliverReviewedIssue(f),deliverReviewedIssue(f)]);assert.equal(f.creates(),1);});
test('rejected public review and revoked authority prevent mutation',async()=>{const f=fixture();f.reviewDraft=async()=>({accepted:true,public_safe:false,findings:['private']});await assert.rejects(deliverReviewedIssue(f),/review_rejected/);assert.equal(f.creates(),0);f.setRevoked(true);await assert.rejects(deliverReviewedIssue(f),/revoked/);});
test('private IDs, email, hidden HTML and external links are not published',()=>{for(const suffix of [' req_1791874000000_123456789abc',' ai@mysc.co.kr',' p1779092105308',' <!-- hidden -->',' https://evil.example/a'])assert.throws(()=>validateIssueDraft({title:'현금흐름 목록 조회 실패',body:'확인된 기술 문제와 조치 내용을 구성원이 이해할 수 있도록 설명합니다.'+suffix}));});

test('source reversion or mutation immediately before publish prevents create',async()=>{for(const changed of [{status:'running'},{answer:{cause_status:'supported'}}]){const f=fixture(),original=f.authorize;let calls=0;f.authorize=async()=>{const source=await original();if(++calls===3)Object.assign(source.run,changed);return source;};await assert.rejects(deliverReviewedIssue(f),/issue_source_/);assert.equal(f.creates(),0);}});
test('relative, protocol-relative and reference Markdown links are rejected',()=>{for(const suffix of [' [자료](//external.example/private)',' [자료](/private)','\n[자료]: //external.example/private',' <a href="/private">자료</a>'])assert.throws(()=>validateIssueDraft({title:'현금흐름 목록 조회 실패',body:'확인된 기술 문제와 조치 내용을 구성원이 이해할 수 있도록 설명합니다.'+suffix}));});

test('foreign case binding never produces an issue',async()=>{const f=fixture(),original=f.authorize;f.authorize=async()=>{const s=await original();s.run.case_id='foreign';return s;};await assert.rejects(deliverReviewedIssue(f),/binding_invalid/);assert.equal(f.creates(),0);});

test('lost receipt CAS never reports a persisted publication and next run reconciles',async()=>{
 const f=fixture(),cas=f.store.compareAndSet;let rejectReceipt=true;
 f.store.compareAndSet=async(v,d)=>d.status==='published'&&rejectReceipt?false:cas(v,d);
 assert.equal((await deliverReviewedIssue(f)).status,'receipt_persistence_conflict');
 assert.equal(f.record().status,'posting');assert.equal(f.creates(),1);
 rejectReceipt=false;assert.equal((await deliverReviewedIssue(f)).status,'published');assert.equal(f.creates(),1);
});

test('automatic URL links are normalized and cannot escape the public repository',()=>{
 const draft={title:'현금흐름 목록 조회 실패',body:'확인된 기술 문제와 조치 내용을 구성원이 이해할 수 있도록 설명합니다. '};
 for(const url of ['HTTPS://internal.example/private','www.internal.example/private','https://github.com/merryAI-dev/MYSCube/blob/'+'a'.repeat(40)+'/../../../../private-repo/issues/12','https://github.com/merryAI-dev/MYSCube/blob/'+'a'.repeat(40)+'/%2e%2e/private','https://github.com/merryAI-dev/MYSCube/issues/12?private=value'])assert.throws(()=>validateIssueDraft({...draft,body:draft.body+url}),/external_link/);
 assert.doesNotThrow(()=>validateIssueDraft({...draft,body:draft.body+'https://github.com/merryAI-dev/MYSCube/blob/'+'a'.repeat(40)+'/server/bff/app.mjs#L12'}));
});

test('authority revoked or source changed after drafting prevents a second model request',async()=>{
 for(const revoke of [true,false]){
  const f=fixture(),original=f.authorize;let changed=false,reviews=0;
  f.generateDraft=async()=>{changed=true;if(revoke)f.setRevoked(true);return {title:'현금흐름 목록 조회 실패',body:'현금흐름 목록에서 오류가 발생했습니다. 원인은 확인 중이며 추가 검증이 필요합니다.'};};
  f.authorize=async()=>{const source=await original();if(changed&&!revoke)source.run.answer={changed:true};return source;};
  f.reviewDraft=async()=>{reviews++;return {accepted:true,public_safe:true,findings:[]};};
  await assert.rejects(deliverReviewedIssue(f));assert.equal(reviews,0);assert.equal(f.creates(),0);
 }
});

for (const [status,expected] of [['failed','investigation_failed'],['needs_review','investigation_needs_review'],['running','waiting_for_reviewed_result'],['queued','waiting_for_reviewed_result']]) {
 test(`publication distinguishes ${status} without model, storage or GitHub calls`,async()=>{
  const forbidden=()=>assert.fail('unfinished source must have no publication side effects');
  const result=await deliverReviewedIssue({caseId,authorize:async()=>({run:{status,error:'Bearer SECRET'}}),store:{read:forbidden,compareAndSet:forbidden},generateDraft:forbidden,reviewDraft:forbidden,github:{create:forbidden,find:forbidden,get:forbidden}});
  assert.deepEqual(result,{status:expected});
 });
}
