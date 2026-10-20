// Actual OAuthProvider, KV and MCP HTTP transport in workerd. All identities and upstreams are synthetic.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ORIGIN = 'https://ema.fixture.test';
const WEB = 'https://web.fixture.test';
const REDIRECT = 'https://client.fixture.test/callback';
const R = 'ema:registry', N = 'ema:news:read';
const VERIFIER = 'synthetic-pkce-verifier-for-offline-tests-only-123456789';
let runtime;

beforeAll(async () => {
  const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/ema/index.mjs', import.meta.url))],
    bundle: true, format: 'esm', platform: 'browser', conditions: ['workerd', 'worker', 'browser'],
    external: ['cloudflare:workers', 'node:*'], write: false });
  runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
    { name: 'ema', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'],
      bindings: { PUBLIC_ORIGIN: ORIGIN, EMA_WEB_ORIGIN: WEB, EMA_FUNCTIONS_BASE: 'https://functions.fixture.test',
        CONSENT_SECRET: 'offline-fixture-consent-secret-32-characters', FIREBASE_WEB_API_KEY: 'offline-fixture' },
      outboundService: 'fixture-upstream' },
    { name: 'fixture-upstream', modules: true, compatibilityDate: '2026-09-01', script: `
      export default { async fetch(request) {
        const url = new URL(request.url);
        if (url.hostname === 'securetoken.googleapis.com' && url.pathname === '/v1/token') {
          return Response.json({id_token:'offline-synthetic-refreshed-admin-token',refresh_token:'offline-synthetic-refresh',expires_in:3600});
        }
        if (url.hostname !== 'functions.fixture.test') return new Response('Unexpected external request blocked', {status:502});
        if (url.pathname === '/getAdminLabNews') {
          const {data} = await request.json();
          if (request.method !== 'POST' || data.source !== 'publishers' || data.period !== 'custom') return new Response('Unexpected reader request blocked', {status:502});
          return Response.json({result:{source:'publishers',period:{from:data.from,to:data.to,timezone:'Asia/Seoul',asOf:'2026-10-19T00:00:00Z'},inbox:[],inboxTruncated:false}});
        }
        if (url.pathname !== '/getRegistryAccess') return new Response('Unexpected callable blocked', {status:502});
        return Response.json({result:{uid:'offline-admin',email:'offline@example.invalid',role:'admin',canExportAndImport:true}});
      } };` },
  ] }));
}, 30_000);
afterAll(async () => { await runtime?.dispose(); });

