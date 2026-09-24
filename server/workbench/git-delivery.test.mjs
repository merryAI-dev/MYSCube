import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createGitDeliveryService } from './git-delivery.mjs';
import { canonicalWorkspace, normalizeReactSource } from '../../shared/workbench-react-workspace.mjs';

const hash = (s) => createHash('sha256').update(s).digest('hex');
const gitHash = (s) => createHash('sha1').update(s).digest('hex');
const context = { tenantId: 'demo-git-delivery', actorId: 'member-a' };
const code = 'export default function App() { return <h1>자료 미연결</h1>; }';
const source = { pageId: 'page-1', version: 1, title: '테스트 화면', code, sourceHash: hash(code), packageSetHash: 'react19-v1', apiIds: ['api-one'] };
const env = { WORKBENCH_GIT_REPOSITORY: 'test-owner/test-repo', WORKBENCH_GITHUB_TOKEN: 'test-token-do-not-export' };
function memoryDb() {
  const values = new Map();
  let queue = Promise.resolve();
  return { projectId: 'demo-git-unit', values, doc: (path) => ({ path }), runTransaction(fn) {
    const run = queue.then(async () => {
      const writes = new Map();
      const result = await fn({ get: async (ref) => ({ data: () => structuredClone(values.get(ref.path)) }), set: (ref, value) => writes.set(ref.path, structuredClone(value)) });
      for (const [key, value] of writes) values.set(key, value);
      return result;
    });
    queue = run.catch(() => {});
    return run;
  } };
}
function github() {
  const calls = []; const refs = new Map(); const pulls = []; const blobs = new Map();
  let nextPull = 10;
  let hook = async () => {};
  const fetchImpl = async (url, options) => {
    const u = new URL(url); const path = u.pathname.replace(/^\/repos\/[^/]+\/[^/]+/, '');
    const body = options.body ? JSON.parse(options.body) : null;
    const call = { url, path, method: options.method, body, options }; calls.push(call);
    await hook(call);
    const reply = (value, status = 200) => new Response(JSON.stringify(value), { status });
    if (options.method === 'GET' && path === '') return reply({ full_name: env.WORKBENCH_GIT_REPOSITORY, private: true });
    if (options.method === 'GET' && /^\/pulls\/\d+$/.test(path)) return reply(pulls.find((pull) => pull.number === Number(path.split('/').at(-1))));
    if (options.method === 'GET' && path === '/git/ref/heads/main') return reply({ object: { sha: 'a'.repeat(40) } });
    if (path.startsWith('/git/commits/') && options.method === 'GET') return reply({ tree: { sha: 'b'.repeat(40) } });
    if (path === '/git/blobs') { const sha = gitHash(body.content); blobs.set(sha, body.content); return reply({ sha }, 201); }
    if (path === '/git/trees' || path === '/git/commits') return reply({ sha: gitHash(JSON.stringify(body)) }, 201);
    if (path === '/git/refs') { if (refs.has(body.ref)) return reply({}, 422); refs.set(body.ref, body.sha); return reply({}, 201); }
    if (path.startsWith('/git/ref/heads/')) { const value = refs.get(`refs/${path.slice('/git/ref/'.length)}`); return value ? reply({ object: { sha: value } }) : reply({}, 404); }
    if (path === '/pulls' && options.method === 'GET') return reply(pulls.filter((p) => u.searchParams.get('head').endsWith(`:${p.head.ref}`)));
    if (path === '/pulls' && options.method === 'POST') {
      const pull = { state: 'open', merged: false, number: nextPull++, head: { ref: body.head, sha: refs.get(`refs/heads/${body.head}`), repo: { full_name: env.WORKBENCH_GIT_REPOSITORY } }, base: { ref: body.base }, draft: body.draft };
      pulls.push(pull); return reply(pull, 201);
    }
    throw new Error(`Unexpected ${options.method} ${path}`);
  };
  return { calls, refs, pulls, blobs, fetchImpl, hook: (value) => { hook = value; } };
}
function setup(options = {}) {
  const db = options.db || memoryDb(); const remote = github();
  const service = createGitDeliveryService({ db, env, authorize: async () => {}, now: () => Date.parse('2026-09-23T03:00:00Z'), retryDelayMs: 0, ...options, fetchImpl: options.fetchImpl || remote.fetchImpl });
  return { db, remote, service };
}

