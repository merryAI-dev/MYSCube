import { collectInitialObservation } from './initial-observation.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
import { connectPipelineMcpSources } from './pipeline-mcp.mjs';
import { createPipelineInvestigationTools } from './pipeline-tools.mjs';
import { validateReaderLanguage } from "./reader-language.mjs";
import {
  deriveBlockedDependencies,
  reconcileInvestigationQuality,
} from "./investigation-quality.mjs";
import {
  validateCandidateFindings,
  candidateVerdictGate,
} from "./candidate-ledger.mjs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { runInvestigation, reviewInvestigation } from "./agent.mjs";
import { createInvestigationTools, loadEvaluationReport } from "./tools.mjs";
import { createCodeTools } from "./code-tools.mjs";
import {
  createDeploymentTools,
  createDeploymentObservationTool,
} from "./deployment-tools.mjs";
import { createBffLogSnapshotTools } from "./bff-log-snapshot-tools.mjs";
import {
  DRAFT_PROTOCOL,
  runOpenAIInvestigation,
  reviewOpenAIInvestigation,
  planOpenAIInvestigation,
  createOpenAICandidateVerifier,
} from "./openai-agent.mjs";
import { REVIEW_IMPLEMENTATION_SHA256 } from "./review-sessions.mjs";
import { createCaseAuthorityClient } from "./authority-client.mjs";
import { loadPipelineContext } from "./pipeline-context.mjs";
import { emptyMetrics, checkpointMetrics } from "./metrics.mjs";
import { createSessionContext } from "./session-context.mjs";
import {
  evidenceRecord,
  nextModelStep,
  nextPublicStage,
  sessionStateRecord,
  continuationPatch,
  deadlineContinuation,
} from "./runner-persistence.mjs";

// Dynamic cases use authenticated server bindings. Packaged reports remain
// explicitly labeled evaluation inputs and are never used as a live fallback.
const projectId = process.env.GOOGLE_CLOUD_PROJECT;
const runId = process.env.QA_RUN_ID;
const model = process.env.QA_MODEL;
const provider = process.env.QA_PROVIDER || "vertex";
if (
  projectId !== "inner-platform-qa-20260310" ||
  !/^[a-z0-9-]{8,100}$/.test(runId || "") ||
  !model ||
  !["vertex", "openai"].includes(provider) ||
  process.env.FIRESTORE_EMULATOR_HOST ||
  process.env.FIREBASE_AUTH_EMULATOR_HOST
) {
  throw new Error("invalid_cloud_investigation_configuration");
}
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});
const client = await auth.getClient().catch(() => {
  throw new Error("investigation_auth_unavailable");
});
const pipeline =
  process.env.QA_REPORT_ID === "case"
    ? await loadPipelineContext({
        client,
        dispatchId: process.env.QA_DISPATCH_ID,
        runId,
        tenantId: process.env.QA_TENANT_ID,
        authorizeScope: createCaseAuthorityClient({
          auth,
          origin: process.env.QA_AUTHORITY_ORIGIN,
        }),
      })
    : null;
if (pipeline && provider !== "openai")
  throw new Error("investigation_pipeline_provider_invalid");
const { reportId, title, request } =
  pipeline || (await loadEvaluationReport(process.env.QA_REPORT_ID ?? "dtips"));
const apiKey =
  provider === "openai"
    ? (
        await readFile("/secrets/openai/key", "utf8").catch(() => {
          throw new Error("openai_secret_unavailable");
        })
      ).trim()
    : undefined;
if (provider === "openai" && !apiKey)
  throw new Error("openai_secret_unavailable");
const inputHash = createHash("sha256")
  .update(JSON.stringify(request))
  .digest("hex");
const tenant = request.policy.tenant;
const root = `projects/${projectId}/databases/qa-assistant/documents`;
const runPath = `${root}/orgs/${tenant}/qa_runs/${runId}`;
const endpoint = `https://firestore.googleapis.com/v1/${root}:commit`;
const observedEvidence = new Map();
const observedTools = new Set();
let checkpointCount = 0,
  toolCount = 0,
  lastStep = 0,
  lastReview;
