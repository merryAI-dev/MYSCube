import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';

// MCP Worker 배포(MYSCube: mcp.myscguard.app, EMA Station: ema-mcp.myscguard.app). main 의 GitHub Actions 에서만 실행한다.
// KV 는 이름으로 찾고 없으면 만든다. 비밀값은 이 러너와 Cloudflare 밖으로 나가지 않는다.
// 사용법: node scripts/deploy-mcp-worker.mjs [myscube|ema]
const TARGETS = {
  myscube: {
    kvTitle: 'myscube-mcp-oauth',
    origin: 'https://mcp.myscguard.app',
    config: 'wrangler.jsonc',
    generated: 'wrangler.generated.jsonc',
    // Worker 비밀 이름 → 러너 환경변수
    secrets: {
      GOOGLE_CLIENT_ID: 'MCP_GOOGLE_CLIENT_ID',
      GOOGLE_CLIENT_SECRET: 'MCP_GOOGLE_CLIENT_SECRET',
      FIREBASE_WEB_API_KEY: 'MCP_FIREBASE_WEB_API_KEY',
      CONSENT_SECRET: 'MCP_CONSENT_SECRET',
    },
  },
  ema: {
    kvTitle: 'myscube-ema-mcp-oauth',
    origin: 'https://ema-mcp.myscguard.app',
    config: 'wrangler.ema.jsonc',
    generated: 'wrangler.ema.generated.jsonc',
    secrets: {
      FIREBASE_WEB_API_KEY: 'EMA_MCP_FIREBASE_WEB_API_KEY',
      CONSENT_SECRET: 'EMA_MCP_CONSENT_SECRET',
    },
    // 있으면 넣고 없으면 건너뛴다(회의록 드라이브 저장용 Apps Script).
    optionalSecrets: {
      NOTES_SAVE_URL: 'EMA_MCP_NOTES_SAVE_URL',
    },
  },
  // Tiro 회의록 자동 저장(크론·웹훅). MCP 가 아니라서 OAuth 확인 대신 /healthz 로 확인한다.
  tiro: {
    kvTitle: 'myscube-tiro-autosave-state',
    kvBinding: 'STATE_KV',
    origin: 'https://tiro-autosave.myscguard.app',
    config: 'wrangler.tiro.jsonc',
    generated: 'wrangler.tiro.generated.jsonc',
    health: true,
    // 비밀값을 아직 안 넣었으면 실패하지 않고 건너뛴다(다른 대상 배포를 막지 않게).
    skipIfUnconfigured: true,
    secrets: {
      TIRO_API_KEY: 'TIRO_AUTOSAVE_TIRO_API_KEY',
      ANTHROPIC_API_KEY: 'TIRO_AUTOSAVE_ANTHROPIC_API_KEY',
      NOTES_SAVE_URL: 'EMA_MCP_NOTES_SAVE_URL',
    },
    optionalSecrets: {
      TIRO_WEBHOOK_SECRET: 'TIRO_AUTOSAVE_WEBHOOK_SECRET',
    },
  },
};
const targetName = process.argv[2] || 'myscube';
const target = TARGETS[targetName];
if (!target) throw new Error(`Unknown target: ${targetName}`);
const KV_TITLE = target.kvTitle;
const ORIGIN = target.origin;
const env = process.env;
if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only main GitHub Actions may deploy');
if (target.skipIfUnconfigured && Object.values(target.secrets).some((key) => !env[key])) {
  console.log(`::notice::${targetName} 비밀값이 없어 배포를 건너뜁니다: ${Object.values(target.secrets).filter((key) => !env[key]).join(', ')}`);
  process.exit(0);
}
for (const key of ['CLOUDFLARE_API_KEY', 'CLOUDFLARE_EMAIL', 'CLOUDFLARE_ZONE_ID', ...Object.values(target.secrets)]) {
  if (!env[key]) throw new Error(`${key} is not configured`);
}
if (target.secrets.CONSENT_SECRET && env[target.secrets.CONSENT_SECRET].length < 32) throw new Error(`${target.secrets.CONSENT_SECRET} must be at least 32 characters`);

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
const config = JSON.parse(readFileSync(new URL(target.config, workerDir), 'utf8').replace(/^\s*\/\/.*$/gm, ''));
config.kv_namespaces = [{ binding: target.kvBinding ?? 'OAUTH_KV', id: kv.id }];
if (targetName === 'myscube' && env.MCP_DOCUMENTS_ORIGIN) {
  const origin = new URL(env.MCP_DOCUMENTS_ORIGIN);
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Invalid document service origin');
  const response = await fetch(`${origin.origin}/healthz`, { redirect: 'error', signal: AbortSignal.timeout(30_000) });
  const health = response.ok ? await response.json() : null;
  if (health?.service !== 'myscube-mcp-documents' || health.renderer !== 'ready' || !/^[a-f0-9]{40}$/u.test(health.release || '')) throw new Error('Document service must be ready before routing changes');
  config.vars.ATTACHMENT_BASE_URL = origin.origin;
}
const generated = new URL(target.generated, workerDir);
writeFileSync(generated, JSON.stringify(config, null, 2));
const secretsFile = new URL('.deploy-secrets.json', workerDir);
const wranglerEnv = { ...env, CLOUDFLARE_ACCOUNT_ID: accountId, WRANGLER_SEND_METRICS: 'false' };
const wrangler = (...args) => execFileSync('npx', ['wrangler', ...args, '--config', generated.pathname], { cwd: workerDir, env: wranglerEnv, stdio: 'inherit' });
try {
  wrangler('deploy');
  writeFileSync(secretsFile, JSON.stringify(Object.fromEntries([...Object.entries(target.secrets), ...Object.entries(target.optionalSecrets ?? {}).filter(([, variable]) => env[variable])].map(([name, variable]) => [name, env[variable]]))), { mode: 0o600 });
  wrangler('secret', 'bulk', secretsFile.pathname);
} finally {
  rmSync(secretsFile, { force: true });
}

