import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod, symlink, link, realpath, readlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { upgradeHost, createUpgradeActions, validateUpgradePins, validateUntaggedArchive, readUpgradeFile, renderUpgradeMaintenance, UPGRADE_PATHS } from './upgrade-host.mjs';
import { renderBootstrapNginx } from './bootstrap-install.mjs';

const oldSha = 'a'.repeat(40), sourceSha = 'b'.repeat(40), hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const oldApp = `sha256:${'1'.repeat(64)}`, oldRenderer = `sha256:${'2'.repeat(64)}`, newApp = `sha256:${'3'.repeat(64)}`, newRenderer = `sha256:${'4'.repeat(64)}`;
const pins = () => ({ sourceSha: oldSha, receiptSha256: 'c'.repeat(64), configurationSha256: 'd'.repeat(64), nginxSha256: 'e'.repeat(64), appImageId: oldApp, rendererImageId: oldRenderer });
const options = () => ({ directory: '/root/release', sourceSha, manifestSha256: 'f'.repeat(64), currentPins: '/root/current-pins.json', apply: true, dedicated: true });
function orchestration() {
  const calls: string[] = [], state = { ingress: 200, enabled: true, active: true, app: oldApp, renderer: oldRenderer, link: oldSha, receipt: oldSha, lock: false };
  const input = { pins: pins(), bundle: { sourceSha, manifestSha256: 'f'.repeat(64), manifest: { images: [] } } };
  const action = (name: string, handler = async () => {}) => vi.fn(async (..._args: unknown[]) => { calls.push(name); return handler(); });
  const actions: any = {
    inputs: action('inputs', async () => input as any), hostGate: action('hostGate'), acquire: action('acquire', async () => { if (state.lock) throw new Error('lock held'); state.lock = true; }),
    preflight: action('preflight'), stage: action('stage', async () => ({ final: `/opt/myscube-workbench-releases/${sourceSha}` }) as any),
    journal: vi.fn(async (phase, status) => { calls.push(`journal:${phase}:${status}`); }),
    maintenance: action('maintenance', async () => { state.ingress = 503; }), disable: action('disable', async () => { state.enabled = false; }),
    stop: action('stop', async () => { state.active = false; }), drain: action('drain'),
    switchRelease: action('switch', async () => { expect(state).toMatchObject({ enabled: false, active: false, ingress: 503 }); state.app = newApp; state.renderer = newRenderer; state.link = sourceSha; state.receipt = sourceSha; }),
    runtimeSmoke: action('runtimeSmoke', async () => { expect(state.active).toBe(false); }), start: action('start', async () => { state.active = true; }), acceptance: action('acceptance'),
    reopen: action('reopen', async () => { state.ingress = 200; }), enable: action('enable', async () => { state.enabled = true; }),
    failClosed: action('failClosed', async () => { state.enabled = false; state.active = false; state.ingress = 503; }), releaseLock: action('releaseLock', async () => { state.lock = false; }),
  };
  return { calls, state, actions };
}

