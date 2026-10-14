import { candidateHash } from "../qa-shared/candidate-integrity.mjs";

const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/;
const STAGES = new Set([
  "observation",
  "code",
  "logs",
  "state",
  "deployment",
  "writer",
]);
const PUBLIC_STAGES = new Set(["preparing", ...STAGES, "evidence_review", "resume_pending"]);

// Only server checkpoint types can change the member-facing progress stage.
// The model's session_state and arbitrary checkpoint payload never leave the run.
export function nextPublicStage({ event, current = "preparing" }) {
  const safeCurrent = PUBLIC_STAGES.has(current) ? current : "preparing";
  if (
    event?.phase === "answer_validation_started" ||
    event?.phase === "review_session_opened"
  )
    return "evidence_review";
  if (
    event?.phase === "session_opened" &&
    event.role !== "candidate_verifier" &&
    STAGES.has(event.stage)
  )
    return event.stage;
  return safeCurrent;
}

export function evidenceRecord({
  item,
  runId,
  runBinding,
  ledger,
  alreadyStored,
}) {
  if (!item || !EVIDENCE_ID.test(item.evidence_id || "")) return null;
  const descriptor = ledger?.observe(item);
  if (alreadyStored) return null;
  return {
    evidence_id: item.evidence_id,
    run_id: runBinding?.run_id || runId,
    ...(runBinding
      ? {
          tenant_id: runBinding.tenant_id,
          case_id: runBinding.case_id,
          case_input_hash: runBinding.case_input_hash,
          aggregate_version: runBinding.aggregate_version,
        }
      : {}),
    source: item.source,
    status: item.status,
    observed_at: item.observed_at,
    payload_json: JSON.stringify(item),
    payload_sha256: descriptor?.content_sha256 || candidateHash(item),
  };
}

export function nextModelStep({ pipeline, role, phase, current, step }) {
  if (role === "candidate_verifier" || (pipeline && phase !== "session_closed"))
    return current;
  return Math.max(current, step || 0);
}

export function sessionStateRecord({ event, runBinding, observedEvidence }) {
  if (event.phase !== "session_closed" || event.role === "candidate_verifier")
    return null;
  const state = event.session_state;
  if (
    !runBinding ||
    !state ||
    !STAGES.has(state.stage) ||
    !Number.isSafeInteger(state.ordinal) ||
    state.ordinal !== event.step ||
    !Array.isArray(state.requested_evidence_ids) ||
    state.requested_evidence_ids.some(
      (id) => !EVIDENCE_ID.test(id) || !observedEvidence.has(id),
    ) ||
    Buffer.byteLength(JSON.stringify(state)) > 98304
  )
    throw new Error("investigation_session_state_invalid");
  return {
    ...state,
    run_binding: runBinding,
    state_sha256: candidateHash({ run_binding: runBinding, state }),
  };
}

export function continuationPatch({event, persistedSession}) {
  if (event.clear_pending_answer === true && !persistedSession)
    throw new Error('investigation_pending_clear_without_session');
  return {
    ...(persistedSession ? {session_state:persistedSession} : {}),
    ...(event.phase === 'pending_answer_saved' ? {pending_answer:event.pending_answer} : {}),
    ...(event.phase === 'pending_answer_stale' || event.clear_pending_answer === true
      ? {pending_answer:null} : {}),
  };
}

export function deadlineContinuation({deadlineExpired,leaseAborted,abortRelated,runBinding,
  session,startOrdinal,pending,receipt,currentManifestHash,reportHash,authorityBinding,currentEvidence,draftProtocol,reviewProtocol}) {
  if (!deadlineExpired || leaseAborted || !abortRelated || !session || !runBinding
    || !Number.isSafeInteger(startOrdinal) || startOrdinal < 0) return null;
  const {state_sha256,run_binding,...state}=session;
  if (candidateHash(run_binding)!==candidateHash(runBinding)
    || state_sha256!==candidateHash({run_binding,state})
    || !Number.isSafeInteger(state.ordinal) || state.ordinal<startOrdinal) return null;
  let resumableReview=false;
  if (pending && receipt) {
    const {snapshot_sha256,...body}=pending;
    resumableReview = snapshot_sha256===candidateHash(body)
      && candidateHash(body.context?.run_binding)===candidateHash(runBinding)
      && !!draftProtocol && body.context?.protocol_sha256===draftProtocol
      && !!reviewProtocol && receipt.snapshot?.implementation_sha256===reviewProtocol
      && body.context?.evidence_manifest_sha256===currentManifestHash
      && body.context?.report_sha256===reportHash
      && candidateHash(body.context?.authority_binding)===candidateHash(authorityBinding)
      && receipt.snapshot?.answer_sha256===candidateHash(body.answer)
      && receipt.snapshot?.report_sha256===reportHash
      && candidateHash(receipt.snapshot?.run_binding)===candidateHash(runBinding)
      && candidateHash(receipt.snapshot?.authority_binding)===candidateHash(authorityBinding)
      && candidateHash(receipt.snapshot?.evidence)===candidateHash(currentEvidence);
  }
  if (state.ordinal<=startOrdinal && !resumableReview) return null;
  return {execution_yield_reason:'execution_deadline',
    execution_yield_checkpoint_sha256:state_sha256,
    execution_yield_pending_sha256:resumableReview?pending.snapshot_sha256:null};
}
