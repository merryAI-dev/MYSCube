import ts from 'typescript';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { REACT_PUBLIC_ENTRIES, reactHash } from './react-compiler-packages.mjs';

const require = createRequire(import.meta.url);
const ROOT = '/workspace/';
const TYPE_VERSIONS = Object.freeze({ typescript: '5.9.3', '@types/react': '18.3.28', '@types/react-dom': '18.3.7', csstype: '3.2.3', '@types/prop-types': '15.7.15' });
const packagePaths = { react: '/types/react/index.d.ts', 'react/jsx-runtime': '/types/react/jsx-runtime.d.ts', 'react-dom': '/types/react-dom/index.d.ts', 'react-dom/client': '/types/react-dom/client.d.ts', csstype: '/types/csstype/index.d.ts', 'prop-types': '/types/prop-types/index.d.ts' };
const quote = (value) => JSON.stringify(value);
const record = (value) => value && typeof value === 'object' && !Array.isArray(value);
const problem = (file, node, code, message) => {
  const point = file.getLineAndCharacterOfPosition(node?.getStart(file) || 0);
  return { file: file.fileName.replace(ROOT, ''), line: point.line + 1, column: point.character + 1, code, message };
};
export function diagnosticError(stage, diagnostics, truncated = false) {
  return Object.assign(new Error(diagnostics[0]?.message || 'React 소스 검사를 완료하지 못했습니다.'), { details: { stage, diagnostics, truncated } });
}