let metrics = emptyMetrics();
let investigationPlan;
let observeRuntimeEvidence = () => {};
let observeSourceEvidence = () => {};
let dependencyResolvers = {};
let requiredFollowups = () => [];
let startedAtMs = Date.now();
// High-reasoning investigation and independent review share one bounded deadline.
const executionTimeoutMs = (provider === "openai" ? 90 : 25) * 60 * 1000;
const leaseAbort = new AbortController();
const deadlineSignal = AbortSignal.timeout(executionTimeoutMs);
const signal = AbortSignal.any([
  deadlineSignal,
  leaseAbort.signal,
]);
let heartbeat;
let verifyCandidates;
let candidateRecords = [];

function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number" && Number.isSafeInteger(value))
    return { integerValue: String(value) };
  if (typeof value === "number" && Number.isFinite(value))
    return { doubleValue: value };
  if (Array.isArray(value))
    return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === "object")
    return {
      mapValue: {
        fields: Object.fromEntries(
          Object.entries(value).map(([k, v]) => [k, encode(v)]),
        ),
      },
    };
  throw new Error("invalid_persisted_value");
}
const fields = (object) =>
  Object.fromEntries(
    Object.entries(object).map(([key, value]) => [key, encode(value)]),
  );
async function commit(writes) {
  if (pipeline) return pipeline.commit(writes);
  try {
    await client.request({
      url: endpoint,
      method: "POST",
      data: { writes },
      timeout: 30000,
      retry: false,
    });
  } catch {
    // A raw SDK error may carry HTTP headers. Never allow it to reach stderr.
    throw Object.assign(new Error("investigation_persistence_failed"), {
      code: "investigation_persistence_failed",
    });
  }
}
const update = (name, object) => ({
  update: { name, fields: fields(object) },
  updateMask: { fieldPaths: Object.keys(object) },
  currentDocument: { exists: true },
});
const create = (name, object) => ({
  update: { name, fields: fields(object) },
  currentDocument: { exists: false },
});

const now = new Date().toISOString();
const initialRun = {
  schema_version: 1,
  run_id: runId,
  tenant_id: tenant,
  platform_key: "myscube",
  visibility: pipeline ? "private" : "organization",
  source: pipeline ? "authenticated_case" : "operator_supplied_report",
  reporter_verified: !!pipeline,
  report_id: reportId,
  title,
  status: "running",
  model,
  provider,
  created_at: now,
  updated_at: now,
  checkpoint_count: 0,
  model_step: 0,
  evidence_count: 0,
  current_stage: "preparing",
  session_count: 0,
  tool_count: 0,
  tool_names: [],
  input_hash: inputHash,
  build_id: process.env.QA_BUILD_ID || "unknown",
  execution_name: process.env.CLOUD_RUN_EXECUTION || "unknown",
  verification_kind: pipeline
    ? "authenticated_cloud_case"
    : "real_cloud_evaluation",
  delivery_status: "not_sent",
  execution_deadline_at: new Date(
    Date.now() + executionTimeoutMs,
  ).toISOString(),
  count_policy: "unset",
  metrics,
  elapsed_ms: 0,
};
let priorEvidence = [];
let priorEvidenceRecords = [];
let resumeSession = null;
let pendingAnswer = null;
let durableSession = null, durablePending = null, durableReviewReceipt = null;
const knownReviewReceipts = new Set();
let currentStage = initialRun.current_stage;
if (pipeline) {
  const resume = await pipeline.begin(initialRun);
  if (resume.skip) {
    console.log(
      JSON.stringify({ run_id: runId, phase: "lease_or_terminal_skip" }),
    );
    process.exit(0);
  }
  priorEvidence = resume.priorEvidence;
  priorEvidenceRecords = resume.priorEvidenceRecords;
  if (resume.previous) {
    const previous = resume.previous;
    investigationPlan = previous.investigation_plan;
    checkpointCount = previous.checkpoint_count || 0;
    toolCount = previous.tool_count || 0;
    lastStep = previous.model_step || 0;
    metrics = previous.metrics || emptyMetrics();
    currentStage = previous.current_stage || currentStage;
    resumeSession = previous.session_state || null;
    pendingAnswer = previous.pending_answer || null;
    startedAtMs = Date.now() - (previous.elapsed_ms || 0);
    for (const name of previous.tool_names || []) observedTools.add(name);
    for (const item of priorEvidence)
      observedEvidence.set(item.evidence_id, item);
  }
  heartbeat = setInterval(
    () => pipeline.heartbeat().catch(() => leaseAbort.abort()),
    60000,
  );
} else await commit([create(runPath, initialRun)]);
durableSession = resumeSession;
durablePending = pendingAnswer;
const executionStartOrdinal = lastStep;
const runBinding = pipeline?.runBinding;
const sessionLedger = pipeline
  ? createSessionContext({
      runBinding,
      report: request.report,
      priorEvidence: priorEvidenceRecords,
    })
  : null;

