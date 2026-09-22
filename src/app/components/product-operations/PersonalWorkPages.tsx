import { InsightEditor, InsightDashboard, defaultInsightWidgets } from './InsightDashboard';
import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { useWorkbench } from './useWorkbench';
import { CashflowEvidencePanel } from './CashflowEvidencePanel';
import { ServiceGuidance } from './ServiceGuidance';
import { AssistantComposer } from './AssistantComposer';
import { formatTime } from './labels';
import type { WorkPage, WorkPageConfig } from '../../lib/workbench-client';

const initialConfig = (): WorkPageConfig => ({ schemaVersion: 1, title: '내 현금흐름 확인', description: '', source: 'cashflow-evidence', presentation: 'table',
  yearMonth: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(new Date()), search: '' });

export function PersonalWorkPages() {
  const state = useWorkbench();
  if (!state.ready) return <p className="p-6">로그인 정보를 확인하고 있습니다.</p>;
  return <PersonalWorkPagesContent key={state.scope} />;
}

function PersonalWorkPagesContent() {
  const { client } = useWorkbench();
  const location = useLocation();
  const [pages, setPages] = useState<WorkPage[]>([]);
  const [page, setPage] = useState<WorkPage | null>(null);
  const [config, setConfig] = useState<WorkPageConfig>(initialConfig);
  const [preview, setPreview] = useState<WorkPageConfig | null>(null);
  const [versions, setVersions] = useState<WorkPage[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    let active = true;
    void client.list().then((value) => { if (active) { setPages(value.items); if (value.truncated) setMessage('페이지가 많아 100개까지만 표시됩니다.'); } },
      (err) => { if (active) setError(err instanceof Error ? err.message : '페이지 목록 조회 실패'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [client]);
  const dirty = JSON.stringify(config) !== JSON.stringify(page?.config || initialConfig());
  const leaveEditor = () => !dirty || window.confirm('저장하지 않은 페이지 구성이 있습니다. 저장하지 않고 이동할까요?');
  const apply = (value: WorkPage) => { setPage(value); setConfig(value.config); setPreview(null); setVersions([]); };
  const run = async (action: () => Promise<void>) => {
    if (busy || loading) return;
    setBusy(true); setError(''); setMessage('');
    try { await action(); } catch (err) { if (alive.current) setError(err instanceof Error ? err.message : '처리하지 못했습니다. 입력은 유지됩니다.'); }
    finally { if (alive.current) setBusy(false); }
  };
  const save = () => run(async () => {
    const saved = await client.save(page?.id || null, page?.version || 0, config);
    if (!alive.current) return;
    apply(saved); setPages((items) => [saved, ...items.filter((item) => item.id !== saved.id)]);
    setMessage(`페이지를 저장했습니다. 버전 ${saved.version} · ${formatTime(saved.updatedAt)}`);
  });
  const changeSource = (source: WorkPageConfig['source']) => { setConfig((current) => source === 'insight-dashboard' ? { ...current, source, schemaVersion: 2, widgets: defaultInsightWidgets() } : (({ widgets, ...rest }) => ({ ...rest, source, schemaVersion: 1 } as WorkPageConfig))(current)); };
  const patch = <K extends keyof WorkPageConfig>(key: K, value: WorkPageConfig[K]) => { setConfig((current) => ({ ...current, [key]: value })); };
  return <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
    <div><h1 className="text-xl font-bold">내 업무 페이지</h1><p className="mt-2 text-sm text-muted-foreground">필요한 조회 화면을 구성하고 버전별로 저장합니다. 나에게만 보이며, 조회할 때마다 현재 권한으로 최신 반영 자료를 확인합니다. 저장되는 것은 화면 구성이고 사업 자료의 복사본이 아닙니다.</p></div>
    <Link className="text-sm text-blue-700 underline" to={location.pathname.startsWith('/portal') ? '/portal/cashflow-assistant' : '/cashflow-assistant'}>현금흐름 조회·진단 바로 열기</Link>
    {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {message && <p role="status" className="rounded bg-blue-50 p-3 text-sm">{message}</p>}
    <AssistantComposer mode="page" yearMonth={config.yearMonth} onProposal={(value) => { if (!busy && leaveEditor()) { setConfig(value); } }} />
    <div className="grid min-w-0 grid-cols-1 gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="space-y-3"><Button variant="outline" disabled={busy} onClick={() => { if (leaveEditor()) { setPage(null); setConfig(initialConfig()); setPreview(null); setVersions([]); } }}>새 업무 페이지</Button>{loading && <p role="status">목록을 불러오고 있습니다.</p>}{!loading && !pages.length && <p className="text-sm text-muted-foreground">저장한 페이지가 없습니다.</p>}{pages.map((item) => <button key={item.id} disabled={busy} className={`block w-full rounded-lg border p-3 text-left ${page?.id === item.id ? 'border-blue-500 bg-blue-50' : ''}`} onClick={() => { if (leaveEditor()) void run(async () => { const value = await client.get(item.id); if (alive.current) apply(value); }); }}><strong className="block break-words text-sm">{item.config.title}</strong><span className="text-xs text-muted-foreground">버전 {item.version} · {formatTime(item.updatedAt)}</span></button>)}</aside>
      <div className="space-y-4"><fieldset disabled={busy} className="space-y-4 rounded-xl border bg-card p-4"><legend className="px-2 font-semibold">페이지 구성 {page ? `· 버전 ${page.version}` : '· 새 페이지'}</legend>
        <label className="block text-sm">제목<Input className="mt-1" value={config.title} maxLength={80} onChange={(e) => patch('title', e.target.value)} /></label>
        <label className="block text-sm">설명 (선택)<Textarea className="mt-1" value={config.description} maxLength={500} onChange={(e) => patch('description', e.target.value)} /></label>
        <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">조회할 자료<select className="mt-1 w-full rounded border p-2" value={config.source} onChange={(e) => changeSource(e.target.value as WorkPageConfig['source'])}><option value="insight-dashboard">CEO 인사이트 · 여러 지표 구성</option><option value="cashflow-evidence">현금흐름 반영 자료</option><option value="service-guidance">서비스 이용 안내</option></select></label><label className="text-sm">표시 방식<select className="mt-1 w-full rounded border p-2" value={config.presentation} onChange={(e) => patch('presentation', e.target.value as WorkPageConfig['presentation'])}><option value="table">표</option><option value="cards">카드</option></select></label></div>
        {config.source !== 'service-guidance' && <div className="grid gap-4 sm:grid-cols-2"><label className="text-sm">조회 연월<Input type="month" value={config.yearMonth} onChange={(e) => patch('yearMonth', e.target.value)} /></label><label className="text-sm">사업명·CIC 필터 (선택)<Input value={config.search} maxLength={100} onChange={(e) => patch('search', e.target.value)} /></label></div>}
        {config.source === 'insight-dashboard' && <InsightEditor config={config} onChange={(value) => { setConfig(value); }} />}
        <div className="flex flex-wrap gap-2"><Button onClick={() => void save()}>현재 구성 저장</Button><Button variant="outline" onClick={() => setPreview({ ...config })}>미리보기</Button>{page && <><Button variant="outline" onClick={() => void run(async () => { const result = await client.versions(page.id); if (alive.current) { setVersions(result.items); if (result.truncated) setMessage('최근 100개 버전만 표시됩니다.'); } })}>저장 이력</Button><Button variant="outline" onClick={() => { if (window.confirm('이 개인 업무 페이지를 삭제할까요? 사업 자료는 삭제되지 않습니다.')) void run(async () => { await client.remove(page.id, page.version); if (alive.current) { setPages((items) => items.filter((item) => item.id !== page.id)); setPage(null); setConfig(initialConfig()); setPreview(null); setVersions([]); setMessage('개인 업무 페이지를 삭제했습니다.'); } }); }}>페이지 삭제</Button></>}</div>
      </fieldset>
      {versions.length > 0 && <section className="rounded-lg border p-4"><h2 className="font-semibold">저장 이력</h2><p className="mt-1 text-xs text-muted-foreground">이전 구성을 복원하면 새 버전으로 저장됩니다. 조회 자료는 복원 시점의 권한으로 다시 확인합니다.</p>{versions.map((version) => <div key={version.version} className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-3 text-sm"><div>버전 {version.version} · {formatTime(version.updatedAt)}<p className="break-all text-xs text-muted-foreground">저장 계정: {version.updatedBy}</p></div><Button variant="outline" disabled={busy || version.version === page?.version} onClick={() => { if (leaveEditor()) void run(async () => { const saved = await client.restore(page!.id, page!.version, version.version); if (alive.current) { apply(saved); setPages((items) => [saved, ...items.filter((item) => item.id !== saved.id)]); setMessage(`버전 ${version.version} 구성을 새 버전 ${saved.version}으로 복원했습니다.`); } }); }}>이 구성 복원</Button></div>)}</section>}
      {preview && <section className="space-y-4 rounded-xl border p-4"><h2 className="font-semibold">미리보기 · {preview.title}</h2><p className="whitespace-pre-wrap text-sm">{preview.description}</p>{JSON.stringify(config) !== JSON.stringify(preview) && <p role="status" className="text-sm text-amber-800">미리보기는 이전 구성입니다. 위 미리보기 버튼으로 수정한 구성을 적용해 주세요.</p>}<div ref={(element) => { if (element) element.inert = JSON.stringify(config) !== JSON.stringify(preview); }} className={JSON.stringify(config) !== JSON.stringify(preview) ? 'opacity-60' : ''}>{preview.source === 'insight-dashboard' ? <InsightDashboard config={preview} /> : preview.source === 'cashflow-evidence' ? <CashflowEvidencePanel yearMonth={preview.yearMonth} search={preview.search} presentation={preview.presentation} /> : <ServiceGuidance />}</div></section>}
      </div>
    </div>
  </div>;
}
