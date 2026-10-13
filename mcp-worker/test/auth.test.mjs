import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
  authorizationErrorRedirect: (request, error) => `${request.redirectUri}?error=${error}&state=${request.state}`,
}));
const { handleCallback } = await import('../src/auth.mjs');

const b64 = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '');
const original = { redirectUri: 'https://claude.ai/cb', state: 'st', scope: ['myscube:read'] };

function env(overrides = {}) {
  return {
    PUBLIC_ORIGIN: 'https://mcp.myscguard.app', BFF_BASE_URL: 'https://myscube.myscguard.app', GOOGLE_HOSTED_DOMAIN: 'mysc.co.kr',
    GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', FIREBASE_WEB_API_KEY: 'k',
    OAUTH_PROVIDER: {
      finishUpstream: vi.fn(async () => ({ request: original, data: { verifier: 'v' }, headers: new Headers() })),
      completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=mcp-code&state=st' })),
    },
    ...overrides,
  };
}

function upstream({ bffStatus = 200, hd = 'mysc.co.kr' } = {}) {
  return vi.fn(async (url) => {
    const target = String(url);
    if (target.startsWith('https://oauth2.googleapis.com')) return Response.json({ id_token: `h.${b64({ aud: 'cid', email: 'a@mysc.co.kr', email_verified: true, hd })}.s` });
    if (target.includes('signInWithIdp')) return Response.json({ localId: 'u1', idToken: 'fid', refreshToken: 'fref', expiresIn: '3600' });
    if (target.startsWith('https://myscube.myscguard.app/api/v1/projects')) return Response.json(bffStatus === 200 ? { items: [] } : { message: 'Active organization membership is required' }, { status: bffStatus });
    throw new Error(`unexpected ${target}`);
  });
}

describe('OAuth callback', () => {
  it('issues an MCP grant for an active member holding only the encrypted Firebase session', async () => {
    const e = env();
    const response = await handleCallback(new Request('https://mcp.myscguard.app/callback?code=g&state=st'), e, { fetchImpl: upstream() });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://claude.ai/cb?code=mcp-code&state=st');
    expect(e.OAUTH_PROVIDER.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      request: original, userId: 'u1', scope: ['myscube:read'],
      props: expect.objectContaining({ uid: 'u1', email: 'a@mysc.co.kr', firebaseIdToken: 'fid', firebaseRefreshToken: 'fref' }),
    }));
  });

  it('refuses people who are not active MYSCube members or not on the company domain', async () => {
    for (const options of [{ bffStatus: 403 }, { hd: 'gmail.com' }]) {
      const e = env();
      const response = await handleCallback(new Request('https://mcp.myscguard.app/callback?code=g&state=st'), e, { fetchImpl: upstream(options) });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).toMatch(/구성원|회사 Google 계정/);
      expect(e.OAUTH_PROVIDER.completeAuthorization).not.toHaveBeenCalled();
    }
  });

  it('returns access_denied to the client when the user cancels at Google', async () => {
    const response = await handleCallback(new Request('https://mcp.myscguard.app/callback?error=access_denied&state=st'), env(), { fetchImpl: upstream() });
    expect(response.headers.get('location')).toBe('https://claude.ai/cb?error=access_denied&state=st');
  });
});