describe('upgrade orchestration with injected actions (not actual host acceptance)', () => {
  it('plans by default without host, Docker or service mutation', async () => {
    const f = orchestration(); const { apply: _apply, dedicated: _dedicated, ...input } = options();
    expect(await upgradeHost(input, { actions: f.actions })).toMatchObject({ action: 'plan', apply: false, automaticRollback: false }); expect(f.calls).toEqual(['inputs']);
  });
  it('preserves maintenance/disabled state until pair, native runtime and renderer checks complete', async () => {
    const f = orchestration(); expect(await upgradeHost(options(), { actions: f.actions })).toMatchObject({ action: 'upgraded', authorizedBrowserAcceptanceRequired: true });
    expect(f.calls.filter(name => !name.startsWith('journal'))).toEqual(['inputs', 'hostGate', 'acquire', 'preflight', 'stage', 'maintenance', 'disable', 'stop', 'drain', 'switch', 'runtimeSmoke', 'start', 'acceptance', 'reopen', 'enable', 'releaseLock']);
    expect(f.state).toMatchObject({ enabled: true, active: true, ingress: 200, app: newApp, renderer: newRenderer, lock: false });
  });
  it.each(['maintenance', 'disable', 'stop', 'drain', 'switchRelease', 'runtimeSmoke', 'start', 'acceptance', 'reopen', 'enable'])('fails closed without any old restart after %s fails', async phase => {
    const f = orchestration(); f.actions[phase].mockRejectedValueOnce(Object.assign(new Error('private command output'), { code: 'upgrade_synthetic_failure' }));
    await expect(upgradeHost(options(), { actions: f.actions })).rejects.toMatchObject({ code: 'upgrade_failed_manual_review' });
    expect(f.state).toMatchObject({ ingress: 503, enabled: false, active: false, lock: true }); expect(f.actions.releaseLock).not.toHaveBeenCalled();
    expect(f.actions.journal).toHaveBeenLastCalledWith(expect.any(String), 'failed-kept-closed', 'upgrade_synthetic_failure');
    expect(f.calls.filter(value => value === 'start').length).toBeLessThanOrEqual(1);
  });
  it.each(['app', 'renderer', 'link', 'receipt'])('keeps reboot startup disabled after interruption at partial %s switch', async checkpoint => {
    const f = orchestration();
    f.actions.switchRelease.mockImplementation(async () => {
      expect(f.state.enabled).toBe(false); expect(f.state.active).toBe(false);
      for (const [name, value] of [['app', newApp], ['renderer', newRenderer], ['link', sourceSha], ['receipt', sourceSha]]) {
        (f.state as any)[name] = value; if (name === checkpoint) throw new Error('simulated abrupt checkpoint');
      }
    });
    await expect(upgradeHost(options(), { actions: f.actions })).rejects.toMatchObject({ code: 'upgrade_failed_manual_review' });
    expect(f.state.enabled && f.state.active).toBe(false); expect(f.state.ingress).toBe(503); expect(f.actions.start).not.toHaveBeenCalled();
    expect(f.state.app).toBe(newApp); // No automatic old image rollback, even on a partial pair.
  });
  it('recloses ingress and disables restart on a signal arriving during the reopen await', async () => {
    const f = orchestration(), controller = new AbortController();
    f.actions.reopen.mockImplementation(async () => { f.state.ingress = 200; controller.abort(); });
    await expect(upgradeHost(options(), { actions: f.actions, signal: controller.signal })).rejects.toMatchObject({ code: 'upgrade_failed_manual_review' });
    expect(f.state).toMatchObject({ ingress: 503, enabled: false, active: false, lock: true }); expect(f.actions.enable).not.toHaveBeenCalled();
  });
  it('leaves the existing live service intact when preflight or staging fails before maintenance', async () => {
    for (const phase of ['preflight', 'stage']) {
      const f = orchestration(); f.actions[phase].mockRejectedValueOnce(new Error('invalid release'));
      await expect(upgradeHost(options(), { actions: f.actions })).rejects.toMatchObject({ code: 'upgrade_failed_manual_review' });
      expect(f.state).toMatchObject({ ingress: 200, active: true, enabled: true, app: oldApp, lock: true }); expect(f.actions.failClosed).not.toHaveBeenCalled(); expect(f.actions.start).not.toHaveBeenCalled();
    }
  });
  it('distinguishes unknown containment and retains the lock/journal instead of claiming safe failure', async () => {
    const f = orchestration(); f.actions.acceptance.mockRejectedValueOnce(new Error('failed')); f.actions.failClosed.mockRejectedValueOnce(new Error('stop unavailable'));
    await expect(upgradeHost(options(), { actions: f.actions })).rejects.toMatchObject({ code: 'upgrade_containment_unconfirmed' });
    expect(f.actions.releaseLock).not.toHaveBeenCalled(); expect(f.actions.journal).toHaveBeenLastCalledWith('acceptance', 'failed-containment-unconfirmed', 'upgrade_phase_failed');
  });
  it('accepts Docker 29 containerd index identity separately from config digest and rejects nested mutable names', () => {
    const leaf = Buffer.from(JSON.stringify({ schemaVersion: 2, config: { digest: `sha256:${'9'.repeat(64)}` }, layers: [] }));
    const leafId = `sha256:${hash(leaf)}`;
    const nested = Buffer.from(JSON.stringify({ schemaVersion: 2, manifests: [{ digest: leafId, size: leaf.length, mediaType: 'application/vnd.oci.image.manifest.v1+json' }] }));
    const id = `sha256:${hash(nested)}`;
    const index = JSON.stringify({ schemaVersion: 2, manifests: [{ digest: id, size: nested.length, mediaType: 'application/vnd.oci.image.index.v1+json' }] });
    const manifest = JSON.stringify([{ Config: `blobs/sha256/${'9'.repeat(64)}`, RepoTags: null, Layers: [] }]);
    expect(() => validateUntaggedArchive(manifest, id, index, { [id]: nested, [leafId]: leaf })).not.toThrow();
    expect(() => validateUntaggedArchive(manifest, newApp, index, { [id]: nested, [leafId]: leaf })).toThrow();
    const tagged = Buffer.from(JSON.stringify({ schemaVersion: 2, annotations: { 'io.containerd.image.name': 'myscube-workbench-app:release' }, manifests: [] })), taggedId = `sha256:${hash(tagged)}`;
    expect(() => validateUntaggedArchive(manifest, taggedId, JSON.stringify({ schemaVersion: 2, manifests: [{ digest: taggedId, size: tagged.length }] }), { [taggedId]: tagged })).toThrow();
    expect(() => validateUntaggedArchive(manifest, id, index, { [id]: Buffer.from('tampered'), [leafId]: leaf })).toThrow();
  });
  it('rejects unknown options, malformed external pins and unsupported archive tags before loading', async () => {
    const f = orchestration(); await expect(upgradeHost({ ...options(), paths: {} }, { actions: f.actions })).rejects.toMatchObject({ code: 'upgrade_options_invalid' }); expect(f.calls).toEqual([]);
    for (const value of [{ ...pins(), sourceSha: 'main' }, { ...pins(), rendererImageId: oldApp }, { ...pins(), extra: true }]) expect(() => validateUpgradePins(value)).toThrow();
    const saved = [{ Config: `${newApp.slice(7)}.json`, RepoTags: null, Layers: ['layer.tar'] }]; expect(() => validateUntaggedArchive(JSON.stringify(saved), newApp)).not.toThrow();
    expect(() => validateUntaggedArchive(JSON.stringify([{ ...saved[0], RepoTags: ['myscube-workbench-app:release'] }]), newApp)).toThrow();
    expect(() => validateUntaggedArchive(JSON.stringify(saved), oldApp)).toThrow();
    expect(() => validateUntaggedArchive(JSON.stringify(saved), newApp, JSON.stringify({ schemaVersion: 2, manifests: [{ annotations: { 'org.opencontainers.image.ref.name': 'release' } }] }))).toThrow();
  });
});

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });
async function directory() { const path = await realpath(await mkdtemp(join(tmpdir(), 'axr-upgrade-test-'))); temporary.push(path); return path; }
const uid = process.getuid!();

