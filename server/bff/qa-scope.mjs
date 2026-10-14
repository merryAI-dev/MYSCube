import { createHttpError } from './bff-utils.mjs';

export const QA_PROJECT_ID = /^p[0-9]{10,20}$/;
const denied = (code) => createHttpError(403, '현재 사업 접근 권한을 확인할 수 없습니다.', code);

// A grant is a server-managed projection of the business owner's ACL. Its expiry
// bounds stale projections; revocation takes effect as soon as this record changes.
export async function requireQaProjectGrant(tx, db, { tenantId, actorId, projectId, at }) {
  if (!QA_PROJECT_ID.test(projectId || '')) throw denied('qa_project_scope_invalid');
  const base = `orgs/${tenantId}`;
  const [grantSnap, linkSnap] = await Promise.all([
    tx.get(db.doc(`${base}/qa_project_grants/${actorId}_${projectId}`)),
    tx.get(db.doc(`${base}/qa_actor_business_links/${actorId}`)),
  ]);
  const grant = grantSnap.data(), link = linkSnap.data();
  if (!link || link.status !== 'ACTIVE' || link.qa_actor_id !== actorId
    || link.source !== 'dual_firebase_tokens'
    || !grant || grant.status !== 'ACTIVE' || grant.actor_id !== actorId || grant.project_id !== projectId
    || grant.source_system !== 'myscube_business_acl' || typeof grant.source_revision !== 'string'
    || !grant.source_revision.trim() || !Number.isFinite(Date.parse(grant.expires_at))
    || Date.parse(grant.expires_at) <= Date.parse(at) || grant.revoked_at) {
    throw denied('qa_project_grant_required');
  }
  return { source_revision: grant.source_revision };
}

export function qaPlatformScope(tenantId) {
  return { authority: 'server_binding', tenant_id: tenantId, scope_kind: 'platform', project_ids: [] };
}

export function qaProjectScope(tenantId, projectId, grant) {
  return { authority: 'server_binding', tenant_id: tenantId, scope_kind: 'project',
    project_ids: [projectId], grant_source_revision: grant.source_revision };
}
