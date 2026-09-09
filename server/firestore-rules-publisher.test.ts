import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { prepareRules, publishRules } from '../scripts/publish-firestore-rules.mjs';

const prefix = 'projects/inner-platform-live-20260316';
const release = `${prefix}/releases/cloud.firestore`;
const source = (content: string) => ({ source: { files: [{ name: 'firebase/firestore.rules', content }] } });
function harness(content = 'old') {
  let live = `${prefix}/rulesets/old`;
  const request = vi.fn(async (method: string, path: string, body?: any) => {
    if (method === 'GET' && path === release) return { name: release, rulesetName: live };
    if (method === 'GET') return source(path.endsWith('/new') ? 'new' : content);
    if (method === 'POST') return { name: `${prefix}/rulesets/new` };
    if (method === 'PATCH') { live = body.release.rulesetName; return { name: release, rulesetName: live }; }
    throw new Error('Unexpected request');
  });
  const prepare = () => prepareRules({ request, baseline: 'old', target: 'new', baseSha: 'a'.repeat(40), targetSha: 'b'.repeat(40) });
  return { request, prepare, change: () => { live = `${prefix}/rulesets/external`; } };
}

describe('production rules publication', () => {
  it('backs up exact source and verifies publication', async () => {
    const h = harness(); const plan = await h.prepare();
    expect(plan.source).toEqual(source('old').source.files);
    expect(await publishRules({ request: h.request, plan })).toEqual({ unchanged: false, rulesetName: `${prefix}/rulesets/new` });
    expect(h.request.mock.calls.map(([method]) => method)).toEqual(['GET', 'GET', 'GET', 'GET', 'POST', 'GET', 'PATCH', 'GET', 'GET']);
  });
  it('does not mutate rules that already match', async () => {
    const h = harness('new'); const plan = await h.prepare();
    expect(await publishRules({ request: h.request, plan })).toMatchObject({ unchanged: true });
    expect(h.request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('rejects external drift before backup and after backup', async () => {
    await expect(harness('external').prepare()).rejects.toThrow('drifted');
    const h = harness(); const plan = await h.prepare(); h.change();
    await expect(publishRules({ request: h.request, plan })).rejects.toThrow('after backup');
    expect(h.request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('blocks publish on source read and permission failures', async () => {
    const h = harness(); const plan = await h.prepare();
    h.request.mockRejectedValueOnce(new Error('403'));
    await expect(publishRules({ request: h.request, plan })).rejects.toThrow('403');
    expect(h.request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
  it('does not patch when another publisher changes release during ruleset creation', async () => {
    const h = harness(); const plan = await h.prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, path, body) => {
      const result = await original(method, path, body);
      if (method === 'POST') h.change();
      return result;
    });
    await expect(publishRules({ request: h.request, plan })).rejects.toThrow('before publication');
    expect(h.request.mock.calls.some(([method]) => method === 'PATCH')).toBe(false);
  });
  it('accepts a lost PATCH response only when exact live rules verify the write', async () => {
    const h = harness(); const plan = await h.prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, path, body) => {
      const result = await original(method, path, body);
      if (method === 'PATCH') throw new Error('response lost after commit');
      return result;
    });
    await expect(publishRules({ request: h.request, plan })).resolves.toMatchObject({ unchanged: false });
  });
  it('fails when PATCH throws without changing the live release', async () => {
    const h = harness(); const plan = await h.prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, path, body) => {
      if (method === 'PATCH') throw new Error('403');
      return original(method, path, body);
    });
    await expect(publishRules({ request: h.request, plan })).rejects.toThrow('verification failed');
  });
  it('fails when published ruleset name matches but source does not', async () => {
    const h = harness(); const plan = await h.prepare();
    const original = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (method, path, body) => {
      if (method === 'GET' && path.endsWith('/new')) return source('wrong source');
      return original(method, path, body);
    });
    await expect(publishRules({ request: h.request, plan })).rejects.toThrow('verification failed');
  });
  it('requires main CI even when credentials are locally present', () => {
    expect(() => execFileSync(process.execPath, ['scripts/publish-firestore-rules.mjs', 'publish', '/tmp/no-plan'], {
      env: { ...process.env, GITHUB_ACTIONS: 'false' }, stdio: 'pipe',
    })).toThrow();
  });
  it.each(['production-deploy', 'jvm-production-deploy'])('uploads backup before rules and application mutation in %s', (name) => {
    const workflow = readFileSync(`.github/workflows/${name}.yml`, 'utf8');
    const prepare = workflow.indexOf('- name: Prepare Firestore rules backup');
    const upload = workflow.indexOf('- name: Preserve Firestore rules rollback artifact');
    const publish = workflow.indexOf('- name: Publish and verify Firestore rules');
    const deploy = workflow.indexOf(name === 'production-deploy' ? '- name: Deploy to Vercel production' : '- name: Activate current web maintenance alias');
    expect(prepare).toBeGreaterThan(0); expect(upload).toBeGreaterThan(prepare);
    expect(publish).toBeGreaterThan(upload); expect(deploy).toBeGreaterThan(publish);
    expect(workflow).toContain('group: inner-platform-production');
    expect(workflow).toContain('cancel-in-progress: false');
  });
});
