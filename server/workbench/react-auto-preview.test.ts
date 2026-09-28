import { describe, expect, it } from 'vitest';
import { initialStudio, studioReducer as reduce, ticketFor, defaultReactApis, studioDirty, type RegisteredApi, type StudioAction } from '../../workbench/react-studio-model';
import { draftIdentity, newWorkspace, type SourceProposal } from '../../workbench/react-workspace-editor';

const api = { id: '11111111-1111-4111-8111-111111111111', version: 1 };
const initial = () => ({ ...reduce(initialStudio(), { type: 'reset', code: 'export default function App(){return <h1>Previous</h1>}' }), capabilities: { modelEnabled: true, gitEnabled: false, gitRepository: null, runtimeUrl: null, remoteRuntime: true, runtimeMode: 'remote-container', example: '' } });
const proposalFor = (state: ReturnType<typeof initial>): SourceProposal => ({ source: { ...newWorkspace(), title: 'Generated', workspace: { ...newWorkspace().workspace, files: { 'App.tsx': 'import {label} from "./lib/label"; export default function App(){return <h1>{label}</h1>}', 'lib/label.ts': 'export const label = "Generated";' } } }, apis: [api], baseEditorIdentity: draftIdentity(state.source, state.apis) });
const actionFor = (state: ReturnType<typeof initial>): StudioAction => ({ type: 'generated-preview', value: proposalFor(state), target: state.target, requestIdentity: draftIdentity(state.source, state.apis), requestId: 'new-source-turn' });

describe('generated React source automatically enters the existing transactional preview', () => {
  it('atomically installs all files, API versions and candidate from the accepted proposal without saving', () => {
    const before = initial(), action = actionFor(before), next = reduce(before, action);
    expect(next.source.title).toBe('Generated'); expect(Object.keys(next.source.workspace.files)).toHaveLength(2);
    expect(next.apis).toEqual([api]); expect(next.execution.remoteDraft?.source).toEqual(next.source);
    expect(next.execution.candidate?.identity).toBe(draftIdentity(next.source, next.apis));
    expect(next.execution.remoteDraft?.apis).toEqual(next.apis); expect(next.execution.sequence).toBe(1);
    expect(next.proposal).toBeNull(); expect(next.saved).toBeNull(); expect(next.git).toBeNull(); expect(next.pages).toEqual([]);
    expect(reduce(next, action)).toBe(next);
  });
  const edits: StudioAction[] = [{ type: 'title', value: 'My latest title' }, { type: 'code', path: 'App.tsx', value: 'My latest code' }, { type: 'add', path: 'Hidden.ts' }, { type: 'apis', value: [api] }];
  for (const edit of edits) it(`keeps a newer ${edit.type} edit and schedules no candidate`, () => {
    const before = initial(), action = actionFor(before), edited = reduce(before, edit), next = reduce(edited, action);
    expect(next.source).toEqual(edited.source); expect(next.apis).toEqual(edited.apis);
    expect(next.execution).toBe(edited.execution); expect(next.notice).toContain('자동으로 적용하지');
  });
  it('rejects an obsolete page and authorization target even when its source text is identical', () => {
    const before = initial(), action = actionFor(before);
    for (const changed of [reduce(before, { type: 'reset', code: before.source.workspace.files['App.tsx'] }), reduce(before, { type: 'authorization-failed', message: 'denied' })]) expect(reduce(changed, action)).toBe(changed);
  });
  it('keeps prior visible identity and proof during candidate failure, with the unsaved generated source available for retry', () => {
    let before = initial();
    const ticket = ticketFor(before, 'previous');
    before = { ...before, ...reduce(before, { type: 'execution-start', ticket, remote: true }) };
    const ready = reduce(before, { type: 'execution-result', id: before.execution.candidate!.key, status: 'ready' });
    const generated = reduce(ready, { ...actionFor(initial()), requestIdentity: draftIdentity(ready.source, ready.apis) });
    expect(generated.execution.visible).toEqual(ready.execution.visible);
    const failed = reduce(generated, { type: 'execution-result', id: generated.execution.candidate!.key, status: 'error', message: 'Could not create candidate' });
    expect(failed.execution.visible).toEqual(ready.execution.visible); expect(failed.source).toEqual(generated.source);
    expect(failed.execution.preparing).toBe(false); expect(failed.error).toBe('Could not create candidate'); expect(failed.saved).toBeNull();
  });
  it('rejects missing server baseline, malformed API refs and a stored-context mismatch', () => {
    const before = initial();
    for (const value of [{ ...proposalFor(before), baseEditorIdentity: undefined }, { ...proposalFor(before), apis: [{ id: 'invalid', version: 1 }] }, { ...proposalFor(before), baseEditorIdentity: 'different-context' }]) {
      const next = reduce(before, { type: 'generated-preview', value, target: before.target, requestIdentity: draftIdentity(before.source, before.apis), requestId: 'bad' });
      expect(next.source).toEqual(before.source); expect(next.execution).toBe(before.execution); expect(next.notice).not.toBe('');
    }
  });
  it('does not replace a save or preview already in progress', () => {
    const before = initial(), action = actionFor(before), ticket = ticketFor(before, 'other');
    for (const busy of [reduce(before, { type: 'task-start', ticket }), reduce(before, { type: 'execution-start', ticket, remote: true })]) {
      const next = reduce(busy, action);
      expect(next.source).toEqual(busy.source); expect(next.execution).toBe(busy.execution); expect(next.task).toBe(busy.task);
      expect(next.notice).toContain('다른 요청을 처리');
    }
  });
  it('history review remains inert and missing runtime reports source-only application honestly', () => {
    const before = initial(), value = proposalFor(before);
    const reviewed = reduce(before, { type: 'propose', value, target: before.target }); expect(reviewed.source).toEqual(before.source); expect(reviewed.execution.candidate).toBeNull();
    const noRuntime = reduce({ ...before, capabilities: { ...before.capabilities, remoteRuntime: false } }, actionFor(before));
    expect(noRuntime.source.title).toBe('Generated'); expect(noRuntime.execution.candidate).toBeNull(); expect(noRuntime.notice).toContain('미리보기를 표시할 수 없습니다');
  });
});

