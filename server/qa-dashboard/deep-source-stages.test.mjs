import test from "node:test";
import assert from "node:assert/strict";
import { projectStages } from "./stages.mjs";

const event = (sequence, phase, payload = {}) => ({
  sequence,
  phase,
  payload,
  occurred_at: "2026-10-12T09:00:00Z",
});
const result = (name, output) => ({ name, result: { output } });
test("a source inventory is not a source read and planning acceptance is not investigation success", () => {
  const projected = projectStages(
    {
      status: "running",
      tool_names: ["list_live_source_files", "read_live_source_range"],
    },
    [
      event(1, "plan_completed", { plan: { checks: [] } }),
      event(2, "tool_completed", {
        results: [result("list_live_source_files", { status: "available" })],
      }),
    ],
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "planning").status,
    "completed",
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "code").status,
    "running",
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "result_storage").status,
    "waiting",
  );
});
test("real Sheets denial remains partial when saved diagnostics succeeded; a Slack precedent is separate", () => {
  const projected = projectStages(
    {
      status: "running",
      tool_names: ["read_authorized_sheet_labels", "search_slack_history"],
    },
    [
      event(1, "tool_completed", {
        results: [
          result("read_cashflow_sheet_diagnostics", { status: "available" }),
          result("read_authorized_sheet_labels", {
            status: "unavailable",
            error_code: "source_access_denied",
          }),
          result("search_slack_history", { status: "available" }),
        ],
      }),
    ],
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "business").status,
    "partial",
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "history").status,
    "completed",
  );
  assert.equal(
    projected.stages.find((stage) => stage.id === "evidence_validation").status,
    "waiting",
  );
});
test("one candidate verdict is not a completed investigation and unresolved candidates remain partial", () => {
  const run = { status: "running", tool_names: [] };
  const one = [
    event(1, "candidate_verification_started"),
    event(1.5, "completed", { role: "candidate_verifier" }),
    event(2, "candidate_verification_completed", {
      record: { verification: { verdict: "confirmed" } },
    }),
  ];
  const first = projectStages(run, one);
  assert.equal(
    first.stages.find((s) => s.id === "candidate_verification").status,
    "running",
  );
  assert.equal(
    first.stages.find((s) => s.id === "result_storage").status,
    "waiting",
  );
  const batch = projectStages(run, [
    ...one,
    event(3, "candidate_verification_batch_completed", {
      records: [{ verification: { verdict: "needs_validation" } }],
    }),
  ]);
  assert.equal(
    batch.stages.find((s) => s.id === "candidate_verification").status,
    "partial",
  );
  assert.equal(
    batch.stages.find((s) => s.id === "ai_review").status,
    "waiting",
  );
});
test("independent verifier calls and retries do not advance the primary model stage", () => {
  const projected = projectStages({ status: "running", tool_names: [] }, [
    event(1, "candidate_verification_started"),
    event(2, "tools_requested", { role: "candidate_verifier", toolCalls: [] }),
    event(3, "model_retry_scheduled", { role: "candidate_verifier" }),
  ]);
  assert.equal(
    projected.stages.find((s) => s.id === "model").status,
    "waiting",
  );
  assert.equal(
    projected.stages.find((s) => s.id === "candidate_verification").status,
    "running",
  );
});
