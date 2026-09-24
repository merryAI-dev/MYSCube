import * as z from 'zod/v4';

export const REACT_PACKAGE_SET_ID = 'react18-tailwind4-v1';
export const MAX_WORKSPACE_BYTES = 180000;
export const MAX_WORKSPACE_FILES = 32;
export const MAX_REACT_DIAGNOSTICS = 50;
const bytes = (value) => new TextEncoder().encode(value).byteLength;

export const WorkspacePathSchema = z.string().max(160).regex(/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:ts|tsx)$/)
  .refine((path) => !path.split('/').some((part) => ['__proto__', 'prototype', 'constructor', 'node_modules'].includes(part)), '지원하지 않는 파일 경로입니다.');
export const ReactWorkspaceSchema = z.object({
  schemaVersion: z.literal(1),
  entry: WorkspacePathSchema,
  packageSetId: z.literal(REACT_PACKAGE_SET_ID),
  files: z.record(WorkspacePathSchema, z.string().max(MAX_WORKSPACE_BYTES)),
}).strict().superRefine((workspace, context) => {
  const paths = Object.keys(workspace.files);
  if (!paths.length || paths.length > MAX_WORKSPACE_FILES) context.addIssue({ code: 'custom', message: '파일은 1개부터 32개까지 사용할 수 있습니다.' });
  if (new Set(paths.map((path) => path.toLowerCase())).size !== paths.length) context.addIssue({ code: 'custom', message: '대소문자만 다른 파일 이름은 사용할 수 없습니다.' });
  if (!Object.hasOwn(workspace.files, workspace.entry)) context.addIssue({ code: 'custom', path: ['entry'], message: '시작 파일이 없습니다.' });
  if (paths.reduce((size, path) => size + bytes(path) + bytes(workspace.files[path]), 0) > MAX_WORKSPACE_BYTES) context.addIssue({ code: 'custom', message: '전체 파일 내용은 180KB 이내로 작성해 주세요.' });
});
const title = z.string().trim().min(1).max(80);
export const WorkspaceSourceSchema = z.object({ title, workspace: ReactWorkspaceSchema }).strict();
export const LegacyReactSourceSchema = z.object({ title, code: z.string().min(1).max(100000) }).strict();
export const ReactSourceSchema = z.union([WorkspaceSourceSchema, LegacyReactSourceSchema]);
export const ReactApiRefsSchema = z.array(z.object({ id: z.string().uuid(), version: z.number().int().positive() }).strict()).max(12)
  .refine((refs) => new Set(refs.map((item) => item.id)).size === refs.length);
export const ReactDiagnosticSchema = z.object({
  file: z.string(), line: z.number().int().positive(), column: z.number().int().positive(),
  code: z.union([z.number().int(), z.string()]), message: z.string(),
}).strict();

/** @param {z.infer<typeof ReactSourceSchema>} source */
export function normalizeReactSource(source) {
  const parsed = ReactSourceSchema.parse(source);
  if ('workspace' in parsed) return parsed;
  return WorkspaceSourceSchema.parse({ title: parsed.title, workspace: {
    schemaVersion: 1, entry: 'App.tsx', packageSetId: REACT_PACKAGE_SET_ID, files: { 'App.tsx': parsed.code },
  } });
}

/** @param {z.infer<typeof ReactWorkspaceSchema>} workspace */
export function canonicalWorkspace(workspace) {
  const parsed = ReactWorkspaceSchema.parse(workspace);
  return JSON.stringify({ schemaVersion: parsed.schemaVersion, entry: parsed.entry, packageSetId: parsed.packageSetId,
    files: Object.fromEntries(Object.keys(parsed.files).sort().map((path) => [path, parsed.files[path]])) });
}

/** Legacy identity must remain unchanged for immutable versions and outstanding receipts.
 * @param {z.infer<typeof ReactSourceSchema>} source */
export function reactSourceIdentity(source) {
  const parsed = ReactSourceSchema.parse(source);
  return 'workspace' in parsed ? canonicalWorkspace(parsed.workspace) : parsed.code;
}

/** @param {z.infer<typeof ReactSourceSchema>} source
 * @param {z.infer<typeof ReactApiRefsSchema>} apis */
export function editorIdentity(source, apis) {
  const normalized = normalizeReactSource(source);
  return JSON.stringify({ title: normalized.title, workspace: canonicalWorkspace(normalized.workspace),
    apis: ReactApiRefsSchema.parse(apis).slice().sort((a, b) => a.id.localeCompare(b.id)) });
}
