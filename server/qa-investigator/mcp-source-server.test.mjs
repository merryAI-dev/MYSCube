import test from 'node:test';
import { createMcpSourceInvestigationTools } from './mcp-source-tools.mjs';
import { createSessionContext } from './session-context.mjs';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createInvestigationMcpSourceServer } from './mcp-source-server.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
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
function sources(execute) {
  return { tools: { read_state: { description: 'Read scoped state',
    parameters: { type: 'object', properties: { cursor: { type: 'string' } }, additionalProperties: false }, execute } } };
}
function evidence(extra = {}) {
  const body = { source: 'read_state', status: 'available', observed_at: '2026-10-14T00:00:00Z', ...extra };
  const content_hash = candidateHash(body);
  return { ...body, content_hash, evidence_id: `ev_${content_hash}` };
}

test('actual SDK preserves source envelope and same-session continuation state', async () => {
  const cursors = new Map(); let synchronized = 0, calls = 0;
  const context = sources(async args => {
    calls++;
    if (!args.cursor) { cursors.set('opaque', 1); return evidence({ next_cursor: 'opaque' }); }
    assert.equal(cursors.get(args.cursor), 1); return evidence({ next_cursor: null, rows: [1] });
  });
  const s = await session({ sources: context, authorityBinding: binding, authorize: async () => binding,
    synchronizeEvidence: async ({ sources: actual }) => { assert.equal(actual, context); synchronized++; } });
  try {
    assert.deepEqual((await s.client.listTools()).tools.map(tool => tool.name), ['read_state']);
    const first = await s.client.callTool({ name: 'read_state', arguments: {} });
    const second = await s.client.callTool({ name: 'read_state', arguments: { cursor: first.structuredContent.next_cursor } });
    assert.deepEqual(second.structuredContent, evidence({ next_cursor: null, rows: [1] }));
    assert.equal(candidateHash(second.structuredContent), second._meta['mysc/payload_sha256']);
    assert.equal(synchronized, 2); assert.equal(calls, 2);
  } finally { await s.close(); }
});

test('changed authority denies catalog and post-source results; invalid args cannot inject scope', async () => {
  let allowed = true, calls = 0;
  const s = await session({ sources: sources(async () => { calls++; allowed = false; return evidence(); }),
    authorityBinding: binding, authorize: async () => allowed ? binding : 'c'.repeat(64), synchronizeEvidence: async () => {} });
  try {
    await assert.rejects(s.client.callTool({ name: 'read_state', arguments: { tenant: 'other' } }), /request_denied/);
    assert.equal(calls, 0);
    await assert.rejects(s.client.callTool({ name: 'read_state', arguments: {} }), /request_denied/);
    await assert.rejects(s.client.listTools(), /request_denied/);
    assert.equal(calls, 1);
  } finally { await s.close(); }
});

test('payload requiring redaction is rejected rather than changing original evidence hashes', async () => {
  const s = await session({ sources: sources(async () => evidence({ secret: 'synthetic-secret' })),
    authorityBinding: binding, authorize: async () => binding, synchronizeEvidence: async () => {} });
  try { await assert.rejects(s.client.callTool({ name: 'read_state', arguments: {} }), /request_denied/); }
  finally { await s.close(); }
});



test('invalid observation and mismatched evidence identity are denied', async () => {
  for (const invalid of [{ observed_at: 'invalid' }, { content_hash: 'c'.repeat(64) }]) {
    const s = await session({ sources: sources(async () => ({ ...evidence(), ...invalid })),
      authorityBinding: binding, authorize: async () => binding, synchronizeEvidence: async () => {} });
    try { await assert.rejects(s.client.callTool({ name: 'read_state', arguments: {} }), /request_denied/); }
    finally { await s.close(); }
  }
});

test('stalled synchronization and execution fail within RPC deadline', async () => {
  for (const stage of ['sync', 'execute']) {
    let active, executions = 0;
    const s = await session({ sources: sources(async (_args, options) => {
      executions++; active = options.signal;
      if (stage === 'execute') return new Promise(() => {});
      return evidence();
    }), authorityBinding: binding, authorize: async () => binding, requestTimeoutMs: 30,
    synchronizeEvidence: async ({ signal }) => {
      active = signal;
      if (stage === 'sync') return new Promise(() => {});
    } });
    try {
      await assert.rejects(s.client.callTool({ name: 'read_state', arguments: {} }), /request_denied/);
      assert.equal(active.aborted, true);
      assert.equal(executions, stage === 'sync' ? 0 : 1);
    } finally { await s.close(); }
  }
});


test('foreign tenant, case, run and input version cannot become source evidence', async () => {
  for (const field of ['tenant_id', 'workspace_id', 'case_id', 'run_id', 'case_input_hash', 'aggregate_version']) {
    const s = await session({ sources: sources(async () => evidence({ [field]: field === 'aggregate_version' ? 2 : 'foreign' })),
      authorityBinding: binding, authorize: async () => binding, synchronizeEvidence: async () => {} });
    try { await assert.rejects(s.client.callTool({ name: 'read_state', arguments: {} }), /request_denied/); }
    finally { await s.close(); }
  }
});


