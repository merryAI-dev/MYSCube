import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, verify } from 'node:crypto';
import { createGitCredentialProvider } from './git-credentials.mjs';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const env = { WORKBENCH_GIT_CREDENTIAL_MODE: 'github-app', WORKBENCH_GITHUB_APP_ID: '12345', WORKBENCH_GITHUB_INSTALLATION_ID: '67890', WORKBENCH_GITHUB_APP_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() };
const at = Date.parse('2026-09-23T00:00:00.000Z');
const answer = { token: 'server-only-installation-token', expires_at: new Date(at + 3600000).toISOString(), permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }, repositories: [{ full_name: 'owner/generated' }] };
describe('server-only Git credential provider', () => {
  it('uses only the dedicated token setting and never inherits developer credentials', async () => {
    const missing = createGitCredentialProvider({ env: { GITHUB_TOKEN: 'production-token', GH_TOKEN: 'developer-token' } });
    await expect(missing({ repository: 'owner/generated' })).rejects.toMatchObject({ code: 'git_delivery_disabled' });
    const dedicated = createGitCredentialProvider({ env: { WORKBENCH_GITHUB_TOKEN: 'dedicated' } });
    expect(await dedicated({ repository: 'owner/generated' })).toBe('dedicated');
  });
  it('signs a short-lived RS256 JWT and requests exactly one repository with Contents and PR write permissions', async () => {
    const calls = [];
    const credentials = createGitCredentialProvider({ env, now: () => at, fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const jwt = options.headers.Authorization.slice(7); const parts = jwt.split('.');
      expect(verify('RSA-SHA256', Buffer.from(parts.slice(0, 2).join('.')), publicKey, Buffer.from(parts[2], 'base64url'))).toBe(true);
      expect(JSON.parse(Buffer.from(parts[0], 'base64url'))).toEqual({ alg: 'RS256', typ: 'JWT' });
      expect(JSON.parse(Buffer.from(parts[1], 'base64url'))).toEqual({ iat: at / 1000 - 60, exp: at / 1000 + 540, iss: '12345' });
      expect(JSON.parse(options.body)).toEqual({ repositories: ['generated'], permissions: { contents: 'write', pull_requests: 'write' } });
      expect(options.redirect).toBe('error');
      return new Response(JSON.stringify(answer));
    } });
    const signal = AbortSignal.timeout(1000);
    expect(await credentials({ repository: 'owner/generated', signal })).toBe(answer.token);
    expect(await credentials({ repository: 'owner/generated', signal })).toBe(answer.token);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.github.com/app/installations/67890/access_tokens');
  });
  it('refreshes an expiring token in memory and does not reuse it across repositories', async () => {
    let clock = at; let calls = 0;
    const credentials = createGitCredentialProvider({ env, now: () => clock, fetchImpl: async (_url, options) => {
      calls++; const name = JSON.parse(options.body).repositories[0];
      return new Response(JSON.stringify({ ...answer, token: `token-${calls}`, expires_at: new Date(clock + 3600000).toISOString(), repositories: [{ full_name: `owner/${name}` }] }));
    } });
    expect(await credentials({ repository: 'owner/generated' })).toBe('token-1');
    clock += 3550000;
    expect(await credentials({ repository: 'owner/generated' })).toBe('token-2');
    expect(await credentials({ repository: 'owner/other' })).toBe('token-3');
  });
  it('refuses wider permissions, wrong repository or an expired token', async () => {
    for (const value of [{ ...answer, permissions: { ...answer.permissions, administration: 'write' } }, { ...answer, repositories: [{ full_name: 'owner/other' }] }, { ...answer, expires_at: new Date(at).toISOString() }]) {
      const credentials = createGitCredentialProvider({ env, now: () => at, fetchImpl: async () => new Response(JSON.stringify(value)) });
      await expect(credentials({ repository: 'owner/generated' })).rejects.toMatchObject({ code: 'git_credential_scope_invalid' });
    }
  });
  it('redacts provider failures and stops on caller cancellation', async () => {
    const credentials = createGitCredentialProvider({ env, fetchImpl: async () => new Response(JSON.stringify({ message: env.WORKBENCH_GITHUB_APP_PRIVATE_KEY }), { status: 403 }) });
    await expect(credentials({ repository: 'owner/generated' })).rejects.toMatchObject({ code: 'git_credential_denied', message: expect.not.stringContaining('PRIVATE KEY') });
    const controller = new AbortController(); controller.abort();
    await expect(credentials({ repository: 'owner/generated', signal: controller.signal })).rejects.toBeDefined();
  });
});
