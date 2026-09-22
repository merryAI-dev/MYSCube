import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { useWorkbench } from './useWorkbench';
import { useProductOperations } from './useProductOperations';
import { TransactionalPreview } from './preview/TransactionalPreview';
import type { PreviewPage, PreviewWidget } from './preview/document';
import type { InsightWidget, WorkPageConfig } from '../../lib/workbench-client';
import { proposeInsightLayout, WIDGETS } from '../../../../shared/insight-page.mjs';
const kinds = Object.fromEntries(Object.entries(WIDGETS).map(([key, value]) => [key, value.label])) as Record<InsightWidget['kind'], string>;
export function defaultInsightWidgets(): InsightWidget[] {
  return [{ id: 'quality', kind: 'operations', title: kinds.operations, display: 'trend', days: 7, search: '', width: 'full' },
    { id: 'cashflow', kind: 'cashflow', title: kinds.cashflow, display: 'table', days: 7, search: '', width: 'full' }];
}
export function InsightEditor({ config, onChange }: { config: WorkPageConfig; onChange: (value: WorkPageConfig) => void }) {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('');
  const widgets = config.widgets || [];
  const update = (values: InsightWidget[]) => onChange({ ...config, widgets: values });
  const patch = (id: string, value: Partial<InsightWidget>) => update(widgets.map((item) => item.id === id ? { ...item, ...value } : item));
  return <div className="space-y-4">
    <div className="rounded-lg bg-slate-50 p-3"><label className="text-sm">필요한 인사이트<Textarea aria-label="필요한 인사이트" value={prompt} onChange={(e) => setPrompt(e.target.value)} maxLength={1000} placeholder="예: 최근 14일 오류 추이와 CIC1 현금흐름, 구성원 안내" /></label><Button type="button" variant="outline" className="mt-2" onClick={() => { const result = proposeInsightLayout(prompt, config.yearMonth); setNotice(`${result.interpretation} ${result.unsupported}`); if (result.config) onChange(result.config as WorkPageConfig); }}>지표 키워드로 구성</Button>{notice && <p className="mt-2 text-xs">{notice}</p>}</div>
    {widgets.map((widget, index) => <div className="space-y-3 rounded-lg border p-3" key={widget.id}>
      <div className="flex flex-wrap justify-between gap-2"><strong className="text-sm">위젯 {index + 1}</strong><div className="flex gap-2"><Button type="button" variant="outline" size="sm" disabled={index === 0} aria-label={`위젯 ${index + 1} 위로`} onClick={() => { const copy = [...widgets]; [copy[index - 1], copy[index]] = [copy[index], copy[index - 1]]; update(copy); }}>위로</Button><Button type="button" variant="outline" size="sm" disabled={widgets.length === 1} onClick={() => update(widgets.filter((item) => item.id !== widget.id))}>위젯 삭제</Button></div></div>
      <label className="block text-sm">위젯 제목<Input aria-label={`위젯 ${index + 1} 제목`} value={widget.title} onChange={(e) => patch(widget.id, { title: e.target.value })} maxLength={80} /></label>
      <div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">지표<select aria-label={`위젯 ${index + 1} 지표`} className="w-full rounded border p-2" value={widget.kind} onChange={(e) => patch(widget.id, { kind: e.target.value as InsightWidget['kind'], display: e.target.value === 'cashflow' ? 'table' : 'cards', title: kinds[e.target.value as InsightWidget['kind']] })}>{Object.entries(kinds).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <label className="text-sm">표현<select className="w-full rounded border p-2" value={widget.display} onChange={(e) => patch(widget.id, { display: e.target.value as InsightWidget['display'] })}><option value="cards">카드</option><option value="table">표</option>{widget.kind === 'operations' && <option value="trend">일별 추이</option>}</select></label>
      <label className="text-sm">너비<select className="w-full rounded border p-2" value={widget.width} onChange={(e) => patch(widget.id, { width: e.target.value as InsightWidget['width'] })}><option value="full">전체</option><option value="half">절반 (모바일에서는 전체)</option></select></label></div>
      {widget.kind === 'operations' && <label className="block text-sm">관측 기간<select className="ml-2 rounded border p-2" value={widget.days} onChange={(e) => patch(widget.id, { days: Number(e.target.value) as InsightWidget['days'] })}>{[7, 14, 28].map((days) => <option key={days} value={days}>최근 {days}일</option>)}</select></label>}
      {widget.kind === 'cashflow' && <label className="block text-sm">사업명·CIC 필터<Input value={widget.search} onChange={(e) => patch(widget.id, { search: e.target.value })} maxLength={100} /></label>}
    </div>)}
    <Button type="button" variant="outline" disabled={widgets.length >= 6} onClick={() => update([...widgets, { ...defaultInsightWidgets()[0], id: crypto.randomUUID(), title: '새 품질 지표' }])}>위젯 추가</Button><p className="text-xs text-muted-foreground">최대 6개. 화면 구성만 저장합니다. 각 지표의 조회 권한과 자료 범위는 바뀌지 않습니다.</p>
  </div>;
}
const money = (value: number | null | undefined) => value == null ? '확인되지 않음' : `${value.toLocaleString('ko-KR')}원`;
export function InsightDashboard(props: { config: WorkPageConfig }) {
  const { scope } = useWorkbench();
  return <InsightDashboardContent key={scope} {...props} />;
}
function InsightDashboardContent({ config }: { config: WorkPageConfig }) {
  const { client, scope, isAdmin } = useWorkbench();
  const { client: operations } = useProductOperations();
  const [page, setPage] = useState<PreviewPage | null>(null);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [queryMs, setQueryMs] = useState<number | null>(null);
  const sequence = useRef(0);
  useEffect(() => { sequence.current++; setStale(true); setBusy(false); return () => { sequence.current++; }; }, [config, scope]);
  const query = async () => {
    if (busy) return;
    const current = ++sequence.current; setBusy(true); const start = performance.now();
    const cache = new Map<string, Promise<any>>();
    const once = (key: string, fn: () => Promise<any>) => { if (!cache.has(key)) cache.set(key, fn()); return cache.get(key)!; };
    const widgets = await Promise.all((config.widgets || []).map(async (widget): Promise<PreviewWidget> => {
      const base: PreviewWidget = { id: widget.id, title: widget.title, width: widget.width, display: widget.display, source: kinds[widget.kind], period: config.yearMonth,
        queriedAt: '', metrics: [], columns: [], rows: [], notes: [] };
      try {
        if (widget.kind === 'operations') {
          if (!isAdmin) throw new Error('운영 관리자만 품질 지표를 조회할 수 있습니다. 다른 위젯은 현재 권한으로 확인합니다.');
          const value = await once(`operations:${widget.days}`, () => operations.summary(widget.days));
          base.queriedAt = value.queriedAt; base.period = `${value.from} ~ ${value.to}`;
          base.metrics = [{ label: '관측 업무 시도', value: `${value.counts.total}건` }, { label: '서버 저장 확인', value: `${value.counts.saved}건` }, { label: '시스템 오류', value: `${value.counts.system_failed}건` },
            { label: '관측 시스템 오류율', value: value.observedSystemFailureRate == null ? '계산 불가' : `${(value.observedSystemFailureRate * 100).toFixed(2)}%` }];
          base.notes = [value.collection.note, '오류율 = 관측 시스템 오류 / 관측 업무 시도. 사용자 입력 검증 차단은 시스템 오류와 구분합니다.', '수집 전 과거 오류 건수와 이 비율을 직접 비교할 수 없습니다.'];
          const days = new Map<string, { total: number; failed: number }>();
          for (const row of value.rows) { const day = days.get(row.day) || { total: 0, failed: 0 }; day.total += row.counts.total; day.failed += row.counts.system_failed; days.set(row.day, day); }
          if (widget.display === 'trend') { const max = Math.max(1, ...[...days.values()].map((day) => day.total)); base.bars = [...days].map(([label, day]) => ({ label, width: day.total / max * 55, value: `${day.failed} / ${day.total}건` })); }
          if (widget.display === 'table') { base.columns = ['날짜', '관측 업무 시도', '시스템 오류']; base.rows = [...days].map(([day, values]) => [day, String(values.total), String(values.failed)]); }
        } else if (widget.kind === 'cashflow') {
          const value = await once('cashflow', () => client.insightReport(config.yearMonth));
          const rows = value.rows.filter((row: any) => `${row.name} ${row.cic}`.toLowerCase().includes(widget.search.toLowerCase()));
          base.queriedAt = value.queriedAt; base.metrics = [{ label: '조회한 사업 중 필터 결과', value: `${rows.length}개 사업` }, { label: '조회 실패', value: `${rows.filter((row: any) => row.status === 'FAILED').length}개` }];
          base.columns = ['사업 / CIC', '계획 입금', '실제 입금', '실제 출금', '조회 상태'];
          base.rows = rows.map((row: any) => [`${row.name} / ${row.cic}`, money(row.projection?.inflow), money(row.actual?.inflow), money(row.actual?.outflow), row.status === 'FAILED' ? row.error?.message || '조회 실패' : row.status === 'NOT_RECORDED' ? '기록 없음' : '반영 자료 있음']);
          if (widget.display === 'cards') { base.metrics.push(...rows.map((row: any) => ({ label: `${row.name} · 실제 입금`, value: money(row.actual?.inflow) }))); base.rows = []; }
          base.notes = [...value.limitations, value.catalogComplete ? '권한 내 사업 목록 탐색 완료. 누락된 금액과 실패 사업은 별도로 확인해 주세요.' : '추가 사업이 있습니다. 전체 사업은 현금흐름 조회·진단에서 이어서 확인해 주세요.'];
        } else {
          const value = await once('guidance', () => operations.guidance());
          base.queriedAt = new Date().toISOString(); base.period = '현재 공개 중'; base.metrics = [{ label: '공개 안내', value: `${value.items.length}건` }];
          base.columns = ['안내', '현재 상황', '할 일']; base.rows = value.items.map((item: any) => [item.title, item.message, item.nextAction]);
          base.notes = [value.truncated ? '일부 안내만 조회됐습니다.' : '운영 담당자가 공개한 내용입니다.'];
        }
        return base;
      } catch (err) { return { ...base, error: err instanceof Error ? err.message : '자료 조회 실패', notes: ['조회 실패는 0이나 정상 상태를 의미하지 않습니다.'] }; }
    }));
    if (current !== sequence.current) return;
    setStale(false); setPage({ title: config.title, description: config.description, widgets }); setQueryMs(Math.round(performance.now() - start)); setBusy(false);
  };
  return <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><Button disabled={busy} onClick={() => void query()}>{busy ? '자료 확인 중…' : '인사이트 자료 조회·미리보기'}</Button>{queryMs !== null && <span className="text-xs text-muted-foreground">자료 조회 {queryMs}ms</span>}</div>
    <p className="text-xs text-muted-foreground">선택한 화면 구성으로 조회합니다. 사업 자료와 정산 상태를 변경하지 않습니다.</p>{stale && page && <p role="status" className="text-sm text-amber-800">이전 구성의 화면입니다. 자료를 다시 조회하면 새 구성이 반영됩니다.</p>}{page && <div className={stale || busy ? 'pointer-events-none opacity-60' : ''}><TransactionalPreview page={page} /></div>}</div>;
}