async function checkpoint(event) {
  const eventIndex = checkpointCount + 1;
  const nextMetrics = checkpointMetrics(metrics, event);
  const nextStage = nextPublicStage({ event, current: currentStage });
  const timestamp = new Date().toISOString();
  const writes = [];
  const initialRecords = [];
  if (event.phase === "tool_completed") {
    toolCount++;
    for (const result of event.results || []) {
      if (result.name !== "finalize_investigation")
        observedTools.add(result.name);
      const item = result.result?.output;
      if (item && /^ev_[a-f0-9]{64}$/.test(item.evidence_id || "")) {
        const record = evidenceRecord({
          item,
          runId,
          runBinding,
          ledger: sessionLedger,
          alreadyStored: observedEvidence.has(item.evidence_id),
        });
        if (record) {
          if (event.origin === "initial_observation") initialRecords.push({documentId:item.evidence_id,stored:record});
          writes.push(
            create(`${runPath}/evidence/${item.evidence_id}`, record),
          );
          observedEvidence.set(item.evidence_id, item);
          observeRuntimeEvidence(item);
          observeSourceEvidence(item);
        }
      }
    }
  }
  // A fresh session can be retried from the last closed handoff. A verifier
  // never advances the main investigator's continuation cursor.
  const persistedSession = sessionStateRecord({
    event,
    runBinding,
    observedEvidence,
  });
  lastStep = nextModelStep({
    pipeline: !!pipeline,
    role: event.role,
    phase: event.phase,
    current: lastStep,
    step: event.step,
  });
  // Internal checkpoint content is never returned by the member dashboard API.
  writes.push(
    create(`${runPath}/checkpoints/${String(eventIndex).padStart(8, "0")}`, {
      sequence: eventIndex,
      phase: event.phase,
      occurred_at: timestamp,
      model_step:
        event.role === "candidate_verifier"
          ? event.step || 0
          : event.step || lastStep,
      payload_json: JSON.stringify(event),
    }),
  );
  writes.push(
    update(runPath, {
      updated_at: timestamp,
      checkpoint_count: eventIndex,
      model_step: lastStep,
      evidence_count: observedEvidence.size,
      current_stage: nextStage,
      session_count: nextMetrics.session_count || 0,
      tool_count: toolCount,
      tool_names: [...observedTools].sort(),
      ...(event.phase === "plan_completed"
        ? { investigation_plan: event.plan }
        : {}),
      ...(event.phase === "candidate_ledger_proposed"
        ? { candidate_findings: event.candidates }
        : {}),
      ...(event.phase === "candidate_verification_batch_completed"
        ? { candidate_verifications: event.records }
        : {}),
      ...continuationPatch({event, persistedSession}),
      metrics: nextMetrics,
      elapsed_ms: Date.now() - startedAtMs,
    }),
  );
  await commit(writes);
  for (const record of initialRecords) {
    priorEvidenceRecords.push(record);
    priorEvidence.push(observedEvidence.get(record.documentId));
  }
  if (persistedSession) durableSession = persistedSession;
  if (event.phase === 'pending_answer_saved') {durablePending = event.pending_answer;durableReviewReceipt = null;}
  if (event.phase === 'pending_answer_stale' || event.clear_pending_answer === true) {durablePending = null;durableReviewReceipt = null;}
  if (event.phase === 'review_session_validated' && !knownReviewReceipts.has(event.receipt_sha256)) {
    durableReviewReceipt = event.receipt;
    knownReviewReceipts.add(event.receipt_sha256);
  }
  checkpointCount = eventIndex;
  metrics = nextMetrics;
  currentStage = nextStage;
  console.log(
    JSON.stringify({
      run_id: runId,
      phase: event.phase,
      model_step: lastStep,
      checkpoint_count: checkpointCount,
      evidence_count: observedEvidence.size,
      tools: (event.toolCalls || []).map((call) => call.name),
    }),
  );
}

