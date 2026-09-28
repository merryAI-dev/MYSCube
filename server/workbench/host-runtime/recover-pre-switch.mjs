import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { lstat, open, readFile, readlink, realpath, readdir, mkdir, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readUpgradeFile, validateUpgradePins, renderUpgradeMaintenance, UPGRADE_PATHS } from './upgrade-host.mjs';
import { renderBootstrapNginx } from './bootstrap-install.mjs';

const exec = promisify(execFile), hash = bytes => createHash('sha256').update(bytes).digest('hex');
const app = 'myscube-axr-workbench.service', reaper = 'myscube-axr-renderer-reaper.timer';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const units = { [app]: 'host-runtime/systemd/myscube-axr-workbench.service', 'myscube-axr-renderer-reaper.service': 'remote-runtime/systemd/myscube-axr-renderer-reaper.service', [reaper]: 'remote-runtime/systemd/myscube-axr-renderer-reaper.timer' };
const runDefault = async (file, args, options = {}) => { const { stdout } = await exec(file, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024, ...options }); return Buffer.isBuffer(stdout) ? stdout : stdout.trim(); };
function options(raw) {
  if (!raw || Object.keys(raw).some(key => !['failedSourceSha', 'failedOwner', 'currentPins', 'apply', 'dedicated'].includes(key)) || !/^[a-f0-9]{40}$/.test(raw.failedSourceSha || '') || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(raw.failedOwner || '') || typeof raw.currentPins !== 'string' || !raw.currentPins.startsWith('/') || raw.currentPins.length > 4096 || /[\x00-\x1f\x7f]/.test(raw.currentPins) || ['apply', 'dedicated'].some(key => raw[key] !== undefined && typeof raw[key] !== 'boolean')) fail('recovery_options_invalid');
  return Object.freeze({ ...raw });
}
async function directory(path, uid) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o022 || await realpath(path) !== path) fail('recovery_directory_invalid'); }
async function syncDir(path) { const fd = await open(path, constants.O_RDONLY); try { await fd.sync(); } finally { await fd.close(); } }
async function durable(path, bytes, mode = 0o600) { const fd = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode); try { await fd.writeFile(bytes); await fd.sync(); } finally { await fd.close(); } }
async function replace(path, bytes, previous, mode) { await previous.assertCurrent(); const staged = `${path}.recovery-${randomUUID()}`; await durable(staged, bytes, mode); await previous.assertCurrent(); await rename(staged, path); await syncDir(dirname(path)); }
export function createPreSwitchRecoveryActions({ run = runDefault, uid = 0, paths = UPGRADE_PATHS, checkpoint = async () => {} } = {}) {
  const at = name => join(paths.config, name), lock = at('.upgrade-lock'), recoveryLock = at('.pre-switch-recovery-lock');
  const read = (path, limit = 65536, secret = true) => readUpgradeFile(path, limit, { uid, secret });
  const state = async (unit, operation = 'is-active') => { try { return await run('/usr/bin/systemctl', [operation, unit]); } catch (error) { const value = error.stdout?.trim(); if (operation === 'is-active' && error.code === 3 && ['inactive', 'failed'].includes(value) || operation === 'is-enabled' && error.code === 1 && value === 'disabled') return value; throw error; } };
  const docker = (...args) => run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', ...args]);
  const empty = async () => { if ((await docker('ps', '-aq', '--no-trunc', '--filter', 'label=io.myscube.axr.renderer=v1')).trim()) fail('recovery_renderers_present'); };
  const status = (domain, path) => run('/usr/bin/curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '5', '--resolve', `${domain}:443:127.0.0.1`, `https://${domain}${path}`]);
  let original, exclusive, acceptedBytes, failedLockArchived = false, evidencePath = recoveryLock;
  const unchanged = async ({ nginx = 'maintenance', running = false } = {}) => {
    const o = original;
    for (const file of o.pinnedFiles) await file.assertCurrent();
    const link = await lstat(paths.current);
    if (!link.isSymbolicLink() || link.uid !== uid || await readlink(paths.current) !== o.target || await realpath(paths.current) !== o.target) fail('recovery_current_changed');
    const actual = await read(paths.nginx, 30000, false); if (!actual.bytes.equals(Buffer.from(nginx === 'maintenance' ? o.maintenance : o.nginx))) fail('recovery_nginx_changed');
    for (const [name, relative] of Object.entries(units)) {
      if (!(await read(join(paths.units, name), 20000, false)).bytes.equals((await read(join(o.target, 'server/workbench', relative), 20000, false)).bytes)) fail('recovery_unit_changed');
    }
    for (const image of o.receipt.manifest.images) {
      const expected = [image.id, 'linux', 'amd64', o.pins.sourceSha, 'production_candidate'];
      const format = '{{json .Id}}\n{{json .Os}}\n{{json .Architecture}}\n{{json (index .Config.Labels "org.opencontainers.image.revision")}}\n{{json (index .Config.Labels "io.myscube.workbench.classification")}}';
      const found = (await docker('image', 'inspect', '--format', format, image.tag)).split('\n').map(value => JSON.parse(value));
      if (!same(found, expected)) fail('recovery_image_changed');
    }
    if (await state(app) !== (running ? 'active' : 'inactive') || await state(reaper) !== 'active' || await state('nginx') !== 'active') fail('recovery_service_state_invalid');
    await empty();
  };
  return {
    async hostGate(input) {
      if (!input.dedicated || process.getuid?.() !== 0 || process.platform !== 'linux' || process.arch !== 'x64' || !/^v24\./.test(process.version)) fail('recovery_dedicated_host_required');
      const os = await readFile('/etc/os-release', 'utf8'); if (!/^ID=debian$/m.test(os) || !/^VERSION_ID="?12"?$/m.test(os)) fail('recovery_host_invalid');
    },
    async inspect(input) {
      for (const path of [paths.config, paths.releases, dirname(paths.current), dirname(paths.nginx), paths.units, lock]) await directory(path, uid);
      const pinsFile = await read(input.currentPins, 4096), pins = validateUpgradePins(JSON.parse(pinsFile.bytes));
      const journalFile = await read(at('upgrade-journal.json')), lockJournal = await read(join(lock, 'journal.json')), ownerFile = await read(join(lock, 'owner.json'), 4096);
      const journal = JSON.parse(journalFile.bytes), owner = JSON.parse(ownerFile.bytes);
      if (!journalFile.bytes.equals(lockJournal.bytes) || journal.schemaVersion !== 1 || journal.owner !== input.failedOwner || journal.phase !== 'maintenance' || journal.status !== 'failed-kept-closed' || journal.code !== 'upgrade_maintenance_not_closed' || journal.originalEnabled !== true || journal.automaticRollback !== false || !same(validateUpgradePins(journal.previous), pins) || journal.candidate?.manifest?.sourceSha !== input.failedSourceSha || journal.candidate.path !== join(paths.releases, input.failedSourceSha) || !/^[a-f0-9]{64}$/.test(journal.candidate.manifestSha256 || '') || input.failedSourceSha === pins.sourceSha || owner.owner !== input.failedOwner || owner.sourceSha !== input.failedSourceSha || !Number.isSafeInteger(owner.pid) || owner.pid < 1) fail('recovery_failure_identity_mismatch');
      const transient = await run('/usr/bin/systemctl', ['show', `axr-upgrade-${input.failedSourceSha}.service`, '-p', 'LoadState', '-p', 'ActiveState', '-p', 'MainPID']);
      const transientFields = Object.fromEntries(transient.split('\n').map(line => line.split('=')));
      if (!['loaded', 'not-found'].includes(transientFields.LoadState) || !['inactive', 'failed'].includes(transientFields.ActiveState) || transientFields.MainPID !== '0') fail('recovery_failed_upgrade_still_running');
      const receiptFile = await read(at('release.json')), activationFile = await read(at('activation.json'), 4096), environment = await read(at('runtime.env'), 50000);
      const receiptBackup = await read(join(lock, 'release.original.json')), activationBackup = await read(join(lock, 'activation.original.json'), 4096), nginxBackup = await read(join(lock, 'nginx.original'), 30000);
      if (hash(receiptFile.bytes) !== pins.receiptSha256 || !receiptFile.bytes.equals(receiptBackup.bytes) || !activationFile.bytes.equals(activationBackup.bytes) || hash(environment.bytes) !== pins.configurationSha256 || hash(nginxBackup.bytes) !== pins.nginxSha256) fail('recovery_previous_pin_mismatch');
      const receipt = JSON.parse(receiptFile.bytes), activation = JSON.parse(activationFile.bytes), target = join(paths.releases, pins.sourceSha);
      await directory(target, uid);
      if (activation.sourceSha !== pins.sourceSha || activation.configurationSha256 !== pins.configurationSha256 || Object.keys(activation).sort().join() !== 'configurationSha256,domain,sourceSha' || receipt.manifest?.sourceSha !== pins.sourceSha || receipt.manifest.classification !== 'production_candidate' || !/^[a-f0-9]{64}$/.test(receipt.manifestSha256 || '') || receipt.manifest.platform?.os !== 'linux' || receipt.manifest.platform?.architecture !== 'amd64' || !Array.isArray(receipt.manifest.images) || receipt.manifest.images.length !== 2) fail('recovery_installed_identity_invalid');
      for (const [role, tag] of [['app', 'myscube-workbench-app:release'], ['renderer', 'myscube-axr-renderer:1.58.2-v1']]) if (receipt.manifest.images.filter(image => image.role === role && image.tag === tag && image.id === pins[`${role}ImageId`]).length !== 1) fail('recovery_installed_identity_invalid');
      const setting = key => { const values = [...environment.bytes.toString().matchAll(new RegExp(`^${key}=\"([a-z0-9-]+)\"$`, 'gm'))]; if (values.length !== 1) fail('recovery_runtime_identity_invalid'); return values[0][1]; };
      const projectId = setting('WORKBENCH_PROJECT_ID'); if (projectId === setting('PRODUCTION_PROJECT_ID') || setting('WORKBENCH_AUTH_PROJECT_ID') !== receipt.manifest.build.auth.projectId) fail('recovery_runtime_identity_invalid');
      const nginx = renderBootstrapNginx(activation.domain); if (nginxBackup.bytes.toString() !== nginx) fail('recovery_nginx_backup_invalid');
      if ((await readdir(join(dirname(dirname(paths.nginx)), 'sites-enabled'))).length || (await readdir(dirname(paths.nginx))).filter(name => name.endsWith('.conf')).join() !== 'myscube-workbench.conf') fail('recovery_other_sites');
      const metadata = await read(join(target, 'workbench-build.json'), 65536, false);
      if (!same(JSON.parse(metadata.bytes), { schemaVersion: 1, sourceSha: pins.sourceSha, classification: receipt.manifest.classification, platform: receipt.manifest.platform, nodeVersion: receipt.manifest.build.nodeVersion, auth: receipt.manifest.build.auth, locks: receipt.manifest.build.locks })) fail('recovery_source_metadata_changed');
      const lockfiles = [];
      for (const [key, relative] of [['root', 'package-lock.json'], ['workbench', 'server/workbench/package-lock.json']]) { const file = await read(join(target, relative), 8 * 1024 * 1024, false); if (hash(file.bytes) !== receipt.manifest.build.locks[key]) fail('recovery_source_lock_changed'); lockfiles.push(file); }
      const html = await read(join(target, 'dist-workbench/index.html'), 200000, false), assets = [{ url: '/', bytes: html.bytes }];
      const pathsInHtml = [...new Set([...html.bytes.toString().matchAll(/(?:src|href)="(\/assets\/[A-Za-z0-9_.-]+\.(?:js|css))"/g)].map(match => match[1]))];
      if (pathsInHtml.length > 20 || !pathsInHtml.some(path => path.endsWith('.js')) || !pathsInHtml.some(path => path.endsWith('.css'))) fail('recovery_static_invalid');
      const assetFiles = [];
      for (const url of pathsInHtml) { const file = await read(join(target, 'dist-workbench', url), 8 * 1024 * 1024, false); assets.push({ url, bytes: file.bytes }); assetFiles.push(file); }
      original = { input, pins, journal, journalFile, ownerFile, lockJournal, receipt, activation, target, projectId, nginx, maintenance: renderUpgradeMaintenance(activation.domain), assets, pinnedFiles: [pinsFile, journalFile, lockJournal, ownerFile, receiptFile, activationFile, environment, receiptBackup, activationBackup, nginxBackup, metadata, html, ...lockfiles, ...assetFiles] };
      await unchanged(); if (await state(app, 'is-enabled') !== 'disabled') fail('recovery_app_not_disabled');
      const dependencies = await run('/usr/bin/systemctl', ['show', app, '-p', 'WantedBy', '-p', 'RequiredBy', '-p', 'TriggeredBy', '-p', 'PartOf', '-p', 'UpheldBy', '-p', 'DropInPaths']);
      const fields = Object.fromEntries(dependencies.split('\n').map(line => line.split('=')));
      if (!same(Object.keys(fields).sort(), ['DropInPaths', 'PartOf', 'RequiredBy', 'TriggeredBy', 'UpheldBy', 'WantedBy']) || Object.values(fields).some(value => value !== '')) fail('recovery_service_dependencies_changed');
      await run('/usr/sbin/nginx', ['-t']); if (await status(activation.domain, '/health') !== '503') fail('recovery_maintenance_not_closed');
      return { previousSourceSha: pins.sourceSha, failedSourceSha: input.failedSourceSha, failedOwner: input.failedOwner, failedJournalSha256: hash(journalFile.bytes) };
    },
    async acquire() { await mkdir(recoveryLock, { mode: 0o700 }); exclusive = true; await durable(join(recoveryLock, 'owner.json'), JSON.stringify({ failedOwner: original.input.failedOwner, failedJournalSha256: hash(original.journalFile.bytes) })); await durable(join(recoveryLock, 'failed-journal.json'), original.journalFile.bytes); await syncDir(recoveryLock); },
    async start() { await unchanged(); if (await state(app, 'is-enabled') !== 'disabled') fail('recovery_app_not_disabled'); await run('/usr/bin/systemctl', ['start', app]); },
    async acceptance() {
      const health = JSON.parse(await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--retry', '10', '--retry-connrefused', '--retry-delay', '1', '--retry-max-time', '40', '--max-time', '3', 'http://127.0.0.1:8791/health'], { timeout: 45000 }));
      if (health.ok !== true || health.service !== 'myscube-workbench' || health.projectId !== original.projectId) fail('recovery_health_invalid');
      for (const api of ['html-work-pages', 'react-work-pages']) if (await run('/usr/bin/curl', ['--silent', '--show-error', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '5', `http://127.0.0.1:8791/api/v1/${api}`]) !== '401') fail('recovery_auth_invalid');
      for (const asset of original.assets) if (hash(await run('/usr/bin/curl', ['--fail', '--silent', '--show-error', '--max-time', '5', `http://127.0.0.1:8791${asset.url}`], { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 })) !== hash(asset.bytes)) fail('recovery_static_changed');
      await unchanged({ running: true }); if (await status(original.activation.domain, '/health') !== '503') fail('recovery_maintenance_not_closed');
    },
    async reopen(signal) { await unchanged({ running: true }); signal?.throwIfAborted(); const current = await read(paths.nginx, 30000, false); signal?.throwIfAborted(); await replace(paths.nginx, original.nginx, current, 0o644); await run('/usr/sbin/nginx', ['-t']); await run('/usr/bin/systemctl', ['reload', 'nginx']);
      for (let i = 0; i < 10; i++) { signal?.throwIfAborted(); if (await status(original.activation.domain, '/health') === '200') break; if (i === 9) fail('recovery_tls_health_invalid'); await new Promise(resolve => setTimeout(resolve, 250)); }
      for (const api of ['html-work-pages', 'react-work-pages']) if (await status(original.activation.domain, `/api/v1/${api}`) !== '401') fail('recovery_tls_auth_invalid'); },
    async enable() { await unchanged({ nginx: 'original', running: true }); await run('/usr/bin/systemctl', ['enable', app]); if (await state(app, 'is-enabled') !== 'enabled') fail('recovery_enable_failed'); },
    async resolve(signal) {
      signal?.throwIfAborted();
      await unchanged({ nginx: 'original', running: true }); if (await state(app, 'is-enabled') !== 'enabled') fail('recovery_enable_failed');
      const resolution = { schemaVersion: 1, action: 'restored-unswitched-service', failedOwner: original.input.failedOwner, failedCandidateSha: original.input.failedSourceSha, failedJournalSha256: hash(original.journalFile.bytes), restoredSourceSha: original.pins.sourceSha, previous: original.pins, resolvedAt: new Date().toISOString(), candidateInstalled: false, databaseRollback: false };
      await durable(join(recoveryLock, 'resolved.json'), JSON.stringify(resolution)); await syncDir(recoveryLock);
      signal?.throwIfAborted();
      const accepted = { ...original.journal, phase: 'complete', status: 'completed', code: null, updatedAt: resolution.resolvedAt, recovery: resolution };
      acceptedBytes = JSON.stringify(accepted);
      await replace(at('upgrade-journal.json'), acceptedBytes, original.journalFile, 0o600);
      await checkpoint('accepted-journal-written'); signal?.throwIfAborted();
      await original.ownerFile.assertCurrent(); await original.lockJournal.assertCurrent();
      await rename(lock, at(`upgrade-recovered-${original.input.failedOwner}`)); failedLockArchived = true; await syncDir(paths.config);
      await checkpoint('failed-lock-archived'); signal?.throwIfAborted();
      const completed = at(`pre-switch-recovery-completed-${original.input.failedOwner}`);
      await rename(recoveryLock, completed); evidencePath = completed; await syncDir(paths.config);
      await checkpoint('recovery-directory-synced'); signal?.throwIfAborted(); exclusive = false;
      return resolution;
    },
    async contain() {
      if (!exclusive || !original) fail('recovery_containment_unconfirmed');
      let stopped = false, disabled = false, closed = false;
      try { await run('/usr/bin/systemctl', ['disable', app]); disabled = await state(app, 'is-enabled') === 'disabled'; } catch {}
      try { await run('/usr/bin/systemctl', ['stop', app], { timeout: 45000 }); stopped = await state(app) === 'inactive'; } catch {}
      try { const current = await read(paths.nginx, 30000, false); if (![original.nginx, original.maintenance].includes(current.bytes.toString())) fail('recovery_nginx_changed'); if (current.bytes.toString() !== original.maintenance) await replace(paths.nginx, original.maintenance, current, 0o644); await run('/usr/sbin/nginx', ['-t']); await run('/usr/bin/systemctl', ['reload', 'nginx']); closed = await status(original.activation.domain, '/health') === '503'; } catch {}
      if (!closed) { try { await run('/usr/bin/systemctl', ['stop', 'nginx']); closed = await state('nginx') === 'inactive'; } catch {} }
      if (acceptedBytes) {
        try { const journal = await read(at('upgrade-journal.json')); if (journal.bytes.toString() === acceptedBytes) await replace(at('upgrade-journal.json'), original.journalFile.bytes, journal, 0o600); else if (!journal.bytes.equals(original.journalFile.bytes)) fail('recovery_journal_changed'); } catch { fail('recovery_containment_unconfirmed'); }
      }
      if (failedLockArchived) {
        const archived = at(`upgrade-recovered-${original.input.failedOwner}`);
        const owner = await read(join(archived, 'owner.json'), 4096), journal = await read(join(archived, 'journal.json'));
        if (!owner.bytes.equals(original.ownerFile.bytes) || !journal.bytes.equals(original.lockJournal.bytes)) fail('recovery_containment_unconfirmed');
        try { await lstat(lock); fail('recovery_lock_conflict'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        await owner.assertCurrent(); await journal.assertCurrent(); await rename(archived, lock); await syncDir(paths.config); failedLockArchived = false;
      }
      await durable(join(evidencePath, 'recovery-failed.json'), JSON.stringify({ schemaVersion: 1, failedOwner: original.input.failedOwner, failedJournalSha256: hash(original.journalFile.bytes), status: 'recovery-failed-kept-closed', stopped, disabled, closed, at: new Date().toISOString() }));
      if (!stopped || !disabled || !closed) fail('recovery_containment_unconfirmed');
    },
  };
}
export async function recoverPreSwitch(raw, { actions = createPreSwitchRecoveryActions(), signal } = {}) {
  const input = options(raw); if (input.apply) await actions.hostGate(input);
  const evidence = await actions.inspect(input);
  if (!input.apply) return { action: 'plan-pre-switch-recovery', ...evidence, apply: false, candidateInstalled: false };
  signal?.throwIfAborted(); await actions.acquire();
  try { for (const name of ['start', 'acceptance', 'reopen', 'enable']) { signal?.throwIfAborted(); await actions[name](signal); signal?.throwIfAborted(); } return await actions.resolve(signal); }
  catch (error) { try { await actions.contain(); } catch { fail('recovery_containment_unconfirmed'); } fail('recovery_failed_kept_closed'); }
}
async function main(args) {
  const names = { '--failed-source-sha': 'failedSourceSha', '--failed-owner': 'failedOwner', '--current-pins': 'currentPins', '--apply': 'apply', '--dedicated-host': 'dedicated' }, input = {};
  for (let i = 0; i < args.length; i++) { const key = names[args[i]]; if (!key || Object.hasOwn(input, key)) fail('recovery_options_invalid'); if (['apply', 'dedicated'].includes(key)) input[key] = true; else { if (!args[i + 1] || args[i + 1].startsWith('--')) fail('recovery_options_invalid'); input[key] = args[++i]; } }
  const controller = new AbortController(); for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => controller.abort());
  process.stdout.write(`${JSON.stringify(await recoverPreSwitch(input, { signal: controller.signal }))}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { process.stderr.write('{"event":"workbench.pre-switch-recovery","status":"failed","message":"Inspect the root-only recovery evidence; do not reopen or replace a writer manually."}\n'); process.exitCode = 1; });
