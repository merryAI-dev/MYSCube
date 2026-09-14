import { afterEach, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
vi.mock('node:fs', async (original) => ({ ...await original(), writeFileSync: vi.fn() }));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules(); });

it('backs up before patching only the reviewed rule and rejects drift', async () => {
  for (const [key, value] of Object.entries({ GITHUB_REF: 'refs/heads/main', CLOUDFLARE_API_KEY: 'fixture', CLOUDFLARE_EMAIL: 'fixture', CLOUDFLARE_ZONE_ID: 'a'.repeat(32) })) vi.stubEnv(key, value);
  const line = readFileSync('infra/cloudflare/main.tf', 'utf8').split('\n').find((value) => value.includes('expression  =') && value.includes('http.user_agent eq'));
  const expected = JSON.parse(line.slice(line.indexOf('=') + 1).trim());
  const rule = { id: 'a4602e5dfc844cca8bf77c6627d50332', ref: 'mysc_explicit_automation_client_block', action: 'block', enabled: true, expression: expected.split(' and not ')[0] };
  const other = { id: 'other', expression: 'true', action: 'block' };
  const { writeFileSync } = await import('node:fs');
  const fetchMock = vi.fn(async (url, options) => {
    if (options.method === 'PATCH') {
      expect(writeFileSync).toHaveBeenCalled();
      expect(url).toContain(`/rules/${rule.id}`);
      expect(JSON.parse(options.body).expression).toBe(expected);
      Object.assign(rule, JSON.parse(options.body));
    }
    return Response.json({ success: true, result: { id: 'cd3d15e4086648069f6bc73060cb8a62', rules: [rule, other] } });
  });
  vi.stubGlobal('fetch', fetchMock);
  await import('../../scripts/configure-slack-edge.mjs');
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
  vi.resetModules();
  rule.expression = 'true';
  await expect(import('../../scripts/configure-slack-edge.mjs')).rejects.toThrow('changed since review');
  expect(fetchMock.mock.calls.filter(([, options]) => options.method === 'PATCH')).toHaveLength(1);
});
