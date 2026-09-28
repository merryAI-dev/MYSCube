import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { it, expect } from 'vitest';

it('loads the production BFF with native ESM export validation', () => {
  const result = execFileSync(process.execPath, ['--input-type=module', '-e',
    "await import('./server/bff/app.mjs'); console.log('bff-import-ok');"], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)), encoding: 'utf8', timeout: 15000,
  });
  expect(result).toContain('bff-import-ok');
}, 20000);
