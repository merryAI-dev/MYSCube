import { execFileSync } from 'node:child_process';
import { globSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('isolated attachment PDF deployment package', () => {
  it('extracts text and renders without access to the workspace dependencies', async () => {
    const config = JSON.parse(await readFile(join(root, 'vercel.json'), 'utf8'));
    const pattern = config.functions['api/bff.js'].includeFiles;
    expect(pattern).toMatch(/^node_modules\//);
    const dependencies = await realpath(join(root, 'node_modules'));
    const directory = await mkdtemp(join(tmpdir(), 'myscube-pdf-package-'));
    try {
      for (const relative of globSync(pattern.slice('node_modules/'.length), { cwd: dependencies, withFileTypes: true })) {
        if (!relative.isFile()) continue;
        const source = join(relative.parentPath, relative.name);
        const target = join(directory, 'node_modules', source.slice(dependencies.length + 1));
        await mkdir(dirname(target), { recursive: true });
        await copyFile(source, target);
      }
      for (const name of ['pdf-text.mjs', 'test-pdf.fixture.mjs']) {
        await copyFile(join(root, 'server/bff', name), join(directory, name));
      }
      const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
        import {extractPdfPages, renderPdfPage} from './pdf-text.mjs';
        import {makePdf} from './test-pdf.fixture.mjs';
        const source = makePdf(['Contract delivery within 30 days']);
        const text = await extractPdfPages(source);
        const image = await renderPdfPage(source, {pageNumber: 1});
        console.log(JSON.stringify({pages: text.pages, pageCount: image.pageCount, jpeg: image.bytes.subarray(0, 2).toString('hex')}));
      `], { cwd: directory, encoding: 'utf8', timeout: 20000, env: { ...process.env, NODE_PATH: '' } });
      expect(JSON.parse(output.trim().split('\n').at(-1))).toEqual({
        pages: ['Contract delivery within 30 days'], pageCount: 1, jpeg: 'ffd8',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 30000);
});
