import { useEffect, useRef, useState } from 'react';
import { request } from './client';
import { compareScreenEvidence, type ScreenQueryExpectation } from './screen-evidence';

type Binding = { evidenceId: string };
type Evidence = {
  evidenceId: string;
  columns: Array<{ name: string; label?: string }>;
  rows: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
  datasetVersions?: Record<string, string>;
  semantic?: { definitionVersions?: Record<string, { id: string; version: string; hash?: string }>; appliedPlan?: Record<string, unknown> };
  truncated?: boolean;
};
type State = { status: 'loading' | 'ready' | 'error'; evidence: Evidence[]; error?: string };
const labels: Record<string, string> = {
  project_id: '사업 식별자', year_month: '정산 월', week_no: '정산 주차', mode: '실적·예정', receipt_scope: '입금 항목 범위', currency: '통화',
  total_amount: '선택한 기준의 입금 합계', known_amount_total: '확인된 항목 부분합', project_count: '대상 사업 수', observation_count: '대상 사업·주차 수',
  missing_observation_count: '금액 확인이 필요한 사업·주차 수', expected_cell_count: '확인 대상 항목 수', confirmed_cell_count: '확인한 항목 수', missing_cell_count: '확인이 필요한 항목 수',
  amount: '모든 항목을 확인한 입금액', known_amount: '확인된 항목 부분합', expected_cells: '확인 대상 항목 수', confirmed_cells: '확인한 항목 수', missing_cells: '확인이 필요한 항목 수',
  source_status: '원본 확인 상태', week_start: '정산주 시작일', week_end: '정산주 종료일', captured_at: '원본을 읽은 시각',
  status: '주정산 상태', recorded_status: '저장된 상태', health: '조회 상태', revision: '자료 버전', submitted_at: '제출 시각', approved_at: '승인 시각',
};
const amounts = new Set(['total_amount', 'known_amount_total', 'amount', 'known_amount']);
const counts = new Set(['project_count', 'observation_count', 'missing_observation_count', 'expected_cell_count', 'confirmed_cell_count', 'missing_cell_count', 'expected_cells', 'confirmed_cells', 'missing_cells']);
const metadataLabels: Record<string, string> = { definition: '계산 기준', resultScope: '표시 범위', asOf: '원본 확인 기준', capturedAt: '자료를 모은 시각', completeness: '자료 완전성' };
const valueLabels: Record<string, string> = { actual: '실제 입금', projection: '입금 예정', all_inflows: '전체 입금 항목(내부 선입금 포함)', sales: '매출 입금', sales_with_vat: '매출·매출부가세 입금', OK: '확인됨', UNAVAILABLE: '확인하지 못함', KRW: '원화', WAITING_FOR_UPDATE: '업데이트 대기', PENDING_APPROVAL: '조직장 승인 대기', COMPLETED: '승인 완료' };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const text = (value: unknown) => typeof value === 'string' ? value.slice(0, 1000) : typeof value === 'boolean' ? value ? '예' : '아니오' : typeof value === 'number' && Number.isFinite(value) ? String(value) : '확인 필요';
const comparisons: Record<string, string> = { eq: '같음', ne: '제외', in: '포함', not_in: '제외', gt: '초과', gte: '이상', lt: '미만', lte: '이하', is_null: '미입력', is_not_null: '입력됨' };
const integerText = (value: unknown) => (typeof value !== 'number' || Number.isSafeInteger(value)) && /^-?(0|[1-9]\d*)$/.test(text(value)) ? text(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : '확인 필요';
function cellText(name: string, value: unknown) {
  if (amounts.has(name)) return value === null || value === undefined ? '계산 불가·입력 확인 필요' : integerText(value) === '확인 필요' ? '확인 필요' : `${integerText(value)}원`;
  if (counts.has(name)) return integerText(value);
  return valueLabels[text(value)] || text(value);
}

function EvidenceTable({ evidence, index, expected }: { evidence: Evidence; index: number; expected?: ScreenQueryExpectation }) {
  const [page, setPage] = useState(0);
  const columns = evidence.columns.map((column) => column.name);
  const pageSize = 20; const pages = Math.max(1, Math.ceil(evidence.rows.length / pageSize));
  const definitions = Object.values(evidence.semantic?.definitionVersions || {});
  const financial = definitions.some((definition) => definition?.id === 'cashflow_inflow');
  const hasMissingAmounts = financial && evidence.rows.some((row) => columns.some((name) => amounts.has(name) && row[name] == null) || /^[1-9]\d*$/.test(String(row.missing_observation_count ?? row.missing_cells ?? '')));
  const match = expected ? compareScreenEvidence(expected, evidence) : null;
  const criteria = evidence.semantic?.appliedPlan;
  return <article className="bound-evidence-card">
    <h3>{financial ? '입금 계산 근거' : '조회 근거'} {index + 1}<span>집계 정의 {definitions.map((definition) => `v${definition.version}`).join(', ')}</span></h3>
    {match === 'criteria-changed' && <p role="alert" className="bound-evidence-warning">요청한 조회 조건과 실제 화면의 조회 조건이 다릅니다. 필터를 직접 바꾸지 않았다면 화면 소스를 확인해 주세요. 아래 표는 현재 API가 실제로 조회한 결과이며, 앞선 대화의 결과를 대신 표시하지 않습니다.</p>}
    {match === 'unverified' && <p role="alert" className="bound-evidence-warning">이 결과의 조회 기준을 확인하지 못했습니다. 앞서 요청한 자료와 일치한다고 판단하지 마세요.</p>}
    {match === 'data-updated' && <p className="notice">앞선 대화 이후 자료가 갱신되었습니다. 조회 조건은 같으며 아래 표는 새 자료를 기준으로 표시합니다.</p>}
    {criteria && <details open={match === 'criteria-changed'}><summary>실제로 조회한 기간과 조건</summary><dl className="bound-evidence-meta">{record(criteria.time) && <div><dt>기간</dt><dd>{text(criteria.time.yearMonth)} · {criteria.time.weekScope === 'all' ? '전체 주차' : `${text(criteria.time.weekNo)}주차`}</dd></div>}{Array.isArray(criteria.filters) && criteria.filters.filter(record).map((filter, itemIndex) => <div key={itemIndex}><dt>{labels[text(filter.field)] || text(filter.field)}</dt><dd>{comparisons[text(filter.op)] || text(filter.op)}{!['is_null', 'is_not_null'].includes(text(filter.op)) && <> · {Array.isArray(filter.value) ? filter.value.map((value) => valueLabels[text(value)] || text(value)).join(', ') : valueLabels[text(filter.value)] || text(filter.value)}</>}</dd></div>)}</dl></details>}
    <dl className="bound-evidence-meta">{Object.entries(metadataLabels).map(([name, label]) => <div key={name}><dt>{label}</dt><dd>{text(evidence.metadata?.[name])}</dd></div>)}</dl>
    {hasMissingAmounts && <p className="bound-evidence-warning">일부 금액을 확인하지 못했습니다. ‘확인된 항목 부분합’을 전체 입금 합계로 사용하지 마세요.</p>}
    {columns.length ? <><div className="bound-evidence-table" role="region" aria-label="입금 계산 근거 표" tabIndex={0}><table><caption>서버가 계산한 값과 확인 범위 · {evidence.rows.length}행</caption><thead><tr>{columns.map((name) => <th key={name} scope="col">{evidence.columns.find((column) => column.name === name)?.label || labels[name] || name}</th>)}</tr></thead><tbody>{evidence.rows.length ? evidence.rows.slice(page * pageSize, (page + 1) * pageSize).map((row, rowIndex) => <tr key={page * pageSize + rowIndex}>{columns.map((name) => <td key={name} className={amounts.has(name) && row[name] == null ? 'bound-evidence-missing' : undefined}>{financial || counts.has(name) ? cellText(name, row[name]) : valueLabels[text(row[name])] || text(row[name])}</td>)}</tr>) : <tr><td colSpan={columns.length}>선택한 범위에 조회 결과가 없습니다. 자료가 없다는 사실만으로 금액이나 업무 상태를 판단하지 않습니다.</td></tr>}</tbody></table></div>{pages > 1 && <nav className="bound-evidence-pagination" aria-label="계산 근거 페이지"><button className="quiet compact" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>이전</button><span>{page + 1} / {pages}페이지</span><button className="quiet compact" disabled={page + 1 === pages} onClick={() => setPage((value) => value + 1)}>다음</button></nav>}</> : <p className="subtle">이 조회에는 표시할 입금 금액이나 확인 범위 항목이 없습니다. 미리보기의 금액을 확인된 값으로 판단하지 마세요.</p>}
    {evidence.truncated && <p className="bound-evidence-warning">조회 한도로 일부 결과만 포함되어 있습니다. 전부 확인하려면 조회 범위를 나누어 주세요.</p>}
  </article>;
}

function BoundEvidenceRequest({ ids, expectedByEvidence, onPermissionError }: { ids: string[]; expectedByEvidence: Map<string, ScreenQueryExpectation>; onPermissionError?: (reason: unknown) => void }) {
  const [state, setState] = useState<State>({ status: 'loading', evidence: [] });
  const [attempt, setAttempt] = useState(0);
  const permissionError = useRef(onPermissionError); permissionError.current = onPermissionError;
  const idsKey = JSON.stringify(ids);
  useEffect(() => {
    let active = true;
    setState({ status: 'loading', evidence: [] });
    void Promise.all(ids.map(async (id) => {
      const value: unknown = await request(`/evidence/${encodeURIComponent(id)}`);
      if (!record(value) || value.evidenceId !== id || !Array.isArray(value.columns) || !Array.isArray(value.rows) || value.columns.length > 64 || value.rows.length > 500 || value.columns.some((column) => !record(column) || typeof column.name !== 'string') || value.rows.some((row) => !record(row))) throw new Error('계산 근거의 형식을 확인할 수 없습니다.');
      return value as Evidence;
    })).then((values) => {
      const evidence = values;
      if (active) setState({ status: 'ready', evidence });
    }).catch((reason: unknown) => {
      if (!active) return;
      setState({ status: 'error', evidence: [], error: reason instanceof Error ? reason.message : '계산 근거 조회에 실패했습니다.' });
      if ([401, 403].includes(Number((reason as { status?: number })?.status))) permissionError.current?.(reason);
    });
    return () => { active = false; };
  }, [idsKey, attempt]);
  return <section className="bound-evidence" aria-label="계산 근거" data-testid="bound-evidence"><div className="bound-evidence-heading"><div><h2>계산 근거</h2><p>미리보기와 별도로 확인한 서버 계산 결과입니다. 금액과 누락 범위를 함께 확인해 주세요.</p></div><button className="quiet compact" disabled={state.status === 'loading'} onClick={() => { setState({ status: 'loading', evidence: [] }); setAttempt((value) => value + 1); }}>근거 다시 확인</button></div>
    {state.status === 'loading' && <p className="subtle" role="status">연결된 계산 근거와 현재 조회 권한을 확인하고 있습니다.</p>}
    {state.status === 'error' && <p className="bound-evidence-warning" role="alert" data-testid="bound-evidence-error">계산 근거를 확인하지 못했습니다. 이 근거 영역의 이전 금액은 표시하지 않습니다. 미리보기는 마지막 화면이므로 금액을 다시 확인해 주세요.<br />{state.error}</p>}
    {state.status === 'ready' && (state.evidence.length ? state.evidence.map((evidence, index) => <EvidenceTable key={evidence.evidenceId} evidence={evidence} index={index} expected={expectedByEvidence.get(evidence.evidenceId)} />) : <p className="subtle">이 화면에 표시할 조회 근거가 없습니다.</p>)}
  </section>;
}

export function BoundEvidence({ bindings, expectedQueries = [], onPermissionError }: { bindings?: Record<string, Binding>; expectedQueries?: ScreenQueryExpectation[]; onPermissionError?: (reason: unknown) => void }) {
  if (!bindings) return <p className="bound-evidence-unverified">조회 근거가 연결되지 않은 화면입니다. 직접 입력된 금액은 검증된 계산 결과가 아닙니다.</p>;
  const values = Object.values(bindings);
  const ids = [...new Set(values.map((binding) => binding?.evidenceId))].sort();
  if (!ids.length || ids.length > 6 || ids.some((id) => typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id))) return <p className="bound-evidence-warning" role="alert" data-testid="bound-evidence-error">계산 근거의 연결 정보를 확인할 수 없습니다. 이전 금액은 표시하지 않습니다.</p>;
  const expectedByEvidence = new Map(expectedQueries.flatMap((expected) => bindings[expected.apiId]?.evidenceId ? [[bindings[expected.apiId].evidenceId, expected] as const] : []));
  return <BoundEvidenceRequest key={JSON.stringify(ids)} ids={ids} expectedByEvidence={expectedByEvidence} onPermissionError={onPermissionError} />;
}
