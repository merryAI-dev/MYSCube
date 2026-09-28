import { useEffect, useState } from 'react';
import { workbenchRequest } from './client';

type Counts = Record<string, number | null>;
type Row = { day: string; environment: string; operationKey: string; mode: string; counts: Counts };
type HttpCounts = { total: number; status2xx: number; status4xx: number; status5xx: number; other: number };
type HttpRecords = {
  status: 'imported_sample' | 'partial'; measurementScope: 'http_response_log'; completeness: 'not_guaranteed';
  provenance: 'operator_export_unverified'; rate: null; overallRate: null; counts: HttpCounts;
  rows: Array<{ day: string; environment: string; operationKey: string | null; counts: HttpCounts }>;
  invalidRecords: number; truncated: boolean; lastImportedAt: string | null; note: string;
};
type Summary = {
  from: string; to: string; queriedAt?: string; measurementScope: 'logical_operation'; historicalOnly: true;
  sourceEnvironments: string[]; counts: Counts; rows: Row[]; truncated?: boolean; invalidRecords?: number;
  collection: { status: 'partial' | 'unverified' | 'degraded' | 'snapshot_ready'; completeness: 'not_guaranteed'; note: string };
  source: { capturedAt: string | null; sweepCompletedAt: string | null };
  clientErrors: { count: number | null; truncated: boolean; invalidRecords?: number; collection?: { status?: string } };
  httpRequests: { status: 'not_collected'; rate: null; note: string } | HttpRecords;
  observedSystemFailureRate: number | null;
};
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const boundedText = (value: unknown, limit = 100) => typeof value === 'string' && value.length > 0 && value.length <= limit;
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('ko-KR') : '확인 불가';
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '확인 불가';
const environments: Record<string, string> = { live: '운영', production: '운영', preview: '미리보기', local: '로컬 검증', isolated: '독립 도구', unknown: '환경 확인 필요' };
const modes: Record<string, string> = { manual: '직접 저장', automatic: '자동 저장', unknown: '저장 방식 확인 필요' };
const operations: Record<string, string> = {
  'registration.draft.save': '프로젝트 등록 임시저장', 'registration.submit': '프로젝트 등록 제출',
  'registration.draft.create': '프로젝트 등록 초안 만들기', 'project-change.draft.open': '프로젝트 수정 초안 열기',
  'project-change.draft.save': '프로젝트 수정 임시저장', 'project-change.submit': '프로젝트 수정 제출',
  'project.executive-review': '조직장 승인·반려',
};
const countColumns = [['total', '관측된 시도'], ['saved', '저장 확인'], ['system_failed', '시스템 오류'], ['rejected', '요청 거절·충돌'], ['validation_blocked', '입력 확인 요청'], ['pending', '처리 대기'], ['unknown', '결과 확인 필요']] as const;
const environmentLabel = (value: string) => `${environments[value] || '별도 환경'} (${value})`;
const httpColumns = [['total', '가져온 응답 수'], ['status2xx', 'HTTP 응답 정상 (2xx)'], ['status4xx', '요청 거절 (4xx)'], ['status5xx', '서버 오류 (5xx)'], ['other', '그 외']] as const;
const integer = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const validHttpCounts = (value: unknown) => record(value) && httpColumns.every(([key]) => integer(value[key]))
  && value.total === Number(value.status2xx) + Number(value.status4xx) + Number(value.status5xx) + Number(value.other);

function validHttpRecords(value: unknown): boolean {
  if (!record(value) || value.rate !== null) return false;
  if (value.status === 'not_collected') return true;
  return ['imported_sample', 'partial'].includes(String(value.status)) && value.measurementScope === 'http_response_log'
    && value.completeness === 'not_guaranteed' && value.provenance === 'operator_export_unverified' && value.overallRate === null
    && validHttpCounts(value.counts) && integer(value.invalidRecords) && typeof value.truncated === 'boolean'
    && (value.lastImportedAt === null || typeof value.lastImportedAt === 'string' && Number.isFinite(Date.parse(value.lastImportedAt)))
    && Array.isArray(value.rows) && value.rows.length <= 5000 && value.rows.every((row) => record(row) && boundedText(row.day, 10)
      && /^\d{4}-\d{2}-\d{2}$/.test(String(row.day)) && boundedText(row.environment, 64)
      && (row.operationKey === null || boundedText(row.operationKey)) && validHttpCounts(row.counts));
}

