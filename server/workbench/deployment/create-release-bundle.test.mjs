import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, truncate, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createReleaseBundle, main } from './create-release-bundle.mjs';

const sourceSha = 'a'.repeat(40), appId = `sha256:${'1'.repeat(64)}`, rendererId = `sha256:${'2'.repeat(64)}`;
const folders = [];
const hash = value => createHash('sha256').update(value).digest('hex');
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), 'bundle-producer-test-'))); folders.push(parent);
  const directory = join(parent, 'release'), classification = 'synthetic';
  const metadata = { schemaVersion: 1, sourceSha, classification, platform: { os: 'linux', architecture: 'amd64' }, nodeVersion: 'v24.13.0', auth: { projectId: 'demo-workbench-test', domain: 'demo-workbench-test.firebaseapp.com', apiKeySha256: '3'.repeat(64) }, locks: { root: '4'.repeat(64), workbench: '5'.repeat(64) } };
  const images = ['myscube-workbench-app:release', 'myscube-axr-renderer:1.58.2-v1'].map((tag, index) => ({ Id: index ? rendererId : appId, RepoTags: [tag], Os: 'linux', Architecture: 'amd64', Config: { Labels: { 'org.opencontainers.image.revision': sourceSha, 'io.myscube.workbench.classification': classification } } }));
  const execute = vi.fn(async (args, options) => {
    const command = args.slice(4);
    if (command[0] === 'image' && command[1] === 'inspect') return JSON.stringify([images.find(image => image.RepoTags.includes(command[2]))]);
    if (command[0] === 'run') return JSON.stringify(metadata);
    if (command[0] === 'image' && command[1] === 'save') { await writeFile(options.stdoutFile, `synthetic-archive-${command[2]}`, { flag: 'wx', mode: 0o600 }); return ''; }
    throw new Error('Unexpected command');
  });
  const verify = vi.fn(async () => {});
  return { directory, sourceSha, classification, metadata, images, execute, verify, hostPlatform: 'linux' };
}

