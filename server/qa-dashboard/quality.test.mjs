import test from "node:test";
import assert from "node:assert/strict";
import { projectInvestigationQuality } from "./stages.mjs";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
const fixture = () => ({
  status: "completed",
  review: { accepted: true },
  investigation_plan: {
    checks: [
      {
        check_id: "check_ui",
        screen: "현금흐름",
        expected_rule: "항목명",
        question: "어느 칸이 다른가?",
        required_tools: ["read_cashflow_sheet_diagnostics"],
      },
    ],
  },
  answer: {
    user_result: {
      headline: "항목명이 다릅니다",
      what_happened: "불러오기를 거절했습니다",
      observed_expected: "",
      next_action: "시트 담당자가 A17을 비교해 주세요",
      result_kind: "needs_input",
    },
    coverage: [
      {
        check_id: "check_ui",
        status: "unavailable",
        evidence_ids: ["ev_" + "a".repeat(64)],
        missing_data: "시트의 현재 A17 표시값이 필요합니다",
      },
    ],
  },
});
test("structured result allows unknown comparison and projects bounded plan", () => {
  const r = projectInvestigationQuality(fixture());
  assert.equal(r.result_format, "structured_v1");
  assert.equal(r.user_result.observed_expected, "");
  assert.equal(r.check_coverage[0].evidence_count, 1);
});
test("legacy preserved and withheld result never exposed", () => {
  assert.equal(
    projectInvestigationQuality({
      status: "completed",
      review: { accepted: true },
      answer: { user_reply: "long legacy" },
    }).result_format,
    "legacy",
  );
  const f = fixture();
  f.status = "needs_review";
  assert.equal(projectInvestigationQuality(f).user_result, null);
});
test("unknown coverage id and oversized user text fail safely", () => {
  const f = fixture();
  f.answer.coverage[0].check_id = "check_other";
  assert.throws(() => projectInvestigationQuality(f));
  const g = fixture();
  g.answer.user_result.headline = "x".repeat(101);
  assert.throws(() => projectInvestigationQuality(g));
});
test("only reviewed server verifier summaries are projected and current findings retain their scope", () => {
  const f = fixture();
  f.answer.candidate_findings = [
    {
      candidate_id: "candidate_revision",
      claim_scope: "current_observation",
      proposed_verdict: "needs_validation",
    },
  ];
  f.candidate_verifications = [
    {
      candidate_id: "candidate_revision",
      verifier_role: "candidate_verifier",
      verifier_run_id: "12345678-1234-1234-1234-123456789012",
      record_hash: "a".repeat(64),
      private_context: "hidden",
      verification: {
        candidate_id: "candidate_revision",
        verdict: "needs_validation",
        summary: "당시 요청 버전이 필요합니다.",
        blockers: ["사고 요청의 버전이 기록되지 않았습니다."],
      },
    },
  ];
  const record = f.candidate_verifications[0];
  record.candidate_hash = candidateHash(f.answer.candidate_findings[0]);
  delete record.record_hash;
  record.record_hash = candidateHash(record);
  const r = projectInvestigationQuality(f);
  assert.equal(r.candidate_results[0].verdict, "needs_validation");
  assert.equal(r.candidate_results[0].claim_scope, "current_observation");
  assert.equal(JSON.stringify(r).includes("hidden"), false);
  f.status = "needs_review";
  assert.deepEqual(projectInvestigationQuality(f).candidate_results, []);
  f.status = "completed";
  f.candidate_verifications[0].verifier_role = "investigator";
  assert.throws(() => projectInvestigationQuality(f));
});
test("publication rejects changed candidate content, changed verifier text, and stale verdicts", () => {
  const f = fixture();
  const candidate = {
    candidate_id: "candidate_revision",
    claim_scope: "incident_cause",
    claim: "승인 자료 버전 차이",
    proposed_verdict: "confirmed",
  };
  const record = {
    candidate_id: candidate.candidate_id,
    candidate_hash: candidateHash(candidate),
    verifier_role: "candidate_verifier",
    verifier_run_id: "12345678-1234-1234-1234-123456789012",
    verification: {
      candidate_id: candidate.candidate_id,
      verdict: "confirmed",
      summary: "검증된 비교",
      blockers: [],
    },
  };
  record.record_hash = candidateHash(record);
  f.answer.candidate_findings = [candidate];
  f.candidate_verifications = [record];
  assert.equal(
    projectInvestigationQuality(f).candidate_results[0].verdict,
    "confirmed",
  );
  const changedCandidate = structuredClone(f);
  changedCandidate.answer.candidate_findings[0].claim = "다른 원인";
  assert.throws(() => projectInvestigationQuality(changedCandidate));
  const changedRecord = structuredClone(f);
  changedRecord.candidate_verifications[0].verification.summary = "변조된 결과";
  assert.throws(() => projectInvestigationQuality(changedRecord));
  const changedVerdict = structuredClone(f);
  changedVerdict.answer.candidate_findings[0].proposed_verdict = "rejected";
  changedVerdict.candidate_verifications[0].candidate_hash = candidateHash(
    changedVerdict.answer.candidate_findings[0],
  );
  delete changedVerdict.candidate_verifications[0].record_hash;
  changedVerdict.candidate_verifications[0].record_hash = candidateHash(
    changedVerdict.candidate_verifications[0],
  );
  assert.throws(() => projectInvestigationQuality(changedVerdict));
});
