import { boundedMcpRequest, boundedMcpAuthorization } from './mcp-response-budget.mjs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpInvestigationTools } from './mcp-tools.mjs';
import { createMcpSourceInvestigationTools } from './mcp-source-tools.mjs';

// Only deployment-owned endpoints and credentials enter this factory.
export async function connectMcpInvestigationTools({
  endpoint, allowedEndpoints, getAuthorization, fetchImpl = globalThis.fetch,
  maxResponseBytes = 8388608, requestTimeoutMs = 30000,
  ...adapter
}) {
  let url;
  try { url = new URL(endpoint); } catch { throw Error('investigation_mcp_endpoint_invalid'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || !Array.isArray(allowedEndpoints) || !allowedEndpoints.includes(url.href)
    || typeof getAuthorization !== 'function' || typeof adapter.authorize !== 'function') {
    throw Error('investigation_mcp_endpoint_invalid');
  }
  let closed = false;
  const lifetime = new AbortController();
  const sessionSignal = adapter.signal ? AbortSignal.any([adapter.signal, lifetime.signal]) : lifetime.signal;
  const invocation = new AsyncLocalStorage();
  const authorize = async (requestSignal) => {
    if (closed) throw Error('investigation_mcp_connection_closed');
    sessionSignal.throwIfAborted();
    const signals = [sessionSignal, requestSignal, invocation.getStore()?.signal].filter(Boolean);
    await boundedMcpAuthorization({ authorize: adapter.authorize,
      signal: AbortSignal.any(signals), maxDurationMs: requestTimeoutMs });
    sessionSignal.throwIfAborted();
  };
  const transport = new StreamableHTTPClientTransport(url, {
    fetch: async (input, init = {}) => {
      const target = input instanceof Request ? input.url : String(input);
      if (target !== url.href) throw Error('investigation_mcp_endpoint_invalid');
      const message = typeof init.body === 'string' ? JSON.parse(init.body) : null;
      const call = message?.method === 'tools/call' ? invocation.getStore() : null;
      if (message?.method === 'tools/call' && !call) throw Error('investigation_mcp_call_context_missing');
      const signals = [sessionSignal, init.signal, call?.signal].filter(Boolean);
      const signal = signals.length ? AbortSignal.any(signals) : undefined;
      return boundedMcpRequest({
        signal, maxBytes: maxResponseBytes, maxDurationMs: requestTimeoutMs,
        onFailure: error => { void close(error).catch(() => {}); },
        request: async activeSignal => {
          activeSignal.throwIfAborted();
          await authorize(activeSignal);
          activeSignal.throwIfAborted();
          const authorization = await getAuthorization({ signal: activeSignal });
          await authorize(activeSignal);
          activeSignal.throwIfAborted();
          if (typeof authorization !== 'string' || !/^Bearer [^\s]+$/.test(authorization)) {
            throw Error('investigation_mcp_credentials_unavailable');
          }
          const headers = new Headers(init.headers);
          headers.set('Authorization', authorization);
          const response = await fetchImpl(input, { ...init, headers, signal: activeSignal, redirect: 'error' });
          try { await authorize(activeSignal); activeSignal.throwIfAborted(); }
          catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
          return response;
        },
      });
    },
  });
  const client = new Client({ name: 'mysc-qa-investigator', version: '0.1.0' });
  const onAbort = () => { void close(adapter.signal.reason).catch(() => {}); };
  adapter.signal?.addEventListener('abort', onAbort, { once: true });
  async function close(reason = Error('investigation_mcp_connection_closed')) {
    if (closed) return;
    closed = true;
    lifetime.abort(reason);
    adapter.signal?.removeEventListener('abort', onAbort);
    await client.close();
  }
  try {
    await authorize();
    await client.connect(transport, { signal: sessionSignal });
    await authorize();
    const scopedClient = {
      listTools: (params, options = {}) => client.listTools(params, { ...options, signal: sessionSignal }),
      callTool: (params, schema, options) => invocation.run({ signal: options?.signal },
        () => client.callTool(params, schema, options)),
    };
    const factory = adapter.authorityBinding === undefined ? createMcpInvestigationTools : createMcpSourceInvestigationTools;
    const tools = await factory({ ...adapter, signal: sessionSignal, client: scopedClient, authorize });
    return { tools, close };
  } catch (error) {
    const reason = sessionSignal.aborted ? sessionSignal.reason : error;
    await close(reason).catch(() => {});
    throw reason;
  }
}
