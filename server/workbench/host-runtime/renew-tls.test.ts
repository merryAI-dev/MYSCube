import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm, symlink, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renewTlsCertificate, validateRenewedChain } from './renew-tls.mjs';

const exec = promisify(execFile);
describe('certificate renewal with an unchanged installed key', () => {
  let root: string, certs: string, paths: any, oldChain: Buffer, nextChain: Buffer, otherKeyChain: Buffer, key: Buffer;
  const domain = 'axr.myscguard.app';
  const openssl = async (...args: string[]) => (await exec('/usr/bin/openssl', args, { timeout: 15000 })).stdout.trim();
  const env = () => ({ RENEWED_LINEAGE: paths.lineage, RENEWED_DOMAINS: domain });
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'axr-renewal-'))); certs = join(root, 'certs'); await mkdir(certs);
    await writeFile(join(certs, 'ca.conf'), '[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=ca\n[dn]\nCN=Local Renewal Test Root\n[ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n');
    await openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90', '-keyout', join(certs, 'ca.key'), '-out', join(certs, 'ca.pem'), '-config', join(certs, 'ca.conf'));
    await openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', join(certs, 'key.pem'));
    await openssl('req', '-new', '-key', join(certs, 'key.pem'), '-subj', `/CN=${domain}`, '-out', join(certs, 'leaf.csr'));
    await writeFile(join(certs, 'leaf.conf'), `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${domain}\n`);
    const sign = (csr: string, target: string, serial: string, days: string) => openssl('x509', '-req', '-in', join(certs, csr), '-CA', join(certs, 'ca.pem'), '-CAkey', join(certs, 'ca.key'), '-set_serial', serial, '-days', days, '-extfile', join(certs, 'leaf.conf'), '-out', join(certs, target));
    await sign('leaf.csr', 'old.pem', '1', '30'); await sign('leaf.csr', 'new.pem', '2', '60');
    await openssl('genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', join(certs, 'other.key'));
    await openssl('req', '-new', '-key', join(certs, 'other.key'), '-subj', `/CN=${domain}`, '-out', join(certs, 'other.csr'));
    await sign('other.csr', 'other.pem', '3', '60');
    const ca = await readFile(join(certs, 'ca.pem'));
    oldChain = Buffer.concat([await readFile(join(certs, 'old.pem')), ca]); nextChain = Buffer.concat([await readFile(join(certs, 'new.pem')), ca]); otherKeyChain = Buffer.concat([await readFile(join(certs, 'other.pem')), ca]); key = await readFile(join(certs, 'key.pem'));
    await mkdir(join(certs, 'trust')); await writeFile(join(certs, 'trust', `${await openssl('x509', '-hash', '-noout', '-in', join(certs, 'ca.pem'))}.0`), ca);
  });
  beforeEach(async () => {
    const fixture = join(root, 'fixture'); await rm(fixture, { recursive: true, force: true }); await mkdir(fixture, { mode: 0o700 });
    paths = { domain, lineage: join(fixture, 'live'), archive: join(fixture, 'archive'), tls: join(fixture, 'tls'), activation: join(fixture, 'activation.json'), nginx: join(fixture, 'nginx.conf'), caPath: join(certs, 'trust'), caFile: join(certs, 'ca.pem') };
    for (const path of [paths.lineage, paths.archive, paths.tls]) await mkdir(path, { mode: 0o700 });
    await writeFile(paths.activation, JSON.stringify({ domain }), { mode: 0o600 });
    await writeFile(paths.nginx, `server {\n server_name ${domain};\n ssl_certificate ${paths.tls}/fullchain.pem;\n ssl_certificate_key ${paths.tls}/key.pem;\n}\n`, { mode: 0o644 });
    await writeFile(join(paths.tls, 'key.pem'), key, { mode: 0o600 }); await writeFile(join(paths.tls, 'fullchain.pem'), oldChain, { mode: 0o644 });
    await writeFile(join(paths.archive, 'fullchain2.pem'), nextChain, { mode: 0o644 }); await symlink(join(paths.archive, 'fullchain2.pem'), join(paths.lineage, 'fullchain.pem'));
  });
  afterAll(async () => { await rm(root, { recursive: true, force: true }); });
  const runner = (active = true) => vi.fn(async (file: string, args: string[]) => file === '/usr/bin/openssl' ? openssl(...args) : args[0] === 'is-active' ? (active ? 'active' : 'inactive') : '');
  const apply = (run: any, extra = {}) => renewTlsCertificate({ apply: true, env: env(), paths, uid: process.getuid!(), run, ...extra });

  it('verifies a real chain and atomically renews the certificate while the key inode/bytes stay unchanged', async () => {
    const run = runner(), before = await stat(join(paths.tls, 'key.pem'));
    expect(await apply(run)).toMatchObject({ status: 'reloaded' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(nextChain);
    expect(await readFile(join(paths.tls, 'key.pem'))).toEqual(key);
    expect((await stat(join(paths.tls, 'key.pem'))).ino).toBe(before.ino);
    expect(run.mock.calls.map(([file, args]) => [file, ...args].join(' '))).toContain('/usr/sbin/nginx -t');
    expect(await apply(run)).toMatchObject({ status: 'unchanged' });
    expect(run.mock.calls.filter(([, args]) => args[0] === 'reload')).toHaveLength(1);
  });
  it('does not change either installed file when the renewed key rotated', async () => {
    await writeFile(join(paths.archive, 'fullchain2.pem'), otherKeyChain);
    const run = runner();
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_key_rotation_requires_maintenance' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(oldChain);
    expect(run).not.toHaveBeenCalled();
  });
  it('check mode validates but never replaces certificates or reloads nginx', async () => {
    const run = runner(); expect(await apply(run, { apply: false })).toMatchObject({ status: 'checked' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(oldChain);
    expect(run.mock.calls.every(([file]) => file === '/usr/bin/openssl')).toBe(true);
  });
  it('installs for an inactive nginx without starting or reloading the service', async () => {
    const run = runner(false); expect(await apply(run)).toMatchObject({ status: 'installed_inactive' });
    expect(run.mock.calls.some(([, args]) => ['start', 'reload'].includes(args[0]))).toBe(false);
  });
  it.each(['syntax', 'reload'])('restores the previous fullchain after %s failure', async failure => {
    const base = runner(); let failed = false;
    const run = vi.fn(async (file: string, args: string[]) => {
      if (!failed && (failure === 'syntax' && file === '/usr/sbin/nginx' || failure === 'reload' && args[0] === 'reload')) { failed = true; throw new Error('simulated command failure'); }
      return base(file, args);
    });
    await expect(apply(run)).rejects.toThrow('simulated command failure');
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(oldChain);
    expect(await readFile(join(paths.tls, 'key.pem'))).toEqual(key);
    if (failure === 'reload') expect(run.mock.calls.filter(([, args]) => args[0] === 'reload')).toHaveLength(2);
  });
  it('fails before replacement for an untrusted chain, unrelated lineage, or unsafe key mode', async () => {
    const run = runner();
    await expect(apply(run, { env: { ...env(), RENEWED_LINEAGE: '/unrelated' } })).rejects.toMatchObject({ code: 'tls_renewal_context_invalid' });
    await expect(apply(async () => { throw new Error('untrusted chain'); })).rejects.toThrow('untrusted chain');
    await chmod(join(paths.tls, 'key.pem'), 0o644);
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_file_invalid' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(oldChain);
  });
  it('retains the lock and does not overwrite a target changed by another actor during failed application', async () => {
    const base = runner();
    const run = async (file: string, args: string[]) => {
      if (file === '/usr/sbin/nginx') { await writeFile(join(paths.tls, 'fullchain.pem'), 'operator-changed-file'); throw new Error('syntax failure'); }
      return base(file, args);
    };
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_rollback_failed_manual_review' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'), 'utf8')).toBe('operator-changed-file');
    expect((await stat(join(paths.tls, '.renewal-lock'))).isDirectory()).toBe(true);
  });
  it('rolls back if service state cannot be determined instead of treating it as inactive', async () => {
    const base = runner();
    const run = async (file: string, args: string[]) => { if (args[0] === 'is-active') throw new Error('systemd unavailable'); return base(file, args); };
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_nginx_state_unknown' });
    expect(await readFile(join(paths.tls, 'fullchain.pem'))).toEqual(oldChain);
  });
  it('rejects archive escapes, concurrent hooks and future/near-expiry leaves', async () => {
    const run = runner();
    await rm(join(paths.lineage, 'fullchain.pem')); await symlink(join(certs, 'new.pem'), join(paths.lineage, 'fullchain.pem'));
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_lineage_escape' });
    await mkdir(join(paths.tls, '.renewal-lock'));
    await expect(apply(run)).rejects.toMatchObject({ code: 'tls_renewal_locked' });
    expect(() => validateRenewedChain({ fullchain: nextChain, installedKey: key, domain, now: Date.now() - 86400000 })).toThrow('tls_validity_invalid');
    expect(() => validateRenewedChain({ fullchain: nextChain, installedKey: key, domain, now: Date.now() + 59 * 86400000 })).toThrow('tls_validity_invalid');
    expect(() => validateRenewedChain({ fullchain: nextChain, installedKey: key, domain: 'other.example.org' })).toThrow('tls_hostname_invalid');
  });
});
