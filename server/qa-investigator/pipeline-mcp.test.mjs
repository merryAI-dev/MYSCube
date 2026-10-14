import test from 'node:test';
import assert from 'node:assert/strict';
import { connectPipelineMcpSources } from './pipeline-mcp.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
const runBinding = { tenant_id: 'mysc', case_id: '11111111-1111-4111-8111-111111111111',
  run_id: 'qa-22222222-2222-4222-8222-222222222222', case_input_hash: 'a'.repeat(64), aggregate_version: 1 };
function setup() {
  let allowed = true, calls = 0;
  const receipts = [];
  const body = { source: 'query_logs', status: 'available', observed_at: '2026-10-14T00:00:00Z', rows: [1] };
  const hash = candidateHash(body), evidence = { ...body, content_hash: hash, evidence_id: `ev_${hash}` };
  const pipeline = { runBinding, authorize: async () => { if (!allowed) throw Error('revoked'); },
    reviewAuthorityBinding: () => ({ actor_id: 'actor', scope_sha256: 'b'.repeat(64) }),
    recordMcpReceipt: async receipt => { receipts.push(receipt); } };
  const sources = { tools: { query_logs: { description: 'Read logs',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => { calls++; return evidence; } } } };
  return { pipeline, sources, receipts, evidence, revoke: () => { allowed = false; }, calls: () => calls };
}
test('worker bridge uses same source instance and records receipt before returning original', async () => {
  const f = setup(), connection = await connectPipelineMcpSources(f);
  try {
    assert.deepEqual(await connection.tools.query_logs.execute({}), f.evidence);
    assert.equal(f.calls(), 1); assert.equal(f.receipts.length, 1);
    assert.equal(f.receipts[0].payloadSha256, candidateHash(f.evidence));
    f.revoke();
    await assert.rejects(connection.tools.query_logs.execute({}), /revoked/);
    assert.equal(f.calls(), 1);
  } finally { await connection.close(); }
});
test('worker bridge cannot bypass failed persistent receipt callback', async () => {
  const f = setup();
  f.pipeline.recordMcpReceipt = async () => { throw Error('storage_unavailable'); };
  const connection = await connectPipelineMcpSources(f);
  try { await assert.rejects(connection.tools.query_logs.execute({}), /storage_unavailable/); }
  finally { await connection.close(); }
});
