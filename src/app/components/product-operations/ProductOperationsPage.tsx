import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, RefreshCw, Plus, History, Save } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { PageHeader } from '../layout/PageHeader';
import { useProductOperations } from './useProductOperations';
import { formatTime, operationLabels, statusLabels } from './labels';
import type { Incident, IncidentInput, ReliabilitySummary } from '../../lib/product-operations-client';

const emptyIncident = (): IncidentInput => ({ expectedVersion: 0, title: '', status: 'investigating', operationKey: null,
  cause: '', evidence: '', owner: '', action: '', releaseSha: '', published: false, publicTitle: '', publicMessage: '', publicAction: '' });
const errorMessage = (error: unknown) => error instanceof Error ? error.message : '자료를 불러오지 못했습니다. 다시 시도해 주세요.';
const fieldClass = 'mt-1 w-full rounded-md border bg-background p-2 text-sm';

export function ProductOperationsPage() {
  const { ready, isAdmin, scope } = useProductOperations();
  if (!ready) return <p className="p-6" role="status">로그인 정보를 확인하고 있습니다.</p>;
  if (!isAdmin) return <div className="p-6" role="alert">서비스 운영 현황은 관리자만 확인할 수 있습니다.</div>;
  return <ProductOperationsContent key={scope} />;
}

