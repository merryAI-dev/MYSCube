import { useEffect, useState } from 'react';
import { workbenchRequest } from './client';

type Source = { title: string; html: string };
type EvidenceColumn = { name: string; type?: string; label?: string };
type Evidence = { evidenceId: string; columns: EvidenceColumn[]; rows: unknown[]; metadata?: Record<string, unknown>; sql?: string; normalizedSql?: string; coverage?: Record<string, unknown> | unknown[] };
type Proposal = { title: string; html: string; [key: string]: unknown };
type Clarification = { id: string; question: string; options?: Array<{ id: string; label: string }>; reason?: string };
type TurnResult = { status: 'answered' | 'clarification_required' | 'preview_ready'; answer: string; evidence?: Evidence[]; clarification?: Clarification; proposal?: Proposal };
type TurnError = { code: string; message: string };
type Turn = { id: string; sequence: number; state: 'pending' | 'completed' | 'failed'; message: string; result?: TurnResult; error?: TurnError; createdAt: string };
type Session = { id: string; title: string; version: number; updatedAt?: string; turns?: Turn[]; truncated?: boolean; historyNotice?: string };

export type ConversationPanelProps = {
  modelEnabled: boolean;
  busy?: boolean;
  currentSource: Source;
  onProposal: (proposal: Proposal) => void;
};

const formatTime = (value?: string) => value ? new Date(value).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const valueText = (value: unknown) => value === null || value === undefined ? '값 없음' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '표시할 수 없는 값';
const evidenceLabel: Record<string, string> = { definition: '계산 기준', resultScope: '표시 범위', limitations: '자료 해석 안내', query: '계산식', provenance: '출처', asOf: '기준 일자', capturedAt: '수집 시각', completeness: '자료 완전성', sql: '조회 조건', normalizedSql: '정리된 조회 조건' };
const displayMetadata = (evidence: Evidence) => {
  const fields: Array<[string, unknown]> = Object.entries(evidence.metadata || {});
  for (const key of ['sql', 'normalizedSql'] as const) if (evidence[key] !== undefined) fields.push([key, evidence[key]]);
  return fields.filter(([, value]) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null);
};

function CoverageValue({ value }: { value: unknown }) {
  if (Array.isArray(value)) return <ul>{value.map((item, index) => <li key={index}><CoverageValue value={item} /></li>)}</ul>;
  if (value && typeof value === 'object') return <dl>{Object.entries(value as Record<string, unknown>).map(([key, item]) => <div key={key}><dt>{evidenceLabel[key] || key}</dt><dd><CoverageValue value={item} /></dd></div>)}</dl>;
  return <>{valueText(value)}</>;
}

function CoverageDetails({ coverage }: { coverage?: Record<string, unknown> | unknown[] }) {
  if (!coverage || (Array.isArray(coverage) && !coverage.length) || (!Array.isArray(coverage) && !Object.keys(coverage).length)) return null;
  return <details className="evidence-coverage"><summary>조회 범위 확인</summary><CoverageValue value={coverage} /></details>;
}

function EvidenceView({ evidence }: { evidence: Evidence[] }) {
  return <div className="conversation-evidence">{evidence.map((item) => <section key={item.evidenceId} className="evidence-card">
    <p className="evidence-label">확인 근거 · {item.evidenceId}</p>
    {displayMetadata(item).length > 0 && <dl className="evidence-metadata">{displayMetadata(item).map(([key, value]) => <div key={key}><dt>{evidenceLabel[key] || key}</dt><dd>{valueText(value)}</dd></div>)}</dl>}
    <CoverageDetails coverage={item.coverage} />
    {item.columns.length > 0 ? <div className="evidence-table-wrap"><table><thead><tr>{item.columns.map((column) => <th key={column.name}>{column.label || column.name}{column.type ? <small> · {column.type}</small> : null}</th>)}</tr></thead><tbody>{item.rows.length > 0 ? item.rows.map((row, rowIndex) => {
      const record = asRecord(row); const values = Array.isArray(row) ? row : null;
      return <tr key={rowIndex}>{item.columns.map((column, columnIndex) => <td key={column.name}>{valueText(values ? values[columnIndex] : record[column.name])}</td>)}</tr>;
    }) : <tr><td colSpan={item.columns.length}>조회 결과가 없습니다.</td></tr>}</tbody></table></div> : <p className="subtle">표시할 열 정보가 없습니다.</p>}
  </section>)}</div>;
}

function TurnView({ turn, disabled, clarificationActive, onProposal, onClarification }: { turn: Turn; disabled: boolean; clarificationActive: boolean; onProposal: (proposal: Proposal) => void; onClarification: (option: string) => void }) {
  const result = turn.result;
  return <article className="conversation-turn"><p className="turn-question">{turn.message}</p>
    {turn.state === 'pending' && <p className="turn-pending" role="status">질문을 확인하고 있습니다.</p>}
    {turn.state === 'failed' && <p className="conversation-error" role="alert"><strong>{turn.error?.code || '요청 실패'}</strong> · {turn.error?.message || '요청을 처리하지 못했습니다. 기존 대화와 작업 내용은 유지합니다.'}</p>}
    {turn.state === 'completed' && result && <div className="turn-answer"><p>{result.answer}</p>{result.evidence && <EvidenceView evidence={result.evidence} />}
      {result.clarification && <section className="clarification" aria-label="추가 확인"><p><strong>{result.clarification.question}</strong>{result.clarification.reason ? <small>{result.clarification.reason}</small> : null}{!clarificationActive ? <small>이전 확인 질문입니다. 최신 질문 또는 입력창을 사용해 주세요.</small> : !result.clarification.options?.length ? <small>아래 입력창에 답변을 직접 작성해 주세요.</small> : null}</p>{result.clarification.options?.length ? <div className="clarification-options">{result.clarification.options.map((option) => <button key={option.id} className="quiet compact" disabled={disabled || !clarificationActive} onClick={() => onClarification(option.label)}>{option.label}</button>)}</div> : null}</section>}
      {result.proposal && <button className="quiet compact" disabled={disabled} onClick={() => onProposal(result.proposal!)}>제안 소스 검토하기</button>}
    </div>}
  </article>;
}

