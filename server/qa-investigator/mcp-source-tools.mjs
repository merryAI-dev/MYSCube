import { firstPartyToolFailureReason } from './tool-failure.mjs';
import { createMcpInvestigationTools } from './mcp-tools.mjs';
import { cleanInvestigationJson } from './safe-json.mjs';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
import { normalizeInvestigationBinding, validateInvestigationEvidence } from './session-context.mjs';

// First-party projection is enabled only by the host, after its remote-principal guard.
export async function createMcpSourceInvestigationTools({ authorityBinding, recordReceipt, ...options }) {
  if (!/^[a-f0-9]{64}$/.test(authorityBinding || '') || typeof recordReceipt !== 'function') {
    throw Error('investigation_mcp_source_contract_invalid');
  }
  const bound = normalizeInvestigationBinding(options.runBinding);
  const manifest = structuredClone(options.manifest);
  const remote = await createMcpInvestigationTools({ ...options, runBinding: bound, responseLimit: 1048576 });
  const tools = {};
  for (const entry of manifest) {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(entry.name)) throw Error('investigation_mcp_source_contract_invalid');
    tools[entry.name] = {
      description: entry.description, parameters: structuredClone(entry.parameters),
      async execute(args, call = {}) {
        const signal = options.signal && call.signal ? AbortSignal.any([options.signal, call.signal]) : call.signal || options.signal;
        const check = async () => { signal?.throwIfAborted(); await options.authorize(signal); signal?.throwIfAborted(); };
        let envelope;
        try { envelope = await remote[entry.alias].execute(args, { signal }); }
        catch(error) {
          await check();
          const code=firstPartyToolFailureReason(error);
          if(code)throw Object.assign(new Error(code),{code});
          throw error;
        }
        await check();
        const response = envelope.result, output = response?.structuredContent, meta = response?._meta;
        if (envelope.status !== 'available' || output?.source !== entry.name
          || meta?.['mysc/authority_binding'] !== authorityBinding
          || meta?.['mysc/input_schema_sha256'] !== entry.remoteSchemaSha256
          || meta?.['mysc/payload_sha256'] !== candidateHash(output)
          || response.content.length !== 1 || response.content[0].type !== 'text'
          || response.content[0].text !== JSON.stringify(output)) {
          throw Error('investigation_mcp_source_response_invalid');
        }
        const original = validateInvestigationEvidence(cleanInvestigationJson(output), bound);
        await recordReceipt({ runBinding: structuredClone(bound), source: entry.name,
          evidenceId: original.evidence_id, payloadSha256: candidateHash(original),
          transportEvidence: envelope, signal });
        await check();
        return original;
      },
    };
  }
  return tools;
}
