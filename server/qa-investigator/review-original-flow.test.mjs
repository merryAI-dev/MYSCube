import test from 'node:test';
import assert from 'node:assert/strict';
import {SPEECH_ACT_GUIDANCE,ACTION_EVIDENCE_GUIDANCE} from './review-claims.mjs';
import {reviewInBoundedSessions} from './review-sessions.mjs';
const eid='ev_'+'1'.repeat(64);
const response=value=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(value)}]}],usage:{total_tokens:10}});
function fixture({rejectClaim,rawSize=0}={}) {
  const requests=[],events=[];
  const options={apiKey:'synthetic',model:'synthetic',originalClaimsJoin:true,
    report:{title:'조회 오류'},answer:{facts:[{claim:'r1의 화면 오류가 기록됐고 서버가 200을 반환했습니다.',evidence_ids:[eid]}],user_reply:'원인은 아직 확인되지 않았습니다.',next_actions:['응답 본문을 확보한 뒤 화면 오류와 비교합니다.'],cause_status:'not_established'},
    evidence:[{evidence_id:eid,status:'available',source:'synthetic',request_id:'r1',client_error:true,http_status:200,padding:'가'.repeat(rawSize)}],
    verificationRecords:[],generation:{},formatSchema:s=>s,beforeStep:async()=>{},onCheckpoint:async e=>events.push(e),
    reviewAuthorityBinding:{actor_id:'reporter',business_actor_id:'reporter',scope_sha256:'b'.repeat(64)},
    runBinding:{tenant_id:'mysc',case_id:'case',run_id:'run',case_input_hash:'a'.repeat(64),aggregate_version:1},
    request:async r=>{
      requests.push(r);const p=JSON.parse(r.input[0].content);
      if(r.stage==='evidence_audit')return response({manifest_sha256:p.manifest_sha256,inspected_claim_ids:p.claims.map(c=>c.claim_id),inspected_part_ids:p.evidence.map(e=>e.part_id),assessments:p.claims.flatMap(c=>p.evidence.map(e=>({claim_id:c.claim_id,evidence_id:e.evidence_id,part_index:e.part_index,relation:'unknown',support_kind:'none',note:'개별 부분만으로 판단하지 않습니다.'})))});
      if(r.stage==='claim_evidence_join') {
        const rejected=p.claim.claim_id===rejectClaim;
        return response({manifest_sha256:p.manifest_sha256,claim_id:p.claim.claim_id,claim_fidelity:'faithful',accepted:!rejected,
          inspected_evidence_ids:[eid],supporting_evidence_ids:rejected?[]:[eid],supporting_anchors:rejected?[]:[{evidence_id:eid,json_pointer:'/request_id',quote:'"r1"'}],
          connection_explanation:'동일 요청의 원본 근거를 함께 확인했습니다.',gaps:p.unresolved.map(g=>({assessment_sha256:g.assessment_sha256,resolution:rejected?'unresolved':'resolved_by_evidence',
            evidence_ids:rejected?[]:[eid],anchors:rejected?[]:[{evidence_id:eid,json_pointer:'/request_id',quote:'"r1"'}],condition:'전체 문장 사실 조건',explanation:rejected?'나머지 사실 절의 근거가 없습니다.':'원문 전체를 대조했습니다.'})),findings:rejected?[{message:'나머지 사실 절의 근거가 없습니다.',evidence_ids:[eid]}]:[]});
      }
      assert.equal(r.stage,'answer_consistency_review');return response({accepted:true,findings:[]});
    }};
  return {options,requests,events};
}
test('original mode keeps exact field values and joins unknowns without generated decomposition',async()=>{
  const f=fixture(),before=structuredClone(f.options.answer);const result=await reviewInBoundedSessions(f.options);
  assert.equal(result.accepted,true);assert.deepEqual(f.options.answer,before);
  assert.ok(!f.requests.some(r=>['claim_decomposition','claim_fidelity'].includes(r.stage)));
  const joins=f.requests.filter(r=>r.stage==='claim_evidence_join').map(r=>JSON.parse(r.input[0].content));
  assert.equal(joins.length,4);assert.deepEqual(joins.find(j=>j.claim.claim_id==='facts/0').claim.value,before.facts[0]);
  assert.ok(joins.every(j=>j.manifest.review_mode==='original'&&j.unresolved.length));
  assert.ok(f.events.filter(e=>e.phase==='review_session_validated').every(e=>e.receipt.snapshot.review_mode==='original'));
});
test('partial compound support and unsupported user prose reject even when requires_support is false',async()=>{
  for(const claim of ['facts/0','user_reply','next_actions/0']) {
    const f=fixture({rejectClaim:claim});const r=await reviewInBoundedSessions(f.options);
    assert.equal(r.accepted,false);assert.ok(r.findings.some(x=>x.message.includes('나머지 사실 절')));
    assert.ok(!f.requests.some(x=>x.stage==='answer_consistency_review'));
  }
});
test('original mode rejects decomposition errors and mutually exclusive modes before source calls',async()=>{
  const f=fixture();f.options.atomicClaims=true;
  await assert.rejects(reviewInBoundedSessions(f.options),{code:'investigation_review_mode_invalid'});assert.equal(f.requests.length,0);
  const g=fixture(),request=g.options.request;
  g.options.request=async r=>{const out=await request(r);if(r.stage==='claim_evidence_join'){
    const v=JSON.parse(out.output[0].content[0].text);v.claim_fidelity='decomposition_error';out.output[0].content[0].text=JSON.stringify(v);
  }return out;};
  await assert.rejects(reviewInBoundedSessions(g.options));assert.ok(!g.requests.some(r=>r.stage==='answer_consistency_review'));
});
test('180KB original is retained in every join and final, oversized raw cannot be silently cut',async()=>{
  const f=fixture({rawSize:60000});assert.equal((await reviewInBoundedSessions(f.options)).accepted,true);
  for(const r of f.requests.filter(r=>['claim_evidence_join','answer_consistency_review'].includes(r.stage))) {
    assert.equal(JSON.parse(r.input[0].content).evidence[0].raw.padding,f.options.evidence[0].padding);
  }
  const g=fixture({rawSize:180000});await assert.rejects(reviewInBoundedSessions(g.options),/context_too_large/);
});
test('reusable receipts require the same original mode; legacy mode cannot reuse them',async()=>{
  const f=fixture();await reviewInBoundedSessions(f.options);const receipts=f.events.filter(e=>e.phase==='review_session_validated');
  const same=fixture();same.options.priorReceipts=receipts;same.options.request=()=>assert.fail('receipt must reuse');
  assert.equal((await reviewInBoundedSessions(same.options)).accepted,true);
  const legacy=fixture();legacy.options.originalClaimsJoin=false;legacy.options.priorReceipts=receipts;
  await reviewInBoundedSessions(legacy.options);assert.ok(legacy.requests.length>0);
  assert.equal(legacy.events.filter(e=>e.phase==='review_session_reused').length,0);
});

