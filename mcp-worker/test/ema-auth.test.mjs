import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  authorizationErrorRedirect: (request, error) => `${request.redirectUri}?error=${error}`,
}));
const { handleSession } = await import('../src/ema/auth.mjs');
const { createEmaClient, EmaError } = await import('../src/ema/client.mjs');

const WEB = 'https://emastation.myscguard.app';
const env = (provider) => ({
  EMA_WEB_ORIGIN: WEB, PUBLIC_ORIGIN: 'https://ema-mcp.myscguard.app',
  EMA_FUNCTIONS_BASE: 'https://functions.example/fn', OAUTH_PROVIDER: provider,
});
const provider = (overrides = {}) => ({
  finishUpstream: vi.fn(async () => ({ request: { redirectUri: 'https://claude.ai/cb', state: 's', scope: ['ema:registry'] }, headers: new Headers({ 'set-cookie': '__Host-oauth-upstream-x=; Max-Age=0' }) })),
  completeAuthorization: vi.fn(async () => ({ redirectTo: 'https://claude.ai/cb?code=mcp-code&state=s' })),
  ...overrides,
});
const post = (body, headers = {}) => new Request('https://ema-mcp.myscguard.app/ema/session', {
  method: 'POST', headers: { origin: WEB, 'content-type': 'application/json', cookie: '__Host-oauth-upstream-x=hash', ...headers }, body: JSON.stringify(body),
});
const emaFetch = (result, status = 200) => vi.fn(async () => Response.json(status === 200 ? { result } : { error: result }, { status }));

describe('EMA session handoff', () => {
  const body = { state: 'state-123', idToken: 'id', refreshToken: 'refresh' };

  it('completes the grant with the member session and answers with the AI app redirect', async () => {
    const oauth = provider();
    const fetchImpl = emaFetch({ uid: 'u1', email: 'a@mysc.co.kr', role: 'admin', canExportAndImport: true });
    const response = await handleSession(post(body), env(oauth), { fetchImpl });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ redirectTo: 'https://claude.ai/cb?code=mcp-code&state=s' });
    expect(response.headers.get('access-control-allow-origin')).toBe(WEB);
    expect(response.headers.get('access-control-allow-credentials')).toBe('true');
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(fetchImpl.mock.calls[0][0]).toBe('https://functions.example/fn/getRegistryAccess');
    expect(fetchImpl.mock.calls[0][1].headers.authorization).toBe('Bearer id');

    const finishRequest = oauth.finishUpstream.mock.calls[0][0];
    expect(new URL(finishRequest.url).searchParams.get('state')).toBe('state-123');
    expect(finishRequest.headers.get('cookie')).toContain('__Host-oauth-upstream-x=hash');
    expect(oauth.completeAuthorization).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'u1', scope: ['ema:registry'],
      props: expect.objectContaining({ uid: 'u1', role: 'admin', canExportAndImport: true, idToken: 'id', refreshToken: 'refresh' }),
    }));
  });

  it('answers the CORS preflight only for the EMA site and rejects any other origin', async () => {
    const preflight = await handleSession(new Request('https://ema-mcp.myscguard.app/ema/session', { method: 'OPTIONS', headers: { origin: WEB } }), env(provider()));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(WEB);
    const oauth = provider();
    const foreign = await handleSession(post(body, { origin: 'https://evil.example' }), env(oauth), { fetchImpl: emaFetch({}) });
    expect(foreign.status).toBe(403);
    expect(oauth.finishUpstream).not.toHaveBeenCalled();
  });

  it('refuses accounts without registry access and leaves the connection request usable', async () => {
    const oauth = provider();
    const response = await handleSession(post(body), env(oauth), {
      fetchImpl: emaFetch({ status: 'PERMISSION_DENIED', message: 'Registry에 기업을 등록할 권한이 없습니다.' }, 403),
    });
    expect(response.status).toBe(403);
    expect((await response.json()).message).toContain('권한');
    expect(oauth.finishUpstream).not.toHaveBeenCalled();
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  it('reports an expired or foreign-browser request without issuing anything', async () => {
    const oauth = provider({ finishUpstream: vi.fn(async () => { throw new Error('different browser'); }) });
    const response = await handleSession(post(body), env(oauth), { fetchImpl: emaFetch({ uid: 'u1', email: 'a', role: 'staff' }) });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain('다시 시작');
    expect(oauth.completeAuthorization).not.toHaveBeenCalled();
  });

  it('rejects malformed requests before calling EMA', async () => {
    const fetchImpl = emaFetch({});
    for (const bad of [{}, { state: 's', idToken: 'x' }, { state: '', idToken: 'x', refreshToken: 'y' }]) {
      const response = await handleSession(post(bad), env(provider()), { fetchImpl });
      expect(response.status).toBe(400);
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('EMA callable client', () => {
  it('posts the callable envelope with the member token and marks the call as coming from MCP', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ result: { ok: true } }));
    const client = createEmaClient({ functionsBase: 'https://f.example', idToken: 'tok', fetchImpl });
    expect(await client.call('exportRegistryRows', { filters: { year: 2026 } })).toEqual({ ok: true });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://f.example/exportRegistryRows');
    expect(JSON.parse(init.body)).toEqual({ data: { filters: { year: 2026 }, via: 'mcp' } });
    expect(init.headers.authorization).toBe('Bearer tok');
  });

  it('turns callable errors into readable ones and refuses odd function names', async () => {
    const denied = createEmaClient({ functionsBase: 'https://f.example', idToken: 't', fetchImpl: emaFetch({ status: 'PERMISSION_DENIED', message: '관리자만 사용할 수 있습니다.' }, 403) });
    await expect(denied.call('exportRegistryRows')).rejects.toMatchObject({ code: 'PERMISSION_DENIED', status: 403, message: '관리자만 사용할 수 있습니다.' });
    await expect(denied.call('../admin')).rejects.toThrow('ema_function_invalid');
    const silent = createEmaClient({ functionsBase: 'https://f.example', idToken: 't', fetchImpl: vi.fn(async () => new Response('oops', { status: 500 })) });
    await expect(silent.call('getRegistryAccess')).rejects.toBeInstanceOf(EmaError);
  });
});
