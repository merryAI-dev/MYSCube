import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBffClient } from '../src/bff.mjs';
import { resolveApiRequestContext } from '../../server/bff/app.mjs';

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  authorizationErrorRedirect: () => 'https://client.example/callback?error=access_denied',
}));
const { AuthorizationError } = await import('@cloudflare/workers-oauth-provider');
const { handleCallback } = await import('../src/auth.mjs');
const token = (claims) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const claims = { uid: 'member-fixture', email: 'member@mysc.co.kr' };
const request = () => new Request('https://mcp.myscguard.app/callback?code=fixture-code&state=fixture-state');

function env() {
  return {
    PUBLIC_ORIGIN: 'https://mcp.myscguard.app', BFF_BASE_URL: 'https://myscube.myscguard.app', BFF_TENANT_ID: 'mysc',
    GOOGLE_HOSTED_DOMAIN: 'mysc.co.kr', GOOGLE_CLIENT_ID: 'fixture-client', GOOGLE_CLIENT_SECRET: 'fixture-secret', FIREBASE_WEB_API_KEY: 'fixture-key',
    OAUTH_PROVIDER: {
      finishUpstream: vi.fn(async () => ({ request: { scope: ['myscube:read'] }, data: { verifier: 'fixture' }, headers: new Headers() })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://client.example/callback' })),
    },
  };
}

function backend({ role = 'pm', status = 'ACTIVE', missing = false, rejectToken = false, tokenClaims = claims } = {}) {
  const verifyToken = vi.fn(async () => {
    if (rejectToken) throw new Error('fixture_invalid_signature');
    return tokenClaims;
  });
  const membership = vi.fn(async () => missing ? null : ({ role, status }));
  const fetchImpl = vi.fn(async (_url, init) => {
    const headers = new Headers(init.headers);
    try {
      // Real BFF identity and membership code; only token verification and storage are fixtures.
      const context = await resolveApiRequestContext({ method: 'GET', path: '/projects', header: (key) => headers.get(key) }, {
        authMode: 'firebase_required', verifyToken, resolveMemberIdentity: membership,
      });
      return Response.json({ tenantId: context.tenantId, role: context.actorRole });
    } catch (error) {
      return Response.json({ code: error.code || 'internal', message: 'fixture backend denied' }, { status: error.statusCode || 500 });
    }
  });
  return { fetchImpl, verifyToken, membership };
}

function upstream(bff, firebaseClaims = claims) {
  return vi.fn(async (url, init) => {
    if (String(url).startsWith('https://oauth2.googleapis.com/')) return Response.json({ id_token: token({ aud: 'fixture-client', email: claims.email, email_verified: true, hd: 'mysc.co.kr' }) });
    if (String(url).includes('signInWithIdp')) return Response.json({ localId: claims.uid, idToken: token(firebaseClaims), refreshToken: 'fixture-refresh', expiresIn: 3600 });
    return bff(url, init);
  });
}

afterEach(() => vi.restoreAllMocks());

describe('MCP tenant context with real BFF request authorization', () => {
  it.each(['admin', 'pm', 'finance'])('connects an active %s without tenant claims', async (role) => {
    const e = env(); const b = backend({ role });
    const response = await handleCallback(request(), e, { fetchImpl: upstream(b.fetchImpl) });
    expect(response.status).toBe(302);
    expect(new Headers(b.fetchImpl.mock.calls[0][1].headers).get('x-tenant-id')).toBe('mysc');
    expect(b.verifyToken).toHaveBeenCalledOnce();
    expect(b.membership).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 'mysc', actorId: claims.uid }));
    expect(e.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledOnce();
  });

  it.each(['tenantId', 'tenant_id', 'orgId', 'org_id'])('preserves BFF claim routing for %s', async (key) => {
    const c = { ...claims, [key]: ' OTHER-ORG ' }; const b = backend({ tokenClaims: c });
    const result = await createBffClient({ baseUrl: 'https://bff.example', idToken: token(c), tenantId: 'mysc', fetchImpl: b.fetchImpl }).get('/api/v1/projects');
    expect(new Headers(b.fetchImpl.mock.calls[0][1].headers).has('x-tenant-id')).toBe(false);
    expect(result.tenantId).toBe('other-org');
  });

  it('uses the fallback for whitespace claims and normalizes server configuration', async () => {
    const c = { ...claims, tenantId: ' ' }; const b = backend({ tokenClaims: c });
    const result = await createBffClient({ baseUrl: 'https://bff.example', idToken: token(c), tenantId: ' MYSC ', fetchImpl: b.fetchImpl }).get('/api/v1/projects');
    expect(result.tenantId).toBe('mysc');
  });

  it('keeps fresh membership role authoritative over an admin token claim', async () => {
    const c = { ...claims, role: 'admin' }; const b = backend({ tokenClaims: c, role: 'pm' });
    const result = await createBffClient({ baseUrl: 'https://bff.example', idToken: token(c), tenantId: 'mysc', fetchImpl: b.fetchImpl }).get('/api/v1/projects');
    expect(result.role).toBe('pm');
  });

  it('lets the BFF apply the existing claim alias priority', async () => {
    const c = { ...claims, tenantId: ' ', tenant_id: ' first-org ', orgId: 'second-org' }; const b = backend({ tokenClaims: c });
    const result = await createBffClient({ baseUrl: 'https://bff.example', idToken: token(c), tenantId: 'mysc', fetchImpl: b.fetchImpl }).get('/api/v1/projects');
    expect(result.tenantId).toBe('first-org');
  });

  it('leaves invalid nonempty claims for the BFF to reject instead of substituting an organization', async () => {
    const c = { ...claims, tenantId: '../other' }; const b = backend({ tokenClaims: c });
    await expect(createBffClient({ baseUrl: 'https://bff.example', idToken: token(c), tenantId: 'mysc', fetchImpl: b.fetchImpl }).get('/api/v1/projects')).rejects.toMatchObject({ status: 500 });
    expect(b.membership).not.toHaveBeenCalled();
  });

  it.each([undefined, '', '../mysc', 'a'.repeat(33)])('fails before fetching when fallback configuration is invalid: %s', async (tenantId) => {
    const fetchImpl = vi.fn();
    await expect(createBffClient({ baseUrl: 'https://bff.example', idToken: token(claims), tenantId, fetchImpl }).get('/api/v1/projects')).rejects.toMatchObject({ status: 503, code: 'tenant_context_unconfigured' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ status: 'INACTIVE' }, { missing: true }, { rejectToken: true }])('does not grant access when the BFF rejects %j', async (options) => {
    const e = env(); const b = backend(options);
    const response = await handleCallback(request(), e, { fetchImpl: upstream(b.fetchImpl) });
    expect(response.status).toBe(403);
    expect(e.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });

  it('does not grant malformed tokens even when an organization is configured', async () => {
    const b = backend({ rejectToken: true });
    await expect(createBffClient({ baseUrl: 'https://bff.example', idToken: 'malformed', tenantId: 'mysc', fetchImpl: b.fetchImpl }).get('/api/v1/projects')).rejects.toMatchObject({ status: 401 });
    expect(b.membership).not.toHaveBeenCalled();
  });
});

describe('callback failures return safe responses', () => {
  it('handles missing, expired, reused or foreign-browser authorization state without skipping validation', async () => {
    const e = env(); e.OAUTH_PROVIDER.finishUpstream.mockRejectedValue(new AuthorizationError('fixture private state detail'));
    const fetchImpl = vi.fn(); const response = await handleCallback(request(), e, { fetchImpl });
    expect(response.status).toBe(400); expect(await response.text()).not.toContain('fixture private state detail');
    expect(fetchImpl).not.toHaveBeenCalled(); expect(e.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });

  it.each(['google', 'firebase', 'bff', 'grant'])('does not leak private upstream details when %s fails', async (step) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {}); const e = env(); const base = upstream(async () => Response.json({ items: [] }));
    if (step === 'grant') e.OAUTH_PROVIDER.completeAuthorization.mockRejectedValue(new Error('fixture-private-code-token'));
    const fetchImpl = async (url, init) => {
      if ((step === 'google' && String(url).includes('oauth2.googleapis.com')) || (step === 'firebase' && String(url).includes('signInWithIdp'))) throw new TypeError('fixture-private-code-token');
      if (step === 'bff' && String(url).includes('/api/v1/projects')) return Response.json({ message: 'fixture-private-code-token' }, { status: 500 });
      return base(url, init);
    };
    const response = await handleCallback(request(), e, { fetchImpl });
    expect(response.status).toBe(502); expect(await response.text()).not.toContain('fixture-private-code-token');
    expect(JSON.stringify(log.mock.calls)).not.toContain('fixture-private-code-token');
    if (step !== 'grant') expect(e.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
  });
});
