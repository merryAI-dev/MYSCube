import { X509Certificate, createPrivateKey, createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
export const TLS_RENEWAL_PATHS = Object.freeze({ domain: 'axr.myscguard.app', lineage: '/etc/letsencrypt/live/axr.myscguard.app', archive: '/etc/letsencrypt/archive/axr.myscguard.app',
  tls: '/etc/myscube-workbench/tls', activation: '/etc/myscube-workbench/activation.json', nginx: '/etc/nginx/conf.d/myscube-workbench.conf', caPath: '/etc/ssl/certs', caFile: '/etc/ssl/certs/ca-certificates.crt' });
const error = code => Object.assign(new Error(code), { code });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const execute = async (file, args) => (await exec(file, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 15000, maxBuffer: 128000 })).stdout.trim();
const syncDirectory = async path => { const file = await open(path, constants.O_RDONLY); try { await file.sync(); } finally { await file.close(); } };
async function nginxActive(run) {
  let state;
  try { state = await run('/usr/bin/systemctl', ['is-active', 'nginx']); }
  catch (cause) { if (cause.code === 3 && cause.stdout?.trim() === 'inactive') return false; throw error('tls_nginx_state_unknown'); }
  if (!['active', 'inactive'].includes(state)) throw error('tls_nginx_state_unknown');
  return state === 'active';
}

async function directory(path, uid) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid || (info.mode & 0o022)) throw error('tls_directory_invalid');
  if (await realpath(path) !== path) throw error('tls_directory_symlink');
}

async function snapshot(path, limit, uid, secret = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.nlink !== 1 || info.size < 1 || info.size > limit || (info.mode & 0o022) || secret && (info.mode & 0o077)) throw error('tls_file_invalid');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(info, await handle.stat())) throw error('tls_file_changed');
    const bytes = Buffer.alloc(limit + 1); let total = 0;
    while (total <= limit) { const chunk = await handle.read(bytes, total, bytes.length - total, total); if (!chunk.bytesRead) break; total += chunk.bytesRead; }
    if (total > limit || !same(info, await handle.stat()) || !same(info, await lstat(path))) throw error('tls_file_changed');
    return { bytes: bytes.subarray(0, total), assertCurrent: async () => { if (!same(info, await lstat(path))) throw error('tls_file_changed'); } };
  } finally { await handle.close(); }
}

