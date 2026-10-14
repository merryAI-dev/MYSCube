import { verificationMatchesCandidate } from "../qa-shared/candidate-integrity.mjs";

const DEFINITIONS = [
  ["receipt", "접수"],
  ["model", "모델 호출"],
  ["business", "업무 상태 조회"],
  ["server_logs", "서버 로그"],
  ["client_errors", "클라이언트 오류"],
  ["code", "코드 조회"],
  ["evidence_validation", "근거 검증"],
  ["ai_review", "AI 검토"],
  ["result_storage", "결과 저장"],
  ["external_delivery", "외부 전달"],
];
const TOOLS = {
  inspect_month_close_approval_evidence: "business",
  read_authorized_sheet_labels: "business",
  query_correlated_runtime_trace: "server_logs",
  list_live_source_files: "code",
  search_live_source: "code",
  read_live_source_range: "code",
  list_live_file_history: "history",
  read_live_hotfix_diff: "history",
  search_slack_history: "history",
  read_slack_history_thread: "history",
  read_live_jvm_deployment: "deployment",
  read_cashflow_sheet_diagnostics: "business",
  query_live_vercel_request_logs: "server_logs",
  read_live_deployed_code: "code",
  read_live_vercel_deployment: "deployment",
  read_project_state: "business",
  query_runtime_logs: "server_logs",
  read_bff_request_log_snapshot: "server_logs",
  query_client_errors: "client_errors",
  list_code_snapshots: "code",
  search_code: "code",
  read_code: "code",
  read_public_deployment_identity: "deployment",
  read_deployment_observation_snapshot: "deployment",
};
const DEPLOYMENT_TOOLS = new Set([
  "read_live_jvm_deployment",
  "read_live_vercel_deployment",
  "read_public_deployment_identity",
  "read_deployment_observation_snapshot",
]);
const ERRORS = new Set([
  "investigation_provider_credit_exhausted",
  "source_credentials_missing",
  "deployment_revision_unverified",
  "source_service_revision_mismatch",
  "sheet_binding_missing",
  "sheet_binding_changed",
  "sheet_tab_binding_ambiguous",
  "sheet_response_incomplete",
  "trace_not_observed_in_http_metadata",
  "trace_scope_ambiguous",
  "invalid_continuation",
  "unsupported_action_commitment",
  "provider_schema_invalid",
  "evidence_validation_failed",
  "model_request_failed",
  "answer_validation_failed",
  "tool_execution_failed",
  "source_access_denied",
  "source_auth_unavailable",
  "source_unavailable",
  "no_verified_actor_scope",
  "actor_scope_changed",
  "source_timeout",
  "invalid_deployment_request",
  "invalid_deployment_observation",
  "deployment_redirect",
  "deployment_non_json",
  "deployment_invalid_schema",
  "deployment_response_too_large",
  "deployment_invalid_json",
  "invalid_scope",
  "invalid_code_request",
  "step_limit",
  "investigation_step_limit",
  "investigation_timeout",
  "investigation_failed",
  "investigation_model_request_failed",
  "investigation_output_limit",
  "investigation_content_filtered",
  "investigation_incomplete_response",
  "investigation_answer_validation_failed",
  "investigation_review_request_failed",
  "investigation_review_invalid_output",
  "investigation_persistence_failed",
  "final_evidence_rejected",
]);
const PROVIDER_STATUS = new Set([
  "INVALID_ARGUMENT",
  "UNAUTHENTICATED",
  "PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "NOT_FOUND",
  "UNKNOWN",
]);
export function safeDiagnostics(value = {}) {
  const result = {};
  if (ERRORS.has(value.error_code)) result.error_code = value.error_code;
  if (
    Number.isInteger(value.provider_http_status) &&
    value.provider_http_status >= 400 &&
    value.provider_http_status <= 599
  )
    result.provider_http_status = value.provider_http_status;
  if (
    ["max_output_tokens", "content_filter", "unknown"].includes(
      value.provider_incomplete_reason,
    )
  )
    result.provider_incomplete_reason = value.provider_incomplete_reason;
  if (PROVIDER_STATUS.has(value.provider_error_status))
    result.provider_error_status = value.provider_error_status;
  if (
    Number.isSafeInteger(value.retry_attempt) &&
    value.retry_attempt >= 1 &&
    value.retry_attempt <= 100
  )
    result.retry_attempt = value.retry_attempt;
  if (
    Number.isSafeInteger(value.delay_ms) &&
    value.delay_ms >= 0 &&
    value.delay_ms <= 3600000
  )
    result.delay_ms = value.delay_ms;
  return result;
}
export function projectStages(run, checkpoints, { truncated = false } = {}) {
  // Older runs keep their original ten stages. Inspect checkpoints as well as
  // parent metadata: some projections or partial histories omit tool_names.
  const deploymentObserved =
    (Array.isArray(run.tool_names) &&
      run.tool_names.some((name) => DEPLOYMENT_TOOLS.has(name))) ||
    checkpoints.some((c) =>
      [c.payload?.toolCalls, c.payload?.results].some(
        (items) =>
          Array.isArray(items) &&
          items.some((item) => DEPLOYMENT_TOOLS.has(item?.name)),
      ),
    );
  let definitions = deploymentObserved
    ? [
        ...DEFINITIONS.slice(0, 6),
        ["deployment", "배포 정보 확인"],
        ...DEFINITIONS.slice(6),
      ]
    : DEFINITIONS;
  const observedNames = new Set([
    ...(run.tool_names || []),
    ...checkpoints.flatMap((c) =>
      [...(c.payload?.toolCalls || []), ...(c.payload?.results || [])].map(
        (item) => item.name,
      ),
    ),
  ]);
  if ([...observedNames].some((name) => TOOLS[name] === "history"))
    definitions = [
      ...definitions.slice(0, 6),
      ["history", "이전 사례 대조"],
      ...definitions.slice(6),
    ];
  if (
    run.investigation_plan ||
    checkpoints.some((c) => c.phase?.startsWith("plan_"))
  )
    definitions = [
      definitions[0],
      ["planning", "조사 계획 검토"],
      ...definitions.slice(1),
    ];
  if (checkpoints.some((c) => c.phase?.startsWith("candidate_"))) {
    const index = definitions.findIndex(([id]) => id === "ai_review");
    definitions = [
      ...definitions.slice(0, index),
      ["candidate_verification", "원인 후보 독립 검증"],
      ...definitions.slice(index),
    ];
  }
  const stages = definitions.map(([id, label]) => ({
    id,
    label,
    status: "waiting",
    available: 0,
    unavailable: 0,
    attempts: 0,
  }));
  const byId = Object.fromEntries(stages.map((stage) => [stage.id, stage]));
  const timeline = [];
  byId.receipt.status = "completed";
  if (run.delivery_status === "not_sent")
    byId.external_delivery.status = "not_connected";
  function set(id, status, event, diagnostics = {}) {
    const stage = byId[id];
    stage.status = status;
    if (status === "completed")
      for (const key of [
        "error_code",
        "provider_http_status",
        "provider_error_status",
        "provider_incomplete_reason",
      ])
        delete stage[key];
    if (event?.occurred_at) stage.updated_at = event.occurred_at;
    Object.assign(stage, diagnostics);
  }
  let lastFailure;
  for (const c of [...checkpoints].sort((a, b) => a.sequence - b.sequence)) {
    const p = c.payload || {},
      diagnostics = safeDiagnostics(p);
    let stageId = null;
    if (
      p.role === "candidate_verifier" &&
      ["started", "completed", "failed"].includes(c.phase)
    ) {
      stageId = "candidate_verification";
      if (byId[stageId])
        set(
          stageId,
          c.phase === "failed" ? "failed" : "running",
          c,
          diagnostics,
        );
      else stageId = null;
    } else if (c.phase?.startsWith("candidate_")) {
      stageId = "candidate_verification";
      if (c.phase === "candidate_verification_batch_completed") {
        const records = Array.isArray(p.records) ? p.records : [];
        set(
          stageId,
          records.some((r) => r.verification?.verdict === "needs_validation")
            ? "partial"
            : "completed",
          c,
        );
      } else set(stageId, "running", c);
    } else if (c.phase?.startsWith("plan_")) {
      stageId = "planning";
      const rejected =
        c.phase === "plan_review_completed" && p.review?.accepted !== true;
      set(
        stageId,
        c.phase === "plan_completed"
          ? "completed"
          : rejected
            ? "partial"
            : "running",
        c,
        diagnostics,
      );
    } else if (
      c.phase === "model_retry_scheduled" ||
      c.phase === "review_retry_scheduled"
    ) {
      stageId =
        p.role === "candidate_verifier" && byId.candidate_verification
          ? "candidate_verification"
          : c.phase === "model_retry_scheduled"
            ? "model"
            : "ai_review";
      set(stageId, "running", c, diagnostics);
    } else if (c.phase === "started") {
      set("model", "running", c);
      stageId = "model";
    } else if (c.phase === "tools_requested") {
      stageId =
        p.role === "candidate_verifier" && byId.candidate_verification
          ? "candidate_verification"
          : "model";
      set(
        stageId,
        stageId === "candidate_verification" ? "running" : "completed",
        c,
      );
      for (const call of p.toolCalls || [])
        if (TOOLS[call.name]) set(TOOLS[call.name], "running", c);
    } else if (c.phase === "tool_completed") {
      for (const item of p.results || []) {
        const id = TOOLS[item.name];
        if (!id) continue;
        const stage = byId[id],
          output = item.result?.output;
        const available = output?.status === "available";
        stage.attempts++;
        stage[available ? "available" : "unavailable"]++;
        const error = safeDiagnostics({
          error_code: output?.error_code || item.result?.error,
        });
        // Catalog/search are useful observations, but only read_code proves source lines were read.
        if (
          id === "code" &&
          [
            "read_code",
            "read_live_deployed_code",
            "read_live_source_range",
          ].includes(item.name) &&
          available
        )
          stage.source_read_observed = true;
        const codeRead = id !== "code" || stage.source_read_observed === true;
        set(
          id,
          stage.unavailable
            ? stage.available
              ? "partial"
              : "failed"
            : codeRead
              ? "completed"
              : "running",
          c,
          error,
        );
        timeline.push({
          phase: c.phase,
          tool_name: item.name,
          stage: id,
          status: available ? "completed" : "failed",
          occurred_at: c.occurred_at,
          step: c.model_step,
          ...error,
        });
      }
      continue;
    } else if (c.phase === "answer_validation_started") {
      set("evidence_validation", "running", c);
      stageId = "evidence_validation";
    } else if (c.phase === "answer_validation_failed") {
      set("evidence_validation", "failed", c, diagnostics);
      stageId = "evidence_validation";
    } else if (c.phase === "review_started") {
      set("evidence_validation", "completed", c);
      set("ai_review", "running", c);
      stageId = "ai_review";
    } else if (c.phase === "review_completed") {
      set("ai_review", p.review?.accepted === true ? "completed" : "failed", c);
      stageId = "ai_review";
    } else if (c.phase === "completed") {
      set("result_storage", "running", c);
      stageId = "result_storage";
    } else if (c.phase === "diagnostic") {
      stageId = definitions.some(([id]) => id === p.stage)
        ? p.stage
        : diagnostics.error_code === "provider_schema_invalid"
          ? "model"
          : null;
      if (stageId) {
        set(stageId, "failed", c, diagnostics);
        lastFailure = { stage: stageId, ...diagnostics };
      }
    } else if (c.phase === "exhausted") {
      // The loop stopped at its application budget; this is not a provider API failure.
      lastFailure = { stage: null, error_code: "investigation_step_limit" };
    } else if (c.phase === "failed") {
      const code = diagnostics.error_code;
      stageId =
        code === "investigation_provider_credit_exhausted"
          ? byId.ai_review.status === "running" ? "ai_review" : "model"
          : code === "model_request_failed" ||
        code === "investigation_model_request_failed"
          ? "model"
          : code === "answer_validation_failed" ||
              code === "investigation_answer_validation_failed"
            ? byId.ai_review.status === "running"
              ? "ai_review"
              : "evidence_validation"
            : code === "investigation_review_request_failed" ||
                code === "investigation_review_invalid_output"
              ? "ai_review"
              : code === "investigation_persistence_failed"
                ? "result_storage"
                : null;
      if (stageId) set(stageId, "failed", c, diagnostics);
      lastFailure = { stage: stageId, ...diagnostics };
    }
    if (stageId || ["source_catalog_ready", "exhausted"].includes(c.phase))
      timeline.push({
        phase: c.phase,
        ...(stageId ? { stage: stageId, status: byId[stageId].status } : {}),
        occurred_at: c.occurred_at,
        step: c.model_step,
        ...diagnostics,
      });
  }
  if (run.status === "completed" && run.review_accepted === true && run.answer)
    byId.result_storage.status = "completed";
  if (["failed", "needs_review"].includes(run.status))
    for (const stage of stages) {
      if (stage.status === "waiting" || stage.status === "running")
        stage.status = "blocked";
    }
  // Never convert an unobserved source into success because a parent run completed.
  const budgetStopped =
    checkpoints.some((c) => c.phase === "exhausted") ||
    ["step_limit", "investigation_step_limit"].includes(run.error_code);
  const failure = ["failed", "needs_review"].includes(run.status)
    ? run.error_code === "investigation_provider_credit_exhausted"
      ? { stage: lastFailure?.stage || null, ...safeDiagnostics(run) }
      : budgetStopped
        ? { stage: null, error_code: "investigation_step_limit" }
        : lastFailure || { stage: null, ...safeDiagnostics(run) }
    : null;
  let failure_summary = null;
  if (failure) {
    const credit = failure.error_code === "investigation_provider_credit_exhausted";
    const commitment = failure.error_code === "unsupported_action_commitment";
    const exhausted = ["step_limit", "investigation_step_limit"].includes(
      failure.error_code,
    );
    const incomplete =
      failure.provider_incomplete_reason ||
      {
        investigation_output_limit: "max_output_tokens",
        investigation_content_filtered: "content_filter",
        investigation_incomplete_response: "unknown",
      }[failure.error_code];
    const phaseLabel =
      failure.stage === "ai_review"
        ? "AI 검토"
        : failure.stage === "model"
          ? "모델 호출"
          : "해당 호출";
    const schema = failure.error_code === "provider_schema_invalid";
    const capacity =
      failure.provider_http_status === 429 ||
      failure.provider_error_status === "RESOURCE_EXHAUSTED";
    const denied =
      failure.provider_error_status === "PERMISSION_DENIED" ||
      failure.error_code === "source_access_denied";
    failure_summary = {
      ...failure,
      message: credit
        ? "AI 서비스의 사용 크레딧이 소진되어 조사가 중단됐습니다."
        : commitment
        ? "답변에 실제 수행 권한이나 실행 근거가 없는 후속 행동 약속이 포함되어 독립 검토에서 공개가 보류됐습니다."
        : exhausted
          ? "조사 횟수 한도에 도달해 최종 정리·검토를 완료하지 못했습니다. 모델 공급자의 요청량 제한과는 다른 중단입니다."
          : incomplete === "max_output_tokens"
            ? `${phaseLabel} 응답이 출력 한도에 도달해 끝까지 생성되지 않았습니다.`
            : incomplete === "content_filter"
              ? `${phaseLabel} 응답이 공급자 콘텐츠 필터로 완료되지 않았습니다.`
              : incomplete === "unknown"
                ? `${phaseLabel} 응답이 완료되지 않았으며 저장된 정보로 세부 이유를 확인할 수 없습니다.`
                : capacity
                  ? "모델 공급자가 요청량 또는 가용 용량 제한으로 호출을 거절했습니다."
                  : schema
                    ? "모델 요청의 출력 형식을 공급자가 거부했습니다. 업무 데이터 조회 실패와는 다른 단계입니다."
                    : denied
                      ? "해당 단계에서 접근 권한이 거부되었습니다."
                      : failure.stage === "model"
                        ? "모델 호출 단계에서 조사가 중단되었습니다. 저장된 진단만으로 세부 원인을 확정할 수 없습니다."
                        : failure.stage === "ai_review"
                          ? "수집한 근거를 검토하는 AI 호출을 완료하지 못했습니다."
                          : "조사 실행이 중단되었습니다. 완료된 단계와 미실행 단계를 나누어 확인해 주세요.",
      next_action: credit
        ? "관리자가 연결된 OpenAI 계정의 결제·크레딧을 확인하고 충전한 뒤 조사를 다시 실행해 주세요. 신고 내용이나 업무 데이터를 수정할 필요는 없습니다."
        : commitment
        ? "원래 답변과 검토 기록은 보존합니다. 읽기 전용 조사 범위에 맞춰 답변을 다시 검토하고, 검토가 끝나기 전에는 공개하지 않습니다."
        : exhausted
          ? "과거 실행의 횟수 한도 중단 기록입니다. 새 실행의 횟수 정책과 실제 진행 기록을 확인합니다. 미검토 초안을 완료 답변으로 공개하지 않습니다."
          : incomplete === "max_output_tokens"
            ? "해당 단계의 입력과 출력 범위를 확인한 뒤 완결된 응답이 저장되는지 다시 검증합니다. 부분 응답을 완료 답변으로 공개하지 않습니다."
            : incomplete === "content_filter"
              ? "요청과 근거의 적절성을 검토합니다. 필터를 우회하거나 부분 응답을 최종 결과로 사용하지 않습니다."
              : incomplete === "unknown"
                ? "해당 단계의 안전한 진단 기록을 확인하고 새 실행에서 응답 완료 여부를 검증합니다."
                : capacity
                  ? "저장된 서버 재시도 기록을 확인합니다. 제한이 계속되면 대기 후 재실행하거나 검증된 다른 공급자 연결을 검토합니다. 자동 공급자 전환이 완료됐다는 뜻은 아닙니다."
                  : schema
                    ? "지원되는 출력 스키마로 수정한 새 실행에서 모델 호출·도구 실행·최종 검토를 각각 재검증합니다."
                    : denied
                      ? "실행 계정과 해당 리소스의 권한을 확인한 뒤 실패 단계부터 다시 검증합니다."
                      : "실패 단계의 진단과 실제 응답을 확인하고 새 실행을 시작합니다. 다른 단계의 성공을 추정하지 않습니다.",
    };
  }
  return {
    stages,
    timeline,
    timeline_truncated: truncated,
    stage_coverage: truncated ? "partial_checkpoints" : "stored_checkpoints",
    failure_summary,
  };
}

