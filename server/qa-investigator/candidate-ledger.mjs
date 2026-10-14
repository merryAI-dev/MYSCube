import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
export { candidateHash } from "../qa-shared/candidate-integrity.mjs";
import { randomUUID } from "node:crypto";
import Ajv from "ajv/dist/2020.js";
const text = { type: "string", minLength: 1, maxLength: 1500 };
const obj = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const ids = {
  type: "array",
  maxItems: 50,
  uniqueItems: true,
  items: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
};
const cid = { type: "string", pattern: "^candidate_[a-z0-9_]{1,60}$" },
  conditionId = { type: "string", pattern: "^condition_[a-z0-9_]{1,60}$" };
export const candidateFindingsSchema = {
  type: "array",
  maxItems: 20,
  items: obj({
    candidate_id: cid,
    claim_scope: {
      type: "string",
      enum: ["current_observation", "incident_cause"],
    },
    request_anchor: {
      type: "object",
      additionalProperties: false,
      // Legacy project anchors retain their exact stored shape and hash.
      required: ["project_id", "request_id", "trace_id"],
      properties: {
        scope: { type: "string", enum: ["project", "platform"] },
        project_id: { type: "string", pattern: "^(?:p[0-9]{10,20})?$" },
        request_id: {
          type: "string",
          pattern: "^(?:req_[0-9]{13}_[a-f0-9]{12,64})?$",
        },
        trace_id: { type: "string", pattern: "^(?:[a-f0-9]{32})?$" },
      },
    },
    claim: text,
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: obj({
        condition_id: conditionId,
        statement: text,
        verification_target: text,
        falsifier: text,
      }),
    },
    support_evidence_ids: ids,
    counter_evidence_ids: ids,
    blockers: { type: "array", maxItems: 20, items: text },
    proposed_verdict: {
      type: "string",
      enum: ["confirmed", "needs_validation", "rejected"],
    },
  }),
};
export const candidateVerificationsSchema = {
  type: "array",
  maxItems: 1,
  items: obj({
    candidate_id: cid,
    verdict: {
      type: "string",
      enum: ["confirmed", "needs_validation", "rejected"],
    },
    conditions: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: obj({
        condition_id: conditionId,
        status: { type: "string", enum: ["supported", "refuted", "unknown"] },
        evidence_ids: ids,
        provenance: {
          type: "string",
          enum: [
            "current_state",
            "incident_execution",
            "source_rule",
            "unverified",
          ],
        },
        expected_value: { type: "string", maxLength: 1500 },
        observed_value: { type: "string", maxLength: 1500 },
        reason: text,
      }),
    },
    blockers: { type: "array", maxItems: 20, items: text },
    code_bindings: {
      type: "array",
      maxItems: 20,
      items: obj({
        source_evidence_id: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
        execution_evidence_id: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
        rejection_symbol: {
          type: "string",
          pattern: "^[A-Za-z_$][A-Za-z0-9_.$]{0,150}$",
        },
        rejection_line: { type: "integer", minimum: 1 },
        logged_error_code: {
          type: "string",
          pattern: "^[a-z][a-z0-9_]{0,100}$",
        },
        predicate_evidence_ids: ids,
      }),
    },
    summary: text,
  }),
};
const ajv = new Ajv({ strict: false, validateFormats: false });
const validCandidates = ajv.compile(candidateFindingsSchema),
  validVerifications = ajv.compile(candidateVerificationsSchema);
