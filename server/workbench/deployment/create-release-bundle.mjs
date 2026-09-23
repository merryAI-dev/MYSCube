import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { constants, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MAX_ARCHIVE_BYTES = 8 * 1024 ** 3;
const ROLES = Object.freeze([
  { role: 'app', tag: 'myscube-workbench-app:release', archive: 'app.docker.tar' },
  { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', archive: 'renderer.docker.tar' },
]);
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const invalid = () => new Error('Release bundle could not be verified. Check local image labels, build metadata, platform and private output directory.');
const sha256 = value => createHash('sha256').update(value).digest('hex');

async function executeDocker(args, { timeoutMs, maxBuffer, stdoutFile }) {
  const child = spawn('docker', args, { shell: false, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let failure, output = '', errorBytes = 0, outputBytes = 0;
  const kill = error => { failure ||= error; child.kill('SIGKILL'); };
  const timer = setTimeout(() => kill(invalid()), timeoutMs);
  child.stderr.on('data', data => { errorBytes += data.length; if (errorBytes > maxBuffer) kill(invalid()); });
  const ended = new Promise((resolveExit, reject) => { child.once('error', reject); child.once('close', code => code === 0 && !failure ? resolveExit() : reject(invalid())); });
  let streamed;
  if (stdoutFile) {
    const limit = new Transform({ transform(chunk, _encoding, callback) { outputBytes += chunk.length; callback(outputBytes > MAX_ARCHIVE_BYTES ? invalid() : null, chunk); } });
    streamed = pipeline(child.stdout, limit, createWriteStream(stdoutFile, { flags: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode: 0o600 })).catch(error => { kill(error); throw invalid(); });
  } else {
    child.stdout.on('data', data => { outputBytes += data.length; if (outputBytes > maxBuffer) kill(invalid()); else output += data.toString('utf8'); });
    streamed = Promise.resolve();
  }
  try { await Promise.all([ended, streamed]); return output; } catch { kill(invalid()); await Promise.allSettled([ended, streamed]); throw invalid(); } finally { clearTimeout(timer); }
}

function inspectImage(raw, expected, sourceSha, classification) {
  let items;
  try { items = JSON.parse(raw); } catch { throw invalid(); }
  if (!Array.isArray(items) || items.length !== 1) throw invalid();
  const value = items[0];
  if (!IMAGE_ID.test(value.Id || '') || value.Os !== 'linux' || !['amd64', 'arm64'].includes(value.Architecture)
    || value.Config?.Labels?.['org.opencontainers.image.revision'] !== sourceSha
    || value.Config?.Labels?.['io.myscube.workbench.classification'] !== classification
    || !Array.isArray(value.RepoTags) || !value.RepoTags.includes(expected.tag)) throw invalid();
  return { ...expected, id: value.Id, platform: { os: 'linux', architecture: value.Architecture } };
}

function buildMetadata(raw, sourceSha, classification, platform) {
  let value;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  const sameKeys = (object, keys) => object && typeof object === 'object' && !Array.isArray(object) && Object.keys(object).sort().join(',') === [...keys].sort().join(',');
  if (!sameKeys(value, ['schemaVersion', 'sourceSha', 'classification', 'platform', 'nodeVersion', 'auth', 'locks'])
    || value.schemaVersion !== 1 || value.sourceSha !== sourceSha || value.classification !== classification
    || !sameKeys(value.platform, ['os', 'architecture']) || value.platform.os !== platform.os || value.platform.architecture !== platform.architecture
    || typeof value.nodeVersion !== 'string' || !/^v24\.\d+\.\d+$/.test(value.nodeVersion)
    || !sameKeys(value.auth, ['projectId', 'domain', 'apiKeySha256'])
    || typeof value.auth.projectId !== 'string' || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(value.auth.projectId)
    || typeof value.auth.domain !== 'string' || !/^(?=.{1,253}$)[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/.test(value.auth.domain)
    || !HASH.test(value.auth.apiKeySha256 || '') || !sameKeys(value.locks, ['root', 'workbench'])
    || !HASH.test(value.locks.root || '') || !HASH.test(value.locks.workbench || '')) throw invalid();
  if (classification === 'synthetic' && !value.auth.projectId.startsWith('demo-')) throw invalid();
  if (classification === 'production_candidate' && (/^(demo-|synthetic(?:-|$)|test-)/.test(value.auth.projectId) || /(?:^|\.)(invalid|localhost|test)$/.test(value.auth.domain))) throw invalid();
  return { nodeVersion: value.nodeVersion, auth: value.auth, locks: value.locks };
}

async function archiveDigest(path, deadline) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size <= 0 || before.size > MAX_ARCHIVE_BYTES || (before.mode & 0o777) !== 0o600) throw invalid();
    const hash = createHash('sha256'); let bytes = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) { bytes += chunk.length; if (bytes > MAX_ARCHIVE_BYTES || Date.now() > deadline) throw invalid(); hash.update(chunk); }
    const after = await file.stat();
    if (bytes !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw invalid();
    return { bytes, sha256: hash.digest('hex') };
  } finally { await file.close(); }
}

export async function createReleaseBundle({ directory, sourceSha, classification, execute = executeDocker, verify, hostPlatform = process.platform }) {
  if (hostPlatform !== 'linux' || typeof directory !== 'string' || !directory || !SHA.test(sourceSha || '') || !['synthetic', 'production_candidate'].includes(classification)) throw invalid();
  const target = resolve(directory);
  if (target === dirname(target)) throw invalid();
  const parent = await lstat(dirname(target));
  if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid();
  // A new private directory owns all partial files; pre-existing paths are never reused or removed.
  await mkdir(target, { mode: 0o700 });
  const config = await mkdtemp(join(tmpdir(), 'workbench-release-docker-'));
  const manifestPath = join(target, 'manifest.json'); let completed = false;
  const deadline = Date.now() + 20 * 60 * 1000;
  const command = (args, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw invalid();
    return execute(['--host', 'unix:///var/run/docker.sock', '--config', config, ...args], { timeoutMs: Math.min(options.stdoutFile ? 10 * 60 * 1000 : 30000, remaining), maxBuffer: 65536, ...options });
  };
  try {
    const images = [];
    for (const role of ROLES) images.push(inspectImage(await command(['image', 'inspect', role.tag]), role, sourceSha, classification));
    if (images[0].id === images[1].id || images[0].platform.architecture !== images[1].platform.architecture) throw invalid();
    const platform = images[0].platform;
    const metadataContainer = `workbench-release-metadata-${randomUUID()}`;
    let metadataRaw, metadataRead = false;
    try {
      metadataRaw = await command(['run', '--name', metadataContainer, '--rm', '--pull', 'never', '--network', 'none', '--read-only', '--memory', '128m', '--memory-swap', '128m', '--cpus', '0.5', '--pids-limit', '32', '--user', '10001:10001', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--log-driver', 'none', '--entrypoint', 'node', images[0].id, '-e', "process.stdout.write(require('node:fs').readFileSync('/app/workbench-build.json','utf8'))"]);
      metadataRead = true;
    } finally {
      if (!metadataRead) await execute(['--host', 'unix:///var/run/docker.sock', '--config', config, 'rm', '-f', metadataContainer], { timeoutMs: 3000, maxBuffer: 65536 }).catch(() => {});
    }
    const build = buildMetadata(metadataRaw, sourceSha, classification, platform);
    const saved = [];
    for (const image of images) {
      const archivePath = join(target, image.archive);
      await command(['image', 'save', image.id], { stdoutFile: archivePath });
      saved.push({ role: image.role, tag: image.tag, id: image.id, archive: image.archive, ...await archiveDigest(archivePath, deadline) });
    }
    const manifest = { schemaVersion: 1, format: 'docker-save', sourceSha, classification, platform, requirements: { nodeMajor: 24, libc: 'glibc', minimumGlibc: '2.36', docker: 'local-linux' }, build, images: saved };
    const bytes = `${JSON.stringify(manifest, null, 2)}\n`, manifestSha256 = sha256(bytes);
    await writeFile(manifestPath, bytes, { flag: 'wx', mode: 0o600 });
    const verifier = verify || (await import('./release-bundle.mjs')).verifyReleaseBundle;
    await verifier({ directory: target, expectedManifestSha256: manifestSha256, expectedSourceSha: sourceSha, forProduction: classification === 'production_candidate' });
    completed = true;
    return { manifestSha256, manifest };
  } catch { throw invalid(); } finally {
    if (!completed) await rm(manifestPath, { force: true }).catch(() => {});
    await rm(config, { recursive: true, force: true }).catch(() => {});
  }
}

export async function main(args = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!['--directory', '--source-sha', '--classification'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw invalid();
    options[args[i]] = args[i + 1];
  }
  if (Object.keys(options).length !== 3) throw invalid();
  const result = await createReleaseBundle({ directory: options['--directory'], sourceSha: options['--source-sha'], classification: options['--classification'] });
  process.stdout.write(`${JSON.stringify({ manifestSha256: result.manifestSha256, sourceSha: result.manifest.sourceSha, classification: result.manifest.classification })}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { process.stderr.write('Release bundle creation failed. No completed bundle is available; check the local image pair and private output directory.\n'); process.exitCode = 1; });
