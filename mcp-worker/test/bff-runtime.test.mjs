import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

describe('BFF transport in the actual Worker runtime', () => {
  it('fetches without following redirects or forwarding credentials to another origin', async () => {
    const bundle = await build({
      stdin: {
        contents: `import { createBffClient } from './bff.mjs';
export default { async fetch(request) {
  const client = createBffClient({ baseUrl: 'https://upstream.example', idToken: 'test-only' });
  try { return Response.json(await client.get(new URL(request.url).pathname)); }
  catch (error) { return Response.json({ code: error.code, status: error.status }, { status: 502 }); }
} };`,
        resolveDir: fileURLToPath(new URL('../src', import.meta.url)),
      },
      bundle: true, format: 'esm', platform: 'browser', write: false,
    });
    const runtime = new Miniflare(convertV4MiniflareOptions({ workers: [
      { name: 'client', compatibilityDate: '2026-09-01', modules: true, script: bundle.outputFiles[0].text, outboundService: 'upstream' },
      { name: 'upstream', compatibilityDate: '2026-09-01', modules: true, script: `export default { fetch(request) {
  if (new URL(request.url).hostname !== 'upstream.example') return Response.json({ leaked: true });
  if (new URL(request.url).pathname.endsWith('/redirect')) return Response.redirect('https://other.example/api/v1/private', 302);
  return Response.json({ ok: request.headers.get('authorization') === 'Bearer test-only' });
} };` },
    ] }));
    try {
      expect(await (await runtime.dispatchFetch('http://localhost/api/v1/ok')).json()).toEqual({ ok: true });
      expect(await (await runtime.dispatchFetch('http://localhost/api/v1/redirect')).json()).toEqual({ code: 'redirect_rejected', status: 502 });
    } finally { await runtime.dispose(); }
  }, 20_000);
});
