import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

const scope = '(http.host eq "myscube.myscguard.app" and http.request.method eq "POST" and http.request.uri.path in {"/api/slack/events" "/api/slack/interactions"})';
const baseline = '5966f97c2a4a454711192fa4fa3076ddfef26ccd56d37c4628f1aac4cdeff759';
const { CLOUDFLARE_API_KEY: key, CLOUDFLARE_EMAIL: email, CLOUDFLARE_ZONE_ID: zone } = process.env;
if (!key || !email || !/^[a-f0-9]{32}$/.test(zone || '')) throw new Error('Cloudflare credentials unavailable');
if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only reviewed main may change edge policy');
async function api(path, body) {
  const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/rulesets/${path}`, {
    method: body ? 'PATCH' : 'GET', headers: { 'X-Auth-Key': key, 'X-Auth-Email': email, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) throw new Error(`Cloudflare request failed: ${response.status}`);
  return result.result;
}
const ruleset = await api('phases/http_request_firewall_custom/entrypoint');
const rule = ruleset.rules.find((item) => item.ref === 'mysc_explicit_automation_client_block');
if (ruleset.id !== 'cd3d15e4086648069f6bc73060cb8a62' || rule?.id !== 'a4602e5dfc844cca8bf77c6627d50332' || rule.action !== 'block' || rule.enabled !== true) throw new Error('Unexpected live rule');
const suffix = ` and not ${scope}`;
const original = rule.expression.endsWith(suffix) ? rule.expression.slice(0, -suffix.length) : rule.expression;
if (createHash('sha256').update(original).digest('hex') !== baseline) throw new Error('Rule changed since review; inspect again');
writeFileSync('slack-edge-before.json', JSON.stringify(ruleset, null, 2), { flag: 'wx', mode: 0o600 });
if (!rule.expression.endsWith(suffix)) {
  const { action, description, ref, enabled, logging } = rule;
  await api(`${ruleset.id}/rules/${rule.id}`, { action, description, ref, enabled, ...(logging ? { logging } : {}), expression: original + suffix });
}
const after = await api('phases/http_request_firewall_custom/entrypoint');
const updated = after.rules.find((item) => item.id === rule.id);
if (updated?.expression !== original + suffix || updated.action !== rule.action || updated.enabled !== rule.enabled || updated.ref !== rule.ref) throw new Error('Edge policy readback mismatch');
const stable = (items) => items.map(({ version, last_updated, ...item }) => item);
if (JSON.stringify(stable(after.rules.filter((item) => item.id !== rule.id))) !== JSON.stringify(stable(ruleset.rules.filter((item) => item.id !== rule.id)))) throw new Error('Other rules changed concurrently; review backup');
console.log(JSON.stringify({ ruleId: rule.id, scope, otherRulesUnchanged: true, backup: 'slack-edge-before.json' }));
