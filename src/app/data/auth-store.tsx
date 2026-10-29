import React, { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from 'react';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import {
  GoogleAuthProvider,
  onIdTokenChanged,
  reauthenticateWithPopup,
  signInWithPopup,
  signOut,
  type User as FirebaseUser,
} from 'firebase/auth';
import type { UserRole } from './types';
import { PROJECTS } from './mock-data';
import { featureFlags } from '../config/feature-flags';
import {
  getAuthInstance,
  getDb,
  getDefaultOrgId,
  getGoogleAuthProvider,
  getOrgDocumentPath,
  initFirebase,
} from '../lib/firebase';
import {
  normalizeEmail,
  resolveProjectIdForManager,
  type ProjectOwnerEntry,
} from './auth-helpers';
import { resolveEffectiveAuthRole } from './auth-role-resolution';
import { normalizeProjectIds, resolvePrimaryProjectId } from './project-assignment';
import {
  buildWorkspacePreferencePatch,
  readMemberWorkspace,
  type WorkspaceId,
} from './member-workspace';
import { extractAuthContextFromClaims, type FirebaseAuthClaims } from '../platform/rbac';
import { isAdminSpaceRole } from '../platform/navigation';
import { resolveTenantId } from '../platform/tenant';
import { formatAllowedDomains, getAllowedEmailDomains, isAllowedEmail } from '../platform/email-allowlist';
import { buildPreviewAuthBlockedMessage, shouldBlockFirebasePopupAuth } from '../platform/preview-auth';
import {
  clearDevHarnessSession,
  createDevHarnessSession,
  readDevAuthHarnessConfig,
  readDevHarnessSession,
  persistDevHarnessSession,
  type DevHarnessPreset,
} from '../platform/dev-harness';
import { setObservabilityUserContext } from '../platform/observability';
import { resolveMembershipIssue, type MembershipIssue } from './member-access';
import { MembershipPending } from '../components/auth/MembershipPending';

export interface AuthUser {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  source?: 'firebase' | 'dev_harness';
  idToken?: string;
  googleAccessToken?: string;
  avatarUrl?: string;
  projectId?: string;
  projectIds?: string[];
  tenantId?: string;
  department?: string;
  registeredAt?: string;
  defaultWorkspace?: WorkspaceId;
  lastWorkspace?: WorkspaceId;
}

interface AuthState {
  isAuthenticated: boolean;
  user: AuthUser | null;
  isLoading: boolean;
  isFirebaseAuthEnabled: boolean;
}

interface AuthActions {
  loginWithGoogle: () => Promise<{ success: boolean; error?: string }>;
  loginWithDevHarness: (preset?: DevHarnessPreset) => Promise<{ success: boolean; error?: string }>;
  ensureGoogleWorkspaceAccess: (options?: { forceRefresh?: boolean }) => Promise<string | null>;
  setWorkspacePreference: (workspace: WorkspaceId, options?: { persistDefault?: boolean }) => Promise<boolean>;
  logout: () => void;
  isAdmin: () => boolean;
  isPortalUser: () => boolean;
}

interface MemberDoc {
  uid: string;
  name: string;
  email: string;
  role: UserRole;
  tenantId?: string;
  department?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'PENDING';
  projectId?: string;
  projectIds?: string[];
  avatarUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  lastLoginAt?: string;
  projectNames?: Record<string, string>;
  portalProfile?: Record<string, unknown>;
  defaultWorkspace?: WorkspaceId;
  lastWorkspace?: WorkspaceId;
}

const AUTH_STORAGE_KEY = 'mysc-auth-user';
const ACTIVE_TENANT_KEY = 'MYSC_ACTIVE_TENANT';
const GOOGLE_WORKSPACE_TOKEN_STORAGE_KEY = 'mysc-google-workspace-token-map';
const DEFAULT_ORG_ID = getDefaultOrgId();
const ALLOWED_EMAIL_DOMAINS = getAllowedEmailDomains(import.meta.env);
const DEV_AUTH_HARNESS_CONFIG = readDevAuthHarnessConfig(import.meta.env);

const PROJECT_OWNERS: ProjectOwnerEntry[] = PROJECTS.map((project) => ({
  id: project.id,
  managerId: project.managerId,
}));

function loadSavedUser(): AuthUser | null {
  try {
    const saved = localStorage.getItem(AUTH_STORAGE_KEY);
    if (!saved) return null;
    const parsed = JSON.parse(saved) as AuthUser;
    return {
      ...parsed,
      role: toUserRole(parsed.role) || 'pm',
      ...(parsed.uid ? { googleAccessToken: loadGoogleWorkspaceAccessToken(parsed.uid) } : {}),
    };
  } catch {
    return null;
  }
}

function readGoogleWorkspaceTokenMap(): Record<string, string> {
  try {
    if (typeof sessionStorage === 'undefined') return {};
    const saved = sessionStorage.getItem(GOOGLE_WORKSPACE_TOKEN_STORAGE_KEY);
    if (!saved) return {};
    const parsed = JSON.parse(saved) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed || {})
        .map(([uid, token]) => [uid, typeof token === 'string' ? token.trim() : ''] as const)
        .filter(([uid, token]) => uid && token),
    );
  } catch {
    return {};
  }
}