describe('local immutable image pair release bundle producer', () => {
  it('saves exact IDs through a fixed local Docker socket and produces a private self-checked manifest', async () => {
    const input = await fixture(), result = await createReleaseBundle(input);
    expect((await stat(input.directory)).mode & 0o777).toBe(0o700);
    expect((await readdir(input.directory)).sort()).toEqual(['app.docker.tar', 'manifest.json', 'renderer.docker.tar']);
    const bytes = await readFile(join(input.directory, 'manifest.json'));
    expect(result.manifestSha256).toBe(hash(bytes)); expect(JSON.parse(bytes)).toEqual(result.manifest);
    expect(result.manifest).toMatchObject({ schemaVersion: 1, sourceSha, classification: 'synthetic', format: 'docker-save', platform: { os: 'linux', architecture: 'amd64' }, requirements: { nodeMajor: 24, libc: 'glibc', minimumGlibc: '2.36', docker: 'local-linux' }, build: { nodeVersion: 'v24.13.0' } });
    for (const image of result.manifest.images) {
      const archive = await readFile(join(input.directory, image.archive));
      expect(image.bytes).toBe(archive.length); expect(image.sha256).toBe(hash(archive));
      expect((await stat(join(input.directory, image.archive))).mode & 0o777).toBe(0o600);
    }
    expect(input.verify).toHaveBeenCalledExactlyOnceWith({ directory: input.directory, expectedManifestSha256: result.manifestSha256, expectedSourceSha: sourceSha, forProduction: false });
    for (const [args, options] of input.execute.mock.calls) {
      expect(args.slice(0, 3)).toEqual(['--host', 'unix:///var/run/docker.sock', '--config']);
      expect(options.timeoutMs).toBeGreaterThan(0); expect(options.timeoutMs).toBeLessThanOrEqual(600000); expect(options.maxBuffer).toBe(65536);
    }
    const run = input.execute.mock.calls.find(([args]) => args[4] === 'run')[0];
    expect(run).toEqual(expect.arrayContaining(['--network', 'none', '--read-only', '--memory', '128m', '--cpus', '0.5', '--pids-limit', '32', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pull', 'never', appId]));
    const saves = input.execute.mock.calls.filter(([args]) => args[5] === 'save');
    expect(saves.map(([args]) => args.slice(4))).toEqual([['image', 'save', appId], ['image', 'save', rendererId]]);
    expect(JSON.stringify(input.execute.mock.calls)).not.toContain('DOCKER_HOST');
  });
  it('runs the real read-only verifier over produced bytes before returning success', async () => {
    const input = await fixture(); delete input.verify;
    const result = await createReleaseBundle(input);
    expect(result.manifest.images).toHaveLength(2);
    expect(result.manifestSha256).toBe(hash(await readFile(join(input.directory, 'manifest.json'))));
  });
  it('does not trust mutable tag names after inspection', async () => {
    const input = await fixture(), base = input.execute.getMockImplementation();
    input.execute.mockImplementation(async (args, options) => {
      const value = await base(args, options);
      if (args[4] === 'run') input.images.forEach(image => { image.Id = `sha256:${'9'.repeat(64)}`; });
      return value;
    });
    const result = await createReleaseBundle(input);
    expect(result.manifest.images.map(image => image.id)).toEqual([appId, rendererId]);
    expect(input.execute.mock.calls.filter(([args]) => args[5] === 'save').map(([args]) => args[6])).toEqual([appId, rendererId]);
  });
  it('rejects labels, platforms, shared identities and role tag confusion before saving archives', async () => {
    for (const mutate of [input => { input.images[1].Config.Labels['org.opencontainers.image.revision'] = 'b'.repeat(40); }, input => { input.images[0].Config.Labels['io.myscube.workbench.classification'] = 'production_candidate'; }, input => { input.images[1].Architecture = 'arm64'; }, input => { input.images[1].Os = 'windows'; }, input => { input.images[1].Id = appId; }, input => { input.images[0].RepoTags = ['wrong:tag']; }]) {
      const input = await fixture(); mutate(input);
      await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
      expect(input.execute.mock.calls.some(([args]) => args[5] === 'save')).toBe(false);
      expect(await readdir(input.directory)).toEqual([]);
    }
  });
  it('rejects metadata mismatch, extra keys, non-Node24 and unsupported hashes without exporting', async () => {
    for (const mutate of [m => { m.sourceSha = 'b'.repeat(40); }, m => { m.classification = 'production_candidate'; }, m => { m.platform.architecture = 'arm64'; }, m => { m.nodeVersion = 'v22.13.0'; }, m => { m.auth.apiKeySha256 = 'raw-api-key'; }, m => { m.locks.root = null; }, m => { m.secret = 'private-sentinel'; }]) {
      const input = await fixture(); mutate(input.metadata);
      await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
      expect(input.execute.mock.calls.some(([args]) => args[5] === 'save')).toBe(false);
    }
  });
  it('does not reclassify synthetic auth as a production candidate', async () => {
    const input = await fixture(); input.classification = 'production_candidate'; input.metadata.classification = 'production_candidate';
    input.images.forEach(image => { image.Config.Labels['io.myscube.workbench.classification'] = 'production_candidate'; });
    await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified'); expect(input.verify).not.toHaveBeenCalled();
  });
  it('passes production candidate verification only with matching non-synthetic metadata', async () => {
    const input = await fixture(); input.classification = 'production_candidate'; input.metadata.classification = 'production_candidate'; input.metadata.auth.projectId = 'workbench-identity';
    input.images.forEach(image => { image.Config.Labels['io.myscube.workbench.classification'] = 'production_candidate'; });
    await createReleaseBundle(input);
    expect(input.verify.mock.calls[0][0].forProduction).toBe(true);
  });
  it('removes only its own named metadata container after a timeout and never prunes other containers', async () => {
    const input = await fixture(), base = input.execute.getMockImplementation();
    input.execute.mockImplementation(async (args, options) => { if (args[4] === 'run') throw new Error('timeout'); if (args[4] === 'rm') return ''; return base(args, options); });
    await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
    const run = input.execute.mock.calls.find(([args]) => args[4] === 'run')[0], removal = input.execute.mock.calls.find(([args]) => args[4] === 'rm');
    expect(run[6]).toMatch(/^workbench-release-metadata-[a-f0-9-]{36}$/);
    expect(removal[0].slice(4)).toEqual(['rm', '-f', run[6]]); expect(removal[1].timeoutMs).toBe(3000);
    expect(input.execute.mock.calls.some(([args]) => args.includes('prune'))).toBe(false);
    expect(await readdir(input.directory)).toEqual([]);
  });
  it('preserves only its partial archives, never a completed manifest, after save failure', async () => {
    const input = await fixture(), base = input.execute.getMockImplementation();
    input.execute.mockImplementation(async (args, options) => { if (args[5] === 'save' && args[6] === rendererId) { await writeFile(options.stdoutFile, 'partial', { mode: 0o600 }); throw new Error('private-error-sentinel'); } return base(args, options); });
    await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
    expect((await readdir(input.directory)).sort()).toEqual(['app.docker.tar', 'renderer.docker.tar']); expect(input.verify).not.toHaveBeenCalled();
  });
  it('removes its manifest on verifier rejection without deleting archives or unrelated paths', async () => {
    const input = await fixture(); input.verify.mockRejectedValue(new Error('verification rejected'));
    await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
    expect((await readdir(input.directory)).sort()).toEqual(['app.docker.tar', 'renderer.docker.tar']);
  });
  it('refuses existing output paths, non-Linux hosts and invalid release identity without commands', async () => {
    const input = await fixture(); await mkdir(input.directory); await writeFile(join(input.directory, 'existing'), 'keep');
    await expect(createReleaseBundle(input)).rejects.toBeDefined(); expect(await readFile(join(input.directory, 'existing'), 'utf8')).toBe('keep');
    for (const overrides of [{ hostPlatform: 'darwin' }, { sourceSha: 'short' }, { classification: 'unknown' }]) await expect(createReleaseBundle({ ...input, ...overrides })).rejects.toBeDefined();
    expect(input.execute).not.toHaveBeenCalled();
    await expect(main(['--directory', '/tmp/unsafe'])).rejects.toBeDefined();
  });
  it('rejects empty or oversized archives without allocating their full contents', async () => {
    for (const size of [0, 8 * 1024 ** 3 + 1]) {
      const input = await fixture(), base = input.execute.getMockImplementation();
      input.execute.mockImplementation(async (args, options) => { if (args[5] !== 'save') return base(args, options); await writeFile(options.stdoutFile, '', { mode: 0o600 }); await truncate(options.stdoutFile, size); return ''; });
      await expect(createReleaseBundle(input)).rejects.toThrow('could not be verified');
      expect((await readdir(input.directory)).includes('manifest.json')).toBe(false);
    }
  });
});
