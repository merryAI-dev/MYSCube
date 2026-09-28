import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, symlink, link, rename, mkdir, truncate, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const hooks = vi.hoisted(() => ({ onRead: null as null | ((path: string) => Promise<void>), opened: [] as string[] }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    const path = String(args[0]);
    hooks.opened.push(path);
    const nativeRead = handle.read.bind(handle);
    handle.read = async (...readArgs: any[]) => {
      const result = await (nativeRead as any)(...readArgs);
      if (hooks.onRead) await hooks.onRead(path);
      return result;
    };
    return handle;
  } };
});

import { verifyReleaseBundle, renderReleaseInstallPlan } from './release-bundle.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sha = 'a'.repeat(40);
const directories: string[] = [];
const exec = promisify(execFile);
const cli = resolve('server/workbench/deployment/release-bundle.mjs');

async function fixture(classification = 'production_candidate') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'release-bundle-')));
  directories.push(root);
  const directory = join(root, "bundle's checked files");
  await mkdir(directory);
  const app = Buffer.from('synthetic app archive bytes'), renderer = Buffer.from('synthetic renderer archive bytes');
  const manifest: any = {
    schemaVersion: 1, format: 'docker-save', sourceSha: sha, classification,
    platform: { os: 'linux', architecture: 'amd64' },
    requirements: { nodeMajor: 24, libc: 'glibc', minimumGlibc: '2.36', docker: 'local-linux' },
    build: { nodeVersion: 'v24.21.0', auth: { projectId: 'approved-fixture', domain: 'auth.example.org', apiKeySha256: digest('synthetic public config key') }, locks: { root: digest('synthetic root lock'), workbench: digest('synthetic workbench lock') } },
    images: [
      { role: 'app', tag: 'myscube-workbench-app:release', id: `sha256:${'1'.repeat(64)}`, archive: 'app.docker.tar', bytes: app.length, sha256: digest(app) },
      { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', id: `sha256:${'2'.repeat(64)}`, archive: 'renderer.docker.tar', bytes: renderer.length, sha256: digest(renderer) },
    ],
  };
  await writeFile(join(directory, 'app.docker.tar'), app);
  await writeFile(join(directory, 'renderer.docker.tar'), renderer);
  async function writeManifest() {
    const contents = `${JSON.stringify(manifest, null, 2)}\n`;
    await writeFile(join(directory, 'manifest.json'), contents);
    return { directory, expectedManifestSha256: digest(contents), expectedSourceSha: sha };
  }
  return { root, directory, manifest, app, renderer, writeManifest, input: await writeManifest() };
}

