import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from './http-log-import-cli.mjs';

const env = { WORKBENCH_PROJECT_ID: 'demo-http-cli-copy', PRODUCTION_PROJECT_ID: 'demo-http-cli-prod', WORKBENCH_MODEL_PROJECT_ID: 'demo-http-cli-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-http-cli-prodmodel', WORKBENCH_HTTP_LOG_IMPORT_ENABLED: 'true' };
const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
describe('HTTP operator file boundary', () => {
  it('requires explicit flag before touching files or credentials', async () => {
    await expect(main(['--file', '/does-not-exist/private-name'], {})).rejects.toThrow('Import is disabled');
  });
  it('rejects oversized, non-wrapper NDJSON, and symbolic link inputs before any database connection', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'http-cli-test-')); folders.push(folder);
    const large = join(folder, 'large.json'), ndjson = join(folder, 'raw.ndjson'), link = join(folder, 'link.json');
    await writeFile(large, 'x'.repeat(1_000_001)); await writeFile(ndjson, '{}\n{}\n'); await symlink(ndjson, link);
    await expect(main(['--file', large], env)).rejects.toThrow('Invalid export file');
    await expect(main(['--file', ndjson], env)).rejects.toBeDefined();
    await expect(main(['--file', link], env)).rejects.toBeDefined();
    await expect(main(['--file', folder], env)).rejects.toBeDefined();
  });
  it('offers local usage without resolving cloud credentials or writing metadata', async () => {
    const output = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    await main(['--help'], {});
    expect(output).toHaveBeenCalledWith(expect.stringContaining('partial, unverified'));
  });
});
