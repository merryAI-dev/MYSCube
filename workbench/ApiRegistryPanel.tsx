import { useEffect, useRef, useState } from 'react';
import { workbenchRequest } from './client';
import { RecoveryPanel } from './RecoveryPanel';

type Parameter = { type: 'string' | 'integer' | 'number' | 'boolean'; required?: boolean; label?: string; example?: unknown };
type Definition = { name: string; description: string; enabled: boolean; parameters: Record<string, Parameter> } & ({ kind: 'analytics-copy'; plan: Record<string, unknown> } | { kind: 'external-read'; endpointId: string; endpointVersion: number });
type Endpoint = { id: string; version: number; name: string; description: string; parameters: Record<string, Parameter>; responseSchema: Record<string, unknown> };
type RegisteredApi = { id: string; version: number; definition: Definition };
type Dataset = { datasetId: string; definition?: { id?: string; version?: string; label?: string; meaning?: string; fields?: Record<string, { label?: string; meaning?: string }>; metrics?: Record<string, { label?: string; meaning?: string }> }; semanticDefinitionVersion?: string; asOf?: string; capturedAt?: string };
type Catalog = { items: Dataset[]; unavailable?: Array<{ datasetId: string; message?: string }> };
const json = (value: unknown) => JSON.stringify(value, null, 2);
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const parameters: Record<string, Parameter> = {
  yearMonth: { type: 'string', required: true, label: '정산 월', example: '2026-09' },
  weekNo: { type: 'integer', required: true, label: '주차', example: 1 },
};
const example = (dataset?: Dataset): Extract<Definition, { kind: 'analytics-copy' }> => {
  const inflow = dataset?.definition?.id === 'cashflow_inflow';
  return { name: inflow ? '주차별 입금 확인' : '주정산 상태 확인', description: inflow ? '선택한 정산 주차의 실제 입금액과 금액 확인이 필요한 항목을 함께 조회합니다.' : '선택한 월·주차의 제출 상태와 조회 상태를 함께 확인합니다.', kind: 'analytics-copy', enabled: true, parameters,
    plan: { datasetId: dataset?.datasetId || 'weekly_submission', definitionVersion: dataset?.definition?.version || dataset?.semanticDefinitionVersion || '1',
      ...(inflow ? { measures: ['total_amount', 'known_amount_total'] } : { select: ['project_id', 'status', 'health'] }),
      time: { yearMonth: { $input: 'yearMonth' }, weekNo: { $input: 'weekNo' } },
      ...(inflow ? { filters: [{ field: 'mode', op: 'eq', value: 'actual' }, { field: 'receipt_scope', op: 'eq', value: 'all_inflows' }, { field: 'currency', op: 'eq', value: 'KRW' }] } : {}) } };
};
const parseObject = (text: string, label: string) => {
  if (text.length > 60_000) throw new Error(`${label}이 너무 깁니다. 조회 항목을 줄여 주세요.`);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error(`${label}의 JSON 형식을 확인해 주세요. 쉼표·따옴표·괄호가 맞아야 합니다.`); }
  if (!isRecord(value)) throw new Error(`${label}은 항목 이름과 값을 담은 객체여야 합니다.`);
  return value;
};
const validApi = (value: unknown): value is RegisteredApi => isRecord(value) && typeof value.id === 'string' && Number.isSafeInteger(value.version)
  && isRecord(value.definition) && ['analytics-copy', 'external-read'].includes(String(value.definition.kind)) && typeof value.definition.name === 'string'
  && typeof value.definition.description === 'string' && typeof value.definition.enabled === 'boolean' && isRecord(value.definition.parameters) && (value.definition.kind === 'analytics-copy' ? isRecord(value.definition.plan) : typeof value.definition.endpointId === 'string' && Number.isSafeInteger(value.definition.endpointVersion));
const examplesFrom = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([, spec]) => isRecord(spec) && Object.hasOwn(spec, 'example')).map(([name, spec]) => [name, (spec as Record<string, unknown>).example]));
const fieldStyle = { width: '100%', marginTop: 7, padding: 10, border: '1px solid #d1d6db', borderRadius: 10, background: '#fff', color: '#191f28' };