export function validateCandidateFindings(candidates, evidence) {
  if (!validCandidates(candidates))
    return ["Provide schema-valid candidate_findings."];
  const errors = [],
    seen = new Set();
  for (const c of candidates) {
    if (seen.has(c.candidate_id)) errors.push("Duplicate candidate ID.");
    seen.add(c.candidate_id);
    if (
      c.request_anchor.scope === "platform"
        ? c.request_anchor.project_id !== ""
        : !/^p[0-9]{10,20}$/.test(c.request_anchor.project_id)
    )
      errors.push("Candidate anchor scope and project ID do not match.");
    if (
      c.claim_scope === "incident_cause" &&
      !c.request_anchor.request_id &&
      !c.request_anchor.trace_id
    )
      errors.push(
        "Incident candidates require an exact request or trace anchor.",
      );
    if (
      new Set(c.conditions.map((x) => x.condition_id)).size !==
      c.conditions.length
    )
      errors.push("Duplicate condition ID.");
    for (const id of [...c.support_evidence_ids, ...c.counter_evidence_ids]) {
      if (evidence && !evidence.has(id))
        errors.push("Candidate references unknown evidence.");
      else if (
        c.request_anchor.scope === "platform" &&
        evidence?.get(id)?.project_id
      )
        errors.push("Platform candidate cannot cite project-scoped evidence.");
    }
  }
  return errors;
}
const staticSources = new Set([
  "read_code",
  "search_code",
  "list_code_snapshots",
  "read_live_deployed_code",
  "list_live_source_files",
  "search_live_source",
  "read_live_source_range",
  "list_live_file_history",
  "read_live_hotfix_diff",
]);
const bodySources = new Set([
  "read_code",
  "read_live_deployed_code",
  "read_live_source_range",
]);
function hasSourceBody(e) {
  return (
    e?.status === "available" &&
    bodySources.has(e.source) &&
    e.rows?.some(
      (r) =>
        Number.isInteger(r.line) && typeof r.text === "string" && r.text.trim(),
    )
  );
}
function failureExecution(e, candidate) {
  if (e?.status !== "available") return false;
  const a = candidate.request_anchor;
  // Projectless reports must not match the empty segment in every URL path.
  // No current execution adapter attests a platform-scoped request.
  if (a.scope === "platform") return false;
  if (e.source === "query_live_vercel_request_logs")
    return (
      !!a.request_id &&
      e.rows?.some(
        (r) =>
          r.status >= 400 &&
          r.status <= 599 &&
          typeof r.path === "string" &&
          r.path.split("/").includes(a.project_id) &&
          r.events?.some(
            (x) =>
              x.request_id === a.request_id &&
              typeof x.error_code === "string" &&
              x.error_code,
          ),
      )
    );
  if (e.project_id !== a.project_id || !a.trace_id) return false;
  if (e.source === "query_runtime_logs")
    return e.rows?.some(
      (r) =>
        r.status >= 400 &&
        r.status <= 599 &&
        r.trace ===
          `projects/inner-platform-live-20260316/traces/${a.trace_id}`,
    );
  if (e.source === "query_correlated_runtime_trace")
    return (
      e.trace_id === a.trace_id &&
      e.rows?.some((r) => typeof r.error_code === "string" && r.error_code)
    );
  return false;
}
function currentState(e, candidate) {
  return (
    candidate.request_anchor.scope !== "platform" &&
    e?.status === "available" &&
    e.project_id === candidate.request_anchor.project_id &&
    [
      "read_project_state",
      "read_cashflow_sheet_diagnostics",
      "read_authorized_sheet_labels",
      "inspect_month_close_approval_evidence",
    ].includes(e.source) &&
    (e.rows?.length > 0 ||
      (e.source === "inspect_month_close_approval_evidence" &&
        e.checks?.length > 0))
  );
}
function boundRejection(binding, candidate, reads) {
  const source = reads.get(binding.source_evidence_id),
    execution = reads.get(binding.execution_evidence_id);
  if (!hasSourceBody(source) || !failureExecution(execution, candidate))
    return false;
  // Resolver metadata is not proof that this request executed this source revision.
  if (
    source.execution_verified !== true ||
    source.coverage?.historical_request_execution_verified !== true ||
    !/^[a-f0-9]{40}$/.test(source.revision || "")
  )
    return false;
  const rows = source.rows || [],
    line = rows.find((r) => r.line === binding.rejection_line);
  if (
    source.coverage?.complete !== true ||
    !line ||
    line.truncated === true ||
    /^\s*(?:\/\/|\/\*|\*|#)/.test(line.text) ||
    !line.text.includes(binding.logged_error_code) ||
    !rows.some(
      (r) =>
        !/^\s*(?:\/\/|\/\*|\*|#)/.test(r.text) &&
        r.text.includes(binding.rejection_symbol),
    )
  )
    return false;
  if (typeof source.path !== "string" || !source.path.startsWith("server/"))
    return false;
  let matched = false;
  if (execution.source === "query_live_vercel_request_logs")
    matched = execution.rows.some(
      (r) =>
        r.deployment_id === source.deployment_id &&
        /^dpl_[A-Za-z0-9]+$/.test(r.deployment_id || "") &&
        r.status >= 400 &&
        r.status <= 599 &&
        r.path?.split("/").includes(candidate.request_anchor.project_id) &&
        r.events?.some(
          (e) =>
            e.request_id === candidate.request_anchor.request_id &&
            e.error_code === binding.logged_error_code,
        ),
    );
  if (execution.source === "query_correlated_runtime_trace")
    matched =
      source.runtime_revision === execution.revision &&
      source.service === execution.service &&
      source.region === execution.region &&
      source.runtime_revision &&
      source.service &&
      source.region &&
      execution.rows.some(
        (r) =>
          r.error_code === binding.logged_error_code &&
          r.frames?.some(
            (f) =>
              f.line === binding.rejection_line &&
              source.path.endsWith("/" + f.file) &&
              f.method === binding.rejection_symbol,
          ),
      );
  if (!matched || !binding.predicate_evidence_ids.length) return false;
  // Current snapshots, missing historical input or a generic HTTP status cannot prove predicates.
  return binding.predicate_evidence_ids.every((id) => {
    const e = reads.get(id);
    return (
      e?.status === "available" &&
      e.coverage?.incident_state_verified === true &&
      e.coverage?.historical_state !== false &&
      e.project_id === candidate.request_anchor.project_id &&
      ((candidate.request_anchor.request_id &&
        e.request_id === candidate.request_anchor.request_id) ||
        (candidate.request_anchor.trace_id &&
          e.trace_id === candidate.request_anchor.trace_id))
    );
  });
}
function validateVerification(candidate, answer, reads) {
  const records = answer.candidate_verifications;
  if (!validVerifications(records) || records.length !== 1)
    return ["Return exactly one schema-valid candidate_verifications record."];
  const r = records[0],
    errors = [];
  if (r.candidate_id !== candidate.candidate_id)
    errors.push("Candidate identity mismatch.");
  const expected = new Set(candidate.conditions.map((x) => x.condition_id));
  if (
    r.conditions.length !== expected.size ||
    new Set(r.conditions.map((x) => x.condition_id)).size !== expected.size ||
    r.conditions.some((x) => !expected.has(x.condition_id))
  )
    errors.push("Verify every condition exactly once.");
  for (const c of r.conditions) {
    if (c.evidence_ids.some((id) => !reads.has(id)))
      errors.push(
        "Use evidence independently read in this verifier run, not author-supplied IDs.",
      );
    if (
      c.status !== "unknown" &&
      (!c.evidence_ids.length ||
        c.evidence_ids.some((id) => reads.get(id)?.status !== "available"))
    )
      errors.push(
        "A supported/refuted condition needs independently available evidence.",
      );
  }
  if (r.verdict === "confirmed" && candidate.claim_scope === "incident_cause") {
    const citedIds = new Set(r.conditions.flatMap((c) => c.evidence_ids));
    for (const c of r.conditions) {
      const sources = c.evidence_ids.map((id) => reads.get(id));
      if (
        sources.some(
          (e) =>
            currentState(e, candidate) ||
            e?.coverage?.historical_state === false ||
            e?.coverage?.historical_state_verified === false,
        )
      )
        errors.push(
          "Current-only tool provenance cannot be relabeled as historical execution evidence.",
        );
      if (
        c.provenance === "incident_execution" &&
        !sources.some(
          (e) =>
            failureExecution(e, candidate) ||
            e?.coverage?.incident_state_verified === true,
        )
      )
        errors.push(
          "Incident execution provenance requires actual independently read execution evidence.",
        );
      if (c.provenance === "source_rule" && !sources.some(hasSourceBody))
        errors.push(
          "Source-rule provenance requires independently read source body.",
        );
    }
    for (const b of r.code_bindings)
      if (
        [
          b.source_evidence_id,
          b.execution_evidence_id,
          ...b.predicate_evidence_ids,
        ].some((id) => !citedIds.has(id))
      )
        errors.push(
          "Code binding evidence must be cited by the verified conditions.",
        );
  }
  if (!reads.size)
    errors.push("Independently retrieve relevant evidence before deciding.");
  if (r.verdict === "confirmed") {
    if (
      r.conditions.some(
        (c) =>
          c.status === "supported" &&
          (!c.expected_value.trim() || !c.observed_value.trim()),
      )
    )
      errors.push(
        "Confirmed supported conditions require a nonblank expected-versus-observed comparison; use unknown when either value is unobserved.",
      );
    if (r.blockers.length || r.conditions.some((x) => x.status !== "supported"))
      errors.push(
        "Confirmed requires every condition supported and no blockers.",
      );
    const cited = r.conditions
      .flatMap((x) => x.evidence_ids)
      .map((id) => reads.get(id));
    if (candidate.claim_scope === "incident_cause") {
      if (
        r.conditions.some(
          (c) =>
            c.provenance === "current_state" || c.provenance === "unverified",
        )
      )
        errors.push(
          "Current or unverified conditions cannot establish a historical incident cause.",
        );
      if (
        !r.code_bindings.length ||
        !r.code_bindings.every((b) => boundRejection(b, candidate, reads))
      )
        errors.push(
          "Confirmed incident requires a source/execution deployment-and-branch binding with independently observed historical predicate evidence; generic HTTP failures and deployment metadata are insufficient. Keep needs_validation when execution attestation or historical state is unavailable.",
        );
    } else {
      const state = cited.filter((e) => currentState(e, candidate));
      const embeddedRule = state.some(
        (e) =>
          (e.source === "read_authorized_sheet_labels" &&
            e.expected_rule &&
            e.rows.some(
              (r) => r.expected_label && !r.redacted && !r.effective_error,
            )) ||
          (e.source === "read_cashflow_sheet_diagnostics" &&
            e.rows.some((r) =>
              r.last_refresh_error?.diagnostics?.some(
                (d) =>
                  d.expected_label && d.actual_label && !d.message_redacted,
              ),
            )),
      );
      if (!state.length || (!cited.some(hasSourceBody) && !embeddedRule))
        errors.push(
          "Confirmed current observation requires authorized current state/diagnostics plus an observed rule; it cannot establish an incident cause.",
        );
    }
  }
  if (
    r.verdict === "rejected" &&
    !r.conditions.some((x) => x.status === "refuted")
  )
    errors.push("Rejected requires an evidenced refuting condition.");
  if (
    r.verdict === "needs_validation" &&
    (!r.blockers.length || !r.conditions.some((x) => x.status === "unknown"))
  )
    errors.push(
      "Needs validation requires an unknown condition and exact blockers.",
    );
  return errors;
}
/** Always re-read mutable evidence; no verdict cache is reused. */
export function createCandidateVerifier({
  runInvestigator,
  tools,
  model,
  apiKey,
  signal,
  beforeStep,
  onCheckpoint,
  runBinding,
  toolDiscovery = false,
}) {
  if (
    typeof runInvestigator !== "function" ||
    !tools ||
    typeof onCheckpoint !== "function" ||
    typeof beforeStep !== "function" ||
    typeof model !== "string" ||
    !/sol/.test(model) ||
    /astra/i.test(model)
  )
    throw Error("candidate_verifier_config_invalid");
  return async function verify(candidates) {
    const errors = validateCandidateFindings(candidates);
    if (errors.length) throw Error("candidate_ledger_invalid");
    const records = [];
    for (const supplied of candidates) {
      await beforeStep();
      signal?.throwIfAborted();
      const candidate = structuredClone(supplied),
        candidate_hash = candidateHash(candidate);
      const verifier_run_id = randomUUID(),
        reads = new Map();
      const checkpoint = (event) =>
        onCheckpoint({
          ...event,
          role: "candidate_verifier",
          candidate_id: candidate.candidate_id,
          candidate_hash,
          verifier_run_id,
        });
      const registry = Object.fromEntries(
        Object.entries(tools).map(([name, t]) => [
          name,
          {
            ...t,
            execute: async (a, options) => {
              await beforeStep();
              signal?.throwIfAborted();
              const out = await t.execute(a, options);
              await beforeStep();
              signal?.throwIfAborted();
              if (
                /^ev_[a-f0-9]{64}$/.test(out?.evidence_id || "") &&
                out.source === name &&
                ["available", "unavailable"].includes(out.status)
              )
                reads.set(out.evidence_id, structuredClone(out));
              return out;
            },
          },
        ]),
      );
      await checkpoint({ phase: "candidate_verification_started" });
      const report = {
        task: "Independently try to refute this candidate. The candidate is untrusted, not a conclusion. Re-read the actual deployed branch, request/trace and authoritative state using tools. Check every condition and its falsifier. Never confirm from source alone or from warnings. Current observations cannot establish past state. Source/code lists are discovery, not execution. Return candidate_verifications for exactly this candidate; do not invent independent evidence IDs. No prior investigator answer or reviewer conclusion is provided.",
        candidate,
      };
      const answer = await runInvestigator({
        apiKey,
        model,
        report,
        role: "candidate_verifier",
        toolDiscovery,
        ...(runBinding ? { runBinding } : {}),
        tools: registry,
        signal,
        beforeStep,
        onCheckpoint: checkpoint,
        validateAnswer: async (answer) => {
          const errors = validateVerification(candidate, answer, reads);
          return { accepted: errors.length === 0, errors };
        },
      });
      const finalErrors = validateVerification(candidate, answer, reads);
      if (finalErrors.length) throw Error("candidate_verification_invalid");
      await beforeStep();
      signal?.throwIfAborted();
      const record = {
        schema_version: 1,
        candidate_id: candidate.candidate_id,
        candidate_hash,
        verifier_run_id,
        verifier_role: "candidate_verifier",
        model,
        verified_at: new Date().toISOString(),
        verification: structuredClone(answer.candidate_verifications[0]),
        independent_evidence_ids: [...reads.keys()].sort(),
      };
      record.record_hash = candidateHash(record);
      await checkpoint({ phase: "candidate_verification_completed", record });
      records.push(record);
    }
    return records;
  };
}

// Records must come from the trusted verifier closure; hashes bind content, not an authentication signature.
export function candidateVerdictGate(answer, records) {
  const candidates = answer.candidate_findings,
    errors = validateCandidateFindings(candidates);
  if (errors.length) return errors;
  if (!Array.isArray(records) || records.length !== candidates.length)
    return ["Every candidate requires its independent verification record."];
  const mapped = new Map();
  for (const record of records) {
    if (!record || mapped.has(record.candidate_id)) {
      errors.push("Duplicate or invalid verification record.");
      continue;
    }
    const { record_hash, ...body } = record;
    if (
      record_hash !== candidateHash(body) ||
      record.verifier_role !== "candidate_verifier" ||
      !/^[a-f0-9-]{36}$/.test(record.verifier_run_id || "")
    )
      errors.push("Invalid server verification record binding.");
    mapped.set(record.candidate_id, record);
  }
  for (const c of candidates) {
    const r = mapped.get(c.candidate_id);
    if (
      !r ||
      r.candidate_hash !== candidateHash(c) ||
      r.verification?.candidate_id !== c.candidate_id
    )
      errors.push(
        "Candidate changed since independent verification; reverify.",
      );
    else if (c.proposed_verdict !== r.verification.verdict)
      errors.push(
        "Candidate proposed verdict differs from independent decision; repair the final record.",
      );
  }
  const confirmed = candidates.filter(
    (c) =>
      mapped.get(c.candidate_id)?.candidate_hash === candidateHash(c) &&
      mapped.get(c.candidate_id)?.verification?.verdict === "confirmed",
  );
  if (
    answer.cause_status === "supported" &&
    !confirmed.some((c) => c.claim_scope === "incident_cause")
  )
    errors.push(
      "Supported cause requires an independently confirmed incident candidate, not a current observation.",
    );
  if (
    answer.user_result?.result_kind === "actionable_finding" &&
    !confirmed.length
  )
    errors.push(
      "Actionable finding requires an independently confirmed candidate.",
    );
  return [...new Set(errors)];
}