function ProductOperationsContent() {
  const { client, ready, isAdmin } = useProductOperations();
  const [days, setDays] = useState(7);
  const [summary, setSummary] = useState<ReliabilitySummary | null>(null);
  const [incidents, setIncidents] = useState<Incident[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editor, setEditor] = useState<IncidentInput | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [history, setHistory] = useState<Incident[] | null>(null);
  const [historyTruncated, setHistoryTruncated] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const sequence = useRef(0);
  const editorSequence = useRef(0);
  useEffect(() => () => { sequence.current++; }, []);

  const reload = useCallback(async () => {
    const current = ++sequence.current;
    setLoading(true); setError('');
    try {
      const [metrics, list] = await Promise.all([client.summary(days), client.incidents()]);
      if (current !== sequence.current) return;
      setSummary(metrics); setIncidents(list.items); setTruncated(list.truncated);
    } catch (err) { if (current === sequence.current) setError(errorMessage(err)); }
    finally { if (current === sequence.current) setLoading(false); }
  }, [client, days]);
  useEffect(() => { if (ready && isAdmin) void reload(); }, [ready, isAdmin, reload]);

  const edit = (incident?: Incident) => {
    editorSequence.current++;
    setSelectedId(incident?.id || null); setEditorError(''); setHistory(null); setStatusMessage('');
    setEditor(incident ? { expectedVersion: incident.version, title: incident.title, status: incident.status,
      operationKey: incident.operationKey, cause: incident.cause, evidence: incident.evidence, owner: incident.owner,
      action: incident.action, releaseSha: incident.releaseSha, published: incident.published,
      publicTitle: incident.publicTitle, publicMessage: incident.publicMessage, publicAction: incident.publicAction } : emptyIncident());
  };
  const patch = <K extends keyof IncidentInput>(key: K, value: IncidentInput[K]) => setEditor((current) => current && ({ ...current, [key]: value }));
  const save = async () => {
    if (!editor || saving) return;
    setSaving(true); setEditorError('');
    try {
      const saved = await client.saveIncident(selectedId, editor);
      setSelectedId(saved.id); setEditor({ ...editor, expectedVersion: saved.version });
      setStatusMessage(`사건을 저장했습니다. 버전 ${saved.version}`);
      await reload();
    } catch (err) { setEditorError(errorMessage(err)); }
    finally { setSaving(false); }
  };
  const loadHistory = async () => {
    if (!selectedId) return;
    const current = editorSequence.current;
    try {
      const result = await client.history(selectedId);
      if (current !== editorSequence.current) return;
      setHistory(result.items); setHistoryTruncated(result.truncated);
    } catch (err) { if (current === editorSequence.current) setEditorError(errorMessage(err)); }
  };

  if (!ready) return <p className="p-6" role="status">로그인 정보를 확인하고 있습니다.</p>;
  if (!isAdmin) return <div className="p-6" role="alert">서비스 운영 현황은 관리자만 확인할 수 있습니다.</div>;
  const counts = summary?.counts;
  const rows = summary?.rows || [];
  const dayTotals = Object.entries(rows.reduce<Record<string, { total: number; failed: number }>>((map, row) => {
    const day = map[row.day] || { total: 0, failed: 0 };
    day.total += row.counts.total; day.failed += row.counts.system_failed; map[row.day] = day; return map;
  }, {}));

  return <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
    <PageHeader icon={Activity} iconGradient="" title="서비스 운영 현황" description="업무가 어디서 막혔는지 확인하고, 구성원에게 원인과 다음 행동을 안내합니다." />
    <div className="flex flex-wrap items-center gap-3">
      <label className="text-sm">조회 기간 <select className="ml-2 rounded border p-2" value={days} onChange={(e) => setDays(Number(e.target.value))}>
        <option value={7}>최근 7일</option><option value={14}>최근 14일</option><option value={28}>최근 28일</option>
      </select></label>
      <Button variant="outline" onClick={() => void reload()} disabled={loading}><RefreshCw className="mr-2 h-4 w-4" />새로고침</Button>
      <Button onClick={() => edit()} disabled={saving}><Plus className="mr-2 h-4 w-4" />사건 등록</Button>
    </div>
    {loading && <p role="status">운영 기록을 불러오고 있습니다.</p>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error} 기존 표시 자료는 최신 상태가 아닐 수 있습니다.</div>}
    {summary && !loading && <>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <strong>{summary.collection.status === 'degraded' ? '수집 장애 확인 · 비율 확인 필요' : counts?.total ? '관측된 업무 시도 기준' : '아직 수집된 업무 기록이 없습니다'}</strong>
        <p className="mt-1">{summary.collection.note} 조회 실패나 기록 없음은 오류가 없다는 뜻이 아닙니다.</p>
        <p className="mt-1 text-xs">{summary.from} ~ {summary.to} (한국시간) · 환경 {summary.environment} · 마지막 조회 {formatTime(summary.queriedAt)}</p>
        {summary.truncated && <p className="mt-2 font-semibold">조회 한도에 도달해 집계가 일부만 표시됩니다. 비율을 사용하지 마세요.</p>}
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {[
          ['관측된 시도', counts?.total], ['서버 저장 확인', counts?.saved],
          ['시스템 오류', counts?.system_failed], ['결과 확인 필요', (counts?.unknown || 0) + (counts?.pending || 0)],
        ].map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-sm text-muted-foreground">{label}</p><p className="mt-2 text-2xl font-semibold">{counts?.total ? Number(value).toLocaleString('ko-KR') : '—'}</p></div>)}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">오류와 입력 확인을 구분합니다</h2>
          <dl className="mt-3 space-y-2 text-sm">
            <div className="flex justify-between"><dt>관측분 시스템 오류율</dt><dd>{error || summary.observedSystemFailureRate === null ? '확인 불가' : `${(summary.observedSystemFailureRate * 100).toFixed(1)}%`}</dd></div>
            <div className="flex justify-between"><dt>화면에서 입력 확인 요청</dt><dd>{counts?.validation_blocked || 0}건</dd></div>
            <div className="flex justify-between"><dt>서버에서 요청 거절·충돌</dt><dd>{counts?.rejected || 0}건</dd></div>
            <div className="flex justify-between"><dt>저장 후 후속 처리 확인 필요</dt><dd>{counts?.followupUnconfirmed || 0}건</dd></div>
          </dl><p className="mt-3 text-xs text-muted-foreground">조직장 반려를 정상 저장한 경우는 시스템 오류가 아닙니다. 저장 확인과 첨부 이관 완료는 별도입니다.</p>
        </section>
        <section className="rounded-xl border bg-card p-4"><h2 className="font-semibold">일별 관측 추이</h2>
          {!dayTotals.length ? <p className="mt-3 text-sm text-muted-foreground">계측이 시작된 후 기록을 확인할 수 있습니다.</p> : <div className="mt-3 max-h-64 overflow-auto"><table className="w-full text-sm"><thead><tr className="text-left"><th>날짜</th><th>시도</th><th>시스템 오류</th></tr></thead><tbody>{dayTotals.map(([day, value]) => <tr key={day} className="border-t"><td className="py-2">{day}</td><td>{value.total}</td><td>{value.failed}</td></tr>)}</tbody></table></div>}
          <p className="mt-2 text-xs text-muted-foreground">기록 없는 날짜는 0건으로 채우지 않습니다.</p>
        </section>
      </div>
      <section className="overflow-x-auto rounded-xl border bg-card p-4"><h2 className="mb-3 font-semibold">업무별 기록</h2>
        <table className="w-full min-w-[650px] text-sm"><thead><tr className="text-left"><th>날짜 / 업무</th><th>저장 방식</th><th>시도</th><th>저장 확인</th><th>시스템 오류</th><th>미확정</th></tr></thead>
          <tbody>{rows.map((row) => <tr key={`${row.day}-${row.operationKey}-${row.mode}`} className="border-t"><td className="py-3">{row.day}<br />{operationLabels[row.operationKey]}</td><td>{row.mode === 'automatic' ? '자동' : row.mode === 'manual' ? '직접 실행' : '방식 미확인'}</td><td>{row.counts.total}</td><td>{row.counts.saved}</td><td>{row.counts.system_failed}</td><td>{row.counts.pending + row.counts.unknown}</td></tr>)}</tbody></table>
      </section>
    </>}
    <section className="space-y-3"><h2 className="text-lg font-semibold">원인·조치 관리</h2>
      {truncated && <p role="status" className="text-sm text-amber-800">최근 100개 사건을 표시합니다.</p>}
      {!loading && !error && !incidents.length && <p className="rounded-xl border p-6 text-sm text-muted-foreground">등록된 사건이 없습니다. 확인한 문제를 등록하고 담당자와 안내를 연결하세요.</p>}
      {incidents.map((incident) => <button key={incident.id} className="block w-full rounded-xl border bg-card p-4 text-left hover:border-primary focus-visible:outline-primary" onClick={() => edit(incident)} disabled={saving}>
        <div className="flex flex-wrap justify-between gap-2"><strong>{incident.title}</strong><span className="text-sm">{statusLabels[incident.status]}</span></div>
        <p className="mt-2 text-sm text-muted-foreground">담당 {incident.owner || '미지정'} · {incident.published ? '공개 안내 있음' : '관리자 검토 중'} · 버전 {incident.version} · {formatTime(incident.updatedAt)}</p>
        {incident.reopenedCount > 0 && <p className="mt-1 text-sm text-amber-700">재조사 {incident.reopenedCount}회</p>}
      </button>)}
    </section>
    {editor && <fieldset disabled={saving} className="space-y-4 rounded-xl border-2 border-primary/30 bg-card p-4 sm:p-6" aria-label="사건 편집">
      <h2 className="text-lg font-semibold">{selectedId ? '사건 수정' : '새 사건'} <span className="text-sm font-normal text-muted-foreground">현재 버전 {editor.expectedVersion}</span></h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm">사건 제목<Input value={editor.title} onChange={(e) => patch('title', e.target.value)} maxLength={120} /></label>
        <label className="text-sm">담당자<Input value={editor.owner} onChange={(e) => patch('owner', e.target.value)} maxLength={100} /></label>
        <label className="text-sm">처리 상태<select className={fieldClass} value={editor.status} onChange={(e) => patch('status', e.target.value as IncidentInput['status'])}>{Object.entries(statusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
        <label className="text-sm">관련 업무<select className={fieldClass} value={editor.operationKey || ''} onChange={(e) => patch('operationKey', (e.target.value || null) as IncidentInput['operationKey'])}><option value="">공통 안내</option>{Object.entries(operationLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      </div>
      {([['cause', '확인한 원인'], ['evidence', '확인 근거 · 요청 번호 · 발생 시각'], ['action', '조치와 검증 결과']] as const).map(([key, label]) => <label key={key} className="block text-sm">{label}<Textarea className="mt-1" value={editor[key]} onChange={(e) => patch(key, e.target.value)} maxLength={3000} /></label>)}
      <label className="block text-sm">관련 배포 커밋 (선택)<Input value={editor.releaseSha} onChange={(e) => patch('releaseSha', e.target.value)} placeholder="40자리 커밋 SHA" maxLength={40} /></label>
      <fieldset className="space-y-3 rounded-lg border bg-muted/30 p-4"><legend className="px-2 font-medium">구성원 공개 안내</legend>
        <p className="text-xs text-muted-foreground">아래 내용만 구성원에게 보입니다. 개인·사업별 민감정보를 넣지 말고 누구나 이해할 수 있는 원인과 행동을 작성하세요. 해결 상태에서는 진행 중 안내에서 내려갑니다.</p>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editor.published} onChange={(e) => patch('published', e.target.checked)} />내용을 검토했고 구성원에게 공개합니다</label>
        <label className="block text-sm">안내 제목<Input value={editor.publicTitle} onChange={(e) => patch('publicTitle', e.target.value)} maxLength={120} /></label>
        <label className="block text-sm">현재 상황<Textarea value={editor.publicMessage} onChange={(e) => patch('publicMessage', e.target.value)} maxLength={1500} /></label>
        <label className="block text-sm">구성원이 할 일<Textarea value={editor.publicAction} onChange={(e) => patch('publicAction', e.target.value)} maxLength={1000} /></label>
      </fieldset>
      {editorError && <p role="alert" className="text-sm text-red-700">{editorError} 작성 내용은 유지됩니다.</p>}
      {statusMessage && <p role="status" className="text-sm text-emerald-700">{statusMessage}</p>}
      <div className="flex flex-wrap gap-2"><Button onClick={() => void save()} disabled={saving}><Save className="mr-2 h-4 w-4" />{saving ? '저장 중…' : '사건 저장'}</Button><Button variant="outline" onClick={() => setEditor(null)} disabled={saving}>편집 닫기</Button>{selectedId && <Button variant="outline" onClick={() => void loadHistory()}><History className="mr-2 h-4 w-4" />수정 이력</Button>}</div>
      {history && <div className="space-y-3 border-t pt-4"><h3 className="font-medium">수정 이력{historyTruncated ? ' (최근 50개)' : ''}</h3>{history.map((item) => <details key={item.version} className="rounded border p-3 text-sm"><summary className="cursor-pointer">버전 {item.version} · {statusLabels[item.status]} · {formatTime(item.updatedAt)}</summary><p className="mt-2 whitespace-pre-wrap">원인: {item.cause || '조사 중'}</p><p className="mt-2 whitespace-pre-wrap">조치: {item.action || '미기록'}</p></details>)}</div>}
    </fieldset>}
  </div>;
}