export function ApiRegistryPanel({ onChanged }: { onChanged?: () => void }) {
  const [items, setItems] = useState<RegisteredApi[]>([]);
  const [catalog, setCatalog] = useState<Catalog>({ items: [] });
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [kind, setKind] = useState<'analytics-copy' | 'external-read'>('analytics-copy');
  const [endpointKey, setEndpointKey] = useState('');
  const [selected, setSelected] = useState<RegisteredApi | null>(null);
  const [name, setName] = useState(''); const [description, setDescription] = useState(''); const [enabled, setEnabled] = useState(true);
  const [datasetId, setDatasetId] = useState(''); const [parameterText, setParameterText] = useState(json(parameters)); const [planText, setPlanText] = useState(json(example().plan));
  const [testInput, setTestInput] = useState(json({ yearMonth: '2026-09', weekNo: 1 }));
  const [result, setResult] = useState<unknown>(null); const [hasResult, setHasResult] = useState(false);
  const [busy, setBusy] = useState(''); const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [loaded, setLoaded] = useState(false); const [dirty, setDirty] = useState(false);
  const active = useRef(true); const working = useRef(false);
  const [editorTarget, setEditorTarget] = useState(0);
  const clearResult = () => { setResult(null); setHasResult(false); };
  const install = (api: RegisteredApi | null, definition?: Definition) => {
    setEditorTarget((value) => value + 1);
    const source = definition || api?.definition;
    setSelected(api); setName(source?.name || ''); setDescription(source?.description || ''); setEnabled(source?.enabled ?? true);
    setKind(source?.kind || 'analytics-copy'); setEndpointKey(source?.kind === 'external-read' ? `${source.endpointId}:${source.endpointVersion}` : '');
    setDatasetId(source?.kind === 'analytics-copy' && typeof source.plan.datasetId === 'string' ? source.plan.datasetId : '');
    setParameterText(json(source?.parameters || parameters)); setPlanText(json(source?.kind === 'analytics-copy' ? source.plan : example().plan));
    setTestInput(json(examplesFrom(source?.parameters || parameters))); clearResult(); setDirty(Boolean(definition));
  };
  const abandon = () => !dirty || window.confirm('저장하지 않은 연결 설정이 있습니다. 변경 내용을 버리고 계속할까요?');
  const run = async (label: string, action: () => Promise<void>, clearOnFailure = true) => {
    if (working.current) return;
    working.current = true; setBusy(label); setError(''); setNotice(''); clearResult();
    try { await action(); }
    catch (reason) {
      if (active.current) {
        setError(reason instanceof Error ? reason.message : 'API 연결을 확인하지 못했습니다. 다시 시도해 주세요.');
        if (clearOnFailure) { setItems([]); setCatalog({ items: [] }); setEndpoints([]); setLoaded(false); }
        clearResult();
      }
    } finally { working.current = false; if (active.current) setBusy(''); }
  };
  const refresh = async (keepSelection = true) => {
    const [registered, available, external]: unknown[] = await Promise.all([workbenchRequest('/workbench-apis'), workbenchRequest('/workbench-apis/catalog'), workbenchRequest('/workbench-apis/endpoints')]);
    if (!isRecord(registered) || !Array.isArray(registered.items) || registered.items.some((item) => !validApi(item))
      || !isRecord(available) || !Array.isArray(available.items) || available.items.some((item) => !isRecord(item) || typeof item.datasetId !== 'string')) throw new Error('등록 목록이나 연결 가능한 사본의 형식을 확인하지 못했습니다.');
    if (!isRecord(external) || !Array.isArray(external.items) || external.items.some((item) => !isRecord(item) || typeof item.id !== 'string' || !Number.isSafeInteger(item.version) || !isRecord(item.parameters) || !isRecord(item.responseSchema))) throw new Error('외부 API 연결 목록을 확인하지 못했습니다.');
    if (!active.current) return;
    setEndpoints(external.items as Endpoint[]);
    const freshItems = registered.items as RegisteredApi[];
    const semantic = isRecord(available.semantic) ? available.semantic : available;
    if (!Array.isArray(semantic.items) || semantic.items.some((item) => !isRecord(item) || typeof item.datasetId !== 'string')) throw new Error('사본의 조회 기준을 확인하지 못했습니다.');
    const unavailable = Array.isArray(semantic.unavailable) ? semantic.unavailable.filter((item) => isRecord(item) && typeof item.datasetId === 'string') as Catalog['unavailable'] : [];
    const missing = Array.isArray(available.missingDatasetIds) ? available.missingDatasetIds.filter((id): id is string => typeof id === 'string').map((datasetId) => ({ datasetId, message: '분석 사본이 아직 준비되지 않았습니다.' })) : [];
    setItems(freshItems); setCatalog({ items: semantic.items as Dataset[], unavailable: [...(unavailable || []), ...missing] }); setLoaded(true);
    if (keepSelection && selected) {
      const fresh = freshItems.find((item) => item.id === selected.id);
      if (fresh) install(fresh); else { install(null); setNotice('선택한 연결을 더 이상 조회할 수 없습니다. 목록에서 다시 선택해 주세요.'); }
    } else if (keepSelection) install(null);
  };
  useEffect(() => {
    active.current = true;
    void run('연결 목록 확인 중', () => refresh(false));
    return () => { active.current = false; };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  const edit = (change: () => void) => { change(); setDirty(true); setNotice(''); clearResult(); };
  const readDefinition = (): Definition => {
    const parameterObject = parseObject(parameterText, '입력 정의');
    if (!name.trim()) throw new Error('연결 이름을 입력해 주세요.');
    if (!description.trim()) throw new Error('이 조회로 무엇을 확인하는지 설명을 입력해 주세요.');
    if (kind === 'external-read') {
      const endpoint = endpoints.find((item) => `${item.id}:${item.version}` === endpointKey);
      if (!endpoint) throw new Error('승인된 외부 API 연결을 선택해 주세요.');
      return { name: name.trim(), description: description.trim(), kind: 'external-read', enabled, parameters: endpoint.parameters, endpointId: endpoint.id, endpointVersion: endpoint.version };
    }
    const plan = parseObject(planText, '조회 정의');
    if (!datasetId || plan.datasetId !== datasetId) throw new Error('연결할 사본과 조회 정의의 datasetId가 다릅니다. 같은 사본을 선택해 주세요.');
    if (enabled && !catalog.items.some((item) => item.datasetId === datasetId)) throw new Error('현재 연결할 수 있는 사본이 없습니다. 사본 준비 상태를 확인해 주세요.');
    return { name: name.trim(), description: description.trim(), kind: 'analytics-copy', enabled, parameters: parameterObject as Record<string, Parameter>, plan };
  };
  const save = () => {
    let definition: Definition;
    try { definition = readDefinition(); } catch (reason) { setError(reason instanceof Error ? reason.message : '입력을 확인해 주세요.'); clearResult(); return; }
    void run('연결 저장 중', async () => {
      const response: unknown = await workbenchRequest(selected ? `/workbench-apis/${encodeURIComponent(selected.id)}` : '/workbench-apis', selected ? 'PUT' : 'POST', { expectedVersion: selected?.version || 0, definition });
      if (!validApi(response)) throw new Error('저장 결과의 버전을 확인하지 못했습니다. 새로고침으로 확인해 주세요.');
      if (!active.current) return;
      install(response); setItems((previous) => [response, ...previous.filter((item) => item.id !== response.id)]);
      setNotice(`연결 v${response.version}을 저장했습니다. 기존 페이지의 연결 버전은 자동으로 바뀌지 않습니다.`); onChanged?.();
    });
  };
  const test = () => {
    if (!selected || dirty) { setError('연결 설정을 먼저 저장한 뒤 해당 버전으로 테스트해 주세요.'); return; }
    let input: Record<string, unknown>;
    try { input = parseObject(testInput, '테스트 입력'); } catch (reason) { setError(reason instanceof Error ? reason.message : '입력을 확인해 주세요.'); clearResult(); return; }
    void run('저장한 연결 테스트 중', async () => {
      const response: unknown = await workbenchRequest(`/workbench-apis/${encodeURIComponent(selected.id)}/test`, 'POST', { version: selected.version, input });
      if (!active.current) return;
      setResult(response); setHasResult(true); setNotice(`저장된 연결 v${selected.version}의 테스트 결과입니다. null은 미확인 값이며 0으로 바꾸지 않습니다.`);
    });
  };
  const selectedDataset = catalog.items.find((item) => item.datasetId === datasetId);
  const selectedEndpoint = endpoints.find((item) => `${item.id}:${item.version}` === endpointKey);
  const resultText = hasResult ? json(result) : '';
  return <section className="side-panel" aria-label="API 연결 관리" data-testid="api-registry-panel">
    <div className="section-heading"><div><h2>API 연결 관리</h2><p className="subtle">페이지에서 조회할 자료와 입력 항목을 등록합니다. 분석 사본 또는 승인된 외부 읽기 API를 연결할 수 있습니다.</p></div></div>
    <div className="header-actions"><button type="button" className="quiet compact" disabled={Boolean(busy)} onClick={() => { if (abandon()) void run('연결 목록 확인 중', () => refresh()); }}>목록 새로고침</button><button type="button" className="quiet compact" disabled={Boolean(busy)} onClick={() => { if (abandon()) { install(null); setError(''); setNotice('새 연결의 이름과 조회할 사본을 선택해 주세요.'); } }}>새 연결</button></div>
    <p className="subtle">외부 서비스는 서버에 승인된 연결만 선택할 수 있습니다. 주소나 비밀키를 이 화면에 입력하지 마세요.{!endpoints.length && ' 외부 연결 준비 중입니다.'}</p>
    <RecoveryPanel scope="registered-api" disabled={Boolean(busy)} targetKey={String(editorTarget)} onRecovered={(value) => {
      if (working.current || !validApi(value) || !abandon()) return false;
      install(value); setItems((previous) => [value, ...previous.filter((item) => item.id !== value.id)]); setError(''); onChanged?.();
      void run('복구한 연결의 조회 기준 확인 중', async () => { await refresh(false); setNotice(`복구한 연결 v${value.version}을 불러왔습니다. 기존 화면의 연결 버전은 자동으로 바뀌지 않습니다.`); }, false);
      return true;
    }} />
    {busy && <p className="turn-pending" role="status">{busy}</p>}
    {error && <p className="conversation-error" role="alert">{error}</p>}
    {notice && <p className="conversation-disabled" role="status">{notice}</p>}
    {loaded && kind === 'analytics-copy' && !catalog.items.length && <p className="bound-evidence-warning">연결 가능한 분석 사본이 없습니다. 등록 화면의 예시는 실제 조회 자료가 아닙니다. 사본이 준비된 뒤 저장·테스트해 주세요.</p>}
    {catalog.unavailable?.length ? <details><summary>현재 사용할 수 없는 사본 {catalog.unavailable.length}개</summary>{catalog.unavailable.map((item) => <p className="subtle" key={item.datasetId}>{item.datasetId} · {item.message || '정의 또는 조회 상태를 확인해 주세요.'}</p>)}</details> : null}
    {items.length ? <label>등록한 연결<select aria-label="등록한 API 연결" style={fieldStyle} disabled={Boolean(busy)} value={selected?.id || ''} onChange={(event) => { if (abandon()) { install(items.find((item) => item.id === event.target.value) || null); setError(''); setNotice(''); } }}><option value="">새 연결 작성</option>{items.map((item) => <option key={item.id} value={item.id}>{item.definition.name} · v{item.version} · {item.definition.enabled ? '사용 중' : '중지'}</option>)}</select></label> : loaded ? <p className="subtle">아직 등록한 연결이 없습니다. 아래에서 첫 연결을 만들 수 있습니다.</p> : null}
    <fieldset disabled={Boolean(busy)}>
      <label>연결 종류<select aria-label="연결 종류" style={fieldStyle} value={kind} onChange={(event) => edit(() => { setKind(event.target.value as typeof kind); setEndpointKey(''); })}><option value="analytics-copy">분석 사본 조회</option><option value="external-read" disabled={!endpoints.length}>승인된 외부 API{!endpoints.length ? ' · 연결 준비 중' : ''}</option></select></label>
      <label>연결 이름<input maxLength={80} value={name} placeholder="예: 주정산 상태 확인" onChange={(event) => edit(() => setName(event.target.value))} /></label>
      <label>조회 설명<textarea rows={3} maxLength={1000} value={description} placeholder="무엇을 어떤 기준으로 확인하는 연결인지 적어 주세요." onChange={(event) => edit(() => setDescription(event.target.value))} /></label>
      {kind === 'analytics-copy' ? <><label>연결할 사본<select aria-label="연결할 사본" style={fieldStyle} value={datasetId} onChange={(event) => edit(() => {
        const next = event.target.value; setDatasetId(next);
        try { const plan = parseObject(planText, '조회 정의'); const item = catalog.items.find((entry) => entry.datasetId === next); setPlanText(json({ ...plan, datasetId: next, definitionVersion: item?.definition?.version || item?.semanticDefinitionVersion || '1' })); } catch { /* Keep malformed text visible for correction. */ }
      })}><option value="">사본 선택</option>{catalog.items.map((item) => <option key={item.datasetId} value={item.datasetId}>{item.definition?.label || item.datasetId} · {item.datasetId}</option>)}{datasetId && !selectedDataset && <option value={datasetId}>{datasetId} · 현재 연결 확인 필요</option>}</select></label>
      {selectedDataset?.definition?.meaning && <p className="subtle">{selectedDataset.definition.meaning}</p>}
      <button type="button" className="quiet compact" disabled={!selectedDataset || !['weekly_submission', 'cashflow_inflow'].includes(selectedDataset.definition?.id || '')} onClick={() => {
        if (abandon()) { install(null, example(selectedDataset)); setError(''); setNotice('선택한 사본의 예시를 새 연결에 채웠습니다. 입력값과 조회 기준을 검토한 뒤 저장해 주세요.'); }
      }}>선택한 사본의 예제로 시작</button>
      <details><summary>입력·조회 정의 편집</summary><p className="subtle">등록된 항목과 계산 기준만 사용할 수 있습니다. 조회 정의에 입력값을 연결하려면 {'{"$input":"입력 이름"}'}을 사용하세요. SQL이나 인증 정보는 입력하지 않습니다.</p>
        <label>입력 정의 JSON<textarea className="code" style={{ minHeight: 190 }} value={parameterText} onChange={(event) => edit(() => setParameterText(event.target.value))} spellCheck={false} /></label>
        <label>조회 정의 JSON<textarea className="code" style={{ minHeight: 240 }} value={planText} onChange={(event) => edit(() => setPlanText(event.target.value))} spellCheck={false} /></label>
        {selectedDataset?.definition && <details><summary>이 사본에서 사용할 수 있는 항목</summary><div className="review"><pre>{json({ fields: selectedDataset.definition.fields, metrics: selectedDataset.definition.metrics })}</pre></div></details>}
      </details>
      </> : <>
        <label>승인된 외부 연결<select aria-label="승인된 외부 연결" style={fieldStyle} value={endpointKey} onChange={(event) => edit(() => {
          setEndpointKey(event.target.value); const endpoint = endpoints.find((item) => `${item.id}:${item.version}` === event.target.value);
          if (endpoint) { setParameterText(json(endpoint.parameters)); setTestInput(json(examplesFrom(endpoint.parameters))); if (!name) setName(endpoint.name); if (!description) setDescription(endpoint.description); }
        })}><option value="">외부 연결 선택</option>{endpoints.map((item) => <option key={`${item.id}:${item.version}`} value={`${item.id}:${item.version}`}>{item.name} · v{item.version}</option>)}</select></label>
        {selectedEndpoint && <><p className="subtle">{selectedEndpoint.description} · 이 연결은 조회만 수행합니다. 입력 항목과 응답 형식은 승인된 설정을 따릅니다.</p><details><summary>외부 API 입력·응답 형식 확인</summary><div className="review"><pre>{json({ parameters: selectedEndpoint.parameters, responseSchema: selectedEndpoint.responseSchema })}</pre></div></details></>}
      </>}
      <label className="reference"><input type="checkbox" checked={enabled} onChange={(event) => edit(() => setEnabled(event.target.checked))} /><span><strong>이 연결 사용</strong><small>해제하고 저장하면 이 연결의 새 조회가 중단됩니다. 기존 페이지가 다음에 조회할 때 연결 중지 안내를 받습니다.</small></span></label>
      <div className="header-actions"><button type="button" onClick={save} disabled={!loaded}>{selected ? '변경 내용 저장' : '연결 등록'}</button><span className={dirty ? 'stale-state' : 'badge'}>{dirty ? '저장하지 않은 변경' : selected ? `저장 버전 v${selected.version}` : '새 연결'}</span></div>
    </fieldset>
    {selected && <section className="review" aria-label="API 연결 테스트"><h3>저장 버전 v{selected.version} 테스트</h3><p>현재 계정의 권한으로 실제 분석 사본을 조회합니다. 확인되지 않은 값과 0원은 구분해서 반환합니다.</p>
      <label>테스트 입력 JSON<textarea rows={5} disabled={Boolean(busy)} value={testInput} onChange={(event) => { setTestInput(event.target.value); clearResult(); }} spellCheck={false} /></label>
      <div className="header-actions"><button type="button" className="quiet compact" disabled={Boolean(busy)} onClick={() => { try { setTestInput(json(examplesFrom(parseObject(parameterText, '입력 정의')))); clearResult(); } catch (reason) { setError(reason instanceof Error ? reason.message : '입력 정의를 확인해 주세요.'); } }}>예시 입력 불러오기</button><button type="button" disabled={Boolean(busy) || dirty || !enabled || !loaded} onClick={test}>저장한 연결 테스트</button></div>
      {dirty && <p className="subtle">변경 내용을 저장해야 새 설정으로 테스트할 수 있습니다.</p>}
      {hasResult && <div role="region" aria-label="API 테스트 결과"><pre>{resultText.slice(0, 100_000)}</pre>{resultText.length > 100_000 && <p className="subtle">화면에는 결과의 앞부분만 표시했습니다. 조회 범위를 좁혀 확인해 주세요.</p>}</div>}
    </section>}
  </section>;
}