export function ConversationPanel({ modelEnabled, busy = false, currentSource, onProposal }: ConversationPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([]); const [session, setSession] = useState<Session | null>(null); const [message, setMessage] = useState(''); const [loading, setLoading] = useState(false); const [error, setError] = useState('');
  const disabled = busy || loading;
  const refreshList = async () => { const result = await workbenchRequest('/workbench-conversations'); setSessions((result.items || []).slice(0, 20)); };
  const hydrate = async (id: string) => { const canonical = await workbenchRequest(`/workbench-conversations/${id}`); setSession(canonical); return canonical as Session; };
  useEffect(() => { void refreshList().catch((reason) => setError(reason instanceof Error ? reason.message : '대화 목록을 불러오지 못했습니다.')); }, []);
  const open = async (id: string) => { setLoading(true); setError(''); try { await hydrate(id); } catch (reason) { setError(reason instanceof Error ? reason.message : '대화를 열지 못했습니다.'); } finally { setLoading(false); } };
  const create = async (title?: string): Promise<Session | null> => {
    if (!modelEnabled) { setError('AI 연결 설정 전입니다. 대화는 저장하거나 실행하지 않았습니다. HTML 직접 편집과 미리보기는 계속 이용할 수 있습니다.'); return null; }
    setLoading(true); setError('');
    try { const created = await workbenchRequest('/workbench-conversations', 'POST', { title: title?.slice(0, 80) }); const next: Session = { ...created, turns: [] }; setSession(next); await refreshList(); return next; }
    catch (reason) { setError(reason instanceof Error ? reason.message : '새 대화를 만들지 못했습니다.'); return null; }
    finally { setLoading(false); }
  };
  const send = async (providedMessage?: string) => {
    const input = (providedMessage || message).trim();
    if (!input || disabled) return;
    if (!modelEnabled) { setError('AI 연결 설정 전입니다. 메시지는 저장하거나 처리하지 않았습니다. HTML을 직접 편집해 주세요.'); return; }
    let active = session;
    if (!active) active = await create(input);
    if (!active) return;
    setLoading(true); setError('');
    try {
      await workbenchRequest(`/workbench-conversations/${active.id}/turns`, 'POST', { expectedVersion: active.version, requestId: crypto.randomUUID(), message: input, currentSource });
      await hydrate(active.id);
      await refreshList();
      setMessage('');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '대화 요청을 처리하지 못했습니다. 기존 소스와 대화는 유지합니다.'); }
    finally { setLoading(false); }
  };
  return <section className="conversation-panel" aria-label="업무 대화"><div className="section-heading"><div><p className="section-kicker">CONVERSATION</p><h2>업무 대화</h2></div><button className="quiet compact" disabled={disabled} onClick={() => void create()}>새 대화</button></div><p className="subtle">질문을 이어서 남기면, 확인 근거와 필요한 추가 질문을 같은 대화에서 확인할 수 있습니다.</p>
    {!modelEnabled && <p className="conversation-disabled" role="status">AI 연결 설정 전입니다. 대화는 저장·실행되지 않으며 HTML 직접 편집과 미리보기는 계속 이용할 수 있습니다.</p>}
    {error && <p className="conversation-error" role="alert">{error}</p>}
    <div className="conversation-layout"><nav className="conversation-list" aria-label="대화 목록">{sessions.length === 0 && <p className="subtle">새 대화를 시작하면 최근 대화가 여기에 표시됩니다.</p>}{sessions.map((item) => <button key={item.id} className={session?.id === item.id ? 'selected' : ''} disabled={disabled} onClick={() => void open(item.id)}><strong>{item.title || '새 대화'}</strong><small>{formatTime(item.updatedAt)}</small></button>)}</nav><div className="conversation-thread">{session?.turns?.length ? session.turns.map((turn, index, turns) => <TurnView key={turn.id} turn={turn} disabled={disabled} clarificationActive={index === turns.length - 1 && turn.state === 'completed' && turn.result?.status === 'clarification_required'} onProposal={onProposal} onClarification={(option) => void send(option)} />) : <p className="conversation-empty">{session ? '첫 질문을 입력해 주세요.' : '새 대화를 시작하거나 질문을 입력해 주세요.'}</p>}{session?.truncated && <p className="subtle">{session.historyNotice || '최근 20개 대화 턴만 표시합니다. 이전 내용은 대화 기록에 안전하게 보관됩니다.'}</p>}</div></div>
    <div className="conversation-compose"><textarea aria-label="업무 대화 입력" value={message} disabled={disabled || !modelEnabled} onChange={(event) => setMessage(event.target.value)} placeholder="예: 9월 주정산을 하지 않은 곳을 CIC별로 보여줘" /><button disabled={disabled || !message.trim() || !modelEnabled} onClick={() => void send()}>{loading ? '확인 중…' : '질문 보내기'}</button></div>
  </section>;
}
