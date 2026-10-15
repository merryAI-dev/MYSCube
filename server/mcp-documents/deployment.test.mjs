import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCUMENT_SERVICE_FILES, stageDocumentService } from '../../scripts/stage-mcp-documents.mjs';

describe('document release isolation', () => {
  it('stages only renderer dependencies, not the full BFF or settlement application', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-documents-stage-test-'));
    try {
      const source = join(directory, 'source');
      await stageDocumentService(source);
      const files = (await readdir(source, { recursive: true })).filter((file) => file.endsWith('.mjs')).sort();
      expect(files).toEqual([...DOCUMENT_SERVICE_FILES, 'api/render.mjs', 'api/healthz.mjs'].sort());
      const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
      expect(Object.keys(manifest.dependencies).sort()).toEqual(['@napi-rs/canvas', 'pdfjs-dist']);
      const config = JSON.parse(await readFile(join(source, 'vercel.json'), 'utf8'));
      expect(config.crons).toBeUndefined();
      expect(config.rewrites).toHaveLength(2);
      expect(config.functions['api/*.mjs'].includeFiles).toContain('@napi-rs/canvas');
      expect(await readFile(join(source, 'api/render.mjs'), 'utf8')).toContain('../server/mcp-documents/service.mjs');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('uses green CI directly rather than waiting on a settlement deploy', async () => {
    const workflow = await readFile(new URL('../../.github/workflows/mcp-documents-deploy.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('workflows: [CI]');
    expect(workflow).not.toMatch(/workflow_dispatch|JVM|settlement|FIREBASE_SERVICE_ACCOUNT/u);
    expect(workflow).toContain('MCP_DOCUMENTS_PROJECT_ID');
    const worker = await readFile(new URL('../../.github/workflows/mcp-worker-deploy.yml', import.meta.url), 'utf8');
    expect(worker).toContain('MCP_DOCUMENTS_ACTIVE_ORIGIN');
  });
});
