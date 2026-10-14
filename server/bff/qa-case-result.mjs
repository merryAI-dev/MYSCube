import { candidateHash, verificationMatchesCandidate } from '../qa-shared/candidate-integrity.mjs';
import { projectIssueReceipt } from '../qa-shared/issue-receipt.mjs';
import { createHttpError } from './bff-utils.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const unavailable = (code = 'qa_case_result_invalid') =>
  createHttpError(503, 'QA 조사 결과를 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.', code);
const denied = () => createHttpError(403, 'QA 조사 권한을 다시 확인해 주세요.', 'qa_case_result_revoked');
const gone = () => createHttpError(404, 'QA 접수를 찾을 수 없습니다.', 'qa_case_not_found');
const data = (snapshot) => snapshot?.data?.() || null;
const changed = (before, after) => candidateHash(before) !== candidateHash(after);

function safeText(value, max = 12000) {
  if (typeof value !== 'string' || value.length > max || !value.trim()) throw unavailable();
  return value.replace(/Bearer\s+\S+/gi, 'Bearer [비공개]')
    .replace(/(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,})/g, '[비밀정보 비공개]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 비공개]')
    .replace(/\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b/g, '[전화번호 비공개]')
    .replace(/\bev_[a-f0-9]{64}\b/gi, '[근거 번호 비공개]');
}
function safeStrings(values, max = 50) {
  if (!Array.isArray(values) || values.length > max) throw unavailable();
  return values.map((value) => safeText(value, 4000));
}
const USER_RESULT_FIELDS = ['headline', 'what_happened', 'observed_expected', 'next_action', 'result_kind'];
const RESULT_KINDS = new Set(['actionable_finding', 'needs_input', 'source_blocked', 'inconclusive']);
function safeUserResult(value) {
  if (value == null) return null; // Older reviewed answers did not have this field.
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== USER_RESULT_FIELDS.length
    || USER_RESULT_FIELDS.some((field) => !Object.hasOwn(value, field))
    || !RESULT_KINDS.has(value.result_kind)) throw unavailable();
  const observed = value.observed_expected;
  if (typeof observed !== 'string' || observed.length > 500) throw unavailable();
  return {
    headline: safeText(value.headline, 100),
    what_happened: safeText(value.what_happened, 500),
    observed_expected: observed.trim() ? safeText(observed, 500) : '',
    next_action: safeText(value.next_action, 300),
    result_kind: value.result_kind,
  };
}
function answerProjection(run) {
  const answer = run.answer;
  if (run.review?.accepted !== true || !answer || !Array.isArray(answer.facts)
    || !['supported', 'not_established'].includes(answer.cause_status)) throw unavailable('qa_case_review_required');
  const candidates = answer.candidate_findings;
  const records = run.candidate_verifications;
  if (!Array.isArray(candidates) || !Array.isArray(records) || candidates.length > 20
    || records.length !== candidates.length || new Set(candidates.map((item) => item?.candidate_id)).size !== candidates.length)
    throw unavailable('qa_case_candidate_integrity');
  const recordById = new Map(records.map((record) => [record?.candidate_id, record]));
  if (recordById.size !== records.length || candidates.some((candidate) => {
    const record = recordById.get(candidate.candidate_id);
    return !verificationMatchesCandidate(record, candidate) || record.verifier_role !== 'candidate_verifier'
      || !UUID.test(record.verifier_run_id || '');
  }) || (answer.cause_status === 'supported' && !candidates.some((candidate) =>
    candidate.claim_scope === 'incident_cause' && candidate.proposed_verdict === 'confirmed')))
    throw unavailable('qa_case_candidate_integrity');
  if (answer.facts.length > 50 || answer.facts.some((fact) => !fact || typeof fact.claim !== 'string')) throw unavailable();
  const userResult = safeUserResult(answer.user_result);
  return { user_reply: safeText(answer.user_reply), facts: answer.facts.map((fact) => safeText(fact.claim, 4000)),
    next_actions: safeStrings(answer.next_actions), unknowns: safeStrings(answer.unknowns),
    cause_status: answer.cause_status,
    ...(userResult ? { user_result: userResult } : {}) };
}

