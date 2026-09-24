import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseBootstrapConfiguration, validateBootstrapConfiguration, renderRuntimeEnvironment, renderBootstrapNginx, configureBootstrapHost, activateBootstrapHost } from './bootstrap-install.mjs';

const exec = promisify(execFile);
const script = resolve('server/workbench/host-runtime/bootstrap-host.sh');
const manifest = { classification: 'production_candidate', platform: { os: 'linux', architecture: 'amd64' }, build: { auth: { projectId: 'approved-identity' } } };
const configuration = () => ({ WORKBENCH_PROJECT_ID: 'approved-isolated-data', PRODUCTION_PROJECT_ID: 'approved-business-data', WORKBENCH_MODEL_PROJECT_ID: 'approved-isolated-model', PRODUCTION_MODEL_PROJECT_ID: 'approved-business-model', WORKBENCH_AUTH_PROJECT_ID: 'approved-identity', WORKBENCH_TENANT_ID: 'approved-tenant', WORKBENCH_APP_ORIGIN: 'https://workbench.example.org', WORKBENCH_AI_ENABLED: 'false', WORKBENCH_READS_ENABLED: 'true', WORKBENCH_REMOTE_RUNTIME_ENABLED: 'true', WORKBENCH_REMOTE_RUNTIME_DRIVER: 'docker-host' });
const validate = (value: any, override: any = {}) => validateBootstrapConfiguration({ configuration: value, manifest, domain: 'workbench.example.org', ...override });

