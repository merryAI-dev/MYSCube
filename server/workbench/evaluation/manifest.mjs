import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export const EVALUATION_SOURCE_ROOTS = Object.freeze(['shared', 'server/workbench', 'server/bff', 'server/mcp', 'src/app/platform', 'policies']);
export const EVALUATION_REQUIRED_FILES = Object.freeze(['package.json', 'package-lock.json', 'server/workbench/package.json', 'server/workbench/package-lock.json',
  'server/workbench/evaluation/run-acceptance.mjs', 'server/workbench/evaluation/acceptance-cases.mjs', 'server/workbench/react-compiler.mjs']);
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/, IMAGE = /^sha256:[a-f0-9]{64}$/;
const MAX_FILE = 8 * 1024 ** 2, MAX_TOTAL = 64 * 1024 ** 2, MAX_MANIFEST = 2 * 1024 ** 2, MAX_FILES = 4096;
const coverage = 'fixed-runtime-source-superset-v1';
const hash = (value) => createHash('sha256').update(value).digest('hex');
const fail = (message) => { throw Object.assign(new Error(message), { code: 'evaluation_manifest_invalid' }); };
const requireValue = (condition, message) => { if (!condition) fail(message); };
const object = (value, fields) => requireValue(value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && Object.keys(value).length === fields.length
  && fields.every((key) => Object.hasOwn(value, key)), 'Manifest fields do not match the declared contract.');
const same = (left, right) => ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every((key) => left[key] === right[key]);
const freeze = (value) => { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; };
const stable = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const validPath = (path) => typeof path === 'string' && path.length <= 240 && /^[A-Za-z0-9_-][A-Za-z0-9_./-]*$/.test(path)
  && path.split('/').every((part) => part && !part.startsWith('.') && !['node_modules', 'nodecache', 'coverage', 'test-results', 'dist', 'reports', 'results'].includes(part));
const sourcePath = (path) => validPath(path) && (EVALUATION_REQUIRED_FILES.includes(path)
  || EVALUATION_SOURCE_ROOTS.some((root) => path.startsWith(`${root}/`)) && !/\.(?:test|spec)\./.test(path)
    && (/\.(?:mjs|cjs|js|ts|tsx|mts|cts)$/.test(path) || basename(path) === 'Dockerfile' || path.startsWith('policies/') && path.endsWith('.json')));
const evidencePath = (path) => validPath(path) && (path.startsWith('server/workbench/evaluation/') && /\.(?:mjs|json)$/.test(path)
  && !/(?:manifest|report|result)\.json$/.test(path) || path === 'server/workbench/cashflow-inflow-fixture.mjs');
function paths(value) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= 64 && value.every(evidencePath)
    && new Set(value).size === value.length, 'Oracle and fixture paths must be unique declared evaluation source files.');
  return value.slice().sort();
}
function platform(value) {
  object(value, ['os', 'architecture']);
  requireValue(value.os === 'linux' && ['amd64', 'arm64'].includes(value.architecture), 'Evaluation requires a declared Linux renderer platform.');
}
function identity(value) {
  object(value, ['id', 'revision', 'classification', 'os', 'architecture']);
  requireValue(matches(IMAGE, value.id) && matches(SHA, value.revision) && ['synthetic', 'production_candidate'].includes(value.classification), 'Invalid renderer identity.');
  platform({ os: value.os, architecture: value.architecture });
}
function records(value, predicate) {
  requireValue(Array.isArray(value) && value.length > 0 && value.length <= MAX_FILES, 'Invalid source file inventory.');
  let previous = '', total = 0;
  for (const item of value) {
    object(item, ['path', 'bytes', 'sha256']);
    requireValue(predicate(item.path) && item.path > previous && Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_FILE && matches(HASH, item.sha256), 'Invalid, unsorted or duplicate source file record.');
    previous = item.path; total += item.bytes;
  }
  requireValue(total <= MAX_TOTAL, 'Source inventory exceeds its byte budget.');
}
export function validateEvaluationManifest(manifest) {
  object(manifest, ['schemaVersion', 'source', 'renderer', 'oracles', 'fixtures']);
  requireValue(manifest.schemaVersion === 1, 'Unsupported evaluation manifest version.');
  object(manifest.source, ['kind', 'sha', 'archiveSha256', 'coverage', 'files']);
  requireValue(manifest.source.kind === 'git-archive' && matches(SHA, manifest.source.sha) && matches(HASH, manifest.source.archiveSha256)
    && manifest.source.coverage === coverage, 'Source provenance requires externally supplied archive and commit digests.');
  records(manifest.source.files, sourcePath); records(manifest.oracles, evidencePath); records(manifest.fixtures, evidencePath);
  requireValue(manifest.oracles.length <= 64 && manifest.fixtures.length <= 64, 'Too many oracle or fixture files.');
  for (const required of EVALUATION_REQUIRED_FILES) requireValue(manifest.source.files.some((item) => item.path === required), `Required source file is missing: ${required}`);
  identity(manifest.renderer); requireValue(manifest.renderer.revision === manifest.source.sha, 'Renderer revision differs from the source commit.');
  requireValue(Buffer.byteLength(`${stable(manifest)}\n`) <= MAX_MANIFEST, 'Evaluation manifest is too large.');
  return manifest;
}
export function evaluationManifestDigest(manifest) { return hash(`${stable(validateEvaluationManifest(manifest))}\n`); }

