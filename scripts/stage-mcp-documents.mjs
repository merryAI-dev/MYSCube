import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DOCUMENT_SERVICE_FILES = [
  'server/mcp-documents/service.mjs',
  'server/bff/attachment-text.mjs',
  'server/bff/pdf-text.mjs',
  'server/bff/test-pdf.fixture.mjs',
  'mcp-worker/src/review/attachment-route.mjs',
];

export async function stageDocumentService(destination, root = fileURLToPath(new URL('../', import.meta.url))) {
  const mapping = [
    ...DOCUMENT_SERVICE_FILES.map((path) => [path, path]),
    ...['package.json', 'package-lock.json', 'vercel.json', 'api/render.mjs', 'api/healthz.mjs'].map((path) => [`server/mcp-documents/${path}`, path]),
  ];
  await mkdir(destination, { recursive: false });
  for (const [source, target] of mapping) {
    const output = resolve(destination, target);
    await mkdir(dirname(output), { recursive: true });
    await copyFile(resolve(root, source), output);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('A new staging directory is required');
  await stageDocumentService(resolve(process.argv[2]));
}