describe('dedicated host bootstrap contracts (not real Linux acceptance)', () => {
  it('validates a production configuration without invoking model, cloud or Docker', () => {
    expect(validate(configuration())).toEqual(configuration());
    expect(Object.isFrozen(validate(configuration()))).toBe(true);
  });
  it('rejects duplicate JSON fields and nonstring/nested values before environment-file rendering', () => {
    expect(parseBootstrapConfiguration(JSON.stringify(configuration()))).toEqual(configuration());
    expect(parseBootstrapConfiguration('{"key":"quoted \\"value\\" with : and , punctuation"}')).toEqual({ key: 'quoted "value" with : and , punctuation' });
    for (const input of ['{"key":"one","key":"two"}', '{"key":true}', '{"key":{"nested":"value"}}', '{"key":["value"]}', '[]']) expect(() => parseBootstrapConfiguration(input)).toThrow();
  });
  it.each(['GOOGLE_APPLICATION_CREDENTIALS', 'SETTLEMENT_AGENT_GEMINI_API_KEY', 'JVM_WEEKLY_API_BASE_URL', 'WORKBENCH_COPY_ENABLED', 'WORKBENCH_COPY_SOURCE_PROJECT_ID', 'WORKBENCH_IMPORT_ENABLED', 'WORKBENCH_HTTP_LOG_IMPORT_ENABLED', 'WORKBENCH_GITHUB_TOKEN', 'WORKBENCH_EXTERNAL_ENDPOINTS', 'WORKBENCH_BIND_HOST', 'PORT'])('refuses broker credential/configuration injection: %s', key => {
    expect(() => validate({ ...configuration(), [key]: 'forbidden' })).toThrow(/unsupported|forbidden/);
  });
  it('refuses missing production authentication, origin mismatch and shared production projects', () => {
    for (const patch of [{ WORKBENCH_AUTH_PROJECT_ID: '' }, { WORKBENCH_AUTH_PROJECT_ID: 'other-identity' }, { WORKBENCH_APP_ORIGIN: 'http://workbench.example.org' }, { WORKBENCH_PROJECT_ID: 'approved-business-data' }, { WORKBENCH_MODEL_PROJECT_ID: 'approved-business-model' }, { WORKBENCH_TENANT_ID: '' }, { WORKBENCH_REMOTE_RUNTIME_ENABLED: 'false' }]) expect(() => validate({ ...configuration(), ...patch })).toThrow();
    expect(() => validate(configuration(), { manifest: { ...manifest, classification: 'synthetic' } })).toThrow();
    expect(() => validate(configuration(), { manifest: { ...manifest, platform: { os: 'linux', architecture: 'arm64' } } })).toThrow();
  });
  it('requires a dedicated model key and explicit model before AI activation', () => {
    expect(() => validate({ ...configuration(), WORKBENCH_AI_ENABLED: 'true' })).toThrow();
    expect(() => validate({ ...configuration(), WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'test-key' })).toThrow();
    expect(validate({ ...configuration(), WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'test-key', WORKBENCH_HTML_MODEL: 'approved-model' }).WORKBENCH_AI_ENABLED).toBe('true');
  });
  it('requires all GitHub App fields together; renders private-key newlines as data, not shell code', () => {
    expect(() => validate({ ...configuration(), WORKBENCH_GIT_REPOSITORY: 'approved/private-pages' })).toThrow();
    const value = validate({ ...configuration(), WORKBENCH_GIT_REPOSITORY: 'approved/private-pages', WORKBENCH_GIT_CREDENTIAL_MODE: 'github-app', WORKBENCH_GITHUB_APP_ID: '123', WORKBENCH_GITHUB_INSTALLATION_ID: '456', WORKBENCH_GITHUB_APP_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\nfixture-data\n-----END PRIVATE KEY-----\n' });
    const output = renderRuntimeEnvironment(value);
    expect(output).toContain('WORKBENCH_GITHUB_APP_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nfixture-data\n-----END PRIVATE KEY-----\n"');
    expect(output).toContain('do not source');
  });
  it('refuses duplicate-line/control-character injection and TLS configuration injection', () => {
    expect(() => validate({ ...configuration(), WORKBENCH_GEMINI_API_KEY: 'key\nGOOGLE_APPLICATION_CREDENTIALS=/file' })).toThrow();
    expect(() => validate({ ...configuration(), WORKBENCH_TENANT_ID: 'bad\0value' })).toThrow();
    for (const domain of ['workbench.example.org; return 200;', 'https://workbench.example.org', 'localhost', 'workbench.invalid']) expect(() => validate(configuration(), { domain })).toThrow();
    expect(() => renderBootstrapNginx('host.example.org\ninclude evil;')).toThrow();
  });
  it('nginx only proxies TLS to the loopback app with bounded request size and upstream timeouts', () => {
    const output = renderBootstrapNginx('workbench.example.org');
    expect(output).toContain('listen 443 ssl;');
    expect(output).not.toContain('listen 80');
    expect(output).toContain('proxy_pass http://127.0.0.1:8791;');
    expect(output).toContain('client_max_body_size 1m;');
    expect(output).toContain('proxy_read_timeout 130s;');
    expect(output).not.toContain('Access-Control-Allow-Origin');
    expect(output).not.toContain('proxy_hide_header');
  });
  it('configure and activate default to print-only planning without reading host credentials', async () => {
    expect(await configureBootstrapHost({})).toMatchObject({ apply: false, action: 'configure' });
    expect(await activateBootstrapHost({})).toMatchObject({ apply: false, action: 'activate' });
  });
  it('shell syntax is valid and no-apply does not start package or privilege operations', async () => {
    await exec('bash', ['-n', script]);
    const result = await exec('bash', [script, '--node-version', '24.21.0', '--node-sha256', 'a'.repeat(64)]);
    expect(result.stdout).toContain('Plan: Debian 12 amd64');
    expect(result.stdout).not.toContain('Prerequisites installed');
    await expect(exec('bash', [script, '--node-version', '24.21.0'])).rejects.toMatchObject({ code: 1 });
    await expect(exec('bash', [script, '--node-version', '24.21.0; touch /tmp/forbidden', '--node-sha256', 'a'.repeat(64)])).rejects.toMatchObject({ code: 1 });
  });
  it('installer has no shell execution or broad Docker cleanup and checks readiness with the real exported guard', async () => {
    const source = await readFile(resolve('server/workbench/host-runtime/bootstrap-install.mjs'), 'utf8');
    expect(source).not.toMatch(/(?:execSync|spawnSync|shell:\s*true|\beval\()/);
    expect(source).not.toContain('prune');
    expect(source).not.toContain("'--check'");
    expect(source).toContain('assertRendererHostReady();');
    expect(source).toContain("docker('create', '--pull', 'never', '--network', 'none', '--read-only'");
    expect(source).toContain("if (status !== '401')");
    expect(source.match(/command\('\/usr\/sbin\/nginx', \['-t'\]\)/g)).toHaveLength(2);
    expect(source).not.toContain("command('nginx'");
    expect(source.indexOf("['start', 'nginx']")).toBeGreaterThan(source.indexOf("if (status !== '401')"));
  });
});
