import test from "node:test";
import assert from "node:assert/strict";
import {
  runOpenAIInvestigation,
  planOpenAIInvestigation,
} from "./openai-agent.mjs";
const answer = {
  facts: [],
  hypotheses: [],
  unknowns: [],
  user_reply: "원인은 아직 확인하지 못했습니다.",
  next_actions: [],
  cause_status: "not_established",
};
const response = (args, id) =>
  new Response(
    JSON.stringify({
      status: "completed",
      output: [
        {
          type: "function_call",
          call_id: id,
          name: "finalize_investigation",
          arguments: JSON.stringify(args),
        },
      ],
    }),
    { status: 200 },
  );
test("strict optional null dependency is a root observation, not an invalid plan", async () => {
  const original = globalThis.fetch;
  const plan = {
    checks: [
      {
        check_id: "check_signin",
        screen: "로그인",
        expected_rule: "로그인 후 이동 결과를 확인한다",
        question: "어떤 오류가 기록됐는가?",
        required_tools: ["read_ui"],
      },
    ],
  };
  const outputs = [
    { checks: [{ ...plan.checks[0], depends_on_check_ids: null }] },
    { accepted: true, missing_checks: [] },
  ];
  globalThis.fetch = async () =>
    Response.json({
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: JSON.stringify(outputs.shift()) },
          ],
        },
      ],
    });
  try {
    assert.deepEqual(
      await planOpenAIInvestigation({
        apiKey: "synthetic",
        model: "synthetic",
        report: {},
        tools: {
          read_ui: { description: "Read authorized screen diagnostics" },
        },
        onCheckpoint: async () => {},
      }),
      plan,
    );
    assert.equal(outputs.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("strict optional null fields normalize before final validation without becoming claims", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    response(
      {
        ...answer,
        candidate_findings: null,
        candidate_verifications: null,
        user_result: null,
        action_items: null,
        coverage: null,
      },
      "final",
    );
  try {
    let checked;
    const result = await runOpenAIInvestigation({
      apiKey: "synthetic",
      model: "synthetic",
      report: {},
      tools: {},
      onCheckpoint: async () => {},
      validateAnswer: async (value) => {
        checked = value;
        return { accepted: true, errors: [] };
      },
    });
    assert.deepEqual(checked, answer);
    assert.deepEqual(result, answer);
  } finally {
    globalThis.fetch = original;
  }
});
test("required null stays invalid and safe field diagnostics let the next response repair it", async () => {
  const original = globalThis.fetch,
    bodies = [];
  let calls = 0,
    accepted = 0;
  globalThis.fetch = async (_url, options) => {
    bodies.push(JSON.parse(options.body));
    return response(
      ++calls === 1 ? { ...answer, user_reply: null } : answer,
      "final" + calls,
    );
  };
  try {
    const result = await runOpenAIInvestigation({
      apiKey: "synthetic",
      model: "synthetic",
      report: {},
      tools: {},
      onCheckpoint: async () => {},
      validateAnswer: async () => {
        accepted++;
        return { accepted: true, errors: [] };
      },
    });
    assert.deepEqual(result, answer);
    assert.equal(accepted, 1);
    assert.equal(calls, 2);
    const feedback = JSON.parse(
      bodies[1].input.find((x) => x.type === "function_call_output").output,
    );
    assert.equal(feedback.error, "invalid_final_schema");
    assert.equal(feedback.errors[0].path, "/user_reply");
    assert.equal(feedback.errors[0].keyword, "type");
    assert.equal("data" in feedback.errors[0], false);
  } finally {
    globalThis.fetch = original;
  }
});
