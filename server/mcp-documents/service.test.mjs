import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDocumentService } from './service.mjs';
import { makePdf } from '../bff/test-pdf.fixture.mjs';

const servers = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }))); });
async function start(options) {
  const server = createServer(createDocumentService(options));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
const path = '/api/v1/project-requests/change-p1/attachments/contract/text';
const auth = { authorization: 'Bearer user.token' };

describe('isolated document renderer', () => {
  it('proves native rendering in readiness without fetching private documents', async () => {
    const upstream = vi.fn();
    const origin = await start({ fetchImpl: upstream, release: 'test-sha' });
    expect(await (await fetch(`${origin}/healthz`)).json()).toEqual({ service: 'myscube-mcp-documents', release: 'test-sha', renderer: 'ready' });
    expect(upstream).not.toHaveBeenCalled();
  });

  it('renders real PDF bytes only after existing BFF authorization on every page', async () => {
    const upstream = vi.fn().mockImplementation(async () => new Response(makePdf(['page one', 'page two']), { headers: { 'content-type': 'application/pdf' } }));
    const origin = await start({ fetchImpl: upstream });
    const first = await fetch(`${origin}${path}?format=image&page=1`, { headers: auth });
    const body = await first.json();
    expect(body).toMatchObject({ kind: 'contract', page: 1, pageCount: 2, mimeType: 'image/jpeg' });
    expect(Buffer.from(body.data, 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    await fetch(`${origin}${path}?format=image&page=2`, { headers: auth });
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(String(upstream.mock.calls[0][0])).toBe('https://myscube.myscguard.app/api/v1/project-requests/change-p1/attachments/contract');
    expect(upstream.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error', headers: auth });
  });

  it.each([401, 403, 404, 409, 429, 500])('preserves denial %s without running PDF code', async (status) => {
    const build = vi.fn();
    const origin = await start({ fetchImpl: async () => new Response('private error details', { status }), build });
    const response = await fetch(`${origin}${path}?format=image&page=1`, { headers: auth });
    expect(response.status).toBe(status === 500 ? 502 : status);
    expect(await response.text()).not.toContain('private error details');
    expect(build).not.toHaveBeenCalled();
  });

  it('rechecks revoked access instead of serving a prior render', async () => {
    const upstream = vi.fn().mockResolvedValueOnce(new Response(makePdf(['one']))).mockResolvedValueOnce(new Response('', { status: 403 }));
    const origin = await start({ fetchImpl: upstream });
    expect((await fetch(`${origin}${path}?format=image&page=1`, { headers: auth })).status).toBe(200);
    expect((await fetch(`${origin}${path}?format=image&page=1`, { headers: auth })).status).toBe(403);
  });

  it.each([
    [path, {}, 401],
    ['/api/v1/projects', { headers: auth }, 404],
    ['/api/v1/cashflow/p1', { headers: auth }, 404],
    [`${path}?format=image&page=0`, { headers: auth }, 400],
    [`${path}?format=image&page=301`, { headers: auth }, 400],
    ['/api/render?__path=https://example.com', { headers: auth }, 404],
    [path, { method: 'POST', headers: auth }, 405],
  ])('rejects invalid input without upstream: %s', async (route, options, status) => {
    const upstream = vi.fn();
    const origin = await start({ fetchImpl: upstream });
    expect((await fetch(`${origin}${route}`, options)).status).toBe(status);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('supports Vercel rewrite and RFP documents using the authorized download route', async () => {
    const upstream = vi.fn(async () => new Response(makePdf(['RFP'])));
    const origin = await start({ fetchImpl: upstream });
    const route = path.replace('contract', 'rfp_request_evidence');
    const response = await fetch(`${origin}/api/render?__path=${encodeURIComponent(route)}&format=image&page=1`, { headers: auth });
    expect((await response.json()).kind).toBe('rfp_request_evidence');
    expect(String(upstream.mock.calls[0][0])).toContain('/attachments/rfp_request_evidence');
  });

  it.each([true, false])('caps declared and streaming source size (declared=%s)', async (declared) => {
    const build = vi.fn();
    const upstream = async () => new Response(new Uint8Array(31 * 1024 * 1024), { headers: declared ? { 'content-length': String(31 * 1024 * 1024) } : {} });
    const origin = await start({ fetchImpl: upstream, build });
    expect((await fetch(`${origin}${path}`, { headers: auth })).status).toBe(413);
    expect(build).not.toHaveBeenCalled();
  });

  it('fails readiness when native rendering fails', async () => {
    const origin = await start({ render: async () => { throw new Error('native dependency missing'); } });
    expect((await fetch(`${origin}/healthz`)).status).toBe(503);
  });
});
