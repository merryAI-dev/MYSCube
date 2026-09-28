import type * as z from 'zod/v4';
import { ReactApiRefsSchema, ReactGitResultSchema, ReactPageListSchema, ReactHistorySchema } from '../shared/workbench-react-workspace.mjs';
import type { ScreenQueryExpectation } from './screen-evidence';
import { editorReducer, initialEditor, newWorkspace, draftIdentity, proposalProblem, type SourceProposal, type EditorAction, type EditorState, type ReactSource, type ApiRef, type EditorRevision } from './react-workspace-editor';
import type { ReactPreviewArtifact } from './ReactPreview';
import type { RemoteDraft } from './RemoteReactPreview';

export type Diagnostic = { file: string; line: number; column: number; message: string; code: string | number };
export type EvidenceBindings = Record<string, { evidenceId: string; kind: 'table' }>;
export type GitResult = z.infer<typeof ReactGitResultSchema>;
export type RegisteredApi = ApiRef & { definition: { name: string; enabled: boolean; description: string; kind?: string; endpointId?: string; endpointVersion?: number } };
export type Capabilities = { modelEnabled: boolean; gitEnabled: boolean; gitRepository: string | null; runtimeUrl: string | null; remoteRuntime?: boolean; runtimeMode: string; example: string };
export type Ticket = { id: string; target: number; identity: string };
type Candidate = Ticket & { key: number; source: ReactSource; apis: ApiRef[]; executionId?: string; expectedQueries: ScreenQueryExpectation[] };
type Visible = { identity: string; executionId?: string; expectedQueries: ScreenQueryExpectation[] };
export type StudioState = EditorState & {
  capabilities: Capabilities | null; pages: z.infer<typeof ReactPageListSchema>['items']; history: z.infer<typeof ReactHistorySchema>['items']; registeredApis: RegisteredApi[];
  newPageApis: ApiRef[]; newPagePristine: boolean; generatedRequest: string | null; task: Ticket | null; error: string; message: string; diagnostics: Diagnostic[]; git: GitResult | null;
  execution: { sequence: number; mount: number; candidate: Candidate | null; visible: Visible | null; artifact: ReactPreviewArtifact | null; remoteDraft: RemoteDraft | null; bindings: Record<string, EvidenceBindings>; preparing: boolean };
};
const emptyExecution = () => ({ sequence: 0, mount: 0, candidate: null, visible: null, artifact: null, remoteDraft: null, bindings: {}, preparing: false });
export const initialStudio = (): StudioState => ({ ...initialEditor(), capabilities: null, pages: [], history: [], registeredApis: [], newPageApis: [], newPagePristine: true, generatedRequest: null, task: null, error: '', message: '', diagnostics: [], git: null, execution: emptyExecution() });
export function defaultReactApis(apis: RegisteredApi[]): ApiRef[] {
  const refs = ['myscube-projects', 'myscube-cashflow-evidence', 'myscube-company-cashflow-summary'].flatMap(endpointId => {
    const matches = apis.filter(api => api.definition.enabled === true && api.definition.kind === 'external-read' && api.definition.endpointId === endpointId && api.definition.endpointVersion === 1);
    return matches.length === 1 ? [{ id: matches[0].id, version: matches[0].version }] : [];
  });
  const parsed = ReactApiRefsSchema.safeParse(refs);
  return parsed.success ? parsed.data : [];
}
export const studioDirty = (state: StudioState) => draftIdentity(state.source, state.apis) !== (state.saved ? draftIdentity(state.saved.source, state.saved.apis) : draftIdentity(newWorkspace(state.capabilities?.example || ''), state.newPageApis));
export const ticketFor = (state: StudioState, id: string): Ticket => ({ id, target: state.target, identity: draftIdentity(state.source, state.apis) });
export const sameTarget = (state: StudioState, ticket: Ticket) => state.target === ticket.target;
export const sameDraft = (state: StudioState, ticket: Ticket) => sameTarget(state, ticket) && draftIdentity(state.source, state.apis) === ticket.identity;
export const candidateIsCurrent = (state: StudioState, id: string | number) => Boolean(state.execution.candidate && (state.execution.candidate.key === id || state.execution.candidate.executionId === id) && sameDraft(state, state.execution.candidate));
export const visibleEvidence = (state: StudioState): EvidenceBindings => state.execution.visible?.executionId ? state.execution.bindings[state.execution.visible.executionId] || {} : {};
export type StudioAction = EditorAction
  | { type: 'generated-preview'; value: SourceProposal; target: number; requestIdentity: string; requestId: string }
  | { type: 'initialize'; ticket: Ticket; capabilities: Capabilities; pages: StudioState['pages']; apis: RegisteredApi[] }
  | { type: 'apis-loaded'; ticket: Ticket; apis: RegisteredApi[] }
  | { type: 'history-loaded'; ticket: Ticket; history: StudioState['history'] }
  | { type: 'load-result'; revision: EditorRevision; git?: GitResult; ticket: Ticket; page: StudioState['pages'][number]; message?: string }
  | { type: 'task-start'; ticket: Ticket }
  | { type: 'task-end'; ticket: Ticket; error?: string; diagnostics?: Diagnostic[]; message?: string }
  | { type: 'saved'; ticket: Ticket; revision: EditorRevision; git?: GitResult; message: string; page: StudioState['pages'][number] }
  | { type: 'message'; message: string }
  | { type: 'git'; ticket: Ticket; git: GitResult }
  | { type: 'execution-start'; ticket: Ticket; remote: boolean }
  | { type: 'execution-compiled'; ticket: Ticket; artifact: ReactPreviewArtifact & { executionId: string } }
  | { type: 'execution-result'; id: string | number; status: 'ready' | 'error'; message?: string }
  | { type: 'execution-evidence'; executionId: string; apiId: string; evidenceId: string }
  | { type: 'execution-error'; executionId: string; message: string }
  | { type: 'execution-clear' }
  | { type: 'authorization-failed'; message: string };
