import type { ScreenQueryExpectation } from './screen-evidence';
import type * as z from 'zod/v4';
import { editorIdentity, normalizeReactSource, ReactApiRefsSchema, ReactSourceSchema, ReactRevisionSchema, REACT_PACKAGE_SET_ID, WorkspacePathSchema } from '../shared/workbench-react-workspace.mjs';

export type ReactSource = z.infer<typeof ReactSourceSchema>;
export type ApiRef = z.infer<typeof ReactApiRefsSchema>[number];
export type WorkspaceSource = ReturnType<typeof normalizeReactSource>;
export type EditorRevision = Pick<z.infer<typeof ReactRevisionSchema>, 'id' | 'version' | 'source' | 'apis'>;
export type SourceProposal = { source: ReactSource; apis?: ApiRef[]; baseEditorIdentity?: string; screenBindings?: ScreenQueryExpectation[] };
export type EditorState = { source: WorkspaceSource; apis: ApiRef[]; saved: EditorRevision | null; activeFile: string; proposal: SourceProposal | null; target: number; notice: string; expectedQueries: ScreenQueryExpectation[] };
export const newWorkspace = (code = ''): WorkspaceSource => ({ title: '나의 업무 화면', workspace: { schemaVersion: 1, entry: 'App.tsx', packageSetId: REACT_PACKAGE_SET_ID, files: { 'App.tsx': code } } });
export function draftIdentity(source: ReactSource, apis: ApiRef[]) {
  try { return editorIdentity(source, apis); }
  catch { return `invalid:${JSON.stringify({ source, apis })}`; }
}
export function initialEditor(code = ''): EditorState { return { source: newWorkspace(code), apis: [], saved: null, activeFile: 'App.tsx', proposal: null, target: 0, notice: '', expectedQueries: [] }; }
export function proposalProblem(state: EditorState): string | null {
  const proposal = state.proposal;
  if (!proposal) return '검토할 제안이 없습니다.';
  if (!proposal.baseEditorIdentity || !proposal.apis) return '이전 방식으로 생성한 제안입니다. 현재 편집 내용을 기준으로 다시 요청해 주세요.';
  if (proposal.baseEditorIdentity !== draftIdentity(state.source, state.apis)) return '제안 이후 제목·파일·API 연결이 바뀌었거나 다른 편집 내용을 기준으로 만들어졌습니다. 현재 내용으로 다시 요청해 주세요.';
  if (!ReactSourceSchema.safeParse(proposal.source).success || !ReactApiRefsSchema.safeParse(proposal.apis).success) return '제안의 파일 또는 API 버전을 확인하지 못했습니다. 다시 요청해 주세요.';
  return null;
}
export type EditorAction =
  | { type: 'reset'; code: string }
  | { type: 'load'; revision: EditorRevision }
  | { type: 'remember'; revision: EditorRevision; target: number; identity: string }
  | { type: 'context'; source: ReactSource; apis: ApiRef[] }
  | { type: 'title'; value: string }
  | { type: 'code'; path: string; value: string }
  | { type: 'apis'; value: ApiRef[] }
  | { type: 'select'; path: string }
  | { type: 'add'; path: string }
  | { type: 'remove'; path: string }
  | { type: 'entry'; path: string }
  | { type: 'propose'; value: SourceProposal; target: number }
  | { type: 'apply' }
  | { type: 'dismiss' };