function HttpResponseRecords({ value, from, to }: { value: HttpRecords; from: string; to: string }) {
  const [environment, setEnvironment] = useState(''), [page, setPage] = useState(0);
  const availableEnvironments = [...new Set(value.rows.map((row) => row.environment))].sort();
  const rows = value.rows.filter((row) => !environment || row.environment === environment);
  const pageSize = 20, pages = Math.max(1, Math.ceil(rows.length / pageSize));
  return <section className="operations-card" aria-label="가져온 HTTP 응답 로그">
    <div className="operations-section-heading"><div><h2>가져온 HTTP 응답 로그</h2><p>{from} ~ {to} · 응답 완료 시각의 한국 날짜 기준</p></div><label>응답 로그 환경<select aria-label="응답 로그 환경" value={environment} onChange={(event) => { setEnvironment(event.target.value); setPage(0); }}><option value="">모든 환경 · 행별 구분</option>{availableEnvironments.map((item) => <option value={item} key={item}>{environmentLabel(item)}</option>)}</select></label></div>
    <div className="operations-warning"><strong>운영자가 내보낸 자료이며, 원본 진위는 확인되지 않았습니다.</strong><p>실시간 수집은 연결되지 않았습니다. 가져온 자료에 남아 있는 응답 완료 로그만 표시하므로, 중단되었거나 응답을 완료하지 못한 요청과 빠진 기록은 포함되지 않을 수 있습니다.</p><p>HTTP 응답 정상(2xx)은 업무 저장이나 후속 처리가 완료됐다는 뜻이 아닙니다. 이 로그의 건수로 전체 서비스 오류율이나 감소율을 계산하지 않습니다.</p></div>
    <dl className="operations-meta"><div><dt>확인 범위</dt><dd>{value.status === 'partial' || value.truncated || value.invalidRecords ? '가져온 로그 중 일부만 확인' : '가져온 자료에 포함된 응답 로그만 확인'}</dd></div><div><dt>마지막 가져오기 시각</dt><dd>{date(value.lastImportedAt)}</dd></div><div><dt>전체 서비스 오류율·감소율</dt><dd>계산 불가</dd></div></dl>
    {boundedText(value.note, 1000) && <p className="subtle">{value.note}</p>}
    {!rows.length ? <p className="operations-empty">이 기간과 환경에 가져온 HTTP 응답 로그가 없습니다. 전체 요청이 0건이었다는 뜻은 아닙니다.</p> : <><div className="operations-table" role="region" aria-label="HTTP 응답 로그 표" tabIndex={0}><table><caption>가져온 응답 완료 로그만 집계 · 업무 시도 수와 별도</caption><thead><tr><th scope="col">날짜</th><th scope="col">원본 환경</th><th scope="col">업무</th>{httpColumns.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead><tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => <tr key={`${page}-${index}`}><td>{row.day}</td><td>{environmentLabel(row.environment)}</td><td>{row.operationKey ? operations[row.operationKey] || '업무 확인 필요' : '업무 분류 없음'}</td>{httpColumns.map(([key]) => <td key={key}>{count(row.counts[key])}</td>)}</tr>)}</tbody></table></div>{pages > 1 && <nav className="operations-pagination" aria-label="HTTP 응답 로그 페이지"><button className="quiet compact" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>이전</button><span>{page + 1} / {pages}페이지</span><button className="quiet compact" disabled={page + 1 >= pages} onClick={() => setPage((value) => value + 1)}>다음</button></nav>}</>}
    {value.invalidRecords > 0 && <p className="operations-warning">필수 정보를 확인하지 못한 HTTP 로그 {count(value.invalidRecords)}건은 집계에서 제외했습니다.</p>}
    {value.truncated && <p className="operations-warning">조회 한도로 일부 HTTP 로그만 표시합니다. 표시된 건수는 전체 서비스 요청 수가 아닙니다.</p>}
  </section>;
}

