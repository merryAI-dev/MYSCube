import test from 'node:test';
import assert from 'node:assert/strict';
import { createMcpSourceInvestigationTools } from './mcp-source-tools.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
const binding = 'b'.repeat(64);
const runBinding = { tenant_id: 'mysc', case_id: '11111111-1111-4111-8111-111111111111',
  run_id: 'qa-22222222-2222-4222-8222-222222222222', case_input_hash: 'a'.repeat(64), aggregate_version: 1 };
const schema = { type: 'object', properties: {}, additionalProperties: false };
function response() {
  const body = { source: 'read_state', status: 'available', observed_at: '2026-10-14T00:00:00Z' };
  const hash = candidateHash(body);
  const output = { ...body, content_hash: hash, evidence_id: `ev_${hash}` };
  return { content: [{ type: 'text', text: JSON.stringify(output) }], structuredContent: output,
    _meta: { 'mysc/authority_binding': binding, 'mysc/payload_sha256': candidateHash(output),
      'mysc/input_schema_sha256': candidateHash(schema) } };
}
async function tools(overrides = {}) {
  return createMcpSourceInvestigationTools({ serverId: 'mysc', runBinding, authorityBinding: binding,
    client: { listTools: async () => ({ tools: [{ name: 'read_state', inputSchema: schema }] }), callTool: async () => response() },
    manifest: [{ name: 'read_state', alias: 'mcp_read_state', description: 'Read', parameters: schema,
      readOnly: true, remoteSchemaSha256: candidateHash(schema) }], authorize: async () => {},
    scopeRequest: async () => ({ arguments: {}, scopeSha256: binding }), validateResponse: async () => true,
    recordReceipt: async () => {}, ...overrides });
}
test('receipt failure or authority revocation prevents returning projected evidence', async () => {
  const failed = await tools({ recordReceipt: async () => { throw Error('receipt_failed'); } });
  await assert.rejects(failed.read_state.execute({}), /receipt_failed/);
  let allowed = true;
  const revoked = await tools({ authorize: async () => { if (!allowed) throw Error('revoked'); },
    recordReceipt: async () => { allowed = false; } });
  await assert.rejects(revoked.read_state.execute({}), /revoked/);
});
test('forged transport metadata or inconsistent text cannot enter original source ledger', async () => {
  for (const mutation of [r => { r._meta['mysc/authority_binding'] = 'c'.repeat(64); },
    r => { r._meta['mysc/payload_sha256'] = 'c'.repeat(64); },
    r => { r.content[0].text = '{}'; }]) {
    let receipts = 0;
    const source = await tools({ client: { listTools: async () => ({ tools: [{ name: 'read_state', inputSchema: schema }] }),
      callTool: async () => { const r = response(); mutation(r); return r; } },
      recordReceipt: async () => { receipts++; } });
    await assert.rejects(source.read_state.execute({}), /source_response_invalid/);
    assert.equal(receipts, 0);
  }
});
