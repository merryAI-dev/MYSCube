import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const AXR_DNS_RECORD = Object.freeze({ type: 'A', name: 'axr.myscguard.app', content: '34.64.247.190', ttl: 300, proxied: false });
const fail = code => { throw new Error(code); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = record => Object.entries(AXR_DNS_RECORD).every(([key, value]) => record?.[key] === value);

export async function configureAxrDns({ action = 'plan', expectedPlanHash, env = process.env, fetchImpl = fetch } = {}) {
  if (!['plan', 'apply'].includes(action)) fail('axr_dns_invalid_action');
  const zone = env.CLOUDFLARE_ZONE_ID;
  if (!/^[a-f0-9]{32}$/.test(zone || '') || !env.CLOUDFLARE_API_KEY || !env.CLOUDFLARE_EMAIL) fail('axr_dns_credentials_missing');
  const total = AbortSignal.timeout(60000);
  async function request(path, method = 'GET', body) {
    try {
      const response = await fetchImpl(`https://api.cloudflare.com/client/v4/zones/${zone}${path}`, {
        method, redirect: 'error', signal: AbortSignal.any([total, AbortSignal.timeout(10000)]),
        headers: { 'X-Auth-Key': env.CLOUDFLARE_API_KEY, 'X-Auth-Email': env.CLOUDFLARE_EMAIL, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok || !response.body) fail('response');
      let size = 0; const chunks = [];
      for await (const chunk of response.body) { size += chunk.length; if (size > 262144) fail('size'); chunks.push(Buffer.from(chunk)); }
      const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (json.success !== true || !Array.isArray(json.errors) || json.errors.length) fail('envelope');
      return json;
    } catch { fail(method === 'POST' ? 'axr_dns_create_uncertain_replan_before_retry' : 'axr_dns_read_failed'); }
  }
  const zoneInfo = (await request('')).result;
  if (zoneInfo?.id !== zone || zoneInfo.name !== 'myscguard.app' || zoneInfo.status !== 'active') fail('axr_dns_zone_mismatch');
  async function records() {
    const found = []; let expectedPages;
    for (let page = 1; page <= 10; page++) {
      const query = new URLSearchParams({ name: AXR_DNS_RECORD.name, page: String(page), per_page: '100' });
      const result = await request(`/dns_records?${query}`);
      const info = result.result_info;
      if (!Array.isArray(result.result) || !Number.isInteger(info?.total_pages) || info.total_pages < 0 || info.total_pages > 10 || info.page !== page || (expectedPages !== undefined && expectedPages !== info.total_pages)) fail('axr_dns_pagination_invalid');
      expectedPages = info.total_pages;
      for (const record of result.result) {
        if (record?.name !== AXR_DNS_RECORD.name || !/^[a-f0-9]{32}$/.test(record.id || '')) fail('axr_dns_record_invalid');
        found.push(record);
      }
      if (page >= expectedPages) return found;
    }
    fail('axr_dns_pagination_invalid');
  }
  function inspect(items) {
    if (items.length > 1 || (items.length === 1 && !same(items[0]))) fail('axr_dns_existing_record_conflict');
    return items.length ? 'already_matches' : 'create';
  }
  const initial = await records();
  const state = inspect(initial);
  const planHash = digest({ zone, desired: AXR_DNS_RECORD, state, recordIds: initial.map(row => row.id) });
  const safe = { schemaVersion: 1, action, state, record: AXR_DNS_RECORD, planHash };
  if (action === 'plan') return safe;
  if (!/^[a-f0-9]{64}$/.test(expectedPlanHash || '') || expectedPlanHash !== planHash) fail('axr_dns_plan_changed');
  const beforeWrite = await records();
  const currentState = inspect(beforeWrite);
  if (currentState !== state || beforeWrite.map(row => row.id).join() !== initial.map(row => row.id).join()) fail('axr_dns_plan_changed');
  if (state === 'already_matches') return { ...safe, result: 'no_change' };
  const created = (await request('/dns_records', 'POST', AXR_DNS_RECORD)).result;
  if (!same(created) || !/^[a-f0-9]{32}$/.test(created?.id || '')) fail('axr_dns_create_response_mismatch');
  const confirmed = (await request(`/dns_records/${created.id}`)).result;
  if (!same(confirmed) || confirmed.id !== created.id) fail('axr_dns_created_record_mismatch');
  const after = await records();
  inspect(after);
  if (after.length !== 1 || after[0].id !== created.id) fail('axr_dns_concurrent_change_detected');
  return { ...safe, result: 'created_and_verified' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  configureAxrDns({ action: process.env.AXR_DNS_ACTION, expectedPlanHash: process.env.AXR_DNS_PLAN_HASH })
    .then(result => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch(error => { process.stderr.write(`${/^axr_dns_[a-z_]+$/.test(error?.message || '') ? error.message : 'axr_dns_failed'}\n`); process.exitCode = 1; });
}
