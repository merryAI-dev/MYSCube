import { describe, expect, it, vi } from 'vitest';
import { PlatformApiClient, PlatformApiError } from './api-client';
import { clearDevtoolsLogs, getDevtoolsLogs } from './devtools-transaction-log';

describe('PlatformApiClient', () => {
  it('injects standard headers and parses json body', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('x-tenant-id')).toBe('mysc');
      expect(headers.get('x-actor-id')).toBe('u001');
      expect(headers.get('x-actor-role')).toBe('admin');
      expect(headers.get('authorization')).toBe('Bearer id-token-1');
      expect(headers.get('idempotency-key')).toMatch(/^idem_POST_u001_/);
      expect(headers.get('content-type')).toBe('application/json');

      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-server',
        },
      });
    });

    const client = new PlatformApiClient({ baseUrl: 'https://api.example.com', fetchImpl });
    const response = await client.post<{ ok: boolean }>('/api/v1/projects', {
      tenantId: 'mysc',
      actor: { id: 'u001', role: 'admin', idToken: 'id-token-1' },
      body: { name: 'test' },
      requestId: 'req-client',
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.requestId).toBe('req-server');
    expect(response.data.ok).toBe(true);
  });

  it('does not add idempotency for GET', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('idempotency-key')).toBeNull();

      return new Response('ok', {
        status: 200,
        headers: {
          'content-type': 'text/plain',
        },
      });
    });

    const client = new PlatformApiClient({ fetchImpl });
    const response = await client.get<string>('/api/v1/health', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    });

    expect(response.data).toBe('ok');
  });

  it('coalesces identical concurrent GET requests and fetches again after completion', async () => {
    let resolveFirst: ((response: Response) => void) | undefined;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const client = new PlatformApiClient({ fetchImpl });
    const options = { tenantId: 'mysc', actor: { id: 'u001' } };

    const first = client.get<{ ok: boolean }>('/api/v1/cashflow/p001/activity', options);
    const duplicate = client.get<{ ok: boolean }>('/api/v1/cashflow/p001/activity', options);
    expect(fetchImpl).toHaveBeenCalledOnce();
    resolveFirst?.(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(Promise.all([first, duplicate])).resolves.toHaveLength(2);

    await client.get('/api/v1/cashflow/p001/activity', options);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('throws PlatformApiError on non-2xx responses', async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(JSON.stringify({ code: 'forbidden', message: 'Access denied' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-denied',
        },
      });
    });

    const client = new PlatformApiClient({ fetchImpl });

    await expect(
      client.get('/api/v1/secure', {
        tenantId: 'mysc',
        actor: { id: 'u001' },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PlatformApiError>>({
        name: 'PlatformApiError',
        status: 403,
        requestId: 'req-denied',
        code: 'forbidden',
        serverMessage: 'Access denied',
        message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
        body: { code: 'forbidden', message: 'Access denied' },
      }),
    );
  });

  it('reads a safe BFF error identifier from its established error field', async () => {
    const client = new PlatformApiClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({
        error: 'cashflow_month_close_reconciliation_pending',
        message: '월 결산 저장 결과를 확정할 수 없습니다.',
      }), {
        status: 503,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.get('/api/v1/secure', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    })).rejects.toMatchObject({ code: 'cashflow_month_close_reconciliation_pending' });
  });

  it('keeps empty gateway responses safe and preserves the default message', async () => {
    const client = new PlatformApiClient({
      fetchImpl: vi.fn(async () => new Response('<html>bad gateway</html>', {
        status: 502,
        headers: { 'content-type': 'text/html' },
      })),
    });

    await expect(client.get('/api/v1/secure', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    })).rejects.toMatchObject({
      code: '',
      serverMessage: '',
      message: '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
    });
  });

  it('does not preserve non-string server messages', async () => {
    const client = new PlatformApiClient({
      fetchImpl: vi.fn(async () => new Response(JSON.stringify({ code: 500, message: { nested: true } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      })),
    });

    await expect(client.get('/api/v1/secure', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    })).rejects.toMatchObject({ code: '', serverMessage: '' });
  });

  it('preserves long server codes so the UI can limit them to 64 characters', () => {
    const error = new PlatformApiError('failed', 400, 'request-id', { code: 'x'.repeat(100_000) });
    expect(error.code).toHaveLength(100_000);
    expect(error.code.slice(0, 64)).toHaveLength(64);
  });

  it('retries transient failures and eventually succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('network down'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));

    const client = new PlatformApiClient({
      fetchImpl,
      maxRetries: 1,
      retryDelayMs: 0,
    });

    const response = await client.get<{ ok: boolean }>('/api/v1/health', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(response.data.ok).toBe(true);
  });

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('bad request', {
      status: 400,
      headers: { 'content-type': 'text/plain' },
    }));

    const client = new PlatformApiClient({
      fetchImpl,
      maxRetries: 3,
      retryDelayMs: 0,
    });

    await expect(
      client.get('/api/v1/health', {
        tenantId: 'mysc',
        actor: { id: 'u001' },
      }),
    ).rejects.toBeInstanceOf(PlatformApiError);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns null for empty 204 responses', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, {
      status: 204,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PlatformApiClient({ fetchImpl });

    const response = await client.get<null>('/api/v1/health', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    });

    expect(response.data).toBeNull();
  });

  it('falls back to text when json parsing fails', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('not-json', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new PlatformApiClient({ fetchImpl });

    const response = await client.get<string>('/api/v1/health', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    });

    expect(response.data).toBe('not-json');
  });

  it('binds the global fetch implementation when no custom fetch is provided', async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(async function (this: typeof globalThis, _input: RequestInfo | URL, _init?: RequestInit) {
      expect(this).toBe(globalThis);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    // Simulate browsers that require window/global binding for fetch.
    globalThis.fetch = fetchSpy as typeof fetch;

    try {
      const client = new PlatformApiClient();
      const response = await client.get<{ ok: boolean }>('/api/v1/health', {
        tenantId: 'mysc',
        actor: { id: 'u001' },
      });
      expect(response.data.ok).toBe(true);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('records BFF request lifecycle logs without leaking auth tokens', async () => {
    clearDevtoolsLogs();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-request-id': 'req-server',
      },
    }));
    const client = new PlatformApiClient({ baseUrl: 'https://api.example.com', fetchImpl });

    await client.post<{ ok: boolean }>('/api/v1/projects/p001/cashflow-weeks/upsert', {
      tenantId: 'mysc',
      actor: { id: 'u001', role: 'admin', idToken: 'id-token-1' },
      body: { yearMonth: '2026-06', weekNo: 2, mode: 'projection' },
      requestId: 'req-client',
    });

    const logs = getDevtoolsLogs();
    expect(logs).toEqual([
      expect.objectContaining({
        kind: 'bff_request',
        phase: 'start',
        operation: '/api/v1/projects/p001/cashflow-weeks/upsert',
        method: 'POST',
        requestId: 'req-client',
        tenantId: 'mysc',
        actorId: 'u001',
      }),
      expect.objectContaining({
        kind: 'bff_request',
        phase: 'success',
        operation: '/api/v1/projects/p001/cashflow-weeks/upsert',
        responseRequestId: 'req-server',
        status: 200,
      }),
    ]);
    expect(JSON.stringify(logs)).not.toContain('id-token-1');
  });

  it('does not write raw authorization diagnostics to console or transaction logs', async () => {
    clearDevtoolsLogs();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      code: 'missing_bearer_token',
      message: 'person@mysc.co.kr expectedDepositAmount=9999 raw cell=B12:C12',
    }), {
      status: 401,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-denied' },
    }));
    const client = new PlatformApiClient({ fetchImpl });

    try {
      await expect(client.get('/api/v1/secure', {
        tenantId: 'mysc',
        actor: { id: 'u001', email: 'person@mysc.co.kr' },
      })).rejects.toBeInstanceOf(PlatformApiError);

      const serialized = JSON.stringify(getDevtoolsLogs());
      expect(warnSpy).not.toHaveBeenCalled();
      expect(serialized).not.toContain('person@mysc.co.kr');
      expect(serialized).not.toContain('expectedDepositAmount=9999');
      expect(serialized).not.toContain('B12:C12');
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('never copies an unsafe body.error into the response-code transaction summary', async () => {
    clearDevtoolsLogs();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      error: 'sk_live_1234567890',
      message: 'raw financial payload 2300000',
    }), {
      status: 400,
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-secret' },
    }));
    const client = new PlatformApiClient({ fetchImpl });

    await expect(client.get('/api/v1/secure', {
      tenantId: 'mysc',
      actor: { id: 'u001' },
    })).rejects.toBeInstanceOf(PlatformApiError);

    const serialized = JSON.stringify(getDevtoolsLogs());
    expect(serialized).not.toContain('sk_live_supersecret');
    expect(serialized).not.toContain('2300000');
  });
});
