import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, writeFile, mkdir, mkdtemp, readdir, realpath, readlink, symlink, rename, chmod, chown, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReleaseBundle } from '../deployment/release-bundle.mjs';
import { resolveWorkbenchRuntime } from '../runtime-config.mjs';

const exec = promisify(execFile);
const current = '/opt/myscube-workbench';
const releases = '/opt/myscube-workbench-releases';
const configRoot = '/etc/myscube-workbench';
const sha = /^[a-f0-9]{40}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const allowed = new Set(['WORKBENCH_PROJECT_ID', 'PRODUCTION_PROJECT_ID', 'WORKBENCH_MODEL_PROJECT_ID', 'PRODUCTION_MODEL_PROJECT_ID', 'WORKBENCH_AUTH_PROJECT_ID', 'WORKBENCH_TENANT_ID', 'WORKBENCH_APP_ORIGIN', 'WORKBENCH_AI_ENABLED', 'WORKBENCH_GEMINI_API_KEY', 'WORKBENCH_HTML_MODEL', 'WORKBENCH_READS_ENABLED', 'WORKBENCH_REMOTE_RUNTIME_ENABLED', 'WORKBENCH_REMOTE_RUNTIME_DRIVER', 'WORKBENCH_GIT_REPOSITORY', 'WORKBENCH_GIT_BASE_BRANCH', 'WORKBENCH_GIT_CREDENTIAL_MODE', 'WORKBENCH_GITHUB_APP_ID', 'WORKBENCH_GITHUB_INSTALLATION_ID', 'WORKBENCH_GITHUB_APP_PRIVATE_KEY']);
const fail = message => { throw new Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

export function parseBootstrapConfiguration(text) {
  const parsed = JSON.parse(text);
  if (!plain(parsed)) fail('Runtime configuration must be a JSON object.');
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}:,]|[^\s{}:,]+/g) || [];
  const seen = new Set(); let index = 0;
  if (tokens[index++] !== '{') fail('Invalid configuration JSON.');
  if (tokens[index] !== '}') for (;;) {
    const key = JSON.parse(tokens[index++]);
    if (typeof key !== 'string' || seen.has(key) || tokens[index++] !== ':') fail('Duplicate or invalid configuration field.');
    seen.add(key);
    if (typeof JSON.parse(tokens[index++]) !== 'string') fail('Configuration values must be strings.');
    if (tokens[index] !== ',') break;
    index++;
  }
  if (tokens[index++] !== '}' || index !== tokens.length) fail('Nested configuration values are not supported.');
  return parsed;
}

export function validateBootstrapConfiguration({ configuration, manifest, domain }) {
  if (!plain(configuration) || Object.keys(configuration).some(key => !allowed.has(key))) fail('Configuration contains unsupported or forbidden credentials/settings.');
  for (const [key, value] of Object.entries(configuration)) {
    if (typeof value !== 'string' || value.length > 20000 || /\r|\0/.test(value) || key !== 'WORKBENCH_GITHUB_APP_PRIVATE_KEY' && /\n/.test(value)) fail('Configuration value format is invalid.');
  }
  resolveWorkbenchRuntime(configuration);
  if (manifest?.classification !== 'production_candidate' || manifest.platform?.os !== 'linux' || manifest.platform?.architecture !== 'amd64') fail('A production Linux amd64 release is required.');
  if (typeof domain !== 'string' || domain.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(domain) || /(?:^|\.)(invalid|test|localhost)$/.test(domain)) fail('An approved public TLS domain is required.');
  if (configuration.WORKBENCH_APP_ORIGIN !== `https://${domain}` || configuration.WORKBENCH_AUTH_PROJECT_ID !== manifest.build?.auth?.projectId) fail('Runtime authentication/origin must match the approved build and TLS host.');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(configuration.WORKBENCH_TENANT_ID || '')) fail('An explicit tenant is required.');
  if (!['true', 'false'].includes(configuration.WORKBENCH_AI_ENABLED) || !['true', 'false'].includes(configuration.WORKBENCH_READS_ENABLED)) fail('AI and read switches must be explicit.');
  if (configuration.WORKBENCH_REMOTE_RUNTIME_ENABLED !== 'true' || configuration.WORKBENCH_REMOTE_RUNTIME_DRIVER !== 'docker-host') fail('This host installation requires the isolated Docker renderer.');
  if (configuration.WORKBENCH_AI_ENABLED === 'true' && (!configuration.WORKBENCH_HTML_MODEL || !/^[A-Za-z0-9._-]{1,100}$/.test(configuration.WORKBENCH_HTML_MODEL))) fail('Explicit approved model and dedicated key are required before enabling AI.');
  const git = [...Object.keys(configuration)].filter(key => key.startsWith('WORKBENCH_GIT') || key.startsWith('WORKBENCH_GITHUB'));
  if (git.length && (configuration.WORKBENCH_GIT_CREDENTIAL_MODE !== 'github-app' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(configuration.WORKBENCH_GIT_REPOSITORY || '') || !/^\d+$/.test(configuration.WORKBENCH_GITHUB_APP_ID || '') || !/^\d+$/.test(configuration.WORKBENCH_GITHUB_INSTALLATION_ID || '') || !/^-----BEGIN (?:RSA )?PRIVATE KEY-----\n[\s\S]+\n-----END (?:RSA )?PRIVATE KEY-----\n?$/.test(configuration.WORKBENCH_GITHUB_APP_PRIVATE_KEY || ''))) fail('Git delivery needs a complete dedicated GitHub App configuration.');
  return Object.freeze({ ...configuration });
}

