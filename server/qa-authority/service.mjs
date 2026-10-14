import { createHash } from 'node:crypto';
import { isActiveActorMember, isProjectInActorScope } from '../bff/cashflow-project-scope.mjs';
import { createQaMembershipOwnerService } from '../bff/qa-membership-owner.mjs';

const TENANT = 'mysc';
const PROJECT = /^p[0-9]{10,20}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ACTOR = /^[A-Za-z0-9._:-]{1,128}$/;
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  return value;
}
export const scopeHash = (scope) => createHash('sha256').update(JSON.stringify(stable(scope))).digest('hex');
const digest = (value) => scopeHash(value);
const deny = (code) => { throw Object.assign(new Error(code), { code, statusCode: 403 }); };
function data(snapshot) { return snapshot?.data?.() || null; }
function validProject(project, id) { return !!project && !project.trashedAt && (!project.id || project.id === id); }
function verifiedEmail(token) {
  const email = typeof token?.email === 'string' ? token.email.trim().toLowerCase() : '';
  if (token?.email_verified !== true || !email.endsWith('@mysc.co.kr') || !ACTOR.test(token?.uid || ''))
    deny('qa_identity_link_denied');
  return email;
}
function validateScope(scope) {
  if (!scope || scope.authority !== 'server_binding' || scope.tenant_id !== TENANT
    || !['platform', 'project'].includes(scope.scope_kind) || !Array.isArray(scope.project_ids)
    || new Set(scope.project_ids).size !== scope.project_ids.length
    || (scope.scope_kind === 'platform' && scope.project_ids.length !== 0)
    || (scope.scope_kind === 'project' && (scope.project_ids.length < 1 || scope.project_ids.length > 20
      || scope.project_ids.some((id) => !PROJECT.test(id))))) deny('qa_scope_invalid');
}

