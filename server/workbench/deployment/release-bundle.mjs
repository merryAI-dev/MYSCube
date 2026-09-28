import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_LIMIT = 64 * 1024;
const ARCHIVE_LIMIT = 8 * 1024 ** 3;
const READ_CHUNK = 1024 * 1024;
const READ_BUDGET_MS = 5 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
const SHA1 = /^[a-f0-9]{40}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const FILES = ['app.docker.tar', 'manifest.json', 'renderer.docker.tar'];
const IMAGE_ROLES = {
  app: { tag: 'myscube-workbench-app:release', archive: 'app.docker.tar' },
  renderer: { tag: 'myscube-axr-renderer:1.58.2-v1', archive: 'renderer.docker.tar' },
};
const verifiedBundles = new WeakMap();

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function exactObject(value, keys, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    fail('release_schema_invalid', `${name}: expected fields do not match.`);
  }
}

function requireValue(condition, message) {
  if (!condition) fail('release_schema_invalid', message);
}

function validateManifest(manifest) {
  exactObject(manifest, ['schemaVersion', 'format', 'sourceSha', 'classification', 'platform', 'requirements', 'build', 'images'], 'manifest');
  requireValue(manifest.schemaVersion === 1 && manifest.format === 'docker-save', 'Unsupported release format.');
  requireValue(typeof manifest.sourceSha === 'string' && SHA1.test(manifest.sourceSha), 'Invalid release source SHA.');
  requireValue(['synthetic', 'production_candidate'].includes(manifest.classification), 'Invalid release classification.');
  exactObject(manifest.platform, ['os', 'architecture'], 'platform');
  requireValue(manifest.platform.os === 'linux' && ['amd64', 'arm64'].includes(manifest.platform.architecture), 'Unsupported release platform.');
  exactObject(manifest.requirements, ['nodeMajor', 'libc', 'minimumGlibc', 'docker'], 'requirements');
  requireValue(manifest.requirements.nodeMajor === 24 && manifest.requirements.libc === 'glibc'
    && manifest.requirements.minimumGlibc === '2.36' && manifest.requirements.docker === 'local-linux', 'Unsupported runtime requirements.');
  exactObject(manifest.build, ['nodeVersion', 'auth', 'locks'], 'build');
  requireValue(typeof manifest.build.nodeVersion === 'string' && /^v24\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.build.nodeVersion), 'A Node 24 build is required.');
  exactObject(manifest.build.auth, ['projectId', 'domain', 'apiKeySha256'], 'build.auth');
  requireValue(typeof manifest.build.auth.projectId === 'string' && /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(manifest.build.auth.projectId), 'Invalid authentication project identifier.');
  requireValue(typeof manifest.build.auth.domain === 'string' && manifest.build.auth.domain.length <= 253
    && manifest.build.auth.domain.split('.').length >= 2 && manifest.build.auth.domain.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && /\.[a-z]{2,63}$/.test(manifest.build.auth.domain), 'Invalid authentication domain.');
  requireValue(typeof manifest.build.auth.apiKeySha256 === 'string' && SHA256.test(manifest.build.auth.apiKeySha256), 'Invalid authentication key digest.');
  requireValue(manifest.classification !== 'production_candidate'
    || (!/^(demo-|synthetic(?:-|$)|test-)/.test(manifest.build.auth.projectId)
      && !/(?:^|\.)(invalid|localhost|test)$/.test(manifest.build.auth.domain)), 'Synthetic authentication settings cannot describe a production candidate.');
  exactObject(manifest.build.locks, ['root', 'workbench'], 'build.locks');
  for (const digest of Object.values(manifest.build.locks)) requireValue(typeof digest === 'string' && SHA256.test(digest), 'Invalid dependency lock digest.');
  requireValue(Array.isArray(manifest.images) && manifest.images.length === 2, 'Exactly two release images are required.');
  const roles = new Set(), ids = new Set();
  for (const image of manifest.images) {
    exactObject(image, ['role', 'tag', 'id', 'archive', 'bytes', 'sha256'], 'image');
    requireValue(typeof image.role === 'string' && Object.hasOwn(IMAGE_ROLES, image.role) && !roles.has(image.role), 'Release image roles must be distinct.');
    roles.add(image.role);
    const expected = IMAGE_ROLES[image.role];
    requireValue(image.tag === expected.tag && image.archive === expected.archive, 'Release image tag or archive does not match its role.');
    requireValue(typeof image.id === 'string' && IMAGE_ID.test(image.id) && !ids.has(image.id), 'Release image identifiers must be valid and distinct.');
    ids.add(image.id);
    requireValue(Number.isSafeInteger(image.bytes) && image.bytes > 0 && image.bytes <= ARCHIVE_LIMIT, 'Release image size is outside its limit.');
    requireValue(typeof image.sha256 === 'string' && SHA256.test(image.sha256), 'Invalid image archive digest.');
  }
  return manifest;
}

function sameFile(left, right) {
  return ['dev', 'ino', 'size', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => left[key] === right[key]);
}