async function directoryRoot(directory) {
  requireValue(typeof directory === 'string' && directory.length > 0, 'An explicit candidate source directory is required.');
  const requested = resolve(directory), before = await lstat(requested, { bigint: true });
  requireValue(before.isDirectory() && !before.isSymbolicLink(), 'Candidate source directory must not be a symlink.');
  const canonical = await realpath(requested), after = await lstat(canonical, { bigint: true });
  requireValue(same(before, after), 'Candidate directory changed while resolving it.');
  return { root: canonical, requested, before };
}
async function checkedFile(root, path, deadline, collect = false, limit = MAX_FILE) {
  requireValue(validPath(path) && performance.now() < deadline, 'Invalid file path or exceeded file inspection time budget.');
  const name = join(root, path), before = await lstat(name, { bigint: true });
  requireValue(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.size <= BigInt(limit)
    && await realpath(name) === name, 'Evaluation inputs must be direct bounded regular files without hard links.');
  const handle = await open(name, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireValue(same(before, await handle.stat({ bigint: true })), 'Evaluation file was substituted before reading.');
    const digest = createHash('sha256'), parts = [], buffer = Buffer.alloc(256 * 1024); let bytes = 0;
    for (;;) {
      requireValue(performance.now() < deadline, 'Evaluation file inspection exceeded its time budget.');
      const chunk = await handle.read(buffer, 0, buffer.length, null); if (!chunk.bytesRead) break;
      bytes += chunk.bytesRead; requireValue(bytes <= limit, 'Evaluation input grew beyond its byte limit.');
      digest.update(buffer.subarray(0, chunk.bytesRead)); if (collect) parts.push(Buffer.from(buffer.subarray(0, chunk.bytesRead)));
    }
    requireValue(BigInt(bytes) === before.size && same(before, await handle.stat({ bigint: true }))
      && same(before, await lstat(name, { bigint: true })) && await realpath(name) === name, 'Evaluation file changed while reading.');
    return { record: { path, bytes, sha256: digest.digest('hex') }, before, ...(collect ? { text: Buffer.concat(parts).toString('utf8') } : {}) };
  } finally { await handle.close(); }
}
async function inventory(directory, oraclePaths, fixturePaths) {
  const target = await directoryRoot(directory), deadline = performance.now() + 120000;
  const directories = new Map(), names = new Set(EVALUATION_REQUIRED_FILES), snapshots = new Map();
  const visit = async (path) => {
    requireValue(directories.size <= MAX_FILES && performance.now() < deadline, 'Source directory inventory exceeds its limit.');
    const name = join(target.root, path), before = await lstat(name, { bigint: true });
    requireValue(before.isDirectory() && !before.isSymbolicLink() && await realpath(name) === name, 'Source directories must not contain symlinks.');
    directories.set(name, before);
    for (const entry of (await readdir(name, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${path}/${entry.name}`; if (!validPath(relative)) continue;
      requireValue(!entry.isSymbolicLink(), 'Source inventories cannot include symlinks.');
      if (entry.isDirectory()) await visit(relative);
      else if (sourcePath(relative)) names.add(relative);
      requireValue(names.size <= MAX_FILES, 'Too many source files.');
    }
  };
  for (const path of EVALUATION_SOURCE_ROOTS) await visit(path);
  let total = 0;
  for (const path of [...new Set([...names, ...oraclePaths, ...fixturePaths])].sort()) {
    const value = await checkedFile(target.root, path, deadline); total += value.record.bytes;
    requireValue(total <= MAX_TOTAL, 'Source inventory exceeds its total byte budget.'); snapshots.set(path, value);
  }
  for (const [path, snapshot] of snapshots) requireValue(same(snapshot.before, await lstat(join(target.root, path), { bigint: true })), 'A source file changed during inventory.');
  for (const [path, before] of directories) requireValue(same(before, await lstat(path, { bigint: true })) && await realpath(path) === path, 'A source directory changed during inventory.');
  requireValue(same(target.before, await lstat(target.requested, { bigint: true })) && await realpath(target.requested) === target.root, 'Candidate directory was replaced during inventory.');
  return { files: [...names].sort().map((path) => snapshots.get(path).record), oracles: oraclePaths.map((path) => snapshots.get(path).record), fixtures: fixturePaths.map((path) => snapshots.get(path).record) };
}

const inspectFormat = '{"id":{{json .Id}},"revision":{{json (index .Config.Labels "org.opencontainers.image.revision")}},"classification":{{json (index .Config.Labels "io.myscube.workbench.classification")}},"os":{{json .Os}},"architecture":{{json .Architecture}}}';
export async function inspectEvaluationRenderer({ imageId, execute = promisify(execFile) }) {
  requireValue(typeof imageId === 'string' && matches(IMAGE, imageId), 'An immutable sha256 image ID is required; tags are not accepted.');
  const configuration = await mkdtemp('/tmp/myscube-evaluation-docker-');
  try {
    const result = await execute('docker', ['--host', 'unix:///var/run/docker.sock', '--config', configuration, 'image', 'inspect', '--format', inspectFormat, imageId],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 65536 });
    requireValue(typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= 65536, 'Invalid bounded Docker inspection response.');
    let value; try { value = JSON.parse(result.stdout); } catch { fail('Docker image inspection did not return the fixed JSON identity.'); }
    identity(value); requireValue(value.id === imageId, 'Docker returned a different immutable image ID.'); return value;
  } catch (error) { if (error?.code === 'evaluation_manifest_invalid') throw error; fail('Local immutable renderer inspection failed.'); }
  finally { await rm(configuration, { recursive: true, force: true }); }
}
const inspectDefault = (imageId) => inspectEvaluationRenderer({ imageId });
async function renderer(inspectImage, imageId, sourceSha, classification, expectedPlatform) {
  requireValue(typeof imageId === 'string' && matches(IMAGE, imageId), 'An immutable renderer image ID is required.');
  const value = await inspectImage(imageId); identity(value);
  requireValue(value.id === imageId && value.revision === sourceSha && value.classification === classification
    && value.os === expectedPlatform.os && value.architecture === expectedPlatform.architecture, 'Renderer identity, source revision, classification or platform differs.');
  return { ...value };
}
export async function createEvaluationManifest({ directory, sourceSha, archiveSha256, rendererImageId, classification, platform: expectedPlatform, oraclePaths, fixturePaths, inspectImage = inspectDefault }) {
  requireValue(typeof sourceSha === 'string' && matches(SHA, sourceSha) && typeof archiveSha256 === 'string' && matches(HASH, archiveSha256), 'Externally verified source commit and archive SHA256 are required.');
  requireValue(['synthetic', 'production_candidate'].includes(classification), 'An explicit image classification is required.'); platform(expectedPlatform);
  const selectedPlatform = { ...expectedPlatform };
  const oracles = paths(oraclePaths), fixtures = paths(fixturePaths);
  const snapshot = await inventory(directory, oracles, fixtures);
  const image = await renderer(inspectImage, rendererImageId, sourceSha, classification, selectedPlatform);
  const after = await inventory(directory, oracles, fixtures); requireValue(stable(snapshot) === stable(after), 'Source files changed during renderer inspection.');
  const manifest = { schemaVersion: 1, source: { kind: 'git-archive', sha: sourceSha, archiveSha256, coverage, files: snapshot.files }, renderer: image, oracles: snapshot.oracles, fixtures: snapshot.fixtures };
  return freeze({ manifest, manifestSha256: evaluationManifestDigest(manifest) });
}
export async function verifyEvaluationManifest({ directory, manifest, expectedManifestSha256, expectedSourceSha, expectedArchiveSha256, expectedRendererImageId, inspectImage = inspectDefault }) {
  requireValue(typeof expectedManifestSha256 === 'string' && matches(HASH, expectedManifestSha256) && matches(SHA, expectedSourceSha) && matches(HASH, expectedArchiveSha256) && matches(IMAGE, expectedRendererImageId), 'Externally trusted manifest, source, archive and image digests are required.');
  const snapshot = JSON.parse(stable(validateEvaluationManifest(manifest)));
  requireValue(evaluationManifestDigest(snapshot) === expectedManifestSha256 && snapshot.source.sha === expectedSourceSha && snapshot.source.archiveSha256 === expectedArchiveSha256 && snapshot.renderer.id === expectedRendererImageId, 'Evaluation identity does not match the externally trusted digests.');
  const current = await createEvaluationManifest({ directory, sourceSha: expectedSourceSha, archiveSha256: expectedArchiveSha256, rendererImageId: expectedRendererImageId,
    classification: snapshot.renderer.classification, platform: { os: snapshot.renderer.os, architecture: snapshot.renderer.architecture }, oraclePaths: snapshot.oracles.map((item) => item.path), fixturePaths: snapshot.fixtures.map((item) => item.path), inspectImage });
  requireValue(current.manifestSha256 === expectedManifestSha256, 'Candidate source, oracle, fixture or image changed since the manifest was recorded.');
  return freeze({ ...current, rendererImageId: expectedRendererImageId });
}
export async function writeEvaluationManifest({ file, manifest }) {
  const snapshot = JSON.parse(stable(validateEvaluationManifest(manifest))), digest = evaluationManifestDigest(snapshot);
  const text = `${stable(snapshot)}\n`, location = resolve(file), parent = await directoryRoot(dirname(location));
  requireValue(basename(location).endsWith('.json') && validPath(basename(location)), 'Manifest output must be an explicit JSON filename.');
  const name = join(parent.root, basename(location)), handle = await open(name, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  const saved = await readEvaluationManifest({ file: name, expectedManifestSha256: digest });
  return { manifestSha256: evaluationManifestDigest(saved) };
}
export async function readEvaluationManifest({ file, expectedManifestSha256 }) {
  requireValue(typeof expectedManifestSha256 === 'string' && matches(HASH, expectedManifestSha256), 'The trusted manifest digest is required before reading.');
  const location = resolve(file), parent = await directoryRoot(dirname(location));
  const read = await checkedFile(parent.root, basename(location), performance.now() + 10000, true, MAX_MANIFEST);
  requireValue(same(parent.before, await lstat(parent.requested, { bigint: true })) && await realpath(parent.requested) === parent.root, 'Manifest directory changed while reading.');
  requireValue(read.record.sha256 === expectedManifestSha256, 'Manifest file bytes differ from the trusted digest.');
  let manifest; try { manifest = JSON.parse(read.text); } catch { fail('Evaluation manifest is not valid JSON.'); }
  requireValue(evaluationManifestDigest(manifest) === expectedManifestSha256, 'Recorded evaluation manifest does not match its trusted digest.'); return freeze(manifest);
}
