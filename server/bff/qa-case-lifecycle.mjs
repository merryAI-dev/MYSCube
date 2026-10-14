import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from './bff-utils.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';

const UUID = z.string().uuid();
const ACTOR = /^[A-Za-z0-9._:-]{1,128}$/;
const sensitive = /Bearer\s+\S+|(?:AIza[0-9A-Za-z_-]{20,}|sk-[0-9A-Za-z_-]{16,})|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b01[016789][- .]?\d{3,4}[- .]?\d{4}\b/i;
const safeText = (limit) => z.string().trim().min(1).max(limit).refine((value) => !sensitive.test(value));
export const operatorRoles = new Set(['QA_OPERATOR', 'QA_LEAD']);
const severity = z.enum(['low', 'medium', 'high', 'critical']);
const priority = z.enum(['low', 'normal', 'high', 'urgent']);
const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('triage'), expected_version: z.number().int().nonnegative(),
    severity, priority, observed_behavior: safeText(2000),
    expected_outcome: safeText(2000), reason: safeText(500) }).strict(),
  z.object({ action: z.literal('propose_assignment'), expected_version: z.number().int().nonnegative(),
    assignee_id: z.string().regex(ACTOR), reason: safeText(500) }).strict(),
  z.object({ action: z.literal('accept_assignment'), expected_version: z.number().int().nonnegative(),
    reason: safeText(500) }).strict(),
  ...['needs_information', 'investigating', 'fix_in_progress', 'verification_pending', 'deployment_pending', 'cancel']
    .map((action) => z.object({ action: z.literal(action), expected_version: z.number().int().nonnegative(),
      reason: safeText(500) }).strict()),
  z.object({ action: z.literal('reopen'), expected_version: z.number().int().nonnegative(),
    reason: safeText(500) }).strict(),
]);
const allowed = {
  received: new Set(['needs_information', 'investigating', 'cancel']),
  awaiting_connection: new Set(['needs_information', 'investigating', 'cancel']),
  needs_information: new Set(['investigating', 'cancel']),
  investigating: new Set(['needs_information', 'fix_in_progress', 'verification_pending', 'cancel']),
  fix_in_progress: new Set(['verification_pending', 'cancel']),
  verification_pending: new Set(['fix_in_progress', 'deployment_pending', 'cancel']),
  deployment_pending: new Set(['verification_pending', 'cancel']),
  resolved: new Set(['reopen']),
  cancelled: new Set(['reopen']),
};
const fail = (status, code, message = 'QA 사건 상태를 확인해 주세요.') => createHttpError(status, message, code);
const data = (snapshot) => snapshot?.data?.() || null;
function contextGuard(context) {
  if (context?.authSource !== 'firebase' || context.tenantId !== 'mysc' || !ACTOR.test(context.actorId || ''))
    throw fail(401, 'qa_lifecycle_auth_required');
}
export async function actorInTransaction(tx, db, context) {
  contextGuard(context);
  const base = `orgs/${context.tenantId}`;
  const [member, link] = await Promise.all([
    tx.get(db.doc(`${base}/members/${context.actorId}`)),
    tx.get(db.doc(`${base}/qa_actor_business_links/${context.actorId}`)),
  ]);
  const m = data(member), l = data(link);
  if (m?.status !== 'ACTIVE' || l?.status !== 'ACTIVE' || l.qa_actor_id !== context.actorId
    || l.source !== 'dual_firebase_tokens' || !ACTOR.test(l.business_actor_id || ''))
    throw fail(403, 'qa_lifecycle_actor_revoked');
  return { member: m, link: l, operator: operatorRoles.has(m.role) };
}
async function actorForAction(tx, db, context, action) {
  if (action !== 'cancel') return actorInTransaction(tx, db, context);
  contextGuard(context);
  const member = data(await tx.get(db.doc(`orgs/${context.tenantId}/members/${context.actorId}`)));
  if (member?.status !== 'ACTIVE') throw fail(403, 'qa_lifecycle_actor_revoked');
  return { member, link: null, operator: operatorRoles.has(member.role) };
}
async function requireAssignmentRecipient(tx, db, context, body) {
  if (body.action !== 'propose_assignment') return;
  try {
    await actorInTransaction(tx, db, { ...context, actorId: body.assignee_id });
  } catch (error) {
    if (error?.code === 'qa_lifecycle_actor_revoked')
      throw fail(409, 'qa_lifecycle_assignee_unavailable');
    throw error;
  }
}
export function caseBound(qa, caseId, context) {
  if (!qa || qa.case_id !== caseId || qa.workspace_id !== context.tenantId
    || !ACTOR.test(qa.actor_id || '') || !Number.isSafeInteger(qa.aggregate_version)
    || qa.aggregate_version < 1 || !qa.investigation_scope) throw fail(404, 'qa_case_not_found');
}
function nextStatus(current, body, actor, context) {
  const state = current.case_status;
  const action = body.action;
  if (action === 'triage' || action === 'propose_assignment') {
    if (!actor.operator || ['cancelled', 'resolved'].includes(state)) throw fail(403, 'qa_lifecycle_operator_required');
    return state;
  }
  if (action === 'accept_assignment') {
    if (current.proposed_assignee_id !== context.actorId || ['cancelled', 'resolved'].includes(state))
      throw fail(403, 'qa_lifecycle_assignee_required');
    return state;
  }
  if (action === 'reopen') {
    if (!(actor.operator || current.actor_id === context.actorId)) throw fail(403, 'qa_lifecycle_owner_required');
  } else if (action === 'cancel') {
    if (!(actor.operator || current.actor_id === context.actorId)) throw fail(403, 'qa_lifecycle_owner_required');
  } else if (!actor.operator) throw fail(403, 'qa_lifecycle_operator_required');
  if (!allowed[state]?.has(action)) throw fail(409, 'qa_lifecycle_transition_invalid');
  return action === 'cancel' ? 'cancelled' : action === 'reopen' ? 'received' : action;
}

