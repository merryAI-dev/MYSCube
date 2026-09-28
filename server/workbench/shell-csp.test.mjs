import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { workbenchShellCsp } from './shell-csp.mjs';

const directives = policy => Object.fromEntries(policy.split(';').map(value => value.trim().split(/\s+/)).filter(parts => parts[0]).map(([key, ...values]) => [key, values]));
describe('trusted Workbench shell Firebase popup policy', () => {
  it('adds only the Firebase gapi script origin while preserving all other script restrictions', () => {
    const policy = directives(workbenchShellCsp());
    expect(policy['script-src']).toEqual(["'self'", 'https://apis.google.com']);
    expect(policy['script-src']).not.toContain("'unsafe-inline'"); expect(policy['script-src']).not.toContain("'unsafe-eval'");
    expect(policy['connect-src']).toEqual(["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com']);
    expect(policy['frame-src']).toEqual(["'self'", 'https://*.firebaseapp.com']);
    expect(policy['default-src']).toEqual(["'self'"]); expect(policy['object-src']).toEqual(["'none'"]);
    expect(policy['base-uri']).toEqual(["'none'"]); expect(policy['form-action']).toEqual(["'none'"]); expect(policy['frame-ancestors']).toEqual(["'none'"]);
  });
  it('preserves a separately validated preview origin only in the existing frame directive', () => {
    const policy = directives(workbenchShellCsp({ reactRuntimeOrigin: 'https://preview.example.invalid' }));
    expect(policy['frame-src']).toEqual(["'self'", 'https://*.firebaseapp.com', 'https://preview.example.invalid']);
    expect(policy['script-src']).toEqual(["'self'", 'https://apis.google.com']);
    for (const value of ['https://preview.example.invalid/path', 'https://preview.example.invalid; script-src *', 'javascript:alert(1)']) expect(() => workbenchShellCsp({ reactRuntimeOrigin: value })).toThrow();
  });
  it('is wired to the actual standalone server header without changing generated runtime policies', async () => {
    const server = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
    expect(server).toContain("import { workbenchShellCsp } from './shell-csp.mjs'");
    expect(server).toContain("res.setHeader('Content-Security-Policy', workbenchShellCsp({ reactRuntimeOrigin: reactRuntime?.origin || '' }))");
    for (const path of ['./remote-runtime/worker.mjs', './react-compiler-runtime.mjs']) {
      const runtime = await readFile(new URL(path, import.meta.url), 'utf8');
      expect(runtime).not.toContain('https://apis.google.com'); expect(runtime).toContain("connect-src 'none'");
    }
  });
});