export function createQaCaseResultService({ db, authorizeCase }) {
  if (typeof authorizeCase !== 'function') throw Error('qa_case_authority_required');
  return {
    async get(context, caseId) {
      if (!UUID.test(caseId || '')) throw createHttpError(400, 'QA 접수 번호를 확인해 주세요.', 'qa_case_id_invalid');
      if (context?.authSource !== 'firebase' || context.tenantId !== 'mysc' || !context.actorId) throw denied();
      const base = `orgs/${context.tenantId}`;
      const memberRef = db.doc(`${base}/members/${context.actorId}`);
      const linkRef = db.doc(`${base}/qa_actor_business_links/${context.actorId}`);
      const caseRef = db.doc(`${base}/qa_cases/${caseId}`);
      const initial = await db.runTransaction(async (tx) => {
        if (data(await tx.get(memberRef))?.status !== 'ACTIVE') throw denied();
        const qa = data(await tx.get(caseRef));
        if (!qa || qa.actor_id !== context.actorId) throw gone();
        if (qa.case_id !== caseId || qa.workspace_id !== context.tenantId || !qa.investigation_scope) throw unavailable();
        if (qa.case_status === 'cancelled') throw denied();
        const legacy = !qa.investigation_event_id && qa.aggregate_version === 1;
        const eventRef = legacy
          ? caseRef.collection('activity').doc('0000000001')
          : db.doc(`${base}/qa_kafka_outbox/${qa.investigation_event_id}`);
        const event = data(await tx.get(eventRef));
        if (!event || event.case_id !== caseId || !UUID.test(event.event_id || '')
          || (legacy ? event.activity_type !== 'case_received'
            : event.event_id !== qa.investigation_event_id || event.workspace_id !== context.tenantId
              || event.event_type !== 'qa.investigation.requested'
              || event.aggregate_version !== qa.aggregate_version)) throw unavailable();
        const dispatchRef = db.doc(`${base}/qa_dispatches/${event.event_id}`);
        const dispatch = data(await tx.get(dispatchRef));
        const runId = `qa-${event.event_id}`;
        if (dispatch && (dispatch.case_id !== caseId || dispatch.event_id !== event.event_id
          || dispatch.dispatch_id !== event.event_id || dispatch.run_id !== runId
          || dispatch.workspace_id !== context.tenantId)) throw unavailable();
        const runRef = db.doc(`${base}/qa_runs/${runId}`);
        const run = dispatch ? data(await tx.get(runRef)) : null;
        if (run && (run.run_id !== runId || run.case_id !== caseId || run.dispatch_id !== event.event_id
          || run.case_actor_id !== context.actorId || run.tenant_id !== context.tenantId
          || run.source !== 'authenticated_case')) throw unavailable();
        // Before Kafka projection there is no bound run. A link check still blocks self-unlinked accounts.
        if (!dispatch) {
          const link = data(await tx.get(linkRef));
          if (link?.status !== 'ACTIVE' || link.qa_actor_id !== context.actorId
            || link.source !== 'dual_firebase_tokens') throw denied();
        }
        return { qa, event, eventRef, dispatch, run, runId, dispatchRef, runRef };
      });
      let businessActorId;
      if (initial.dispatch) {
        try {
          const decision = await authorizeCase({ caseId, runId: initial.runId, phase: initial.run ? 'run' : 'intake',
            actorId: context.actorId, scope: initial.qa.investigation_scope });
          businessActorId = decision.businessActorId;
          if (typeof businessActorId !== 'string' || !businessActorId) throw Error('invalid_authority');
        } catch (error) {
          if (error?.code === 'investigation_authority_revoked') throw denied();
          throw unavailable('qa_case_authority_unavailable');
        }
      }
      // The authority call crosses services. Recheck all locally read bindings after it.
      let githubIssue = null;
      const latest = await db.runTransaction(async (tx) => {
        if (data(await tx.get(memberRef))?.status !== 'ACTIVE') throw denied();
        const link = data(await tx.get(linkRef));
        if (link?.status !== 'ACTIVE' || link.qa_actor_id !== context.actorId
          || link.source !== 'dual_firebase_tokens'
          || (businessActorId && link.business_actor_id !== businessActorId)) throw denied();
        const [caseSnap, eventSnap, dispatchSnap, runSnap] = await Promise.all([
          tx.get(caseRef), tx.get(initial.eventRef),
          initial.dispatch ? tx.get(initial.dispatchRef) : Promise.resolve(null),
          initial.run ? tx.get(initial.runRef) : Promise.resolve(null),
        ]);
        if (changed(initial.qa, data(caseSnap)) || changed(initial.event, data(eventSnap))
          || changed(initial.dispatch, data(dispatchSnap)) || changed(initial.run, data(runSnap)))
          throw createHttpError(409, 'QA 조사 상태가 바뀌었습니다. 다시 불러와 주세요.', 'qa_case_result_changed');
        const currentRun = data(runSnap);
        const publication = data(await tx.get(db.doc(`${base}/qa_github_publications/${caseId}`)));
        githubIssue = projectIssueReceipt(publication, initial.qa, currentRun);
        return currentRun;
      });
      if (!latest) return { case_id: caseId, state: 'pending', updated_at: initial.dispatch?.updated_at || initial.qa.updated_at, answer: null };
      if (latest.status === 'failed') return { case_id: caseId, state: 'failed', updated_at: latest.updated_at, answer: null,
        failure: { category: latest.error_code === 'investigation_provider_credit_exhausted' ? 'provider_credit_exhausted' : 'execution_failed' } };
      if (latest.status === 'needs_review') return { case_id: caseId, state: 'needs_review', updated_at: latest.updated_at, answer: null };
      if (latest.status !== 'completed') return { case_id: caseId, state: 'pending', updated_at: latest.updated_at, answer: null };
      if (latest.review?.accepted !== true) return { case_id: caseId, state: 'needs_review', updated_at: latest.updated_at, answer: null };
      return { case_id: caseId, state: 'completed', updated_at: latest.updated_at, answer: answerProjection(latest), github_issue: githubIssue };
    },
  };
}

export function mountQaCaseResultRoutes(app, { db, authorizeCase, asyncHandler }) {
  const service = createQaCaseResultService({ db, authorizeCase });
  app.get('/api/v1/qa-cases/:id/result', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.get(req.context, req.params.id));
  }));
}