function certificates(bytes) {
  const text = bytes.toString('utf8'), blocks = text.match(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length < 2 || blocks.length > 10 || text.replace(/-----BEGIN CERTIFICATE-----\s+[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g, '').trim()) throw error('tls_chain_format_invalid');
  return blocks.map(block => ({ pem: `${block}\n`, certificate: new X509Certificate(block) }));
}

export function validateRenewedChain({ fullchain, installedKey, domain, now = Date.now() }) {
  const blocks = certificates(fullchain), leaf = blocks[0].certificate;
  if (leaf.ca || leaf.checkHost(domain, { subject: 'never', wildcards: false }) !== domain) throw error('tls_hostname_invalid');
  if (Date.parse(leaf.validFrom) > now || Date.parse(leaf.validTo) - now < 7 * 86400000) throw error('tls_validity_invalid');
  if (!leaf.checkPrivateKey(createPrivateKey(installedKey))) throw error('tls_key_rotation_requires_maintenance');
  return { leaf: blocks[0].pem, chain: blocks.slice(1).map(block => block.pem).join(''), canonical: blocks.map(block => block.pem).join(''), fingerprint: leaf.fingerprint256, expiresAt: new Date(leaf.validTo).toISOString() };
}

async function durableFile(path, bytes, mode) {
  const file = await open(path, 'wx', mode);
  try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
}

export async function renewTlsCertificate({ apply = false, env = process.env, paths = TLS_RENEWAL_PATHS, uid = 0, run = execute, now = Date.now } = {}) {
  if (env.RENEWED_LINEAGE !== paths.lineage || env.RENEWED_DOMAINS?.trim() !== paths.domain) throw error('tls_renewal_context_invalid');
  for (const path of [paths.tls, paths.lineage, paths.archive]) await directory(path, uid);
  const activation = await snapshot(paths.activation, 4096, uid, true);
  if (JSON.parse(activation.bytes).domain !== paths.domain) throw error('tls_activation_domain_invalid');
  const nginx = await snapshot(paths.nginx, 30000, uid);
  const config = nginx.bytes.toString('utf8');
  const directives = name => [...config.matchAll(new RegExp(`^\\s*${name}\\s+([^;]+);\\s*$`, 'gm'))].map(match => match[1]);
  if (JSON.stringify(directives('server_name')) !== JSON.stringify([paths.domain]) || JSON.stringify(directives('ssl_certificate')) !== JSON.stringify([`${paths.tls}/fullchain.pem`]) || JSON.stringify(directives('ssl_certificate_key')) !== JSON.stringify([`${paths.tls}/key.pem`])) throw error('tls_nginx_paths_changed');
  const lock = join(paths.tls, '.renewal-lock');
  try { await mkdir(lock, { mode: 0o700 }); } catch (cause) { if (cause.code === 'EEXIST') throw error('tls_renewal_locked'); throw cause; }
  const token = randomUUID(), staged = join(paths.tls, `.renewal-${token}.pem`), backup = join(paths.tls, `.rollback-${token}.pem`), target = join(paths.tls, 'fullchain.pem');
  let swapped = false, reloadAttempted = false, completed = false, keepLock = false, installedHash, previousHash;
  try {
    await writeFile(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, startedAt: new Date(now()).toISOString() }), { flag: 'wx', mode: 0o600 });
    const sourceLink = join(paths.lineage, 'fullchain.pem'), source = await realpath(sourceLink);
    const sourceLinkInfo = await lstat(sourceLink);
    if (!sourceLinkInfo.isSymbolicLink() || sourceLinkInfo.uid !== uid || sourceLinkInfo.nlink !== 1) throw error('tls_lineage_link_invalid');
    if (!new RegExp(`^fullchain[0-9]+\\.pem$`).test(source.slice(paths.archive.length + 1)) || !source.startsWith(`${paths.archive}/`)) throw error('tls_lineage_escape');
    const [fresh, current, key] = await Promise.all([snapshot(source, 200000, uid), snapshot(target, 200000, uid), snapshot(join(paths.tls, 'key.pem'), 30000, uid, true)]);
    const validated = validateRenewedChain({ fullchain: fresh.bytes, installedKey: key.bytes, domain: paths.domain, now: now() });
    await durableFile(join(lock, 'leaf.pem'), validated.leaf, 0o600);
    await durableFile(join(lock, 'chain.pem'), validated.chain, 0o600);
    await run('/usr/bin/openssl', ['verify', '-purpose', 'sslserver', '-CAfile', paths.caFile, '-CApath', paths.caPath, '-untrusted', join(lock, 'chain.pem'), join(lock, 'leaf.pem')]);
    for (const file of [activation, nginx, fresh, current, key]) await file.assertCurrent();
    if (await realpath(sourceLink) !== source || !same(sourceLinkInfo, await lstat(sourceLink))) throw error('tls_lineage_changed');
    if (!apply) return { status: 'checked', fingerprint: validated.fingerprint, expiresAt: validated.expiresAt };
    if (certificates(current.bytes).map(block => block.pem).join('') === validated.canonical) return { status: 'unchanged', fingerprint: validated.fingerprint, expiresAt: validated.expiresAt };
    await durableFile(staged, validated.canonical, 0o644);
    await durableFile(backup, current.bytes, 0o644);
    installedHash = hash(validated.canonical); previousHash = hash(current.bytes);
    for (const file of [nginx, current, key]) await file.assertCurrent();
    await rename(staged, target); swapped = true;
    await syncDirectory(paths.tls);
    await run('/usr/sbin/nginx', ['-t']);
    const active = await nginxActive(run);
    if (active) { reloadAttempted = true; await run('/usr/bin/systemctl', ['reload', 'nginx']); }
    completed = true;
    return { status: active ? 'reloaded' : 'installed_inactive', fingerprint: validated.fingerprint, expiresAt: validated.expiresAt };
  } catch (cause) {
    if (swapped && !completed) {
      try {
        if (hash((await snapshot(target, 200000, uid)).bytes) !== installedHash || hash((await snapshot(backup, 200000, uid)).bytes) !== previousHash) {
          throw error('tls_target_changed_during_rollback');
        }
        await rename(backup, target);
        await syncDirectory(paths.tls);
        await run('/usr/sbin/nginx', ['-t']);
        if (reloadAttempted && await nginxActive(run)) await run('/usr/bin/systemctl', ['reload', 'nginx']);
      } catch { keepLock = true; throw error('tls_rollback_failed_manual_review'); }
    }
    throw cause;
  } finally {
    if (!keepLock) {
      await rm(staged, { force: true }); await rm(backup, { force: true }); await rm(lock, { recursive: true });
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (process.getuid?.() !== 0 || process.platform !== 'linux' || args.length !== 1 || !['--check', '--apply'].includes(args[0])) {
    process.stderr.write('TLS renewal requires the dedicated Linux root deployment hook and --check or --apply.\n'); process.exitCode = 1;
  } else {
    renewTlsCertificate({ apply: args[0] === '--apply' }).then(result => process.stdout.write(`${JSON.stringify({ event: 'workbench.tls-renewal', ...result })}\n`)).catch(cause => {
      const code = /^tls_[a-z_]+$/.test(cause.code || '') ? cause.code : 'tls_renewal_failed';
      process.stderr.write(`${JSON.stringify({ event: 'workbench.tls-renewal', status: 'failed', code })}\n`); process.exitCode = 1;
    });
  }
}
