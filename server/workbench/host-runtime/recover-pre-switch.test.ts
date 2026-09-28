import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, realpath, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createPreSwitchRecoveryActions, recoverPreSwitch } from './recover-pre-switch.mjs';
import { renderBootstrapNginx } from './bootstrap-install.mjs';
import { renderUpgradeMaintenance } from './upgrade-host.mjs';

const oldSha = 'a'.repeat(40), failedSha = 'b'.repeat(40), owner = '7769181b-617e-422c-9a07-8d4288605064';
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(checkpoint = async (_phase: string) => {}) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'axr-recover-'))); folders.push(folder);
  const paths = { config: join(folder, 'config'), releases: join(folder, 'releases'), current: join(folder, 'current'), nginx: join(folder, 'nginx/conf.d/myscube-workbench.conf'), units: join(folder, 'units') };
  const target = join(paths.releases, oldSha), lock = join(paths.config, '.upgrade-lock');
  for (const path of [paths.config, target, lock, join(folder, 'nginx/conf.d'), join(folder, 'nginx/sites-enabled'), paths.units, join(target, 'dist-workbench/assets'), join(target, 'server/workbench')]) await mkdir(path, { recursive: true, mode: 0o700 });
  const put = (path: string, value: unknown, mode = 0o600) => writeFile(path, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value), { mode });
  const nginx = renderBootstrapNginx('axr.example.com'), maintenance = renderUpgradeMaintenance('axr.example.com');
  const environment = 'WORKBENCH_PROJECT_ID="isolated-app"\nPRODUCTION_PROJECT_ID="original-app"\nWORKBENCH_AUTH_PROJECT_ID="original-auth"\n';
  const appId = `sha256:${'1'.repeat(64)}`, rendererId = `sha256:${'2'.repeat(64)}`;
  const manifest = { sourceSha: oldSha, classification: 'production_candidate', platform: { os: 'linux', architecture: 'amd64' }, build: { nodeVersion: 'v24.21.0', auth: { projectId: 'original-auth' }, locks: { root: hash('{}'), workbench: hash('{}') } }, images: [{ role: 'app', tag: 'myscube-workbench-app:release', id: appId }, { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', id: rendererId }] };
  const receipt = JSON.stringify({ manifest, manifestSha256: 'c'.repeat(64) });
  const pins = { sourceSha: oldSha, receiptSha256: hash(receipt), configurationSha256: hash(environment), nginxSha256: hash(nginx), appImageId: appId, rendererImageId: rendererId };
  const activation = { sourceSha: oldSha, domain: 'axr.example.com', configurationSha256: pins.configurationSha256 };
  const journal = { schemaVersion: 1, owner, phase: 'maintenance', status: 'failed-kept-closed', code: 'upgrade_maintenance_not_closed', updatedAt: '2026-09-28T05:12:00.000Z', previous: pins, candidate: { manifest: { sourceSha: failedSha }, manifestSha256: 'd'.repeat(64), path: join(paths.releases, failedSha) }, originalEnabled: true, automaticRollback: false };
  const currentPins = join(folder, 'pins.json');
  for (const [path, value] of [[currentPins, pins], [join(paths.config, 'release.json'), receipt], [join(lock, 'release.original.json'), receipt], [join(paths.config, 'activation.json'), activation], [join(lock, 'activation.original.json'), activation], [join(paths.config, 'runtime.env'), environment], [join(lock, 'nginx.original'), nginx], [paths.nginx, maintenance], [join(lock, 'owner.json'), { owner, pid: 123, sourceSha: failedSha }], [join(lock, 'journal.json'), journal], [join(paths.config, 'upgrade-journal.json'), journal], [join(target, 'workbench-build.json'), { schemaVersion: 1, sourceSha: oldSha, classification: manifest.classification, platform: manifest.platform, nodeVersion: manifest.build.nodeVersion, auth: manifest.build.auth, locks: manifest.build.locks }], [join(target, 'package-lock.json'), '{}'], [join(target, 'server/workbench/package-lock.json'), '{}']]) await put(path as string, value);
  const unitFiles = { 'myscube-axr-workbench.service': 'host-runtime/systemd/myscube-axr-workbench.service', 'myscube-axr-renderer-reaper.service': 'remote-runtime/systemd/myscube-axr-renderer-reaper.service', 'myscube-axr-renderer-reaper.timer': 'remote-runtime/systemd/myscube-axr-renderer-reaper.timer' };
  for (const [name, relative] of Object.entries(unitFiles)) { const destination = join(target, 'server/workbench', relative); await mkdir(join(destination, '..'), { recursive: true }); await put(destination, `unit-${name}`); await put(join(paths.units, name), `unit-${name}`); }
  const assets: Record<string, Buffer> = { '/': Buffer.from('<script src="/assets/app.js"></script><link href="/assets/app.css">'), '/assets/app.js': Buffer.from('fixture-app'), '/assets/app.css': Buffer.from('fixture-style') };
  for (const [url, value] of Object.entries(assets)) await put(join(target, 'dist-workbench', url === '/' ? 'index.html' : url), value);
  await symlink(target, paths.current);
  const state = { active: false, enabled: false, nginxActive: true, tamperedTag: false, renderers: false, transientActive: false, wrongHealth: false, unauth: '401', tlsLag: 0 };
  const commands: Array<{ file: string, args: string[] }> = [];
  const run = vi.fn(async (file: string, args: string[], options: any = {}) => {
    commands.push({ file, args });
    if (file.endsWith('/docker')) {
      if (args.includes('ps')) return state.renderers ? 'renderer-fixture' : '';
      if (args.includes('inspect')) { const image = manifest.images.find(image => image.tag === args.at(-1))!; return [state.tamperedTag ? 'sha256:changed' : image.id, 'linux', 'amd64', oldSha, 'production_candidate'].map(value => JSON.stringify(value)).join('\n'); }
      throw new Error('unexpected Docker mutation');
    }
    if (file.endsWith('/systemctl')) {
      const [operation, name] = args;
      if (operation === 'show' && name.startsWith('axr-upgrade-')) return `LoadState=not-found\nActiveState=${state.transientActive ? 'active' : 'inactive'}\nMainPID=${state.transientActive ? '123' : '0'}`;
      if (operation === 'show') return 'WantedBy=\nRequiredBy=\nTriggeredBy=\nPartOf=\nUpheldBy=\nDropInPaths=';
      if (operation === 'is-enabled') return state.enabled ? 'enabled' : 'disabled';
      if (operation === 'is-active') return name === 'nginx' ? state.nginxActive ? 'active' : 'inactive' : name.endsWith('.timer') ? 'active' : state.active ? 'active' : 'inactive';
      if (operation === 'start') state.active = true;
      else if (operation === 'stop') { if (name === 'nginx') state.nginxActive = false; else state.active = false; }
      else if (operation === 'enable') state.enabled = true;
      else if (operation === 'disable') state.enabled = false;
      else if (operation !== 'reload') throw new Error('unexpected systemctl');
      return '';
    }
    if (file.endsWith('/nginx')) return '';
    if (file.endsWith('/curl')) {
      const url = args.at(-1)!;
      if (url.startsWith('https:')) { if ((await readFile(paths.nginx, 'utf8')).includes('return 503;')) return '503'; if (state.tlsLag-- > 0) return '503'; return url.endsWith('/health') ? '200' : state.unauth; }
      if (url.includes('/api/')) return state.unauth;
      if (url.endsWith('/health')) return JSON.stringify({ ok: !state.wrongHealth, service: 'myscube-workbench', projectId: 'isolated-app' });
      return options.encoding === 'buffer' ? assets[new URL(url).pathname] : '';
    }
    throw new Error('unexpected command');
  });
  const actions = createPreSwitchRecoveryActions({ run, uid: process.getuid?.() || 0, paths, checkpoint }); actions.hostGate = async () => {};
  const input = { failedSourceSha: failedSha, failedOwner: owner, currentPins, dedicated: true, apply: true };
  return { folder, paths, target, lock, put, journal, pins, state, commands, run, actions, input, nginx, maintenance };
}

describe('pre-switch recovery with real private files and injected host commands', () => {
  it('plans without any service/file mutation', async () => {
    const f = await fixture(); const before = await readFile(join(f.paths.config, 'upgrade-journal.json'));
    expect(await recoverPreSwitch({ ...f.input, apply: false }, { actions: f.actions })).toMatchObject({ action: 'plan-pre-switch-recovery', candidateInstalled: false });
    expect(f.state.active).toBe(false); expect(await readFile(join(f.paths.config, 'upgrade-journal.json'))).toEqual(before);
    expect(f.commands.some(({ args }) => ['start', 'enable', 'reload', 'disable', 'stop'].includes(args[0]))).toBe(false);
  });
  it('restores only the unchanged old service and preserves failed evidence before resolving the journal', async () => {
    const f = await fixture(), before = await readFile(join(f.paths.config, 'release.json')); f.state.tlsLag = 1;
    const result = await recoverPreSwitch(f.input, { actions: f.actions });
    expect(result).toMatchObject({ action: 'restored-unswitched-service', restoredSourceSha: oldSha, failedCandidateSha: failedSha, candidateInstalled: false, databaseRollback: false });
    expect(f.state).toMatchObject({ active: true, enabled: true }); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.nginx);
    expect(await readlink(f.paths.current)).toBe(f.target); expect(await readFile(join(f.paths.config, 'release.json'))).toEqual(before);
    const archived = join(f.paths.config, `upgrade-recovered-${owner}`), recovery = join(f.paths.config, `pre-switch-recovery-completed-${owner}`);
    expect(JSON.parse(await readFile(join(archived, 'journal.json'), 'utf8'))).toEqual(f.journal);
    expect(JSON.parse(await readFile(join(recovery, 'failed-journal.json'), 'utf8'))).toEqual(f.journal);
    expect(JSON.parse(await readFile(join(f.paths.config, 'upgrade-journal.json'), 'utf8'))).toMatchObject({ phase: 'complete', status: 'completed', recovery: result });
    expect(f.commands.filter(({ file }) => file.endsWith('/docker')).every(({ args }) => args.includes('inspect') || args.includes('ps'))).toBe(true);
    await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toThrow();
  });
  it.each(['candidate-link', 'receipt', 'config', 'backup', 'activation', 'unit', 'owner', 'journal', 'tag', 'renderers', 'running-upgrade'])('refuses %s divergence before starting any service', async kind => {
    const f = await fixture();
    if (kind === 'candidate-link') { await mkdir(join(f.paths.releases, failedSha)); await rm(f.paths.current); await symlink(join(f.paths.releases, failedSha), f.paths.current); }
    if (kind === 'receipt') await f.put(join(f.paths.config, 'release.json'), '{}');
    if (kind === 'config') await f.put(join(f.paths.config, 'runtime.env'), 'changed');
    if (kind === 'backup') await f.put(join(f.lock, 'nginx.original'), 'changed');
    if (kind === 'activation') await f.put(join(f.paths.config, 'activation.json'), '{}');
    if (kind === 'unit') await f.put(join(f.paths.units, 'myscube-axr-workbench.service'), 'changed');
    if (kind === 'owner') await f.put(join(f.lock, 'owner.json'), { owner: 'wrong', pid: 123, sourceSha: failedSha });
    if (kind === 'journal') { const journal = { ...f.journal, phase: 'switch' }; await f.put(join(f.lock, 'journal.json'), journal); await f.put(join(f.paths.config, 'upgrade-journal.json'), journal); }
    if (kind === 'tag') f.state.tamperedTag = true;
    if (kind === 'renderers') f.state.renderers = true;
    if (kind === 'running-upgrade') f.state.transientActive = true;
    await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toThrow();
    expect(f.commands.some(({ args }) => args[0] === 'start')).toBe(false); expect(f.state.active).toBe(false);
  });
  it.each(['start', 'acceptance', 'reopen', 'enable', 'resolve'])('fails closed after %s error', async phase => {
    const f = await fixture(); f.actions[phase as keyof typeof f.actions] = vi.fn(async () => { throw new Error('private error'); }) as any;
    await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toMatchObject({ code: 'recovery_failed_kept_closed' });
    expect(f.state).toMatchObject({ active: false, enabled: false }); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.maintenance);
    expect(JSON.parse(await readFile(join(f.paths.config, 'upgrade-journal.json'), 'utf8'))).toEqual(f.journal);
  });
  it('closes ingress again on an abort immediately after reopening', async () => {
    const f = await fixture(), controller = new AbortController(), reopen = f.actions.reopen;
    f.actions.reopen = async () => { await reopen(); controller.abort(); };
    await expect(recoverPreSwitch(f.input, { actions: f.actions, signal: controller.signal })).rejects.toMatchObject({ code: 'recovery_failed_kept_closed' });
    expect(f.state).toMatchObject({ active: false, enabled: false }); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.maintenance);
  });
  it('refuses an existing recovery lock without deleting either owner', async () => {
    const f = await fixture(); await mkdir(join(f.paths.config, '.pre-switch-recovery-lock'));
    await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toThrow(); expect(await readFile(join(f.lock, 'owner.json'), 'utf8')).toContain(owner); expect(f.state.active).toBe(false);
  });
  it('restores the failed journal and retains the lock when resolution stops after writing an accepted journal', async () => {
    const f = await fixture(async phase => { if (phase === 'accepted-journal-written') throw new Error('simulated disk fault'); });
    await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toMatchObject({ code: 'recovery_failed_kept_closed' });
    expect(f.state).toMatchObject({ active: false, enabled: false }); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.maintenance);
    expect(JSON.parse(await readFile(join(f.paths.config, 'upgrade-journal.json'), 'utf8'))).toEqual(f.journal);
    expect(JSON.parse(await readFile(join(f.paths.config, '.pre-switch-recovery-lock/recovery-failed.json'), 'utf8'))).toMatchObject({ status: 'recovery-failed-kept-closed', stopped: true, disabled: true, closed: true });
    expect(await readFile(join(f.lock, 'owner.json'), 'utf8')).toContain(owner);
  });
  it.each(['failed-lock-archived', 'recovery-directory-synced'])('contains fault or late abort at %s and preserves the failed lock', async phase => {
    const controller = new AbortController();
    const f = await fixture(async checkpoint => { if (checkpoint === phase) { if (phase === 'recovery-directory-synced') controller.abort(); else throw new Error('archive fault'); } });
    await expect(recoverPreSwitch(f.input, { actions: f.actions, signal: controller.signal })).rejects.toMatchObject({ code: 'recovery_failed_kept_closed' });
    expect(f.state).toMatchObject({ active: false, enabled: false }); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.maintenance);
    expect(JSON.parse(await readFile(join(f.paths.config, 'upgrade-journal.json'), 'utf8'))).toEqual(f.journal);
    expect(await readFile(join(f.lock, 'owner.json'), 'utf8')).toContain(owner);
    const folder = phase === 'recovery-directory-synced' ? `pre-switch-recovery-completed-${owner}` : '.pre-switch-recovery-lock';
    expect(JSON.parse(await readFile(join(f.paths.config, folder, 'recovery-failed.json'), 'utf8'))).toMatchObject({ status: 'recovery-failed-kept-closed', stopped: true, disabled: true, closed: true });
  });
  it('requires correct actual health and unauthenticated API status before reopen', async () => {
    for (const kind of ['health', 'auth']) { const f = await fixture(); if (kind === 'health') f.state.wrongHealth = true; else f.state.unauth = '200';
      await expect(recoverPreSwitch(f.input, { actions: f.actions })).rejects.toMatchObject({ code: 'recovery_failed_kept_closed' }); expect(f.state.active).toBe(false); expect(await readFile(f.paths.nginx, 'utf8')).toBe(f.maintenance); }
  });
});