describe('isolated Git delivery', () => {
  it('writes only three source review files and an independent draft PR, then reuses the receipt', async () => {
    const { service, remote, db } = setup();
    const first = await service.publish(context, source);
    expect(first).toMatchObject({ status: 'complete', version: 1, repository: env.WORKBENCH_GIT_REPOSITORY, baseBranch: 'main', pullNumber: 10 });
    expect(await service.publish(context, source)).toEqual(first);
    expect(remote.calls.filter((c) => c.path === '/git/commits')).toHaveLength(1);
    expect(remote.calls.filter((c) => c.path === '/pulls' && c.method === 'POST')).toHaveLength(1);
    expect(remote.pulls[0].draft).toBe(true);
    const tree = remote.calls.find((c) => c.path === '/git/trees').body;
    expect(tree.base_tree).toBe('b'.repeat(40));
    expect(tree.tree.map((f) => f.path.split('/').at(-1))).toEqual(['App.tsx', 'manifest.json', 'README.md']);
    expect(tree.tree.every((f) => /^generated\/[a-f0-9]{64}\//.test(f.path))).toBe(true);
    expect([...remote.blobs.values()]).toContain(code);
    expect(remote.calls.some((c) => c.method === 'PATCH' || c.method === 'DELETE')).toBe(false);
    expect(JSON.stringify([...db.values.values()])).not.toContain(env.WORKBENCH_GITHUB_TOKEN);
    expect(JSON.stringify([...remote.blobs.values()])).not.toContain(context.actorId);
    expect(JSON.stringify([...remote.blobs.values()])).not.toContain(env.WORKBENCH_GITHUB_TOKEN);
  });
  it('exports every canonical workspace file with exact bytes and pins its identity', async () => {
    const { service, remote } = setup();
    const workspace = { ...normalizeReactSource({ title: source.title, code }).workspace, files: {
      'App.tsx': "import {Card} from './components/Card'; export default function App(){ return <Card/>; }",
      'components/Card.tsx': "import {label} from '../lib/label'; export function Card(){ return <p>{label}</p>; }",
      'lib/label.ts': 'export const label = "실제 파일 묶음";\n',
    } };
    const { code: _legacy, ...metadata } = source;
    const input = { ...metadata, workspace, sourceHash: hash(canonicalWorkspace(workspace)) };
    const delivered = await service.publish(context, input);
    const tree = remote.calls.find((call) => call.path === '/git/trees').body.tree;
    for (const [path, content] of Object.entries(workspace.files)) {
      const entry = tree.find((item) => item.path.endsWith('/' + path));
      expect(remote.blobs.get(entry.sha)).toBe(content);
    }
    const manifest = JSON.parse(remote.blobs.get(tree.find((item) => item.path.endsWith('/manifest.json')).sha));
    expect(manifest).toMatchObject({ schemaVersion: 2, workspaceSchemaVersion: 1, entry: workspace.entry,
      workspaceHash: input.sourceHash, packageSetId: workspace.packageSetId, files: Object.keys(workspace.files).sort() });
    expect(await service.publish(context, { ...input, workspace: { ...workspace, files: Object.fromEntries(Object.entries(workspace.files).reverse()) } })).toEqual(delivered);
    expect(remote.calls.filter((call) => call.path === '/git/commits')).toHaveLength(1);
    const changed = { ...workspace, files: { ...workspace.files, 'lib/label.ts': 'export const label = "바뀜";' } };
    await expect(service.publish(context, { ...input, workspace: changed })).rejects.toMatchObject({ code: 'git_source_invalid' });
    await expect(service.publish(context, { ...input, workspace: changed, sourceHash: hash(canonicalWorkspace(changed)) })).rejects.toMatchObject({ code: 'git_version_conflict' });
  });
  it('scans all helper files for secrets and rejects dual source identities before network', async () => {
    const { service, remote } = setup();
    const workspace = normalizeReactSource({ title: source.title, code }).workspace;
    workspace.files['lib/settings.ts'] = 'export const token = "very-secret-literal";';
    const { code: _legacy, ...metadata } = source;
    const input = { ...metadata, workspace, sourceHash: hash(canonicalWorkspace(workspace)) };
    await expect(service.publish(context, input)).rejects.toMatchObject({ code: 'git_source_secret_detected' });
    await expect(service.publish(context, { ...input, code })).rejects.toMatchObject({ code: 'git_source_invalid' });
    expect(remote.calls).toHaveLength(0);
  });
  it('records immutable API versions in the source review manifest', async () => {
    const { service, remote } = setup();
    await service.publish(context, { ...source, apiBindings: [{ id: 'api-one', version: 7 }] });
    const manifest = [...remote.blobs.values()].map((content) => { try { return JSON.parse(content); } catch { return null; } }).find((value) => value?.schemaVersion === 1);
    expect(manifest).toMatchObject({ apiIds: ['api-one'], apis: [{ id: 'api-one', version: 7 }] });
    expect(manifest).not.toHaveProperty('credentials');
  });
  it('rejects missing, extra, duplicate or invalid API version pins before network', async () => {
    const { service, remote } = setup();
    for (const apiBindings of [[], [{ id: 'another-api', version: 1 }], [{ id: 'api-one', version: 0 }],
      [{ id: 'api-one', version: 1, token: 'not-permitted' }], [{ id: 'api-one', version: 1 }, { id: 'api-one', version: 2 }]]) {
      await expect(service.publish(context, { ...source, apiBindings })).rejects.toMatchObject({ code: 'git_api_bindings_invalid' });
    }
    expect(remote.calls).toHaveLength(0);
  });
  it('is disabled without explicit repository and credential', async () => {
    const { service, remote } = setup({ env: {} });
    await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_delivery_disabled', statusCode: 503 });
    expect(remote.calls).toHaveLength(0);
  });
  it('rejects mismatched hashes, unknown extra data, secret literals and unsafe paths before network', async () => {
    const { service, remote } = setup();
    for (const input of [{ ...source, code: 'changed' }, { ...source, data: [{ salary: 1 }] }, { ...source, pageId: '../outside' },
      { ...source, code: 'const token = "very-secret-string"', sourceHash: hash('const token = "very-secret-string"') }]) {
      await expect(service.publish(context, input)).rejects.toMatchObject({ statusCode: 400 });
    }
    expect(remote.calls).toHaveLength(0);
  });
  it('rejects a different source for an already published immutable version', async () => {
    const { service } = setup(); await service.publish(context, source);
    await expect(service.publish(context, { ...source, code: code + '\n', sourceHash: hash(code + '\n') })).rejects.toMatchObject({ code: 'git_version_conflict' });
  });
  it('continues after PR failure without repeating commit creation', async () => {
    const { service, remote } = setup(); let fail = true;
    remote.hook(async (call) => { if (call.path === '/pulls' && call.method === 'POST' && fail) throw new Error('network secret'); });
    await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_transport_failed' });
    fail = false;
    expect((await service.publish(context, source)).status).toBe('complete');
    expect(remote.calls.filter((c) => c.path === '/git/commits')).toHaveLength(1);
    expect(remote.pulls).toHaveLength(1);
  });
  it('reconciles an acknowledged-lost PR response without creating another PR', async () => {
    const remote = github(); let lost = true;
    const fetchImpl = async (url, options) => {
      const response = await remote.fetchImpl(url, options);
      if (url.endsWith('/pulls') && options.method === 'POST' && lost) { lost = false; throw new Error('lost response'); }
      return response;
    };
    const { service } = setup({ fetchImpl });
    expect((await service.publish(context, source)).pullNumber).toBe(10);
    expect((await service.publish(context, source)).pullNumber).toBe(10);
    expect(remote.pulls).toHaveLength(1);
  });
  it('reuses the deterministic commit identity when its first response is lost', async () => {
    const remote = github(); let lost = true;
    const fetchImpl = async (url, options) => {
      const response = await remote.fetchImpl(url, options);
      if (url.endsWith('/git/commits') && options.method === 'POST' && lost) { lost = false; throw new Error('response lost'); }
      return response;
    };
    const { service } = setup({ fetchImpl });
    expect((await service.publish(context, source)).status).toBe('complete');
    expect((await service.publish(context, source)).status).toBe('complete');
    const commits = remote.calls.filter((c) => c.path === '/git/commits');
    expect(commits).toHaveLength(2);
    expect(commits[1].body).toEqual(commits[0].body);
    expect(remote.pulls).toHaveLength(1);
  });
  it('reconciles branch creation when the success response is lost', async () => {
    const remote = github(); let lost = true;
    const fetchImpl = async (url, options) => {
      const response = await remote.fetchImpl(url, options);
      if (url.endsWith('/git/refs') && options.method === 'POST' && lost) { lost = false; throw new Error('response lost'); }
      return response;
    };
    const { service } = setup({ fetchImpl });
    expect((await service.publish(context, source)).status).toBe('complete');
    expect((await service.publish(context, source)).status).toBe('complete');
    expect(remote.calls.filter((c) => c.path === '/git/refs')).toHaveLength(1);
    expect(remote.calls.filter((c) => c.path === '/git/commits')).toHaveLength(1);
  });
  it('rejects changed remote branch HEAD and never force-updates it', async () => {
    const { service, remote } = setup(); let fail = true;
    remote.hook(async (call) => { if (call.path === '/pulls' && fail) throw new Error('stop'); });
    await expect(service.publish(context, source)).rejects.toBeDefined();
    for (const key of remote.refs.keys()) remote.refs.set(key, 'c'.repeat(40));
    fail = false;
    await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_branch_conflict' });
    expect(remote.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });
  it('prevents concurrent publication of the same version with a persisted lease', async () => {
    const { service, remote } = setup(); let release;
    const waiting = new Promise((resolve) => { release = resolve; }); let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    remote.hook(async (call) => { if (call.path === '/git/ref/heads/main') { entered(); await waiting; } });
    const one = service.publish(context, source); await started;
    await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_delivery_busy' });
    release(); await one;
    expect(remote.pulls).toHaveLength(1);
  });
  it('rechecks authorization after responses and stops before another side effect', async () => {
    let allowed = true;
    const { service, remote } = setup({ authorize: async () => { if (!allowed) throw Object.assign(new Error('revoked'), { statusCode: 403 }); } });
    remote.hook(async () => { allowed = false; });
    await expect(service.publish(context, source)).rejects.toMatchObject({ statusCode: 403 });
    expect(remote.calls).toHaveLength(1);
    expect(remote.calls[0].method).toBe('GET');
  });
  it('uses distinct durable identities for actor, repository and base branch changes', async () => {
    const { service, db } = setup(); await service.publish(context, source);
    await service.publish({ ...context, actorId: 'member-b' }, source);
    for (const configuration of [{ ...env, WORKBENCH_GIT_REPOSITORY: 'another/repository' }, { ...env, WORKBENCH_GIT_BASE_BRANCH: 'review' }]) {
      const next = setup({ db, env: configuration, fetchImpl: async () => { throw new Error('deliberate stop'); } });
      await expect(next.service.publish(context, source)).rejects.toMatchObject({ code: 'git_transport_failed' });
    }
    expect(db.values.size).toBe(4);
    expect(new Set([...db.values.values()].map((r) => r.branch)).size).toBe(4);
  });
  it('fails closed for a public or unverifiable repository before any Git write', async () => {
    for (const metadata of [{ full_name: env.WORKBENCH_GIT_REPOSITORY, private: false }, { full_name: env.WORKBENCH_GIT_REPOSITORY }, { full_name: 'wrong/repo', private: true }]) {
      const remote = github();
      const { service } = setup({ fetchImpl: async (url, options) => url.endsWith(env.WORKBENCH_GIT_REPOSITORY) ? new Response(JSON.stringify(metadata)) : remote.fetchImpl(url, options) });
      await expect(service.publish(context, source)).rejects.toMatchObject({ code: metadata.private === false ? 'git_public_repository_forbidden' : 'git_repository_invalid' });
      expect(remote.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
    }
  });
  it('allows a public sample only with explicit flag, emulator mode, demo DB and loopback emulator together', async () => {
    const allowed = { ...env, WORKBENCH_GIT_ALLOW_PUBLIC_TEST: 'true', WORKBENCH_AUTH_MODE: 'emulator', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' };
    for (const change of [{ WORKBENCH_GIT_ALLOW_PUBLIC_TEST: 'false' }, { WORKBENCH_AUTH_MODE: 'production' }, { FIRESTORE_EMULATOR_HOST: 'cloud.example:8080' }, { productionDb: true }, {}]) {
      const remote = github(); const db = memoryDb(); if (change.productionDb) db.projectId = 'real-project';
      const { service } = setup({ db, env: { ...allowed, ...change }, fetchImpl: async (url, options) => url.endsWith(env.WORKBENCH_GIT_REPOSITORY) ? new Response(JSON.stringify({ full_name: env.WORKBENCH_GIT_REPOSITORY, private: false })) : remote.fetchImpl(url, options) });
      if (!Object.keys(change).length) expect((await service.publish(context, source)).status).toBe('complete');
      else await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_public_repository_forbidden' });
    }
  });
  it('bounds automatic recovery to two attempts and respects a single total deadline', async () => {
    let calls = 0;
    const failed = setup({ fetchImpl: async () => { calls++; return new Response('{}', { status: 503 }); } });
    await expect(failed.service.publish(context, source)).rejects.toMatchObject({ code: 'git_provider_unavailable' });
    expect(calls).toBe(2);
    calls = 0;
    const slow = setup({ totalTimeoutMs: 30, fetchImpl: async (_url, { signal }) => new Promise((_resolve, reject) => { calls++; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }) });
    const started = Date.now();
    await expect(slow.service.publish(context, source)).rejects.toMatchObject({ code: 'git_delivery_deadline', statusCode: 504 });
    expect(Date.now() - started).toBeLessThan(500);
    expect(calls).toBe(1);
    expect([...slow.db.values.values()][0]).toMatchObject({ status: 'retryable', leaseUntil: 0 });
  });
  it('reads the current PR state rather than treating a historical receipt as current open status', async () => {
    const { service, remote } = setup();
    await service.publish(context, source);
    remote.pulls[0].state = 'closed'; remote.pulls[0].merged = true;
    const result = await service.status(context, source);
    expect(result).toMatchObject({ status: 'complete', pullState: 'closed', merged: true });
    expect(remote.calls.filter((c) => c.method === 'POST' && c.path === '/pulls')).toHaveLength(1);
    remote.pulls[0].head.sha = '9'.repeat(40);
    await expect(service.publish(context, source)).rejects.toMatchObject({ code: 'git_pull_conflict' });
  });
  it('does not publish or acquire a lease during read-only status and refuses a cancelled caller', async () => {
    const { service, remote } = setup();
    await expect(service.status(context, source)).rejects.toMatchObject({ code: 'git_delivery_not_found' });
    const controller = new AbortController(); controller.abort();
    await expect(service.publish(context, source, { signal: controller.signal })).rejects.toMatchObject({ code: 'git_delivery_deadline' });
    expect(remote.calls).toHaveLength(0);
  });
  it('does not forward token to redirects and does not expose remote error bodies', async () => {
    const { service, remote } = setup({ fetchImpl: async (_url, options) => {
      expect(options.redirect).toBe('error'); expect(options.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ message: env.WORKBENCH_GITHUB_TOKEN }), { status: 403 });
    } });
    await expect(service.publish(context, source)).rejects.toMatchObject({ message: expect.not.stringContaining(env.WORKBENCH_GITHUB_TOKEN), code: 'git_request_failed' });
    expect(remote.calls).toHaveLength(0);
  });
});
