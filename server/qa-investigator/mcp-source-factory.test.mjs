import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInvestigationMcpSourceServer } from './mcp-source-server.mjs';
import { createPipelineInvestigationTools } from './pipeline-tools.mjs';
const binding = 'b'.repeat(64);
const runBinding = { tenant_id: 'mysc', case_id: '11111111-1111-4111-8111-111111111111',
  run_id: 'qa-22222222-2222-4222-8222-222222222222', case_input_hash: 'a'.repeat(64), aggregate_version: 1 };
async function session(options) {
  const server = createInvestigationMcpSourceServer({ runBinding, ...options });
  const client = new Client({ name: 'test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  return { client, close: async () => { await client.close(); await server.close(); } };
}
test('actual shared platform factory is exposed through the SDK without broadening tool scope', async () => {
  let network = 0, deniedCalls = 0;
  const shared = await createPipelineInvestigationTools({
    pipeline: { authorize: async () => { deniedCalls++; throw Error('denied'); } },
    auth: { getClient: async () => { network++; throw Error('no network'); } },
    request: { policy: { cloudProject: 'inner-platform-live-20260316', tenant: 'mysc', scopeKind: 'platform',
      trustedActorId: 'reporter', allowedProjectIds: [], allowedStartAt: '2026-10-12T08:00:00Z',
      allowedEndAt: '2026-10-12T08:10:00Z', services: [{ name: 'innerplatform-jvm-weekly-api-live', region: 'us-central1' }],
    }, report: { server_context: {} } }, runBinding: { run_id: 'test' }, env: {},
  });
  const s = await session({ sources: shared, authorityBinding: binding, authorize: async () => binding, synchronizeEvidence: async () => {} });
  try {
    const catalog = (await s.client.listTools()).tools;
    assert.deepEqual(catalog.map(tool => tool.name).sort(), Object.keys(shared.tools).sort());
    assert.ok(catalog.some(tool => tool.name === 'query_jvm_request_diagnostics'));
    assert.equal(catalog.some(tool => tool.name.includes('sheet')), true);
    await assert.rejects(s.client.callTool({ name: 'query_jvm_request_diagnostics', arguments: {
      evidence_id: `ev_${'a'.repeat(64)}`, request_id: 'req_1791792279993_aa0de4197a294e00', region: 'us-central1',
    } }), /request_denied/);
    assert.equal(network, 0); assert.equal(deniedCalls, 1);
  } finally { await s.close(); }
});

