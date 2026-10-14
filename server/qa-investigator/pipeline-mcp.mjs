import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { candidateHash } from '../qa-shared/candidate-integrity.mjs';
import { createInvestigationMcpSourceServer } from './mcp-source-server.mjs';
import { createMcpSourceInvestigationTools } from './mcp-source-tools.mjs';

// The worker and source owner share one authoritative instance; no network principal is impersonated.
export async function connectPipelineMcpSources({ pipeline, sources, signal }) {
  if (typeof pipeline?.recordMcpReceipt !== 'function') throw Error('investigation_mcp_pipeline_invalid');
  await pipeline.authorize();
  const authorityBinding = candidateHash({ runBinding: pipeline.runBinding, authority: pipeline.reviewAuthorityBinding() });
  const authorize = async () => {
    signal?.throwIfAborted();
    await pipeline.authorize();
    if (candidateHash({ runBinding: pipeline.runBinding, authority: pipeline.reviewAuthorityBinding() }) !== authorityBinding) {
      throw Error('investigation_mcp_authority_changed');
    }
    signal?.throwIfAborted();
    return authorityBinding;
  };
  const server = createInvestigationMcpSourceServer({ sources, authorityBinding, runBinding: pipeline.runBinding,
    authorize, signal, synchronizeEvidence: authorize });
  const client = new Client({ name: 'mysc-investigation-worker', version: '0.1.0' });
  const [workerTransport, sourceTransport] = InMemoryTransport.createLinkedPair();
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true; signal?.removeEventListener('abort', onAbort);
    await Promise.allSettled([client.close(), server.close()]);
  };
  const onAbort = () => { void close(); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    await authorize();
    await server.connect(sourceTransport); await client.connect(workerTransport);
    const manifest = Object.entries(sources.tools).map(([name, tool]) => ({
      name, alias: `mcp_${name}`, description: tool.description, parameters: tool.parameters,
      readOnly: true, remoteSchemaSha256: candidateHash(tool.parameters),
    }));
    const tools = await createMcpSourceInvestigationTools({ client, serverId: 'mysc-local-sources',
      manifest, runBinding: pipeline.runBinding, authorityBinding, authorize, signal,
      scopeRequest: async ({ arguments: args }) => ({ arguments: args, scopeSha256: authorityBinding }),
      validateResponse: async () => { await authorize(); return true; },
      recordReceipt: receipt => pipeline.recordMcpReceipt(receipt),
    });
    return { tools, close };
  } catch (error) { await close(); throw error; }
}
