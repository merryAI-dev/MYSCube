import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => {
  const init = vi.fn();
  const setUser = vi.fn();
  const setTag = vi.fn();
  const captureException = vi.fn(() => 'evt_1');
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
