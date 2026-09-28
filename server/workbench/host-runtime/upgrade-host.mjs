import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, readdir, mkdir, mkdtemp, rename, symlink, chmod, chown, rm } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseBundle } from '../deployment/release-bundle.mjs';
import { renderBootstrapNginx } from './bootstrap-install.mjs';

const exec = promisify(execFile), sha = /^[a-f0-9]{40}$/, hex = /^[a-f0-9]{64}$/, imageId = /^sha256:[a-f0-9]{64}$/;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const exact = (value, keys) => value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).sort().join() === [...keys].sort().join();
export const UPGRADE_PATHS = Object.freeze({ current: '/opt/myscube-workbench', releases: '/opt/myscube-workbench-releases', config: '/etc/myscube-workbench', nginx: '/etc/nginx/conf.d/myscube-workbench.conf', units: '/etc/systemd/system' });
const unitFiles = Object.freeze({ 'myscube-axr-workbench.service': 'host-runtime/systemd/myscube-axr-workbench.service', 'myscube-axr-renderer-reaper.service': 'remote-runtime/systemd/myscube-axr-renderer-reaper.service', 'myscube-axr-renderer-reaper.timer': 'remote-runtime/systemd/myscube-axr-renderer-reaper.timer' });
const appUnit = 'myscube-axr-workbench.service', timerUnit = 'myscube-axr-renderer-reaper.timer';
const tags = { app: 'myscube-workbench-app:release', renderer: 'myscube-axr-renderer:1.58.2-v1' };
const same = (a, b) => ['dev', 'ino', 'size', 'uid', 'mode', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const execute = async (file, args, options = {}) => {
  const { stdout } = await exec(file, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, ...options });
  return Buffer.isBuffer(stdout) ? stdout : stdout.trim();
};

