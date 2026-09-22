import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { useWorkbench } from './useWorkbench';
import { formatTime } from './labels';
import type { CashflowEvidence, DiagnosticResult } from '../../lib/workbench-client';

const money = (value: number | null | undefined) => value == null ? '확인되지 않음' : `${value.toLocaleString('ko-KR')}원`;
export function CashflowEvidencePanel({ yearMonth, search = '', presentation = 'table' }: { yearMonth: string; search?: string; presentation?: 'table' | 'cards' }) {
  const { client, isAdmin, scope } = useWorkbench();
  const [result, setResult] = useState<CashflowEvidence | null>(null);
  const [logs, setLogs] = useState<DiagnosticResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setResult(null); setLogs(null); setError(''); setLoading(false); return () => { sequence.current++; }; }, [scope, yearMonth]);
  const query = async (after?: string) => {
    const current = ++sequence.current;
    setLoading(true); setError(''); setResult(null); setLogs(null);
    try { const value = await client.evidence(yearMonth, after); if (current === sequence.current) setResult(value); }
    catch (err) { if (current === sequence.current) setError(err instanceof Error ? err.message : '자료를 조회하지 못했습니다.'); }
    finally { if (current === sequence.current) setLoading(false); }
  };
  const diagnostics = async () => {
    const current = sequence.current;
    try { const value = await client.diagnostics(); if (current === sequence.current) setLogs(value); }
    catch (err) { if (current === sequence.current) setError(err instanceof Error ? err.message : '오류 기록 조회에 실패했습니다.'); }
  };
  const rows = result?.rows.filter((row) => `${row.name} ${row.cic}`.toLowerCase().includes(search.toLowerCase())) || [];
  return <section className="space-y-4" aria-label="현금흐름 근거 조회">
    <div className="rounded-lg border bg-slate-50 p-4 text-sm"><strong>현금흐름 조회·진단</strong><p className="mt-1">권한이 있는 사업의 반영 자료를 조회합니다. 현재는 모델 답변 생성 없이 실제 수치·조회 오류·코드 설명을 확인하는 기능입니다. 정산 제출이나 시트 동기화는 실행하지 않습니다.</p></div>
    <div className="flex flex-wrap gap-2"><Button onClick={() => void query()} disabled={loading}>현재 자료 조회</Button>{isAdmin && <Button variant="outline" onClick={() => void diagnostics()} disabled={loading}>최근 화면 오류 확인</Button>}</div>
    {loading && <p role="status">사업별 반영 자료를 확인하고 있습니다…</p>}
    {error && <p role="alert" className="rounded border border-red-200 p-3 text-red-800">{error} 조회 실패를 0원으로 판단하지 마세요.</p>}
    {result && <>
      <p className="text-sm">{result.yearMonth} · 조회 {formatTime(result.queriedAt)} · 이번 페이지 권한 내 사업 {result.accessibleInPage}개 / 자료 있음 {result.available}개 / 자료 없음 {result.notRecorded}개 / 조회 실패 {result.failed}개</p>
      <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">{result.limitations.map((text) => <li key={text}>{text}</li>)}</ul>
      {search && <p className="text-xs">검색은 이번 페이지의 사업명·CIC에만 적용됩니다.</p>}
      {presentation === 'table' ? <div className="overflow-x-auto rounded-lg border"><table className="w-full min-w-[660px] text-sm"><thead className="bg-slate-50"><tr>{['사업', 'CIC', 'Projection 입금', 'Actual 입금', 'Actual 출금', '조회 상태'].map((name) => <th key={name} className="p-3 text-left">{name}</th>)}</tr></thead><tbody>{rows.map((row) => <tr key={row.projectId} className="border-t"><td className="p-3">{row.name}</td><td className="p-3">{row.cic}</td><td className="p-3">{money(row.projection?.inflow)}</td><td className="p-3">{money(row.actual?.inflow)}</td><td className="p-3">{money(row.actual?.outflow)}</td><td className="p-3">{row.status === 'FAILED' ? '조회 실패' : row.status === 'AVAILABLE' ? '반영 자료 조회됨' : '자료 없음'}</td></tr>)}</tbody></table></div> : <div className="grid gap-3 md:grid-cols-2">{rows.map((row) => <article key={row.projectId} className="rounded-lg border p-4"><h3 className="font-medium">{row.name}</h3><p className="text-sm">Actual 입금 {money(row.actual?.inflow)} · 출금 {money(row.actual?.outflow)}</p></article>)}</div>}
      {!rows.length && <p>이번 페이지에는 표시할 사업이 없습니다. 다음 페이지가 있으면 이어서 확인해 주세요.</p>}
      {rows.map((row) => <details key={row.projectId} className="rounded border p-3 text-sm"><summary className="cursor-pointer">{row.name} — 조회 근거</summary>{row.error ? <><p className="mt-2">{row.error.message || '조회 원인을 확인하지 못했습니다. 운영 담당자에게 발생 시각과 사업명을 전달해 주세요.'}</p><p className="mt-1 text-xs">확인 코드: {row.error.code} · 원인 확정 전 오류 기록을 대조해야 합니다.</p></> : <><p className="mt-2 break-all">반영 버전: {row.evidence?.source.targetRevision} · 조회: {formatTime(row.evidence?.source.retrievedAt || '')}</p>{row.missingWeeks && <p className="mt-2">기록 미확인 주차: Projection {row.missingWeeks.projection.join(', ') || '없음'} / Actual {row.missingWeeks.actual.join(', ') || '없음'}. 일부 항목만 기록된 주차도 있으므로 조회된 금액이 전체 입력 완료를 뜻하지 않습니다.</p>}{row.evidence?.warnings.map((text) => <p key={text} className="mt-1">{text}</p>)}</>}</details>)}
      {result.nextAfter && <Button variant="outline" disabled={loading} onClick={() => void query(result.nextAfter!)}>다음 사업 조회</Button>}
      <details className="rounded border p-4 text-sm"><summary className="cursor-pointer font-medium">코드에 근거한 동작 설명과 확인 방법</summary><p className="my-2">{result.conclusion}</p><p className="break-all text-xs">설명 버전 {result.code.version} · 배포 코드 {result.code.release || '버전 확인 불가'}</p>{result.code.entries.map((entry) => <div key={entry.topic} className="mt-4"><h3 className="font-semibold">{entry.title}</h3>{entry.facts.map((fact) => <p className="mt-1" key={fact}>{fact}</p>)}<ul className="mt-2 list-disc pl-5">{entry.nextSteps.map((step) => <li key={step}>{step}</li>)}</ul><p className="mt-2 break-all text-xs text-muted-foreground">코드 근거: {entry.sources.join(', ')}</p></div>)}</details>
    </>}
    {logs && <div className="rounded-lg border p-4 text-sm"><h3 className="font-semibold">실제 수집된 화면 오류</h3><p className="my-2">{logs.warning}</p>{!logs.items.length && <p>이 조회 범위에서는 현금흐름 오류가 확인되지 않았습니다. 오류가 없다는 뜻은 아닙니다.</p>}{logs.items.map((item) => <div key={item.id} className="border-t py-2"><p>{formatTime(item.occurredAt || '')} · {item.errorClass} · {item.code || '상세 오류 코드 미수집'}</p><p className="break-all text-xs">기록 {item.id} · 수집 서버 배포 {item.release || '미수집'}</p></div>)}</div>}
  </section>;
}
