import { getAuth } from 'firebase-admin/auth';
import { getOrInitAdminApp } from './firestore.mjs';
import { assertTenantId, normalizeActorId, normalizeTenantId } from './utils.mjs';

const AUTH_MODES = new Set(['headers', 'firebase_optional', 'firebase_required']);
const TENANT_CLAIM_KEYS = ['tenantId', 'tenant_id', 'orgId', 'org_id'];

function createAuthError(statusCode, message, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code || (statusCode === 401 ? 'unauthorized' : 'forbidden');
  return error;
}

function normalizeRole(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'viewer' ? 'pm' : normalized;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeActorName(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function normalizeDomain(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const withoutAt = raw.startsWith('@') ? raw.slice(1) : raw;
  return withoutAt.replace(/\s+/g, '');
}

export function parseAllowedEmailDomains(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return ['mysc.co.kr'];
  return text
    .split(',')
    .map((part) => normalizeDomain(part))
    .filter(Boolean);
}

export function isAllowedEmail(email, allowedDomains) {
  const normalized = normalizeEmail(email);
  if (!normalized || !normalized.includes('@')) return false;
  const domain = normalized.split('@').pop() || '';
  return allowedDomains.some((allowed) => domain === normalizeDomain(allowed));
}

function normalizeOptionalActorId(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';
  return raw.replace(/\s+/g, '_').replace(/[^A-Za-z0-9._-]/g, '_');
}

function readHeader(readHeaderValue, name) {
  return String(readHeaderValue(name) || '').trim();
}

export function resolveAuthMode(env = process.env) {
  const configured = String(env.BFF_AUTH_MODE || '').trim().toLowerCase();
  if (AUTH_MODES.has(configured)) {
    return configured;
  }
  return env.NODE_ENV === 'production' ? 'firebase_required' : 'headers';
}

export function parseAuthorizationBearer(rawAuthorizationHeader) {
  const headerValue = String(rawAuthorizationHeader || '').trim();
  if (!headerValue) return '';
  const match = headerValue.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function extractTenantIdFromClaims(claims) {
  if (!claims || typeof claims !== 'object') return '';
  for (const key of TENANT_CLAIM_KEYS) {
    const normalized = normalizeTenantId(claims[key]);
    if (normalized) return normalized;
  }
  return '';
}

export function extractRoleFromClaims(claims) {
  if (!claims || typeof claims !== 'object') return '';
  const claimRole = normalizeRole(claims.role);
  if (claimRole) return claimRole;

  if (Array.isArray(claims.roles)) {
    for (const role of claims.roles) {
      const normalized = normalizeRole(role);
      if (normalized) return normalized;
    }
  }
  return '';
}

export function createFirebaseTokenVerifier(options = {}) {
  const app = getOrInitAdminApp({ projectId: options.projectId, appName: options.appName });
  const auth = getAuth(app);
  return async (token) => auth.verifyIdToken(token, true);
}

export function createFirebaseAuthAdminService(options = {}) {
  const app = getOrInitAdminApp({ projectId: options.projectId, appName: options.appName });
  const auth = getAuth(app);

  return {
    async listUsers(maxResults = 1000, pageToken) {
      return auth.listUsers(maxResults, pageToken);
    },
    async getUserByEmail(email) {
      return auth.getUserByEmail(email);
    },
    async setCustomUserClaims(uid, claims) {
      await auth.setCustomUserClaims(uid, claims);
      return claims;
    },
  };
}

export function resolveFirebaseAuthProjectId(options = {}, env = process.env, fallbackProjectId = '') {
  return readText(options.firebaseAuthProjectId)
    || readText(env.BFF_FIREBASE_AUTH_PROJECT_ID)
    || readText(env.FIREBASE_AUTH_PROJECT_ID)
    || readText(env.VITE_FIREBASE_PROJECT_ID)
    || readText(fallbackProjectId);
}

function resolveIdentityFromHeaders({ readHeaderValue }) {
  const tenantId = assertTenantId(readHeader(readHeaderValue, 'x-tenant-id'));
  const actorId = normalizeActorId(readHeader(readHeaderValue, 'x-actor-id'));
  const actorRole = normalizeRole(readHeader(readHeaderValue, 'x-actor-role')) || undefined;
  const actorEmail = normalizeEmail(readHeader(readHeaderValue, 'x-actor-email')) || undefined;
  const actorName = normalizeActorName(readHeader(readHeaderValue, 'x-actor-name')) || undefined;

  return {
    source: 'headers',
    tenantId,
    actorId,
    actorRole,
    actorEmail,
    actorName,
  };
}

export async function resolveRequestIdentity(params) {
  const {
    authMode,
    readHeaderValue,
    verifyToken,
  } = params;

  if (authMode === 'headers') {
    return resolveIdentityFromHeaders({ readHeaderValue });
  }

  const bearerToken = parseAuthorizationBearer(readHeader(readHeaderValue, 'authorization'));
  if (!bearerToken && authMode === 'firebase_required') {
    throw createAuthError(401, 'Authorization Bearer token is required', 'missing_bearer_token');
  }

  if (!bearerToken && authMode === 'firebase_optional') {
    return resolveIdentityFromHeaders({ readHeaderValue });
  }

  if (!verifyToken) {
    throw createAuthError(500, 'Auth verifier is not configured', 'auth_not_configured');
  }

  let claims;
  try {
    claims = await verifyToken(bearerToken);
  } catch {
    throw createAuthError(401, 'Invalid Firebase ID token', 'invalid_token');
  }

  const claimActorId = normalizeOptionalActorId(claims?.uid || claims?.sub);
  if (!claimActorId) {
    throw createAuthError(401, 'Token does not include a valid uid', 'invalid_token');
  }

  const claimTenantId = extractTenantIdFromClaims(claims);
  const headerTenantId = normalizeTenantId(readHeader(readHeaderValue, 'x-tenant-id'));
  if (claimTenantId && headerTenantId && claimTenantId !== headerTenantId) {
    throw createAuthError(403, 'Header tenant does not match token tenant', 'tenant_mismatch');
  }

  const headerActorId = normalizeOptionalActorId(readHeader(readHeaderValue, 'x-actor-id'));
  if (headerActorId && headerActorId !== claimActorId) {
    throw createAuthError(403, 'Header actor does not match token subject', 'actor_mismatch');
  }

  const claimEmail = normalizeEmail(claims?.email || '');
  const claimActorName = normalizeActorName(claims?.name || claims?.displayName || claims?.display_name || '');
  const allowedDomains = parseAllowedEmailDomains(process.env.BFF_ALLOWED_EMAIL_DOMAINS);
  if (!claimEmail) {
    throw createAuthError(403, 'Token does not include a valid email', 'missing_email');
  }
  if (!isAllowedEmail(claimEmail, allowedDomains)) {
    throw createAuthError(403, 'Email domain is not allowed', 'email_domain_not_allowed');
  }

  const claimRole = extractRoleFromClaims(claims);
  const resolvedTenantId = assertTenantId(claimTenantId || headerTenantId);
  return {
    source: 'firebase',
    tenantId: resolvedTenantId,
    actorId: claimActorId,
    actorRole: claimRole || undefined,
    actorEmail: claimEmail || undefined,
    actorName: claimActorName || undefined,
    tokenClaims: claims,
  };
}
