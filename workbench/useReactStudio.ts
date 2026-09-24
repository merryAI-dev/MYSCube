import { useEffect, useReducer, useRef } from 'react';
import type * as z from 'zod/v4';
import { workbenchRequest, logout as signOut } from './client';
import { ReactSourceSchema, ReactApiRefsSchema, ReactDiagnosticSchema, MAX_REACT_DIAGNOSTICS, ReactExecutionArtifactSchema, ReactRevisionSchema, ReactPageListSchema, ReactHistorySchema, ReactPageMutationResponseSchema, ReactGitResultSchema } from '../shared/workbench-react-workspace.mjs';
import { draftIdentity, newWorkspace } from './react-workspace-editor';
import { studioReducer, initialStudio, ticketFor, sameTarget, candidateIsCurrent, visibleEvidence, type Ticket } from './react-studio-model';

type Revision = z.infer<typeof ReactRevisionSchema>;
const request = (path: string, method = 'GET', body?: unknown) => workbenchRequest(`/react-work-pages${path}`, method, body);
const errorText = (reason: unknown) => reason instanceof Error && reason.name === 'ZodError' ? '서버에서 받은 화면의 버전 또는 파일 정보를 확인하지 못했습니다. 편집 내용은 유지했습니다. 새로고침 후 다시 확인해 주세요.' : reason instanceof Error ? reason.message : '요청을 완료하지 못했습니다.';