export function renderRuntimeEnvironment(configuration) {
  return '# Generated from approved JSON; do not source this file in a shell.\n' + Object.keys(configuration).sort().map(key => `${key}="${configuration[key].replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`).join('\n') + '\n';
}

export function renderBootstrapNginx(domain) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,63}$/.test(domain || '')) fail('Invalid TLS domain.');
  return `server {\n  listen 443 ssl;\n  server_name ${domain};\n  ssl_certificate ${configRoot}/tls/fullchain.pem;\n  ssl_certificate_key ${configRoot}/tls/key.pem;\n  ssl_protocols TLSv1.2 TLSv1.3;\n  client_max_body_size 1m;\n  server_tokens off;\n  add_header Strict-Transport-Security "max-age=31536000" always;\n  location / {\n    proxy_pass http://127.0.0.1:8791;\n    proxy_http_version 1.1;\n    proxy_set_header Host ${domain};\n    proxy_set_header X-Forwarded-Proto https;\n    proxy_set_header X-Forwarded-For $remote_addr;\n    proxy_connect_timeout 5s;\n    proxy_read_timeout 130s;\n    proxy_send_timeout 130s;\n    proxy_buffering off;\n  }\n}\n`;
}

async function command(file, args, options = {}) {
  return (await exec(file, args, { env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 30000, maxBuffer: 2 * 1024 * 1024, ...options })).stdout.trim();
}
const docker = (...args) => command('docker', ['--host', 'unix:///var/run/docker.sock', ...args], { timeout: 300000 });
async function exists(path) { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function rootFile(path, limit, secret = false) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.uid !== 0 || info.size > limit || (info.mode & 0o022) || secret && (info.mode & 0o077)) fail('Input file ownership, mode, type or size is invalid.');
  const same = other => ['dev', 'ino', 'size', 'mode', 'uid', 'nlink', 'mtimeMs', 'ctimeMs'].every(key => info[key] === other[key]);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!same(await handle.stat())) fail('Input file changed before reading.');
    const buffer = Buffer.alloc(limit + 1); let total = 0;
    while (total <= limit) { const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total); if (!bytesRead) break; total += bytesRead; }
    if (total > limit || !same(await handle.stat()) || !same(await lstat(path))) fail('Input file changed while reading.');
    return buffer.subarray(0, total);
  } finally { await handle.close(); }
}
async function hostGate(options) {
  if (options.dedicated !== true || process.getuid?.() !== 0 || process.platform !== 'linux' || process.arch !== 'x64' || !/^v24\./.test(process.version)) fail('Apply requires root on the approved dedicated Linux amd64 Node 24 host.');
  const os = await readFile('/etc/os-release', 'utf8');
  if (!/^ID=debian$/m.test(os) || !/^VERSION_ID="?12"?$/m.test(os)) fail('Debian 12 is required.');
  const glibc = await command('getconf', ['GNU_LIBC_VERSION']);
  if (!/^glibc \d+\.\d+$/.test(glibc)) fail('glibc is required.');
  await command('dpkg', ['--compare-versions', glibc.slice(6), 'ge', '2.36']);
}
async function noExistingInstallation() {
  if (await exists(current) || await exists(`${configRoot}/release.json`)) fail('Existing installation requires a separate reviewed maintenance plan.');
}
async function inspect(id, manifest) {
  const rows = JSON.parse(await docker('image', 'inspect', id));
  if (rows.length !== 1 || rows[0].Id !== id || rows[0].Os !== 'linux' || rows[0].Architecture !== 'amd64'
    || rows[0].Config?.Labels?.['org.opencontainers.image.revision'] !== manifest.sourceSha
    || rows[0].Config?.Labels?.['io.myscube.workbench.classification'] !== 'production_candidate') fail('Loaded image identity, platform or release labels differ.');
  return rows[0];
}
async function sealTree(path, root = path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    const target = await realpath(path);
    if (target !== root && !target.startsWith(`${root}/`)) fail('Payload symlink escapes the release directory.');
    return;
  }
  if (!info.isDirectory() && !info.isFile()) fail('Payload contains a special filesystem object.');
  if (info.isDirectory()) for (const name of await readdir(path)) await sealTree(join(path, name), root);
  await chown(path, 0, 0);
  await chmod(path, info.isDirectory() ? 0o755 : (info.mode & 0o111 ? 0o755 : 0o644));
}

