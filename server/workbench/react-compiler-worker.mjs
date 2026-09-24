import { build } from 'esbuild';
import { compile } from '@tailwindcss/node';
import { REACT_DEPENDENCIES, REACT_PUBLIC_ENTRIES, REACT_RUNTIME_VERSION, reactCompilerBase, reactHash, reactPackageIdentity } from './react-compiler-packages.mjs';
import { normalizeReactSource, canonicalWorkspace, reactSourceIdentity } from '../../shared/workbench-react-workspace.mjs';
import { checkReactWorkspace, resolveWorkspaceImport, diagnosticError } from './react-typecheck.mjs';

let stdin = '';
for await (const chunk of process.stdin) { stdin += chunk; if (Buffer.byteLength(stdin) > 1000000) throw new Error('source_limit'); }
try {
  const { source, apis } = JSON.parse(stdin);
  const { workspace } = normalizeReactSource(source);
  const packageSetHash = await reactPackageIdentity();
  const { candidates, typecheck } = checkReactWorkspace(workspace, apis);
  const shims = { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOMClient', 'react/jsx-runtime': 'JSXRuntime' };
  const result = await build({ entryPoints: [`/workspace/${workspace.entry}`], bundle: true, format: 'iife', globalName: 'AXRCompiledApp', platform: 'browser', target: 'es2020', jsx: 'automatic', sourcemap: false, minify: false, write: false, logLevel: 'silent',
    plugins: [{ name: 'fixed-react-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => {
        if (Object.hasOwn(shims, args.path) && args.kind !== 'dynamic-import') return { path: args.path, namespace: 'fixed-react' };
        const path = args.kind === 'entry-point' && args.path === `/workspace/${workspace.entry}` ? args.path : resolveWorkspaceImport(args.path, args.importer, workspace.files);
        return path && args.kind !== 'dynamic-import' ? { path, namespace: 'workspace' } : { errors: [{ text: '작성한 파일과 등록된 React 패키지만 import할 수 있습니다.' }] };
      });
      builder.onLoad({ filter: /.*/, namespace: 'workspace' }, (args) => ({ contents: workspace.files[args.path.slice('/workspace/'.length)], loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixed-react' }, (args) => ({ contents: `module.exports = globalThis.AXRReactPackages.${shims[args.path]};`, loader: 'js' }));
    } }],
  });
  const bundle = result.outputFiles[0].text;
  if (Buffer.byteLength(bundle) > 240000) throw new Error('bundle_limit');
  const compiler = await compile('@import "tailwindcss";', { base: reactCompilerBase, onDependency: () => {} });
  const css = compiler.build([...candidates].sort());
  if (Buffer.byteLength(css) > 80000) throw new Error('style_limit');
  const normalized = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\\(?:\r\n|[\r\n\f])/g, '').replace(/\\([0-9a-f]{1,6})\s?|\\([^\r\n])/gi, (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
  if (/<\s*\/\s*style\b/i.test(css) || /@(?:import|font-face|namespace)\b|\b(?:url|image-set|-webkit-image-set|expression)\s*\(|-moz-binding\s*:/i.test(normalized)) throw new Error('style_network_forbidden');
  process.stdout.write(JSON.stringify({ ok: true, artifact: { bundle, css, sourceHash: reactHash(reactSourceIdentity(source)), workspaceHash: reactHash(canonicalWorkspace(workspace)), bundleHash: reactHash(bundle), cssHash: reactHash(css), runtimeVersion: REACT_RUNTIME_VERSION, packageSetHash, dependencies: REACT_DEPENDENCIES, typecheck } }));
} catch (error) {
  if (!error.details && error.errors?.length) error = diagnosticError('bundle', error.errors.slice(0, 50).map((item) => ({ file: String(item.location?.file || 'App.tsx').replace(/^workspace:\/workspace\//, ''), line: item.location?.line || 1, column: (item.location?.column || 0) + 1, code: 'ESBUILD', message: item.text.slice(0, 1200) })), error.errors.length > 50);
  process.stdout.write(JSON.stringify({ ok: false, message: error?.message || 'compile_failed', ...(error.details ? { details: error.details } : {}) }));
}
