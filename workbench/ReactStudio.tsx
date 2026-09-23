import { useEffect, useRef, useState } from 'react';
import { workbenchRequest } from './client';
import { ReactPreview, type ReactPreviewResult } from './ReactPreview';
import { ApiRegistryPanel } from './ApiRegistryPanel';
import { BoundEvidence } from './BoundEvidence';
import { ReactConversationPanel } from './ReactConversationPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { RemoteReactPreview, type RemoteDraft, type RemotePreviewResult } from './RemoteReactPreview';

type Source = { title: string; code: string };
type ApiRef = { id: string; version: number };
type Artifact = { bundle: string; css: string; sourceHash: string; bundleHash: string; cssHash: string; runtimeVersion: string; packageSetHash: string; dependencies: Array<{ name: string; version: string }>; executionId: string };
type EvidenceBindings = Record<string, { evidenceId: string; kind: 'table' }>;
type Revision = { id: string; version: number; source: Source; apis: ApiRef[]; sourceHash: string; artifact: Artifact; updatedAt: string };
type GitResult = { status: string; pullUrl?: string; commitSha?: string; message?: string };
type Api = ApiRef & { definition: { name: string; enabled: boolean; description: string } };
const request = (path: string, method = 'GET', body?: unknown) => workbenchRequest(`/react-work-pages${path}`, method, body);
const empty = { title: '나의 React 업무 화면', code: '' };
const date = (value: string) => new Date(value).toLocaleString('ko-KR');