describe('upgrade real filesystem ownership and preflight contracts', () => {
  it('rejects symlinks, hardlinks, unsafe mode/owner and changed snapshots without allocating archive-size buffers', async () => {
    const root = await directory(), file = join(root, 'file'); await writeFile(file, 'original', { mode: 0o600 });
    const checked = await readUpgradeFile(file, 100, { uid, secret: true }); expect(checked.bytes.toString()).toBe('original');
    await writeFile(file, 'changed'); await expect(checked.assertCurrent()).rejects.toMatchObject({ code: 'upgrade_file_changed' });
    const symbolic = join(root, 'symlink'); await symlink(file, symbolic); await expect(readUpgradeFile(symbolic, 100, { uid })).rejects.toMatchObject({ code: 'upgrade_file_invalid' });
    await expect(readUpgradeFile(file, 100, { uid: uid + 1 })).rejects.toMatchObject({ code: 'upgrade_file_invalid' });
    await chmod(file, 0o666); await expect(readUpgradeFile(file, 100, { uid })).rejects.toMatchObject({ code: 'upgrade_file_invalid' }); await chmod(file, 0o600);
    await link(file, join(root, 'hardlink')); await expect(readUpgradeFile(file, 100, { uid })).rejects.toMatchObject({ code: 'upgrade_file_invalid' });
  });
  async function fixture() {
    const root = await directory(), paths = { config: join(root, 'etc/config'), releases: join(root, 'opt/releases'), current: join(root, 'opt/current'), nginx: join(root, 'etc/nginx/conf.d/myscube-workbench.conf'), units: join(root, 'etc/systemd/system') };
    for (const path of [paths.config, paths.releases, dirname(paths.nginx), join(root, 'etc/nginx/sites-enabled'), paths.units, join(paths.releases, oldSha)]) await mkdir(path, { recursive: true, mode: 0o700 });
    const images = [{ role: 'app', tag: 'myscube-workbench-app:release', id: oldApp }, { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', id: oldRenderer }];
    const auth = { projectId: 'approved-auth', domain: 'approved.firebaseapp.com', apiKeySha256: 'a'.repeat(64) };
    const manifest = { sourceSha: oldSha, classification: 'production_candidate', build: { auth }, images };
    const receipt = JSON.stringify({ manifest, manifestSha256: 'c'.repeat(64) }), env = 'WORKBENCH_PROJECT_ID="isolated-data"\nPRODUCTION_PROJECT_ID="business-data"\nWORKBENCH_AUTH_PROJECT_ID="approved-auth"\n';
    const nginx = renderBootstrapNginx('workbench.example.org');
    const currentPins = { ...pins(), receiptSha256: hash(receipt), configurationSha256: hash(env), nginxSha256: hash(nginx) };
    await writeFile(join(paths.config, 'release.json'), receipt, { mode: 0o600 }); await writeFile(join(paths.config, 'runtime.env'), env, { mode: 0o600 });
    await writeFile(join(paths.config, 'activation.json'), JSON.stringify({ sourceSha: oldSha, domain: 'workbench.example.org', configurationSha256: hash(env) }), { mode: 0o600 });
    await writeFile(paths.nginx, nginx, { mode: 0o644 }); await symlink(join(paths.releases, oldSha), paths.current);
    for (const [name, relative] of Object.entries({ 'myscube-axr-workbench.service': 'host-runtime/systemd/myscube-axr-workbench.service', 'myscube-axr-renderer-reaper.service': 'remote-runtime/systemd/myscube-axr-renderer-reaper.service', 'myscube-axr-renderer-reaper.timer': 'remote-runtime/systemd/myscube-axr-renderer-reaper.timer' })) {
      const source = join(paths.releases, oldSha, 'server/workbench', relative); await mkdir(dirname(source), { recursive: true }); await writeFile(source, name, { mode: 0o644 }); await writeFile(join(paths.units, name), name, { mode: 0o644 });
    }
    const run = vi.fn(async (file: string, args: string[]) => {
      if (file.endsWith('docker')) {
        const target = args.at(-1)!; const id = target.includes('app:') ? oldApp : target.includes('renderer:') ? oldRenderer : target;
        if (args.includes('inspect')) return args[args.indexOf('--format') + 1] === '{{json .Id}}' ? JSON.stringify(id) : [id, 'linux', 'amd64', oldSha, 'production_candidate'].map(value => JSON.stringify(value)).join('\n');
        return '';
      }
      if (args[0] === 'is-active') return 'active';
      if (args[0] === 'is-enabled') return 'enabled';
      if (args[0] === 'show') return 'WantedBy=multi-user.target\nRequiredBy=\nTriggeredBy=\nPartOf=\nUpheldBy=\nDropInPaths=';
      if (file.endsWith('df')) return 'Avail\n34000000000';
      if (file.endsWith('curl')) return '503';
      return '';
    });
    const input = { pins: currentPins, bundle: { sourceSha, manifestSha256: 'f'.repeat(64), manifest: { sourceSha, build: { auth }, images: [{ bytes: 10 }] } } };
    const actions = createUpgradeActions({ uid, paths, run }); await actions.acquire(input); return { root, paths, input, actions, run };
  }
  it('checks actual pinned receipt/config/link/auth and saves exact original files before maintenance', async () => {
    const f = await fixture(); await expect(f.actions.preflight(f.input)).resolves.toMatchObject({ domain: 'workbench.example.org' });
    const before = await readFile(f.paths.nginx, 'utf8'); await f.actions.maintenance();
    expect(await readFile(f.paths.nginx, 'utf8')).toBe(renderUpgradeMaintenance('workbench.example.org'));
    expect(await readFile(join(f.paths.config, '.upgrade-lock/nginx.original'), 'utf8')).toBe(before);
  });
  it.each(['receipt', 'config', 'auth'])('rejects changed %s during preflight with no service stop or tag writes', async field => {
    const f = await fixture();
    if (field === 'receipt') await writeFile(join(f.paths.config, 'release.json'), '{}');
    if (field === 'config') await writeFile(join(f.paths.config, 'runtime.env'), 'changed');
    if (field === 'auth') f.input.bundle.manifest.build.auth = { ...f.input.bundle.manifest.build.auth, projectId: 'different-auth' };
    await expect(f.actions.preflight(f.input)).rejects.toThrow(); expect(f.run.mock.calls.some(([, args]) => args.includes('stop') || args.includes('tag'))).toBe(false);
  });
  it('does not overwrite nginx/config changes made after staging and before closing ingress', async () => {
    for (const field of ['nginx', 'config']) {
      const f = await fixture(); await f.actions.preflight(f.input); const path = field === 'nginx' ? f.paths.nginx : join(f.paths.config, 'runtime.env');
      await writeFile(path, 'external change'); await expect(f.actions.maintenance()).rejects.toMatchObject({ code: 'upgrade_file_changed' }); expect(await readFile(path, 'utf8')).toBe('external change');
    }
  });
  it('rejects a changed image tag after attempted pair switch before changing the current link or starting', async () => {
    const f = await fixture(); await f.actions.preflight(f.input); await f.actions.maintenance();
    const previous = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => args[0] === 'is-active' && args[1] === 'myscube-axr-workbench.service' ? 'inactive' : previous(file, args));
    const candidate = { ...f.input, bundle: { ...f.input.bundle, manifest: { ...f.input.bundle.manifest, images: [{ role: 'app', tag: 'myscube-workbench-app:release', id: newApp }, { role: 'renderer', tag: 'myscube-axr-renderer:1.58.2-v1', id: newRenderer }] } } };
    await expect(f.actions.switchRelease(candidate, { final: join(f.paths.releases, sourceSha) })).rejects.toMatchObject({ code: 'upgrade_tag_changed' });
    expect(await readlink(f.paths.current)).toBe(join(f.paths.releases, oldSha));
    expect(JSON.parse(await readFile(join(f.paths.config, 'release.json'), 'utf8')).manifest.sourceSha).toBe(oldSha);
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'start')).toBe(false);
  });
  it('still attempts app stop when persistent disable fails and never claims complete containment', async () => {
    const f = await fixture(); await f.actions.preflight(f.input); await f.actions.maintenance();
    const previous = f.run.getMockImplementation()!;
    f.run.mockImplementation(async (file, args) => {
      if (args[0] === 'disable') throw new Error('systemctl failed');
      if (args[0] === 'is-active' && args[1] === 'myscube-axr-workbench.service') return 'inactive';
      return previous(file, args);
    });
    await expect(f.actions.failClosed()).rejects.toMatchObject({ code: 'upgrade_containment_unconfirmed' });
    expect(f.run.mock.calls.some(([, args]) => args[0] === 'stop' && args[1] === 'myscube-axr-workbench.service')).toBe(true);
  });
  it('writes a stable safe recovery journal containing both identities and phase without runtime credentials', async () => {
    const f = await fixture(); await f.actions.preflight(f.input); await f.actions.journal('switch', 'failed-kept-closed', 'upgrade_tag_changed');
    const saved = JSON.parse(await readFile(join(f.paths.config, 'upgrade-journal.json'), 'utf8'));
    expect(saved).toMatchObject({ phase: 'switch', status: 'failed-kept-closed', code: 'upgrade_tag_changed', previous: f.input.pins, candidate: { manifestSha256: 'f'.repeat(64), path: join(f.paths.releases, sourceSha) }, automaticRollback: false });
    expect(saved.runtimeEnvironment).toBeUndefined();
  });
  it('keeps fixed production paths and does not add a business database or cloud client dependency', async () => {
    expect(UPGRADE_PATHS.current).toBe('/opt/myscube-workbench');
    const source = await readFile('server/workbench/host-runtime/upgrade-host.mjs', 'utf8');
    expect(source).not.toMatch(/firebase-admin|@google-cloud|shell:\s*true|docker.*prune|execSync/); expect(source).not.toMatch(/readUpgradeFile\([^\n]+8 \* 1024 \*\* 3/);
  });
});