function writeGoogleWorkspaceTokenMap(next: Record<string, string>) {
  if (typeof sessionStorage === 'undefined') return;
  const entries = Object.entries(next).filter(([uid, token]) => uid && token);
  if (entries.length === 0) {
    sessionStorage.removeItem(GOOGLE_WORKSPACE_TOKEN_STORAGE_KEY);
    return;
  }
  sessionStorage.setItem(GOOGLE_WORKSPACE_TOKEN_STORAGE_KEY, JSON.stringify(Object.fromEntries(entries)));
}

function loadGoogleWorkspaceAccessToken(uid: string | undefined): string | undefined {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return undefined;
  return readGoogleWorkspaceTokenMap()[normalizedUid];
}

function persistGoogleWorkspaceAccessToken(uid: string | undefined, token: string | undefined) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid) return;
  const next = readGoogleWorkspaceTokenMap();
  const normalizedToken = String(token || '').trim();
  if (!normalizedToken) {
    delete next[normalizedUid];
  } else {
    next[normalizedUid] = normalizedToken;
  }
  writeGoogleWorkspaceTokenMap(next);
}

function saveUser(user: AuthUser | null) {
  if (user) {
    const { googleAccessToken: _ignoredGoogleAccessToken, ...persistedUser } = user;
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(persistedUser));
    if (user.tenantId) {
      localStorage.setItem(ACTIVE_TENANT_KEY, user.tenantId);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(
          new CustomEvent('mysc:tenant-changed', { detail: { tenantId: user.tenantId } }),
        );
      }
    }
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
    localStorage.removeItem(ACTIVE_TENANT_KEY);
  }
}

function omitUndefinedFields<T extends object>(input: T): T {
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined),
  ) as T;
}

function toUserRole(role: string | undefined): UserRole | undefined {
  const normalized = typeof role === 'string' ? role.trim().toLowerCase() : '';
  const effectiveRole = normalized === 'viewer' ? 'pm' : normalized;
  if (
    effectiveRole === 'admin' ||
    effectiveRole === 'tenant_admin' ||
    effectiveRole === 'finance' ||
    effectiveRole === 'pm' ||
    effectiveRole === 'auditor' ||
    effectiveRole === 'support' ||
    effectiveRole === 'security'
  ) {
    return effectiveRole as UserRole;
  }
  return undefined;
}

function mapFirebaseUserToAuthUser(
  firebaseUser: FirebaseUser,
  member: Partial<MemberDoc> | undefined,
  tenantId: string,
  idToken?: string,
): AuthUser {
  const normalizedEmail = normalizeEmail(firebaseUser.email || member?.email || '');
  const workspace = readMemberWorkspace(member);
  const mergedProjectIds = normalizeProjectIds([
    ...(workspace.portalProfile?.projectIds || []),
    ...(Array.isArray(member?.projectIds) ? member?.projectIds : []),
    workspace.portalProfile?.projectId,
    member?.projectId,
    resolveProjectIdForManager(firebaseUser.uid, PROJECT_OWNERS),
  ]);
  const primaryProjectId = resolvePrimaryProjectId(
    mergedProjectIds,
    workspace.portalProfile?.projectId || member?.projectId,
  );
  const role = resolveEffectiveAuthRole({
    memberRole: member?.role,
  });
  return {
    uid: firebaseUser.uid,
    name: member?.name || firebaseUser.displayName || '사용자',
    email: normalizedEmail,
    role,
    source: 'firebase',
    idToken,
    googleAccessToken: loadGoogleWorkspaceAccessToken(firebaseUser.uid),
    avatarUrl: member?.avatarUrl || firebaseUser.photoURL || undefined,
    projectId: primaryProjectId,
    projectIds: mergedProjectIds,
    tenantId,
    department: member?.department,
    registeredAt: member?.createdAt,
    defaultWorkspace: workspace.defaultWorkspace,
    lastWorkspace: workspace.lastWorkspace,
  };
}

