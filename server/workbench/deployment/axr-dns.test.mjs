import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { configureAxrDns, AXR_DNS_RECORD } from './axr-dns.mjs';

const zone = '1'.repeat(32), recordId = '2'.repeat(32);
const env = { CLOUDFLARE_ZONE_ID: zone, CLOUDFLARE_EMAIL: 'secret-mail', CLOUDFLARE_API_KEY: 'secret-key' };
const record = { ...AXR_DNS_RECORD, id: recordId };
const good = (result, result_info) => new Response(JSON.stringify({ success: true, errors: [], result, ...(result_info ? { result_info } : {}) }));
function fixture({ lists = [[]], zoneName = 'myscguard.app', create = record, confirmed = record, failAt, pages } = {}) {
  const calls = []; let index = 0;
  const fetchImpl = async (url, options) => {
    const parsed = new URL(url); calls.push({ path: parsed.pathname, query: parsed.searchParams, ...options });
    if (calls.length === failAt) throw new Error('secret-key secret-mail malicious provider diagnostic');
    if (parsed.pathname === `/client/v4/zones/${zone}`) return good({ id: zone, name: zoneName, status: 'active' });
    if (options.method === 'POST') return good(create);
    if (parsed.pathname.endsWith(`/${recordId}`)) return good(confirmed);
    const page = Number(parsed.searchParams.get('page'));
    return good(lists[Math.min(index++, lists.length - 1)], { page, total_pages: pages || 1 });
  };
  return { calls, fetchImpl };
}
const run = (f, args = {}) => configureAxrDns({ env, fetchImpl: f.fetchImpl, ...args });

describe('exact approved AXR DNS create-only operation', () => {
  it('plans with only reads and sanitized target/hash', async () => {
    const f = fixture(); const plan = await run(f);
    expect(plan.state).toBe('create'); expect(plan.planHash).toMatch(/^[a-f0-9]{64}$/);
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    expect(f.calls[1].query.get('name')).toBe('axr.myscguard.app');
    expect(JSON.stringify(plan)).not.toContain('secret');
    expect(f.calls.every(call => call.redirect === 'error' && call.signal instanceof AbortSignal)).toBe(true);
  });
  it('rechecks before a single exact POST, verifies GET and the final same-name list', async () => {
    const plan = await run(fixture()); const f = fixture({ lists: [[], [], [record]] });
    expect((await run(f, { action: 'apply', expectedPlanHash: plan.planHash })).result).toBe('created_and_verified');
    expect(f.calls.map(call => call.method)).toEqual(['GET', 'GET', 'GET', 'POST', 'GET', 'GET']);
    expect(JSON.parse(f.calls[3].body)).toEqual(AXR_DNS_RECORD);
    expect(f.calls[4].path).toBe(`/client/v4/zones/${zone}/dns_records/${recordId}`);
  });
  it('repeated exact record is no-op with no create/update/delete', async () => {
    const plan = await run(fixture({ lists: [[record]] })); const f = fixture({ lists: [[record]] });
    expect((await run(f, { action: 'apply', expectedPlanHash: plan.planHash })).result).toBe('no_change');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it.each([{ type: 'CNAME' }, { content: '1.2.3.4' }, { ttl: 1 }, { proxied: true }])('rejects existing differences without overwrite: %j', async patch => {
    const f = fixture({ lists: [[{ ...record, ...patch }]] });
    await expect(run(f)).rejects.toThrow('axr_dns_existing_record_conflict');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('rejects duplicate matching records, including later pages', async () => {
    const f = fixture({ lists: [[record], [{ ...record, id: '3'.repeat(32) }]], pages: 2 });
    await expect(run(f)).rejects.toThrow('axr_dns_existing_record_conflict');
    expect(f.calls).toHaveLength(3);
  });
  it('rejects a wrong zone before any DNS record access', async () => {
    const f = fixture({ zoneName: 'elsewhere.example' });
    await expect(run(f)).rejects.toThrow('axr_dns_zone_mismatch'); expect(f.calls).toHaveLength(1);
  });
  it('rejects stale or absent plan hashes before mutation', async () => {
    for (const expectedPlanHash of [undefined, 'a'.repeat(64)]) {
      const f = fixture(); await expect(run(f, { action: 'apply', expectedPlanHash })).rejects.toThrow('axr_dns_plan_changed');
      expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    }
  });
  it('detects a record created between plan and final pre-write check', async () => {
    const plan = await run(fixture()); const f = fixture({ lists: [[], [record]] });
    await expect(run(f, { action: 'apply', expectedPlanHash: plan.planHash })).rejects.toThrow('axr_dns_plan_changed');
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
  });
  it('detects a concurrent conflicting create after POST without deleting anyone’s record', async () => {
    const plan = await run(fixture()); const f = fixture({ lists: [[], [], [record, { ...record, id: '3'.repeat(32) }]] });
    await expect(run(f, { action: 'apply', expectedPlanHash: plan.planHash })).rejects.toThrow('axr_dns_existing_record_conflict');
    expect(f.calls.filter(call => call.method !== 'GET')).toHaveLength(1);
  });
  it('redacts transport errors and never retries an uncertain POST', async () => {
    const plan = await run(fixture()); const f = fixture({ failAt: 4 });
    await expect(run(f, { action: 'apply', expectedPlanHash: plan.planHash })).rejects.toThrow('axr_dns_create_uncertain_replan_before_retry');
    expect(f.calls).toHaveLength(4);
  });
  it('rejects false success, oversized body, wrong-name results, and mismatched post-read', async () => {
    for (const response of [new Response(JSON.stringify({ success: false, errors: [{ message: 'secret-key' }] })), new Response(' '.repeat(262145))]) {
      await expect(configureAxrDns({ env, fetchImpl: async () => response })).rejects.toThrow('axr_dns_read_failed');
    }
    await expect(run(fixture({ lists: [[{ ...record, name: 'myscube.myscguard.app' }]] }))).rejects.toThrow('axr_dns_record_invalid');
    const plan = await run(fixture());
    await expect(run(fixture({ confirmed: { ...record, content: '1.2.3.4' } }), { action: 'apply', expectedPlanHash: plan.planHash })).rejects.toThrow('axr_dns_created_record_mismatch');
  });
  it('keeps the existing report flow and isolates DNS to approved manual dispatch', async () => {
    const workflow = await readFile(new URL('../../../.github/workflows/cloudflare-security-daily-report.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('default: report');
    expect(workflow).toContain('github.event_name != \'workflow_dispatch\' || inputs.action == \'report\' || inputs.action == \'\'');
    expect(workflow).toContain('run: npm run security:cloudflare:daily-report');
    expect(workflow).toContain('github.ref == \'refs/heads/feat/axr-isolated-workbench-complete\'');
    expect(workflow).toContain('"$REVIEWED_SHA" == "$GITHUB_SHA"');
    expect(workflow).toContain('cancel-in-progress: false');
    expect(workflow).not.toContain('environment:');
    expect(workflow).not.toContain('pull_request');
  });
});