test('original audit wire excludes decomposition relation and joins preserve action/speech guidance',async()=>{
  const f=fixture();await reviewInBoundedSessions(f.options);
  const audit=f.requests.find(r=>r.stage==='evidence_audit');
  assert.ok(!audit.instructions.includes('decomposition_error'));
  assert.deepEqual(audit.text.format.schema.properties.assessments.items.properties.relation.enum,['support','counter','unknown','irrelevant']);
  for(const request of f.requests.filter(r=>['evidence_audit','claim_evidence_join'].includes(r.stage))) {
    assert.ok(request.instructions.includes(SPEECH_ACT_GUIDANCE));
    assert.ok(request.instructions.includes(ACTION_EVIDENCE_GUIDANCE));
  }
});

test('a real counter blocks original join instead of being reinterpreted as a local gap',async()=>{
  const f=fixture(),request=f.options.request;
  f.options.request=async r=>{
    const out=await request(r);
    if(r.stage==='evidence_audit'){
      const value=JSON.parse(out.output[0].content[0].text);
      value.assessments[0]={...value.assessments[0],relation:'counter',note:'동일 요청의 서버 응답은 주장과 다릅니다.'};
      return response(value);
    }
    return out;
  };
  const result=await reviewInBoundedSessions(f.options);
  assert.equal(result.accepted,false);
  assert.ok(result.findings.some(f=>f.code==='contradiction'));
  assert.ok(!f.requests.some(r=>['claim_evidence_join','answer_consistency_review'].includes(r.stage)));
});

test('changing a condition in the full answer invalidates original review receipts',async()=>{
  const first=fixture();await reviewInBoundedSessions(first.options);
  const next=fixture();
  next.options.priorReceipts=first.events.filter(e=>e.phase==='review_session_validated');
  next.options.answer.user_reply='응답 본문이 확보된 경우에만 원인을 판단할 수 있습니다.';
  await reviewInBoundedSessions(next.options);
  assert.ok(next.requests.some(r=>r.stage==='evidence_audit'));
  assert.ok(next.requests.some(r=>r.stage==='claim_evidence_join'));
  assert.equal(next.events.filter(e=>e.phase==='review_session_reused').length,0);
});