test('SDK source response projects unchanged into the worker ledger only after receipt persistence', async () => {
  const original = evidence({ request_id: 'req_1791792279993_aa0de4197a294e00', rows: 'x'.repeat(200000) });
  const context = sources(async () => original);
  const s = await session({ sources: context, authorityBinding: binding, authorize: async () => binding,
    synchronizeEvidence: async () => {} });
  const receipts = [];
  try {
    const tools = await createMcpSourceInvestigationTools({ client: s.client, serverId: 'mysc',
      manifest: [{ name: 'read_state', alias: 'mcp_read_state', readOnly: true, description: 'Read scoped state',
        parameters: context.tools.read_state.parameters, remoteSchemaSha256: candidateHash(context.tools.read_state.parameters) }],
      runBinding, authorityBinding: binding, authorize: async () => {},
      scopeRequest: async ({ arguments: args }) => ({ arguments: args, scopeSha256: binding }),
      validateResponse: async () => true,
      recordReceipt: async receipt => { receipts.push(receipt); },
    });
    const result = await tools.read_state.execute({});
    assert.deepEqual(result, original); assert.equal(receipts.length, 1);
    assert.equal(receipts[0].payloadSha256, candidateHash(original));
    assert.equal(receipts[0].transportEvidence.source, 'mcp_read_state');
    const ledger = createSessionContext({ runBinding, report: {} });
    ledger.observe(result);
  } finally { await s.close(); }
});

for(const code of ['investigation_project_unobserved','investigation_project_access_denied']) {
 test(`actual MCP SDK delivers ${code} through projection to the model without evidence receipts`,async()=>{
  const {runOpenAIInvestigation}=await import('./openai-agent.mjs');
  const s=await session({sources:sources(async()=>{throw Object.assign(Error('Bearer PRIVATE'),{code});}),authorityBinding:binding,authorize:async()=>binding,synchronizeEvidence:async()=>{}});
  let receipts=0,requests=0;const originalFetch=globalThis.fetch,bodies=[];
  try {
   const catalog=(await s.client.listTools()).tools;
   const tools=await createMcpSourceInvestigationTools({serverId:'mysc',client:s.client,runBinding,authorityBinding:binding,
    manifest:catalog.map(t=>({name:t.name,alias:'mcp_'+t.name,description:t.description,parameters:t.inputSchema,readOnly:true,remoteSchemaSha256:candidateHash(t.inputSchema)})),
    authorize:async()=>{},scopeRequest:async({arguments:args})=>({arguments:args,scopeSha256:binding}),validateResponse:async()=>true,recordReceipt:async()=>{receipts++;}});
   const answer={facts:[],hypotheses:[],unknowns:[],user_reply:'추가 확인이 필요합니다.',next_actions:[],cause_status:'not_established'};
   globalThis.fetch=async(_url,options)=>{
    bodies.push(JSON.parse(options.body));requests++;
    if(requests>2)throw Error('unexpected model request');
    return Response.json({id:'response'+requests,status:'completed',output:[{type:'function_call',call_id:'call'+requests,name:requests===1?'read_state':'finalize_investigation',arguments:JSON.stringify(requests===1?{}:answer)}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}});
   };
   const result=await runOpenAIInvestigation({apiKey:'fixture',model:'gpt-6-sol',report:{text:'fixture'},tools,onCheckpoint:async()=>{},validateAnswer:async()=>({accepted:true})});
   assert.deepEqual(result,answer);assert.equal(receipts,0);
   const output=bodies[1].input.find(x=>x.type==='function_call_output'&&x.call_id==='call1');
   const failure=JSON.parse(output.output);assert.equal(failure.error,code);assert.ok(failure.next_step);
   assert.ok(!JSON.stringify(bodies).includes('PRIVATE'));
  }finally{globalThis.fetch=originalFetch;await s.close();}
 });
}

test('global authorization revocation overrides scoped MCP failure and cannot generate a receipt',async()=>{
 let allowed=true,receipts=0;
 const s=await session({sources:sources(async()=>{allowed=false;throw Object.assign(Error('private'),{code:'investigation_project_access_denied'});}),authorityBinding:binding,authorize:async()=>binding,synchronizeEvidence:async()=>{}});
 try {
  const catalog=(await s.client.listTools()).tools;
  const tools=await createMcpSourceInvestigationTools({serverId:'mysc',client:s.client,runBinding,authorityBinding:binding,
   manifest:catalog.map(t=>({name:t.name,alias:'mcp_'+t.name,description:t.description,parameters:t.inputSchema,readOnly:true,remoteSchemaSha256:candidateHash(t.inputSchema)})),
   authorize:async()=>{if(!allowed)throw Error('global_authority_revoked');},scopeRequest:async({arguments:args})=>({arguments:args,scopeSha256:binding}),validateResponse:async()=>true,recordReceipt:async()=>{receipts++;}});
  await assert.rejects(tools.read_state.execute({}),/global_authority_revoked/);assert.equal(receipts,0);
 }finally{await s.close();}
});