export function resolveWorkspaceImport(specifier, importer, files) {
  if (!/^\.\.?\//.test(specifier) || /[\\\0?#]/.test(specifier)) return null;
  const target = posix.normalize(posix.join(posix.dirname(importer), specifier));
  if (!target.startsWith(ROOT)) return null;
  return [target, `${target}.ts`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.tsx`].find((name) => Object.hasOwn(files, name.slice(ROOT.length))) || null;
}

export function inspectReactWorkspace(workspace) {
  const sources = new Map(); const candidates = new Set(); let count = 0;
  for (const [path, code] of Object.entries(workspace.files)) {
    const source = ts.createSourceFile(`${ROOT}${path}`, code, ts.ScriptTarget.ES2020, true, path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    sources.set(source.fileName, source);
    const deny = (node, id, message) => { throw diagnosticError('policy', [problem(source, node, id, message)]); };
    if (!ts.isExternalModule(source)) deny(source, 'AXR_MODULE_REQUIRED', '각 파일은 import 또는 export가 있는 모듈이어야 합니다.');
    if (source.referencedFiles.length || source.typeReferenceDirectives.length || source.libReferenceDirectives.length || source.hasNoDefaultLib) deny(source, 'AXR_REFERENCE_DENIED', '삼중 슬래시 타입·파일 참조는 사용할 수 없습니다.');
    const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, source.languageVariant, code);
    for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
      if ([ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia].includes(token) && /@ts-(?:ignore|nocheck|expect-error)\b/.test(scanner.getTokenText())) deny(source, 'AXR_TYPE_BYPASS_DENIED', '타입 오류를 숨기는 주석은 사용할 수 없습니다. 실제 오류를 수정해 주세요.');
    }
    const pending = [{ node: source, depth: 0 }];
    while (pending.length) {
      const { node, depth } = pending.pop();
      if (++count > 20000 || depth > 100) deny(node, 'AXR_SOURCE_COMPLEXITY', '소스 구성이 검사 한도를 넘었습니다. 파일 구성을 단순하게 나누어 주세요.');
      if (ts.isModuleDeclaration(node) || ts.getModifiers(node)?.some((item) => item.kind === ts.SyntaxKind.DeclareKeyword)) deny(node, 'AXR_AMBIENT_DENIED', '사용자 소스에서 전역·외부 모듈 타입을 다시 선언할 수 없습니다.');
      if (ts.isImportEqualsDeclaration(node) || (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || ts.isIdentifier(node.expression) && node.expression.text === 'require'))) deny(node, 'AXR_DYNAMIC_IMPORT_DENIED', '동적 import와 require는 사용할 수 없습니다.');
      let imported;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) imported = ts.isStringLiteral(node.moduleSpecifier) ? node.moduleSpecifier.text : '';
      if (ts.isImportTypeNode(node)) imported = ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal) ? node.argument.literal.text : '';
      if (imported !== undefined && !REACT_PUBLIC_ENTRIES.includes(imported) && !resolveWorkspaceImport(imported, source.fileName, workspace.files)) deny(node, 'AXR_IMPORT_DENIED', `등록되지 않았거나 찾을 수 없는 import입니다: ${String(imported).slice(0, 160)}`);
      if (ts.isStringLiteralLike(node)) for (const candidate of node.text.split(/\s+/).filter(Boolean)) {
        if (candidate.length > 512 || candidates.size >= 1500 && !candidates.has(candidate)) deny(node, 'AXR_STYLE_LIMIT', '스타일 구성이 검사 한도를 넘었습니다.');
        candidates.add(candidate);
      }
      ts.forEachChild(node, (child) => { pending.push({ node: child, depth: depth + 1 }); });
    }
  }
  return { sources, candidates };
}

function schemaType(schema, depth = 0, budget = { nodes: 0 }) {
  if (!record(schema) || ++budget.nodes > 150 || depth > 8) throw new Error('api_type_schema_invalid');
  let type;
  if (schema.type === 'object' && record(schema.properties)) {
    type = `{${Object.entries(schema.properties).map(([key, item]) => `${quote(key)}${schema.required?.includes(key) ? '' : '?'}:${schemaType(item, depth + 1, budget)}`).join(';')}}`;
  } else if (schema.type === 'array') type = `Array<${schemaType(schema.items, depth + 1, budget)}>`;
  else if (['string', 'number', 'integer', 'boolean', 'null'].includes(schema.type)) type = schema.type === 'integer' ? 'number' : schema.type;
  else throw new Error('api_type_schema_invalid');
  if (schema.enum) {
    if (!Array.isArray(schema.enum) || !schema.enum.length || schema.enum.length > 100 || schema.enum.some((value) => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) throw new Error('api_type_schema_invalid');
    type = schema.enum.map(quote).join('|');
  }
  return schema.nullable === true ? `(${type})|null` : type;
}

export function reactApiDeclarations(apis = []) {
  if (!Array.isArray(apis) || apis.length > 12 || Buffer.byteLength(JSON.stringify(apis)) > 256000) throw new Error('api_type_schema_invalid');
  const ids = new Set(); const definitions = [];
  for (const api of apis) {
    const definition = api.definition || api;
    if (typeof api.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(api.id) || ids.has(api.id) || !Number.isSafeInteger(api.version) || api.version < 1 || !record(definition.parameters)) throw new Error('api_type_schema_invalid');
    ids.add(api.id);
    const inputs = Object.entries(definition.parameters);
    if (inputs.length > 12) throw new Error('api_type_schema_invalid');
    const inputType = `{${inputs.map(([name, parameter]) => {
      if (!/^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) || !['string', 'integer', 'number', 'boolean'].includes(parameter.type)) throw new Error('api_type_schema_invalid');
      return `${quote(name)}${parameter.required === false ? '?' : ''}:${schemaType(parameter)}`;
    }).join(';')}}`;
    const kind = api.responseKind || definition.kind;
    const outputType = kind === 'external-read'
      ? `{apiId:string;apiVersion:number;data:${schemaType(api.responseSchema)};metadata:{source:string;endpointId:string;endpointVersion:number;asOf:string;resultScope:string};truncated:boolean}`
      : kind === 'analytics-copy' ? 'AXRAnalyticsResult' : null;
    if (!outputType) throw new Error('api_type_schema_invalid');
    definitions.push(`${quote(api.id)}:{input:${inputType};output:${outputType}}`);
  }
  return `export {};
type AXRJson = null|boolean|number|string|AXRJson[]|{[key:string]:AXRJson};
interface AXRAnalyticsResult {evidenceId:string;columns:Array<{name:string;type:string;label?:string}>;rows:Array<Record<string,unknown>>;metadata:{provenance:string;asOf:string;capturedAt:string;completeness:string;resultScope?:string;[key:string]:unknown};semantic?:{definitionVersions:unknown;[key:string]:unknown};coverage:unknown;truncated:boolean;[key:string]:unknown}
interface AXRApiMap {${definitions.join(';')}}
declare global {interface Window {readonly workbench:{callApi<K extends keyof AXRApiMap,P extends AXRApiMap[K]['input']>(apiId:K,input:P & Record<Exclude<keyof P,keyof AXRApiMap[K]['input']>,never>):Promise<AXRApiMap[K]['output']>}}}
`;
}

function fixedTypeFiles() {
  const files = new Map(); const dependencies = [];
  for (const [name, version] of Object.entries(TYPE_VERSIONS)) {
    const packageFile = require.resolve(`${name}/package.json`);
    if (JSON.parse(readFileSync(packageFile, 'utf8')).version !== version) throw new Error('type_package_version_mismatch');
    dependencies.push({ name, version });
    const directory = dirname(packageFile);
    if (name === 'typescript') {
      for (const file of readdirSync(join(directory, 'lib'))) if (/^lib\.[a-z0-9.]+\.d\.ts$/.test(file)) files.set(`/lib/${file}`, readFileSync(join(directory, 'lib', file), 'utf8'));
    } else {
      const relative = name.replace('@types/', '');
      for (const file of name === '@types/react' ? ['index.d.ts', 'global.d.ts', 'jsx-runtime.d.ts'] : name === '@types/react-dom' ? ['index.d.ts', 'client.d.ts'] : ['index.d.ts']) files.set(`/types/${relative}/${file}`, readFileSync(join(directory, file), 'utf8'));
    }
  }
  return { files, dependencies };
}

export function checkReactWorkspace(workspace, apis, inspected = inspectReactWorkspace(workspace)) {
  const { files, dependencies } = fixedTypeFiles();
  for (const [path, source] of inspected.sources) files.set(path, source.text);
  files.set('/bridge.d.ts', reactApiDeclarations(apis));
  files.set('/entry-check.tsx', `import React from 'react';import App from './workspace/${workspace.entry}';const component:React.ComponentType<Record<string, never>>=App;export default component;`);
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.ReactJSX,
    types: [], lib: ['lib.es2020.d.ts', 'lib.dom.d.ts', 'lib.dom.iterable.d.ts'], allowSyntheticDefaultImports: true, esModuleInterop: true, allowImportingTsExtensions: true, forceConsistentCasingInFileNames: true };
  const resolveModule = (specifier, importer) => {
    if (REACT_PUBLIC_ENTRIES.includes(specifier) || !importer.startsWith(ROOT) && Object.hasOwn(packagePaths, specifier)) return packagePaths[specifier];
    if (importer === '/entry-check.tsx' && specifier === `./workspace/${workspace.entry}`) return `${ROOT}${workspace.entry}`;
    if (importer.startsWith(ROOT)) return resolveWorkspaceImport(specifier, importer, workspace.files);
    if (/^\.\.?\//.test(specifier)) {
      const base = posix.join(posix.dirname(importer), specifier);
      return [base, `${base}.d.ts`, posix.join(base, 'index.d.ts')].find((path) => files.has(path));
    }
    return undefined;
  };
  const host = { getSourceFile: (name, languageVersion) => files.has(name) ? inspected.sources.get(name) || ts.createSourceFile(name, files.get(name), languageVersion, true) : undefined,
    getDefaultLibFileName: () => '/lib/lib.es2020.d.ts', getDefaultLibLocation: () => '/lib', writeFile: () => { throw new Error('type_emit_forbidden'); }, getCurrentDirectory: () => '/',
    getDirectories: () => [], fileExists: (name) => files.has(name), readFile: (name) => files.get(name), getCanonicalFileName: (name) => name, useCaseSensitiveFileNames: () => true, getNewLine: () => '\n',
    resolveModuleNames: (names, importer) => names.map((name) => { const path = resolveModule(name, importer); return path ? { resolvedFileName: path, extension: path.endsWith('.d.ts') ? ts.Extension.Dts : path.endsWith('.tsx') ? ts.Extension.Tsx : ts.Extension.Ts, isExternalLibraryImport: path.startsWith('/types/') } : undefined; }) };
  const program = ts.createProgram({ rootNames: [...inspected.sources.keys(), '/bridge.d.ts', '/entry-check.tsx'], options, host });
  const diagnostics = [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...program.getSyntacticDiagnostics(), ...program.getSemanticDiagnostics()].filter((item) => item.category === ts.DiagnosticCategory.Error);
  const mapped = diagnostics.slice(0, 50).map((item) => {
    const location = item.file?.getLineAndCharacterOfPosition(item.start || 0);
    return { file: item.file?.fileName?.startsWith(ROOT) ? item.file.fileName.slice(ROOT.length) : workspace.entry, line: item.file?.fileName?.startsWith(ROOT) ? (location?.line || 0) + 1 : 1,
      column: item.file?.fileName?.startsWith(ROOT) ? (location?.character || 0) + 1 : 1, code: item.code, message: ts.flattenDiagnosticMessageText(item.messageText, '\n').replaceAll(ROOT, '').slice(0, 1200) };
  });
  if (mapped.length) throw diagnosticError('type', mapped, diagnostics.length > mapped.length);
  const entry = program.getSourceFile(`${ROOT}${workspace.entry}`), checker = program.getTypeChecker();
  const exported = entry && checker.getSymbolAtLocation(entry) && checker.getExportsOfModule(checker.getSymbolAtLocation(entry)).find((item) => item.name === 'default');
  if (!exported || checker.getTypeOfSymbolAtLocation(exported, entry).flags & ts.TypeFlags.Any) throw diagnosticError('type', [{ file: workspace.entry, line: 1, column: 1, code: 'AXR_DEFAULT_COMPONENT', message: '시작 파일은 타입이 확인되는 React 컴포넌트를 default export해야 합니다.' }]);
  return { ...inspected, typecheck: { status: 'passed', typescriptVersion: ts.version, dependencies, declarationHash: reactHash(files.get('/bridge.d.ts')) } };
}
