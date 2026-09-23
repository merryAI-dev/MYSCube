import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export const REACT_RUNTIME_VERSION = 'react-preview-v1';
export const REACT_DEPENDENCIES = Object.freeze([{ name: 'react', version: '18.3.1' }, { name: 'react-dom', version: '18.3.1' }, { name: 'esbuild', version: '0.25.12' }, { name: 'tailwindcss', version: '4.1.12' }, { name: '@tailwindcss/node', version: '4.1.12' }]);
export const REACT_PUBLIC_ENTRIES = Object.freeze(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime']);
export const reactHash = (value) => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
export const reactCompilerBase = fileURLToPath(new URL('../../', import.meta.url));
let packagePromise;

export async function reactPackageIdentity() {
  for (const dependency of REACT_DEPENDENCIES) {
    const manifestPath = dependency.name === '@tailwindcss/node' ? resolve(dirname(require.resolve(dependency.name)), '../package.json') : require.resolve(`${dependency.name}/package.json`);
    const actual = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (actual.version !== dependency.version) throw new Error(`React 미리보기의 ${dependency.name} 버전이 고정된 실행 환경과 다릅니다.`);
  }
  const lockHash = reactHash(await readFile(new URL('../../package-lock.json', import.meta.url)));
  return reactHash(JSON.stringify({ lockHash, entries: REACT_PUBLIC_ENTRIES, dependencies: REACT_DEPENDENCIES, runtimeVersion: REACT_RUNTIME_VERSION, target: 'es2020-production' }));
}

export function getReactPackageSet() {
  if (!packagePromise) packagePromise = (async () => {
    const packageSetHash = await reactPackageIdentity();
    const { build } = await import('esbuild');
    const result = await build({ stdin: { contents: "import React from 'react'; import * as ReactDOM from 'react-dom'; import * as ReactDOMClient from 'react-dom/client'; import * as JSXRuntime from 'react/jsx-runtime'; export { React, ReactDOM, ReactDOMClient, JSXRuntime };", resolveDir: reactCompilerBase, sourcefile: 'react-packages.js' }, bundle: true, format: 'iife', globalName: 'AXRReactPackages', platform: 'browser', target: 'es2020', minify: true, define: { 'process.env.NODE_ENV': '"production"' }, write: false, sourcemap: false, logLevel: 'silent' });
    const bundle = result.outputFiles[0].text;
    return { packageSetHash, bundle, bundleHash: reactHash(bundle), runtimeVersion: REACT_RUNTIME_VERSION, dependencies: REACT_DEPENDENCIES };
  })().catch((error) => { packagePromise = null; throw error; });
  return packagePromise;
}
