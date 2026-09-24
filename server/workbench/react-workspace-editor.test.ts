import { describe, expect, it } from 'vitest';
import { draftIdentity, editorReducer as reduce, initialEditor, lineDiff, proposalProblem, type EditorState } from '../../workbench/react-workspace-editor';
const ref = { id: '22222222-2222-4222-8222-222222222222', version: 1 };
const ready = (): EditorState => {
  let state = reduce(initialEditor('entry old'), { type: 'add', path: 'components/Card.tsx' });
  state = reduce(state, { type: 'code', path: 'components/Card.tsx', value: 'card old' });
  return reduce(state, { type: 'apis', value: [ref] });
};
const proposed = (state: EditorState) => reduce(state, { type: 'propose', target: state.target, value: { baseEditorIdentity: draftIdentity(state.source, state.apis), apis: state.apis, source: { ...state.source, title: '제안 제목', workspace: { ...state.source.workspace, files: { 'App.tsx': 'entry new', 'lib/amount.ts': 'export const amount = 0;' } } } } });

describe('canonical React editor transitions', () => {
  it('normalizes legacy only in the editor and preserves the immutable saved source', () => {
    const revision = { id: 'page-a', version: 1, source: { title: '이전 원문', code: 'legacy original' }, apis: [] };
    const state = reduce(initialEditor(), { type: 'load', revision });
    expect(state.source.workspace.files).toEqual({ 'App.tsx': 'legacy original' });
    expect(state.saved?.source).toEqual(revision.source);
    expect(draftIdentity(state.source, [])).toBe(draftIdentity(revision.source, []));
  });
  it('applies title, all files, deletion, entry and pinned APIs atomically', () => {
    const state = proposed(ready()), next = reduce(state, { type: 'apply' });
    expect(next.source.title).toBe('제안 제목');
    expect(next.source.workspace.files).toEqual({ 'App.tsx': 'entry new', 'lib/amount.ts': 'export const amount = 0;' });
    expect(next.activeFile).toBe('App.tsx'); expect(next.apis).toEqual([ref]); expect(next.proposal).toBeNull();
  });
  it.each(['title', 'inactive-file', 'api-version', 'file-added', 'file-deleted'] as const)('rejects stale proposal after %s changes without partial application', kind => {
    let state = proposed(ready());
    if (kind === 'title') state = reduce(state, { type: 'title', value: '사용자 제목' });
    if (kind === 'inactive-file') state = reduce(state, { type: 'code', path: 'App.tsx', value: 'user changed hidden file' });
    if (kind === 'api-version') state = reduce(state, { type: 'apis', value: [{ ...ref, version: 2 }] });
    if (kind === 'file-added') state = reduce(state, { type: 'add', path: 'Added.ts' });
    if (kind === 'file-deleted') state = reduce(state, { type: 'remove', path: 'components/Card.tsx' });
    const result = reduce(state, { type: 'apply' });
    expect(result.source).toBe(state.source); expect(result.apis).toBe(state.apis); expect(result.notice).toContain('다시 요청');
  });
  it('allows same bytes restored while still in the same editor target', () => {
    let state = proposed(ready()); const title = state.source.title;
    state = reduce(reduce(state, { type: 'title', value: '잠시 변경' }), { type: 'title', value: title });
    expect(proposalProblem(state)).toBeNull(); expect(reduce(state, { type: 'apply' }).source.title).toBe('제안 제목');
  });
  it('rejects a late callback from another target even when all bytes are identical', () => {
    const old = proposed(ready()), revision = { id: 'different-page', version: 1, source: old.source, apis: old.apis };
    const next = reduce(old, { type: 'load', revision });
    expect(reduce(next, { type: 'propose', value: old.proposal!, target: old.target })).toBe(next);
    expect(next.proposal).toBeNull();
  });
  it('does not apply old unbound or malformed proposals', () => {
    const start = ready();
    for (const value of [{ source: start.source }, { source: start.source, apis: [] }, { source: { title: '', code: '' }, apis: [], baseEditorIdentity: draftIdentity(start.source, start.apis) }]) {
      const state = reduce(start, { type: 'propose', value, target: start.target });
      expect(proposalProblem(state)).not.toBeNull(); expect(reduce(state, { type: 'apply' }).source).toBe(start.source);
    }
  });
  it('preserves typing after a save response and ignores a result for a departed target', () => {
    const start = ready(), identity = draftIdentity(start.source, start.apis), revision = { id: 'saved-a', version: 2, source: start.source, apis: start.apis };
    const edited = reduce(start, { type: 'title', value: '저장 중 작성' });
    const done = reduce(edited, { type: 'remember', revision, identity, target: start.target });
    expect(done.source.title).toBe('저장 중 작성'); expect(done.saved?.version).toBe(2);
    const departed = reduce(edited, { type: 'reset', code: 'new editor' });
    expect(reduce(departed, { type: 'remember', revision, identity, target: start.target })).toBe(departed);
  });
  it('handles temporarily invalid title without crashing identity or marking proposal fresh', () => {
    const state = reduce(proposed(ready()), { type: 'title', value: '' });
    expect(draftIdentity(state.source, state.apis)).toMatch(/^invalid:/); expect(proposalProblem(state)).not.toBeNull();
  });
  it('protects entry and rejects traversal, prototype paths, duplicate case and over-limit files', () => {
    const state = ready();
    for (const path of ['../bad.tsx', '__proto__/bad.ts', 'app.tsx', 'node_modules/react.ts']) expect(reduce(state, { type: 'add', path }).source).toBe(state.source);
    expect(reduce(state, { type: 'remove', path: 'App.tsx' }).source).toBe(state.source);
    let full = initialEditor(); for (let i = 0; i < 31; i++) full = reduce(full, { type: 'add', path: `F${i}.ts` });
    expect(reduce(full, { type: 'add', path: 'overflow.ts' }).source).toBe(full.source);
  });
  it('clears stale proposal on explicit restored conversation context', () => {
    const state = proposed(ready()), result = reduce(state, { type: 'context', source: { title: '대화 원문', code: 'restored' }, apis: [] });
    expect(result.target).toBe(state.target + 1); expect(result.proposal).toBeNull(); expect(result.source.workspace.files['App.tsx']).toBe('restored');
  });
});
describe('line diff', () => {
  it('shows deletion and addition with original line coordinates', () => {
    expect(lineDiff('same\nold\nend', 'same\nnew\nend')).toEqual([{ kind: 'same', text: 'same', before: 1, after: 1 }, { kind: 'remove', text: 'old', before: 2 }, { kind: 'add', text: 'new', after: 2 }, { kind: 'same', text: 'end', before: 3, after: 3 }]);
    expect(lineDiff('removed', '')).toEqual([{ kind: 'remove', text: 'removed', before: 1 }]);
    expect(lineDiff('same', 'same')).toEqual([]);
  });
  it('bounds quadratic work for large unrelated changes', () => {
    const before = Array.from({ length: 600 }, (_, i) => `old${i}`).join('\n'), after = Array.from({ length: 600 }, (_, i) => `new${i}`).join('\n');
    const diff = lineDiff(before, after); expect(diff).toHaveLength(1200); expect(diff.filter(item => item.kind === 'add')).toHaveLength(600);
  });
});
