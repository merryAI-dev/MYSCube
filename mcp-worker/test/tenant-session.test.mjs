import { afterEach, describe, expect, it, vi } from 'vitest';
const bridge = vi.hoisted(() => ({ bff: null }));
vi.mock('@cloudflare/workers-oauth-provider', () => ({
  default: class Provider { constructor(options) { return options; } },
  GrantType: { AUTHORIZATION_CODE: 'authorization_code', REFRESH_TOKEN: 'refresh_token' },
  OAuthError: class OAuthError extends Error {}, AuthorizationError: class AuthorizationError extends Error {},
}));
vi.mock('../src/tools.mjs', () => ({ createMyscubeMcpServer: ({ bff }) => {
  bridge.bff = bff; return { connect: async () => {} };
} }));
vi.mock('@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js', () => ({
  WebStandardStreamableHTTPServerTransport: class Transport {
    async handleRequest() { return Response.json(await bridge.bff.get('/api/v1/projects')); }
  },
}));
const { default: worker } = await import('../src/index.mjs');
const token = (claims) => `fixture.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture`;
const env = { BFF_BASE_URL: 'https://bff.example', BFF_TENANT_ID: 'mysc', FIREBASE_WEB_API_KEY: 'fixture-key' };
afterEach(() => vi.unstubAllGlobals());

describe('authenticated MCP request wiring', () => {
  it.each([false, true])('passes tenant context through the actual handler; refresh=%s', async (expired) => {
    const bffHeaders = []; let refreshCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('securetoken.googleapis.com')) {
        refreshCalls++; return Response.json({ id_token: token({ uid: 'fixture' }), refresh_token: 'fixture-refresh', expires_in: 3600 });
      }
      bffHeaders.push(new Headers(init.headers)); return Response.json({ items: [] });
    }));
    const props = { uid: 'fixture', firebaseIdToken: token({ uid: 'fixture' }), firebaseRefreshToken: 'fixture-refresh', firebaseExpiresAt: expired ? 0 : Date.now() + 3600_000 };
    const response = await worker.apiHandler.fetch(new Request('https://mcp.myscguard.app/mcp', { method: 'POST' }), env, { props });
    expect(response.status).toBe(200); expect(refreshCalls).toBe(expired ? 1 : 0);
    expect(bffHeaders[0].get('x-tenant-id')).toBe('mysc');
  });

  it('preserves organization claims acquired by a refreshed session', async () => {
    let headers;
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (String(url).includes('securetoken.googleapis.com')) return Response.json({ id_token: token({ uid: 'fixture', orgId: 'other' }), refresh_token: 'fixture-refresh', expires_in: 3600 });
      headers = new Headers(init.headers); return Response.json({ items: [] });
    }));
    await worker.apiHandler.fetch(new Request('https://mcp.myscguard.app/mcp', { method: 'POST' }), env, { props: { uid: 'fixture', firebaseIdToken: token({ uid: 'fixture' }), firebaseRefreshToken: 'fixture-refresh', firebaseExpiresAt: 0 } });
    expect(headers.has('x-tenant-id')).toBe(false);
  });
});
