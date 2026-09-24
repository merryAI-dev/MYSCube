import type { ScreenQueryExpectation } from './screen-evidence';
import { useEffect, useRef, useState } from 'react';
import { workbenchRequest } from './client';

import { draftIdentity, type ReactSource as Source, type ApiRef, type SourceProposal } from './react-workspace-editor';
type Mode = 'react' | 'analysis' | 'auto';
type Clarification = { id: string; mode?: Mode; question: string; reason?: string; options?: Array<{ id: string; label: string }> };
type Result = { type?: 'source' | 'clarification' | 'answer'; mode?: Mode; answer: string; source?: Source; apis?: ApiRef[]; baseEditorIdentity?: string; screenBindings?: ScreenQueryExpectation[]; clarification?: Clarification;
  evidence?: Array<{ evidenceId: string; columns: Array<{ name: string; label?: string }>; rows: Array<Record<string, unknown>>; metadata?: Record<string, unknown> }>; proposal?: { html?: string } };
type Turn = { id: string; state: string; message: string; result?: Result; error?: { message: string } };
type Session = { id: string; title: string; version: number; turns?: Turn[]; lastMode?: Mode; truncated?: boolean; pendingClarification?: Clarification | null; reactContext?: { source?: Source; sourceHash?: string; apis: ApiRef[] } | null };
type Props = { modelEnabled: boolean; busy: boolean; currentSource: Source; apis: ApiRef[]; onPermissionError?: (reason: unknown) => void; onProposal: (proposal: SourceProposal) => void; onRestoreContext: (context: { source: Source; apis: ApiRef[] }) => boolean };
const request = (path: string, method = 'GET', body?: unknown) => workbenchRequest(`/react-work-pages/conversations${path}`, method, body);
const display = (value: unknown) => value == null ? '확인 필요' : typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '상세 자료';

