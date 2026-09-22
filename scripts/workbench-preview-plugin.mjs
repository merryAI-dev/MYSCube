import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export function workbenchPreviewPlugin() {
  let artifact;
  return { name: 'workbench-preview-package',
    resolveId(id) { if (id === 'virtual:workbench-preview-package') return '\0workbench-preview-package'; },
    async load(id) {
      if (id !== '\0workbench-preview-package') return;
      if (!artifact) {
        const result = await build({ entryPoints: ['src/app/components/product-operations/preview/package.jsx'], bundle: true, write: false,
          format: 'iife', globalName: 'MYSCubePreview', platform: 'browser', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, target: 'es2020' });
        const source = result.outputFiles[0].text;
        const lock = await readFile('package-lock.json', 'utf8');
        const hash = createHash('sha256').update(lock).update(source).digest('hex');
        artifact = `export const packageHash=${JSON.stringify(hash)}; export const source=${JSON.stringify(source)};`;
      }
      return artifact;
    },
  };
}
