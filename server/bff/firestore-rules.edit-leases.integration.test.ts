import { readFileSync } from 'node:fs';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore as getAdminFirestore, type Firestore as AdminFirestore } from 'firebase-admin/firestore';
import {
  collection as firestoreCollection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  setLogLevel,
  updateDoc,
} from 'firebase/firestore';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
const describeIfEmulator = emulatorHost ? describe : describe.skip;
const projectId = 'demo-bff-firestore-rules-it';
const tenantId = 'firestore-rules-private-edit-it';
const protectedCollections = [
  'editLeases',
  'idempotency_keys',
  'weekly_api_idempotency',
  'weekly_api_audit_events',
  'weekly_api_audit_exports',
  'projectRequestDrafts',
  'privateEditDrafts',
  'project_requests',
  'projectRequests',
  'projectCodeClaims',
  'cashflowEditLocks',
  'cashflow_edit_locks',
  'cashflow_sheet_mirrors',
  'cashflow_sheet_snapshots',
  'cashflow_sheet_snapshot_months',
  'cashflow_sheet_snapshot_years',
  'cashflow_sheet_week_values',
  'cashflow_sheet_year_totals',
  'cashflow_sheet_refresh_runs',
  'cashflow_sheet_stage_runs',
  'cashflow_sheet_stage_months',
  'cashflow_sheet_stage_years',
  'cashflow_change_candidates',
  'cashflow_month_close_requests',
  'cashflow_month_close_request_months',
  'cashflow_month_close_request_audits',
  'cashflow_cumulative_close_heads',
  'monthly_close_versions',
  'persons',
] as const;
const canonicalRootCollections = [
  'projects',
  'cashflow_weeks',
  'cashflow_settlement_statuses',
  'weekly_submission_status',
  'transactions',
  'comments',
  'evidences',
  'budget_evidence_maps',
] as const;
const canonicalProjectSubcollections = ['bank_statements'] as const;
const actors = [
  { uid: 'draft-owner', role: 'viewer', label: 'project request draft owner' },
  { uid: 'pm-member', role: 'pm', label: 'PM' },
  { uid: 'finance-member', role: 'finance', label: 'finance' },
  { uid: 'admin-member', role: 'admin', label: 'admin' },
] as const;

setLogLevel('silent');

