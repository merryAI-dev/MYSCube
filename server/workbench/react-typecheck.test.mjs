import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileReactPreview } from './react-compiler.mjs';
import { canonicalWorkspace, reactSourceIdentity } from '../../shared/workbench-react-workspace.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const source = (files, entry = 'App.tsx') => ({ title: '여러 파일 검증', workspace: { schemaVersion: 1, entry, packageSetId: 'react18-tailwind4-v1', files } });
const simple = (code) => source({ 'App.tsx': code });
const files = {
  'App.tsx': "import React from 'react';import {Card} from './components/Card';import {amount} from './lib/amount';export default function App(){return <Card value={amount(2)}/>}",
  'components/Card.tsx': "import React from 'react';export function Card({value}:{value:number}){return <div className='p-4 bg-blue-500'>{value}</div>}",
  'lib/amount.ts': 'export const amount=(n:number):number=>n*3;',
};
const externalApi = { id: 'receipts-api', version: 2, definition: { kind: 'external-read', parameters: {
  period: { type: 'string', required: true, enum: ['2026-09', '2026-10'] }, limit: { type: 'integer', required: false },
} }, responseKind: 'external-read', responseSchema: { type: 'object', additionalProperties: false, required: ['amount', 'rows'], properties: {
  amount: { type: 'string', nullable: true, maxLength: 30 }, rows: { type: 'array', maxItems: 10, items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', maxLength: 30 } } } },
} } };
const apiCode = (body) => `import React from 'react';async function load(){${body}}export default function App(){return <button onClick={()=>void load()}>조회</button>}`;
async function expectDiagnostic(value, { apis, stage = 'type', file = 'App.tsx', code } = {}) {
  let error; try { await compileReactPreview(value, { apis }); } catch (reason) { error = reason; }
  expect(error).toMatchObject({ code: 'react_compile_failed', details: { stage, diagnostics: expect.any(Array) } });
  expect(error.details.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ file, ...(code ? { code } : {}), line: expect.any(Number), column: expect.any(Number), message: expect.any(String) })]));
  expect(error.details.diagnostics.every((item) => item.line > 0 && item.column > 0)).toBe(true);
  return error;
}

