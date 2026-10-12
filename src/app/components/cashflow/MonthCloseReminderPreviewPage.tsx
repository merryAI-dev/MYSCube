import { useRef, useState } from 'react';
import { BellRing, Clipboard, Loader2, RefreshCw, ShieldAlert } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { fetchMonthCloseReminderPreviewViaBff, type MonthCloseReminderPreviewResult } from '../../lib/platform-bff-client';
import { PlatformApiError } from '../../platform/api-client';
import { PageHeader } from '../layout/PageHeader';
import { Alert, AlertDescription, AlertTitle } from '../ui/alert';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { Label } from '../ui/label';

const pad = (value: number) => String(value).padStart(2, '0');
const currentCycle = () => { const now = new Date(); return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`; };
const defaultLocalDeadline = (day: number) => { const [year, month] = currentCycle().split('-'); return `${year}-${month}-${pad(day)}T23:59`; };
const toIso = (local: string) => new Date(`${local}:00+09:00`).toISOString();

export function MonthCloseReminderPreviewPage() {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const [yearMonth, setYearMonth] = useState(currentCycle);
  const [submissionDeadline, setSubmissionDeadline] = useState(() => defaultLocalDeadline(10));
  const [approvalDeadline, setApprovalDeadline] = useState(() => defaultLocalDeadline(13));
  const [result, setResult] = useState<MonthCloseReminderPreviewResult | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const sequence = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const allowed = user?.role === 'admin' || user?.role === 'finance';

  const invalidatePreview = () => {
    sequence.current += 1;
    controller.current?.abort();
    setLoading(false);
    setError('');
    setResult(null);
  };

  const run = async () => {
    if (!user || !allowed || loading) return;
    const request = ++sequence.current;
    controller.current?.abort();
    controller.current = new AbortController();
    setLoading(true); setError(''); setResult(null);
    try {
      const next = await fetchMonthCloseReminderPreviewViaBff({
        tenantId: orgId,
        actor: { uid: user.uid, email: user.email, role: user.role, idToken: user.idToken },
        yearMonth,
        submissionDeadlineAt: toIso(submissionDeadline),
        approvalDeadlineAt: toIso(approvalDeadline),
        signal: controller.current.signal,
      });
      if (request === sequence.current) setResult(next);
    } catch (cause) {
      if (request !== sequence.current || (cause instanceof DOMException && cause.name === 'AbortError')) return;
      setError(cause instanceof PlatformApiError && cause.status === 403
        ? '관리자 또는 재무 권한이 필요합니다.'
        : '실제 월결산 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  };

  const copy = async () => {
    if (!result?.plan.text) return;
    await navigator.clipboard.writeText(result.plan.text);
    toast.success('미리보기 원문을 복사했습니다.');
  };

  if (!allowed) return <Alert variant="destructive"><ShieldAlert className="h-4 w-4" /><AlertTitle>접근 권한이 없습니다</AlertTitle><AlertDescription>관리자 또는 재무 역할로 로그인해 주세요.</AlertDescription></Alert>;

  return <div className="space-y-5">
    <PageHeader icon={BellRing} iconGradient="linear-gradient(135deg, #0f766e, #2dd4bf)" title="월결산 리마인드 미리보기" description="실제 DB의 canonical 월결산 상태로 문안을 만들며 Slack 발송이나 데이터 변경은 하지 않습니다." />
    <Card><CardHeader><CardTitle>조회 기준</CardTitle></CardHeader><CardContent className="grid gap-4 md:grid-cols-3">
      <div className="space-y-2"><Label htmlFor="cycle">결산 주기 월</Label><Input id="cycle" type="month" value={yearMonth} onChange={(event) => { invalidatePreview(); setYearMonth(event.target.value); }} disabled={loading} /></div>
      <div className="space-y-2"><Label htmlFor="submission">제출 마감 (한국시간)</Label><Input id="submission" type="datetime-local" value={submissionDeadline} onChange={(event) => { invalidatePreview(); setSubmissionDeadline(event.target.value); }} disabled={loading} /></div>
      <div className="space-y-2"><Label htmlFor="approval">조직장 승인 마감 (한국시간)</Label><Input id="approval" type="datetime-local" value={approvalDeadline} onChange={(event) => { invalidatePreview(); setApprovalDeadline(event.target.value); }} disabled={loading} /></div>
      <div className="md:col-span-3"><Button type="button" onClick={() => void run()} disabled={loading || !yearMonth || !submissionDeadline || !approvalDeadline} className="gap-2">{loading ? <Loader2 className="h-4 w-4 animate-spin" /> : result ? <RefreshCw className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}{loading ? '실제 상태 조회 중…' : result ? '다시 생성' : '미리보기 생성'}</Button></div>
    </CardContent></Card>
    {error ? <Alert variant="destructive"><AlertTitle>미리보기를 만들 수 없습니다</AlertTitle><AlertDescription className="space-y-3"><p>{error}</p><Button type="button" variant="outline" size="sm" onClick={() => void run()}>재시도</Button></AlertDescription></Alert> : null}
    {result ? <Card><CardHeader><div className="flex flex-wrap items-center justify-between gap-3"><CardTitle>실제 DB 미리보기</CardTitle><Button type="button" variant="outline" size="sm" className="gap-2" onClick={() => void copy()}><Clipboard className="h-4 w-4" />원문 복사</Button></div></CardHeader><CardContent className="space-y-4">
      <div className="flex flex-wrap gap-2"><Badge>대상 {result.plan.targetYearMonth}</Badge><Badge variant="outline">상태 확인 {new Date(result.plan.checkedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}</Badge><Badge variant="outline">결산 전 {result.plan.beforeClose.length}</Badge><Badge variant="outline">승인 필요 {result.plan.approvalRequired.length}</Badge><Badge variant={result.plan.unknown.length ? 'destructive' : 'outline'}>확인 필요 {result.plan.unknown.length}</Badge><Badge variant="outline">제외 {result.plan.excluded.length}</Badge></div>
      <pre className="whitespace-pre-wrap rounded-md border bg-muted/40 p-4 text-sm leading-6">{result.plan.text}</pre>
      {result.plan.unknown.length ? <div><h3 className="font-medium">확인 필요 목록</h3><ul className="mt-2 list-disc pl-5 text-sm">{result.plan.unknown.map((item) => <li key={`${item.projectId}:${item.reason}`}>{item.organization || '조직 확인 필요'} · {item.name || item.projectId} · {item.reason}</li>)}</ul></div> : null}
    </CardContent></Card> : null}
  </div>;
}
