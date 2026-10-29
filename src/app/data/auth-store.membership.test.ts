import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ callback: null as null | ((u: any) => Promise<void>), getDoc: vi.fn(), setDoc: vi.fn(), signOut: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../config/feature-flags', () => ({ featureFlags: { firebaseAuthEnabled: true, tenantIsolationStrict: false } }));
vi.mock('firebase/firestore', () => ({ doc: (_: unknown, path: string) => path, getDocFromServer: mocks.getDoc, setDoc: mocks.setDoc }));
vi.mock('firebase/auth', () => ({ GoogleAuthProvider: {}, onIdTokenChanged: (_: unknown, callback: any) => { mocks.callback = callback; return () => {}; }, reauthenticateWithPopup: vi.fn(), signInWithPopup: vi.fn(), signOut: mocks.signOut }));
vi.mock('../lib/firebase', () => ({ initFirebase: () => ({ auth: {} }), getAuthInstance: () => ({}), getDb: () => ({}), getDefaultOrgId: () => 'synthetic', getGoogleAuthProvider: () => ({}), getOrgDocumentPath: (tenant: string, collection: string, uid: string) => `orgs/${tenant}/${collection}/${uid}` }));
vi.mock('../platform/observability', () => ({ setObservabilityUserContext: vi.fn() }));
vi.mock('../platform/dev-harness', () => ({ clearDevHarnessSession: vi.fn(), createDevHarnessSession: vi.fn(), readDevAuthHarnessConfig: () => ({ enabled: false }), readDevHarnessSession: () => null, persistDevHarnessSession: vi.fn() }));
vi.mock('../platform/email-allowlist', () => ({ getAllowedEmailDomains: () => ['example.com'], isAllowedEmail: () => true, formatAllowedDomains: () => 'example.com' }));
import { AuthProvider, useAuth } from './auth-store';
let root: ReactTestRenderer;
let state: ReturnType<typeof useAuth>;
function Protected() { state = useAuth(); return React.createElement('p', null, state.isAuthenticated ? `protected:${state.user?.role}` : 'signed-out'); }
const account = { uid: 'synthetic-uid', email: 'staff@example.com', displayName: 'Synthetic Staff', getIdTokenResult: async () => ({ token: 'synthetic-token', claims: { role: 'admin', tenantId: 'synthetic' } }) };
const snapshot = (record?: object) => ({ exists: () => !!record, data: () => record });
const active = { uid: account.uid, role: 'pm', status: 'ACTIVE', name: 'Staff' };
beforeEach(async () => {
  const data = new Map([['mysc-auth-user', JSON.stringify({ uid: account.uid, role: 'admin', email: account.email })]]);
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) || null, setItem: (k: string, v: string) => data.set(k,v), removeItem: (k: string) => data.delete(k) });
  mocks.getDoc.mockReset(); mocks.setDoc.mockReset().mockResolvedValue(undefined);
  await act(async () => { root = create(React.createElement(AuthProvider, null, React.createElement(Protected))); });
});
afterEach(() => { act(() => root.unmount()); vi.unstubAllGlobals(); });
it('blocks missing membership despite cached admin and admin claims, then admits approved canonical role on retry', async () => {
  mocks.getDoc.mockResolvedValue(snapshot());
  await act(async () => { await mocks.callback!(account); });
  expect(JSON.stringify(root.toJSON())).toContain('직원 연결과 권한 승인을 기다리고 있습니다');
  expect(JSON.stringify(root.toJSON())).not.toContain('protected:');
  expect(localStorage.getItem('mysc-auth-user')).toBeNull();
  expect(mocks.setDoc).not.toHaveBeenCalled();
  mocks.getDoc.mockResolvedValue(snapshot(active));
  await act(async () => { root.root.findAllByType('button')[0].props.onClick(); });
  await act(async () => { await mocks.callback!(account); });
  expect(JSON.stringify(root.toJSON())).toContain('protected:pm');
  expect(mocks.setDoc.mock.calls[0][1]).not.toHaveProperty('role');
  expect(mocks.setDoc.mock.calls[0][1]).not.toHaveProperty('status');
});
it.each(['INACTIVE', 'PENDING'])('blocks canonical %s membership without writing it', async (status) => {
  mocks.getDoc.mockResolvedValue(snapshot({ ...active, status }));
  await act(async () => { await mocks.callback!(account); });
  expect(JSON.stringify(root.toJSON())).not.toContain('protected:'); expect(mocks.setDoc).not.toHaveBeenCalled();
});
it('distinguishes failed lookup and does not fall back to cached access', async () => {
  mocks.getDoc.mockRejectedValue(new Error('offline'));
  await act(async () => { await mocks.callback!(account); });
  expect(JSON.stringify(root.toJSON())).toContain('직원 권한을 확인하지 못했습니다');
  expect(JSON.stringify(root.toJSON())).not.toContain('protected:');
});
it('keeps existing statusless membership and survives optional metadata failure', async () => {
  mocks.getDoc.mockResolvedValue(snapshot({ uid: account.uid, role: 'pm' })); mocks.setDoc.mockRejectedValue(new Error('metadata unavailable'));
  await act(async () => { await mocks.callback!(account); });
  expect(JSON.stringify(root.toJSON())).toContain('protected:pm');
});
it('ignores late lookup after sign-out', async () => {
  let finish!: (value: unknown) => void;
  mocks.getDoc.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  let pending!: Promise<void>;
  await act(async () => { pending = mocks.callback!(account); });
  await act(async () => { await mocks.callback!(null); finish(snapshot(active)); await pending; });
  expect(JSON.stringify(root.toJSON())).toContain('signed-out'); expect(localStorage.getItem('mysc-auth-user')).toBeNull();
});
