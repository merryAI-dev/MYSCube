import { demo } from './client';
import { useState } from 'react';
import { ReactPreview } from './ReactPreview';
import { ApiRegistryPanel } from './ApiRegistryPanel';
import { BoundEvidence } from './BoundEvidence';
import { ReactConversationPanel } from './ReactConversationPanel';
import { RecoveryPanel } from './RecoveryPanel';
import { RemoteReactPreview } from './RemoteReactPreview';
import { draftIdentity } from './react-workspace-editor';
import { ReactWorkspaceEditor, ReactProposalReview } from './ReactWorkspaceEditor';
import { useReactStudio } from './useReactStudio';
const date = (value: string) => new Date(value).toLocaleString('ko-KR');

export function ReactStudio() {
  const studio = useReactStudio();
  const { state, dispatch, capabilities, pages, history, apis, busy, dirty, evidence } = studio;
  const { source, saved, apis: selected, execution, error, message, diagnostics, git } = state;
  const [tab, setTab] = useState<'make' | 'apis'>('make');
  const [view, setView] = useState<'preview' | 'source'>('preview');
  const [focusLocation, setFocusLocation] = useState<{ file: string; line: number; column: number; sequence: number } | null>(null);
  const runtimeAvailable = Boolean(capabilities?.remoteRuntime || capabilities?.runtimeUrl);
  const proposalTarget = state.target;
  const artifact = execution.artifact;
  return <div className="studio react-studio">
    <header className="studio-header"><div className="brand"><span className="eyebrow">MYSCube · AXR STUDIO</span><h1>나의 업무 공간</h1><p>자료를 묻고, 필요한 화면을 함께 만드세요.</p></div>
      <div className="header-actions"><a className="quiet" href="/?mode=operations" target="_blank" rel="noopener noreferrer">운영 기록 ↗</a><a className="quiet" href="/?mode=html">기존 HTML 화면</a><span role="status" className="save-state">{busy ? '처리 중…' : dirty ? '저장하지 않은 변경' : saved ? `저장됨 · 버전 ${saved.version}` : '새 화면'}</span>
        <button disabled={busy || execution.preparing || !runtimeAvailable} className="quiet" onClick={() => { setView('preview'); studio.preview(); }}>미리보기 적용</button><button disabled={busy} onClick={studio.save}>저장·PR 생성</button>{!demo && <button className="quiet" disabled={busy} onClick={studio.logout}>로그아웃</button>}</div>
    </header>
    <div className="studio-subnav"><nav className="canvas-tabs" aria-label="업무 공간 메뉴"><button className={tab === 'make' ? 'active' : ''} onClick={() => setTab('make')}>업무 만들기</button><button className={tab === 'apis' ? 'active' : ''} onClick={() => { dispatch({ type: 'execution-clear' }); setTab('apis'); }}>API 등록·관리</button></nav>
      <details className="studio-connection"><summary>연결 상태 · {runtimeAvailable ? '미리보기 사용 가능' : '미리보기 준비 중'}</summary>
        {!runtimeAvailable && <p>별도 실행 공간 연결 전입니다. 원문 편집과 저장은 사용할 수 있습니다.</p>}
        {capabilities?.runtimeMode === 'local-test' && <p>로컬 실행 검증 환경입니다. 운영 환경의 네트워크·자원 격리가 검증된 상태를 의미하지 않습니다.</p>}
        {!capabilities?.gitEnabled && <p>GitHub 전용 연결 설정 전입니다. 화면은 버전으로 저장되며 연결 후 같은 버전으로 PR 생성을 재시도할 수 있습니다.</p>}
        {capabilities?.gitEnabled && <p>저장한 원문을 GitHub에서 검토할 수 있습니다.</p>}
      </details>
    </div>
    {state.notice && <p className="notice" role="status">{state.notice}</p>}{message && <p className="notice studio-message" role="status">{message}</p>}{error && <p className="error" role="alert">{error}</p>}
    {diagnostics.length > 0 && <section className="notice" aria-label="React 파일 오류"><strong>수정할 위치를 확인해 주세요</strong><ul>{diagnostics.map((item, index) => <li key={index}><button className="quiet compact" disabled={!Object.hasOwn(source.workspace.files, item.file)} onClick={() => { setView('source'); dispatch({ type: 'select', path: item.file }); setFocusLocation({ ...item, sequence: Date.now() }); }}>{item.file} · {item.line}행 {item.column}열</button> {item.message}</li>)}</ul></section>}
    {tab === 'apis' ? <ApiRegistryPanel onChanged={() => { void studio.refreshApis(); }} /> : <div className="workspace">
      <aside className="library" aria-label="저장한 업무 화면"><div className="section-heading"><h2>나의 화면</h2><button className="quiet compact" disabled={busy} onClick={studio.newPage}>새 화면</button></div>
        {!pages.length && <p className="subtle">저장한 화면과 이전 버전을 이곳에서 다시 열 수 있습니다.</p>}{pages.map(item => <button className={`page-item ${item.id === saved?.id ? 'selected' : ''}`} key={item.id} disabled={busy} onClick={() => studio.open(item.id)}><strong>{item.source.title}</strong><small>버전 {item.version} · {date(item.updatedAt)}</small></button>)}
      </aside>
      <main className="studio-main"><section className="canvas-panel"><div className="canvas-toolbar"><div><h2>{source.title || '새 업무 화면'}</h2><span className="subtle">{execution.preparing ? '새 화면 확인 중…' : execution.visible ? '마지막으로 확인한 실행 화면' : '대화로 시작하거나 원문을 편집하세요'}</span></div><nav className="canvas-tabs" aria-label="화면 보기"><button className={view === 'preview' ? 'active' : ''} onClick={() => setView('preview')}>미리보기</button><button className={view === 'source' ? 'active' : ''} onClick={() => setView('source')}>원문·파일</button></nav></div>
        {execution.visible && execution.visible.identity !== draftIdentity(source, selected) && <p className="notice">현재 편집 내용과 실행 중인 버전이 다릅니다. ‘미리보기 적용’으로 확인해 주세요.</p>}
        <div hidden={view !== 'preview'} className="studio-preview-stage">
          {capabilities?.remoteRuntime ? <RemoteReactPreview key={`${state.target}:${execution.mount}`} draft={execution.remoteDraft} onPermissionError={studio.rejectUnauthorized} canCommit={studio.canCommit} onResult={result => dispatch({ type: 'execution-result', id: result.key, status: result.status, message: result.message })} /> : capabilities?.runtimeUrl ? <ReactPreview key={`${state.target}:${execution.mount}`} artifact={artifact} runtimeUrl={capabilities.runtimeUrl} canCommit={studio.canCommit} onApiCall={(apiId, input) => artifact?.executionId ? studio.callApi(artifact.executionId, apiId, input) : Promise.reject(new Error('실행 내용을 확인해 주세요.'))} onResult={result => { if (result.executionId) dispatch({ type: 'execution-result', id: result.executionId, status: result.status, message: result.message }); }} /> : <div className="preview-empty"><strong>어떤 업무를 도와드릴까요?</strong><span>오른쪽에서 자료를 묻거나 필요한 화면을 설명해 주세요.</span></div>}
          {!capabilities?.remoteRuntime && Object.keys(evidence).length > 0 && <BoundEvidence onPermissionError={studio.rejectUnauthorized} bindings={evidence} expectedQueries={execution.visible?.expectedQueries} />}
        </div>
        <div hidden={view !== 'source'}><ReactWorkspaceEditor state={state} dispatch={dispatch} disabled={false} focusLocation={focusLocation} /></div>
      </section>
      <aside className="studio-rail">{capabilities && <ReactConversationPanel onPermissionError={studio.rejectUnauthorized} modelEnabled={Boolean(capabilities.modelEnabled)} busy={busy} currentSource={source} apis={selected}
        onProposal={value => dispatch({ type: 'propose', value, target: proposalTarget })} onRestoreContext={value => { if (!studio.mayLeave()) return false; dispatch({ type: 'context', source: value.source, apis: value.apis }); dispatch({ type: 'message', message: '대화 당시 편집 내용과 연결 자료 버전을 불러왔습니다. 저장 전 내용을 확인해 주세요.' }); return true; }} />}
        {state.proposal && <section className="side-panel proposal-panel"><h2>변경 내용 검토</h2><ReactProposalReview state={state} dispatch={dispatch} disabled={busy} /></section>}
        <details className="side-panel studio-tools"><summary>연결 자료 · {selected.length}개</summary><p className="subtle">선택한 API 버전만 이 화면에서 조회할 수 있습니다.</p>
          {!apis.length && <p className="subtle">등록된 API가 없습니다. ‘API 등록·관리’에서 먼저 등록해 주세요.</p>}
          {apis.map(api => <label className="reference" key={api.id}><input type="checkbox" disabled={!api.definition.enabled && !selected.some(item => item.id === api.id)} checked={selected.some(item => item.id === api.id)} onChange={event => dispatch({ type: 'apis', value: event.target.checked ? [...selected, { id: api.id, version: api.version }] : selected.filter(item => item.id !== api.id) })} /><span>{api.definition.name} · 버전 {selected.find(item => item.id === api.id)?.version || api.version}{!api.definition.enabled && ' · 사용 중지'}<small>{api.definition.description}</small></span></label>)}
          {selected.filter(ref => !apis.some(api => api.id === ref.id)).map(ref => <p className="error" key={ref.id}>이전에 연결한 API를 현재 권한으로 확인할 수 없습니다. <button onClick={() => dispatch({ type: 'apis', value: selected.filter(item => item.id !== ref.id) })}>연결 해제</button></p>)}
        </details>
        <details className="side-panel studio-tools"><summary>저장 이력·GitHub·응답 복구</summary><p className="subtle">저장한 원문마다 별도 커밋과 Draft PR을 만듭니다. API 조회 결과는 전송하지 않습니다.</p>
          {git && <div role="status"><p>{git.status === 'complete' ? 'GitHub 전달 완료' : git.message || 'GitHub 전달 상태 확인 필요'}</p>{git.pullUrl && <a href={git.pullUrl} target="_blank" rel="noreferrer">Draft PR 열기 ↗</a>}{git.commitSha && <p className="hash">커밋 {git.commitSha}</p>}</div>}
          <div className="button-row"><button className="quiet" disabled={busy || !saved} onClick={studio.publish}>저장 버전 PR 확인·재시도</button><button className="quiet" disabled={busy || !saved} onClick={studio.showHistory}>버전 이력</button></div>
          {history.map(item => <div className="history-row" key={item.version}><span>버전 {item.version} · {date(item.updatedAt)}</span><button disabled={busy} onClick={() => studio.restore(item.version)}>버전 복원</button></div>)}
          <RecoveryPanel scope="react-page" disabled={busy} targetKey={String(state.target)} onRecovered={studio.recover} />
        </details>
      </aside></main>
    </div>}
  </div>;
}
