import { randomUUID } from 'node:crypto';

const ACTOR = /^[A-Za-z0-9._:-]{1,128}$/;
const deny = () => { throw Object.assign(new Error('qa_member_inactive'), { code: 'qa_member_inactive', statusCode: 403 }); };

// Called only after the authority service verifies both Firebase identities
// and reads the current ACTIVE business member. The QA account has no product role.
export function createQaMembershipOwnerService({ qaDb, now = () => new Date() }) {
  return {
    async ensure({ qaActorId, businessActorId, sourceRevision }) {
      if (!ACTOR.test(qaActorId || '') || !ACTOR.test(businessActorId || '')
        || typeof sourceRevision !== 'string' || !/^[a-f0-9]{64}$/.test(sourceRevision)) deny();
      const base = 'orgs/mysc';
      return qaDb.runTransaction(async (tx) => {
        const ref = qaDb.doc(`${base}/members/${qaActorId}`);
        const existing = (await tx.get(ref)).data();
        if (existing) {
          if (existing.status !== 'ACTIVE' || (existing.uid && existing.uid !== qaActorId)) deny();
          return { created: false };
        }
        const at = new Date(now()).toISOString();
        tx.create(ref, { uid: qaActorId, status: 'ACTIVE', role: 'MEMBER',
          source_system: 'myscube_business_acl', business_actor_id: businessActorId,
          source_revision: sourceRevision, source_checked_at: at });
        tx.create(qaDb.doc(`${base}/qa_membership_events/${randomUUID()}`), {
          event_type: 'qa_member_created', qa_actor_id: qaActorId,
          business_actor_id: businessActorId, source_revision: sourceRevision, occurred_at: at });
        return { created: true };
      });
    },
  };
}