const liveApi = (id: string, endpointId: string): RegisteredApi => ({ id, version: 3, definition: { name: endpointId, description: 'Approved fixture connection', enabled: true, kind: 'external-read', endpointId, endpointVersion: 1 } });
const defaults = [liveApi(api.id, 'myscube-projects'), liveApi('22222222-2222-4222-8222-222222222222', 'myscube-cashflow-evidence')];
const initialize = (state = initialStudio()) => reduce(state, { type: 'initialize', ticket: ticketFor(state, 'initialize'), capabilities: initial().capabilities, pages: [], apis: defaults });
describe('approved live connections default only to new untouched editors', () => {
  it('includes the company summary only when a unique enabled registered definition exists', () => {
    const summary = liveApi('33333333-3333-4333-8333-333333333333', 'myscube-company-cashflow-summary');
    expect(defaultReactApis([...defaults, summary])).toContainEqual({ id: summary.id, version: 3 });
    expect(defaultReactApis([...defaults, summary, { ...summary, id: '44444444-4444-4444-8444-444444444444' }])).toEqual(defaultReactApis(defaults));
    expect(defaultReactApis([...defaults, { ...summary, definition: { ...summary.definition, enabled: false } }])).toEqual(defaultReactApis(defaults));
  });

  it('selects exactly the two unique enabled endpoints and treats initial selection as the clean baseline', () => {
    const state = initialize(); expect(state.apis).toEqual(defaults.map(({ id, version }) => ({ id, version }))); expect(studioDirty(state)).toBe(false);
    expect(state.execution.candidate).toBeNull(); expect(state.saved).toBeNull();
    const deselected = reduce(state, { type: 'apis', value: [] }); expect(studioDirty(deselected)).toBe(true);
    const refreshed = reduce(deselected, { type: 'apis-loaded', ticket: ticketFor(deselected, 'refresh'), apis: defaults });
    expect(refreshed.apis).toEqual([]); expect(studioDirty(refreshed)).toBe(true);
    const late = reduce(refreshed, { type: 'initialize', ticket: ticketFor(initialStudio(), 'old-initialize'), capabilities: initial().capabilities, pages: [], apis: defaults }); expect(late).toBe(refreshed);
  });
  it('excludes duplicate, disabled, unrelated and different endpoint versions without guessing a registration', () => {
    expect(defaultReactApis([...defaults, liveApi('33333333-3333-4333-8333-333333333333', 'myscube-projects')])).toEqual([{ id: defaults[1].id, version: 3 }]);
    for (const definition of [{ ...defaults[0].definition, enabled: false }, { ...defaults[0].definition, kind: 'analytics-copy' }, { ...defaults[0].definition, endpointId: 'myscube-projects-extra' }, { ...defaults[0].definition, endpointVersion: 2 }]) expect(defaultReactApis([{ ...defaults[0], definition }])).toEqual([]);
  });
  it('keeps pre-initialization user changes, saved empty selection, and restored selection', () => {
    const before = initialStudio(), edited = reduce(before, { type: 'title', value: 'already editing' });
    const late = reduce(edited, { type: 'initialize', ticket: ticketFor(before, 'initial'), capabilities: initial().capabilities, pages: [], apis: defaults });
    expect(late.source.title).toBe('already editing'); expect(late.apis).toEqual([]);
    const explicitEmpty = reduce(before, { type: 'apis', value: [] });
    expect(reduce(explicitEmpty, { type: 'initialize', ticket: ticketFor(before, 'late'), capabilities: initial().capabilities, pages: [], apis: defaults }).apis).toEqual([]);
    const state = initialize();
    for (const refs of [[], [api]]) {
      const loaded = reduce(state, { type: 'load', revision: { id: 'saved', version: 2, source: state.source, apis: refs } });
      expect(loaded.apis).toEqual(refs); expect(studioDirty(loaded)).toBe(false);
      const refreshed = reduce(loaded, { type: 'apis-loaded', ticket: ticketFor(loaded, 'refresh'), apis: defaults }); expect(refreshed.apis).toEqual(refs);
    }
    const context = reduce(state, { type: 'context', source: state.source, apis: [] }); expect(context.apis).toEqual([]);
  });
  it('explicit new page restores current defaults while ordinary API refresh does not', () => {
    const state = initialize(), changed = reduce(state, { type: 'apis', value: [] });
    const next = reduce(changed, { type: 'reset', code: state.capabilities!.example });
    expect(next.apis).toEqual(state.apis); expect(next.target).toBe(changed.target + 1); expect(studioDirty(next)).toBe(false);
  });
});
