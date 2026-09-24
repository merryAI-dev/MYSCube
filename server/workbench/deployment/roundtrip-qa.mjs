import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createReleaseBundle } from './create-release-bundle.mjs';
import { verifyReleaseBundle } from './release-bundle.mjs';

const exec = promisify(execFile);
assert.equal(process.platform, 'linux', 'Roundtrip QA requires an ephemeral Linux CI runner');
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Image removal is allowed only in the disposable CI job');
const sourceSha = process.env.WORKBENCH_RELEASE_SHA;
assert.match(sourceSha || '', /^[a-f0-9]{40}$/);
assert.equal((await exec('git', ['rev-parse', 'HEAD'])).stdout.trim(), sourceSha, 'Image labels must identify the actual checked out CI source');
const root = await mkdtemp(join(tmpdir(), 'axr-release-roundtrip-'));
const directory = join(root, 'bundle');
const reportDirectory = resolve(process.env.RELEASE_QA_REPORT_DIRECTORY || 'release-bundle-evidence');
const localEnv = { PATH: process.env.PATH, LANG: 'C.UTF-8' };
const docker = async (...args) => (await exec('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { env: localEnv, timeout: 300000, maxBuffer: 1024 * 1024 })).stdout.trim();
const inspect = async id => JSON.parse(await docker('image', 'inspect', id))[0];
const sameImage = async expected => {
  const actual = await inspect(expected.id);
  assert.equal(actual.Id, expected.id);
  assert.equal(actual.Config.Labels['org.opencontainers.image.revision'], sourceSha);
  assert.equal(actual.Config.Labels['io.myscube.workbench.classification'], 'synthetic');
  return actual;
};
const smokeArgs = ['run', '--rm', '--pull', 'never', '--network', 'none', '--memory', '1g', '--cpus', '2', '--pids-limit', '128', '--read-only', '--tmpfs', '/tmp:rw,nosuid,size=128m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--env', `WORKBENCH_EXPECTED_SOURCE_SHA=${sourceSha}`];
let extractionContainer;
try {
  const { manifest, manifestSha256 } = await createReleaseBundle({ directory, sourceSha, classification: 'synthetic' });
  await verifyReleaseBundle({ directory, expectedManifestSha256: manifestSha256, expectedSourceSha: sourceSha });
  for (const image of manifest.images) {
    const actual = await sameImage(image);
    assert.deepEqual(actual.RepoTags, [image.tag], 'Only the image tagged by this job may be removed');
    assert.equal(await docker('ps', '-aq', '--filter', `ancestor=${image.id}`), '', 'Do not delete images referenced by a container');
  }
  for (const image of manifest.images) {
    await docker('image', 'rm', image.tag);
    await assert.rejects(inspect(image.id), 'Original image must be absent before archive restoration');
  }
  for (const image of manifest.images) {
    await docker('image', 'load', '--input', join(directory, image.archive));
    const restored = await sameImage(image);
    assert.equal(restored.Os, manifest.platform.os);
    assert.equal(restored.Architecture, manifest.platform.architecture);
    await docker('image', 'tag', image.id, image.tag);
    assert.equal((await inspect(image.tag)).Id, image.id);
  }
  const app = manifest.images.find(image => image.role === 'app');
  const imageSmoke = JSON.parse(await docker(...smokeArgs, app.id, 'node', 'server/workbench/deployment/app-smoke.mjs'));
  extractionContainer = `axr-release-extract-${randomUUID()}`;
  await docker('create', '--pull', 'never', '--network', 'none', '--name', extractionContainer, app.id);
  const payload = join(root, 'payload');
  await docker('cp', `${extractionContainer}:/app`, payload);
  await docker('rm', extractionContainer); extractionContainer = undefined;
  await exec('chmod', ['-R', 'a+rX', payload], { timeout: 60000 });
  const extractedSmoke = JSON.parse(await docker(...smokeArgs, '--tmpfs', '/app:ro,nosuid,size=1m', '--mount', `type=bind,source=${payload},target=/release,readonly`, '--workdir', '/release', '--env', 'NODE_PATH=', app.id, 'node', '--input-type=module', '-e', "import assert from 'node:assert/strict';import{readdir}from'node:fs/promises';assert.equal(process.cwd(),'/release');assert.deepEqual(await readdir('/app'),[]);assert.equal(process.env.NODE_PATH,'');await import('/release/server/workbench/deployment/app-smoke.mjs');"));
  const runtimeReport = join(root, 'runtime-isolation.json');
  await exec(process.execPath, ['server/workbench/remote-runtime/docker-qa.mjs'], { env: { ...localEnv, REQUIRE_REMOTE_DOCKER_QA: 'true', REMOTE_DOCKER_QA_REPORT: runtimeReport }, timeout: 180000, maxBuffer: 1024 * 1024 });
  const isolation = JSON.parse(await readFile(runtimeReport, 'utf8'));
  assert.equal(isolation.status, 'PASS');
  assert.equal(isolation.imageId, manifest.images.find(image => image.role === 'renderer').id);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(reportDirectory, { recursive: true });
  const manifestBytes = await readFile(join(directory, 'manifest.json'));
  assert.equal(createHash('sha256').update(manifestBytes).digest('hex'), manifestSha256);
  await writeFile(join(reportDirectory, 'manifest.json'), manifestBytes);
  await writeFile(join(reportDirectory, 'remote-runtime-isolation.json'), `${JSON.stringify(isolation, null, 2)}\n`);
  const report = { status: 'PASS', sourceSha, classification: 'synthetic', manifestSha256, originalImagesAbsentBeforeRestore: true, sameImageIdsAfterRestore: true, imageSmoke, extractedSmoke, originalAppMaskedDuringExtractedSmoke: true, sourceCheckoutMounted: false, rendererIsolation: isolation.status, archiveStorage: 'job-temporary-deleted', deliveryComplete: false, productionReads: 0 };
  await writeFile(join(reportDirectory, 'roundtrip.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  if (extractionContainer) await docker('rm', extractionContainer).catch(() => {});
  await rm(root, { recursive: true, force: true });
}