function cleared(state: StudioState) { return { ...emptyExecution(), sequence: state.execution.sequence, mount: state.execution.mount + 1 }; }
export function studioReducer(state: StudioState, action: StudioAction): StudioState {
  if (action.type === 'generated-preview') {
    if (action.target !== state.target || state.generatedRequest === action.requestId) return state;
    const proposed = { ...state, ...editorReducer(state, { type: 'propose', value: action.value, target: action.target }) };
    const problem = state.task || state.execution.preparing ? '다른 요청을 처리하고 있어 생성한 화면을 자동으로 적용하지 않았습니다. 요청이 끝난 뒤 제안을 확인해 주세요.' : action.requestIdentity !== draftIdentity(state.source, state.apis)
      ? '화면을 만드는 동안 편집 내용이 바뀌어 자동으로 적용하지 않았습니다. 현재 내용으로 다시 요청해 주세요.' : proposalProblem(proposed);
    if (problem) return { ...proposed, notice: problem };
    const applied = { ...proposed, ...editorReducer(proposed, { type: 'apply' }), generatedRequest: action.requestId, newPagePristine: false, notice: '생성한 화면을 적용했습니다. 화면을 확인한 뒤 저장해 주세요.' };
    if (!state.capabilities?.remoteRuntime && !state.capabilities?.runtimeUrl) return { ...applied, notice: '생성한 화면을 편집기에 적용했습니다. 실행 공간 연결 전이라 미리보기를 표시할 수 없습니다. 저장은 별도로 진행해 주세요.' };
    return studioReducer(applied, { type: 'execution-start', ticket: ticketFor(applied, action.requestId), remote: Boolean(state.capabilities.remoteRuntime) });
  }
  if (action.type === 'initialize') {
    if (!sameTarget(state, action.ticket)) return state;
    const pristine = sameDraft(state, action.ticket) && state.newPagePristine && !state.saved;
    const defaults = defaultReactApis(action.apis);
    const next = pristine ? { ...editorReducer(state, { type: 'reset', code: action.capabilities.example }), apis: defaults, newPageApis: defaults } : state;
    return { ...state, ...next, capabilities: action.capabilities, pages: action.pages, registeredApis: action.apis, task: null };
  }
  if (action.type === 'apis-loaded') return sameTarget(state, action.ticket) ? { ...state, registeredApis: action.apis } : state;
  if (action.type === 'history-loaded') return sameTarget(state, action.ticket) ? { ...state, history: action.history } : state;
  if (action.type === 'load-result') {
    if (!sameTarget(state, action.ticket)) return state;
    return { ...state, ...editorReducer(state, { type: 'load', revision: action.revision }), pages: [action.page, ...state.pages.filter(page => page.id !== action.page.id)], history: [], task: null, diagnostics: [], git: action.git || null, error: '', message: action.message || '', execution: cleared(state) };
  }
  if (action.type === 'task-start') return sameTarget(state, action.ticket) ? { ...state, task: action.ticket, error: '', diagnostics: [] } : state;
  if (action.type === 'task-end') {
    if (state.task?.id !== action.ticket.id || !sameTarget(state, action.ticket)) return state;
    const current = sameDraft(state, action.ticket);
    return { ...state, task: null, ...(action.error && state.execution.candidate?.id === action.ticket.id ? { execution: { ...state.execution, candidate: null, preparing: false, artifact: null } } : {}), ...(action.error ? { error: action.error, diagnostics: current ? action.diagnostics || [] : [] } : {}), ...(action.message ? { message: action.message } : {}) };
  }
  if (action.type === 'saved') {
    if (!sameTarget(state, action.ticket)) return state;
    return { ...state, ...editorReducer(state, { type: 'remember', revision: action.revision, target: action.ticket.target, identity: action.ticket.identity }), git: action.git || null, message: action.message, pages: [action.page, ...state.pages.filter(page => page.id !== action.page.id)] };
  }
  if (action.type === 'git') return sameTarget(state, action.ticket) ? { ...state, git: action.git } : state;
  if (action.type === 'message') return { ...state, message: action.message };
  if (action.type === 'execution-clear') return { ...state, execution: cleared(state) };
  if (action.type === 'authorization-failed') return { ...state, execution: cleared(state), target: state.target + 1, pages: [], history: [], registeredApis: [], proposal: null, git: null, error: action.message, diagnostics: [], task: null };
  if (action.type === 'execution-start') {
    if (!sameDraft(state, action.ticket)) return state;
    const key = state.execution.sequence + 1;
    const candidate = { ...action.ticket, key, source: state.source, apis: state.apis, expectedQueries: state.expectedQueries };
    const visibleId = state.execution.visible?.executionId;
    return { ...state, error: '', diagnostics: [], execution: { ...state.execution, sequence: key, candidate, preparing: true, artifact: null, remoteDraft: action.remote ? { key, source: state.source, apis: state.apis, expectedQueries: state.expectedQueries } : null, bindings: visibleId ? { [visibleId]: state.execution.bindings[visibleId] || {} } : {} } };
  }
  if (action.type === 'execution-compiled') {
    if (state.execution.candidate?.id !== action.ticket.id) return state;
    if (!sameDraft(state, action.ticket)) return { ...state, error: '화면을 준비하는 동안 편집 내용이 바뀌었습니다. 현재 내용으로 다시 미리보기를 확인해 주세요.', execution: { ...state.execution, candidate: null, preparing: false, artifact: null } };
    return { ...state, execution: { ...state.execution, candidate: { ...state.execution.candidate, executionId: action.artifact.executionId }, artifact: action.artifact } };
  }
  if (action.type === 'execution-result') {
    const candidate = state.execution.candidate;
    const matches = candidate && (candidate.key === action.id || candidate.executionId === action.id);
    if (!matches) {
      if (action.status !== 'error' || state.execution.visible?.executionId !== action.id) return state;
      return { ...state, error: action.message || '실행 화면에서 오류가 발생했습니다. 이전 정상 화면을 확인해 주세요.', execution: { ...state.execution, bindings: {} } };
    }
    if (action.status === 'ready' && sameDraft(state, candidate)) return { ...state, message: '화면을 확인했습니다. 버튼과 필터를 사용해 본 뒤 저장해 주세요.', execution: { ...state.execution, candidate: null, preparing: false, visible: { identity: candidate.identity, executionId: candidate.executionId, expectedQueries: candidate.expectedQueries }, bindings: candidate.executionId ? { [candidate.executionId]: state.execution.bindings[candidate.executionId] || {} } : {} } };
    const visibleId = state.execution.visible?.executionId;
    return { ...state, error: action.message || '화면을 준비하는 동안 편집 내용이 바뀌었습니다. 현재 내용으로 다시 미리보기를 확인해 주세요.', execution: { ...state.execution, candidate: null, preparing: false, artifact: null, bindings: visibleId ? { [visibleId]: state.execution.bindings[visibleId] || {} } : {} } };
  }
  if (action.type === 'execution-evidence') {
    const live = state.execution.visible?.executionId === action.executionId;
    if (!live && !candidateIsCurrent(state, action.executionId)) return state;
    return { ...state, execution: { ...state.execution, bindings: { ...state.execution.bindings, [action.executionId]: { ...state.execution.bindings[action.executionId], [action.apiId]: { evidenceId: action.evidenceId, kind: 'table' } } } } };
  }
  if (action.type === 'execution-error') {
    if (state.execution.visible?.executionId !== action.executionId && state.execution.candidate?.executionId !== action.executionId) return state;
    const bindings = { ...state.execution.bindings }; delete bindings[action.executionId];
    return { ...state, error: action.message, execution: { ...state.execution, bindings } };
  }
  const edited = editorReducer(state, action);
  const defaults = action.type === 'reset' ? defaultReactApis(state.registeredApis) : null;
  const touchesDraft = ['title', 'code', 'apis', 'add', 'remove', 'entry', 'apply', 'load', 'context'].includes(action.type);
  const next = defaults ? { ...edited, apis: defaults, newPageApis: defaults, newPagePristine: true } : touchesDraft ? { ...edited, newPagePristine: false } : edited;
  if (next === state) return state;
  if (next.target !== state.target) return { ...state, ...next, task: null, history: [], diagnostics: [], git: null, error: '', message: '', execution: cleared(state) };
  return { ...state, ...next };
}
