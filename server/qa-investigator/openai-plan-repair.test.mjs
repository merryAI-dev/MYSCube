import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { planOpenAIInvestigation } from "./openai-agent.mjs";
const root = {
  check_id: "check_entry",
  screen: "등록",
  expected_rule: "저장 결과 확인",
  question: "저장이 완료됐는가?",
  required_tools: ["read_state"],
};
const plan = { checks: [root] };
const response = (value) =>
  Response.json({
    status: "completed",
    output: [
      {
        type: "message",
        content: [
          {
            type: "output_text",
            text: typeof value === "string" ? value : JSON.stringify(value),
          },
        ],
      },
    ],
  });
const options = {
  apiKey: "synthetic",
  model: "synthetic",
  report: { text: "PRIVATE_REPORT_VALUE", server_context: {
    platform_key: 'myscube', scope_kind: 'platform',
  } },
  tools: { read_state: { description: "Read authorized state" } },
};
for (const [kind, invalid] of [
  ["malformed JSON", "PRIVATE_INVALID_JSON_VALUE"],
  ["required null", { checks: [{ ...root, question: null }] }],
  [
    "malformed dependency",
    { checks: [{ ...root, depends_on_check_ids: "PRIVATE_INVALID_VALUE" }] },
  ],
  ["unknown tool", { checks: [{ ...root, required_tools: ["unknown_tool"] }] }],
  ['multiple upfront checks', { checks: [root, { ...root, check_id: 'check_other' }] }],
  ['dependent first check', { checks: [{ ...root, depends_on_check_ids: ['check_entry'] }] }],
  [
    "unknown dependency",
    {
      checks: [
        root,
        {
          ...root,
          check_id: "check_child",
          depends_on_check_ids: ["check_missing"],
        },
      ],
    },
  ],
  [
    "self dependency",
    {
      checks: [
        root,
        {
          ...root,
          check_id: "check_child",
          depends_on_check_ids: ["check_child"],
        },
      ],
    },
  ],
  [
    "cycle",
    {
      checks: [
        root,
        { ...root, check_id: "check_a", depends_on_check_ids: ["check_b"] },
        { ...root, check_id: "check_b", depends_on_check_ids: ["check_a"] },
      ],
    },
  ],
])
  test(`planner repairs ${kind} before independent review`, async () => {
    const original = globalThis.fetch,
      requests = [],
      events = [];
    const outputs = [invalid, plan, { accepted: true, missing_checks: [] }];
    globalThis.fetch = async (_url, request) => {
      requests.push(JSON.parse(request.body));
      return response(outputs.shift());
    };
    try {
      const result = await planOpenAIInvestigation({
        ...options,
        onCheckpoint: async (e) => events.push(e),
      });
      assert.deepEqual(result, plan);
      assert.equal(requests.length, 3);
      assert.equal(
        requests[0].text.format.name,
        "independent_investigation_plan",
      );
      assert.match(requests[0].instructions, /exactly one root check/);
      assert.match(requests[0].instructions, /Do not plan a complete causal tree/);
      assert.match(requests[0].instructions, /do not ask the user to identify an already bound product/);
      assert.equal(JSON.parse(requests[0].input[0].content).untrusted_report.server_context.scope_kind,
        'platform');
      assert.equal(
        requests[1].text.format.name,
        "independent_investigation_plan",
      );
      assert.notEqual(
        requests[2].text.format.name,
        "independent_investigation_plan",
      );
      assert.match(requests[2].instructions, /review only the proposed first observation/i);
      const rejected = events.filter(
        (e) => e.phase === "plan_validation_rejected",
      );
      assert.equal(rejected.length, 1);
      assert.doesNotMatch(JSON.stringify(rejected), /PRIVATE_/);
      assert.deepEqual(
        JSON.parse(requests[1].input[0].content).plan_validation_feedback,
        rejected[0].errors,
      );
      assert.equal(
        events.filter((e) => e.phase === "plan_completed").length,
        1,
      );
      const started = events.find((event) => event.phase === 'plan_started');
      const reviewed = events.find((event) => event.phase === 'plan_review_started');
      assert.match(started.session_id, /^[a-f0-9-]{36}$/);
      assert.match(started.input_manifest_sha256, /^[a-f0-9]{64}$/);
      assert.equal(started.stage, 'initial_observation_plan');
      assert.equal(reviewed.stage, 'initial_observation_review');
      assert.notEqual(started.session_id, reviewed.session_id);
      const manifest = { stage: started.stage, model: options.model,
        instructions: requests[0].instructions, input: requests[0].input,
        formatName: requests[0].text.format.name };
      assert.equal(started.input_manifest_sha256,
        createHash('sha256').update(JSON.stringify(manifest)).digest('hex'));
    } finally {
      globalThis.fetch = original;
    }
  });
test("planner repair honors abort rather than executing an invalid plan", async () => {
  const original = globalThis.fetch,
    controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response({ checks: [] });
  };
  try {
    await assert.rejects(
      planOpenAIInvestigation({
        ...options,
        signal: controller.signal,
        onCheckpoint: async (e) => {
          if (e.phase === "plan_validation_rejected") controller.abort();
        },
      }),
      { name: "AbortError" },
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('planner and reviewer share the verified stored evidence manifest', async () => {
  const {evidenceRecord}=await import('./runner-persistence.mjs');
  const {createSessionContext}=await import('./session-context.mjs');
  const {candidateHash}=await import('../qa-shared/candidate-integrity.mjs');
  const runBinding={tenant_id:'mysc',case_id:'11111111-1111-4111-8111-111111111111',run_id:'qa-22222222-2222-4222-8222-222222222222',case_input_hash:'a'.repeat(64),aggregate_version:1};
  const body={source:'query_client_errors',status:'available',observed_at:'2026-10-14T00:00:00Z',rows:[{private_raw_value:'DO_NOT_DUMP_IN_PLAN'}],next_cursor:'private-cursor'};
  const hash=candidateHash(body),item={...body,content_hash:hash,evidence_id:`ev_${hash}`};
  const ledger=createSessionContext({runBinding,report:options.report,priorEvidence:[]});
  const record={documentId:item.evidence_id,stored:evidenceRecord({item,runBinding,ledger,alreadyStored:false})};
  const saved=globalThis.fetch,inputs=[];
  globalThis.fetch=async(_,init)=>{inputs.push(JSON.parse(JSON.parse(init.body).input[0].content));return response(inputs.length===1?plan:{accepted:true,missing_checks:[]});};
  try {
    await planOpenAIInvestigation({...options,runBinding,priorEvidenceRecords:[record],onCheckpoint:async()=>{}});
    assert.deepEqual(inputs[0].observed_evidence_manifest,inputs[1].observed_evidence_manifest);
    assert.ok(JSON.stringify(inputs[0].observed_evidence_manifest).includes(item.evidence_id));
    assert.ok(!JSON.stringify(inputs).includes('DO_NOT_DUMP_IN_PLAN'));
    for(const patch of [{run_id:'qa-wrong'},{aggregate_version:2},{payload_sha256:'0'.repeat(64)}]){
      await assert.rejects(planOpenAIInvestigation({...options,runBinding,priorEvidenceRecords:[{...record,stored:{...record.stored,...patch}}],onCheckpoint:async()=>{}}));
    }
    assert.equal(inputs.length,2);
  } finally {globalThis.fetch=saved;}
});
