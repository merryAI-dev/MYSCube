import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import https from 'node:https';
import { createExternalApiAdapter, isPublicExternalAddress, requestPinnedExternalJson } from './external-api.mjs';

const parameters = { month: { type: 'string', required: true, label: '조회 월', example: '2026-09' } };
const endpoint = { id: 'receipts', version: 1, name: '입금 확인', description: '승인된 외부 입금 내역', url: 'https://approved.example/receipts', allowedTenants: ['qa'], parameters,
  responseSchema: { type: 'object', additionalProperties: false, required: ['amount'], properties: { amount: { type: 'string', maxLength: 40, nullable: true } } },
  auth: { type: 'bearer', secretEnv: 'WORKBENCH_EXTERNAL_SECRET_RECEIPTS' } };
const context = { tenantId: 'qa', actorId: 'admin' };
const make = (options = {}, definition = endpoint) => {
  const transport = vi.fn(async () => ({ amount: '0' })); const authorize = vi.fn(async () => {});
  const env = { WORKBENCH_EXTERNAL_ENDPOINTS: JSON.stringify([definition]), WORKBENCH_EXTERNAL_SECRET_RECEIPTS: 'server-secret' };
  return { env, transport, authorize, adapter: createExternalApiAdapter({ env, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }], transport, ...options }) };
};
describe('external read API contract', () => {
  it('rejects private, link-local, mapped IPv6, documentation and special addresses', () => {
    for (const address of ['127.0.0.1', '10.1.2.3', '172.16.1.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '198.18.0.1', '192.0.2.1', '203.0.113.1', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1', '2002:7f00:1::', '3fff::1']) expect(isPublicExternalAddress(address), address).toBe(false);
    expect(isPublicExternalAddress('8.8.8.8')).toBe(true); expect(isPublicExternalAddress('2606:4700:4700::1111')).toBe(true);
  });
  it('returns sanitized endpoint metadata and rejects unapproved tenants', () => {
    const { adapter } = make(); const listed = adapter.list(context);
    expect(listed.items[0]).toMatchObject({ id: 'receipts', responseSchema: endpoint.responseSchema });
    expect(JSON.stringify(listed)).not.toContain('approved.example'); expect(JSON.stringify(listed)).not.toContain('secretEnv');
    expect(adapter.list({ tenantId: 'other' }).items).toEqual([]);
    expect(() => adapter.get({ tenantId: 'other' }, 'receipts', 1)).toThrow();
  });
  it('pins a validated DNS address, passes only declared query inputs, and keeps auth server-side', async () => {
    const { adapter, transport, authorize } = make();
    expect(await adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize })).toMatchObject({ data: { amount: '0' }, metadata: { endpointId: 'receipts', endpointVersion: 1 } });
    expect(transport.mock.calls[0][0]).toMatchObject({ address: '8.8.8.8', family: 4, headers: { Authorization: 'Bearer server-secret' } });
    expect(transport.mock.calls[0][0].url.href).toBe('https://approved.example/receipts?month=2026-09');
    expect(authorize).toHaveBeenCalledTimes(3);
    await expect(adapter.invoke(context, 'receipts', 1, { month: '2026-09', url: 'http://localhost' }, { authorize })).rejects.toMatchObject({ code: 'external_input_invalid' });
  });
  it('blocks every DNS answer if any is private and never contacts the transport', async () => {
    const transport = vi.fn(); const { adapter, authorize } = make({ transport, resolveDns: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] });
    await expect(adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize })).rejects.toMatchObject({ code: 'external_address_forbidden' });
    expect(transport).not.toHaveBeenCalled();
  });
  it('rejects query credentials, other-service secrets, unsafe URL forms and nondeclared response fields', async () => {
    for (const change of [{ url: 'http://approved.example/' }, { url: 'https://u:p@approved.example/' }, { url: 'https://approved.example/?key=x' }, { url: 'https://approved.example:8443/' }, { auth: { type: 'bearer', secretEnv: 'SETTLEMENT_AGENT_GEMINI_API_KEY' } }, { parameters: { apiKey: parameters.month } }]) {
      expect(() => make({}, { ...endpoint, ...change }).adapter.list(context)).toThrow();
    }
    const { adapter, authorize } = make({ transport: async () => ({ amount: '0', unexpectedPersonalData: 'hidden' }) });
    await expect(adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize })).rejects.toMatchObject({ code: 'external_response_invalid' });
  });
  it('preserves missing and zero values and rejects unsafe integer financial values', async () => {
    const missing = make({ transport: async () => ({ amount: null }) });
    expect((await missing.adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize: missing.authorize })).data.amount).toBeNull();
    const unsafe = make({ transport: async () => ({ amount: Number.MAX_SAFE_INTEGER + 1 }) }, { ...endpoint, responseSchema: { ...endpoint.responseSchema, properties: { amount: { type: 'integer' } } } });
    await expect(unsafe.adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize: unsafe.authorize })).rejects.toMatchObject({ code: 'external_response_invalid' });
  });
  it('rechecks authorization and exact endpoint version after the response before exposing data', async () => {
    let calls = 0; const { adapter } = make();
    await expect(adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize: async () => { if (++calls === 3) throw Object.assign(new Error('revoked'), { statusCode: 403 }); } })).rejects.toMatchObject({ statusCode: 403 });
    const setup = make({ transport: async () => { setup.env.WORKBENCH_EXTERNAL_ENDPOINTS = JSON.stringify([{ ...endpoint, description: 'changed' }]); return { amount: '1' }; } });
    await expect(setup.adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize: setup.authorize })).rejects.toMatchObject({ code: 'external_definition_changed' });
  });
  it('bounds a stalled DNS lookup by the caller deadline', async () => {
    const { adapter, authorize, transport } = make({ resolveDns: () => new Promise(() => {}) });
    await expect(adapter.invoke(context, 'receipts', 1, { month: '2026-09' }, { authorize, signal: AbortSignal.timeout(25) })).rejects.toMatchObject({ code: 'external_timeout' });
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('actual pinned HTTPS transport on a local fixture only', () => {
  let folder, server, certificate, port; const calls = [];
  beforeAll(async () => {
    folder = await mkdtemp(join(tmpdir(), 'axr-external-tls-'));
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=external-fixture.test', '-addext', 'subjectAltName=DNS:external-fixture.test', '-keyout', join(folder, 'key.pem'), '-out', join(folder, 'cert.pem')], { stdio: 'ignore' });
    certificate = await readFile(join(folder, 'cert.pem')); const key = await readFile(join(folder, 'key.pem'));
    server = https.createServer({ key, cert: certificate }, (req, res) => {
      calls.push({ url: req.url, method: req.method, host: req.headers.host });
      if (req.url === '/redirect') { res.writeHead(302, { Location: 'http://169.254.169.254/latest' }); res.end(); return; }
      if (req.url === '/large') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: 'x'.repeat(10000) })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"amount":"0"}');
    }).listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); port = server.address().port;
  });
  afterAll(async () => { if (server) await new Promise(resolve => server.close(resolve)); if (folder) await rm(folder, { recursive: true, force: true }); });
  const call = (path, maxBytes = 256000) => requestPinnedExternalJson({ url: new URL(`https://external-fixture.test:${port}${path}`), address: '127.0.0.1', family: 4, headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2000), maxBytes,
    requestImpl: (url, options, callback) => https.request(url, { ...options, ca: certificate }, callback) });
  it('connects to the supplied pinned IP while TLS validates the configured hostname', async () => {
    expect(await call('/read')).toEqual({ amount: '0' });
    expect(calls.at(-1)).toMatchObject({ url: '/read', method: 'GET', host: `external-fixture.test:${port}` });
  });
  it('does not follow redirects and stops an oversized streamed response', async () => {
    const count = calls.length;
    await expect(call('/redirect')).rejects.toMatchObject({ code: 'external_redirect_forbidden' });
    expect(calls.length).toBe(count + 1);
    await expect(call('/large', 100)).rejects.toMatchObject({ code: 'external_response_large' });
  });
});