export function useReactStudio() {
  const [state, dispatch] = useReducer(studioReducer, undefined, initialStudio);
  const current = useRef(state); current.current = state;
  const mounted = useRef(true);
  const { capabilities, pages, history, registeredApis: apis } = state;
  const dirty = draftIdentity(state.source, state.apis) !== (state.saved ? draftIdentity(state.saved.source, state.saved.apis) : draftIdentity(newWorkspace(capabilities?.example || ''), []));
  const active = (ticket: Ticket) => mounted.current && sameTarget(current.current, ticket);
  const rejectUnauthorized = (reason: unknown) => { if ([401, 403].includes(Number((reason as { status?: number })?.status))) { dispatch({ type: 'authorization-failed', message: '조회 권한을 확인하지 못해 실행 화면과 계산 근거를 숨겼습니다. 편집 내용과 확인하지 않은 저장 요청은 유지됩니다.' }); return true; } return false; };
  const run = async (fn: (ticket: Ticket) => Promise<void>) => {
    const ticket = ticketFor(current.current, crypto.randomUUID());
    dispatch({ type: 'task-start', ticket });
    try { await fn(ticket); if (active(ticket)) dispatch({ type: 'task-end', ticket }); }
    catch (reason) {
      if (!active(ticket) || rejectUnauthorized(reason)) return;
      const parsed = ReactDiagnosticSchema.array().max(MAX_REACT_DIAGNOSTICS).safeParse((reason as { details?: { diagnostics?: unknown } })?.details?.diagnostics);
      dispatch({ type: 'task-end', ticket, error: errorText(reason), diagnostics: parsed.success ? parsed.data : [] });
    }
  };
  const refreshApis = async () => { await run(async ticket => { const result = await workbenchRequest('/workbench-apis'); if (active(ticket)) dispatch({ type: 'apis-loaded', ticket, apis: result.items }); }); };
  useEffect(() => {
    mounted.current = true;
    void run(async ticket => {
      const [caps, list, registered] = await Promise.all([request('/capabilities'), request(''), workbenchRequest('/workbench-apis')]);
      if (!active(ticket)) return;
      const checked = ReactPageListSchema.parse(list);
      dispatch({ type: 'initialize', ticket, capabilities: caps, pages: checked.items, apis: registered.items });
    });
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  const mayLeave = () => !dirty || window.confirm('저장하지 않은 변경이 있습니다. 변경을 버리고 이동할까요?');
  const pageMetadata = (revision: Revision) => ({ id: revision.id, version: revision.version, source: { title: revision.source.title }, updatedAt: revision.updatedAt, sourceHash: revision.sourceHash });
  const load = (revision: Revision & { git?: z.infer<typeof ReactGitResultSchema> }, ticket: Ticket, message?: string) => dispatch({ type: 'load-result', revision, ticket, git: revision.git, page: pageMetadata(revision), message });
  const save = () => void run(async ticket => {
    const { source, apis, saved } = current.current;
    if (!ReactSourceSchema.safeParse(source).success || !ReactApiRefsSchema.safeParse(apis).success) throw new Error('화면 제목, 시작 파일, 파일 경로와 연결 자료 버전을 확인해 주세요. 파일은 최대 32개, 전체 내용은 180KB까지 저장할 수 있습니다.');
    const result = ReactPageMutationResponseSchema.parse(await request(saved ? `/${saved.id}` : '', saved ? 'PUT' : 'POST', { source, apis, expectedVersion: saved?.version || 0 }));
    if (!active(ticket)) return;
    dispatch({ type: 'saved', page: pageMetadata(result), ticket, revision: result, git: result.git, message: `버전 ${result.version}으로 저장했습니다. ${result.git?.status === 'complete' ? 'GitHub 커밋과 Draft PR도 생성했습니다.' : 'GitHub 전달 상태는 저장 이력에서 확인할 수 있습니다.'}` });
  });
  const preview = () => {
    const before = current.current, ticket = ticketFor(before, crypto.randomUUID());
    dispatch({ type: 'execution-start', ticket, remote: Boolean(capabilities?.remoteRuntime) });
    if (capabilities?.remoteRuntime) return;
    dispatch({ type: 'task-start', ticket });
    void request('/preview', 'POST', { source: before.source, apis: before.apis }).then(value => {
      if (active(ticket)) dispatch({ type: 'execution-compiled', ticket, artifact: ReactExecutionArtifactSchema.parse(value) });
    }).catch(reason => {
      if (!active(ticket) || rejectUnauthorized(reason)) return;
      const parsed = ReactDiagnosticSchema.array().max(MAX_REACT_DIAGNOSTICS).safeParse(reason?.details?.diagnostics);
      dispatch({ type: 'task-end', ticket, error: errorText(reason), diagnostics: parsed.success ? parsed.data : [] });
    }).finally(() => { if (active(ticket)) dispatch({ type: 'task-end', ticket }); });
  };
  const callApi = async (executionId: string, apiId: string, input: unknown) => {
    const relevant = () => mounted.current && (current.current.execution.visible?.executionId === executionId || candidateIsCurrent(current.current, executionId));
    if (!relevant()) throw new Error('현재 실행 화면의 요청이 아닙니다.');
    try {
      const result = await request(`/executions/${executionId}/call`, 'POST', { apiId, input });
      if (!relevant()) throw new Error('편집 또는 실행 대상이 바뀌어 이전 응답을 사용하지 않았습니다.');
      if (result.evidenceId) dispatch({ type: 'execution-evidence', executionId, apiId, evidenceId: result.evidenceId });
      return result;
    } catch (reason) { if (relevant() && !rejectUnauthorized(reason)) dispatch({ type: 'execution-error', executionId, message: errorText(reason) }); throw reason; }
  };
  const open = (id: string) => { if (mayLeave()) void run(async ticket => { const value = ReactRevisionSchema.parse(await request(`/${id}`)); if (active(ticket)) load(value, ticket); }); };
  const recover = (value: unknown) => { const checked = ReactPageMutationResponseSchema.safeParse(value); if (!checked.success || !mayLeave()) return false; load(checked.data, ticketFor(current.current, crypto.randomUUID()), '확인한 저장 결과를 불러왔습니다.'); return true; };
  const restore = (version: number) => { if (mayLeave()) void run(async ticket => { const saved = current.current.saved; if (!saved) return; const value = ReactPageMutationResponseSchema.parse(await request(`/${saved.id}/restore`, 'POST', { expectedVersion: saved.version, version })); if (!active(ticket)) return; load(value, ticket, `이전 원문을 새 버전 ${value.version}으로 복원했습니다.`); }); };
  const showHistory = () => void run(async ticket => { const saved = current.current.saved; if (!saved) return; const result = ReactHistorySchema.parse(await request(`/${saved.id}/versions`)); if (active(ticket)) dispatch({ type: 'history-loaded', ticket, history: result.items }); });
  const publish = () => void run(async ticket => { const saved = current.current.saved; if (!saved) return; const git = ReactGitResultSchema.parse(await request(`/${saved.id}/publish`, 'POST', { version: saved.version })); if (active(ticket)) dispatch({ type: 'git', ticket, git }); });
  return { state, dispatch, capabilities, pages, history, apis, dirty, busy: Boolean(state.task), evidence: visibleEvidence(state), save, preview, callApi, open, recover, restore, showHistory, publish, refreshApis, mayLeave, rejectUnauthorized, logout: () => { if (mayLeave()) void run(async () => { await signOut(); }); },
    newPage: () => { if (mayLeave()) { dispatch({ type: 'reset', code: capabilities?.example || '' }); } },
    canCommit: (id: string | number) => mounted.current && candidateIsCurrent(current.current, id) };
}