export function createQaCaseLifecycleService({ db, authorizeCase, authorizeReopen, now = () => new Date() }) {
  return {
    async inbox(context, { cursor } = {}) {
      contextGuard(context);
      if (cursor !== undefined && !UUID.safeParse(cursor).success)
        throw fail(400, 'qa_lifecycle_input_invalid');
      const base = `orgs/${context.tenantId}`;
      return db.runTransaction(async tx => {
        await actorInTransaction(tx, db, context);
        let query = db.collection(`${base}/qa_cases`)
          .where('proposed_assignee_id', '==', context.actorId).orderBy('__name__').limit(51);
        if (cursor) query = query.startAfter(db.doc(`${base}/qa_cases/${cursor}`));
        const snapshot = await tx.get(query);
        const page = snapshot.docs.slice(0, 50);
        const items = page.flatMap(doc => {
          const qa = doc.data();
          caseBound(qa, doc.id, context);
          if (qa.proposed_assignee_id !== context.actorId) throw fail(403, 'qa_lifecycle_assignee_required');
          if (['cancelled', 'resolved'].includes(qa.case_status)) return [];
          return [{ case_id: qa.case_id, lifecycle_version: qa.lifecycle_version || 0,
            case_status: qa.case_status, severity: qa.severity || null,
            priority: qa.priority || null, updated_at: qa.updated_at || null }];
        });
        return { items, next_cursor: snapshot.docs.length > 50 ? page.at(-1).id : null,
          observed_at: new Date(now()).toISOString() };
      }, { readOnly: true });
    },
    async read(context, caseId) {
      contextGuard(context);
      if (!UUID.safeParse(caseId).success) throw fail(400, 'qa_lifecycle_input_invalid');
      const base = `orgs/${context.tenantId}`;
      return db.runTransaction(async (tx) => {
        const actor = await actorInTransaction(tx, db, context);
        const qa = data(await tx.get(db.doc(`${base}/qa_cases/${caseId}`)));
        caseBound(qa, caseId, context);
        if (!(actor.operator || qa.actor_id === context.actorId)) throw fail(403, 'qa_lifecycle_owner_required');
        const count = Math.min(qa.lifecycle_version || 0, 50);
        const events = [];
        for (let version = Math.max(1, (qa.lifecycle_version || 0) - count + 1);
          version <= (qa.lifecycle_version || 0); version += 1) {
          const event = data(await tx.get(db.doc(`${base}/qa_case_lifecycle_events/${caseId}_${String(version).padStart(10, '0')}`)));
          if (event) events.push({ lifecycle_version: event.lifecycle_version, action: event.action,
            from_status: event.from_status, to_status: event.to_status,
            actor_id: event.actor_id, reason: event.reason, occurred_at: event.occurred_at });
        }
        return { case_id: caseId, case_status: qa.case_status,
          lifecycle_version: qa.lifecycle_version || 0, input_aggregate_version: qa.aggregate_version,
          severity: qa.severity || null, priority: qa.priority || null,
          proposed_assignee_id: qa.proposed_assignee_id || null, assignee_id: qa.assignee_id || null,
          events };
      }, { readOnly: true });
    },
    async transition(context, caseId, input) {
      contextGuard(context);
      const id = UUID.safeParse(caseId);
      const parsed = actionSchema.safeParse(input);
      if (!id.success || !parsed.success) throw fail(400, 'qa_lifecycle_input_invalid');
      const body = parsed.data;
      const base = `orgs/${context.tenantId}`;
      const caseRef = db.doc(`${base}/qa_cases/${caseId}`);
      // A live source check precedes the write transaction; no network call runs inside it.
      const before = await db.runTransaction(async (tx) => {
        const actor = await actorForAction(tx, db, context, body.action);
        const qa = data(await tx.get(caseRef));
        caseBound(qa, caseId, context);
        const currentVersion = qa.lifecycle_version || 0;
        if (currentVersion !== body.expected_version) throw fail(409, 'qa_lifecycle_version_changed');
        nextStatus(qa, body, actor, context);
        await requireAssignmentRecipient(tx, db, context, body);
        const eventId = qa.investigation_event_id;
        const dispatch = eventId ? data(await tx.get(db.doc(`${base}/qa_dispatches/${eventId}`))) : null;
        const run = dispatch ? data(await tx.get(db.doc(`${base}/qa_runs/${dispatch.run_id}`))) : null;
        return { qa, actor, dispatch, run };
      }, { readOnly: true });
      let trustedBusinessActor;
      const reopening = body.action === 'reopen';
      if (reopening || (body.action !== 'cancel' && before.dispatch)) {
        const authorize = reopening ? authorizeReopen : authorizeCase;
        if (typeof authorize !== 'function' || !UUID.safeParse(before.qa.investigation_event_id).success)
          throw fail(503, 'qa_lifecycle_authority_unavailable');
        try {
          const result = await authorize({ caseId,
            runId: before.dispatch?.run_id || `qa-${before.qa.investigation_event_id}`,
            phase: reopening ? 'reopen' : before.run ? 'run' : 'intake', actorId: before.qa.actor_id,
            scope: before.qa.investigation_scope });
          trustedBusinessActor = result.businessActorId;
          if (!ACTOR.test(trustedBusinessActor || '')) throw Error('invalid authority');
        } catch (error) {
          if (error?.code === 'investigation_authority_revoked') throw fail(403, 'qa_lifecycle_authority_revoked');
          throw fail(503, 'qa_lifecycle_authority_unavailable');
        }
      }
      return db.runTransaction(async (tx) => {
        const actor = await actorForAction(tx, db, context, body.action);
        const qa = data(await tx.get(caseRef));
        caseBound(qa, caseId, context);
        if ((qa.lifecycle_version || 0) !== body.expected_version || qa.aggregate_version !== before.qa.aggregate_version
          || qa.investigation_event_id !== before.qa.investigation_event_id
          || qa.case_status !== before.qa.case_status
          || candidateHash(qa.investigation_scope) !== candidateHash(before.qa.investigation_scope))
          throw fail(409, 'qa_lifecycle_version_changed');
        const latestDispatch = qa.investigation_event_id
          ? data(await tx.get(db.doc(`${base}/qa_dispatches/${qa.investigation_event_id}`))) : null;
        if (candidateHash(latestDispatch) !== candidateHash(before.dispatch))
          throw fail(409, 'qa_lifecycle_version_changed');
        if (trustedBusinessActor) {
          const ownerLink = data(await tx.get(db.doc(`${base}/qa_actor_business_links/${qa.actor_id}`)));
          if (ownerLink?.status !== 'ACTIVE' || ownerLink.business_actor_id !== trustedBusinessActor)
            throw fail(403, 'qa_lifecycle_authority_revoked');
        }
        const status = nextStatus(qa, body, actor, context);
        await requireAssignmentRecipient(tx, db, context, body);
        const version = body.expected_version + 1;
        const at = new Date(now()).toISOString();
        const patch = { lifecycle_version: version, case_status: status, updated_at: at };
        if (body.action === 'triage') Object.assign(patch, { severity: body.severity, priority: body.priority,
          observed_behavior: body.observed_behavior, expected_outcome: body.expected_outcome });
        if (body.action === 'propose_assignment') patch.proposed_assignee_id = body.assignee_id;
        if (body.action === 'accept_assignment') Object.assign(patch, { assignee_id: context.actorId,
          assignment_accepted_at: at, proposed_assignee_id: null });
        let nextEvent = null;
        if (body.action === 'cancel') patch.execution_status = 'cancelled';
        if (body.action === 'reopen') {
          if (qa.aggregate_version >= Number.MAX_SAFE_INTEGER) throw fail(409, 'qa_lifecycle_version_exhausted');
          nextEvent = randomUUID();
          Object.assign(patch, { aggregate_version: qa.aggregate_version + 1,
            investigation_event_id: nextEvent, execution_status: 'queued',
            assignee_id: null, proposed_assignee_id: null });
          tx.create(db.doc(`${base}/qa_kafka_outbox/${nextEvent}`), {
            event_id: nextEvent, schema_version: 1, event_type: 'qa.investigation.requested',
            workspace_id: context.tenantId, case_id: caseId,
            aggregate_type: 'qa_case', aggregate_id: caseId,
            aggregate_version: patch.aggregate_version,
            partition_key: `${context.tenantId}:${caseId}`, occurred_at: at,
            delivery_status: 'intent_saved', attempt_count: 0,
          });
        }
        tx.update(caseRef, patch);
        tx.create(db.doc(`${base}/qa_case_lifecycle_events/${caseId}_${String(version).padStart(10, '0')}`), {
          schema_version: 1, case_id: caseId, lifecycle_version: version,
          input_aggregate_version: patch.aggregate_version || qa.aggregate_version,
          action: body.action, from_status: qa.case_status, to_status: status,
          actor_id: context.actorId, actor_role: actor.member.role,
          reason: body.reason, occurred_at: at,
          ...(nextEvent ? { investigation_event_id: nextEvent } : {}),
          ...(body.action === 'propose_assignment' ? { proposed_assignee_id: body.assignee_id } : {}),
        });
        return { case_id: caseId, case_status: status, lifecycle_version: version,
          investigation_event_id: nextEvent || qa.investigation_event_id || null, updated_at: at };
      });
    },
  };
}

export function mountQaCaseLifecycleRoutes(app, { db, authorizeCase, authorizeReopen, asyncHandler }) {
  const service = createQaCaseLifecycleService({ db, authorizeCase, authorizeReopen });
  app.get('/api/v1/qa-assignment-inbox', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (Object.keys(req.query).some(key => key !== 'cursor')) throw fail(400, 'qa_lifecycle_input_invalid');
    res.json(await service.inbox(req.context, req.query));
  }));
  app.get('/api/v1/qa-cases/:id/lifecycle', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.read(req.context, req.params.id));
  }));
  app.post('/api/v1/qa-cases/:id/lifecycle', asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await service.transition(req.context, req.params.id, req.body));
  }));
}
