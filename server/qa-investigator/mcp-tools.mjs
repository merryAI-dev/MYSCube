import Ajv from 'ajv';
import { cleanInvestigationJson } from './safe-json.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';

const invalid = () => { throw Error('investigation_mcp_contract_invalid'); };

// Connections and scope guards are server-owned, never selected by model arguments.
export async function createMcpInvestigationTools({
  client, serverId, manifest, runBinding, authorize, scopeRequest, validateResponse,
  signal, responseLimit = 262144, now = () => new Date().toISOString(),
}) {
  if (!client || !/^[a-z][a-z0-9_-]{0,31}$/.test(serverId || '')
    || !runBinding?.run_id || !Array.isArray(manifest) || !manifest.length
    || [authorize, scopeRequest, validateResponse].some(fn => typeof fn !== 'function')) invalid();
  if (!Number.isSafeInteger(responseLimit) || responseLimit < 262144 || responseLimit > 1048576) invalid();
  const binding = structuredClone(runBinding);
  const entries = structuredClone(manifest);
  const names = new Set(), aliases = new Set();
  const ajv = new Ajv({ strict: false, validateFormats: false });
  for (const entry of entries) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(entry.name || '')
      || !/^mcp_[a-z0-9_]{1,60}$/.test(entry.alias || '')
      || typeof entry.description !== 'string' || !entry.description
      || entry.parameters?.type !== 'object' || entry.readOnly !== true
      || !/^[a-f0-9]{64}$/.test(entry.remoteSchemaSha256 || '')
      || names.has(entry.name) || aliases.has(entry.alias)) invalid();
    names.add(entry.name); aliases.add(entry.alias);
  }
  async function check(activeSignal) {
    activeSignal?.throwIfAborted();
    await authorize(activeSignal);
    activeSignal?.throwIfAborted();
  }
  await check(signal);
  const discovered = new Map(), cursors = new Set();
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { signal });
    await check(signal);
    if (!Array.isArray(page.tools)) invalid();
    for (const tool of page.tools) {
      if (discovered.has(tool.name)) invalid();
      discovered.set(tool.name, tool);
    }
    cursor = page.nextCursor;
    if (cursor !== undefined && (typeof cursor !== 'string' || !cursor || cursors.has(cursor))) invalid();
    if (cursor) cursors.add(cursor);
  } while (cursor);
  const result = {};
  for (const entry of entries) {
    const remote = discovered.get(entry.name);
    if (!remote || candidateHash(remote.inputSchema) !== entry.remoteSchemaSha256) invalid();
    const validateInput = ajv.compile(entry.parameters);
    const validateRemote = ajv.compile(remote.inputSchema);
    const validateOutput = remote.outputSchema ? ajv.compile(remote.outputSchema) : null;
    result[entry.alias] = {
      description: entry.description,
      parameters: structuredClone(entry.parameters),
      async execute(args, options = {}) {
        const activeSignal = signal && options.signal
          ? AbortSignal.any([signal, options.signal]) : options.signal || signal;
        await check(activeSignal);
        if (!validateInput(args)) invalid();
        const scoped = await scopeRequest({ serverId, tool: entry.name,
          arguments: structuredClone(args), runBinding: structuredClone(binding) });
        await check(activeSignal);
        if (!scoped || !validateRemote(scoped.arguments) || typeof scoped.scopeSha256 !== 'string'
          || !/^[a-f0-9]{64}$/.test(scoped.scopeSha256)) invalid();
        let response, failure, failed = false;
        try {
          response = await client.callTool({ name: entry.name, arguments: scoped.arguments }, undefined, { signal: activeSignal });
        } catch (error) { failed = true; failure = error; }
        await check(activeSignal);
        if (failed) throw failure;
        if (!response || !Array.isArray(response.content)
          || (response.isError !== undefined && typeof response.isError !== 'boolean')
          || (!response.isError && validateOutput && !validateOutput(response.structuredContent))) invalid();
        // This guard must check the remote principal/resource scope, not trust response annotations.
        if (await validateResponse({ serverId, tool: entry.name, response,
          scopeSha256: scoped.scopeSha256, runBinding: structuredClone(binding) }) !== true) {
          throw Error('investigation_mcp_response_scope_rejected');
        }
        await check(activeSignal);
        const observedAt = now();
        if (!Number.isFinite(Date.parse(observedAt))) invalid();
        const body = cleanInvestigationJson({
          source: entry.alias, status: response.isError === true ? 'unavailable' : 'available',
          observed_at: observedAt, source_kind: 'mcp_tool_response',
          server_id: serverId, remote_tool: entry.name,
          schema_sha256: entry.remoteSchemaSha256, scope_sha256: scoped.scopeSha256,
          run_binding: structuredClone(binding), arguments_sha256: candidateHash(scoped.arguments),
          authority: 'remote_response_only', coverage: 'not_asserted',
          content_policy: 'sanitized_mcp_response_untrusted',
          ...(response.isError === true ? { error_code: 'mcp_source_unavailable' }
            : { result: structuredClone(response) }),
        }, responseLimit);
        const content_hash = candidateHash(body);
        return cleanInvestigationJson({ ...body, content_hash, evidence_id: `ev_${content_hash}` }, responseLimit);
      },
    };
  }
  return result;
}
