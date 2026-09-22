import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Textarea } from '../ui/textarea';
import { useWorkbench } from './useWorkbench';
import type { WorkPageConfig } from '../../lib/workbench-client';

export function AssistantComposer({ mode, yearMonth, onProposal }: { mode: 'page' | 'cashflow'; yearMonth: string; onProposal?: (value: WorkPageConfig) => void }) {
  const { client, scope } = useWorkbench();
  const [capability, setCapability] = useState<{ modelEnabled: boolean; message: string } | null>(null);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [evidence, setEvidence] = useState<unknown[]>([]);
  const [proposal, setProposal] = useState<WorkPageConfig | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  useEffect(() => {
    const current = ++sequence.current;
    setCapability(null); setQuestion(''); setAnswer(''); setEvidence([]); setProposal(null); setError(''); setBusy(false);
    void client.capabilities().then((value) => { if (current === sequence.current) setCapability(value); }, () => { if (current === sequence.current) setError('AI 연결 상태를 확인하지 못했습니다. 직접 구성·조회는 이용할 수 있습니다.'); });
    return () => { sequence.current++; };
  }, [client, scope, yearMonth]);
  const submit = async () => {
    if (busy || !capability?.modelEnabled || !question.trim()) return;
    const current = sequence.current;
    setBusy(true); setError(''); setProposal(null); setAnswer(''); setEvidence([]);
    try {
      if (mode === 'page') {
        const result = await client.propose(question, yearMonth);
        if (current === sequence.current) setProposal(result.config);
      } else {
        const result = await client.ask(question, yearMonth);
        if (current === sequence.current) {
          const status = ({ answered: '답변 생성', partial: '일부 결과', limited: '조회 한도 도달', unverified: '확인 근거 부족', needs_clarification: '추가 정보 필요' } as Record<string, string>)[result.status] || '답변 상태 확인 필요';
          setAnswer(`${status}\n\n${result.answer}\n\n${result.review}\n조회 근거 ${result.evidence.length}건 · 실행 번호 ${result.runId}`); setEvidence(result.evidence);
        }
      }
    } catch (err) { if (current === sequence.current) setError(err instanceof Error ? err.message : 'AI 요청을 완료하지 못했습니다.'); }
    finally { if (current === sequence.current) setBusy(false); }
  };
  return <section className="space-y-3 rounded-lg border p-4"><h2 className="font-semibold">{mode === 'page' ? '말로 업무 페이지 구성하기' : '현금흐름 에이전트에게 질문하기'}</h2>
    <p className="text-sm text-muted-foreground">{capability?.message || 'AI 연결 상태 확인 중…'}</p>
    <Textarea aria-label={mode === 'page' ? '만들고 싶은 페이지' : '현금흐름 질문'} disabled={!capability?.modelEnabled || busy} value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={2000} placeholder={mode === 'page' ? '예: 현금흐름을 CIC1 사업만 표로 보고 싶어요.' : '예: 이 달 현금흐름 자료에서 확인되지 않은 항목과 확인할 근거를 설명해 주세요.'} />
    <Button disabled={!capability?.modelEnabled || busy || !question.trim()} onClick={() => void submit()}>{busy ? '근거를 확인하고 있습니다…' : mode === 'page' ? '구성 제안받기' : '질문하기'}</Button>
    {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
    {proposal && <div className="space-y-2 rounded border bg-slate-50 p-3 text-sm"><p>제안: {proposal.title} · {proposal.yearMonth} · {proposal.source === 'insight-dashboard' ? 'CEO 인사이트' : proposal.source === 'cashflow-evidence' ? '현금흐름' : '서비스 안내'} · {proposal.presentation === 'table' ? '표' : '카드'}</p><p>아직 저장되지 않았습니다. 적용 후 구성과 미리보기를 확인해 주세요.</p><Button variant="outline" onClick={() => { onProposal?.(proposal); setProposal(null); }}>검토 후 편집기에 적용</Button></div>}
    {answer && <p className="whitespace-pre-wrap rounded border bg-slate-50 p-4 text-sm" role="status">{answer}</p>}
    {evidence.length > 0 && <details className="rounded border p-3"><summary className="cursor-pointer text-sm">답변에 사용한 조회 결과 원문 확인</summary><p className="my-2 text-xs">현재 권한으로 조회한 반영 자료·오류 기록·코드 설명입니다. 빈 값은 확인되지 않은 항목입니다.</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(evidence, null, 2)}</pre></details>}
  </section>;
}
