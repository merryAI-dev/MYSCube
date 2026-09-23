import { build } from 'esbuild';
import ts from 'typescript';
import { compile } from '@tailwindcss/node';
import { REACT_DEPENDENCIES, REACT_PUBLIC_ENTRIES, REACT_RUNTIME_VERSION, reactCompilerBase, reactHash, reactPackageIdentity } from './react-compiler-packages.mjs';

const MAX_CODE = 160000;
let stdin = '';
for await (const chunk of process.stdin) { stdin += chunk; if (Buffer.byteLength(stdin) > 210000) throw new Error('source_limit'); }
try {
  const { code } = JSON.parse(stdin);
  if (typeof code !== 'string' || code.length > MAX_CODE) throw new Error('source_limit');
  const packageSetHash = await reactPackageIdentity();
  const source = ts.createSourceFile('App.tsx', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const pending = [{ node: source, depth: 0 }]; const candidates = new Set(); let count = 0;
  while (pending.length) {
    const { node, depth } = pending.pop();
    if (++count > 20000 || depth > 100) throw new Error('source_complexity');
    if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require'))) throw new Error('dynamic_import_forbidden');
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && (!ts.isStringLiteral(node.moduleSpecifier) || !REACT_PUBLIC_ENTRIES.includes(node.moduleSpecifier.text))) throw new Error('unregistered_import');
    if (ts.isImportTypeNode(node) && (!ts.isLiteralTypeNode(node.argument) || !ts.isStringLiteral(node.argument.literal) || !REACT_PUBLIC_ENTRIES.includes(node.argument.literal.text))) throw new Error('unregistered_import');
    if (ts.isStringLiteralLike(node)) for (const candidate of node.text.split(/\s+/).filter(Boolean)) {
      if (candidate.length > 512 || candidates.size >= 1500 && !candidates.has(candidate)) throw new Error('style_limit');
      candidates.add(candidate);
    }
    ts.forEachChild(node, (child) => { pending.push({ node: child, depth: depth + 1 }); });
  }
  const shims = { react: 'React', 'react-dom': 'ReactDOM', 'react-dom/client': 'ReactDOMClient', 'react/jsx-runtime': 'JSXRuntime' };
  const result = await build({ stdin: { contents: code, sourcefile: 'App.tsx', loader: 'tsx', resolveDir: reactCompilerBase }, bundle: true, format: 'iife', globalName: 'AXRCompiledApp', platform: 'browser', target: 'es2020', jsx: 'automatic', sourcemap: false, minify: false, write: false, logLevel: 'silent',
    plugins: [{ name: 'fixed-react-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, (args) => Object.hasOwn(shims, args.path) && args.kind !== 'dynamic-import'
        ? { path: args.path, namespace: 'fixed-react' } : { errors: [{ text: '등록된 React 패키지만 import할 수 있습니다.' }] });
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
  process.stdout.write(JSON.stringify({ ok: true, artifact: { bundle, css, sourceHash: reactHash(code), bundleHash: reactHash(bundle), cssHash: reactHash(css), runtimeVersion: REACT_RUNTIME_VERSION, packageSetHash, dependencies: REACT_DEPENDENCIES } }));
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, message: error?.errors?.[0]?.text || error?.message || 'compile_failed' }));
}