function jar() {
  const values = new Map();
  return {
    take(response) {
      for (const line of response.headers.getSetCookie()) {
        const pair = line.split(';', 1)[0], at = pair.indexOf('=');
        const key = pair.slice(0, at), value = pair.slice(at + 1);
        if (!value) values.delete(key); else values.set(key, value);
      }
    },
    header() { return [...values].map(([key, value]) => `${key}=${value}`).join('; '); },
  };
}
async function begin(scope) {
  const registration = await runtime.dispatchFetch(`${ORIGIN}/register`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Offline QA',
      redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'] }) });
  expect(registration.status).toBe(201);
  const { client_id: clientId } = await registration.json();
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT,
    state: 'offline-client-state', scope: scope.join(' '), resource: `${ORIGIN}/mcp`,
    code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'), code_challenge_method: 'S256' });
  const cookies = jar();
  const consent = await runtime.dispatchFetch(`${ORIGIN}/authorize?${params}`);
  expect(consent.status).toBe(200); cookies.take(consent);
  const html = await consent.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  expect(handle).toBeTruthy();
  return { clientId, cookies, handle, html };
}
async function decision(flow, approve, news) {
  const body = new URLSearchParams({ handle: flow.handle, decision: approve ? 'approve' : 'deny' });
  if (news) body.set('newsConsent', 'yes');
  const response = await runtime.dispatchFetch(`${ORIGIN}/authorize`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: flow.cookies.header() }, body });
  flow.cookies.take(response); return response;
}
async function authorize(scope, news) {
  const flow = await begin(scope);
  const approved = await decision(flow, true, news);
  expect(approved.status).toBe(302);
  const state = new URL(approved.headers.get('location')).searchParams.get('state');
  const session = await runtime.dispatchFetch(`${ORIGIN}/ema/session`, { method: 'POST',
    headers: { origin: WEB, cookie: flow.cookies.header(), 'content-type': 'application/json' },
    body: JSON.stringify({ state, idToken: 'offline-synthetic-admin-token', refreshToken: 'offline-synthetic-refresh' }) });
  expect(session.status).toBe(200);
  const code = new URL((await session.json()).redirectTo).searchParams.get('code');
  const exchange = await runtime.dispatchFetch(`${ORIGIN}/token`, { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code',
      client_id: flow.clientId, code, redirect_uri: REDIRECT, code_verifier: VERIFIER, resource: `${ORIGIN}/mcp` }) });
  expect(exchange.status).toBe(200);
  return { flow, token: await exchange.json() };
}
async function tools(token) {
  const response = await runtime.dispatchFetch(`${ORIGIN}/mcp`, { method: 'POST', headers: {
    authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  expect(response.status).toBe(200);
  return (await response.json()).result.tools.map((tool) => tool.name);
}

describe('EMA actual SDK OAuth consent, tokens and tool scopes (offline only)', () => {
  it('keeps a registry-only authorization registry-only when news is unchecked', async () => {
    const { flow, token } = await authorize([R], false);
    expect(token.scope.split(' ')).toEqual([R]);
    const names = await tools(token); expect(names).toContain('ema_registry_search'); expect(names).not.toContain('ema_news_read');
    const escalation = await runtime.dispatchFetch(`${ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: flow.clientId, refresh_token: token.refresh_token,
        scope: `${R} ${N}`, resource: `${ORIGIN}/mcp` }) });
    // The installed provider intersects requested scopes with the existing grant.
    expect(escalation.status).toBe(200);
    const bounded = await escalation.json();
    expect(bounded.scope).toBe(R);
    expect(await tools(bounded)).not.toContain('ema_news_read');
  }, 30_000);
  it('grants optional news only after explicit selection and honors token refresh downscope', async () => {
    const { flow, token } = await authorize([R], true);
    expect(new Set(token.scope.split(' '))).toEqual(new Set([R, N]));
    expect(await tools(token)).toContain('ema_news_read');
    const refresh = await runtime.dispatchFetch(`${ORIGIN}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: flow.clientId, refresh_token: token.refresh_token,
        scope: R, resource: `${ORIGIN}/mcp` }) });
    expect(refresh.status).toBe(200); const reduced = await refresh.json(); expect(reduced.scope).toBe(R);
    const names = await tools(reduced); expect(names).not.toContain('ema_news_read'); expect(names).toContain('ema_registry_search');
  }, 30_000);
  it('keeps a news-only token isolated from registry and writing tools', async () => {
    const { token } = await authorize([N], true);
    expect(token.scope).toBe(N); expect(await tools(token)).toEqual(['ema_news_read']);
    const response = await runtime.dispatchFetch(`${ORIGIN}/mcp`, { method: 'POST', headers: {
      authorization: `Bearer ${token.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2025-03-26' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: {name:'ema_news_read',arguments:{from:'2026-10-01',to:'2026-10-19'}} }) });
    expect(response.status).toBe(200);
    const result = (await response.json()).result;
    expect(result.isError).not.toBe(true);
    const snapshot = JSON.parse(result.content[0].text);
    expect(snapshot.status).toBe('no_matches_in_saved_corpus');
    expect(snapshot.coverage.sourceHealth).toBe('unknown');
    expect(snapshot.sendEligible).toBe(false);
  }, 30_000);
  it('denies without consenting to requested news and rejects missing required consent', async () => {
    const declined = await begin([N]);
    expect(declined.html).toMatch(/value="deny"[^>]*formnovalidate|formnovalidate[^>]*value="deny"/);
    const denial = await decision(declined, false, false); expect(denial.status).toBe(302);
    expect(new URL(denial.headers.get('location')).searchParams.get('error')).toBe('access_denied');
    const unchecked = await begin([N]); expect((await decision(unchecked, true, false)).status).toBe(400);
  }, 30_000);
});