export function validateUpgradePins(value) {
  if (!exact(value, ['sourceSha', 'receiptSha256', 'configurationSha256', 'nginxSha256', 'appImageId', 'rendererImageId']) || !sha.test(value.sourceSha)
    || ![value.receiptSha256, value.configurationSha256, value.nginxSha256].every(value => hex.test(value))
    || ![value.appImageId, value.rendererImageId].every(value => imageId.test(value)) || value.appImageId === value.rendererImageId) fail('upgrade_pins_invalid');
  return Object.freeze({ ...value });
}
function validateOptions(input) {
  if (!input || Object.keys(input).some(key => !['directory', 'sourceSha', 'manifestSha256', 'currentPins', 'apply', 'dedicated'].includes(key))
    || !sha.test(input.sourceSha || '') || !hex.test(input.manifestSha256 || '') || !['directory', 'currentPins'].every(key => typeof input[key] === 'string' && input[key].startsWith('/') && input[key].length < 4096 && !/[\x00-\x1f\x7f]/.test(input[key]))
    || input.apply !== undefined && typeof input.apply !== 'boolean' || input.dedicated !== undefined && typeof input.dedicated !== 'boolean') fail('upgrade_options_invalid');
  return Object.freeze({ ...input });
}
export function renderUpgradeMaintenance(domain) {
  return renderBootstrapNginx(domain).replace('server {\n', 'server {\n  return 503;\n');
}
export function validateUntaggedArchive(manifestRaw, expectedId, indexRaw, blobs = {}) {
  const entries = JSON.parse(manifestRaw);
  if (!imageId.test(expectedId) || !Array.isArray(entries) || entries.length !== 1 || !entries[0] || !Array.isArray(entries[0].Layers)
    || entries[0].RepoTags != null && (!Array.isArray(entries[0].RepoTags) || entries[0].RepoTags.length)
    || !/^(?:[a-f0-9]{64}\.json|blobs\/sha256\/[a-f0-9]{64})$/.test(entries[0].Config || '')) fail('upgrade_archive_tags_or_identity');
  const classicIdentity = [`${expectedId.slice(7)}.json`, `blobs/sha256/${expectedId.slice(7)}`].includes(entries[0].Config);
  if (indexRaw === undefined) { if (!classicIdentity) fail('upgrade_archive_tags_or_identity'); return; }
  const index = JSON.parse(indexRaw);
  if (index.schemaVersion !== 2 || !Array.isArray(index.manifests) || index.manifests.length !== 1 || !classicIdentity && index.manifests[0].digest !== expectedId) fail('upgrade_archive_index_invalid');
  let nodes = 0;
  const visit = (value, depth = 0) => {
    if (++nodes > 32 || depth > 4 || value.schemaVersion !== 2) fail('upgrade_archive_index_invalid');
    for (const object of [value, ...(value.manifests || [])]) for (const key of Object.keys(object.annotations || {})) {
      if (key.includes('ref.name') || key.includes('image.name')) fail('upgrade_archive_tags_or_identity');
    }
    if (value.manifests) for (const descriptor of value.manifests) {
      if (!imageId.test(descriptor.digest || '') || !Number.isSafeInteger(descriptor.size) || descriptor.size < 1 || descriptor.size > 2 * 1024 * 1024) fail('upgrade_archive_index_invalid');
      const bytes = blobs[descriptor.digest];
      if (!bytes || Buffer.byteLength(bytes) !== descriptor.size || `sha256:${digest(bytes)}` !== descriptor.digest) fail('upgrade_archive_blob_invalid');
      visit(JSON.parse(bytes), depth + 1);
    }
  };
  visit(index);
}
export async function readUpgradeFile(path, limit, { uid = 0, secret = false } = {}) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1 || info.size < 1 || info.size > limit || (info.mode & 0o022) || secret && (info.mode & 0o077)) fail('upgrade_file_invalid');
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(info, await fd.stat())) fail('upgrade_file_changed');
    const bytes = Buffer.alloc(limit + 1); let count = 0;
    while (count <= limit) { const part = await fd.read(bytes, count, bytes.length - count, count); if (!part.bytesRead) break; count += part.bytesRead; }
    if (count > limit || !same(info, await fd.stat()) || !same(info, await lstat(path))) fail('upgrade_file_changed');
    return { bytes: bytes.subarray(0, count), assertCurrent: async () => { if (!same(info, await lstat(path))) fail('upgrade_file_changed'); } };
  } finally { await fd.close(); }
}
async function safeDirectory(path, uid = 0) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022) || await realpath(path) !== path) fail('upgrade_directory_invalid');
}
async function durable(path, bytes, mode = 0o600) {
  const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); }
}
async function syncDir(path) { const fd = await open(path, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
async function replaceFile(path, bytes, expectedHash, mode, uid) {
  const previous = await readUpgradeFile(path, 100000, { uid });
  if (digest(previous.bytes) !== expectedHash) fail('upgrade_replace_conflict');
  const staged = `${path}.upgrade-${randomUUID()}`;
  await durable(staged, bytes, mode); await previous.assertCurrent(); await rename(staged, path); await syncDir(dirname(path));
}
export function createUpgradeActions({ run = execute, uid = 0, paths = UPGRADE_PATHS, verify = verifyReleaseBundle, now = () => performance.now(), wait = delay } = {}) {
  const configPath = name => join(paths.config, name), lock = configPath('.upgrade-lock');
  const docker = (...args) => run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args], { timeout: 300000 });
  const unitState = async name => {
    try { return await run('/usr/bin/systemctl', ['is-active', name]); }
    catch (error) { if (error.code === 3 && ['inactive', 'failed'].includes(error.stdout?.trim())) return error.stdout.trim(); throw error; }
  };
  const active = async name => { if (await unitState(name) !== 'active') fail('upgrade_service_not_active'); };
  const inspect = async (id, sourceSha) => {
    const format = '{{json .Id}}\n{{json .Os}}\n{{json .Architecture}}\n{{json (index .Config.Labels "org.opencontainers.image.revision")}}\n{{json (index .Config.Labels "io.myscube.workbench.classification")}}';
    const fields = (await docker('image', 'inspect', '--format', format, id)).split('\n').map(value => JSON.parse(value));
    if (JSON.stringify(fields) !== JSON.stringify([id, 'linux', 'amd64', sourceSha, 'production_candidate'])) fail('upgrade_image_identity');
  };
  const checkTags = async manifest => {
    for (const image of manifest.images) {
      if (JSON.parse(await docker('image', 'inspect', '--format', '{{json .Id}}', image.tag)) !== image.id) fail('upgrade_tag_changed');
      await inspect(image.id, manifest.sourceSha);
    }
  };
  const managedEmpty = async () => {
    if ((await docker('ps', '-aq', '--no-trunc', '--filter', 'label=io.myscube.axr.renderer=v1')).trim()) fail('upgrade_renderers_not_drained');
  };
  const checkUnitFiles = async release => {
    for (const [name, relative] of Object.entries(unitFiles)) {
      const actual = await readUpgradeFile(join(paths.units, name), 20000, { uid });
      const expected = await readUpgradeFile(join(release, 'server/workbench', relative), 20000, { uid });
      if (!actual.bytes.equals(expected.bytes)) fail('upgrade_unit_change_requires_review');
    }
  };
  const checkStatic = async release => {
    const html = await readUpgradeFile(join(release, 'dist-workbench/index.html'), 200000, { uid });
    const assets = [...new Set([...html.bytes.toString().matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_.-]+\.(?:js|css))"/g)].map(value => value[1]))];
    if (assets.length > 20 || !assets.some(path => path.endsWith('.js')) || !assets.some(path => path.endsWith('.css'))) fail('upgrade_static_assets_invalid');
    const files = [{ url: '/', bytes: html.bytes }];
    for (const asset of assets) files.push({ url: asset, bytes: (await readUpgradeFile(join(release, 'dist-workbench', asset), 8 * 1024 * 1024, { uid })).bytes });
    return files;
  };
  let owner, original, maintenanceHash, approved, journalHash;
  const switchedPair = async (input, staged) => {
    const link = await lstat(paths.current);
    if (!link.isSymbolicLink() || link.uid !== uid || await readlink(paths.current) !== staged.final || await realpath(paths.current) !== staged.final) fail('upgrade_switched_link_mismatch');
    const receipt = JSON.parse((await readUpgradeFile(configPath('release.json'), 65536, { uid, secret: true })).bytes);
    const activation = JSON.parse((await readUpgradeFile(configPath('activation.json'), 4096, { uid, secret: true })).bytes);
    if (receipt.manifestSha256 !== input.bundle.manifestSha256 || JSON.stringify(receipt.manifest) !== JSON.stringify(input.bundle.manifest)
      || JSON.stringify(activation) !== JSON.stringify({ ...original.activation, sourceSha: input.bundle.sourceSha })) fail('upgrade_switched_receipt_mismatch');
    if (digest((await readUpgradeFile(paths.nginx, 30000, { uid })).bytes) !== maintenanceHash) fail('upgrade_maintenance_changed');
    await original.environment.assertCurrent(); await checkTags(input.bundle.manifest); await checkUnitFiles(staged.final);
  };
  return {
    async inputs(options) {
      const pins = validateUpgradePins(JSON.parse((await readUpgradeFile(options.currentPins, 4096, { uid, secret: true })).bytes));
      if (pins.sourceSha === options.sourceSha) fail('upgrade_same_release');
      const bundle = await verify({ directory: options.directory, expectedManifestSha256: options.manifestSha256, expectedSourceSha: options.sourceSha, forProduction: true });
      if (bundle.manifest.platform.architecture !== 'amd64') fail('upgrade_platform_invalid');
      return { pins, bundle };
    },
    async hostGate(options) {
      if (!options.dedicated || process.getuid?.() !== 0 || process.platform !== 'linux' || process.arch !== 'x64' || !/^v24\./.test(process.version)) fail('upgrade_dedicated_host_required');
      const os = await readFile('/etc/os-release', 'utf8');
      if (!/^ID=debian$/m.test(os) || !/^VERSION_ID="?12"?$/m.test(os)) fail('upgrade_debian12_required');
      const libc = await run('/usr/bin/getconf', ['GNU_LIBC_VERSION']);
      if (!/^glibc \d+\.\d+$/.test(libc)) fail('upgrade_glibc_invalid');
      await run('/usr/bin/dpkg', ['--compare-versions', libc.slice(6), 'ge', '2.36']);
      for (const path of [paths.config, paths.releases, dirname(paths.current), dirname(paths.nginx), paths.units]) await safeDirectory(path, uid);
    },
    async acquire(input) {
      await mkdir(lock, { mode: 0o700 }); owner = randomUUID(); approved = input;
      await durable(join(lock, 'owner.json'), JSON.stringify({ owner, pid: process.pid, createdAt: new Date().toISOString(), sourceSha: input.bundle.sourceSha }));
      await syncDir(paths.config);
    },
    async preflight(input) {
      const { pins, bundle } = input;
      const receiptFile = await readUpgradeFile(configPath('release.json'), 65536, { uid, secret: true });
      if (digest(receiptFile.bytes) !== pins.receiptSha256) fail('upgrade_receipt_pin_mismatch');
      const receipt = JSON.parse(receiptFile.bytes), old = receipt.manifest;
      if (!old || old.sourceSha !== pins.sourceSha || old.classification !== 'production_candidate' || !hex.test(receipt.manifestSha256 || '')
        || JSON.stringify(old.build?.auth) !== JSON.stringify(bundle.manifest.build.auth)
        || !Array.isArray(old.images) || old.images.length !== 2 || ['app', 'renderer'].some(role => old.images.filter(image => image.role === role && image.tag === tags[role] && image.id === pins[`${role}ImageId`]).length !== 1)) fail('upgrade_receipt_identity');
      const link = await lstat(paths.current), currentTarget = join(paths.releases, pins.sourceSha);
      if (!link.isSymbolicLink() || link.uid !== uid || await readlink(paths.current) !== currentTarget || await realpath(paths.current) !== currentTarget) fail('upgrade_current_link_invalid');
      await safeDirectory(currentTarget, uid);
      const activationFile = await readUpgradeFile(configPath('activation.json'), 4096, { uid, secret: true });
      const activation = JSON.parse(activationFile.bytes), environment = await readUpgradeFile(configPath('runtime.env'), 50000, { uid, secret: true });
      if (!exact(activation, ['sourceSha', 'domain', 'configurationSha256']) || activation.sourceSha !== pins.sourceSha || activation.configurationSha256 !== pins.configurationSha256 || digest(environment.bytes) !== pins.configurationSha256) fail('upgrade_configuration_pin_mismatch');
      const publicSetting = key => { const values = [...environment.bytes.toString().matchAll(new RegExp(`^${key}=\"([a-z0-9-]+)\"$`, 'gm'))]; if (values.length !== 1) fail('upgrade_runtime_identity_missing'); return values[0][1]; };
      const projectId = publicSetting('WORKBENCH_PROJECT_ID');
      if (projectId === publicSetting('PRODUCTION_PROJECT_ID') || publicSetting('WORKBENCH_AUTH_PROJECT_ID') !== bundle.manifest.build.auth.projectId) fail('upgrade_runtime_identity_mismatch');
      const nginxFile = await readUpgradeFile(paths.nginx, 30000, { uid }), nginx = renderBootstrapNginx(activation.domain);
      if (digest(nginxFile.bytes) !== pins.nginxSha256 || nginxFile.bytes.toString() !== nginx) fail('upgrade_nginx_not_exact');
      if ((await readdir(join(dirname(dirname(paths.nginx)), 'sites-enabled'))).length || (await readdir(dirname(paths.nginx))).filter(name => name.endsWith('.conf')).join() !== 'myscube-workbench.conf') fail('upgrade_nginx_other_sites');
      await checkTags(old); await checkUnitFiles(currentTarget);
      if (await run('/usr/bin/systemctl', ['is-enabled', appUnit]) !== 'enabled') fail('upgrade_original_service_not_enabled');
      const dependencies = await run('/usr/bin/systemctl', ['show', appUnit, '-p', 'WantedBy', '-p', 'RequiredBy', '-p', 'TriggeredBy', '-p', 'PartOf', '-p', 'UpheldBy', '-p', 'DropInPaths']);
      const expectedDependencies = { WantedBy: 'multi-user.target', RequiredBy: '', TriggeredBy: '', PartOf: '', UpheldBy: '', DropInPaths: '' };
      const actualDependencies = Object.fromEntries(dependencies.split('\n').map(line => line.split('=')));
      if (Object.keys(actualDependencies).length !== Object.keys(expectedDependencies).length || Object.entries(expectedDependencies).some(([key, value]) => actualDependencies[key] !== value)) fail('upgrade_service_dependencies_changed');
      await active(appUnit); await active(timerUnit); await active('nginx'); await run('/usr/sbin/nginx', ['-t']);
      const available = Number((await run('/usr/bin/df', ['--output=avail', '-B1', paths.releases])).trim().split(/\s+/).at(-1));
      if (!Number.isSafeInteger(available) || available < bundle.manifest.images.reduce((sum, image) => sum + image.bytes, 0) * 3 + 2 * 1024 ** 3) fail('upgrade_disk_insufficient');
      for (const file of [receiptFile, activationFile, environment, nginxFile]) await file.assertCurrent();
      original = { old, activation, projectId, receiptFile, activationFile, environment, nginxFile, nginx, link };
      await durable(join(lock, 'nginx.original'), nginxFile.bytes); await durable(join(lock, 'release.original.json'), receiptFile.bytes); await durable(join(lock, 'activation.original.json'), activationFile.bytes);
      return { domain: activation.domain, currentTarget };
    },
    async journal(phase, status, code = null) {
      const bytes = JSON.stringify({ schemaVersion: 1, owner, phase, status, code, updatedAt: new Date().toISOString(),
        previous: approved.pins, candidate: { manifest: approved.bundle.manifest, manifestSha256: approved.bundle.manifestSha256, path: join(paths.releases, approved.bundle.sourceSha) }, originalEnabled: true, automaticRollback: false });
      const temp = join(lock, `journal-${randomUUID()}.json`); await durable(temp, bytes); await rename(temp, join(lock, 'journal.json')); await syncDir(lock);
      const target = configPath('upgrade-journal.json');
      if (!journalHash) {
        try { const existing = await readUpgradeFile(target, 65536, { uid, secret: true }); const value = JSON.parse(existing.bytes); if (value.phase !== 'complete' || value.status !== 'completed') fail('upgrade_previous_journal_unresolved'); journalHash = digest(existing.bytes); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (journalHash) await replaceFile(target, bytes, journalHash, 0o600, uid); else { await durable(target, bytes); await syncDir(paths.config); }
      journalHash = digest(bytes);
    },
    async stage(input) {
      const { bundle } = input, expected = bundle.manifest, final = join(paths.releases, expected.sourceSha);
      try { await lstat(final); fail('upgrade_release_exists'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await safeDirectory(bundle.directory, uid);
      for (const image of expected.images) {
        const info = await lstat(join(bundle.directory, image.archive));
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1 || info.size !== image.bytes || info.mode & 0o022) fail('upgrade_archive_ownership');
      }
      await verify({ directory: bundle.directory, expectedManifestSha256: bundle.manifestSha256, expectedSourceSha: bundle.sourceSha, forProduction: true });
      for (const image of expected.images) {
        const archive = join(bundle.directory, image.archive);
        const names = await run('/usr/bin/tar', ['-tf', archive], { timeout: 300000, maxBuffer: 8 * 1024 * 1024 });
        const list = names.trim().split('\n');
        if (list.filter(name => name === 'manifest.json').length !== 1 || list.filter(name => name === 'index.json').length > 1) fail('upgrade_archive_index_invalid');
        const readMember = member => run('/usr/bin/tar', ['-xOf', archive, member], { timeout: 300000, maxBuffer: 2 * 1024 * 1024, encoding: 'buffer' });
        const indexBytes = list.includes('index.json') ? await readMember('index.json') : undefined, blobs = {};
        const queue = indexBytes ? [...(JSON.parse(indexBytes).manifests || [])] : [];
        while (queue.length) {
          const descriptor = queue.shift();
          if (!imageId.test(descriptor.digest || '') || Object.keys(blobs).length >= 32) fail('upgrade_archive_index_invalid');
          if (blobs[descriptor.digest]) continue;
          const member = `blobs/sha256/${descriptor.digest.slice(7)}`;
          if (list.filter(name => name === member).length !== 1) fail('upgrade_archive_blob_invalid');
          blobs[descriptor.digest] = await readMember(member);
          const object = JSON.parse(blobs[descriptor.digest]); if (Array.isArray(object.manifests)) queue.push(...object.manifests);
        }
        validateUntaggedArchive(await readMember('manifest.json'), image.id, indexBytes, blobs);
      }
      for (const image of expected.images) { await docker('load', '--input', join(bundle.directory, image.archive)); await inspect(image.id, expected.sourceSha); }
      await checkTags(original.old);
      const staging = await mkdtemp(join(paths.releases, '.upgrade-')), container = `axr-upgrade-${randomUUID()}`;
      let created = false;
      try {
        await docker('create', '--pull', 'never', '--network', 'none', '--read-only', '--name', container, expected.images.find(image => image.role === 'app').id); created = true;
        await docker('cp', `${container}:/app/.`, staging); await docker('rm', container); created = false;
        let count = 0;
        const seal = async path => {
          if (++count > 500000) fail('upgrade_payload_count');
          const info = await lstat(path);
          if (info.isSymbolicLink()) { const target = await realpath(path); if (!target.startsWith(`${staging}/`)) fail('upgrade_payload_escape'); return; }
          if (!info.isDirectory() && !info.isFile() || info.isFile() && info.nlink !== 1) fail('upgrade_payload_type');
          if (info.isDirectory()) for (const name of await readdir(path)) await seal(join(path, name));
          await chown(path, uid, uid); await chmod(path, info.isDirectory() || info.mode & 0o111 ? 0o755 : 0o644);
        };
        await seal(staging);
        const metadata = JSON.parse((await readUpgradeFile(join(staging, 'workbench-build.json'), 65536, { uid })).bytes);
        const expectedMetadata = { schemaVersion: 1, sourceSha: expected.sourceSha, classification: expected.classification, platform: expected.platform, nodeVersion: expected.build.nodeVersion, auth: expected.build.auth, locks: expected.build.locks };
        if (JSON.stringify(metadata) !== JSON.stringify(expectedMetadata)) fail('upgrade_build_metadata_mismatch');
        for (const [key, name] of [['root', 'package-lock.json'], ['workbench', 'server/workbench/package-lock.json']]) if (digest((await readUpgradeFile(join(staging, name), 8 * 1024 * 1024, { uid })).bytes) !== expected.build.locks[key]) fail('upgrade_payload_lock_mismatch');
        await checkUnitFiles(staging);
        const assets = await checkStatic(staging), javascript = assets.filter(file => file.url.endsWith('.js')).map(file => file.bytes.toString()).join('\n');
        const literals = [...javascript.matchAll(/["']([^"'\\\r\n]{1,256})["']/g)].map(match => match[1]);
        if (!javascript.includes(expected.build.auth.projectId) || !javascript.includes(expected.build.auth.domain) || !literals.some(value => digest(value) === expected.build.auth.apiKeySha256)) fail('upgrade_frontend_auth_mismatch');
        await rename(staging, final); await syncDir(paths.releases); return { final, assets };
      } finally { if (created) await docker('rm', container).catch(() => {}); }
    },
    async maintenance({ signal } = {}) {
      signal?.throwIfAborted();
      for (const file of [original.receiptFile, original.activationFile, original.environment, original.nginxFile]) await file.assertCurrent();
      const bytes = renderUpgradeMaintenance(original.activation.domain); maintenanceHash = digest(bytes);
      await replaceFile(paths.nginx, bytes, digest(original.nginxFile.bytes), 0o644, uid);
      await run('/usr/sbin/nginx', ['-t']); signal?.throwIfAborted();
      await run('/usr/bin/systemctl', ['reload', 'nginx']); signal?.throwIfAborted();
      // Reload returns before new workers necessarily serve requests; observe convergence, not one response.
      const deadline = now() + 10000;
      const remaining = () => { signal?.throwIfAborted(); const ms = deadline - now(); if (ms <= 0) fail('upgrade_maintenance_not_closed'); return ms; };
      let consecutive = 0;
      while (consecutive < 2) {
        const timeout = Math.floor(Math.min(5000, remaining()));
        if (timeout < 1) fail('upgrade_maintenance_not_closed');
        let status;
        try {
          status = await run('/usr/bin/curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', String(timeout / 1000), '--resolve', `${original.activation.domain}:443:127.0.0.1`, `https://${original.activation.domain}/health`], { timeout, signal });
        } catch { signal?.throwIfAborted(); fail('upgrade_maintenance_probe_failed'); }
        remaining();
        consecutive = status === '503' ? consecutive + 1 : 0;
        if (consecutive < 2) { await wait(Math.min(250, remaining()), undefined, { signal }); remaining(); }
      }
    },
    async disable() {
      await run('/usr/bin/systemctl', ['disable', appUnit]);
      let state; try { state = await run('/usr/bin/systemctl', ['is-enabled', appUnit]); } catch (error) { if (error.code === 1) state = error.stdout?.trim(); else throw error; }
      if (state !== 'disabled') fail('upgrade_service_not_disabled');
    },
    async stop() { await run('/usr/bin/systemctl', ['stop', appUnit], { timeout: 45000 }); if (await unitState(appUnit) !== 'inactive') fail('upgrade_app_not_stopped'); },
    async drain() { await active(timerUnit); await managedEmpty(); },
    async switchRelease(input, staged) {
      if (await unitState(appUnit) !== 'inactive') fail('upgrade_switch_requires_stopped');
      await managedEmpty(); await original.environment.assertCurrent();
      if (!same(original.link, await lstat(paths.current)) || await readlink(paths.current) !== join(paths.releases, input.pins.sourceSha)) fail('upgrade_link_changed');
      for (const image of input.bundle.manifest.images) await docker('tag', image.id, image.tag);
      await checkTags(input.bundle.manifest);
      const temp = `${paths.current}.upgrade-${owner}`; await symlink(staged.final, temp); await rename(temp, paths.current); await syncDir(dirname(paths.current));
      await replaceFile(configPath('release.json'), `${JSON.stringify({ manifest: input.bundle.manifest, manifestSha256: input.bundle.manifestSha256 }, null, 2)}\n`, input.pins.receiptSha256, 0o600, uid);
      await replaceFile(configPath('activation.json'), JSON.stringify({ ...original.activation, sourceSha: input.bundle.sourceSha }), digest(original.activationFile.bytes), 0o600, uid);
    },
    async runtimeSmoke(input, staged) {
      if (await unitState(appUnit) !== 'inactive') fail('upgrade_smoke_requires_stopped');
      await managedEmpty(); await switchedPair(input, staged);
      const invoke = (relative, extras = []) => run('/usr/sbin/runuser', ['-u', 'axr-runtime', '--', '/usr/bin/env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'LANG=C.UTF-8', ...extras, '/usr/bin/node', join(staged.final, 'server/workbench', relative)], { cwd: staged.final, timeout: 180000, maxBuffer: 1024 * 1024 });
      const native = JSON.parse(await invoke('deployment/host-smoke.mjs', [`WORKBENCH_EXPECTED_SOURCE_SHA=${input.bundle.sourceSha}`]));
      if (native.status !== 'PASS' || native.sourceSha !== input.bundle.sourceSha) fail('upgrade_native_smoke_failed');
      const renderer = JSON.parse(await invoke('remote-runtime/docker-qa.mjs', ['REQUIRE_REMOTE_DOCKER_QA=true']));
      if (renderer.status !== 'PASS' || renderer.isolationVerified !== true || renderer.cleanupVerified !== true || renderer.imageId !== input.bundle.manifest.images.find(image => image.role === 'renderer').id) fail('upgrade_renderer_smoke_failed');
      await durable(join(lock, 'native-smoke.json'), JSON.stringify(native)); await durable(join(lock, 'renderer-smoke.json'), JSON.stringify(renderer));
      await managedEmpty(); await checkTags(input.bundle.manifest); await active(timerUnit);
    },
    async start(input, staged) {
      await switchedPair(input, staged);
      await active(timerUnit); await managedEmpty();
      await run('/usr/bin/node', ['--input-type=module', '-e', `const {assertRendererHostReady}=await import(${JSON.stringify(join(paths.current, 'server/workbench/remote-runtime/reaper.mjs'))});await assertRendererHostReady();`]);
      await run('/usr/bin/systemctl', ['start', appUnit]);
    },
    async acceptance(input, staged) {
      const health = JSON.parse(await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--retry', '10', '--retry-connrefused', '--retry-delay', '1', '--retry-max-time', '40', '--max-time', '3', 'http://127.0.0.1:8791/health'], { timeout: 45000 }));
      if (health.ok !== true || health.service !== 'myscube-workbench' || health.projectId !== original.projectId) fail('upgrade_health_invalid');
      for (const api of ['html-work-pages', 'react-work-pages']) if (await run('/usr/bin/curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '5', `http://127.0.0.1:8791/api/v1/${api}`]) !== '401') fail('upgrade_auth_not_required');
      for (const asset of staged.assets) {
        const bytes = await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '5', `http://127.0.0.1:8791${asset.url}`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
        if (digest(bytes) !== digest(asset.bytes)) fail('upgrade_served_asset_mismatch');
      }
      await switchedPair(input, staged); await active(appUnit); await active(timerUnit); await managedEmpty(); await original.environment.assertCurrent();
    },
    async reopen() {
      await replaceFile(paths.nginx, original.nginxFile.bytes, maintenanceHash, 0o644, uid);
      await run('/usr/sbin/nginx', ['-t']); await run('/usr/bin/systemctl', ['reload', 'nginx']);
    },
    async enable() { await run('/usr/bin/systemctl', ['enable', appUnit]); if (await run('/usr/bin/systemctl', ['is-enabled', appUnit]) !== 'enabled') fail('upgrade_enable_failed'); },
    async failClosed() {
      let disabled = false, stopped = false, closed = false;
      try {
        await run('/usr/bin/systemctl', ['disable', appUnit]);
        let enabled; try { enabled = await run('/usr/bin/systemctl', ['is-enabled', appUnit]); } catch (error) { if (error.code === 1) enabled = error.stdout?.trim(); else throw error; }
        disabled = enabled === 'disabled';
      } catch {}
      try { await run('/usr/bin/systemctl', ['stop', appUnit], { timeout: 45000 }); stopped = await unitState(appUnit) === 'inactive'; } catch {}
      try {
        const file = await readUpgradeFile(paths.nginx, 30000, { uid }), hash = digest(file.bytes);
        if (![digest(original.nginxFile.bytes), maintenanceHash].includes(hash)) fail('upgrade_nginx_changed');
        if (hash !== maintenanceHash) await replaceFile(paths.nginx, renderUpgradeMaintenance(original.activation.domain), hash, 0o644, uid);
        await run('/usr/sbin/nginx', ['-t']); await run('/usr/bin/systemctl', ['reload', 'nginx']); closed = true;
      } catch { try { await run('/usr/bin/systemctl', ['stop', 'nginx']); closed = await unitState('nginx') === 'inactive'; } catch {} }
      if (!disabled || !stopped || !closed) fail('upgrade_containment_unconfirmed');
    },
    async releaseLock() {
      const actual = JSON.parse((await readUpgradeFile(join(lock, 'owner.json'), 4096, { uid, secret: true })).bytes);
      if (actual.owner !== owner) fail('upgrade_lock_owner_changed');
      await rename(lock, configPath(`upgrade-completed-${owner}`)); await syncDir(paths.config);
    },
  };
}

export async function upgradeHost(raw, { actions = createUpgradeActions(), signal } = {}) {
  const options = validateOptions(raw), input = await actions.inputs(options);
  if (!options.apply) return { action: 'plan', sourceSha: input.bundle.sourceSha, previousSourceSha: input.pins.sourceSha, apply: false, automaticRollback: false,
    steps: ['verify-current-pins', 'stage-sealed-payload-without-retagging', 'maintenance-503', 'disable-stop-AXR-and-drain', 'switch-image-pair-and-receipts', 'native-and-renderer-smoke', 'health-static-auth-reaper', 'restore-ingress-and-enable'] };
  await actions.hostGate(options); await actions.acquire(input);
  let phase = 'preflight', maintenanceAttempted = false;
  const step = async (name, operation) => { signal?.throwIfAborted(); phase = name; await actions.journal(name, 'started'); const result = await operation(); signal?.throwIfAborted(); await actions.journal(name, 'completed'); return result; };
  try {
    await step('preflight', () => actions.preflight(input));
    const staged = await step('stage', () => actions.stage(input));
    await step('maintenance', async () => { maintenanceAttempted = true; await actions.maintenance({ signal }); });
    await step('disable', () => actions.disable()); await step('stop', () => actions.stop()); await step('drain', () => actions.drain());
    await step('switch', () => actions.switchRelease(input, staged)); await step('runtime-smoke', () => actions.runtimeSmoke(input, staged)); await step('start', () => actions.start(input, staged));
    await step('acceptance', () => actions.acceptance(input, staged)); await step('reopen', () => actions.reopen()); await step('enable', () => actions.enable());
    signal?.throwIfAborted(); await actions.journal('complete', 'completed'); signal?.throwIfAborted(); await actions.releaseLock();
    return { action: 'upgraded', sourceSha: input.bundle.sourceSha, previousSourceSha: input.pins.sourceSha, automaticRollback: false, acceptance: 'local-smoke-only', authorizedBrowserAcceptanceRequired: true };
  } catch (cause) {
    let contained = !maintenanceAttempted;
    if (maintenanceAttempted) try { await actions.failClosed(); contained = true; } catch {}
    await actions.journal(phase, contained ? (maintenanceAttempted ? 'failed-kept-closed' : 'failed-before-maintenance') : 'failed-containment-unconfirmed', /^upgrade_[a-z_]+$/.test(cause.code || '') ? cause.code : cause.name === 'AbortError' ? 'upgrade_aborted' : 'upgrade_phase_failed').catch(() => {});
    fail(contained ? 'upgrade_failed_manual_review' : 'upgrade_containment_unconfirmed');
  }
}
async function main(args) {
  const names = { '--directory': 'directory', '--source-sha': 'sourceSha', '--manifest-sha256': 'manifestSha256', '--current-pins': 'currentPins', '--apply': 'apply', '--dedicated-host': 'dedicated' }, options = {};
  for (let i = 0; i < args.length; i++) {
    const key = names[args[i]]; if (!key || Object.hasOwn(options, key)) fail('upgrade_options_invalid');
    if (['apply', 'dedicated'].includes(key)) options[key] = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) fail('upgrade_options_invalid'); options[key] = args[++i]; }
  }
  const controller = new AbortController();
  for (const name of ['SIGTERM', 'SIGINT']) process.once(name, () => controller.abort());
  process.stdout.write(`${JSON.stringify(await upgradeHost(options, { signal: controller.signal }))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => {
  process.stderr.write(`${JSON.stringify({ event: 'workbench.upgrade', code: /^upgrade_[a-z_]+$/.test(error.code || '') ? error.code : 'upgrade_failed_manual_review', message: 'Inspect the root-only upgrade journal. Do not roll back an older writer or reopen traffic automatically.' })}\n`); process.exitCode = 1;
});