afterEach(async () => {
  hooks.onRead = null;
  hooks.opened = [];
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('read-only release bundle verifier and print-only restoration plan', () => {
  it('checks real file hashes, freezes its result, and prints quoted local-only restoration commands without executing them', async () => {
    const value = await fixture();
    const before = await Promise.all(['manifest.json', 'app.docker.tar', 'renderer.docker.tar'].map(name => readFile(join(value.directory, name))));
    const result = await verifyReleaseBundle({ ...value.input, forProduction: true });
    expect(result.manifest).toEqual(value.manifest);
    expect(result.manifestSha256).toBe(value.input.expectedManifestSha256);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.manifest.images[0])).toBe(true);
    expect(() => { result.manifest.classification = 'synthetic'; }).toThrow();
    const plan = renderReleaseInstallPlan(result);
    expect(plan).toContain("--host 'unix:///var/run/docker.sock'");
    expect(plan).toContain("bundle'\\''s checked files");
    expect(plan).toContain('--for-production');
    expect(plan).toContain(value.input.expectedManifestSha256);
    expect(plan).toContain('do not prove image internals, secret absence');
    expect(plan).toContain('already identifies another image');
    expect(plan).not.toMatch(/\bdocker --host '[^']+' (?:run|push|exec)\b/);
    expect(plan.indexOf(' image inspect')).toBeLessThan(plan.indexOf(' load --input'));
    expect(plan.indexOf(' load --input')).toBeLessThan(plan.indexOf(' tag '));
    const script = join(value.root, 'plan.sh');
    await writeFile(script, plan);
    await exec('/bin/sh', ['-n', script]);
    expect(await readdir(value.directory)).toHaveLength(3);
    const after = await Promise.all(['manifest.json', 'app.docker.tar', 'renderer.docker.tar'].map(name => readFile(join(value.directory, name))));
    expect(after).toEqual(before);
  });

  it('requires externally supplied manifest and source digests and rejects forged plan values', async () => {
    const value = await fixture();
    for (const input of [{ directory: value.directory }, { ...value.input, expectedManifestSha256: undefined }, { ...value.input, expectedSourceSha: undefined }, { ...value.input, expectedManifestSha256: 'bad' }, { ...value.input, extra: true }]) {
      await expect(verifyReleaseBundle(input)).rejects.toMatchObject({ code: 'release_input_invalid' });
    }
    await expect(verifyReleaseBundle({ ...value.input, expectedManifestSha256: '0'.repeat(64) })).rejects.toMatchObject({ code: 'release_manifest_digest_mismatch' });
    await expect(verifyReleaseBundle({ ...value.input, expectedSourceSha: 'b'.repeat(40) })).rejects.toMatchObject({ code: 'release_source_mismatch' });
    const verified = await verifyReleaseBundle({ ...value.input, forProduction: true });
    expect(() => renderReleaseInstallPlan({ ...verified })).toThrow();
    expect(() => renderReleaseInstallPlan(JSON.parse(JSON.stringify(verified)))).toThrow();
    expect(() => renderReleaseInstallPlan(null)).toThrow();
  });

  it('allows synthetic integrity checks but refuses synthetic production verification and plans', async () => {
    const value = await fixture('synthetic');
    const result = await verifyReleaseBundle(value.input);
    expect(result.manifest.classification).toBe('synthetic');
    expect(() => renderReleaseInstallPlan(result)).toThrow(/production/);
    await expect(verifyReleaseBundle({ ...value.input, forProduction: true })).rejects.toMatchObject({ code: 'release_synthetic_forbidden' });
    const candidate = await fixture();
    expect(() => renderReleaseInstallPlan(result)).toThrow();
    expect(() => renderReleaseInstallPlan({ ...result, manifest: candidate.manifest, forProduction: true })).toThrow();
    const candidateResult = await verifyReleaseBundle(candidate.input);
    expect(() => renderReleaseInstallPlan(candidateResult)).toThrow();
  });

  it.each([
    ['top-level unknown field', (m: any) => { m.script = 'never execute'; }],
    ['nested unknown field', (m: any) => { m.build.auth.apiKey = 'must not be stored'; }],
    ['node major', (m: any) => { m.requirements.nodeMajor = 22; }],
    ['platform', (m: any) => { m.platform.os = 'darwin'; }],
    ['libc', (m: any) => { m.requirements.libc = 'musl'; }],
    ['tag', (m: any) => { m.images[0].tag = 'other:image'; }],
    ['traversal archive', (m: any) => { m.images[0].archive = '../app.docker.tar'; }],
    ['duplicate roles', (m: any) => { m.images[1] = { ...m.images[0] }; }],
    ['duplicate IDs', (m: any) => { m.images[1].id = m.images[0].id; }],
    ['zero bytes', (m: any) => { m.images[0].bytes = 0; }],
    ['large bytes', (m: any) => { m.images[0].bytes = 8 * 1024 ** 3 + 1; }],
    ['fractional bytes', (m: any) => { m.images[0].bytes = 1.5; }],
    ['authentication URL', (m: any) => { m.build.auth.domain = 'https://fixture.invalid/path'; }],
  ])('rejects strict manifest mismatch: %s', async (_name, change) => {
    const value = await fixture(); change(value.manifest);
    await expect(verifyReleaseBundle(await value.writeManifest())).rejects.toMatchObject({ code: 'release_schema_invalid' });
  });

  it('rejects malformed or oversized manifests and mismatched archive bytes/hash', async () => {
    const value = await fixture();
    for (const contents of [Buffer.from('{malformed'), Buffer.from([0xff, 0xfe, 0xfd]), Buffer.alloc(65537, 32)]) {
      await writeFile(join(value.directory, 'manifest.json'), contents);
      await expect(verifyReleaseBundle({ ...value.input, expectedManifestSha256: digest(contents) })).rejects.toThrow();
    }
    value.input = await value.writeManifest();
    await writeFile(join(value.directory, 'app.docker.tar'), Buffer.alloc(value.app.length, 88));
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_archive_digest_mismatch' });
    await writeFile(join(value.directory, 'app.docker.tar'), 'short');
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_size_mismatch' });
  });

  it('rejects extra files/directories, missing files, directory aliases, file symlinks and hard links', async () => {
    const value = await fixture();
    await writeFile(join(value.directory, 'notes.txt'), 'extra');
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_directory_entries' });
    await rm(join(value.directory, 'notes.txt'));
    await mkdir(join(value.directory, 'unexpected'));
    await expect(verifyReleaseBundle(value.input)).rejects.toThrow();
    await rm(join(value.directory, 'unexpected'), { recursive: true });
    const alias = join(value.root, 'alias'); await symlink(value.directory, alias);
    await expect(verifyReleaseBundle({ ...value.input, directory: alias })).rejects.toThrow();
    const path = join(value.directory, 'app.docker.tar'), original = join(value.root, 'original');
    await rename(path, original);
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_directory_entries' });
    await symlink(original, path);
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_file_invalid' });
    await rm(path); await link(original, path);
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_file_invalid' });
  });

  it.each(['replace', 'truncate', 'append', 'rewrite'])('rejects archive %s during hashing', async operation => {
    const value = await fixture();
    let changed = false;
    hooks.onRead = async filename => {
      if (changed || filename !== join(value.directory, 'app.docker.tar')) return;
      changed = true;
      if (operation === 'replace') { await rename(filename, join(value.root, 'old')); await writeFile(filename, value.app); }
      if (operation === 'truncate') await truncate(filename, 1);
      if (operation === 'append') await writeFile(filename, Buffer.concat([value.app, Buffer.from('x')]));
      if (operation === 'rewrite') await writeFile(filename, value.app);
    };
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_file_changed' });
    expect(changed).toBe(true);
  });

  it('rechecks manifest and directory identity after archive hashing', async () => {
    const value = await fixture(); let changed = false;
    hooks.onRead = async filename => {
      if (changed || filename !== join(value.directory, 'renderer.docker.tar')) return;
      changed = true;
      await rename(join(value.directory, 'manifest.json'), join(value.root, 'old-manifest'));
      await writeFile(join(value.directory, 'manifest.json'), await readFile(join(value.root, 'old-manifest')));
    };
    await expect(verifyReleaseBundle(value.input)).rejects.toMatchObject({ code: 'release_file_changed' });
  });

  it('CLI verifies and prints a plan while refusing malformed arguments without leaking input', async () => {
    const value = await fixture();
    const args = ['--directory', value.directory, '--manifest-sha256', value.input.expectedManifestSha256, '--source-sha', sha];
    const verified = await exec(process.execPath, [cli, 'verify', ...args]);
    expect(JSON.parse(verified.stdout)).toMatchObject({ verified: true, sourceSha: sha, forProduction: false });
    const planned = await exec(process.execPath, [cli, 'plan', ...args]);
    expect(planned.stdout).toContain('PRINT-ONLY');
    expect(await readdir(value.directory)).toHaveLength(3);
    await expect(exec(process.execPath, [cli, 'verify', ...args, '--source-sha', 'secret-that-must-not-be-logged'])).rejects.toMatchObject({ code: 1, stderr: expect.not.stringContaining('secret-that-must-not-be-logged') });
  });
});