async function upsertMemberFromFirebase(
  firebaseUser: FirebaseUser,
  tenantId: string,
): Promise<MemberDoc | undefined> {
  const db = getDb();
  if (!db) throw new Error('Membership lookup is unavailable');

  const memberPath = getOrgDocumentPath(tenantId, 'members', firebaseUser.uid);
  const memberRef = doc(db, memberPath);
  const memberSnap = await getDocFromServer(memberRef);
  if (!memberSnap.exists()) return undefined;
  const existing = memberSnap.data() as Partial<MemberDoc>;
  if (resolveMembershipIssue(existing, firebaseUser.uid)) return existing as MemberDoc;
  const now = new Date().toISOString();
  const profilePatch = omitUndefinedFields({
    ...(existing?.name ? {} : { name: firebaseUser.displayName || '사용자' }),
    avatarUrl: firebaseUser.photoURL || existing.avatarUrl,
    updatedAt: now,
    lastLoginAt: now,
  });
  // Login only refreshes presentation metadata. The server owns membership and role.
  await setDoc(memberRef, profilePatch, { merge: true }).catch((error) => {
    console.warn('[Auth] Login profile metadata could not be updated:', error);
  });
  return { ...existing, ...profilePatch } as MemberDoc;
}

const _g = globalThis as any;
if (!_g.__MYSC_AUTH_CTX__) {
  _g.__MYSC_AUTH_CTX__ = createContext<(AuthState & AuthActions) | null>(null);
}
const AuthContext: React.Context<(AuthState & AuthActions) | null> = _g.__MYSC_AUTH_CTX__;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(
    featureFlags.firebaseAuthEnabled ? null : loadSavedUser,
  );
  const [isLoading, setIsLoading] = useState(featureFlags.firebaseAuthEnabled);

  const [membershipIssue, setMembershipIssue] = useState<MembershipIssue | null>(null);
  const [signedInEmail, setSignedInEmail] = useState('');
  const [membershipCheck, setMembershipCheck] = useState(0);

  useEffect(() => {
    let generation = 0;
    let disposed = false;
    const harnessSession = readDevHarnessSession();
    if (DEV_AUTH_HARNESS_CONFIG.enabled && harnessSession) {
      const mapped: AuthUser = {
        uid: harnessSession.uid,
        name: harnessSession.name,
        email: harnessSession.email,
        role: toUserRole(harnessSession.role) || 'pm',
        source: 'dev_harness',
        tenantId: harnessSession.tenantId,
        projectId: harnessSession.projectId,
        projectIds: harnessSession.projectIds,
        defaultWorkspace: harnessSession.defaultWorkspace,
        lastWorkspace: harnessSession.lastWorkspace,
      };
      setUser(mapped);
      saveUser(mapped);
      setIsLoading(false);
      return;
    }

    if (!featureFlags.firebaseAuthEnabled) {
      setIsLoading(false);
      return;
    }

    const initialized = initFirebase();
    const auth = initialized?.auth || getAuthInstance();
    if (!auth) {
      setIsLoading(false);
      return;
    }

    const unsubscribe = onIdTokenChanged(auth, async (firebaseUser) => {
      const currentGeneration = ++generation;
      const isCurrent = () => !disposed && currentGeneration === generation;
      setMembershipIssue(null);
      setSignedInEmail(firebaseUser?.email || '');
      setUser(null);
      saveUser(null);
      setIsLoading(true);
      if (!firebaseUser) {
        setUser(null);
        saveUser(null);
        setIsLoading(false);
        return;
      }

      if (!isAllowedEmail(firebaseUser.email, ALLOWED_EMAIL_DOMAINS)) {
        console.warn('[Auth] blocked sign-in for disallowed email:', firebaseUser.email);
        await signOut(auth).catch(() => {});
        setUser(null);
        saveUser(null);
        setIsLoading(false);
        return;
      }

      try {
        const token = await firebaseUser.getIdTokenResult();
        const claimsContext = extractAuthContextFromClaims(token?.claims as FirebaseAuthClaims | undefined);
        const tenantId = resolveTenantId({
          claimTenantId: claimsContext.tenantId,
          envTenantId: DEFAULT_ORG_ID,
          strict: featureFlags.tenantIsolationStrict,
        });
        const member = await upsertMemberFromFirebase(
          firebaseUser,
          tenantId,
        );
        if (!isCurrent()) return;
        const issue = resolveMembershipIssue(member, firebaseUser.uid);
        if (issue) {
          setMembershipIssue(issue);
          setIsLoading(false);
          return;
        }
        const mapped = mapFirebaseUserToAuthUser(firebaseUser, member, tenantId, token?.token);
        mapped.source = 'firebase';
        setUser(mapped);
        saveUser(mapped);
      } catch (err) {
        if (!isCurrent()) return;
        console.error('[Auth] Failed to sync member profile:', err);
        setMembershipIssue('UNAVAILABLE');
        setUser(null);
        saveUser(null);
      } finally {
        if (isCurrent()) setIsLoading(false);
      }
    });

    return () => { disposed = true; generation += 1; unsubscribe(); };
  }, [membershipCheck]);

  useEffect(() => {
    setObservabilityUserContext(
      user
        ? {
          id: user.uid,
          email: user.email,
          role: user.role,
          tenantId: user.tenantId,
          idToken: user.idToken,
        }
        : null,
    );
  }, [user]);

  const setWorkspacePreference = useCallback(async (
    workspace: WorkspaceId,
    options?: { persistDefault?: boolean },
  ): Promise<boolean> => {
    const persistDefault = options?.persistDefault ?? true;
    const currentUser = user;
    if (!currentUser) return false;

    const updatedAt = new Date().toISOString();
    const nextUser: AuthUser = {
      ...currentUser,
      ...(persistDefault ? { defaultWorkspace: workspace } : {}),
      lastWorkspace: workspace,
    };
    setUser(nextUser);
    saveUser(nextUser);

    if (currentUser.source === 'dev_harness') {
      persistDevHarnessSession({
        source: 'dev_harness',
        uid: nextUser.uid,
        name: nextUser.name,
        email: nextUser.email,
        role: nextUser.role,
        tenantId: nextUser.tenantId || DEFAULT_ORG_ID,
        projectId: nextUser.projectId,
        projectIds: nextUser.projectIds,
        defaultWorkspace: nextUser.defaultWorkspace,
        lastWorkspace: nextUser.lastWorkspace,
      });
      return true;
    }

    const db = getDb();
    if (!db) return true;

    try {
      await setDoc(
        doc(db, getOrgDocumentPath(currentUser.tenantId || DEFAULT_ORG_ID, 'members', currentUser.uid)),
        {
          uid: currentUser.uid,
          email: currentUser.email,
          name: currentUser.name,
          role: currentUser.role,
          tenantId: currentUser.tenantId || DEFAULT_ORG_ID,
          ...buildWorkspacePreferencePatch(workspace, updatedAt, persistDefault),
          lastLoginAt: updatedAt,
        },
        { merge: true },
      );
      return true;
    } catch (err) {
      console.error('[Auth] setWorkspacePreference failed:', err);
      setUser(currentUser);
      saveUser(currentUser);
      return false;
    }
  }, [user]);

  const loginWithGoogle = useCallback(async (): Promise<{ success: boolean; error?: string }> => {
    if (!featureFlags.firebaseAuthEnabled) {
      return { success: false, error: 'Firebase Auth 기능이 비활성화되어 있습니다.' };
    }

    const host = typeof window !== 'undefined' ? window.location.hostname : '';
    if (shouldBlockFirebasePopupAuth(host, import.meta.env)) {
      return {
        success: false,
        error: buildPreviewAuthBlockedMessage(host, import.meta.env),
      };
    }

    setIsLoading(true);

    try {
      const initialized = initFirebase();
      const auth = initialized?.auth || getAuthInstance();
      if (!auth) {
        setIsLoading(false);
        return { success: false, error: 'Firebase 인증 구성을 찾을 수 없습니다.' };
      }

      const cred = await signInWithPopup(auth, getGoogleAuthProvider());
      const providerCredential = GoogleAuthProvider.credentialFromResult(cred);
      const googleAccessToken = providerCredential?.accessToken || undefined;
      if (cred?.user?.uid) {
        persistGoogleWorkspaceAccessToken(cred.user.uid, googleAccessToken);
      }
      const email = cred?.user?.email || '';
      if (!isAllowedEmail(email, ALLOWED_EMAIL_DOMAINS)) {
        await signOut(auth).catch(() => {});
        setIsLoading(false);
        return {
          success: false,
          error: `회사 계정(${formatAllowedDomains(ALLOWED_EMAIL_DOMAINS)})만 로그인할 수 있습니다.`,
        };
      }

      return { success: true };
    } catch (err: any) {
      setIsLoading(false);
      const code = String(err?.code || '').trim();
      if (code === 'auth/unauthorized-domain') {
        return {
          success: false,
          error: `Firebase Auth에서 허용되지 않은 도메인입니다. Firebase Console > Authentication > Settings > Authorized domains에 ${host || '현재 도메인'}을 추가해 주세요.`,
        };
      }
      if (code === 'auth/popup-closed-by-user') {
        return { success: false, error: '로그인을 취소했습니다.' };
      }
      return { success: false, error: err?.message || 'Google 로그인에 실패했습니다.' };
    }
  }, []);

  const loginWithDevHarness = useCallback(async (
    preset: DevHarnessPreset = 'pm',
  ): Promise<{ success: boolean; error?: string }> => {
    if (!DEV_AUTH_HARNESS_CONFIG.enabled) {
      return { success: false, error: '개발용 인증 harness가 비활성화되어 있습니다.' };
    }
    const session = createDevHarnessSession(preset, DEFAULT_ORG_ID);
    persistDevHarnessSession(session);
    const mapped: AuthUser = {
      uid: session.uid,
      name: session.name,
      email: session.email,
      role: session.role,
      source: 'dev_harness',
      tenantId: session.tenantId,
      projectId: session.projectId,
      projectIds: session.projectIds,
      defaultWorkspace: session.defaultWorkspace,
      lastWorkspace: session.lastWorkspace,
    };
    setUser(mapped);
    saveUser(mapped);
    setIsLoading(false);
    return { success: true };
  }, []);

  const ensureGoogleWorkspaceAccess = useCallback(async (options: { forceRefresh?: boolean } = {}): Promise<string | null> => {
    const currentUser = user;
    if (!featureFlags.firebaseAuthEnabled || !currentUser || currentUser.source !== 'firebase') {
      return null;
    }

    const cached = loadGoogleWorkspaceAccessToken(currentUser.uid);
    if (cached && !options.forceRefresh) {
      if (!currentUser.googleAccessToken) {
        const nextUser = { ...currentUser, googleAccessToken: cached };
        setUser(nextUser);
        saveUser(nextUser);
      }
      return cached;
    }
    if (options.forceRefresh) {
      persistGoogleWorkspaceAccessToken(currentUser.uid, undefined);
    }

    const auth = getAuthInstance();
    if (!auth) return null;

    try {
      const provider = getGoogleAuthProvider();
      const cred = auth.currentUser
        ? await reauthenticateWithPopup(auth.currentUser, provider)
        : await signInWithPopup(auth, provider);
      const providerCredential = GoogleAuthProvider.credentialFromResult(cred);
      const googleAccessToken = providerCredential?.accessToken || '';
      if (!googleAccessToken) return null;
      persistGoogleWorkspaceAccessToken(cred.user?.uid || currentUser.uid, googleAccessToken);
      const nextUser = { ...currentUser, googleAccessToken };
      setUser(nextUser);
      saveUser(nextUser);
      return googleAccessToken;
    } catch (err) {
      console.error('[Auth] ensureGoogleWorkspaceAccess failed:', err);
      return null;
    }
  }, [user]);

  const logout = useCallback(() => {
    if (featureFlags.firebaseAuthEnabled) {
      const auth = getAuthInstance();
      if (auth) {
        signOut(auth).catch((err) => {
          console.error('[Auth] signOut failed:', err);
        });
      }
    }

    setMembershipIssue(null);
    setSignedInEmail('');
    setUser(null);
    saveUser(null);
    if (user?.uid) {
      persistGoogleWorkspaceAccessToken(user.uid, undefined);
    }
    clearDevHarnessSession();
    localStorage.removeItem(ACTIVE_TENANT_KEY);
    localStorage.removeItem('mysc-portal-user');
  }, [user?.uid]);

  const isAdmin = useCallback(() => {
    return !!user && isAdminSpaceRole(user.role);
  }, [user]);

  const isPortalUser = useCallback(() => {
    return !!user && user.role === 'pm';
  }, [user]);

  const value: AuthState & AuthActions = {
    isAuthenticated: !!user,
    user,
    isLoading,
    isFirebaseAuthEnabled: featureFlags.firebaseAuthEnabled,
    loginWithGoogle,
    loginWithDevHarness,
    ensureGoogleWorkspaceAccess,
    setWorkspacePreference,
    logout,
    isAdmin,
    isPortalUser,
  };

  return <AuthContext.Provider value={value}>{membershipIssue
    ? <MembershipPending issue={membershipIssue} email={signedInEmail} onRetry={() => setMembershipCheck((value) => value + 1)} onLogout={logout} />
    : children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be inside AuthProvider');
  return ctx;
}