describe('real TypeScript semantic checks over the bounded React workspace', () => {
  it('checks and bundles three relative files and retains deterministic source tree identities', async () => {
    const input = source(files); const result = await compileReactPreview(input);
    expect(result.typecheck).toMatchObject({ status: 'passed', typescriptVersion: '5.9.3' });
    expect(result.bundle).toContain('amount'); expect(result.bundle).toContain('Card'); expect(result.css).toContain('.p-4');
    expect(result.sourceHash).toBe(hash(reactSourceIdentity(input))); expect(result.workspaceHash).toBe(hash(canonicalWorkspace(input.workspace)));
    const reordered = source(Object.fromEntries(Object.entries(files).reverse()));
    const again = await compileReactPreview(reordered); expect(again.sourceHash).toBe(result.sourceHash); expect(again.bundleHash).toBe(result.bundleHash);
  });
  it('retains legacy source identity while adding the canonical workspace hash', async () => {
    const legacy = { title: '이전 저장 소스', code: 'export default function App(){return <p>안내</p>}' };
    const result = await compileReactPreview(legacy);
    expect(result.sourceHash).toBe(hash(legacy.code)); expect(result.workspaceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it('returns actual file, line, column and TS diagnostic code for cross-file props errors', async () => {
    await expectDiagnostic(source({ ...files, 'App.tsx': files['App.tsx'].replace('amount(2)', "'wrong'") }), { code: 2322 });
  });
  it('does not confuse successful transpilation with valid TypeScript assignment', async () => {
    const error = await expectDiagnostic(simple('const value:number="text";\nexport default function App(){return <div>{value}</div>}'), { code: 2322 });
    expect(error.details.diagnostics[0]).toMatchObject({ line: 1, column: 7 });
  });
  it.each([
    'export default 42;',
    'export const App=()=> <div/>;',
    'export default function App({name}:{name:string}){return <div>{name}</div>}',
    'const App:any=42;export default App;',
  ])('requires a typed zero-required-prop React default component: %s', async (code) => {
    await expectDiagnostic(simple(code));
  });
  it('checks files outside the entry import graph too', async () => {
    await expectDiagnostic(source({ ...files, 'unused.ts': 'export const bad:boolean=3;' }), { file: 'unused.ts', code: 2322 });
  });
  it('does not execute source while type checking and bundling', async () => {
    const result = await compileReactPreview(simple('throw new Error("do-not-run");while(true){}export default function App(){return <p/>}'));
    expect(result.bundle).toContain('do-not-run');
  });
  it('rejects a deleted helper rather than using the host filesystem', async () => {
    const { 'lib/amount.ts': _removed, ...remaining } = files;
    await expectDiagnostic(source(remaining), { stage: 'policy', code: 'AXR_IMPORT_DENIED' });
  });
  it.each([
    "import x from '../server/private';export default ()=> <div>{x}</div>",
    "import x from '/etc/passwd';export default ()=> <div>{x}</div>",
    "import type {Stats} from 'node:fs';export default ()=> <div/>",
    "import type {X} from 'https://bad.invalid/x';export default ()=> <div/>",
    "declare global {interface Window {secret:any}};export default ()=> <div/>",
    "declare module 'react' {};export default ()=> <div/>",
    "declare const injected:number;export default ()=> <div/>",
    '/// <reference path="/etc/passwd" />\nexport default ()=> <div/>',
    '/// <reference types="node" />\nexport default ()=> <div/>',
    '// @ts-ignore\nconst bad:number="text";export default ()=> <div/>',
    '// @ts-nocheck\nconst bad:number="text";export default ()=> <div/>',
    '// @ts-expect-error\nconst bad:number="text";export default ()=> <div/>',
    "export default ()=>{import('react');return <div/>}",
  ])('rejects VFS escapes and type-check bypasses: %s', async (code) => {
    await expectDiagnostic(simple(code), { stage: 'policy' });
  });
  it('allows relative parent imports only inside the declared workspace', async () => {
    const result = await compileReactPreview(source({
      'pages/App.tsx': "import {value} from '../lib/value';export default ()=> <p>{value}</p>",
      'lib/value.ts': 'export const value=0;',
    }, 'pages/App.tsx'));
    expect(result.typecheck.status).toBe('passed');
  });
});

describe('registered API request and response type contracts', () => {
  it('accepts actual and flattened API records with the same types', async () => {
    const input = simple(apiCode("const result=await window.workbench.callApi('receipts-api',{period:'2026-09',limit:0});const name:string=result.data.rows[0].name;const amount:string|null=result.data.amount;"));
    const actual = await compileReactPreview(input, { apis: [externalApi] });
    const flattened = await compileReactPreview(input, { apis: [{ id: externalApi.id, version: externalApi.version, ...externalApi.definition, responseKind: externalApi.responseKind, responseSchema: externalApi.responseSchema }] });
    expect(actual.typecheck.declarationHash).toBe(flattened.typecheck.declarationHash);
  });
  it.each([
    "await window.workbench.callApi('unknown-api',{period:'2026-09'});",
    "await window.workbench.callApi('receipts-api',{});",
    "await window.workbench.callApi('receipts-api',{period:2026});",
    "await window.workbench.callApi('receipts-api',{period:'2026-08'});",
    "await window.workbench.callApi('receipts-api',{period:'2026-09',limit:'2'});",
    "const input={period:'2026-09' as const,extra:true};await window.workbench.callApi('receipts-api',input);",
    "const result=await window.workbench.callApi('receipts-api',{period:'2026-09'});const amount:number=result.data.amount;",
    "const result=await window.workbench.callApi('receipts-api',{period:'2026-09'});result.data.missing;",
  ])('reports actual API contract mismatches: %s', async (body) => {
    await expectDiagnostic(simple(apiCode(body)), { apis: [externalApi] });
  });
  it('does not authorize arbitrary API IDs when no API is registered', async () => {
    await expectDiagnostic(simple(apiCode("await window.workbench.callApi('receipts-api',{});")));
  });
  it('keeps unknown analytics row fields unknown instead of asserting a financial type', async () => {
    const apis = [{ id: 'analytics', version: 1, kind: 'analytics-copy', parameters: {} }];
    await expectDiagnostic(simple(apiCode("const result=await window.workbench.callApi('analytics',{});const amount:number=result.rows[0].amount;")), { apis });
    const result = await compileReactPreview(simple(apiCode("const result=await window.workbench.callApi('analytics',{});const value=result.rows[0].amount;if(typeof value==='number'){const amount:number=value;}")), { apis });
    expect(result.typecheck.status).toBe('passed');
  });
});
