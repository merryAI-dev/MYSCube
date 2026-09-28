import { describe, expect, it } from 'vitest';
import { initialStudio, studioReducer as reduce, ticketFor, candidateIsCurrent, visibleEvidence } from '../../workbench/react-studio-model';
import { draftIdentity } from '../../workbench/react-workspace-editor';
const ready = () => reduce(initialStudio(), { type: 'reset', code: 'export default function App(){return null;}' });
const artifact = (executionId: string) => ({ executionId, bundle: '', css: '', sourceHash: 'a'.repeat(64), bundleHash: 'b'.repeat(64), cssHash: 'c'.repeat(64), runtimeVersion: 'react-preview-v1', packageSetHash: 'd'.repeat(64) });
const start = (state = ready(), id = 'a') => { const ticket = ticketFor(state, id); state = reduce(state, { type: 'execution-start', ticket, remote: false }); state = reduce(state, { type: 'execution-compiled', ticket, artifact: artifact(id) }); return { state, ticket }; };
describe('single studio transition model', () => {
  it('keeps the visible frame and its evidence while a new candidate fails', () => {
    let { state } = start(); state = reduce(state, { type: 'execution-evidence', executionId: 'a', apiId: 'api', evidenceId: 'e1' }); state = reduce(state, { type: 'execution-result', id: 'a', status: 'ready' });
    state = start(state, 'b').state; state = reduce(state, { type: 'execution-evidence', executionId: 'b', apiId: 'api', evidenceId: 'e2' });
    expect(visibleEvidence(state).api.evidenceId).toBe('e1'); state = reduce(state, { type: 'execution-result', id: 'b', status: 'error', message: 'failure' });
    expect(state.execution.visible?.executionId).toBe('a'); expect(visibleEvidence(state).api.evidenceId).toBe('e1'); expect(state.execution.bindings.b).toBeUndefined();
  });
  for (const change of [{ type: 'title', value: 'new' }, { type: 'code', path: 'App.tsx', value: 'changed' }, { type: 'apis', value: [{ id: 'api', version: 2 }] }] as const) it(`rejects a late candidate after ${change.type} changed`, () => {
    const value = start(); let state = reduce(value.state, change as any); expect(candidateIsCurrent(state, 'a')).toBe(false);
    state = reduce(state, { type: 'execution-result', id: 'a', status: 'ready' }); expect(state.execution.visible).toBeNull(); expect(state.execution.preparing).toBe(false);
  });
  it('allows identity-equivalent edits but never a different page target', () => {
    const value = start(); let state = reduce(value.state, { type: 'title', value: 'other' }); state = reduce(state, { type: 'title', value: value.state.source.title }); expect(candidateIsCurrent(state, 'a')).toBe(true);
    state = reduce(state, { type: 'reset', code: value.state.source.workspace.files['App.tsx'] }); expect(candidateIsCurrent(state, 'a')).toBe(false);
    state = reduce(state, { type: 'execution-compiled', ticket: value.ticket, artifact: artifact('a') }); expect(state.execution.artifact).toBeNull();
  });
  it('preserves typing after a save and installs only the saved baseline', () => {
    let state = ready(); const ticket = ticketFor(state, 'save'), savedSource = state.source;
    state = reduce(state, { type: 'task-start', ticket }); state = reduce(state, { type: 'title', value: 'later input' });
    state = reduce(state, { type: 'saved', ticket, page: { id: 'page', version: 1, source: { title: 'saved' }, updatedAt: '2026-09-24T00:00:00Z', sourceHash: 'a'.repeat(64) }, revision: { id: 'page', version: 1, source: savedSource, apis: [] }, message: 'saved' });
    expect(state.source.title).toBe('later input'); expect(state.saved?.source).toEqual(savedSource); expect(draftIdentity(state.source, state.apis)).not.toBe(draftIdentity(state.saved!.source, state.saved!.apis));
  });
  it('ignores old target saves, errors, and evidence; revocation clears pixels and proposal only', () => {
    const value = start(); let state = reduce(value.state, { type: 'reset', code: 'new text' });
    state = reduce(state, { type: 'saved', ticket: value.ticket, revision: { id: 'old', version: 1, source: value.state.source, apis: [] }, message: 'old' });
    state = reduce(state, { type: 'execution-evidence', executionId: 'a', apiId: 'api', evidenceId: 'old' });
    state = reduce(state, { type: 'task-end', ticket: value.ticket, error: 'old' }); expect(state.saved).toBeNull(); expect(state.error).toBe(''); expect(state.execution.bindings).toEqual({});
    const before = state.source; state = reduce(state, { type: 'authorization-failed', message: 'denied' }); expect(state.source).toEqual(before); expect(state.execution.visible).toBeNull(); expect(state.proposal).toBeNull();
  });
  it('compile failure ends preparing and retains a good execution', () => {
    let state = start().state; state = reduce(state, { type: 'execution-result', id: 'a', status: 'ready' }); const ticket = ticketFor(state, 'compile');
    state = reduce(state, { type: 'execution-start', ticket, remote: false }); state = reduce(state, { type: 'task-start', ticket }); state = reduce(state, { type: 'task-end', ticket, error: 'invalid source' });
    expect(state.execution.preparing).toBe(false); expect(state.execution.visible?.executionId).toBe('a'); expect(state.task).toBeNull();
  });
});

it('expected query criteria are installed by explicit apply and travel with the committed execution only', () => {
  let state = ready(); const expected = [{ apiId: 'api', apiVersion: 1, evidenceId: 'proof', input: {}, plan: { datasetId: 'weekly_submission' }, datasetVersions: { weekly_submission: 'v1' }, definitionVersions: {} }];
  state = reduce(state, { type: 'propose', target: state.target, value: { source: state.source, apis: [], baseEditorIdentity: draftIdentity(state.source, []), screenBindings: expected } });
  expect(state.expectedQueries).toEqual([]); state = reduce(state, { type: 'apply' }); expect(state.expectedQueries).toEqual(expected);
  state = start(state).state; state = reduce(state, { type: 'execution-result', id: 'a', status: 'ready' });
  state = reduce(state, { type: 'title', value: 'direct edit' }); expect(state.expectedQueries).toEqual([]); expect(state.execution.visible?.expectedQueries).toEqual(expected);
  state = reduce(state, { type: 'load', revision: { id: 'page', version: 1, source: state.source, apis: [] } }); expect(state.expectedQueries).toEqual([]);
});

it('an authorization boundary invalidates every late metadata and revision action without discarding draft content', () => {
  let state = ready(); const ticket = ticketFor(state, 'before-denial'), source = state.source;
  state = reduce(state, { type: 'authorization-failed', message: 'denied' }); expect(state.target).toBe(ticket.target + 1);
  const denied = state;
  const page = { id: 'page', version: 1, source: { title: 'old private title' }, updatedAt: '2026-09-24T00:00:00Z', sourceHash: 'a'.repeat(64) };
  for (const action of [
    { type: 'apis-loaded', ticket, apis: [{ id: 'private', version: 1, definition: { name: 'old private api', enabled: true, description: '' } }] },
    { type: 'history-loaded', ticket, history: [page] },
    { type: 'saved', ticket, revision: { id: 'page', version: 1, source, apis: [] }, page, message: 'saved late' },
    { type: 'load-result', ticket, revision: { id: 'page', version: 1, source, apis: [] }, page },
    { type: 'initialize', ticket, pages: [page], apis: [], capabilities: { example: 'old code' } },
  ]) expect(reduce(state, action as any)).toBe(denied);
  expect(state.source).toEqual(source); expect(state.saved).toBeNull(); expect(state.pages).toEqual([]);
});