// 사용자 도메인 인증서와 DNS 가 붙는 동안 최대 3분 기다리며 MCP 표준 응답을 확인한다.
// Cloudflare 가 러너(데이터센터 IP)의 Node fetch 지문을 막는 일이 있어, 엣지 점검 워크플로와 같은 curl 로 확인한다.
function curl(args) {
  const out = execFileSync('curl', ['-s', '-m', '15', ...args], { encoding: 'utf8' });
  return out;
}
function challengeOf(userAgent) {
  const head = curl(['-i', '-A', userAgent, '-X', 'POST', '-H', 'content-type: application/json', '-d', '{}', `${ORIGIN}/mcp`]);
  return { status: /^HTTP\/[\d.]+ (\d{3})/u.exec(head)?.[1], challenge: /www-authenticate:.*resource_metadata=/iu.test(head) };
}
// 통과 조건은 공개 주소의 보호 리소스 메타데이터(Worker 가 서비스 중이라는 증거)다. 인증 없는 /mcp 호출의 401 은
// 가능하면 함께 확인하지만, GitHub 러너 IP 에서는 엣지가 403 을 주는 일이 있어(Mac·AI 서비스에서는 401) 그때는 경고만 남긴다.
function smoke() {
  const body = curl(['-A', 'python-httpx/0.27.0', '-w', '\n%{http_code}', `${ORIGIN}/.well-known/oauth-protected-resource/mcp`]);
  const lines = body.trimEnd().split('\n');
  const code = lines.pop();
  let resource = '';
  try { resource = JSON.parse(lines.join('\n')).resource; } catch { /* 아직 준비 중 */ }
  const metadataOk = code === '200' && resource === `${ORIGIN}/mcp`;
  const seen = ['mcp-client/1.0', 'Mozilla/5.0'].map((agent) => ({ agent, ...challengeOf(agent) }));
  const challenged = seen.some((entry) => entry.status === '401' && entry.challenge);
  const detail = `metadata ${code} resource=${resource || '-'} / mcp ${seen.map((entry) => `${entry.agent}=${entry.status || '-'}`).join(' ')} challenge=${challenged}`;
  return { ok: metadataOk, warn: metadataOk && !challenged, detail };
}
// MCP 가 아닌 대상은 /healthz 가 서비스 이름과 비밀값 설정을 돌려주는지만 본다.
// 이 호스트는 자동화 클라이언트 차단 예외(configure-mcp-edge.mjs)가 아니라서 브라우저 UA 로 확인한다.
function healthSmoke() {
  const lines = curl(['-A', 'Mozilla/5.0', '-w', '\n%{http_code}', `${ORIGIN}/healthz`]).trimEnd().split('\n');
  const code = lines.pop();
  let health = null;
  try { health = JSON.parse(lines.join('\n')); } catch { /* 아직 준비 중 */ }
  const configured = health?.configured ?? {};
  return { ok: code === '200' && health?.service === `myscube-${targetName}-autosave` && configured.tiro && configured.claude && configured.drive,
    warn: false, detail: `healthz ${code} configured=${JSON.stringify(configured)}` };
}
let last = { ok: false, detail: 'not run' };
for (let attempt = 1; attempt <= 18; attempt++) {
  try { last = target.health ? healthSmoke() : smoke(); } catch (error) { last = { ok: false, detail: `curl failed: ${error.message.split('\n')[0]}` }; }
  console.log(`discovery check ${attempt}: ${last.detail}`);
  if (last.ok) {
    if (last.warn) console.log('::warning::인증 없는 /mcp 요청이 401 이 아닙니다. 러너 IP 에 대한 엣지 응답일 수 있으니 공개 주소에서 직접 확인하세요.');
    break;
  }
  if (attempt === 18) throw new Error(`MCP discovery smoke test failed (${last.detail})`);
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}
console.log(JSON.stringify({ origin: ORIGIN, kvNamespace: KV_TITLE, release: env.GITHUB_SHA, discovery: 'ok' }));
if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, `MYSCube MCP deployed: ${ORIGIN}/mcp\n\nRelease: ${env.GITHUB_SHA}\n\nProtected resource metadata and the 401 challenge were verified.\n`, { flag: 'a' });