describeIfEmulator('BFF-only Firestore collection rules (Firestore emulator)', () => {
  let testEnv: RulesTestEnvironment;
  let adminApp: App;
  let adminDb: AdminFirestore;

  function protectedDocumentData(ownerId = 'draft-owner') {
    return { ownerId, tenantId, status: 'DRAFT', value: 'original' };
  }

  beforeAll(async () => {
    const [host, port] = emulatorHost!.split(':');
    testEnv = await initializeTestEnvironment({
      projectId,
      firestore: {
        host,
        port: Number(port),
        rules: readFileSync(new URL('../../firebase/firestore.rules', import.meta.url), 'utf8'),
      },
    });
    await testEnv.clearFirestore();

    adminApp = initializeApp({ projectId }, `firestore-rules-it-${process.pid}`);
    adminDb = getAdminFirestore(adminApp);

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all([
        ...actors.map((actor) => setDoc(doc(db, `orgs/${tenantId}/members/${actor.uid}`), {
          uid: actor.uid,
          role: actor.role,
          status: 'ACTIVE',
        })),
        setDoc(doc(db, `orgs/${tenantId}/members/inactive-member`), {
          uid: 'inactive-member',
          role: 'admin',
          status: 'INACTIVE',
        }),
        setDoc(doc(db, `orgs/${tenantId}/members/legacy-member`), {
          uid: 'legacy-member',
          name: 'Legacy Member',
          email: 'legacy-member@mysc.co.kr',
          role: 'pm',
          tenantId,
          projectId: '',
          projectIds: [],
          createdAt: '2026-01-01T00:00:00.000Z',
        }),
        setDoc(doc(db, `orgs/${tenantId}/members/self-member`), {
          uid: 'self-member',
          name: 'Self Member',
          email: 'self-member@mysc.co.kr',
          role: 'pm',
          status: 'ACTIVE',
          tenantId,
          projectId: '',
          projectIds: [],
        }),
        ...protectedCollections.map((collection) => setDoc(
          doc(db, `orgs/${tenantId}/${collection}/existing`),
          protectedDocumentData(),
        )),
        ...canonicalRootCollections.map((collection) => setDoc(
          doc(db, `orgs/${tenantId}/${collection}/existing`),
          { tenantId, value: 'original' },
        )),
        ...canonicalProjectSubcollections.map((collection) => setDoc(
          doc(db, `orgs/${tenantId}/projects/existing/${collection}/existing`),
          { tenantId, value: 'original' },
        )),
      ]);
    });
  }, 60_000);

  afterAll(async () => {
    if (testEnv) {
      await testEnv.clearFirestore();
      await testEnv.cleanup();
    }
    if (adminApp) await deleteApp(adminApp);
  }, 60_000);

  /**
   * 은퇴한 컬렉션. 포털 마이페이지가 인력 명부(persons)를 읽도록 바뀌면서 쓰지 않게 됐다.
   * 규칙에서 그냥 지우면 catchall 의 canRead 가 걸려 조직 전체가 읽게 되므로 닫아 둔다.
   */
  it('careerProfiles: 본인도 남도 못 연다 — 은퇴한 경로다', async () => {
    const owner = 'pm-member';
    await testEnv.withSecurityRulesDisabled(async (context) => {
      await setDoc(doc(context.firestore(), `orgs/${tenantId}/careerProfiles/${owner}`), {
        uid: owner, orgId: tenantId, nameKo: '본인', birthDate: '1990-01-01',
      });
    });

    for (const actor of [owner, 'finance-member', 'admin-member']) {
      const actorDb = testEnv.authenticatedContext(actor, { email: `${actor}@mysc.co.kr` }).firestore();
      await assertFails(getDoc(doc(actorDb, `orgs/${tenantId}/careerProfiles/${owner}`)));
      await assertFails(setDoc(doc(actorDb, `orgs/${tenantId}/careerProfiles/${owner}`), { uid: owner, hacked: true }));
      await assertFails(getDocs(firestoreCollection(actorDb, `orgs/${tenantId}/careerProfiles`)));
    }
  });

  for (const collection of protectedCollections) {
    for (const actor of actors) {
      it(`denies ${actor.label} client CRUD on ${collection}`, async () => {
        const db = testEnv.authenticatedContext(actor.uid, {
          email: `${actor.uid}@mysc.co.kr`,
        }).firestore();
        const existing = doc(db, `orgs/${tenantId}/${collection}/existing`);
        const created = doc(db, `orgs/${tenantId}/${collection}/created-${actor.uid}`);

        await assertFails(getDoc(existing));
        await assertFails(getDocs(firestoreCollection(db, `orgs/${tenantId}/${collection}`)));
        await assertFails(setDoc(created, protectedDocumentData(actor.uid)));
        await assertFails(updateDoc(existing, { value: `updated-${actor.uid}` }));
        await assertFails(deleteDoc(existing));
      });
    }
  }

  for (const collection of canonicalRootCollections) {
    for (const actor of actors.filter(({ role }) => role !== 'viewer')) {
      it(`keeps ${actor.label} reads but denies client writes on canonical ${collection}`, async () => {
        const db = testEnv.authenticatedContext(actor.uid, {
          email: `${actor.uid}@mysc.co.kr`,
        }).firestore();
        const existing = doc(db, `orgs/${tenantId}/${collection}/existing`);
        const created = doc(db, `orgs/${tenantId}/${collection}/created-${actor.uid}`);

        expect((await assertSucceeds(getDoc(existing))).data()?.value).toBe('original');
        await assertFails(setDoc(created, { tenantId, value: `created-${actor.uid}` }));
        await assertFails(updateDoc(existing, { value: `updated-${actor.uid}` }));
        await assertFails(deleteDoc(existing));
      });
    }
  }


  for (const collection of canonicalProjectSubcollections) {
    for (const actor of actors.filter(({ role }) => role !== 'viewer')) {
      it(`keeps ${actor.label} reads but denies client writes on project ${collection}`, async () => {
        const db = testEnv.authenticatedContext(actor.uid, {
          email: `${actor.uid}@mysc.co.kr`,
        }).firestore();
        const basePath = `orgs/${tenantId}/projects/existing/${collection}`;
        const existing = doc(db, `${basePath}/existing`);
        const created = doc(db, `${basePath}/created-${actor.uid}`);

        expect((await assertSucceeds(getDoc(existing))).data()?.value).toBe('original');
        await assertFails(setDoc(created, { tenantId, value: `created-${actor.uid}` }));
        await assertFails(updateDoc(existing, { value: `updated-${actor.uid}` }));
        await assertFails(deleteDoc(existing));
      });
    }
  }

  it('keeps viewer list access to canonical collections', async () => {
    const db = testEnv.authenticatedContext('draft-owner', {
      email: 'draft-owner@mysc.co.kr',
    }).firestore();

    for (const collection of canonicalRootCollections) {
      const snapshot = await assertSucceeds(getDocs(
        firestoreCollection(db, `orgs/${tenantId}/${collection}`),
      ));
      expect(snapshot.docs.some((item) => item.id === 'existing')).toBe(true);
    }
    for (const collection of canonicalProjectSubcollections) {
      const snapshot = await assertSucceeds(getDocs(firestoreCollection(
        db,
        `orgs/${tenantId}/projects/existing/${collection}`,
      )));
      expect(snapshot.docs.some((item) => item.id === 'existing')).toBe(true);
    }
  });

  it('denies inactive members while preserving legacy members without status', async () => {
    const inactiveDb = testEnv.authenticatedContext('inactive-member', {
      email: 'inactive-member@mysc.co.kr',
    }).firestore();
    const legacyDb = testEnv.authenticatedContext('legacy-member', {
      email: 'legacy-member@mysc.co.kr',
    }).firestore();
    const projectRef = doc(inactiveDb, `orgs/${tenantId}/projects/existing`);

    await assertFails(getDoc(projectRef));
    await assertFails(getDocs(firestoreCollection(inactiveDb, `orgs/${tenantId}/projects`)));
    expect((await assertSucceeds(getDoc(
      doc(legacyDb, `orgs/${tenantId}/projects/existing`),
    ))).data()?.value).toBe('original');
    await assertSucceeds(setDoc(
      doc(legacyDb, `orgs/${tenantId}/members/legacy-member`),
      {
        uid: 'legacy-member',
        name: 'Legacy Member Updated',
        email: 'legacy-member@mysc.co.kr',
        role: 'pm',
        tenantId,
        projectId: '',
        projectIds: [],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-08-25T00:00:00.000Z',
        lastLoginAt: '2026-08-25T00:00:00.000Z',
      },
      { merge: true },
    ));
    expect((await assertSucceeds(getDoc(
      doc(legacyDb, `orgs/${tenantId}/members/legacy-member`),
    ))).data()).not.toHaveProperty('status');
  });

  it('denies every present noncanonical member status at the Firestore boundary', async () => {
    const invalidStatuses = [
      { uid: 'status-empty', value: '' },
      { uid: 'status-null', value: null },
      { uid: 'status-number', value: 7 },
      { uid: 'status-lowercase', value: 'active' },
      { uid: 'status-padded', value: ' ACTIVE ' },
    ];

    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await Promise.all(invalidStatuses.map(({ uid, value }) => setDoc(
        doc(db, `orgs/${tenantId}/members/${uid}`),
        { uid, role: 'admin', status: value },
      )));
    });

    for (const { uid } of invalidStatuses) {
      const db = testEnv.authenticatedContext(uid, {
        email: `${uid}@mysc.co.kr`,
      }).firestore();
      await assertFails(getDoc(doc(db, `orgs/${tenantId}/projects/existing`)));
      await assertFails(getDocs(firestoreCollection(db, `orgs/${tenantId}/projects`)));
      await assertFails(setDoc(doc(db, `orgs/${tenantId}/projects/existing/expense_sheets/${uid}-write`), {
        tenantId,
        value: 'blocked',
      }));
    }
  });

  it('keeps existing project subcollection writes until every client flow has a server replacement', async () => {
    const db = testEnv.authenticatedContext('pm-member', {
      email: 'pm-member@mysc.co.kr',
    }).firestore();
    const ref = doc(db, `orgs/${tenantId}/projects/existing/expense_sheets/client-compat`);

    await assertSucceeds(setDoc(ref, { tenantId, value: 'created' }));
    await assertSucceeds(updateDoc(ref, { value: 'updated' }));
    await assertSucceeds(deleteDoc(ref));
  });

  it('denies first-login self-registration so only the admin BFF can provision membership', async () => {
    const cases = [
      { uid: 'self-enrollment-claimless', claims: {} },
      { uid: 'self-enrollment-matching-claim', claims: { tenantId, role: 'pm' } },
      { uid: 'self-enrollment-other-claim', claims: { tenantId: 'other-tenant', role: 'finance' } },
    ];

    for (const { uid, claims } of cases) {
      const email = `${uid}@mysc.co.kr`;
      const db = testEnv.authenticatedContext(uid, { email, ...claims }).firestore();
      await assertFails(setDoc(doc(db, `orgs/${tenantId}/members/${uid}`), {
        uid,
        name: 'Blocked Self Enrollment',
        email,
        role: 'pm',
        status: 'ACTIVE',
        tenantId,
        projectId: '',
        projectIds: [],
      }));
    }

    const adminDb = testEnv.authenticatedContext('admin-member', {
      email: 'admin-member@mysc.co.kr',
    }).firestore();
    await assertFails(setDoc(doc(adminDb, `orgs/${tenantId}/members/admin-client-created`), {
      uid: 'admin-client-created',
      email: 'admin-client-created@mysc.co.kr',
      role: 'pm',
      status: 'ACTIVE',
      tenantId,
    }));
  });

  it('denies self-registration with assignment, elevated identity, tenant drift, or unknown keys', async () => {
    const unsafeCases = [
      { label: 'projectId', patch: { projectId: 'project-a' } },
      { label: 'projectIds', patch: { projectIds: ['project-a'] } },
      { label: 'portalProfile', patch: { portalProfile: { projectId: 'project-a', projectIds: ['project-a'] } } },
      { label: 'projectNames', patch: { projectNames: { 'project-a': 'Project A' } } },
      { label: 'role', patch: { role: 'admin' } },
      { label: 'status', patch: { status: 'DISABLED' } },
      { label: 'tenantId', patch: { tenantId: 'another-tenant' } },
      { label: 'uid', patch: { uid: 'another-user' } },
      { label: 'department', patch: { department: 'Strategy' } },
      { label: 'unknown', patch: { isSuperuser: true } },
    ];

    for (const { label, patch } of unsafeCases) {
      const uid = `unsafe-create-${label}`;
      const email = `${uid}@mysc.co.kr`;
      const db = testEnv.authenticatedContext(uid, { email }).firestore();
      await assertFails(setDoc(doc(db, `orgs/${tenantId}/members/${uid}`), {
        uid,
        name: 'Unsafe Self Create',
        email,
        role: 'pm',
        status: 'ACTIVE',
        tenantId,
        projectId: '',
        projectIds: [],
        ...patch,
      }));
    }
  });

  it('allows only safe self profile and session updates tied to the auth email', async () => {
    const db = testEnv.authenticatedContext('self-member', {
      email: 'self-member@mysc.co.kr',
    }).firestore();
    const memberRef = doc(db, `orgs/${tenantId}/members/self-member`);

    await assertSucceeds(updateDoc(memberRef, {
      name: 'Updated Self Member',
      avatarUrl: 'https://example.test/updated.png',
      email: 'self-member@mysc.co.kr',
      lastLoginAt: '2026-07-10T00:10:00.000Z',
      updatedAt: '2026-07-10T00:10:00.000Z',
      defaultWorkspace: 'portal',
      lastWorkspace: 'portal',
    }));
    await assertFails(updateDoc(memberRef, { email: 'someone-else@mysc.co.kr' }));
  });

  it('denies every self-update to persisted identity or assignment fields', async () => {
    const db = testEnv.authenticatedContext('self-member', {
      email: 'self-member@mysc.co.kr',
    }).firestore();
    const memberRef = doc(db, `orgs/${tenantId}/members/self-member`);
    for (const patch of [
      { uid: 'different-user' },
      { status: 'DISABLED' },
      { role: 'admin' },
      { tenantId: 'another-tenant' },
      { projectId: 'project-a' },
      { projectIds: ['project-a'] },
      { portalProfile: { projectId: 'project-a', projectIds: ['project-a'] } },
      { projectNames: { 'project-a': 'Project A' } },
      { department: 'Strategy' },
    ]) {
      await assertFails(updateDoc(memberRef, patch));
    }
  });

  it('does not let an inactive member reactivate itself', async () => {
    const db = testEnv.authenticatedContext('inactive-member', {
      email: 'inactive-member@mysc.co.kr',
      tenantId,
      role: 'admin',
    }).firestore();
    await assertFails(updateDoc(
      doc(db, `orgs/${tenantId}/members/inactive-member`),
      { status: 'ACTIVE' },
    ));
  });

  it('keeps admin assignment writes available', async () => {
    const db = testEnv.authenticatedContext('admin-member', {
      email: 'admin-member@mysc.co.kr',
    }).firestore();
    const memberRef = doc(db, `orgs/${tenantId}/members/self-member`);

    await assertSucceeds(updateDoc(memberRef, {
      projectId: 'project-a',
      projectIds: ['project-a'],
      portalProfile: { projectId: 'project-a', projectIds: ['project-a'] },
    }));
  });

  it('keeps Admin SDK CRUD available for protected and canonical collections', async () => {
    for (const collection of [...protectedCollections, ...canonicalRootCollections]) {
      const ref = adminDb.doc(`orgs/${tenantId}/${collection}/admin-sdk`);
      await ref.set(protectedDocumentData());
      expect((await ref.get()).data()?.value).toBe('original');
      await ref.update({ value: 'updated' });
      expect((await ref.get()).data()?.value).toBe('updated');
      await ref.delete();
    }
    for (const collection of canonicalProjectSubcollections) {
      const ref = adminDb.doc(`orgs/${tenantId}/projects/existing/${collection}/admin-sdk`);
      await ref.set(protectedDocumentData());
      expect((await ref.get()).data()?.value).toBe('original');
      await ref.update({ value: 'updated' });
      expect((await ref.get()).data()?.value).toBe('updated');
      await ref.delete();
    }
  });
});