export function projectRunMetrics(run) {
  const integer = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : null;
  const source =
    run?.metrics &&
    typeof run.metrics === "object" &&
    !Array.isArray(run.metrics)
      ? run.metrics
      : {};
  return {
    count_policy: run?.count_policy === "unset" ? "unset" : null,
    elapsed_ms: integer(run?.elapsed_ms),
    metrics: Object.fromEntries(
      [
        "plan_response_count",
        "plan_review_response_count",
        "model_response_count",
        "review_response_count",
        "retry_count",
        "reported_usage_response_count",
        "total_tokens",
      ].map((key) => [key, integer(source[key])]),
    ),
  };
}

export function projectInvestigationQuality(run, safeText = (value) => value) {
  const result = {
    result_format: "legacy",
    user_result: null,
    investigation_plan: null,
    check_coverage: [],
    candidate_results: [],
  };
  const text = (v, max) => typeof v === "string" && v.length <= max;
  const plan = run.investigation_plan;
  if (plan) {
    if (
      !Array.isArray(plan.checks) ||
      plan.checks.length > 24 ||
      !plan.checks.length
    )
      throw Error("invalid_quality_projection");
    const seen = new Set();
    result.investigation_plan = {
      checks: plan.checks.map((c) => {
        if (
          !/^check_[a-z0-9_]{1,40}$/.test(c.check_id || "") ||
          seen.has(c.check_id) ||
          !["screen", "expected_rule", "question"].every((k) =>
            text(c[k], 1000),
          ) ||
          !Array.isArray(c.required_tools) ||
          c.required_tools.length > 24 ||
          c.required_tools.some((t) => !/^[a-z][a-z0-9_]{0,63}$/.test(t))
        )
          throw Error("invalid_quality_projection");
        seen.add(c.check_id);
        return {
          check_id: c.check_id,
          screen: safeText(c.screen),
          expected_rule: safeText(c.expected_rule),
          question: safeText(c.question),
          required_tools: c.required_tools,
        };
      }),
    };
  }
  if (run.status !== "completed" || run.review?.accepted !== true)
    return result;
  const user = run.answer?.user_result;
  if (run.candidate_verifications !== undefined) {
    const records = run.candidate_verifications;
    const candidates = run.answer?.candidate_findings;
    if (
      !Array.isArray(records) ||
      records.length > 20 ||
      !Array.isArray(candidates) ||
      candidates.length !== records.length
    )
      throw Error("invalid_quality_projection");
    const seen = new Set();
    result.candidate_results = records.map((record) => {
      const candidate = candidates.find(
        (c) => c.candidate_id === record.candidate_id,
      );
      const v = record.verification;
      if (
        !candidate ||
        !verificationMatchesCandidate(record, candidate) ||
        seen.has(record.candidate_id) ||
        record.verifier_role !== "candidate_verifier" ||
        !/^[a-f0-9-]{36}$/.test(record.verifier_run_id || "") ||
        !/^[a-f0-9]{64}$/.test(record.record_hash || "") ||
        !["incident_cause", "current_observation"].includes(
          candidate.claim_scope,
        ) ||
        !["confirmed", "needs_validation", "rejected"].includes(v?.verdict) ||
        v.candidate_id !== record.candidate_id ||
        !text(v.summary, 1500) ||
        !Array.isArray(v.blockers) ||
        v.blockers.length > 20 ||
        v.blockers.some((b) => !text(b, 1500))
      )
        throw Error("invalid_quality_projection");
      seen.add(record.candidate_id);
      return {
        verdict: v.verdict,
        claim_scope: candidate.claim_scope,
        summary: safeText(v.summary),
        blockers: v.blockers.map(safeText),
      };
    });
  }
  if (user) {
    const limits = {
      headline: 100,
      what_happened: 500,
      observed_expected: 500,
      next_action: 300,
    };
    if (
      Object.entries(limits).some(([k, n]) => !text(user[k], n)) ||
      ![
        "actionable_finding",
        "needs_input",
        "source_blocked",
        "inconclusive",
      ].includes(user.result_kind)
    )
      throw Error("invalid_quality_projection");
    result.result_format = "structured_v1";
    result.user_result = {
      ...Object.fromEntries(
        Object.keys(limits).map((k) => [k, safeText(user[k])]),
      ),
      result_kind: user.result_kind,
    };
  }
  const rows = run.answer?.coverage;
  if (rows) {
    if (!Array.isArray(rows) || rows.length > 24)
      throw Error("invalid_quality_projection");
    const seen = new Set(),
      ids = new Set(
        result.investigation_plan?.checks.map((c) => c.check_id) || [],
      );
    result.check_coverage = rows.map((r) => {
      if (
        !ids.has(r.check_id) ||
        seen.has(r.check_id) ||
        ![
          "supported",
          "contradicted",
          "unavailable",
          "not_applicable",
        ].includes(r.status) ||
        !text(r.missing_data, 1000) ||
        !Array.isArray(r.evidence_ids) ||
        r.evidence_ids.length > 50 ||
        r.evidence_ids.some((id) => !/^ev_[a-f0-9]{64}$/.test(id))
      )
        throw Error("invalid_quality_projection");
      seen.add(r.check_id);
      return {
        check_id: r.check_id,
        status: r.status,
        missing_data: safeText(r.missing_data),
        evidence_count: r.evidence_ids.length,
      };
    });
  }
  return result;
}
