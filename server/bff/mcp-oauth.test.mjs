import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createMcpOAuthService } from './mcp-oauth.mjs';
import { resolveApiRequestContext } from './app.mjs';

function memoryDb() {
  const rows = new Map();
  const doc = (path) => ({
    async get() { const data = rows.get(path); return { exists: data !== undefined, data: () => data }; },
    async set(data, options = {}) { rows.set(path, options.merge ? { ...(rows.get(path) || {}), ...data } : data); },
    async delete() { rows.delete(path); },
  });
  return {
    doc,
    collection: (name) => ({ doc: (id) => doc(`${name}/${id}`) }),
    async runTransaction(callback) { return callback({ get: (ref) => ref.get(), set: (ref, data, options) => ref.set(data, options) }); },
  };
}

describe('MYSCube MCP OAuth', () => {
  it('treats the dedicated MCP overview POST as a read and never uses Firebase parsing', async () => {
    const verifyToken = () => { throw new Error('must not verify opaque token as Firebase'); };
    const context = await resolveApiRequestContext({
      path: '/mcp/cashflow/weekly-overview', method: 'POST',
      header: (name) => name === 'authorization' ? 'Bearer opaque-token' : '',
    }, {
      authMode: 'firebase_required', verifyToken,
      resolveMcpAccessToken: async () => ({ tenantId: 'mysc', actorId: 'u1', actorRole: 'pm', authSource: 'mcp_oauth' }),
    });
    expect(context).toMatchObject({ tenantId: 'mysc', actorId: 'u1', idempotencyKey: undefined });
  });

  it('exchanges one PKCE code for an opaque token and rechecks active membership', async () => {
    const db = memoryDb();
    await db.doc('orgs/mysc/members/u1').set({ status: 'ACTIVE', role: 'pm', email: 'u1@mysc.co.kr' });
    const service = createMcpOAuthService({ db, issuer: 'https://myscube.myscguard.app' });
    const verifier = 'a'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const loginUrl = await service.startAuthorization({ response_type: 'code', client_id: 'myscube-local-launcher', redirect_uri: 'http://127.0.0.1:45678/callback', code_challenge: challenge, code_challenge_method: 'S256', scope: 'cashflow.read', resource: service.resource, state: 'state' });
    const requestId = new URL(loginUrl).searchParams.get('request_id');
    const redirect = await service.completeAuthorization({ requestId, context: { tenantId: 'mysc', actorId: 'u1', actorEmail: 'u1@mysc.co.kr' } });
    const code = new URL(redirect).searchParams.get('code');
    await expect(service.exchangeCode({ grant_type: 'authorization_code', client_id: 'myscube-local-launcher', redirect_uri: 'http://127.0.0.1:45678/callback', code, code_verifier: 'b'.repeat(43) })).rejects.toMatchObject({ code: 'invalid_grant' });
    const token = await service.exchangeCode({ grant_type: 'authorization_code', client_id: 'myscube-local-launcher', redirect_uri: 'http://127.0.0.1:45678/callback', code, code_verifier: verifier });

    expect(token.access_token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await expect(service.resolveAccessToken(`Bearer ${token.access_token}`)).resolves.toMatchObject({ tenantId: 'mysc', actorId: 'u1', actorRole: 'pm' });
    await db.doc('orgs/mysc/members/u1').set({ status: 'ACTIVE', role: 'finance' });
    await expect(service.resolveAccessToken(`Bearer ${token.access_token}`)).resolves.toMatchObject({ actorRole: 'finance' });
    for (const status of ['DISABLED', '', null, 7, 'active', ' ACTIVE ']) {
      await db.doc('orgs/mysc/members/u1').set({ status, role: 'finance' });
      await expect(service.resolveAccessToken(`Bearer ${token.access_token}`)).rejects.toMatchObject({ code: 'mcp_member_inactive' });
    }
    await db.doc('orgs/mysc/members/u1').set({ role: 'pm' });
    await expect(service.resolveAccessToken(`Bearer ${token.access_token}`)).resolves.toMatchObject({ actorRole: 'pm' });
    await db.doc('orgs/mysc/members/u1').delete();
    await expect(service.resolveAccessToken(`Bearer ${token.access_token}`)).rejects.toMatchObject({ code: 'mcp_member_inactive' });
    await expect(service.exchangeCode({ grant_type: 'authorization_code', client_id: 'myscube-local-launcher', redirect_uri: 'http://127.0.0.1:45678/callback', code, code_verifier: verifier })).rejects.toMatchObject({ code: 'invalid_grant' });
  });

  it('keeps non-developers signed in with rotating refresh tokens and no scope requirement', async () => {
    const db = memoryDb();
    await db.doc('orgs/mysc/members/u1').set({ status: 'ACTIVE', role: 'pm', email: 'u1@mysc.co.kr' });
    let clock = Date.parse('2026-10-13T00:00:00Z');
    const service = createMcpOAuthService({ db, issuer: 'https://myscube.myscguard.app', now: () => new Date(clock) });
    expect(service.metadata().grant_types_supported).toEqual(['authorization_code', 'refresh_token']);
    const { client_id: clientId } = await service.register({ redirectUris: ['https://claude.ai/api/mcp/auth_callback'] });
    const redirectUri = 'https://claude.ai/api/mcp/auth_callback';
    const verifier = 'v'.repeat(43);
    const loginUrl = await service.startAuthorization({ response_type: 'code', client_id: clientId, redirect_uri: redirectUri,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' });
    clock += 5 * 60_000; // Google 로그인에 5분이 걸려도 요청은 살아 있다.
    const redirect = await service.completeAuthorization({ requestId: new URL(loginUrl).searchParams.get('request_id'), context: { tenantId: 'mysc', actorId: 'u1' } });
    const first = await service.exchangeCode({ grant_type: 'authorization_code', client_id: clientId, redirect_uri: redirectUri,
      code: new URL(redirect).searchParams.get('code'), code_verifier: verifier });
    expect(first).toMatchObject({ expires_in: 3600, refresh_token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });

    clock += 20 * 24 * 60 * 60_000; // 20일 뒤에도 다시 로그인하지 않고 갱신된다.
    await expect(service.resolveAccessToken(`Bearer ${first.access_token}`)).rejects.toMatchObject({ code: 'invalid_token' });
    const second = await service.exchangeCode({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token });
    await expect(service.resolveAccessToken(`Bearer ${second.access_token}`)).resolves.toMatchObject({ actorId: 'u1', actorRole: 'pm' });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    await expect(service.exchangeCode({ grant_type: 'refresh_token', client_id: clientId, refresh_token: first.refresh_token })).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(service.exchangeCode({ grant_type: 'refresh_token', client_id: 'other', refresh_token: second.refresh_token })).rejects.toMatchObject({ code: 'invalid_grant' });

    await db.doc('orgs/mysc/members/u1').set({ status: 'DISABLED', role: 'pm' });
    await expect(service.exchangeCode({ grant_type: 'refresh_token', client_id: clientId, refresh_token: second.refresh_token })).rejects.toMatchObject({ code: 'mcp_member_inactive' });
  });
});
