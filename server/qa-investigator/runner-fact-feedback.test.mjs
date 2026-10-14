import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
const source=await readFile(new URL('./runner.mjs',import.meta.url),'utf8');
const body=source.slice(source.indexOf('async function validateAnswer(answer)'),source.indexOf('\ntry {',source.indexOf('async function validateAnswer(answer)')));
async function validate(status){
 const events=[];let reviews=0;
 const evidence=new Map(status===undefined?[]:[['ev_test',{status,private_detail:'PRIVATE_SOURCE_ERROR'}]]);
 const context={checkpoint:async e=>events.push(e),lastStep:0,investigationPlan:null,requiredFollowups:()=>[],validateReaderLanguage:()=>[],observedEvidence:evidence,
 pipeline:{reviewReceipts:async()=>[],reviewAuthorityBinding:()=>({}),authorize:async()=>{}},validateCandidateFindings:()=>[],verifyCandidates:async()=>[],candidateVerdictGate:()=>[],
 knownReviewReceipts:new Set(),provider:'openai',reviewOpenAIInvestigation:async()=>{reviews++;return {accepted:true,findings:[]};},request:{report:{}},model:'test',projectId:'test',signal:undefined,apiKey:'',reportId:'test',runBinding:{},process:{env:{}},
 answer:{user_reply:'확인했습니다.',facts:[{text:'업무 상태',evidence_ids:['ev_test']}],hypotheses:[],candidate_findings:[],cause_status:'not_established'}};
 const verdict=await runInNewContext(body+'\nvalidateAnswer(answer)',context);
 return {verdict,events,reviews};
}
test('real runner distinguishes missing evidence and gives a manifest-based correction',async()=>{
 const {verdict,reviews}=await validate();assert.equal(verdict.accepted,false);assert.equal(reviews,0);
 assert.match(verdict.errors[0],/unknown evidence/);assert.match(verdict.errors[0],/stored evidence manifest/);
});
test('real runner rejects unreadable evidence with correction without leaking source errors',async()=>{
 for(const status of ['unavailable','denied','unknown']){
 const {verdict,events,reviews}=await validate(status);assert.equal(verdict.accepted,false);assert.equal(reviews,0);
 assert.match(verdict.errors[0],/unavailable evidence/);assert.match(verdict.errors[0],/Move the access gap to unknowns/);
 assert.match(verdict.errors[0],/Do not change a cited ID/);assert(!JSON.stringify({verdict,events}).includes('PRIVATE_SOURCE_ERROR'));
 assert.equal(events.at(-1).phase,'answer_validation_failed');assert.equal(events.at(-1).error_count,1);
 }
});
test('available evidence still reaches independent review',async()=>{
 const {reviews}=await validate('available');assert.equal(reviews,1);
});