function checkFile(info, limit) {
  if (!info.isFile() || info.nlink !== 1n || info.size <= 0n || info.size > BigInt(limit)) {
    fail('release_file_invalid', 'Release files must be nonempty, bounded regular files with one link.');
  }
}

async function checkDirectory(directory, expected) {
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(directory) !== directory
    || (expected && !sameFile(info, expected))) fail('release_directory_changed', 'Release directory is not a stable, direct directory.');
  const names = (await readdir(directory)).sort();
  if (names.length !== FILES.length || names.some((name, index) => name !== FILES[index])) {
    fail('release_directory_entries', 'Only manifest.json and the two declared archives are permitted.');
  }
  return info;
}

async function readCheckedFile(directory, name, limit, deadline, expectedSize) {
  const filename = join(directory, name);
  const before = await lstat(filename, { bigint: true });
  checkFile(before, limit);
  if (expectedSize !== undefined && before.size !== BigInt(expectedSize)) fail('release_size_mismatch', 'Archive size does not match the manifest.');
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    checkFile(opened, limit);
    if (!sameFile(before, opened)) fail('release_file_changed', 'A release file changed before reading.');
    const digest = createHash('sha256'), parts = [];
    const buffer = Buffer.alloc(Math.min(limit, READ_CHUNK));
    let bytes = 0;
    while (bytes < Number(opened.size)) {
      if (Date.now() > deadline) fail('release_read_timeout', 'Release verification exceeded its read budget.');
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(opened.size) - bytes), bytes);
      if (!bytesRead) fail('release_file_changed', 'A release file was truncated while reading.');
      digest.update(buffer.subarray(0, bytesRead));
      if (name === 'manifest.json') parts.push(Buffer.from(buffer.subarray(0, bytesRead)));
      bytes += bytesRead;
    }
    const { bytesRead: extra } = await handle.read(buffer, 0, 1, bytes);
    const after = await handle.stat({ bigint: true });
    const current = await lstat(filename, { bigint: true });
    if (extra || !sameFile(opened, after) || !sameFile(opened, current)) fail('release_file_changed', 'A release file changed while reading.');
    return { sha256: digest.digest('hex'), info: after, contents: name === 'manifest.json' ? Buffer.concat(parts) : undefined };
  } finally {
    await handle.close();
  }
}

function freezeTree(value) {
  for (const child of Object.values(value)) if (child && typeof child === 'object') freezeTree(child);
  return Object.freeze(value);
}

export async function verifyReleaseBundle(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))
    || ['directory', 'expectedManifestSha256', 'expectedSourceSha'].some(key => !Object.hasOwn(input, key))
    || Object.keys(input).some(key => !['directory', 'expectedManifestSha256', 'expectedSourceSha', 'forProduction'].includes(key))) {
    fail('release_input_invalid', 'Release verification input is invalid.');
  }
  const { directory, expectedManifestSha256, expectedSourceSha, forProduction = false } = input;
  if (typeof directory !== 'string' || !directory || directory.length > 4096 || /[\x00-\x1f\x7f]/.test(directory)
    || typeof expectedManifestSha256 !== 'string' || !SHA256.test(expectedManifestSha256)
    || typeof expectedSourceSha !== 'string' || !SHA1.test(expectedSourceSha) || typeof forProduction !== 'boolean') {
    fail('release_input_invalid', 'A directory and externally trusted manifest digest and source SHA are required.');
  }
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') fail('release_host_unsupported', 'This host cannot safely open release files.');
  const requestedDirectory = resolve(directory), deadline = Date.now() + READ_BUDGET_MS;
  const requestedInfo = await lstat(requestedDirectory, { bigint: true });
  if (!requestedInfo.isDirectory() || requestedInfo.isSymbolicLink()) fail('release_directory_changed', 'Release directory cannot be a symbolic link.');
  const absoluteDirectory = await realpath(requestedDirectory);
  const directoryInfo = await checkDirectory(absoluteDirectory, requestedInfo);
  const files = new Map();
  const manifestFile = await readCheckedFile(absoluteDirectory, 'manifest.json', MANIFEST_LIMIT, deadline);
  files.set('manifest.json', manifestFile.info);
  if (manifestFile.sha256 !== expectedManifestSha256) fail('release_manifest_digest_mismatch', 'Manifest digest does not match the externally trusted digest.');
  let parsed;
  try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestFile.contents)); }
  catch { fail('release_manifest_invalid', 'Release manifest must be valid UTF-8 JSON.'); }
  const manifest = validateManifest(parsed);
  if (manifest.sourceSha !== expectedSourceSha) fail('release_source_mismatch', 'Release source SHA does not match the expected source.');
  if (forProduction && manifest.classification !== 'production_candidate') fail('release_synthetic_forbidden', 'Synthetic bundles cannot produce a production installation plan.');
  for (const image of manifest.images) {
    const archive = await readCheckedFile(absoluteDirectory, image.archive, ARCHIVE_LIMIT, deadline, image.bytes);
    if (archive.sha256 !== image.sha256) fail('release_archive_digest_mismatch', 'Archive digest does not match the trusted manifest.');
    files.set(image.archive, archive.info);
  }
  for (const [name, info] of files) {
    if (!sameFile(info, await lstat(join(absoluteDirectory, name), { bigint: true }))) fail('release_file_changed', 'A release file changed after reading.');
  }
  await checkDirectory(absoluteDirectory, directoryInfo);
  const result = freezeTree({ directory: absoluteDirectory, manifest, manifestSha256: manifestFile.sha256, sourceSha: manifest.sourceSha, forProduction });
  verifiedBundles.set(result, result);
  return result;
}

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

