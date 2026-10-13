import { describe, expect, it, vi } from 'vitest';
import { createBffClient, BffError } from '../src/bff.mjs';
import { exchangeGoogleCode, googleAuthorizeUrl, refreshFirebase, signInFirebase } from '../src/identity.mjs';

const b64 = (value) => btoa(JSON.stringify(value)).replace(/=+$/, '');
const idToken = (claims) => `h.${b64(claims)}.s`;

describe('company Google sign-in to Firebase', () => {
  it('asks Google for the company domain with PKCE', () => {
    const url = new URL(googleAuthorizeUrl({ clientId: 'cid', redirectUri: 'https://mcp.myscguard.app/callback', state: 's', codeChallenge: 'c', hostedDomain: 'mysc.co.kr' }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ hd: 'mysc.co.kr', code_challenge_method: 'S256', scope: 'openid email profile' });
  });

  it('accepts only verified company accounts issued for this client', async () => {
    const google = (claims) => vi.fn(async () => Response.json({ id_token: idToken(claims) }));
    const base = { code: 'c', verifier: 'v', clientId: 'cid', clientSecret: 'sec', redirectUri: 'r', hostedDomain: 'mysc.co.kr' };
    await expect(exchangeGoogleCode({ ...base, fetchImpl: google({ aud: 'cid', email: 'A@mysc.co.kr', email_verified: true, hd: 'mysc.co.kr' }) }))
      .resolves.toMatchObject({ email: 'a@mysc.co.kr' });
    for (const claims of [{ aud: 'cid', email_verified: true, hd: 'gmail.com' }, { aud: 'cid', email_verified: false, hd: 'mysc.co.kr' }, { aud: 'other', email_verified: true, hd: 'mysc.co.kr' }]) {
      await expect(exchangeGoogleCode({ ...base, fetchImpl: google(claims) })).rejects.toMatchObject({ code: 'google_account_not_allowed' });
    }
  });

  it('turns the Google token into a Firebase session and refreshes it', async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).includes('signInWithIdp')
      ? Response.json({ localId: 'u1', idToken: 'fid', refreshToken: 'fref', expiresIn: '3600' })
      : Response.json({ id_token: 'fid2', refresh_token: 'fref2', expires_in: '3600' })));
    await expect(signInFirebase({ googleIdToken: 'g', apiKey: 'k', requestUri: 'https://mcp.myscguard.app', fetchImpl }))
      .resolves.toEqual({ uid: 'u1', idToken: 'fid', refreshToken: 'fref', expiresIn: 3600 });
    await expect(refreshFirebase({ refreshToken: 'fref', apiKey: 'k', fetchImpl })).resolves.toMatchObject({ idToken: 'fid2', refreshToken: 'fref2' });
  });

  it('separates a revoked login from a temporary outage', async () => {
    const reply = (status, message) => vi.fn(async () => Response.json({ error: { message } }, { status }));
    await expect(refreshFirebase({ refreshToken: 'r', apiKey: 'k', fetchImpl: reply(400, 'USER_DISABLED') })).rejects.toMatchObject({ code: 'firebase_revoked' });
    await expect(refreshFirebase({ refreshToken: 'r', apiKey: 'k', fetchImpl: reply(503, 'UNAVAILABLE') })).rejects.toMatchObject({ code: 'firebase_unavailable' });
    await expect(refreshFirebase({ refreshToken: 'r', apiKey: 'k', fetchImpl: vi.fn(async () => { throw new TypeError('network'); }) })).rejects.toMatchObject({ code: 'firebase_unavailable' });
  });
});

describe('BFF client', () => {
  it('calls the BFF as the member with a stable user agent and an idempotency key for POST reads', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ ok: true }));
    const bff = createBffClient({ baseUrl: 'https://myscube.myscguard.app', idToken: 'fid', fetchImpl });
    await bff.get('/api/v1/projects', { limit: 1, cursor: undefined });
    await bff.post('/api/v1/cashflow/weekly-overview', { yearMonth: '2026-09' });
    const [getUrl, getInit] = fetchImpl.mock.calls[0];
    expect(String(getUrl)).toBe('https://myscube.myscguard.app/api/v1/projects?limit=1');
    expect(getInit.headers).toMatchObject({ authorization: 'Bearer fid', 'user-agent': 'myscube-mcp-worker/1.0' });
    expect(fetchImpl.mock.calls[1][1].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    await expect(bff.get('/admin')).rejects.toThrow('bff_path_invalid');
  });

  it('reports BFF errors with status and message', async () => {
    const bff = createBffClient({ baseUrl: 'https://b', idToken: 't', fetchImpl: vi.fn(async () => Response.json({ code: 'member_inactive', message: 'Active organization membership is required' }, { status: 403 })) });
    await expect(bff.get('/api/v1/projects')).rejects.toBeInstanceOf(BffError);
    await expect(bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 403, code: 'member_inactive' });
  });
});
