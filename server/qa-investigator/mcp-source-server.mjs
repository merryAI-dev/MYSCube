import { safeToolFailure } from './tool-failure.mjs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import Ajv from 'ajv';
import { validateInvestigationEvidence, normalizeInvestigationBinding } from './session-context.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
import { cleanInvestigationJson } from './safe-json.mjs';
import { boundedMcpAuthorization, boundedMcpOperation } from './mcp-response-budget.mjs';

// One server instance belongs to one trusted investigation context, never a shared global registry.
export function createInvestigationMcpSourceServer({ sources, authorize, synchronizeEvidence,
  authorityBinding, runBinding, signal, requestTimeoutMs = 30000 }) {
  if (!sources?.tools || typeof authorize !== 'function' || typeof synchronizeEvidence !== 'function'
    || !/^[a-f0-9]{64}$/.test(authorityBinding || '')) throw Error('investigation_mcp_server_invalid');
  const bound = normalizeInvestigationBinding(runBinding);
  const ajv = new Ajv({ strict: false, validateFormats: false });
  const entries = Object.entries(sources.tools).sort(([a], [b]) => a.localeCompare(b)).map(([name, tool]) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || typeof tool.execute !== 'function'
      || typeof tool.description !== 'string' || tool.parameters?.type !== 'object') throw Error('investigation_mcp_server_invalid');
    return { name, tool, inputSchema: structuredClone(tool.parameters), validate: ajv.compile(tool.parameters) };
  });
  const catalog = entries.map(({ name, tool, inputSchema }) => ({ name, description: tool.description, inputSchema }));
  const catalogHash = candidateHash({ authorityBinding, runBinding: bound, catalog });
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const server = new Server({ name: 'mysc-investigation-sources', version: '0.1.0' }, { capabilities: { tools: {} } });
  const effective = extra => signal ? AbortSignal.any([signal, extra.signal]) : extra.signal;
  async function check(activeSignal) {
    activeSignal?.throwIfAborted();
    await boundedMcpAuthorization({ authorize: async () => {
      if (await authorize() !== authorityBinding) throw Error('investigation_mcp_authority_changed');
    }, signal: activeSignal, maxDurationMs: requestTimeoutMs });
    activeSignal?.throwIfAborted();
  }
  const denied = () => new McpError(ErrorCode.InvalidRequest, 'investigation_mcp_request_denied');
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    try { return await boundedMcpOperation({ signal: effective(extra), maxDurationMs: requestTimeoutMs, operation: async activeSignal => {
      await check(activeSignal);
      let offset = 0;
      if (request.params?.cursor) {
        const cursor = JSON.parse(Buffer.from(request.params.cursor, 'base64url').toString('utf8'));
        if (cursor.catalog !== catalogHash || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > catalog.length) throw denied();
        offset = cursor.offset;
      }
      const tools = []; let bytes = 0;
      while (offset < catalog.length) {
        const entry = catalog[offset], size = Buffer.byteLength(JSON.stringify(entry));
        if (size > 32768) throw denied();
        if (bytes + size > 32768) break;
        tools.push(structuredClone(entry)); bytes += size; offset++;
      }
      await check(activeSignal);
      return { tools, ...(offset < catalog.length ? { nextCursor: Buffer.from(JSON.stringify({ catalog: catalogHash, offset })).toString('base64url') } : {}) };
    } }); } catch { throw denied(); }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try { return await boundedMcpOperation({ signal: effective(extra), maxDurationMs: requestTimeoutMs, operation: async activeSignal => {
      await check(activeSignal);
      const entry = byName.get(request.params.name), args = request.params.arguments ?? {};
      if (!entry || !entry.validate(args)) throw denied();
      // The host restores only authoritative persisted evidence; model-provided envelopes are not accepted.
      await synchronizeEvidence({ sources, signal: activeSignal });
      await check(activeSignal);
      const output = await entry.tool.execute(args, { signal: activeSignal });
      await check(activeSignal);
      if (output?.source !== entry.name || !/^ev_[a-f0-9]{64}$/.test(output?.evidence_id || '')
        || !['available', 'unavailable'].includes(output?.status)
        || typeof output.observed_at !== 'string' || !Number.isFinite(Date.parse(output.observed_at))
        || (output.content_hash !== undefined && (!/^[a-f0-9]{64}$/.test(output.content_hash)
          || output.evidence_id !== `ev_${output.content_hash}`))) throw denied();
      validateInvestigationEvidence(output, bound);
      const safe = cleanInvestigationJson(output);
      if (candidateHash(safe) !== candidateHash(output)) throw denied();
      return { content: [{ type: 'text', text: JSON.stringify(safe) }], structuredContent: safe,
        _meta: { 'mysc/authority_binding': authorityBinding,
          'mysc/payload_sha256': candidateHash(safe), 'mysc/input_schema_sha256': candidateHash(entry.inputSchema) } };
    } }); } catch (error) {
      const safe=safeToolFailure(error);
      if(safe) {
        try { await check(effective(extra)); } catch { throw denied(); }
        throw new McpError(ErrorCode.InvalidRequest,'investigation_mcp_request_denied',{reason:safe.error});
      }
      throw denied();
    }
  });
  return server;
}
