import { describe, expect, it } from 'vitest';
import { generateReactPage, parseReactGenerationSource, ReactGenerationSourceSchema, reactSourceHash } from './react-pages.mjs';
import { WorkspaceSourceSchema } from '../../shared/workbench-react-workspace.mjs';
import * as z from 'zod/v4';

const files = [{ path: 'App.tsx', content: "import {format} from './lib/format';export default function App(){return <main>{format(2)}</main>}" },
  { path: 'lib/format.ts', content: 'export const format=(n:number)=>String(n);' }];
const wire = (entries = files) => ({ title: '정확한 파일', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: 'react18-tailwind4-v1', files: entries } });
describe('React generation wire files are explicit values, with unchanged canonical storage', () => {
  it('declares bounded path/content items and converts exact names and source bytes without changing canonical identity', async () => {
    const schema = z.toJSONSchema(ReactGenerationSourceSchema);
    expect(schema.properties.workspace.properties.files).toMatchObject({ type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', required: ['path', 'content'], additionalProperties: false } });
    const expected = { ...wire(), workspace: { ...wire().workspace, files: Object.fromEntries(files.map(({ path, content }) => [path, content])) } };
    expect(parseReactGenerationSource(wire())).toEqual({ ...expected, editBaseline: 'editor', removedFiles: [] });
    const result = await generateReactPage({ prompt: '기존 파일 그대로 확인', currentSource: expected, complete: async () => ({ tool_calls: [{ function: { name: 'render_react_source', arguments: JSON.stringify(wire()) } }] }), apis: [], authorize: async () => {}, signal: AbortSignal.timeout(10000) });
    expect(result.source).toEqual(expected);
    expect(WorkspaceSourceSchema.parse(result.source)).toEqual(expected);
    expect(result.artifact.sourceHash).toBe(reactSourceHash(expected));
    expect(result.artifact.workspaceHash).toBe(reactSourceHash(expected));
    expect(result.artifact.typecheck.status).toBe('passed');
  });
  it.each([
    ['empty', []], ['missing entry', files.slice(1)], ['duplicate', [...files, files[0]]],
    ['case collision', [...files, { path: 'app.tsx', content: 'duplicate' }]],
    ['too many', Array.from({ length: 33 }, (_, i) => ({ path: i ? `f${i}.ts` : 'App.tsx', content: '' }))],
    ['total bytes', [{ path: 'App.tsx', content: '한'.repeat(60000) }]],
    ['per-file limit', [{ path: 'App.tsx', content: 'x'.repeat(180001) }]],
    ['parent escape', [{ path: '../App.tsx', content: '' }]],
    ['absolute', [{ path: '/App.tsx', content: '' }]],
    ['prototype segment', [{ path: '__proto__/App.tsx', content: '' }]],
    ['invented minified alias', [{ path: 'minified_App_tsx', content: '' }]],
    ['extension dropped', [{ path: 'App', content: '' }]],
    ['unknown item field', [{ path: 'App.tsx', content: '', filename: 'App.tsx' }]],
  ])('rejects %s without renaming, filling, or silently discarding a file', (_name, entries) => {
    expect(() => parseReactGenerationSource(wire(entries))).toThrow();
  });
  it('rejects the old map as model output while retaining it as the persisted source contract', () => {
    const canonical = { ...wire(), workspace: { ...wire().workspace, files: Object.fromEntries(files.map(({ path, content }) => [path, content])) } };
    expect(WorkspaceSourceSchema.safeParse(canonical).success).toBe(true);
    expect(() => parseReactGenerationSource(canonical)).toThrow();
    expect(() => parseReactGenerationSource({ title: 'old output', code: 'export default function App(){return null}' })).toThrow();
  });
});