export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'reset') return { ...initialEditor(action.code), target: state.target + 1 };
  if (action.type === 'load' || action.type === 'context') {
    const value = action.type === 'load' ? action.revision : action;
    const source = normalizeReactSource(value.source), apis = ReactApiRefsSchema.parse(value.apis);
    return { ...state, source, apis, saved: action.type === 'load' ? action.revision : state.saved, activeFile: source.workspace.entry, target: state.target + 1, proposal: null, notice: '', expectedQueries: [] };
  }
  if (action.type === 'remember') {
    if (action.target !== state.target) return state;
    const unchanged = action.identity === draftIdentity(state.source, state.apis);
    return { ...state, saved: action.revision, ...(unchanged ? { source: normalizeReactSource(action.revision.source), apis: action.revision.apis } : {}), notice: unchanged ? '' : '저장 요청 이후 편집한 내용은 유지했습니다. 추가 변경을 다시 저장해 주세요.' };
  }
  if (action.type === 'propose') return action.target === state.target ? { ...state, proposal: action.value, notice: '' } : state;
  if (action.type === 'dismiss') return { ...state, proposal: null, notice: '' };
  if (action.type === 'apply') {
    const problem = proposalProblem(state);
    if (problem) return { ...state, notice: problem };
    const proposal = state.proposal!, source = normalizeReactSource(proposal.source);
    return { ...state, source, apis: ReactApiRefsSchema.parse(proposal.apis), activeFile: Object.hasOwn(source.workspace.files, state.activeFile) ? state.activeFile : source.workspace.entry, proposal: null, expectedQueries: proposal.screenBindings || [], notice: '검토한 파일과 API 버전을 편집기에 함께 적용했습니다. 미리보기와 저장을 확인해 주세요.' };
  }
  if (action.type === 'title') return { ...state, source: { ...state.source, title: action.value }, expectedQueries: [], notice: '' };
  if (action.type === 'apis') return { ...state, apis: action.value, expectedQueries: [], notice: '' };
  const workspace = state.source.workspace, files = workspace.files;
  if (action.type === 'select') return Object.hasOwn(files, action.path) ? { ...state, activeFile: action.path } : state;
  if (action.type === 'code') return Object.hasOwn(files, action.path) ? { ...state, source: { ...state.source, workspace: { ...workspace, files: { ...files, [action.path]: action.value } } }, expectedQueries: [], notice: '' } : state;
  if (action.type === 'add') {
    if (!WorkspacePathSchema.safeParse(action.path).success || Object.keys(files).some(path => path.toLowerCase() === action.path.toLowerCase()) || Object.keys(files).length >= 32) return { ...state, notice: '중복되지 않는 .ts 또는 .tsx 파일 경로를 입력해 주세요. 파일은 최대 32개입니다.' };
    return { ...state, activeFile: action.path, source: { ...state.source, workspace: { ...workspace, files: { ...files, [action.path]: '' } } }, expectedQueries: [], notice: '' };
  }
  if (!Object.hasOwn(files, action.path)) return state;
  if (action.type === 'entry') return { ...state, source: { ...state.source, workspace: { ...workspace, entry: action.path } }, expectedQueries: [], notice: '' };
  if (action.type === 'remove') {
    if (action.path === workspace.entry) return { ...state, notice: '시작 파일은 삭제할 수 없습니다. 먼저 다른 시작 파일을 선택해 주세요.' };
    const remaining = { ...files }; delete remaining[action.path];
    return { ...state, activeFile: state.activeFile === action.path ? workspace.entry : state.activeFile, source: { ...state.source, workspace: { ...workspace, files: remaining } }, expectedQueries: [], notice: '파일을 삭제했습니다. 이 파일을 불러오던 import도 확인해 주세요.' };
  }
  return state;
}
export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string; before?: number; after?: number };
export function lineDiff(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n');
  let start = 0, end = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  while (end < a.length - start && end < b.length - start && a[a.length - end - 1] === b[b.length - end - 1]) end++;
  const left = a.slice(start, a.length - end), right = b.slice(start, b.length - end), result: DiffLine[] = [];
  for (let i = Math.max(0, start - 3); i < start; i++) result.push({ kind: 'same', text: a[i], before: i + 1, after: i + 1 });
  if (left.length * right.length > 250000) {
    left.forEach((text, i) => result.push({ kind: 'remove', text, before: start + i + 1 }));
    right.forEach((text, i) => result.push({ kind: 'add', text, after: start + i + 1 }));
  } else {
    const width = right.length + 1, table = new Uint32Array((left.length + 1) * width);
    for (let i = left.length - 1; i >= 0; i--) for (let j = right.length - 1; j >= 0; j--) table[i * width + j] = left[i] === right[j] ? table[(i + 1) * width + j + 1] + 1 : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    let i = 0, j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && left[i] === right[j]) { result.push({ kind: 'same', text: left[i], before: start + i + 1, after: start + j + 1 }); i++; j++; }
      else if (i < left.length && (j >= right.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) { result.push({ kind: 'remove', text: left[i], before: start + ++i }); }
      else result.push({ kind: 'add', text: right[j], after: start + ++j });
    }
  }
  for (let i = 0; i < Math.min(end, 3); i++) result.push({ kind: 'same', text: a[a.length - end + i], before: a.length - end + i + 1, after: b.length - end + i + 1 });
  return result;
}