export function renderReleaseInstallPlan(verified) {
  if (!verified || !verifiedBundles.has(verified)) fail('release_plan_unverified', 'Only this verifier\'s result can produce a plan.');
  const snapshot = verifiedBundles.get(verified);
  if (!snapshot.forProduction || snapshot.manifest.classification !== 'production_candidate') fail('release_plan_production_required', 'A verified production candidate is required; synthetic bundles cannot produce this plan.');
  const docker = "env -u DOCKER_HOST -u DOCKER_CONTEXT docker --host 'unix:///var/run/docker.sock'";
  const lines = [
    '# PRINT-ONLY: prepared archive restoration instructions. Nothing has been installed or deployed.',
    '# Verification describes the files when checked, not their future contents. Re-verify immediately before use.',
    '# Use the reviewed verifier from the expected source checkout; the digest must come from an independent trusted channel.',
    `# Source: ${snapshot.sourceSha}; platform: linux/${snapshot.manifest.platform.architecture}.`,
    '# Approved local Linux Docker host only. Node 24 and glibc >= 2.36 are required for host-side tools.',
    '# Image IDs and archive hashes do not prove image internals, secret absence, provenance, or permission to deploy.',
    '# Obtain exclusive host maintenance access. Existing different image tags stop this plan; do not overwrite them automatically.',
    '# No container is started, no running service is stopped, and no credentials, systemd units or IAM are installed.',
    'set -eu',
    `node ${quote(fileURLToPath(import.meta.url))} verify --directory ${quote(snapshot.directory)} --manifest-sha256 ${quote(snapshot.manifestSha256)} --source-sha ${quote(snapshot.sourceSha)} --for-production`,
  ];
  for (const image of snapshot.manifest.images) {
    lines.push(
      '',
      `# ${image.role}: checked archive ${image.archive}, ${image.bytes} bytes, sha256 ${image.sha256}.`,
      `existing_id="$(${docker} image inspect --format '{{.Id}}' ${quote(image.tag)} 2>/dev/null || true)"`,
      `if [ -n "$existing_id" ] && [ "$existing_id" != ${quote(image.id)} ]; then`,
      `  printf '%s\\n' ${quote(`Stop: ${image.tag} already identifies another image. Installer review is required.`)} >&2`,
      '  exit 1',
      'fi',
      `${docker} load --input ${quote(join(snapshot.directory, image.archive))}`,
      `[ "$(${docker} image inspect --format '{{.Id}}' ${quote(image.id)})" = ${quote(image.id)} ]`,
      `[ "$(${docker} image inspect --format '{{.Os}}/{{.Architecture}}' ${quote(image.id)})" = ${quote(`linux/${snapshot.manifest.platform.architecture}`)} ]`,
      `${docker} tag ${quote(image.id)} ${quote(image.tag)}`,
      `[ "$(${docker} image inspect --format '{{.Id}}' ${quote(image.tag)})" = ${quote(image.id)} ]`,
    );
  }
  lines.push('', '# If application files must be extracted, review an isolated inspection container and an explicit path allowlist first.',
    '# Do not unpack the Docker archive into the host filesystem or execute scripts found in it.',
    '# Restored local image tags are not a service deployment or evidence of successful delivery.', '');
  return lines.join('\n');
}

async function main(argv) {
  const [command, ...args] = argv;
  if (!['verify', 'plan'].includes(command)) fail('release_cli_invalid', 'Use verify or plan.');
  const input = {}, names = { '--directory': 'directory', '--manifest-sha256': 'expectedManifestSha256', '--source-sha': 'expectedSourceSha' };
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--for-production' && command === 'verify' && !Object.hasOwn(input, 'forProduction')) { input.forProduction = true; continue; }
    if (!Object.hasOwn(names, key) || Object.hasOwn(input, names[key]) || !args[index + 1] || args[index + 1].startsWith('--')) fail('release_cli_invalid', 'CLI arguments are missing, duplicated or unsupported.');
    input[names[key]] = args[++index];
  }
  if (command === 'plan') input.forProduction = true;
  const verified = await verifyReleaseBundle(input);
  if (command === 'plan') process.stdout.write(renderReleaseInstallPlan(verified));
  else process.stdout.write(`${JSON.stringify({ verified: true, manifestSha256: verified.manifestSha256, sourceSha: verified.sourceSha, classification: verified.manifest.classification, forProduction: verified.forProduction })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => {
    process.stderr.write(`Release bundle verification failed (${typeof error.code === 'string' && /^release_[a-z_]+$/.test(error.code) ? error.code : 'release_read_failed'}). No Docker, extraction or deployment command was executed.\n`);
    process.exitCode = 1;
  });
}
