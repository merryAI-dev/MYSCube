import { writeFileSync } from 'node:fs';

// Must render the same expression as local.axr_workbench_* in infra/cloudflare/main.tf.
export function axrWorkbenchScopeExpression(egressIps) {
  if (!Array.isArray(egressIps) || egressIps.length < 1 || egressIps.some((ip) => !/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || ip.split('.').some((part) => Number(part) > 255))) throw new Error('AXR_WORKBENCH_EGRESS_IPS must list single IPv4 addresses');
  const allowed = `(ip.src in {${egressIps.join(' ')}} and http.host eq "myscube.myscguard.app" and http.request.method eq "GET" and http.request.uri.path in {"/api/v1/projects" "/api/v1/cashflow-evidence"})`;
  return `((lower(http.user_agent) contains "myscube-axr-workbench") and not ${allowed})`;
}

export const AXR_WORKBENCH_RULE = { action: 'block', ref: 'mysc_axr_workbench_identity_scope', description: 'Allow the AXR workbench identity only from its egress IP on reviewed read paths', enabled: true };

async function main() {
  const { CLOUDFLARE_API_KEY: key, CLOUDFLARE_EMAIL: email, CLOUDFLARE_ZONE_ID: zone, AXR_WORKBENCH_EGRESS_IPS: ips } = process.env;
  if (!key || !email || !/^[a-f0-9]{32}$/.test(zone || '')) throw new Error('Cloudflare credentials unavailable');
  if (process.env.GITHUB_REF !== 'refs/heads/main') throw new Error('Only reviewed main may change edge policy');
  const expression = axrWorkbenchScopeExpression(String(ips || '').split(',').map((ip) => ip.trim()).filter(Boolean));
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/rulesets/${path}`, {
      method, headers: { 'X-Auth-Key': key, 'X-Auth-Email': email, 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
    });
    const result = await response.json();
    if (!response.ok || !result.success) throw new Error(`Cloudflare request failed: ${response.status}`);
    return result.result;
  };
  const ruleset = await api('phases/http_request_firewall_custom/entrypoint');
  if (ruleset.id !== 'cd3d15e4086648069f6bc73060cb8a62') throw new Error('Unexpected live ruleset');
  const existing = ruleset.rules.find((item) => item.ref === AXR_WORKBENCH_RULE.ref);
  if (existing && (existing.expression !== expression || existing.action !== 'block' || existing.enabled !== true)) throw new Error('Existing AXR rule differs from review; inspect again');
  writeFileSync('axr-workbench-edge-before.json', JSON.stringify(ruleset, null, 2), { flag: 'wx', mode: 0o600 });
  if (!existing) await api(`${ruleset.id}/rules`, 'POST', { ...AXR_WORKBENCH_RULE, expression });
  const after = await api('phases/http_request_firewall_custom/entrypoint');
  const added = after.rules.find((item) => item.ref === AXR_WORKBENCH_RULE.ref);
  if (added?.expression !== expression || added.action !== 'block' || added.enabled !== true) throw new Error('Edge policy readback mismatch');
  const stable = (items) => items.filter((item) => item.ref !== AXR_WORKBENCH_RULE.ref).map(({ version, last_updated, ...item }) => item);
  if (JSON.stringify(stable(after.rules)) !== JSON.stringify(stable(ruleset.rules))) throw new Error('Other rules changed concurrently; review backup');
  console.log(JSON.stringify({ ruleId: added.id, expression, created: !existing, otherRulesUnchanged: true, backup: 'axr-workbench-edge-before.json' }));
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