export async function stageBootstrapRelease(options) {
  const verified = await verifyReleaseBundle({ directory: options.directory, expectedManifestSha256: options.manifestSha256, expectedSourceSha: options.sourceSha, forProduction: true });
  if (verified.manifest.platform.architecture !== 'amd64') fail('This bootstrap accepts amd64 only.');
  if (!options.apply) return { action: 'stage', apply: false, sourceSha: verified.sourceSha, manifestSha256: verified.manifestSha256 };
  await hostGate(options); await noExistingInstallation();
  const final = join(releases, verified.sourceSha);
  if (await exists(final)) fail('Release directory already exists; it will not be overwritten.');
  for (const image of verified.manifest.images) {
    let existing;
    try { existing = JSON.parse(await docker('image', 'inspect', image.tag))[0]; } catch (error) { if (!String(error.stderr || '').includes('No such image')) throw error; }
    if (existing && existing.Id !== image.id) fail('A fixed image tag already points to another image.');
  }
  await mkdir(releases, { recursive: true, mode: 0o755 });
  const staging = await mkdtemp(join(releases, '.bootstrap-'));
  let container;
  try {
    await verifyReleaseBundle({ directory: verified.directory, expectedManifestSha256: verified.manifestSha256, expectedSourceSha: verified.sourceSha, forProduction: true });
    for (const image of verified.manifest.images) { await docker('load', '--input', join(verified.directory, image.archive)); await inspect(image.id, verified.manifest); }
    const app = verified.manifest.images.find(image => image.role === 'app');
    container = `axr-bootstrap-${randomUUID()}`;
    await docker('create', '--pull', 'never', '--network', 'none', '--read-only', '--name', container, app.id);
    await docker('cp', `${container}:/app/.`, staging);
    await docker('rm', container); container = null;
    const metadata = JSON.parse(await readFile(join(staging, 'workbench-build.json'), 'utf8'));
    const expected = verified.manifest;
    if (metadata.schemaVersion !== 1 || metadata.sourceSha !== expected.sourceSha || metadata.classification !== expected.classification
      || JSON.stringify(metadata.auth) !== JSON.stringify(expected.build.auth) || JSON.stringify(metadata.locks) !== JSON.stringify(expected.build.locks)
      || metadata.nodeVersion !== expected.build.nodeVersion || metadata.platform?.architecture !== 'amd64' || metadata.platform?.os !== 'linux') fail('Extracted app metadata differs from the verified manifest.');
    for (const [key, path] of [['root', 'package-lock.json'], ['workbench', 'server/workbench/package-lock.json']]) {
      if (digest(await readFile(join(staging, path))) !== expected.build.locks[key]) fail('Extracted dependency lock differs from the verified build.');
    }
    await sealTree(staging);
    for (const image of expected.images) { await docker('tag', image.id, image.tag); await inspect(image.id, expected); }
    await rename(staging, final);
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    await writeFile(`${configRoot}/release.json`, `${JSON.stringify({ manifest: expected, manifestSha256: verified.manifestSha256 }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await symlink(final, current);
    return { action: 'staged', sourceSha: verified.sourceSha, activated: false };
  } finally {
    if (container) await docker('rm', container).catch(() => {});
    if (await exists(staging)) await rm(staging, { recursive: true, force: true });
  }
}

async function installedRelease(expectedSha) {
  if (!sha.test(expectedSha || '')) fail('An expected release SHA is required.');
  const receipt = JSON.parse(await rootFile(`${configRoot}/release.json`, 65536, true));
  if (receipt.manifest?.sourceSha !== expectedSha || receipt.manifest.classification !== 'production_candidate' || await realpath(current) !== join(releases, expectedSha)) fail('Installed release differs from the expected release.');
  for (const image of receipt.manifest.images) {
    const tagged = JSON.parse(await docker('image', 'inspect', image.tag))[0];
    if (tagged?.Id !== image.id) fail('Installed image pair has changed.');
    await inspect(image.id, receipt.manifest);
  }
  return receipt.manifest;
}

async function checkNginxSites() {
  for (const name of await readdir('/etc/nginx/sites-enabled')) {
    const path = `/etc/nginx/sites-enabled/${name}`;
    if (name !== 'default' || !(await lstat(path)).isSymbolicLink() || await readlink(path) !== '/etc/nginx/sites-available/default') fail('An existing nginx site requires a separate installation review.');
  }
  if ((await readdir('/etc/nginx/conf.d')).some(name => name.endsWith('.conf') && name !== 'myscube-workbench.conf')) fail('An existing nginx configuration requires review.');
}

export async function configureBootstrapHost(options) {
  if (!options.apply) return { action: 'configure', apply: false, activation: 'separate command required' };
  await hostGate(options);
  const manifest = await installedRelease(options.sourceSha);
  await checkNginxSites();
  const configuration = validateBootstrapConfiguration({ configuration: parseBootstrapConfiguration(new TextDecoder('utf-8', { fatal: true }).decode(await rootFile(resolve(options.configuration), 50000, true))), manifest, domain: options.domain });
  if (await exists(`${configRoot}/runtime.env`) || await exists('/etc/nginx/conf.d/myscube-workbench.conf')) fail('Configuration already exists; it will not be overwritten.');
  const certificate = resolve(options.certificate), key = resolve(options.privateKey), chain = resolve(options.chain);
  const [certificateBytes, keyBytes, chainBytes] = await Promise.all([rootFile(certificate, 100000), rootFile(key, 30000, true), rootFile(chain, 100000)]);
  await command('openssl', ['x509', '-in', certificate, '-noout', '-checkend', '604800']);
  await command('openssl', ['verify', '-CApath', '/etc/ssl/certs', '-untrusted', chain, '-verify_hostname', options.domain, certificate]);
  const certPublic = await command('openssl', ['x509', '-in', certificate, '-pubkey', '-noout']);
  const keyPublic = await command('openssl', ['pkey', '-in', key, '-pubout']);
  if (certPublic !== keyPublic) fail('TLS certificate and private key do not match.');
  const issuer = await command('openssl', ['x509', '-in', certificate, '-noout', '-issuer', '-nameopt', 'RFC2253']);
  const subject = await command('openssl', ['x509', '-in', certificate, '-noout', '-subject', '-nameopt', 'RFC2253']);
  if (issuer.slice(7) === subject.slice(8)) fail('Self-signed leaf certificates are not accepted for production.');
  await mkdir(`${configRoot}/tls`, { recursive: true, mode: 0o700 });
  await writeFile(`${configRoot}/tls/fullchain.pem`, Buffer.concat([certificateBytes, Buffer.from('\n'), chainBytes]), { flag: 'wx', mode: 0o644 });
  await writeFile(`${configRoot}/tls/key.pem`, keyBytes, { flag: 'wx', mode: 0o600 });
  await writeFile(`${configRoot}/runtime.env`, renderRuntimeEnvironment(configuration), { flag: 'wx', mode: 0o600 });
  for (const [name, source] of [
    ['myscube-axr-workbench.service', 'host-runtime/systemd/myscube-axr-workbench.service'],
    ['myscube-axr-renderer-reaper.service', 'remote-runtime/systemd/myscube-axr-renderer-reaper.service'],
    ['myscube-axr-renderer-reaper.timer', 'remote-runtime/systemd/myscube-axr-renderer-reaper.timer'],
  ]) await writeFile(`/etc/systemd/system/${name}`, await readFile(join(current, 'server/workbench', source)), { flag: 'wx', mode: 0o644 });
  await writeFile('/etc/nginx/conf.d/myscube-workbench.conf', renderBootstrapNginx(options.domain), { flag: 'wx', mode: 0o644 });
  if (await exists('/etc/nginx/sites-enabled/default')) await rename('/etc/nginx/sites-enabled/default', `${configRoot}/nginx-default-site.link`);
  await command('systemd-analyze', ['verify', '/etc/systemd/system/myscube-axr-workbench.service', '/etc/systemd/system/myscube-axr-renderer-reaper.service', '/etc/systemd/system/myscube-axr-renderer-reaper.timer']);
  await command('nginx', ['-t']);
  await writeFile(`${configRoot}/activation.json`, JSON.stringify({ sourceSha: options.sourceSha, domain: options.domain, configurationSha256: digest(renderRuntimeEnvironment(configuration)) }), { flag: 'wx', mode: 0o600 });
  return { action: 'configured', sourceSha: options.sourceSha, activated: false };
}

export async function activateBootstrapHost(options) {
  if (!options.apply) return { action: 'activate', apply: false, checks: ['release and configuration', 'reaper', 'loopback health', 'unauthenticated 401', 'TLS'] };
  await hostGate(options); await installedRelease(options.sourceSha);
  await checkNginxSites();
  const activation = JSON.parse(await rootFile(`${configRoot}/activation.json`, 4096, true));
  if (activation.sourceSha !== options.sourceSha || digest(await rootFile(`${configRoot}/runtime.env`, 50000, true)) !== activation.configurationSha256) fail('Activation configuration changed since validation.');
  await command('nginx', ['-t']);
  if (await command('systemctl', ['is-active', 'nginx']).catch(() => '') === 'active') fail('An active nginx service requires a separate maintenance plan.');
  await command('systemctl', ['daemon-reload']);
  await command('systemctl', ['enable', '--now', 'myscube-axr-renderer-reaper.timer']);
  await command('systemctl', ['is-active', 'myscube-axr-renderer-reaper.timer']);
  await command('/usr/bin/node', ['--input-type=module', '-e', "const {assertRendererHostReady}=await import('/opt/myscube-workbench/server/workbench/remote-runtime/reaper.mjs');await assertRendererHostReady();"]);
  let started = false, proxyStarted = false;
  try {
    if (await command('systemctl', ['is-active', 'myscube-axr-workbench.service']).catch(() => '') === 'active') fail('The application is already active; this is an initial activation command.');
    await command('systemctl', ['start', 'myscube-axr-workbench.service']); started = true;
    const health = JSON.parse(await command('curl', ['--fail', '--silent', '--show-error', '--retry', '10', '--retry-connrefused', '--retry-delay', '1', '--retry-max-time', '40', '--max-time', '3', 'http://127.0.0.1:8791/health'], { timeout: 45000 }));
    if (health.ok !== true || health.service !== 'myscube-workbench') fail('Unexpected loopback health response.');
    const status = await command('curl', ['--silent', '--output', '/dev/null', '--write-out', '%{http_code}', '--max-time', '5', 'http://127.0.0.1:8791/api/v1/html-work-pages']);
    if (status !== '401') fail('Unauthenticated API must return 401.');
    await command('systemctl', ['start', 'nginx']); proxyStarted = true;
    await command('curl', ['--fail', '--silent', '--show-error', '--resolve', `${activation.domain}:443:127.0.0.1`, '--max-time', '10', `https://${activation.domain}/health`]);
    await command('systemctl', ['enable', 'myscube-axr-workbench.service', 'nginx']);
    return { action: 'activated', sourceSha: options.sourceSha, liveAcceptanceStillRequired: ['authorized and revoked account', 'copy freshness', 'real model', 'renderer interaction and resource/crash tests', 'external DNS/TLS'] };
  } catch (error) {
    if (proxyStarted) await command('systemctl', ['stop', 'nginx']).catch(() => {});
    if (started) await command('systemctl', ['stop', 'myscube-axr-workbench.service']).catch(() => {});
    throw error;
  }
}

async function main(args) {
  const [action, ...values] = args;
  if (!['stage', 'configure', 'activate'].includes(action)) fail('Use stage, configure or activate; --apply --dedicated-host is required for changes.');
  const names = { '--directory': 'directory', '--manifest-sha256': 'manifestSha256', '--source-sha': 'sourceSha', '--configuration': 'configuration', '--domain': 'domain', '--certificate': 'certificate', '--private-key': 'privateKey', '--chain': 'chain' };
  const options = {};
  for (let i = 0; i < values.length; i++) {
    const key = values[i], field = key === '--apply' ? 'apply' : key === '--dedicated-host' ? 'dedicated' : names[key];
    if (!field || Object.hasOwn(options, field)) fail('Unsupported or duplicated option.');
    if (['apply', 'dedicated'].includes(field)) options[field] = true;
    else { if (!values[i + 1] || values[i + 1].startsWith('--')) fail('Missing option value.'); options[field] = values[++i]; }
  }
  const result = await ({ stage: stageBootstrapRelease, configure: configureBootstrapHost, activate: activateBootstrapHost })[action](options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(() => { process.stderr.write('Workbench host bootstrap failed. No credential values are logged. Keep external traffic closed and review the failed phase before retrying.\n'); process.exitCode = 1; });
