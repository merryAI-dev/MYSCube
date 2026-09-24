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

export const REACT_ARTIFACT_SCHEMA_VERSION = 1;
export const REACT_REVISION_SCHEMA_VERSION = 1;
export const REACT_RUNTIME_VERSION = 'react-preview-v1';
export const REACT_BUILD_DEPENDENCIES = Object.freeze([
  { name: 'react', version: '18.3.1' }, { name: 'react-dom', version: '18.3.1' },
  { name: 'esbuild', version: '0.25.12' }, { name: 'tailwindcss', version: '4.1.12' }, { name: '@tailwindcss/node', version: '4.1.12' },
].map((dependency) => Object.freeze(dependency)));
export const REACT_TYPE_DEPENDENCIES = Object.freeze([
  { name: 'typescript', version: '5.9.3' }, { name: '@types/react', version: '18.3.28' },
  { name: '@types/react-dom', version: '18.3.7' }, { name: 'csstype', version: '3.2.3' }, { name: '@types/prop-types', version: '15.7.15' },
].map((dependency) => Object.freeze(dependency)));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const timestamp = z.iso.datetime({ offset: true });
const dependency = z.object({ name: z.string().min(1).max(100), version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/) }).strict();
const dependencies = dependency.array().min(1).max(20).refine((items) => new Set(items.map((item) => item.name)).size === items.length, '패키지 이름이 중복되었습니다.');
/** @param {ReadonlyArray<{name:string,version:string}>} expected */
const pinnedDependencies = (expected) => dependencies.refine((items) => items.length === expected.length
  && expected.every((pin) => items.some((item) => item.name === pin.name && item.version === pin.version)), '고정된 패키지 조합과 다릅니다.');
const legacyTypecheck = z.object({ status: z.literal('passed'), typescriptVersion: dependency.shape.version,
  dependencies, declarationHash: hash }).strict();
export const ReactTypecheckSchema = legacyTypecheck.extend({ typescriptVersion: z.literal('5.9.3'), dependencies: pinnedDependencies(REACT_TYPE_DEPENDENCIES) });
const artifactShape = {
  bundle: z.string().min(1).max(240000).refine((value) => bytes(value) <= 240000),
  css: z.string().max(80000).refine((value) => bytes(value) <= 80000),
  sourceHash: hash, bundleHash: hash, cssHash: hash, runtimeVersion: z.literal(REACT_RUNTIME_VERSION), packageSetHash: hash, dependencies,
};
export const ReactRuntimeArtifactSchema = z.object({ bundle: artifactShape.bundle, css: artifactShape.css,
  bundleHash: hash, cssHash: hash, runtimeVersion: artifactShape.runtimeVersion, packageSetHash: hash }).strict();
export const ReactRuntimeArtifactJsonSchema = z.toJSONSchema(ReactRuntimeArtifactSchema, { unrepresentable: 'any' });
/** @param {unknown} value */
export function selectReactRuntimeArtifact(value) {
  if (!value || typeof value !== 'object') return ReactRuntimeArtifactSchema.parse(value);
  return ReactRuntimeArtifactSchema.parse(Object.fromEntries(Object.keys(ReactRuntimeArtifactSchema.shape).map((key) => [key, Reflect.get(value, key)])));
}
export const ReactLegacyArtifactSchema = z.object({ ...artifactShape, workspaceHash: hash.optional(), typecheck: legacyTypecheck.optional() }).strict();
export const ReactCompiledArtifactSchema = z.object({ ...artifactShape, schemaVersion: z.literal(REACT_ARTIFACT_SCHEMA_VERSION),
  workspaceHash: hash, dependencies: pinnedDependencies(REACT_BUILD_DEPENDENCIES), typecheck: ReactTypecheckSchema }).strict();
export const ReactArtifactSchema = z.union([ReactCompiledArtifactSchema, ReactLegacyArtifactSchema]);
export const ReactExecutionArtifactSchema = z.union([
  ReactCompiledArtifactSchema.extend({ executionId: z.string().uuid() }), ReactLegacyArtifactSchema.extend({ executionId: z.string().uuid() }),
]);