async function validateAnswer(answer) {
  await checkpoint({ phase: "answer_validation_started", step: lastStep });
  const errors = investigationPlan
    ? reconcileInvestigationQuality({
        plan: investigationPlan,
        answer,
        evidence: observedEvidence,
        observedTools,
        dependencyBlocks: deriveBlockedDependencies({
          evidence: observedEvidence,
          resolvers: dependencyResolvers,
        }),
      })
    : [];
  errors.push(...requiredFollowups().map(({tool,reason}) => `Continue investigation with ${tool}: ${reason}`));
  errors.push(...validateReaderLanguage(answer));
  if (/ev_[a-f0-9]{64}/i.test(answer.user_reply)) {
    errors.push(
      "Keep internal evidence IDs in structured facts and hypotheses, not in the plain Korean user_reply.",
    );
  }
  for (const claim of answer.facts) {
    if (!claim.evidence_ids.length)
      errors.push("Every fact needs observed evidence IDs.");
    for (const id of claim.evidence_ids) {
      const item = observedEvidence.get(id);
      if (!item || item.status !== "available")
        errors.push(`Fact references unavailable or unknown evidence: ${id}`);
    }
  }
  for (const claim of answer.hypotheses)
    for (const id of claim.evidence_ids) {
      if (!observedEvidence.has(id))
        errors.push(`Unknown hypothesis evidence: ${id}`);
    }
  // Live plans follow the failing path; unrelated Sheet/Slack work is not a
  // mandatory detour. Legacy packaged evaluations keep their original contract.
  const requiredTools = pipeline
    ? []
    : [
        "read_project_state",
        "read_cashflow_sheet_diagnostics",
        "query_runtime_logs",
        "query_client_errors",
        "read_code",
      ];
  if (reportId === "jvm-unconfigured")
    requiredTools.push(
      "read_deployment_observation_snapshot",
      "read_public_deployment_identity",
      "read_bff_request_log_snapshot",
    );
  for (const name of requiredTools) {
    if (!observedTools.has(name))
      errors.push(
        `Investigate using ${name} before finalizing; report failures as unknowns.`,
      );
  }
  if (answer.cause_status === "supported" && !answer.facts.length)
    errors.push("A supported cause requires factual evidence.");
  if (pipeline) {
    errors.push(
      ...validateCandidateFindings(answer.candidate_findings, observedEvidence),
    );
    if (answer.candidate_verifications?.length)
      errors.push(
        "Do not supply verifier records; the server independently creates them.",
      );
  }
  if (errors.length) {
    await checkpoint({
      phase: "answer_validation_failed",
      step: lastStep,
      error_code: "evidence_validation_failed",
      error_count: errors.length,
    });
    return { accepted: false, errors: [...new Set(errors)].slice(0, 20) };
  }
  if (pipeline) {
    await checkpoint({
      phase: "candidate_ledger_proposed",
      candidates: answer.candidate_findings,
    });
    candidateRecords = await verifyCandidates(answer.candidate_findings);
    await checkpoint({
      phase: "candidate_verification_batch_completed",
      records: candidateRecords,
    });
    const candidateErrors = candidateVerdictGate(answer, candidateRecords);
    if (candidateErrors.length) {
      await checkpoint({
        phase: "answer_validation_failed",
        error_code: "evidence_validation_failed",
        error_count: candidateErrors.length,
      });
      return {
        accepted: false,
        errors: [
          ...candidateErrors,
          ...candidateRecords.map(
            (r) =>
              `Independent candidate ${r.candidate_id}: ${r.verification.verdict}. ${r.verification.summary} Missing: ${r.verification.blockers.join("; ")}`,
          ),
        ],
      };
    }
  }
  await checkpoint({ phase: "review_started", step: lastStep });
  const review =
    provider === "openai" ? reviewOpenAIInvestigation : reviewInvestigation;
  const priorReceipts = pipeline ? await pipeline.reviewReceipts() : [];
  for (const record of priorReceipts) knownReviewReceipts.add(record.receipt_sha256);
  lastReview = await review({
    report: investigationPlan
      ? { ...request.report, investigation_plan: investigationPlan }
      : request.report,
    answer,
    evidence: [...observedEvidence.values()],
    ...(pipeline ? { verificationRecords: candidateRecords } : {}),
    ...(pipeline ? { runBinding,
      reviewAuthorityBinding: pipeline.reviewAuthorityBinding(),
      originalClaimsJoin: process.env.QA_ORIGINAL_CLAIMS_JOIN === "true",
      priorReceipts,
    } : {}),
    model,
    projectId,
    location: "global",
    signal,
    onCheckpoint: checkpoint,
    ...(pipeline ? { beforeStep: () => pipeline.authorize() } : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  for (const finding of lastReview.findings) {
    if (finding.evidence_ids.some((id) => !observedEvidence.has(id))) {
      throw new Error("review_unknown_evidence");
    }
  }
  await checkpoint({
    phase: "review_completed",
    step: lastStep,
    review: lastReview,
  });
  return {
    accepted: lastReview.accepted,
    errors: lastReview.findings.map((item) => item.message),
  };
}

let sourceConnection;
try {
  let tools;
  if (pipeline) {
    const sources = await createPipelineInvestigationTools({ pipeline, request, auth, priorEvidence, runBinding });
    ({ tools, dependencyResolvers, observeSourceEvidence, observeRuntimeEvidence, requiredFollowups } = sources);
    if (process.env.QA_SOURCE_TRANSPORT === 'mcp') {
      sourceConnection = await connectPipelineMcpSources({ pipeline, sources, signal });
      tools = sourceConnection.tools;
    }
    verifyCandidates = createOpenAICandidateVerifier({
      toolDiscovery: process.env.QA_TOOL_DISCOVERY === "true",
      tools,
      apiKey,
      model,
      signal,
      runBinding,
      beforeStep: () => pipeline.authorize(),
      onCheckpoint: checkpoint,
    });
  } else
    tools = {
      ...createInvestigationTools({ auth, policy: request.policy }),
      ...(await createCodeTools({ snapshotDir: "./code-snapshots" })),
      ...(reportId === "jvm-unconfigured"
        ? {
            ...createDeploymentTools(),
            ...(await createDeploymentObservationTool({
              snapshotPath: "./jvm-deployment-observation.json",
            })),
            ...(await createBffLogSnapshotTools({
              snapshotPath: "./jvm-bff-log-observation.json",
            })),
          }
        : {}),
    };
  await checkpoint({ phase: "source_catalog_ready", step: 0 });
  if (pipeline) await collectInitialObservation({
    tools, policy:request.policy, runBinding, priorEvidence, resumeSession, pendingAnswer,
    authorize:()=>pipeline.authorize(), onCheckpoint:checkpoint, signal,
  });
  if (provider === "openai" && !investigationPlan)
    investigationPlan = await planOpenAIInvestigation({
      apiKey,
      model,
      report: request.report,
      tools,
      signal,
      onCheckpoint: checkpoint,
      ...(pipeline ? { beforeStep: () => pipeline.authorize() } : {}),
    });
  const investigationReport = investigationPlan
    ? { ...request.report, investigation_plan: investigationPlan }
    : request.report;
  const investigate =
    provider === "openai" ? runOpenAIInvestigation : runInvestigation;
  const answer = await investigate({
    ...(pipeline ? { role: "pipeline_investigator", toolDiscovery: process.env.QA_TOOL_DISCOVERY === "true" } : {}),
    report: investigationReport,
    tools,
    model,
    projectId,
    location: "global",
    onCheckpoint: checkpoint,
    validateAnswer,
    signal,
    ...(pipeline
      ? {
          priorEvidence,
          runBinding,
          priorEvidenceRecords,
          resumeSession,
          pendingAnswer,
          pendingAuthorityBinding:pipeline.reviewAuthorityBinding(),
          startStep: lastStep,
          beforeStep: () => pipeline.authorize(),
        }
      : {}),
    ...(apiKey ? { apiKey } : {}),
  });
  const completedAt = new Date().toISOString();
  await commit([
    update(runPath, {
      status: "completed",
      pending_answer:null,
      answer,
      review: lastReview,
      updated_at: completedAt,
      completed_at: completedAt,
      elapsed_ms: Date.now() - startedAtMs,
    }),
  ]);
  console.log(
    JSON.stringify({
      run_id: runId,
      phase: "persisted_completion",
      evidence_count: observedEvidence.size,
      cause_status: answer.cause_status,
      independent_review_accepted: lastReview?.accepted === true,
      delivery_status: "not_sent",
    }),
  );
} catch (error) {
  // Do not persist SDK diagnostics, authorization headers, or source responses.
  const code = /^investigation_[a-z_]+$/.test(error?.code || "")
    ? error.code
    : signal.aborted
      ? "investigation_timeout"
      : "investigation_failed";
  const continuation = pipeline ? deadlineContinuation({
    deadlineExpired:deadlineSignal.aborted,leaseAborted:leaseAbort.signal.aborted,
    abortRelated:error===deadlineSignal.reason || ['investigation_aborted','investigation_timeout'].includes(error?.code),
    runBinding,session:durableSession,startOrdinal:executionStartOrdinal,
    pending:durablePending,receipt:durableReviewReceipt,
    draftProtocol:DRAFT_PROTOCOL,reviewProtocol:REVIEW_IMPLEMENTATION_SHA256,
    currentManifestHash:sessionLedger.manifestPage({maxBytes:32768}).manifest_hash,
    reportHash:candidateHash(investigationPlan?{...request.report,investigation_plan:investigationPlan}:request.report),
    authorityBinding:pipeline.reviewAuthorityBinding(),
    currentEvidence:[...observedEvidence.values()].map(item=>({evidence_id:item.evidence_id,content_sha256:candidateHash(item)}))
      .sort((a,b)=>a.evidence_id.localeCompare(b.evidence_id)),
  }) : null;
  let statusPersisted = false;
  const yieldedAt = new Date().toISOString();
  await commit([
    ...(continuation ? [create(`${runPath}/checkpoints/${String(checkpointCount+1).padStart(8,'0')}`,{
      sequence:checkpointCount+1,phase:'execution_yielded',occurred_at:yieldedAt,model_step:lastStep,
      payload_json:JSON.stringify({...continuation,execution_name:process.env.CLOUD_RUN_EXECUTION}),
    })] : []),
    update(runPath, {
      status: continuation ? "running" : "failed",
      ...(continuation ? {checkpoint_count:checkpointCount+1,current_stage:"resume_pending"} : {}),
      ...(continuation ? {...continuation,execution_yield_execution:process.env.CLOUD_RUN_EXECUTION} : {}),
      error_code: code,
      updated_at: new Date().toISOString(),
      elapsed_ms: Date.now() - startedAtMs,
    }),
  ]).then(() => {statusPersisted = true;}).catch(() =>
    console.error(
      JSON.stringify({ run_id: runId, phase: "failure_status_unpersisted" }),
    ),
  );
  console.error(
    JSON.stringify({ run_id: runId, phase: !statusPersisted ? "status_unpersisted" : continuation ? "yielded" : "failed", error_code: code }),
  );
  process.exitCode = 1;
} finally {
  await sourceConnection?.close();
  if (heartbeat) clearInterval(heartbeat);
}
