import { describe, expect, it } from 'vitest';
import {
  buildDeepSyncPlan,
  mergeAuthGovernanceDirectory,
  parseBootstrapAdminEmails,
} from './auth-governance.mjs';

describe('auth governance helpers', () => {
  it('merges auth users with canonical and legacy member docs and surfaces drift flags', () => {
    const entries = mergeAuthGovernanceDirectory({
      authUsers: [
        {
          uid: 'uid-jslee',
          email: 'jslee@mysc.co.kr',
          displayName: 'JS Lee',
          disabled: false,
          customClaims: { role: 'pm', tenantId: 'mysc' },
        },
      ],
      memberDocs: [
        {
          docId: 'uid-jslee',
          data: {
            uid: 'uid-jslee',
            email: 'jslee@mysc.co.kr',
            name: '이재성',
            role: 'pm',
            status: 'ACTIVE',
          },
        },
        {
          docId: 'jslee_mysc_co_kr',
          data: {
            uid: 'jslee_mysc_co_kr',
            email: 'jslee@mysc.co.kr',
            name: 'JS Legacy',
            role: 'admin',
          },
        },
      ],
      bootstrapAdminEmails: ['jslee@mysc.co.kr'],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      email: 'jslee@mysc.co.kr',
      authUid: 'uid-jslee',
      bootstrapAdmin: true,
      effectiveRole: 'pm',
      driftFlags: expect.arrayContaining(['duplicate_member_docs', 'legacy_role_mismatch', 'bootstrap_admin_not_adopted']),
    });
    expect(entries[0].canonicalMember?.docId).toBe('uid-jslee');
    expect(entries[0].legacyMembers).toHaveLength(1);
    expect(entries[0].claimRole).toBe('pm');
  });

  it('includes bootstrap-only candidates even when auth and member docs are missing', () => {
    const entries = mergeAuthGovernanceDirectory({
      authUsers: [],
      memberDocs: [],
      bootstrapAdminEmails: ['fin@mysc.co.kr'],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      email: 'fin@mysc.co.kr',
      authUid: null,
      effectiveRole: 'admin',
      driftFlags: expect.arrayContaining(['missing_auth', 'missing_canonical_member']),
    });
  });

  it('builds a deep sync plan that writes canonical and legacy docs together', () => {
    const [entry] = mergeAuthGovernanceDirectory({
      authUsers: [
        {
          uid: 'uid-jhsong',
          email: 'jhsong@mysc.co.kr',
          displayName: 'JH Song',
          disabled: false,
          customClaims: { role: 'pm', tenantId: 'mysc' },
        },
      ],
      memberDocs: [
        {
          docId: 'jhsong_mysc_co_kr',
          data: {
            uid: 'jhsong_mysc_co_kr',
            email: 'jhsong@mysc.co.kr',
            name: '송지현',
            role: 'pm',
            status: 'ACTIVE',
            projectIds: ['p1', 'p2'],
          },
        },
      ],
      bootstrapAdminEmails: ['jhsong@mysc.co.kr'],
    });

    const plan = buildDeepSyncPlan({
      entry,
      targetRole: 'admin',
      tenantId: 'mysc',
      actorId: 'u-admin',
      timestamp: '2026-04-13T06:00:00.000Z',
      reason: 'cashflow export alignment',
    });

    expect(plan.identityKey).toBe('jhsong@mysc.co.kr');
    expect(plan.canonicalDocId).toBe('uid-jhsong');
    expect(plan.claims).toEqual({ role: 'admin', tenantId: 'mysc' });
    expect(plan.canonicalPatch).toMatchObject({
      uid: 'uid-jhsong',
      email: 'jhsong@mysc.co.kr',
      role: 'admin',
      projectIds: ['p1', 'p2'],
      roleChangeReason: 'cashflow export alignment',
    });
    expect(plan.legacyPatches).toHaveLength(1);
    expect(plan.legacyPatches[0]).toMatchObject({
      docId: 'jhsong_mysc_co_kr',
      patch: expect.objectContaining({
        canonicalUid: 'uid-jhsong',
        role: 'admin',
      }),
    });
  });

  it('requires an explicit audit reason for every deep sync plan', () => {
    const [entry] = mergeAuthGovernanceDirectory({
      authUsers: [{ uid: 'uid-target', email: 'target@mysc.co.kr', customClaims: { role: 'pm' } }],
      memberDocs: [{
        docId: 'uid-target',
        data: { uid: 'uid-target', email: 'target@mysc.co.kr', role: 'pm', status: 'ACTIVE' },
      }],
    });

    expect(() => buildDeepSyncPlan({
      entry,
      targetRole: 'finance',
      tenantId: 'mysc',
      actorId: 'u-admin',
      timestamp: '2026-08-14T01:02:03.000Z',
    })).toThrow(expect.objectContaining({ code: 'role_change_reason_required' }));
  });

  it('parses server bootstrap admin env values on top of defaults', () => {
    const emails = parseBootstrapAdminEmails({
      BOOTSTRAP_ADMIN_EMAILS: 'extra@mysc.co.kr',
      BOOTSTRAP_ADMIN_EMAIL: 'one@mysc.co.kr',
    });

    expect(emails).toEqual(expect.arrayContaining([
      'mwbyun1220@mysc.co.kr',
      'extra@mysc.co.kr',
      'one@mysc.co.kr',
    ]));
    expect(emails).not.toContain('admin@mysc.co.kr');
  });
});

describe('retained synchronized legacy alias', () => {
  const email = 'staff@example.com', uid = 'verified-uid';
  const canonical = { docId: uid, data: { uid, email, role: 'admin', status: 'ACTIVE', tenantId: 'test' } };
  const alias = { docId: 'staff_example_com', data: { ...canonical.data, uid: 'staff_example_com', canonicalUid: uid } };
  const read = (docs, claims = { role: 'admin', tenantId: 'test' }) => mergeAuthGovernanceDirectory({ authUsers: [{ uid, email, customClaims: claims }], memberDocs: docs })[0];
  it('finishes with a verified retained alias regardless of document order', () => {
    for (const docs of [[alias, canonical], [canonical, alias]]) {
      expect(read(docs)).toMatchObject({ needsDeepSync: false, driftFlags: [], canonicalMember: { docId: uid } });
    }
  });
  it.each([{canonicalUid:'other'}, {role:'pm'}, {status:'INACTIVE'}, {tenantId:'other'}])('retains conflict for alias mismatch %j', patch => {
    expect(read([canonical, { ...alias, data: { ...alias.data, ...patch } }]).driftFlags).toContain('duplicate_member_docs');
  });
  it('keeps arbitrary duplicate and missing or wrong claims actionable', () => {
    expect(read([canonical, alias, {docId:'other',data:canonical.data}]).needsDeepSync).toBe(true);
    expect(read([canonical, alias], {}).driftFlags).toContain('claim_mismatch');
    expect(read([canonical, alias], {role:'admin',tenantId:'other'}).driftFlags).toContain('claim_mismatch');
  });
});
