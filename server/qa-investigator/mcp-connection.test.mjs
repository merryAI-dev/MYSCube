import test from 'node:test';
import assert from 'node:assert/strict';
import { connectMcpInvestigationTools } from './mcp-connection.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
const endpoint = 'https://mcp.example.test/mcp';
const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
function configuration() {
  const methods = [];
  const config = {
    endpoint, allowedEndpoints: [endpoint], getAuthorization: async () => 'Bearer synthetic-test-token',
    serverId: 'test', runBinding: { run_id: 'test' }, authorize: async () => {},
    manifest: [{ name: 'read', alias: 'mcp_read', description: 'Scoped read', parameters: inputSchema,
      readOnly: true, remoteSchemaSha256: candidateHash(inputSchema) }],
    scopeRequest: async ({ arguments: args }) => ({ arguments: args, scopeSha256: 'a'.repeat(64) }),
    validateResponse: async () => true,
    fetchImpl: async (input, options) => {
      assert.equal(String(input), endpoint);
      assert.equal(options.redirect, 'error');
      assert.equal(new Headers(options.headers).get('authorization'), 'Bearer synthetic-test-token');
      if (options.method === 'GET') return new Response(null, { status: 405 });
      const message = JSON.parse(options.body); methods.push(message.method);
      if (!Object.hasOwn(message, 'id')) return new Response(null, { status: 202 });
      let result;
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: 'test-source', version: '1' } };
      else if (message.method === 'tools/list') result = { tools: [{ name: 'read', inputSchema }] };
      else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: 'source data' }] };
      else throw Error('unexpected_protocol_method');
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  return { config, methods };
}

test('installed SDK negotiates HTTP MCP, discovers and calls through evidence adapter', async () => {
  const { config, methods } = configuration();
  let authReads = 0;
  config.getAuthorization = async () => { authReads++; return 'Bearer synthetic-test-token'; };
  const session = await connectMcpInvestigationTools(config);
  try {
    const result = await session.tools.mcp_read.execute({});
    assert.equal(result.status, 'available');
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.ok(authReads >= methods.length);
  } finally { await session.close(); }
  await assert.rejects(session.tools.mcp_read.execute({}), /connection_closed/);
});

test('unlisted or credential-bearing endpoint fails before any network or token read', async () => {
  for (const url of ['https://other.example.test/mcp', endpoint + '?token=x', 'https://u:p@mcp.example.test/mcp']) {
    const { config } = configuration(); let calls = 0;
    config.endpoint = url;
    config.getAuthorization = config.fetchImpl = async () => { calls++; throw Error('must not call'); };
    await assert.rejects(connectMcpInvestigationTools(config), /endpoint_invalid/);
    assert.equal(calls, 0);
  }
});

test('authority revoked while credential refresh waits prevents dispatch', async () => {
  const { config } = configuration(); let revoked = false, calls = 0;
  const denied = Error('authority_revoked');
  config.authorize = async () => { if (revoked) throw denied; };
  config.getAuthorization = async () => { revoked = true; return 'Bearer synthetic-test-token'; };
  config.fetchImpl = async () => { calls++; throw Error('must not call'); };
  await assert.rejects(connectMcpInvestigationTools(config), e => e === denied);
  assert.equal(calls, 0);
});

test('per-call cancellation during credential refresh cannot dispatch a late tools/call', async () => {
  const { config, methods } = configuration();
  const controller = new AbortController(), reason = Error('call_cancelled');
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  let hold = false;
  config.getAuthorization = async ({ signal }) => {
    if (hold) {
      hold = false;
      entered();
      await new Promise(resolve => { release = resolve; });
    }
    return 'Bearer synthetic-test-token';
  };
  const connected = await connectMcpInvestigationTools(config);
  try {
    hold = true;
    const call = connected.tools.mcp_read.execute({}, { signal: controller.signal });
    const rejection = assert.rejects(call, e => e === reason);
    await waiting;
    controller.abort(reason);
    release();
    await rejection;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(methods.filter(method => method === 'tools/call').length, 0);
  } finally { await connected.close(); }
});

test('credential deadline blocks late dispatch after a provider ignores its signal', async () => {
  const { config, methods } = configuration();
  config.requestTimeoutMs = 20;
  let hold = false, release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  config.getAuthorization = async () => {
    if (hold) { hold = false; entered(); await new Promise(resolve => { release = resolve; }); }
    return 'Bearer synthetic-test-token';
  };
  const connected = await connectMcpInvestigationTools(config);
  try {
    hold = true;
    const rejected = assert.rejects(connected.tools.mcp_read.execute({}));
    await waiting;
    await rejected;
    release();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(methods.filter(method => method === 'tools/call').length, 0);
  } finally { await connected.close(); }
});

test('SDK cannot convert incomplete SSE data to successful evidence or reconnect after budget failure', async () => {
  const { config } = configuration();
  const normal = config.fetchImpl;
  config.requestTimeoutMs = 20;
  let reads = 0, cancelled = 0;
  config.fetchImpl = async (input, options) => {
    if (options.body && JSON.parse(options.body).method === 'tools/call') {
      reads++;
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode('id: retry-me\n\ndata: {"jsonrpc":')); },
        cancel() { cancelled++; },
      }), { headers: { 'content-type': 'text/event-stream' } });
    }
    return normal(input, options);
  };
  const connected = await connectMcpInvestigationTools(config);
  await assert.rejects(connected.tools.mcp_read.execute({}));
  await assert.rejects(connected.tools.mcp_read.execute({}), /response_timeout/);
  assert.equal(reads, 1); assert.equal(cancelled, 1);
  await connected.close();
});

test('uncooperative initial authority check obeys deadline and root cancellation', async () => {
  for (const abort of [false, true]) {
    const { config } = configuration();
    config.requestTimeoutMs = 15;
    config.authorize = () => new Promise(() => {});
    const controller = new AbortController(); config.signal = controller.signal;
    const result = connectMcpInvestigationTools(config);
    const rejected = assert.rejects(result, abort ? /stopped/ : /authority_timeout/);
    if (abort) controller.abort(Error('stopped'));
    await rejected;
  }
});

test('hanging authorization after response headers cancels the unconsumed body', async () => {
  const { config } = configuration();
  config.requestTimeoutMs = 15;
  let received = false, cancelled = 0;
  config.authorize = async () => { if (received) await new Promise(() => {}); };
  config.fetchImpl = async () => {
    received = true;
    return new Response(new ReadableStream({ cancel() { cancelled++; } }));
  };
  await assert.rejects(connectMcpInvestigationTools(config), /timeout/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cancelled, 1);
});
