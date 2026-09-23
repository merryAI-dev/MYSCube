import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBuildMetadata, releaseIdentity } from './build-metadata.mjs';

const directories: string[] = [];
const env = { WORKBENCH_RELEASE_SHA: 'a'.repeat(40), WORKBENCH_BUILD_CLASS: 'synthetic', VITE_WORKBENCH_AUTH_PROJECT_ID: 'demo-image-identity', VITE_WORKBENCH_AUTH_DOMAIN: 'demo-image-identity.firebaseapp.com', VITE_WORKBENCH_AUTH_API_KEY: 'synthetic-image-key-not-a-secret' };
const runtime = { platform: 'linux', arch: 'x64', version: 'v24.13.0' };
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

describe('actual build identity', () => {
  it('requires explicit full source SHA and classification', () => {
    expect(() => releaseIdentity({})).toThrow();
    expect(() => releaseIdentity({ ...env, WORKBENCH_RELEASE_SHA: 'main' })).toThrow();
    expect(() => releaseIdentity({ ...env, WORKBENCH_BUILD_CLASS: 'production' })).toThrow();
  });
  it('hashes actual lockfile bytes and public auth key without embedding the key', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-build-')); directories.push(directory);
    await mkdir(join(directory, 'server/workbench'), { recursive: true });
    await writeFile(join(directory, 'package-lock.json'), 'root-lock\n');
    await writeFile(join(directory, 'server/workbench/package-lock.json'), 'duckdb-lock\n');
    const result = await createBuildMetadata({ env, directory, runtime });
    expect(result.platform).toEqual({ os: 'linux', architecture: 'amd64' });
    expect(result.locks.workbench).toBe(createHash('sha256').update('duckdb-lock\n').digest('hex'));
    expect(JSON.stringify(result)).not.toContain(env.VITE_WORKBENCH_AUTH_API_KEY);
  });
  it.each([
    { env: { ...env, WORKBENCH_BUILD_CLASS: 'production_candidate' }, runtime },
    { env: { ...env, VITE_WORKBENCH_AUTH_PROJECT_ID: 'real-identity' }, runtime },
    { env: { ...env, VITE_WORKBENCH_AUTH_DOMAIN: 'https://identity.example.com' }, runtime },
    { env, runtime: { ...runtime, platform: 'darwin' } },
    { env, runtime: { ...runtime, version: 'v22.0.0' } },
  ])('rejects unverified build settings before opening lockfiles %#', async input => {
    await expect(createBuildMetadata({ ...input, directory: '/does-not-exist' })).rejects.not.toThrow(/ENOENT/);
  });
});