const revisionShape = { id: z.string().uuid(), version: positive, sourceHash: hash, apis: ReactApiRefsSchema,
  updatedAt: timestamp, updatedBy: z.string().min(1).max(200), restoredFrom: positive.nullable() };
const currentRevision = z.object({ ...revisionShape, schemaVersion: z.literal(REACT_REVISION_SCHEMA_VERSION), source: WorkspaceSourceSchema, artifact: ReactCompiledArtifactSchema }).strict();
const legacyRevision = z.object({ ...revisionShape, source: ReactSourceSchema, artifact: ReactArtifactSchema }).strict();
/** @param {z.infer<typeof legacyRevision>} value
 * @param {z.core.$RefinementCtx<z.infer<typeof legacyRevision>>} context */
const revisionIdentity = (value, context) => {
  if (value.artifact.sourceHash !== value.sourceHash) context.addIssue({ code: 'custom', path: ['artifact', 'sourceHash'], message: '소스와 실행본의 기준이 다릅니다.' });
  if ('workspace' in value.source && (value.artifact.workspaceHash !== value.sourceHash
    || !ReactCompiledArtifactSchema.safeParse({ ...value.artifact, schemaVersion: REACT_ARTIFACT_SCHEMA_VERSION }).success)) context.addIssue({ code: 'custom', path: ['artifact'], message: '파일 묶음의 타입 검사와 기준값이 필요합니다.' });
  if (value.restoredFrom !== null && value.restoredFrom >= value.version) context.addIssue({ code: 'custom', path: ['restoredFrom'], message: '복원 대상 버전을 확인해 주세요.' });
};
export const ReactCurrentRevisionSchema = currentRevision.superRefine(revisionIdentity);
export const ReactLegacyRevisionSchema = legacyRevision.superRefine(revisionIdentity);
export const ReactRevisionSchema = z.union([ReactCurrentRevisionSchema, ReactLegacyRevisionSchema]);
export const ReactPageSchema = ReactRevisionSchema;
export const ReactPageListItemSchema = z.object({ id: revisionShape.id, version: positive, source: z.object({ title }).strict(),
  sourceHash: hash, updatedAt: timestamp, schemaVersion: z.literal(REACT_REVISION_SCHEMA_VERSION).optional() }).strict();
export const ReactHistoryItemSchema = ReactPageListItemSchema.extend({ restoredFrom: positive.nullable() });
export const ReactPageListSchema = z.object({ schemaVersion: z.literal(1).optional(), items: ReactPageListItemSchema.array().max(100), truncated: z.boolean() }).strict();
export const ReactHistorySchema = z.object({ schemaVersion: z.literal(1).optional(), items: ReactHistoryItemSchema.array().max(100) }).strict();
export const ReactGitResultSchema = z.object({ status: z.enum(['complete', 'disabled', 'failed', 'retryable']), message: z.string().max(2000).optional(),
  id: hash.optional(), repository: z.string().max(200).optional(), baseBranch: z.string().max(200).optional(), branch: z.string().max(200).optional(),
  pageId: revisionShape.id.optional(), version: positive.optional(), sourceHash: hash.optional(), commitSha: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  pullNumber: positive.optional(), pullUrl: z.string().regex(/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/).optional(),
  pullState: z.enum(['open', 'closed']).optional(), merged: z.boolean().optional(), verifiedAt: timestamp.optional(), createdAt: timestamp.optional(), updatedAt: timestamp.optional(),
}).strict();
export const ReactPageMutationResponseSchema = z.union([
  currentRevision.extend({ git: ReactGitResultSchema.optional() }).superRefine(revisionIdentity),
  legacyRevision.extend({ git: ReactGitResultSchema.optional() }).superRefine(revisionIdentity),
]);
export const ReactSaveRequestSchema = z.object({ expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), source: ReactSourceSchema, apis: ReactApiRefsSchema }).strict();
export const ReactRestoreRequestSchema = z.object({ expectedVersion: positive, version: positive }).strict();
export const ReactPreviewRequestSchema = z.object({ source: ReactSourceSchema, apis: ReactApiRefsSchema }).strict();

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
