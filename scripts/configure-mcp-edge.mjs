import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

// MCP 클라이언트(Claude, ChatGPT, Python·Node SDK)는 User-Agent에 httpx·mcp-client 등을 쓰므로
// 자동화 클라이언트 차단 규칙에서 MCP 호스트와 MCP 표준 경로만 뺀다. 브라우저로 여는 /api/v1/mcp/oauth/authorize 는 넣지 않는다.
// infra/cloudflare/main.tf 의 mysc_explicit_automation_client_block 과 같은 식이어야 한다.
export const MCP_PATHS = Object.freeze([
  '/mcp',
  '/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource',
  '/.well-known/oauth-protected-resource/mcp',
  '/api/v1/mcp/oauth/register',
  '/api/v1/mcp/oauth/token',
]);
const LEGACY_BFF_SCOPE = `(http.host eq "myscube.myscguard.app" and http.request.uri.path in {${MCP_PATHS.map((path) => `"${path}"`).join(' ')}})`;
// mcp.myscguard.app 은 MCP 전용 Worker 라 호스트 전체를 뺀다. BFF 의 /mcp 경로 예외는 옮기는 동안 유지한다.
export const MCP_SCOPE = `(http.host eq "mcp.myscguard.app" or ${LEGACY_BFF_SCOPE})`;
const SLACK_SUFFIX = ' and not (http.host eq "myscube.myscguard.app" and http.request.method eq "POST" and http.request.uri.path in {"/api/slack/events" "/api/slack/interactions"})';
const MCP_SUFFIX = ` and not ${MCP_SCOPE}`;
const PREVIOUS_SUFFIXES = [` and not ${LEGACY_BFF_SCOPE}`];
// configure-slack-edge.mjs 가 검토한 원래 규칙 식의 해시. 규칙이 그사이 바뀌었으면 적용하지 않는다.
const BASELINE = '5966f97c2a4a454711192fa4fa3076ddfef26ccd56d37c4628f1aac4cdeff759';

export function withMcpException(expression) {
  const known = [MCP_SUFFIX, ...PREVIOUS_SUFFIXES].find((suffix) => expression.endsWith(suffix));
  const current = known ? expression.slice(0, -known.length) : expression;
  if (!current.endsWith(SLACK_SUFFIX)) throw new Error('Slack exception missing; apply configure-slack-edge.mjs first');
  if (createHash('sha256').update(current.slice(0, -SLACK_SUFFIX.length)).digest('hex') !== BASELINE) throw new Error('Rule changed since review; inspect again');
  return current + MCP_SUFFIX;
}

async function main() {
  const { CLOUDFLARE_API_KEY: key, CLOUDFLARE_EMAIL: email, CLOUDFLARE_ZONE_ID: zone } = process.env;
  if (!key || !email || !/^[a-f0-9]{32}$/.test(zone || '')) throw new Error('Cloudflare credentials unavailable');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only reviewed main may change edge policy');
  const api = async (path, body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/rulesets/${path}`, {
      method: body ? 'PATCH' : 'GET', headers: { 'X-Auth-Key': key, 'X-Auth-Email': email, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(`Cloudflare request failed: ${response.status}`);
    return result.result;
  };
  const ruleset = await api('phases/http_request_firewall_custom/entrypoint');
  const rule = ruleset.rules.find((item) => item.ref === 'mysc_explicit_automation_client_block');
  if (ruleset.id !== 'cd3d15e4086648069f6bc73060cb8a62' || rule?.id !== 'a4602e5dfc844cca8bf77c6627d50332' || rule.action !== 'block' || rule.enabled !== true) throw new Error('Unexpected live rule');
  const expression = withMcpException(rule.expression);
  writeFileSync('mcp-edge-before.json', JSON.stringify(ruleset, null, 2), { flag: 'wx', mode: 0o600 });
  if (rule.expression !== expression) {
    const { action, description, ref, enabled, logging } = rule;
    await api(`${ruleset.id}/rules/${rule.id}`, { action, description, ref, enabled, ...(logging ? { logging } : {}), expression });
  }
  const after = await api('phases/http_request_firewall_custom/entrypoint');
  const updated = after.rules.find((item) => item.id === rule.id);
  if (updated?.expression !== expression || updated.action !== rule.action || updated.enabled !== rule.enabled || updated.ref !== rule.ref) throw new Error('Edge policy readback mismatch');
  const stable = (items) => items.filter((item) => item.id !== rule.id).map(({ version, last_updated, ...item }) => item);
  if (JSON.stringify(stable(after.rules)) !== JSON.stringify(stable(ruleset.rules))) throw new Error('Other rules changed concurrently; review backup');
  console.log(JSON.stringify({ ruleId: rule.id, scope: MCP_SCOPE, changed: rule.expression !== expression, otherRulesUnchanged: true, backup: 'mcp-edge-before.json' }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