export function ReactStudio() {
  const [source, setSource] = useState<Source>(empty);
  const [saved, setSaved] = useState<Revision | null>(null);
  const [pages, setPages] = useState<Revision[]>([]);
  const [apis, setApis] = useState<Api[]>([]);
  const [selected, setSelected] = useState<ApiRef[]>([]);
  const [history, setHistory] = useState<Revision[]>([]);
  const [preview, setPreview] = useState<Artifact | null>(null);
  const [previewSource, setPreviewSource] = useState('');
  const [remoteDraft, setRemoteDraft] = useState<RemoteDraft | null>(null), [remotePreparing, setRemotePreparing] = useState(false);
  const remoteKey = useRef(0);
  const [proposal, setProposal] = useState<{ source: Source } | null>(null);
  const [capabilities, setCapabilities] = useState<{ modelEnabled: boolean; gitEnabled: boolean; gitRepository: string | null; runtimeUrl: string | null; remoteRuntime?: boolean; runtimeMode: string; example: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [git, setGit] = useState<GitResult | null>(null);
  const [tab, setTab] = useState<'make' | 'apis'>('make');
  const [evidence, setEvidence] = useState<EvidenceBindings>({});
  const executionGeneration = useRef(0);
  const editorTarget = useRef(0);
  const executions = useRef<{ visible: string | null; target: string | null; evidence: Map<string, EvidenceBindings> }>({ visible: null, target: null, evidence: new Map() });
  const retainExecutions = () => { const state = executions.current; for (const id of state.evidence.keys()) if (id !== state.visible && id !== state.target) state.evidence.delete(id); };
  const clearExecutions = () => { remoteKey.current++; setRemoteDraft(null); setRemotePreparing(false); setPreviewSource(''); executionGeneration.current++; executions.current = { visible: null, target: null, evidence: new Map() }; setEvidence({}); };
  useEffect(() => () => { executionGeneration.current++; executions.current = { visible: null, target: null, evidence: new Map() }; }, []);
  const dirty = saved ? JSON.stringify(source) !== JSON.stringify(saved.source) || JSON.stringify(selected) !== JSON.stringify(saved.apis) : source.code !== capabilities?.example || source.title !== empty.title || selected.length > 0;
  const refreshApis = async () => { const result = await workbenchRequest('/workbench-apis'); setApis(result.items); };
  useEffect(() => {
    let active = true; setBusy(true);
    void Promise.all([request('/capabilities'), request(''), workbenchRequest('/workbench-apis')]).then(([caps, list, registered]) => {
      if (!active) return; setCapabilities(caps); setPages(list.items); setApis(registered.items); setSource({ ...empty, code: caps.example });
    }).catch((reason) => { if (active) setError(reason.message); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => { const handler = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); }; window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler); }, [dirty]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (reason) { setError(reason instanceof Error ? reason.message : '요청을 완료하지 못했습니다.'); } finally { setBusy(false); } };
  const mayLeave = () => !dirty || window.confirm('저장하지 않은 React 변경이 있습니다. 변경을 버리고 이동할까요?');
  const load = (value: Revision) => { editorTarget.current++; clearExecutions(); setSaved(value); setSource(value.source); setSelected(value.apis); setHistory([]); setProposal(null); setPreview(null); setGit(null); };
  const remember = (value: Revision & { git?: GitResult }) => { setSaved(value); setSource(value.source); setSelected(value.apis); setPages((items) => [value, ...items.filter((item) => item.id !== value.id)]); setGit(value.git || null); };
  const applyPreview = () => {
    if (capabilities?.remoteRuntime) { setError(''); setRemoteDraft({ source: { ...source }, apis: selected.map((api) => ({ ...api })), key: ++remoteKey.current }); return; }
    void run(async () => {
      const generation = executionGeneration.current;
      const result = await request('/preview', 'POST', { source, apis: selected }); if (executionGeneration.current !== generation) return;
      executions.current.target = result.executionId; retainExecutions(); setPreview(result); setPreviewSource(JSON.stringify({ source, selected })); setMessage('새 React 실행 결과를 확인하고 있습니다.');
    });
  };
  const save = () => void run(async () => {
    const result = await request(saved ? `/${saved.id}` : '', saved ? 'PUT' : 'POST', { source, apis: selected, expectedVersion: saved?.version || 0 });
    remember(result); setMessage(`버전 ${result.version}으로 저장했습니다. ${result.git?.status === 'complete' ? 'GitHub 커밋과 Draft PR도 생성했습니다.' : 'GitHub 전달 상태를 확인해 주세요.'}`);
  });
  const callback = preview ? async (apiId: string, input: unknown) => {
    const id = preview.executionId;
    const relevant = () => executions.current.visible === id || executions.current.target === id;
    try {
      const result = await request(`/executions/${id}/call`, 'POST', { apiId, input });
      if (relevant() && result.evidenceId) {
        const bindings: EvidenceBindings = { ...executions.current.evidence.get(id), [apiId]: { evidenceId: result.evidenceId, kind: 'table' } };
        executions.current.evidence.set(id, bindings);
        if (executions.current.visible === id) setEvidence(bindings);
      }
      return result;
    } catch (reason) {
      if (relevant()) {
        executions.current.evidence.delete(id);
        if (executions.current.visible === id) { setEvidence({}); setError(reason instanceof Error ? reason.message : 'API 조회를 완료하지 못했습니다.'); }
      }
      throw reason;
    }
  } : undefined;
  const previewGeneration = executionGeneration.current;
  const proposalTarget = editorTarget.current;
  const previewResult = (result: ReactPreviewResult) => {
    const id = result.executionId, state = executions.current;
    if (!id || executionGeneration.current !== previewGeneration) return;
    if (result.status === 'ready') {
      state.visible = id; if (state.target === id) state.target = null;
      retainExecutions(); setEvidence(state.evidence.get(id) || {}); setMessage('React 화면이 실행되었습니다. 버튼과 필터를 확인한 뒤 저장해 주세요.');
    } else {
      if (id !== state.target && id !== state.visible) return;
      if (state.target === id) state.target = null;
      state.evidence.delete(id); if (state.visible === id) { state.visible = null; setEvidence({}); } retainExecutions();
      if (result.message) setError(result.message);
    }
  };
  const remoteResult = (result: RemotePreviewResult) => {
    if (!remoteDraft || remoteDraft.key !== result.key || remoteKey.current !== result.key) return;
    if (result.status === 'ready') { setPreviewSource(JSON.stringify({ source: remoteDraft.source, selected: remoteDraft.apis })); setMessage('별도 실행 공간에서 React 화면을 확인했습니다. 변경한 코드는 저장 전 검토해 주세요.'); }
    else if (result.message) setError(result.message);
  };
  const runtimeAvailable = Boolean(capabilities?.remoteRuntime || capabilities?.runtimeUrl);
  return <div className="studio react-studio">
    <header className="studio-header"><div className="brand"><span className="eyebrow">MYSCube · AXR STUDIO</span><h1>React 업무 화면 제작</h1><p>요청에서 실행 가능한 화면으로. 저장한 소스와 검토할 PR을 함께 관리합니다.</p></div>
      <div className="header-actions"><a className="quiet" href="/">HTML 제작 공간</a><span role="status" className="save-state">{busy ? '처리 중…' : dirty ? '저장하지 않은 변경' : saved ? `저장됨 · 버전 ${saved.version}` : '새 화면'}</span>
        <button disabled={busy || remotePreparing || !runtimeAvailable} className="quiet" onClick={applyPreview}>React 미리보기 적용</button><button disabled={busy} onClick={save}>React 저장·PR 생성</button></div>
    </header>
    {!runtimeAvailable && <p className="notice">별도 React 실행 공간 연결 전입니다. 소스 편집·컴파일·저장은 사용할 수 있습니다.</p>}
    {capabilities?.runtimeMode === 'local-test' && <p className="notice">로컬 실행 검증 환경입니다. 운영 환경의 네트워크·자원 격리가 검증된 상태를 의미하지 않습니다.</p>}
    {!capabilities?.gitEnabled && <p className="notice">GitHub 전용 연결 설정 전입니다. 화면은 버전으로 저장되며 연결 후 같은 버전으로 PR 생성을 재시도할 수 있습니다.</p>}
    <RecoveryPanel scope="react-page" onRecovered={(value) => { if (!value || typeof value !== 'object' || !('source' in value) || !('artifact' in value) || !('id' in value) || typeof (value as Revision).source?.code !== 'string' || !mayLeave()) return false; load(value as Revision); setMessage('확인한 저장 결과를 불러왔습니다.'); return true; }} />
    {message && <p className="notice" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
    <nav className="canvas-tabs" aria-label="React 제작 메뉴"><button className={tab === 'make' ? 'active' : ''} onClick={() => setTab('make')}>화면 만들기</button><button className={tab === 'apis' ? 'active' : ''} onClick={() => { clearExecutions(); setPreview(null); setTab('apis'); }}>API 등록·관리</button></nav>
    {tab === 'apis' ? <ApiRegistryPanel onChanged={() => { void refreshApis().catch((reason) => setError(reason.message)); }} /> : <div className="workspace">
      <aside className="library" aria-label="저장한 React 화면"><div className="section-heading"><h2>나의 화면</h2><button className="quiet compact" disabled={busy} onClick={() => { if (mayLeave()) { editorTarget.current++; clearExecutions(); setSaved(null); setSource({ ...empty, code: capabilities?.example || '' }); setSelected([]); setPreview(null); setProposal(null); setGit(null); setHistory([]); } }}>새 React 화면</button></div>
        {!pages.length && <p className="subtle">저장하면 다시 열고 이전 버전으로 복원할 수 있습니다.</p>}{pages.map((item) => <button className={`page-item ${item.id === saved?.id ? 'selected' : ''}`} key={item.id} disabled={busy} onClick={() => { if (mayLeave()) void run(async () => load(await request(`/${item.id}`))); }}><strong>{item.source.title}</strong><small>버전 {item.version} · {date(item.updatedAt)}</small></button>)}
      </aside>
      <main className="studio-main"><section className="canvas-panel"><div className="canvas-toolbar"><h2>실행 화면</h2><span className="badge">등록한 읽기 API만 연결</span></div>
        {previewSource && previewSource !== JSON.stringify({ source, selected }) && <p className="notice">현재 편집 내용과 실행 중인 버전이 다릅니다. ‘React 미리보기 적용’으로 확인해 주세요.</p>}
        {!capabilities?.remoteRuntime && Object.keys(evidence).length > 0 && <BoundEvidence bindings={evidence} />}
        {capabilities?.remoteRuntime ? <RemoteReactPreview draft={remoteDraft} onResult={remoteResult} onPreparing={setRemotePreparing} /> : preview && capabilities?.runtimeUrl && callback ? <ReactPreview artifact={preview} runtimeUrl={capabilities.runtimeUrl} onApiCall={callback} onResult={previewResult} /> : <div className="preview-empty"><strong>실행할 준비가 되었습니다</strong><span>React 코드를 작성하거나 AI에 요청한 뒤 미리보기를 적용하세요.</span></div>}
        <details className="react-source-editor" open><summary>App.tsx 소스 보기·편집</summary><fieldset disabled={busy}><label>React 화면 제목<input value={source.title} maxLength={80} onChange={(event) => setSource({ ...source, title: event.target.value })} /></label><label>React 원문<textarea className="code" spellCheck={false} value={source.code} onChange={(event) => setSource({ ...source, code: event.target.value })} /></label></fieldset></details>
      </section>
      <aside className="studio-rail">{capabilities && <ReactConversationPanel modelEnabled={Boolean(capabilities?.modelEnabled)} busy={busy} currentSource={source} apis={selected}
        onProposal={(value) => { if (proposalTarget === editorTarget.current) setProposal(value); }} onRestoreContext={(value) => { if (!mayLeave()) return false; clearExecutions(); setSource(value.source); setSelected(value.apis); setPreview(null); setProposal(null); setMessage('대화 당시 편집 내용과 연결 API 버전을 불러왔습니다. 저장 전 내용을 확인해 주세요.'); return true; }} />}
      <section className="side-panel"><h2>소스 제안 검토</h2>
        {proposal && <section className="proposal"><h3>{proposal.source.title}</h3><pre>{proposal.source.code}</pre><button disabled={busy} onClick={() => { setSource(proposal.source); setProposal(null); }}>React 제안 적용</button><button className="quiet" onClick={() => setProposal(null)}>제안 닫기</button></section>}
      </section><section className="side-panel"><h2>연결할 API</h2><p className="subtle">선택한 API 버전만 이 화면에서 조회할 수 있습니다.</p>
        {!apis.length && <p>등록된 API가 없습니다. ‘API 등록·관리’에서 먼저 등록해 주세요.</p>}
        {apis.map((api) => <label className="reference" key={api.id}><input type="checkbox" disabled={busy || !api.definition.enabled && !selected.some((item) => item.id === api.id)} checked={selected.some((item) => item.id === api.id)} onChange={(event) => setSelected((refs) => event.target.checked ? [...refs, { id: api.id, version: api.version }] : refs.filter((item) => item.id !== api.id))} /><span>{api.definition.name} · 버전 {selected.find((item) => item.id === api.id)?.version || api.version}{!api.definition.enabled && ' · 사용 중지'}<small>{api.definition.description}</small></span></label>)}
        {selected.filter((ref) => !apis.some((api) => api.id === ref.id)).map((ref) => <p className="error" key={ref.id}>이전에 연결한 API를 현재 권한으로 확인할 수 없습니다. <button onClick={() => setSelected((refs) => refs.filter((item) => item.id !== ref.id))}>연결 해제</button></p>)}
      </section><section className="side-panel"><h2>저장 버전·GitHub</h2><p className="subtle">저장한 원문마다 별도 커밋과 Draft PR을 만듭니다. API 조회 결과는 Git 전송 대상에 추가하지 않습니다.</p>
        {git && <div role="status"><p>{git.status === 'complete' ? 'GitHub 전달 완료' : git.message || 'GitHub 전달 상태 확인 필요'}</p>{git.pullUrl && <a href={git.pullUrl} target="_blank" rel="noreferrer">Draft PR 열기 ↗</a>}{git.commitSha && <p className="hash">커밋 {git.commitSha}</p>}</div>}
        <div className="button-row"><button className="quiet" disabled={busy || !saved} onClick={() => void run(async () => setGit(await request(`/${saved!.id}/publish`, 'POST', { version: saved!.version })))}>저장 버전 PR 확인·재시도</button><button className="quiet" disabled={busy || !saved} onClick={() => void run(async () => setHistory((await request(`/${saved!.id}/versions`)).items))}>React 버전 이력</button></div>
        {history.map((item) => <div className="history-row" key={item.version}><span>버전 {item.version} · {date(item.updatedAt)}</span><button disabled={busy} onClick={() => { if (mayLeave()) void run(async () => { const result = await request(`/${saved!.id}/restore`, 'POST', { expectedVersion: saved!.version, version: item.version }); load(result); remember(result); setMessage(`이전 원문을 새 버전 ${result.version}으로 복원했습니다.`); }); }}>React 버전 복원</button></div>)}
      </section></aside></main>
    </div>}
  </div>;
}
