import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const authStoreSource = readFileSync(resolve(import.meta.dirname, 'auth-store.tsx'), 'utf8');

describe('first-login member bootstrap', () => {
  it('lets the member ledger keep its display name when someone signs in again', () => {
    // Google account names arrive in whatever form each person set them, so a sign-in
    // must not overwrite the ledger's 이름(별명) value. A first login still falls back to
    // the account name because the ledger has nothing yet.
    // A sign-in writes no name at all; the field is only seeded when the ledger has none.
    expect(authStoreSource).toContain("...(existing?.name ? {} : { name: firebaseUser.displayName || '사용자' }),");
    expect(authStoreSource).not.toContain("name: existing?.name || firebaseUser.displayName");
    expect(authStoreSource).not.toContain("name: firebaseUser.displayName || existing?.name");
    expect(authStoreSource).not.toContain('buildSafeFirstLoginMember');
  });

  it('does not provision membership from the browser on first login', () => {
    expect(authStoreSource).toContain('if (!memberSnap.exists()) return undefined;');
    expect(authStoreSource).not.toContain('await setDoc(memberRef, created);');
  });

  it('does not grant a role or activate membership during login', () => {
    const login = authStoreSource.slice(authStoreSource.indexOf('async function upsertMemberFromFirebase'), authStoreSource.indexOf('const _g'));
    expect(login).not.toContain('role:');
    expect(login).not.toContain('status:');
    expect(login).not.toContain('mergeMemberRecordSources');
  });
});
