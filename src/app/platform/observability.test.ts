import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => {
  const init = vi.fn();
  const setUser = vi.fn();
  const setTag = vi.fn();
  const captureException = vi.fn((_error?: unknown) => 'evt_1');
  const captureMessage = vi.fn(() => 'msg_1');
  const withScope = vi.fn((callback: (scope: any) => unknown) => callback({
    setTag: vi.fn(),
    setExtra: vi.fn(),
    setUser: vi.fn(),
    setLevel: vi.fn(),
    setFingerprint: vi.fn(),
  }));
  return {
    init,
    setUser,
    setTag,
    captureException,
    captureMessage,
    withScope,
  };
});

vi.mock('@sentry/react', () => sentryMocks);

describe('observability', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete (globalThis as any).__MYSC_OBSERVABILITY__;
    (globalThis as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
    }));
    (globalThis as any).localStorage = {
      getItem: vi.fn((key: string) => (key === 'MYSC_ACTIVE_TENANT' ? 'mysc' : null)),
    };
    (globalThis as any).window = {
      location: {
        pathname: '/portal/weekly-expenses',
        search: '?tab=default',
        hash: '',
        href: 'https://inner-platform.vercel.app/portal/weekly-expenses?tab=default',
        origin: 'https://inner-platform.vercel.app',
        hostname: 'inner-platform.vercel.app',
      },
      addEventListener: vi.fn(),
    };
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
    delete (globalThis as any).localStorage;
    delete (globalThis as any).window;
    delete (globalThis as any).__MYSC_OBSERVABILITY__;
    vi.unstubAllEnvs();
  });

  it('does not initialize sentry without DSN', async () => {
    const mod = await import('./observability');
    mod.initObservability({});

    expect(sentryMocks.init).not.toHaveBeenCalled();
  });

  it.each([
    ['/portal/private@example.com/private-file.pdf?token=x', '/portal/*'],
    ['/portal/register-project/private-draft', '/portal/register-project'],
    ['/portal/edit-project/private-project', '/portal/edit-project'],
    ['/portal/project-approvals/private-request', '/portal/project-approvals'],
    ['/portal/project-settings/private-project', '/portal/project-settings'],
    ['/admin/private@example.com/private-file.pdf', '/*'],
  ])('reduces platform API screen route %s to a static screen name', async (route, expected) => {
    window.location.pathname = route;
    window.location.href = `https://app.invalid${route}`;
    const mod = await import('./observability');
    mod.captureException(new Error('failure'), { tags: { surface: 'platform_api' } });
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.route).toBe(expected);
    expect(payload.href).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/private-|private@example/);
  });

  it('preserves generic API resource-family, method, status and retry counts without path identifiers', async () => {
    const { PlatformApiClient } = await import('./api-client');
    const client = new PlatformApiClient({ maxRetries: 1, retryDelayMs: 0, fetchImpl: vi.fn(async () => new Response(JSON.stringify({ error: 'internal_error' }), { status: 503, headers: { 'content-type': 'application/json' } })) });
    await client.get('/api/v1/transactions/private-user/private-file.pdf?token=private-token#private-hash', {
      tenantId: 'mysc', actor: { id: 'u001' },
    }).catch(() => {});
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.tags.method).toBe('GET');
    expect(payload.extra).toMatchObject({ endpoint: '/api/v1/transactions/*', status: 503, attempt: 1, maxRetries: 1 });
    expect(JSON.stringify(payload)).not.toContain('private-');
  });

  it('strips automatic Sentry request, breadcrumbs, and user PII at the final platform API event boundary', async () => {
    const mod = await import('./observability');
    mod.initObservability({ VITE_SENTRY_DSN: 'https://example@sentry.invalid/1' });
    const beforeSend = sentryMocks.init.mock.calls[0][0].beforeSend;
    const event = {
      tags: { surface: 'platform_api', method: 'PATCH', privateName: 'private-tag' }, extra: { errorCode: 'draft_version_conflict', endpoint: '/api/v1/project-info-drafts/*', status: 409, attempt: 0, maxRetries: 2, body: 'private-body', leaseId: 'secret-lease' },
      message: 'private-message',
      request: { url: 'https://app.invalid/path?token=secret-query#secret-hash', headers: { authorization: 'secret-token' } },
      breadcrumbs: [{ message: 'private-file.pdf', data: { url: 'https://storage.invalid?token=secret-token' } }],
      user: { id: 'u001', email: 'private@example.com', ip_address: '{{auto}}' },
      contexts: { response: { body: 'private-name' }, browser: { name: 'Chrome' } },
    };
    const safe = beforeSend(event, {});
    expect(safe.extra.errorCode).toBe('draft_version_conflict');
    expect(safe.extra).toMatchObject({ endpoint: '/api/v1/project-info-drafts/*', status: 409, attempt: 0, maxRetries: 2 });
    expect(safe.tags.method).toBe('PATCH');
    expect(safe.user).toEqual({ id: 'u001' });
    expect(safe.request).toBeUndefined();
    expect(safe.breadcrumbs).toBeUndefined();
    expect(safe.contexts).toBeUndefined();
    expect(JSON.stringify(safe)).not.toMatch(/private-|secret-|ip_address/);
    const ordinary = { ...event, tags: { surface: 'other' } };
    expect(beforeSend(ordinary, {})).toBe(ordinary);
  });

  it('enforces the platform API extra allowlist even for direct capture callers', async () => {
    const mod = await import('./observability');
    mod.captureException(new Error('private-message'), {
      tags: { surface: 'platform_api', fileName: 'private-file.pdf' },
      extra: { requestId: 'safe-request', errorCode: 'forbidden', body: { password: 'private-password' }, fileName: 'private-file.pdf', sessionId: 'private-session', leaseId: 'private-lease', idempotencyKey: 'private-key' },
    });
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.extra).toMatchObject({ requestId: 'safe-request', errorCode: 'forbidden' });
    expect(JSON.stringify(payload)).not.toContain('private-');
  });

  it.each([99, 600, '503', Number.NaN])('drops invalid HTTP status %s and invalid retry/method diagnostics', async (status) => {
    const mod = await import('./observability');
    mod.captureException(new Error('failure'), {
      tags: { surface: 'platform_api', method: 'private-method' },
      extra: { status, attempt: -1, maxRetries: '3', endpoint: '/api/v1/users/private-user/private-file.pdf' },
    });
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.tags.method).toBeUndefined();
    for (const key of ['status', 'attempt', 'maxRetries', 'endpoint']) expect(payload.extra?.[key]).toBeUndefined();
  });

  it('captures project API failures once with safe correlation and no private response data', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'release-ssot-001');
    const mod = await import('./observability');
    const { PlatformApiClient } = await import('./api-client');
    const { clearDevtoolsLogs, getDevtoolsLogs } = await import('./devtools-transaction-log');
    clearDevtoolsLogs();
    mod.initObservability({ VITE_SENTRY_DSN: 'https://example@sentry.invalid/1' });
    mod.setObservabilityUserContext({ id: 'u001', role: 'pm', tenantId: 'mysc', email: 'private@example.com' });
    window.location.search = '?token=secret-query';
    window.location.hash = '#secret-hash';
    window.location.href = 'https://inner-platform.vercel.app/portal/project-settings?token=secret-query#secret-hash';
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'draft_version_conflict', message: 'private-file.pdf private@example.com',
      details: { expectedDraftRevision: 2, actualDraftRevision: 3, conflictReason: 'revision_changed', leaseId: 'secret-lease', sourceFingerprint: 'secret-fingerprint' },
    }), { status: 409, headers: { 'content-type': 'application/json', 'x-request-id': 'server-req' } }));
    const client = new PlatformApiClient({ fetchImpl, maxRetries: 3 });
    const failure = await client.patch('/api/v1/project-info-drafts/p001?token=secret-query#secret-hash', {
      tenantId: 'mysc', actor: { id: 'u001', role: 'pm' }, requestId: 'client-req', idempotencyKey: 'secret-key',
      body: { expectedDraftRevision: 2, payload: { name: 'private-name' }, sessionId: 'secret-session' },
    }).catch((error) => error);
    mod.captureException(failure);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(globalThis.fetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.extra).toMatchObject({ errorCode: 'draft_version_conflict', operation: 'project_info_draft_save', projectId: 'p001', actorRole: 'pm', release: 'release-ssot-001', expectedDraftRevision: 2, actualDraftRevision: 3, conflictReason: 'revision_changed', requestId: 'client-req', responseRequestId: 'server-req' });
    expect(payload.clientRequestId).toBe('client-req');
    expect(sentryMocks.captureException).toHaveBeenCalledOnce();
    const captured = sentryMocks.captureException.mock.calls[0][0] as unknown as Error & { body?: unknown };
    expect(captured).not.toBe(failure);
    expect(captured.body).toBeUndefined();
    const serialized = JSON.stringify(payload) + JSON.stringify(captured) + JSON.stringify(getDevtoolsLogs());
    for (const secret of ['private-file.pdf', 'private@example.com', 'secret-query', 'secret-hash', 'secret-lease', 'secret-fingerprint', 'secret-key', 'private-name', 'secret-session']) expect(serialized).not.toContain(secret);
  });

  it('drops malformed diagnostic IDs, codes, revisions and release values without copying payloads', async () => {
    vi.stubEnv('VITE_SENTRY_RELEASE', 'private@example.com');
    const { PlatformApiClient } = await import('./api-client');
    const client = new PlatformApiClient({ fetchImpl: vi.fn(async () => new Response(JSON.stringify({
      code: 'private@example.com', message: 'private-file.pdf',
      details: { actualDraftRevision: '3', actualVersion: -1, conflictReason: 'private_reason', projectId: 'not-authoritative' },
    }), { status: 409, headers: { 'content-type': 'application/json', 'x-request-id': 'private@example.com' } })) });
    await client.post('/api/v1/project-registration-drafts/private%40example.com/submit?file=private-file.pdf', {
      tenantId: 'mysc', actor: { id: 'u001', role: 'private@example.com' }, requestId: 'request-safe',
      body: { expectedDraftRevision: '1', expectedVersion: Infinity, projectRequestId: 'private@example.com', privatePayload: 'secret-data' },
    }).catch(() => {});
    const payload = JSON.parse(String((globalThis.fetch as any).mock.calls[0][1].body));
    expect(payload.extra).toMatchObject({ operation: 'project_registration_draft_submit', requestId: 'request-safe' });
    for (const field of ['errorCode', 'draftId', 'projectId', 'projectRequestId', 'release', 'actorRole', 'actualDraftRevision', 'expectedDraftRevision', 'actualVersion', 'expectedVersion', 'conflictReason', 'responseRequestId']) expect(payload.extra[field]).toBeUndefined();
    expect(JSON.stringify(payload)).not.toMatch(/private(?:@|%40)example|private-file|secret-data|not-authoritative/);
  });

  it('captures the same error only once and propagates user context', async () => {
    const mod = await import('./observability');
    mod.initObservability({
      VITE_SENTRY_DSN: 'https://example@sentry.invalid/1',
      MODE: 'production',
    });
    mod.setObservabilityUserContext({
      id: 'u-1',
      email: 'user@example.com',
      role: 'pm',
      tenantId: 'mysc',
    });

    const error = new Error('boom');
    mod.captureException(error, {
      tags: {
        surface: 'test',
      },
    });
    mod.captureException(error, {
      tags: {
        surface: 'test',
      },
    });

    expect(sentryMocks.init).toHaveBeenCalledTimes(1);
    expect(sentryMocks.setUser).toHaveBeenCalledWith({
      id: 'u-1',
      email: 'user@example.com',
      tenantId: 'mysc',
      role: 'pm',
    });
    expect(sentryMocks.captureException).toHaveBeenCalledTimes(1);
  });

  it('posts captured exceptions to the internal observability endpoint', async () => {
    const mod = await import('./observability');
    mod.setObservabilityUserContext({
      id: 'u-1',
      email: 'user@example.com',
      role: 'pm',
      tenantId: 'mysc',
      idToken: 'firebase-id-token',
    });

    mod.captureException(new Error('internal boom'), {
      tags: {
        surface: 'portal_store',
        action: 'projects_listen',
      },
      extra: {
        requestId: 'req_123',
      },
    });
    await Promise.resolve();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://inner-platform.vercel.app/api/v1/client-errors');
    expect(init.method).toBe('POST');

    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer firebase-id-token');
    expect(headers.get('x-tenant-id')).toBe('mysc');
    expect(headers.get('x-actor-id')).toBe('u-1');
    expect(headers.get('idempotency-key')).toMatch(/^idem_POST_u-1_/);

    const body = JSON.parse(String(init.body));
    expect(body.eventType).toBe('exception');
    expect(body.message).toBe('internal boom');
    expect(body.source).toBe('portal_store');
    expect(body.clientRequestId).toBe('req_123');
    expect(body.route).toBe('/portal/weekly-expenses?tab=default');
    expect(body.href).toBe('https://inner-platform.vercel.app/portal/weekly-expenses?tab=default');
  });

  it('keeps hosted client errors on the BFF when env points at the Java API', async () => {
    vi.stubEnv('VITE_PLATFORM_API_BASE_URL', 'https://innerplatform-jvm-weekly-api-c3pm5gv7ia-du.a.run.app');
    const mod = await import('./observability');

    mod.captureMessage('java url should not receive client errors', {
      tags: { surface: 'test' },
    });
    await Promise.resolve();

    const [url] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://inner-platform.vercel.app/api/v1/client-errors');
  });
});
