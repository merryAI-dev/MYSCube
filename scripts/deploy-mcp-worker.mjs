import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

// MYSCube MCP Worker(mcp.myscguard.app) 배포. main 의 GitHub Actions 에서만 실행한다.
// KV 는 이름으로 찾고 없으면 만든다. 비밀값은 이 러너와 Cloudflare 밖으로 나가지 않는다.
const KV_TITLE = 'myscube-mcp-oauth';
const ORIGIN = 'https://mcp.myscguard.app';
const env = process.env;
if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main GitHub Actions may deploy');
for (const key of ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ZONE_ID', 'MCP_GOOGLE_CLIENT_ID', 'MCP_GOOGLE_CLIENT_SECRET', 'MCP_FIREBASE_WEB_API_KEY', 'MCP_CONSENT_SECRET']) {
  if (!env[key]) throw new Error(`${key} is not configured`);
}
if (env.MCP_CONSENT_SECRET.length < 32) throw new Error('MCP_CONSENT_SECRET must be at least 32 characters');

async function cf(path, method = 'GET', body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    method, headers: { 'X-Auth-Key': env.CLOUDFLARE_API_KEY, 'X-Auth-Email': env.CLOUDFLARE_EMAIL, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare ${method} ${path.split('?')[0]} failed: ${response.status}`);
  return result.result;
}

const zone = await cf(`/zones/${env.CLOUDFLARE_ZONE_ID}`);
if (zone.name !== 'myscguard.app') throw new Error('Unexpected zone');
const accountId = zone.account.id;
const namespaces = await cf(`/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
const kv = namespaces.find((item) => item.title === KV_TITLE) || await cf(`/accounts/${accountId}/storage/kv/namespaces`, 'POST', { title: KV_TITLE });

const workerDir = new URL('../mcp-worker/', import.meta.url);
const config = JSON.parse(readFileSync(new URL('wrangler.jsonc', workerDir), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
config.kv_namespaces = [{ binding: 'OAUTH_KV', id: kv.id }];
const generated = new URL('wrangler.generated.jsonc', workerDir);
writeFileSync(generated, JSON.stringify(config, null, 2));
const secretsFile = new URL('.deploy-secrets.json', workerDir);
const wranglerEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' };
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args, '--config', generated.pathname], { cwd: workerDir, env: wranglerEnv, stdio: 'inherit' });
try {
  wrangler('deploy');
  writeFileSync(secretsFile, JSON.stringify({ GOOGLE_CLIENT_ID: env.MCP_GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET: env.MCP_GOOGLE_CLIENT_SECRET,
    FIREBASE_WEB_API_KEY: env.MCP_FIREBASE_WEB_API_KEY, CONSENT_SECRET: env.MCP_CONSENT_SECRET }), { mode: 0o600 });
  wrangler('secret', 'bulk', secretsFile.pathname);
} finally {
  rmSync(secretsFile, { force: true });
}

// 사용자 도메인 인증서와 DNS 가 붙는 동안 최대 3분 기다리며 MCP 표준 응답을 확인한다.
async function smoke() {
  const resource = await fetch(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`, { headers: { 'user-agent': 'python-httpx/0.27.0' } });
  const metadata = resource.ok ? await resource.json() : null;
  const challenge = await fetch(`${ORIGIN}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'mcp-client/1.0' }, body: '{}' });
  return metadata?.resource === `${ORIGIN}/mcp` && challenge.status === 401
    && (challenge.headers.get('www-authenticate') || '').includes('resource_metadata=');
}
for (let attempt = 1; ; attempt++) {
  try { if (await smoke()) break; } catch { /* certificate or DNS still provisioning */ }
  if (attempt === 18) throw new Error('MCP discovery smoke test failed');
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
console.log(JSON.stringify({ origin: ORIGIN, kvNamespace: KV_TITLE, release: env.GITHUB_SHA, discovery: 'ok' }));
if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `MYSCube MCP deployed: ${ORIGIN}/mcp\n\nRelease: ${env.GITHUB_SHA}\n\nProtected resource metadata and the 401 challenge were verified.\n`, { flag: 'a' });
