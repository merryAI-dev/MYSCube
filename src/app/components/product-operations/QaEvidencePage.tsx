import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { useWorkbench } from './useWorkbench';
import type { QaResult } from '../../lib/workbench-client';
export function QaEvidencePage() {
  const { ready, isAdmin, scope } = useWorkbench();
  if (!ready) return <p className="p-6">로그인 정보 확인 중…</p>;
  if (!isAdmin) return <p className="p-6">운영 관리자만 로그와 코드 근거를 확인할 수 있습니다.</p>;
  return <Content key={scope} />;
}
function Content() {
  const { client } = useWorkbench();
  const [modelEnabled, setModelEnabled] = useState(false);
  const [modelAnswer, setModelAnswer] = useState('');
  useEffect(() => { let active = true; void client.capabilities().then((value) => { if (active) setModelEnabled(value.modelEnabled); }, () => {}); return () => { active = false; }; }, [client]);
  const [question, setQuestion] = useState('저장에 실패한 원인과 확인할 코드를 알려주세요.');
  const [area, setArea] = useState('draft'); const [requestId, setRequestId] = useState('');
  const [result, setResult] = useState<QaResult | null>(null); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setResult(null); setModelAnswer(''); setBusy(false); return () => { sequence.current++; }; }, [client, question, area, requestId]);
  const query = async (eventId?: string, cursor?: string) => {
    if (busy || !question.trim()) return;
    const current = ++sequence.current; setBusy(true); setError('');
    try { const value = await client.qa({ question, area, ...(requestId ? { requestId } : {}), ...(eventId ? { eventId } : {}), ...(cursor ? { cursor } : {}) }); if (current === sequence.current) setResult(value); }
    catch (err) { if (current === sequence.current) setError(err instanceof Error ? err.message : '근거 조회 실패'); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  return <div className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6"><h1 className="text-xl font-bold">로그·GitHub QA</h1><p className="text-sm text-muted-foreground">실제 오류 기록과 해당 버전의 GitHub 코드를 함께 확인합니다. 이 화면은 근거를 정리하는 조회 기능입니다. AI 추론이나 원인 확정 결과가 아닙니다.</p>
    <fieldset disabled={busy} className="space-y-3 rounded-xl border p-4"><label className="block text-sm">확인할 질문<Textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={1000} /></label><div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">업무 종류<select className="mt-1 w-full rounded border p-2" value={area} onChange={(e) => setArea(e.target.value)}><option value="draft">임시저장</option><option value="approval">프로젝트 승인</option><option value="cashflow">현금흐름</option><option value="frontend">화면·API 호출</option></select></label><label className="text-sm">실패 요청 번호 (선택)<Input value={requestId} onChange={(e) => setRequestId(e.target.value)} maxLength={100} /></label></div><Button onClick={() => void query()}>{busy ? '근거 조회 중…' : '로그와 코드 확인'}</Button></fieldset>
    <div className="space-y-2"><Button variant="outline" disabled={!modelEnabled || busy || !result} onClick={async () => {
      const current = ++sequence.current; setBusy(true); setError('');
      try { const value = await client.askQa({ question, area, ...(requestId ? { requestId } : {}), ...(result?.logs.length === 1 ? { eventId: result.logs[0].id } : {}) }); if (current === sequence.current) setModelAnswer(`${value.answer}\n\n답변 상태: ${value.status} · 실행 번호 ${value.runId}\n${value.review}`); }
      catch (err) { if (current === sequence.current) setError(err instanceof Error ? err.message : 'AI 해설 실패'); } finally { if (current === sequence.current) setBusy(false); }
    }}>조회 근거로 AI 해설</Button>{!modelEnabled && <p className="text-xs text-muted-foreground">AI 연결 전에도 로그·GitHub 근거 조회를 사용할 수 있습니다. AI 해설은 연결 설정 후 활성화됩니다.</p>}{modelAnswer && <p className="whitespace-pre-wrap rounded border p-4 text-sm">{modelAnswer}</p>}</div>
    {error && <p role="alert" className="rounded bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {result && <><p className="text-xs text-muted-foreground">조회 시각: {result.queriedAt} · {result.correlation === 'REQUEST_METADATA_CANDIDATE' ? '같은 요청 메타데이터의 서버 처리 후보 확인' : '실패 요청과 서버 기록 연결 미확인'}</p>
      {[['관측 사실', result.facts], ['코드상 확인할 후보', result.candidates], ['아직 확인되지 않은 내용', result.unknowns], ['다음 확인', result.nextSteps]].map(([title, items]) => <section key={title as string} className="rounded-xl border p-4"><h2 className="font-semibold">{title as string}</h2><ul className="mt-2 list-disc space-y-1 pl-5 text-sm">{(items as string[]).length ? (items as string[]).map((item) => <li key={item}>{item}</li>) : <li>확인된 근거가 없습니다.</li>}</ul></section>)}
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">오류 기록 선택</h2><p className="text-xs text-muted-foreground">{result.coverage.note}</p>{!result.logs.length && <p>해당 범위의 기록이 없습니다. 오류가 없었다는 뜻은 아닙니다.</p>}{result.logs.map((item) => <button disabled={busy} key={item.id} onClick={() => void query(item.id)} className="block w-full rounded border p-3 text-left text-sm"><strong>{item.code || '오류 코드 미기록'}</strong> · {item.occurredAt || '시각 미기록'}<span className="block break-all text-xs text-muted-foreground">기록 {item.id} · 실패 요청 {item.requestId || '미기록'} · 화면 버전 {item.clientRelease?.slice(0, 8) || '미기록'}</span></button>)}{result.coverage.nextCursor && <Button disabled={busy} variant="outline" onClick={() => void query(undefined, result.coverage.nextCursor!)}>이전 오류 100건 보기</Button>}</section>
      <section className="space-y-3 rounded-xl border p-4"><h2 className="font-semibold">GitHub 코드 근거</h2><p className="text-sm">{result.github.message}</p>{result.github.items.map((item) => <article key={item.path} className="rounded border p-3 text-sm"><p>{item.path} · {item.sha.slice(0, 8)}</p>{item.url ? <a className="text-blue-700 underline" href={item.url} target="_blank" rel="noreferrer">이 버전의 원문 확인</a> : <p>코드 조회 실패: {item.status}</p>}{item.excerpts?.map((excerpt) => <details key={excerpt.startLine} className="mt-2"><summary>오류 코드 인접 문맥 · {excerpt.startLine}~{excerpt.endLine}행</summary><pre className="mt-2 overflow-auto whitespace-pre-wrap break-all text-xs">{excerpt.text}</pre><a href={excerpt.url} target="_blank" rel="noreferrer" className="text-blue-700 underline">해당 줄 확인</a></details>)}</article>)}</section>
    </>}
  </div>;
}