test('separate client and server originals both reach every join after local unknown assessments',async()=>{
  const f=fixture(),serverId='ev_'+'2'.repeat(64),request=f.options.request;
  f.options.evidence=[
    {evidence_id:eid,status:'available',source:'client',request_id:'r1',client_error:true},
    {evidence_id:serverId,status:'available',source:'server',request_id:'r1',http_status:200},
  ];
  f.options.request=async r=>{
    const out=await request(r);
    if(r.stage==='claim_evidence_join'){
      const input=JSON.parse(r.input[0].content);
      assert.deepEqual(new Set(input.evidence.map(e=>e.evidence_id)),new Set([eid,serverId]));
      assert.equal(input.evidence.find(e=>e.evidence_id===eid).raw.http_status,undefined);
      assert.equal(input.evidence.find(e=>e.evidence_id===serverId).raw.client_error,undefined);
      assert.deepEqual(new Set(input.unresolved.map(a=>a.evidence_id)),new Set([eid,serverId]));
      const value=JSON.parse(out.output[0].content[0].text);
      value.inspected_evidence_ids=[eid,serverId];
      value.supporting_evidence_ids=[eid,serverId];
      value.supporting_anchors=[eid,serverId].map(evidence_id=>({evidence_id,json_pointer:'/request_id',quote:'"r1"'}));
      return response(value);
    }
    return out;
  };
  assert.equal((await reviewInBoundedSessions(f.options)).accepted,true);
  assert.equal(f.requests.filter(r=>r.stage==='claim_evidence_join').length,4);
});

test('large final reviews partition details losslessly while retaining the whole answer and originals',async()=>{
  for(const rejectLast of [false,true]){
    const f=fixture(),request=f.options.request,joins=[];
    f.options.answer.next_actions=Array.from({length:12},(_,i)=>`추가 확인 ${i}`);
    f.options.request=async r=>{
      const out=await request(r),p=JSON.parse(r.input[0].content);
      if(r.stage==='claim_evidence_join'){
        const value=JSON.parse(out.output[0].content[0].text);
        value.connection_explanation='상세'.repeat(8000);
        joins.push({claim:p.claim,manifest_sha256:p.manifest_sha256,...value});
        return response(value);
      }
      if(r.stage==='answer_consistency_review'&&rejectLast&&p.final_review_partition.index===p.final_review_partition.count-1)
        return response({accepted:false,findings:[{code:'contradiction',message:'전체 답변의 사실이 원문과 다릅니다.',evidence_ids:[eid]}]});
      return out;
    };
    const result=await reviewInBoundedSessions(f.options);
    assert.equal(result.accepted,!rejectLast);
    const finals=f.requests.filter(r=>r.stage==='answer_consistency_review');
    assert.ok(finals.length>1);
    const payloads=finals.map(r=>JSON.parse(r.input[0].content));
    assert.deepEqual(payloads.flatMap(p=>p.joined_claims),joins);
    for(let i=0;i<finals.length;i++){
      const r=finals[i],p=payloads[i];
      assert.deepEqual(p.answer,f.options.answer);
      assert.deepEqual(p.evidence.map(e=>e.raw),f.options.evidence);
      assert.deepEqual(p.audit,payloads[0].audit);
      assert.equal(p.final_review_partition.index,i);
      assert.equal(p.final_review_partition.count,finals.length);
      assert.equal(new Set(p.final_review_partition.all_joined_claim_ids).size,joins.length);
      assert.ok(Buffer.byteLength(JSON.stringify({instructions:r.instructions,input:r.input,text:r.text}))<=524288);
      assert.ok(r.instructions.includes('Independently verify every factual clause and cross-claim consistency'));
    }
  }
});

test('one oversized detail fails at receipt storage before final review instead of dropping it',async()=>{
  const f=fixture(),request=f.options.request;
  f.options.request=async r=>{
    const out=await request(r);
    if(r.stage==='claim_evidence_join'){
      const value=JSON.parse(out.output[0].content[0].text);
      value.connection_explanation='상세'.repeat(100000);
      return response(value);
    }
    return out;
  };
  await assert.rejects(reviewInBoundedSessions(f.options),{code:'investigation_review_receipt_too_large'});
  assert.equal(f.requests.filter(r=>r.stage==='answer_consistency_review').length,0);
});