function parseSummary(value: unknown, days: number): Summary {
  if (!record(value) || value.measurementScope !== 'logical_operation' || value.historicalOnly !== true
    || !boundedText(value.from, 10) || !boundedText(value.to, 10)
    || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.from)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(value.to))
    || (Date.parse(String(value.to)) - Date.parse(String(value.from))) / 86400000 + 1 !== days
    || !Array.isArray(value.sourceEnvironments) || value.sourceEnvironments.length > 30 || value.sourceEnvironments.some((item) => !boundedText(item, 64))
    || !record(value.counts) || !Array.isArray(value.rows) || value.rows.length > 5000
    || value.rows.some((row) => !record(row) || !boundedText(row.day, 10) || !boundedText(row.environment, 64) || !boundedText(row.operationKey) || !boundedText(row.mode, 64) || !record(row.counts))
    || !record(value.collection) || !['partial', 'unverified', 'degraded', 'snapshot_ready'].includes(String(value.collection.status)) || value.collection.completeness !== 'not_guaranteed'
    || !record(value.source) || !record(value.clientErrors) || !validHttpRecords(value.httpRequests)) {
    throw new Error('invalid_operations_summary');
  }
  return value as Summary;
}

export function OperationsPanel() {
  const [days, setDays] = useState(7), [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<Summary | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('');
  const [environment, setEnvironment] = useState(''), [page, setPage] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setSummary(null); setError(''); setPage(0);
    void workbenchRequest(`/product-operations/summary?days=${days}`).then((value: unknown) => {
      const next = parseSummary(value, days);
      if (active) { setSummary(next); setEnvironment(''); }
    }).catch((reason: unknown) => {
      if (!active) return;
      const status = record(reason) ? reason.status : undefined;
      setSummary(null);
      setError(status === 401 || status === 403
        ? '현재 계정의 운영 기록 조회 권한을 확인할 수 없습니다. 이전 수치는 표시하지 않습니다. 로그인과 권한을 확인한 뒤 다시 조회해 주세요.'
        : '운영 기록을 확인하지 못했습니다. 이전 수치는 표시하지 않습니다. 잠시 후 다시 조회해 주세요.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, attempt]);
  const rows = summary?.rows.filter((row) => !environment || row.environment === environment) || [];
  const knownEnvironments = [...new Set([...(summary?.sourceEnvironments || []), ...(summary?.rows.map((row) => row.environment) || [])])].sort();
  const historicalRate = summary?.collection.status === 'snapshot_ready' && summary.truncated === false && summary.invalidRecords === 0
    && knownEnvironments.length === 1 && knownEnvironments[0] !== 'unknown' && typeof summary.counts.total === 'number' && summary.counts.total > 0
    && typeof summary.observedSystemFailureRate === 'number' && summary.observedSystemFailureRate >= 0 && summary.observedSystemFailureRate <= 1
    ? `${(summary.observedSystemFailureRate * 100).toFixed(1)}%` : '계산 불가';
  const pageSize = 20, pageCount = Math.max(1, Math.ceil(rows.length / pageSize));
  return <div className="studio operations-studio">
    <header className="studio-header"><div className="brand"><span className="eyebrow">MYSCube · AXR</span><h1>운영 기록</h1><p>확인된 기록과 아직 수집하지 못한 범위를 함께 보여드립니다.</p></div><nav className="header-actions" aria-label="제작 공간으로 이동"><a href="/">HTML 제작 공간</a><a href="/?mode=react">React 제작 공간</a></nav></header>
    <main className="operations-main">
      <section className="operations-notice" aria-label="운영 기록의 확인 범위"><strong>과거에 수집한 업무 기록입니다.</strong><p>현재 서비스의 전체 오류율이나 개선 전후 감소율을 뜻하지 않습니다. HTTP 요청의 실시간 수집은 연결되지 않았습니다.</p><p>화면 오류 기록 건수는 실패한 업무 수나 영향을 받은 구성원 수와 다릅니다. 가져온 HTTP 응답 로그가 있으면 업무 기록과 별도로 표시합니다.</p></section>
      <div className="operations-controls"><label>조회 기간<select aria-label="조회 기간" value={days} onChange={(event) => { setSummary(null); setLoading(true); setDays(Number(event.target.value)); }}><option value={7}>최근 7일</option><option value={14}>최근 14일</option><option value={28}>최근 28일</option></select></label><button className="quiet" disabled={loading} onClick={() => { setSummary(null); setLoading(true); setAttempt((value) => value + 1); }}>운영 기록 다시 조회</button></div>
      {loading && <p role="status">운영 기록과 현재 조회 권한을 확인하고 있습니다.</p>}
      {error && <p className="error" role="alert" data-testid="operations-error">{error}</p>}
      {summary && !loading && <>
        <section className="operations-card" aria-label="기록 수집 상태"><h2>{summary.collection.status === 'unverified' ? '수집 범위를 확인하지 못했습니다' : summary.collection.status === 'degraded' ? '일부 기록을 수집하지 못했습니다' : summary.collection.status === 'snapshot_ready' ? '선택한 범위의 과거 기록 복사를 확인했습니다' : '수집된 일부 기록만 표시합니다'}</h2><p>{boundedText(summary.collection.note, 1000) ? summary.collection.note : '전체 기록의 수집을 보장하지 않습니다.'}</p><dl className="operations-meta"><div><dt>조회 기간 · 한국시간</dt><dd>{summary.from} ~ {summary.to}</dd></div><div><dt>마지막 사본 수집 시각</dt><dd>{date(summary.source.capturedAt)}</dd></div><div><dt>과거 기록 한 차례 확인 완료 시각</dt><dd>{date(summary.source.sweepCompletedAt)}</dd></div><div><dt>이 화면의 조회 시각</dt><dd>{date(summary.queriedAt)}</dd></div></dl><p className="subtle">사본을 수집한 시각만으로 모든 기록이 최신이거나 빠짐없이 수집됐다고 판단하지 않습니다.</p></section>
        <div className="operations-metrics">
          <section className="operations-card" aria-label="과거 업무 기록"><h2>과거 업무 기록</h2><p>수집된 과거 업무 시도 · 원본 환경 전체 합계</p><strong className="operations-value" data-testid="operations-attempt-count">{summary.collection.status === 'unverified' ? '확인 불가' : count(summary.counts.total)}</strong><p className="subtle">부분 집계입니다. 현재 업무량 또는 전체 시도 수로 사용하지 마세요.</p><dl><dt>복사 확인된 과거 기록 내 시스템 오류 비율</dt><dd data-testid="operations-historical-rate">{historicalRate}</dd><dt>현재 서비스 오류율·감소율</dt><dd>계산 불가</dd></dl></section>
          <section className="operations-card" aria-label="화면 오류 건수"><h2>화면 오류 건수</h2><p>선택한 기간에 확인된 화면 오류 기록</p><strong className="operations-value" data-testid="operations-client-error-count">{summary.clientErrors.collection?.status === 'unverified' ? '확인 불가' : count(summary.clientErrors.count)}</strong><p className="subtle">성공 건수에 대한 정보가 없어 오류율은 계산할 수 없습니다. 같은 장애가 여러 기록으로 남을 수 있습니다.</p>{summary.clientErrors.truncated && <p className="operations-warning">조회 한도로 일부 오류 기록만 확인했습니다.</p>}</section>
          <section className="operations-card" aria-label="HTTP 요청 수집"><h2>{summary.httpRequests.status === 'not_collected' ? 'HTTP 요청 수집' : '가져온 HTTP 응답 로그'}</h2><strong className="operations-value" data-testid="operations-http-count">{summary.httpRequests.status === 'not_collected' ? '아직 수집하지 않음' : summary.httpRequests.counts.total > 0 ? `${count(summary.httpRequests.counts.total)}건 · 가져온 일부` : '기록 없음 · 전체 미확인'}</strong><p>{summary.httpRequests.status === 'not_collected' ? boundedText(summary.httpRequests.note, 1000) ? summary.httpRequests.note : '전체 요청 건수와 서버 오류율을 확인할 수 없습니다.' : '운영자가 가져온 자료에 포함된 응답 로그입니다. 원본 진위와 전체 범위는 확인되지 않았습니다.'}</p><p className="subtle">실시간 수집이 아닙니다. 수집되지 않은 전체 요청 수와 오류 수를 0건으로 표시하지 않습니다.</p></section>
        </div>
        {summary.httpRequests.status !== 'not_collected' && <HttpResponseRecords value={summary.httpRequests} from={summary.from} to={summary.to} />}
        <section className="operations-card" aria-label="환경별 과거 업무 기록"><div className="operations-section-heading"><div><h2>환경별 과거 업무 기록</h2><p>원본 기록의 날짜와 환경으로 구분합니다. 환경 사이의 오류율을 합치지 않습니다.</p></div><label>원본 환경<select aria-label="원본 환경" value={environment} onChange={(event) => { setEnvironment(event.target.value); setPage(0); }}><option value="">모든 환경 · 행별 구분</option>{knownEnvironments.map((item) => <option value={item} key={item}>{environmentLabel(item)}</option>)}</select></label></div>
          {!rows.length ? <p className="operations-empty">이 기간과 환경에서 확인한 과거 업무 기록이 없습니다. 장애가 없었다는 뜻은 아닙니다.</p> : <><div className="operations-table" role="region" aria-label="과거 업무 기록 표" tabIndex={0}><table><caption>수집된 일부 업무 기록 · 원본 날짜(한국시간) 기준</caption><thead><tr><th scope="col">날짜</th><th scope="col">원본 환경</th><th scope="col">업무</th><th scope="col">저장 방식</th>{countColumns.map(([key, label]) => <th key={key} scope="col">{label}</th>)}</tr></thead><tbody>{rows.slice(page * pageSize, (page + 1) * pageSize).map((row, index) => <tr key={`${page}-${index}`}><td>{row.day}</td><td>{environmentLabel(row.environment)}</td><td>{operations[row.operationKey] || '업무 확인 필요'}</td><td>{modes[row.mode] || '저장 방식 확인 필요'}</td>{countColumns.map(([key]) => <td key={key}>{count(row.counts[key])}</td>)}</tr>)}</tbody></table></div>{pageCount > 1 && <nav className="operations-pagination" aria-label="과거 업무 기록 페이지"><button className="quiet compact" disabled={page === 0} onClick={() => setPage((value) => value - 1)}>이전</button><span>{page + 1} / {pageCount}페이지</span><button className="quiet compact" disabled={page + 1 >= pageCount} onClick={() => setPage((value) => value + 1)}>다음</button></nav>}</>}
          {typeof summary.invalidRecords === 'number' && summary.invalidRecords > 0 && <p className="operations-warning">필수 정보를 확인하지 못한 과거 기록 {count(summary.invalidRecords)}건은 집계에서 제외했습니다.</p>}
          {summary.truncated && <p className="operations-warning">조회 한도로 전체 과거 기록을 확인하지 못했습니다. 총계와 행은 관측된 일부입니다.</p>}
        </section>
      </>}
    </main>
  </div>;
}
