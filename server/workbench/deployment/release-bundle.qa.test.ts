import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm, link, symlink, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyReleaseBundle, renderReleaseInstallPlan } from './release-bundle.mjs';

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const sourceSha = 'a'.repeat(40), directories: string[] = [];
async function fixture(classification = 'synthetic') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'axr-release-qa-'))); directories.push(directory);
  const app = 'synthetic archive bytes; not a Docker execution proof', renderer = 'synthetic renderer archive bytes';
  const manifest: any = { schemaVersion: 1, format: 'docker-save', sourceSha, classification, platform: { os: 'linux', architecture: 'amd64' },
    requirements: { nodeMajor: 24, libc: 'glibc', minimumGlibc: '2.36', docker: 'local-linux' },
    build: { nodeVersion: 'v24.1.0', auth: { projectId: 'approved-fixture', domain: 'auth.example.org', apiKeySha256: 'b'.repeat(64) }, locks: { root: 'c'.repeat(64), workbench: 'd'.repeat(64) } },
    images: [
      { role: 'app', tag: 'myscube-workbench-app:release', id: `sha256:${'1'.repeat(64)}`, archive: 'app.docker.tar', bytes: Buffer.byteLength(app), sha256: digest(app) },
      { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', id: `sha256:${'2'.repeat(64)}`, archive: 'renderer.docker.tar', bytes: Buffer.byteLength(renderer), sha256: digest(renderer) },
    ] };
  await writeFile(join(directory, 'app.docker.tar'), app, { mode: 0o600 });
  await writeFile(join(directory, 'renderer.docker.tar'), renderer, { mode: 0o600 });
  async function publish() { const text = JSON.stringify(manifest); await writeFile(join(directory, 'manifest.json'), text, { mode: 0o600 }); return digest(text); }
  const expectedManifestSha256 = await publish();
  return { directory, manifest, publish, options: { directory, expectedManifestSha256, expectedSourceSha: sourceSha } };
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
describe('independent release verifier sabotage (file contract only)', () => {
  it('verifies bytes without modifying the directory and never promotes a synthetic bundle to an install plan', async () => {
    const f = await fixture(), before = await Promise.all((await readdir(f.directory)).sort().map(async name => [name, digest(await readFile(join(f.directory, name)))]));
    const verified = await verifyReleaseBundle(f.options);
    expect(() => renderReleaseInstallPlan(verified)).toThrow();
    await expect(verifyReleaseBundle({ ...f.options, forProduction: true })).rejects.toBeDefined();
    const after = await Promise.all((await readdir(f.directory)).sort().map(async name => [name, digest(await readFile(join(f.directory, name)))]));
    expect(after).toEqual(before);
  });
  it('rejects a forged verification token and freezes nested manifest fields against promotion', async () => {
    const f = await fixture(); const verified = await verifyReleaseBundle(f.options);
    expect(Object.isFrozen(verified)).toBe(true); expect(Object.isFrozen(verified.manifest.images[0])).toBe(true);
    expect(() => { verified.manifest.classification = 'production_candidate'; }).toThrow();
    expect(() => renderReleaseInstallPlan({ ...verified, forProduction: true })).toThrow();
  });
  it('requires externally supplied expected digests and source revision', async () => {
    const f = await fixture();
    for (const change of [{ expectedManifestSha256: undefined }, { expectedSourceSha: undefined }, { expectedManifestSha256: '0'.repeat(64) }, { expectedSourceSha: '0'.repeat(40) }]) {
      await expect(verifyReleaseBundle({ ...f.options, ...change })).rejects.toBeDefined();
    }
  });
  it('rejects altered archive bytes even when the replacement has exactly the same length', async () => {
    const f = await fixture(); await writeFile(join(f.directory, 'app.docker.tar'), 'x'.repeat(f.manifest.images[0].bytes));
    await expect(verifyReleaseBundle(f.options)).rejects.toBeDefined();
  });
  it('rejects extra environment files and missing declared artifacts', async () => {
    const f = await fixture(); await writeFile(join(f.directory, '.env'), 'SYNTHETIC_TEST_ONLY=1');
    await expect(verifyReleaseBundle(f.options)).rejects.toBeDefined();
    await rm(join(f.directory, '.env')); await rm(join(f.directory, 'renderer.docker.tar'));
    await expect(verifyReleaseBundle(f.options)).rejects.toBeDefined();
  });
  it('rejects symbolic and hard linked archives before considering their matching bytes', async () => {
    const f = await fixture(), other = await fixture();
    await rm(join(f.directory, 'app.docker.tar')); await symlink(join(other.directory, 'app.docker.tar'), join(f.directory, 'app.docker.tar'));
    await expect(verifyReleaseBundle(f.options)).rejects.toBeDefined();
    await rm(join(f.directory, 'app.docker.tar')); await link(join(other.directory, 'app.docker.tar'), join(f.directory, 'app.docker.tar'));
    await expect(verifyReleaseBundle(f.options)).rejects.toBeDefined();
  });
  it('rejects authenticated manifests with invalid roles, paths, sizes or nested unexpected fields', async () => {
    for (const sabotage of [
      (m: any) => { m.images[1].id = m.images[0].id; },
      (m: any) => { m.images[1].role = 'app'; },
      (m: any) => { m.images[0].archive = '../app.docker.tar'; },
      (m: any) => { m.images[0].bytes = 8 * 1024 ** 3 + 1; },
      (m: any) => { m.build.auth.token = 'synthetic-secret-field'; },
    ]) { const f = await fixture(); sabotage(f.manifest); await expect(verifyReleaseBundle({ ...f.options, expectedManifestSha256: await f.publish() })).rejects.toBeDefined(); }
  });
  it('only renders a plan after explicit production-candidate verification and retains its verified identity', async () => {
    const f = await fixture('production_candidate');
    const verificationOnly = await verifyReleaseBundle(f.options); expect(() => renderReleaseInstallPlan(verificationOnly)).toThrow();
    const verified = await verifyReleaseBundle({ ...f.options, forProduction: true });
    const plan = renderReleaseInstallPlan(verified); expect(typeof plan).toBe('string'); expect(plan).toContain(sourceSha); expect(plan).toContain(f.manifest.images[0].id);
  });
  it('does not allow production classification to conceal a known synthetic authentication project', async () => {
    const f = await fixture('production_candidate'); f.manifest.build.auth.projectId = 'demo-image-identity';
    await expect(verifyReleaseBundle({ ...f.options, expectedManifestSha256: await f.publish(), forProduction: true })).rejects.toBeDefined();
  });
});