export function createQaAuthorityService({ qaDb, businessDb, getQaUser, getBusinessUser, now = () => new Date() }) {
  if (typeof getQaUser !== 'function' || typeof getBusinessUser !== 'function')
    throw Error('qa_authority_auth_lookup_required');
  const qaBase = `orgs/${TENANT}`;
  const membershipOwner = createQaMembershipOwnerService({ qaDb, now });
  async function requireCurrentAuth(qaActorId, businessActorId, qaAuthTime, businessAuthTime, emailDigest) {
    if (!Number.isSafeInteger(qaAuthTime) || qaAuthTime <= 0
      || !Number.isSafeInteger(businessAuthTime) || businessAuthTime <= 0)
      deny('qa_identity_proof_invalid');
    const [qaUser, businessUser] = await Promise.all([getQaUser(qaActorId), getBusinessUser(businessActorId)]);
    for (const [user, actorId, authTime] of [[qaUser, qaActorId, qaAuthTime],
      [businessUser, businessActorId, businessAuthTime]]) {
      const validSince = Date.parse(user?.tokensValidAfterTime);
      const email = typeof user?.email === 'string' ? user.email.trim().toLowerCase() : '';
      if (user?.uid !== actorId || user.disabled === true || user.emailVerified !== true
        || !email.endsWith('@mysc.co.kr') || digest(email) !== emailDigest
        || !Number.isFinite(validSince)
        || authTime * 1000 < validSince) deny('qa_identity_revoked');
    }
  }
  const liveAcl = async (businessActorId, projectIds) => businessDb.runTransaction(async (tx) => {
    const memberRef = businessDb.doc(`${qaBase}/members/${businessActorId}`);
    const memberSnap = await tx.get(memberRef), member = data(memberSnap);
    if (!isActiveActorMember(member, businessActorId)) deny('qa_business_member_inactive');
    const projects = [];
    for (const id of projectIds) {
      const snapshot = await tx.get(businessDb.doc(`${qaBase}/projects/${id}`));
      if (!validProject(data(snapshot), id)
        || !isProjectInActorScope({ role: member.role, members: [member], actorId: businessActorId, projectId: id }))
        deny('qa_business_project_denied');
      projects.push({ id, update: snapshot.updateTime?.toDate?.().toISOString() || null });
    }
    return { member, source_revision: digest({ businessActorId,
      member_update: memberSnap.updateTime?.toDate?.().toISOString() || null,
      member_role: member.role, projects }) };
  }, { readOnly: true });
  const service = {
    async authorizeMember({ qa_actor_id }) {
      if (!ACTOR.test(qa_actor_id || '')) deny('qa_authority_request_invalid');
      const readIdentity = () => qaDb.runTransaction(async (tx) => {
        const [member, link] = await Promise.all([
          tx.get(qaDb.doc(`${qaBase}/members/${qa_actor_id}`)),
          tx.get(qaDb.doc(`${qaBase}/qa_actor_business_links/${qa_actor_id}`)),
        ]);
        const value = data(link);
        if (!isActiveActorMember(data(member), qa_actor_id) || value?.status !== 'ACTIVE'
          || value.qa_actor_id !== qa_actor_id || value.source !== 'dual_firebase_tokens'
          || !ACTOR.test(value.business_actor_id || '')) deny('qa_identity_link_required');
        return { member: data(member), link: value };
      }, { readOnly: true });
      const before = await readIdentity(), link = before.link;
      await requireCurrentAuth(qa_actor_id, link.business_actor_id,
        link.qa_auth_time, link.business_auth_time, link.email_digest);
      const authority = await liveAcl(link.business_actor_id, []);
      if (digest(before) !== digest(await readIdentity())) deny('qa_identity_revoked');
      return { allowed: true, tenant_id: TENANT, qa_actor_id,
        business_actor_id: link.business_actor_id, link_hash: digest(link),
        source_revision: authority.source_revision, checked_at: new Date(now()).toISOString() };
    },
    async linkOwnIdentity({ qaToken, businessToken, projectId }) {
      const qaEmail = verifiedEmail(qaToken), businessEmail = verifiedEmail(businessToken);
      if (qaEmail !== businessEmail || (projectId != null && !PROJECT.test(projectId)))
        deny('qa_identity_link_denied');
      const qaActorId = qaToken.uid, businessActorId = businessToken.uid;
      await requireCurrentAuth(qaActorId, businessActorId, qaToken.auth_time, businessToken.auth_time, digest(qaEmail));
      const projects = projectId ? [projectId] : [];
      const authority = await liveAcl(businessActorId, projects);
      await membershipOwner.ensure({ qaActorId, businessActorId, sourceRevision: authority.source_revision });
      const checkedAt = new Date(now()).toISOString();
      const link = { status: 'ACTIVE', qa_actor_id: qaActorId, business_actor_id: businessActorId,
        source: 'dual_firebase_tokens', source_checked_at: checkedAt,
        qa_auth_time: qaToken.auth_time, business_auth_time: businessToken.auth_time,
        email_digest: digest(qaEmail), revocation_reason: null, revoked_at: null };
      await qaDb.runTransaction(async (tx) => {
        const member = data(await tx.get(qaDb.doc(`${qaBase}/members/${qaActorId}`)));
        if (!isActiveActorMember(member, qaActorId)) deny('qa_member_inactive');
        const linkRef = qaDb.doc(`${qaBase}/qa_actor_business_links/${qaActorId}`);
        const previousLink = data(await tx.get(linkRef));
        if (previousLink && (previousLink.status !== 'ACTIVE'
          || previousLink.business_actor_id !== businessActorId
          || previousLink.email_digest !== digest(qaEmail))) deny('qa_identity_link_conflict');
        tx.set(linkRef, link);
        if (projectId) {
          const source_revision = authority.source_revision;
          tx.set(qaDb.doc(`${qaBase}/qa_project_grants/${qaActorId}_${projectId}`), {
            status: 'ACTIVE', actor_id: qaActorId, project_id: projectId,
            source_system: 'myscube_business_acl', source_revision,
            source_checked_at: checkedAt, expires_at: new Date(Date.parse(checkedAt) + 300000).toISOString(),
            revoked_at: null,
          });
        }
      });
      return { linked: true, project_id: projectId || null, checked_at: checkedAt };
    },
    async unlinkOwnIdentity({ qaToken }) {
      verifiedEmail(qaToken);
      const qaActorId = qaToken.uid;
      const qaUser = await getQaUser(qaActorId);
      const email = typeof qaUser?.email === 'string' ? qaUser.email.trim().toLowerCase() : '';
      if (qaUser?.uid !== qaActorId || qaUser.disabled === true || qaUser.emailVerified !== true
        || digest(email) !== digest(verifiedEmail(qaToken)))
        deny('qa_identity_revoked');
      await qaDb.runTransaction(async (tx) => {
        const ref = qaDb.doc(`${qaBase}/qa_actor_business_links/${qaActorId}`);
        const previous = data(await tx.get(ref));
        if (!previous || previous.qa_actor_id !== qaActorId || previous.status !== 'ACTIVE'
          || previous.email_digest !== digest(email)) deny('qa_identity_link_required');
        tx.set(ref, { ...previous, status: 'REVOKED', revocation_reason: 'self_unlinked',
          revoked_at: new Date(now()).toISOString() });
      });
      return { unlinked: true };
    },
    async authorizeCaseProject({ case_id, run_id, project_id }) {
      if (!UUID.test(case_id || '') || !UUID.test(run_id?.slice(3) || '')
        || run_id !== `qa-${run_id.slice(3)}` || !PROJECT.test(project_id || ''))
        deny('qa_authority_request_invalid');
      const binding = () => qaDb.runTransaction(async tx => {
        const qa = data(await tx.get(qaDb.doc(`${qaBase}/qa_cases/${case_id}`)));
        const run = data(await tx.get(qaDb.doc(`${qaBase}/qa_runs/${run_id}`)));
        if (!qa || !run || run.status !== 'running' || !ACTOR.test(qa.actor_id || '')
          || !Number.isSafeInteger(qa.aggregate_version) || qa.aggregate_version < 1
          || run.case_aggregate_version !== qa.aggregate_version || run.case_actor_id !== qa.actor_id)
          deny('qa_case_binding_invalid');
        const link = data(await tx.get(qaDb.doc(`${qaBase}/qa_actor_business_links/${qa.actor_id}`)));
        return { case_id: qa.case_id, actor_id: qa.actor_id, aggregate_version: qa.aggregate_version,
          event_id: qa.investigation_event_id || run_id.slice(3), case_status: qa.case_status,
          scope: qa.investigation_scope, link, run_case_id: run.case_id, run_id: run.run_id,
          run_aggregate_version: run.case_aggregate_version ?? null };
      }, { readOnly: true });
      const before = await binding();
      const original = await service.authorizeCase({ case_id, run_id, phase: 'run' });
      if (before.scope?.scope_kind === 'project' && !before.scope.project_ids.includes(project_id))
        deny('qa_business_project_denied');
      const project = await liveAcl(original.business_actor_id, [project_id]);
      const current = await service.authorizeCase({ case_id, run_id, phase: 'run' });
      const currentProject = await liveAcl(current.business_actor_id, [project_id]);
      if (project.source_revision !== currentProject.source_revision
        || digest(before) !== digest(await binding())
        || original.qa_actor_id !== current.qa_actor_id
        || original.business_actor_id !== current.business_actor_id
        || original.scope_hash !== current.scope_hash) deny('qa_case_binding_changed');
      return { ...current, project_id, purpose: 'investigation_read',
        aggregate_version: before.aggregate_version, event_id: before.event_id,
        project_source_revision: project.source_revision };
    },
    async authorizeCase({ case_id, run_id, phase }) {
      if (!UUID.test(case_id || '') || !/^qa-[a-f0-9-]{36}$/i.test(run_id || '')
        || !['intake', 'run', 'reopen'].includes(phase)) deny('qa_authority_request_invalid');
      const eventId = run_id.slice(3);
      const [caseSnap, dispatchSnap, runSnap, outboxSnap] = await Promise.all([
        qaDb.doc(`${qaBase}/qa_cases/${case_id}`).get(),
        qaDb.doc(`${qaBase}/qa_dispatches/${eventId}`).get(),
        phase === 'run' ? qaDb.doc(`${qaBase}/qa_runs/${run_id}`).get() : Promise.resolve(null),
        phase === 'reopen' ? qaDb.doc(`${qaBase}/qa_kafka_outbox/${eventId}`).get() : Promise.resolve(null),
      ]);
      const qa = data(caseSnap), dispatch = data(dispatchSnap), run = data(runSnap), outbox = data(outboxSnap);
      const scope = qa?.investigation_scope;
      const dispatchBound = dispatch?.case_id === case_id && dispatch.run_id === run_id
        && dispatch.workspace_id === TENANT && (dispatch.aggregate_version ?? 1) === qa?.aggregate_version;
      // A cancelled intake can have an outbox intent but no Kafka dispatch yet.
      // This exception is exclusive to the intake service's reopen phase.
      const reopenBeforeDispatch = phase === 'reopen' && !dispatch
        && outbox?.event_id === eventId && outbox.schema_version === 1
        && outbox.event_type === 'qa.investigation.requested'
        && outbox.workspace_id === TENANT && outbox.case_id === case_id
        && outbox.aggregate_type === 'qa_case' && outbox.aggregate_id === case_id
        && outbox.aggregate_version === qa?.aggregate_version
        && outbox.partition_key === `${TENANT}:${case_id}`;
      if (!qa || qa.case_id !== case_id || qa.workspace_id !== TENANT || !ACTOR.test(qa.actor_id || '')
        || (qa.case_status === 'cancelled' && phase !== 'reopen') || !scope
        || !(dispatchBound || reopenBeforeDispatch)
        || (qa.investigation_event_id ? qa.investigation_event_id !== eventId : qa.aggregate_version !== 1)
        || (phase === 'run' && (!run || run.case_id !== case_id || run.run_id !== run_id)))
        deny('qa_case_binding_invalid');
      validateScope(scope);
      const qaActorId = qa.actor_id;
      const [qaMemberSnap, linkSnap] = await Promise.all([
        qaDb.doc(`${qaBase}/members/${qaActorId}`).get(),
        qaDb.doc(`${qaBase}/qa_actor_business_links/${qaActorId}`).get(),
      ]);
      const link = data(linkSnap);
      if (!isActiveActorMember(data(qaMemberSnap), qaActorId) || !link
        || link.status !== 'ACTIVE' || link.qa_actor_id !== qaActorId
        || link.source !== 'dual_firebase_tokens' || !ACTOR.test(link.business_actor_id || ''))
        deny('qa_identity_link_required');
      await requireCurrentAuth(qaActorId, link.business_actor_id,
        link.qa_auth_time, link.business_auth_time, link.email_digest);
      if (scope.scope_kind === 'project') {
        for (const id of scope.project_ids) {
          const grant = data(await qaDb.doc(`${qaBase}/qa_project_grants/${qaActorId}_${id}`).get());
          const expectedRevision = scope.grant_source_revision || scope.grant_source_revisions?.[id];
          if (!grant || grant.status !== 'ACTIVE' || grant.revoked_at || grant.actor_id !== qaActorId
            || grant.project_id !== id || grant.source_system !== 'myscube_business_acl'
            || !expectedRevision || grant.source_revision !== expectedRevision) deny('qa_project_grant_revoked');
        }
      }
      const authority = await liveAcl(link.business_actor_id, scope.project_ids);
      const scope_hash = scopeHash(scope);
      return { allowed: true, tenant_id: TENANT, case_id, run_id, phase,
        qa_actor_id: qaActorId, business_actor_id: link.business_actor_id, scope_hash,
        source_revision: authority.source_revision, checked_at: new Date(now()).toISOString() };
    },
  };
  return service;
}