export function ReactConversationPanel({ modelEnabled, busy, currentSource, apis, onProposal, onRestoreContext, onPermissionError }: Props) {
  const [sessions, setSessions] = useState<Session[]>([]), [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState('등록한 API로 조회하고 월과 주차를 선택할 수 있는 업무 화면을 만들어 주세요. 확인되지 않은 수치는 확인 필요로 보여 주세요.'), [loading, setLoading] = useState(false), [error, setError] = useState('');
  const generation = useRef(0), working = useRef(false), mounted = useRef(true);
  const editor = draftIdentity(currentSource, apis);
  const editorRef = useRef(editor); editorRef.current = editor;
  const [storedContext, setStoredContext] = useState<{ sessionId: string; editor: string } | null>(null);
  const usingStoredContext = Boolean(session && storedContext?.sessionId === session.id && storedContext.editor === editor);
  const disabled = busy || loading;
  const refreshList = async () => { const at = generation.current; const list = await request(''); if (mounted.current && at === generation.current) setSessions(list.items || []); };
  const authorizationFailure = (reason: unknown) => {
    if (![401, 403].includes(Number((reason as { status?: number })?.status))) return false;
    generation.current++; working.current = false; setLoading(false); setSessions([]); setSession(null); setStoredContext(null);
    setError('조회 권한을 확인하지 못해 이전 대화와 근거를 숨겼습니다. 편집 내용과 저장 요청은 유지됩니다.'); onPermissionError?.(reason); return true;
  };
  const rememberUrl = (id: string | null) => { const url = new URL(location.href); if (id) url.searchParams.set('conversation', id); else url.searchParams.delete('conversation'); history.replaceState(history.state, '', url); };
  const hydrate = async (id: string, at: number, reopen = false) => { const value: Session = await request(`/${id}`); if (mounted.current && at === generation.current) { setSession(value); rememberUrl(id); if (reopen) setStoredContext(value.reactContext ? { sessionId: id, editor: editorRef.current } : null); } return value; };
  useEffect(() => {
    mounted.current = true;
    const at = generation.current, id = new URLSearchParams(location.search).get('conversation');
    void refreshList().catch((reason) => { if (mounted.current && !authorizationFailure(reason)) setError(reason.message); });
    if (id && /^[a-f0-9-]{36}$/i.test(id)) { setLoading(true); void hydrate(id, at, true).catch((reason) => { if (mounted.current && !authorizationFailure(reason)) setError(reason.message); }).finally(() => { if (mounted.current) setLoading(false); }); }
    return () => { mounted.current = false; generation.current++; };
  }, []);
  const open = async (id: string) => {
    if (working.current || disabled) return; const at = ++generation.current; working.current = true; setLoading(true); setError('');
    try { await hydrate(id, at, true); }
    catch (reason) { if (mounted.current && generation.current === at && !authorizationFailure(reason)) setError(reason instanceof Error ? reason.message : '대화를 열지 못했습니다.'); }
    finally { working.current = false; if (mounted.current && generation.current === at) setLoading(false); }
  };
  const newConversation = () => { if (working.current || disabled) return; generation.current++; setSession(null); setStoredContext(null); setMessage(''); setError(''); rememberUrl(null); };
  const send = async (answer?: string, clarificationId?: string) => {
    const text = (answer || message).trim(); if (!text || working.current || disabled || !modelEnabled) return;
    working.current = true; setLoading(true); setError(''); const at = generation.current;
    let active = session;
    try {
      if (!active) { const created = await request('', 'POST', { title: text.slice(0, 80) }); active = { ...created, turns: [] }; if (mounted.current && generation.current === at) { setSession(active); rememberUrl(active!.id); } }
      const response = await request(`/${active!.id}/turns`, 'POST', { expectedVersion: active!.version, requestId: crypto.randomUUID(), message: text, mode: 'auto', ...(!usingStoredContext ? { currentSource, apis } : {}), ...(clarificationId ? { clarificationId } : {}) });
      if (!mounted.current || generation.current !== at) return;
      await hydrate(active!.id, at); await refreshList();
      if (!mounted.current || generation.current !== at) return;
      setMessage(''); if (response.result?.type === 'source' && response.result.source) onProposal({ source: response.result.source, apis: response.result.apis, baseEditorIdentity: response.result.baseEditorIdentity, screenBindings: response.result.screenBindings });
    } catch (reason) {
      if (mounted.current && generation.current === at) {
        if (authorizationFailure(reason)) return;
        setError(reason instanceof Error ? reason.message : '대화를 완료하지 못했습니다. 편집 내용은 유지됩니다.');
        if (active) await hydrate(active.id, at).catch(() => {});
      }
    } finally { working.current = false; if (mounted.current && generation.current === at) setLoading(false); }
  };
  return <section className="side-panel conversation-panel" aria-label="업무 대화">
    <div className="section-heading"><h2>업무 도우미</h2><button className="quiet compact" disabled={disabled} onClick={newConversation}>새 대화</button></div>
    <p className="subtle">자료 질문과 화면 제작을 같은 대화에서 이어갑니다. 화면 변경은 검토한 뒤 적용합니다.</p>
    <label>저장된 대화<select style={{ width: '100%', minWidth: 0 }} aria-label="저장된 제작 대화" value={session?.id || ''} disabled={disabled} onChange={(event) => { if (event.target.value) void open(event.target.value); else newConversation(); }}><option value="">새 대화</option>{sessions.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    {session && <div className="actions"><button className="quiet compact" disabled={disabled} onClick={() => void open(session.id)}>저장된 대화 다시 확인</button>{session.reactContext?.source && <button className="quiet compact" disabled={disabled} onClick={() => onRestoreContext({ source: session.reactContext!.source!, apis: session.reactContext!.apis })}>대화 당시 편집 내용 불러오기</button>}</div>}
    {usingStoredContext && <p className="notice">이 대화에 저장된 코드와 API 버전을 기준으로 이어갑니다. 현재 편집 내용으로 바꾸려면 <button className="quiet compact" disabled={disabled} onClick={() => setStoredContext(null)}>현재 편집 내용으로 대화하기</button>를 눌러 주세요.</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="conversation-thread">{session?.turns?.map((turn, index) => <article key={turn.id} className="conversation-turn">
      <p className="turn-question">{turn.message}</p>{turn.state === 'pending' && <p role="status">이 요청을 처리하고 있습니다. 잠시 후 ‘저장된 대화 다시 확인’을 눌러 주세요.</p>}
      {turn.state === 'failed' && <p role="alert" className="error">{turn.error?.message || '요청을 완료하지 못했습니다.'}</p>}
      {turn.result && <><p className="turn-answer">{turn.result.answer}</p>
        {turn.result.clarification && <section className="clarification" aria-label="제작 추가 확인"><strong>{turn.result.clarification.question}</strong>{turn.result.clarification.reason && <p className="subtle">{turn.result.clarification.reason}</p>}
          <div className="actions">{turn.result.clarification.options?.map((option) => <button className="quiet compact" key={option.id} disabled={disabled || index !== session.turns!.length - 1 || session.pendingClarification?.id !== turn.result!.clarification!.id} onClick={() => void send(option.label, turn.result!.clarification!.id)}>{option.label}</button>)}</div><small>입력창에 직접 답변해도 됩니다. 이전 질문의 선택지는 다시 사용하지 않습니다.</small></section>}
        {turn.result.source && !turn.result.baseEditorIdentity && <p className="notice">이전 방식으로 생성한 제안은 현재 편집 내용과 비교할 기준이 없습니다. 현재 편집 내용으로 다시 생성해 주세요.</p>}
        {turn.result.source && <button className="quiet compact" disabled={disabled} onClick={() => onProposal({ source: turn.result!.source!, apis: turn.result!.apis, baseEditorIdentity: turn.result!.baseEditorIdentity, screenBindings: turn.result!.screenBindings })}>이 화면 제안 검토하기</button>}
        {turn.result.evidence?.map((item) => <details key={item.evidenceId} className="evidence-card"><summary>확인한 자료와 조회 범위</summary><p>{display(item.metadata?.resultScope)} · {display(item.metadata?.asOf)} · {display(item.metadata?.completeness)}</p><div className="evidence-table-wrap"><table><thead><tr>{item.columns.map((column) => <th key={column.name}>{column.label || column.name}</th>)}</tr></thead><tbody>{item.rows.slice(0, 20).map((row, rowIndex) => <tr key={rowIndex}>{item.columns.map((column) => <td key={column.name}>{display(row[column.name])}</td>)}</tr>)}</tbody></table></div>{item.rows.length > 20 && <p>처음 20행을 표시합니다. 조회 범위를 좁혀 이어서 질문해 주세요.</p>}</details>)}
        {turn.result.proposal?.html && <p className="subtle">이 대화에는 HTML 화면 제안도 저장되어 있습니다. HTML 제작 공간의 같은 대화에서 확인할 수 있습니다.</p>}
      </>}
    </article>)}</div>
    {session?.truncated && <p className="subtle">최근 20차례, 합계 1.8MB 이내의 대화를 표시합니다. 이전 대화도 서버에 보존됩니다.</p>}
    <textarea className="prompt" aria-label="업무 요청" disabled={disabled || !modelEnabled} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="이번 주 입금액은 얼마인가요? 확인한 자료로 월별 화면도 만들어 주세요." />
    <button disabled={disabled || !modelEnabled || !message.trim()} onClick={() => void send()}>{loading ? '대화를 처리하고 있습니다…' : '보내기'}</button>
    {!modelEnabled && <p className="subtle">AI 연결 설정 전입니다. 저장된 대화 확인과 직접 소스 편집은 계속 사용할 수 있습니다.</p>}
  </section>;
}
