import { createHttpError } from '../bff/bff-utils.mjs';
import { validateExternalResponse } from './external-api.mjs';

const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const integer = { type: 'integer' }, boolean = { type: 'boolean' };
const nullable = schema => ({ ...schema, nullable: true });
const text = maxLength => ({ type: 'string', maxLength });
const choice = (...values) => ({ type: typeof values[0], enum: values, ...(typeof values[0] === 'string' ? { maxLength: 100 } : {}) });
const array = (items, maxItems) => ({ type: 'array', items, maxItems });
const amount = object({ value: nullable(integer), partialValue: nullable(integer), included: integer, excluded: integer, complete: boolean });
const money = object({ inflow: nullable(integer), outflow: nullable(integer), cumulativeBalance: nullable(integer) });
const mode = object({ inflow: amount, outflow: amount, cumulativeBalance: amount });
const totals = object({ projection: mode, actual: mode, difference: mode });
const statuses = ['AVAILABLE', 'NOT_RECORDED', 'FAILED', 'OUT_OF_SCOPE', 'NOT_ATTEMPTED'];
const schema = object({
  schemaVersion: choice(1), period: object({ yearMonth: text(7), weekNo: nullable(integer) }), amountCurrency: choice('KRW'),
  scope: choice('accessible_registered_projects'), totalsScope: choice('COMPLETE_REGISTERED_PROJECTS', 'PARTIAL_REGISTERED_PROJECTS'), catalogComplete: boolean,
  catalog: object({ asOf: nullable(text(40)), limit: choice(200), enumeratedCount: integer, eligibleCount: integer, complete: boolean, stable: boolean, knownTotal: nullable(integer), projectSetHash: text(64) }),
  readWindow: object({ startedAt: text(40), finishedAt: text(40), atomicSnapshot: choice(false) }),
  totals: nullable(totals), weeks: array(object({ weekNo: integer, start: nullable(text(10)), end: nullable(text(10)), weekCalendarUniform: nullable(boolean), totals: nullable(totals) }), 5),
  weekCalendarUniform: nullable(boolean), counts: object({ eligible: integer, available: integer, notRecorded: integer, failed: integer, outOfScope: integer, notAttempted: integer }),
  rows: array(object({ projectId: text(500), status: choice(...statuses), weeklyYear: nullable(integer), sourceRevision: nullable(text(200)), retrievedAt: nullable(text(40)),
    periodTotals: nullable(object({ projection: nullable(money), actual: nullable(money), difference: nullable(money) })), missingWeeks: nullable(object({ projection: array(integer, 5), actual: array(integer, 5) })) }), 200),
  calendarAuthority: choice('BFF_FIXED_FINANCE_CALENDAR'), fieldStateAvailability: choice('NOT_EXPOSED'), liveSheetVerified: choice(false), limitations: array(text(2000), 20),
});
export const COMPANY_SUMMARY_ENDPOINT = {
  id: 'myscube-company-cashflow-summary', version: 1, name: 'MYSCube 전사 월·주 현금흐름 집계',
  description: '관리자 권한으로 등록 사업의 월 또는 주차별 저장 현금흐름을 조회합니다. complete=true는 모든 대상의 저장 집계값을 받았다는 뜻이며 입력 완료나 빈 셀·명시적 0 검증을 뜻하지 않습니다. partialValue는 확인된 부분합입니다. 누락·시간 제한이 있으면 전사 총액은 확인 필요입니다. 현재 은행 잔고나 실시간 시트 잔고가 아닙니다.',
  parameters: { yearMonth: { type: 'string', required: true, label: '조회 월', example: '2026-09' }, weekNo: { type: 'integer', required: false, label: '주차(미선택 시 월 전체)', example: 1, enum: [1, 2, 3, 4, 5] } }, responseSchema: schema,
};
const invalid = () => { throw createHttpError(502, '전사 집계의 기간·포함 범위·완전성을 확인하지 못했습니다.', 'myscube_live_response_invalid'); };
const instant = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const date = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
export function validateCompanySummary(raw, input) {
  validateExternalResponse(schema, raw);
  const { catalog, counts, rows } = raw;
  if (raw.period.yearMonth !== input.yearMonth || raw.period.weekNo !== (input.weekNo ?? null)
    || catalog.eligibleCount !== rows.length || counts.eligible !== rows.length || catalog.enumeratedCount < rows.length || catalog.enumeratedCount > 200
    || raw.catalogComplete !== catalog.complete || catalog.asOf !== null && !instant(catalog.asOf) || catalog.complete && (!catalog.stable || !instant(catalog.asOf))
    || catalog.knownTotal !== (catalog.complete ? rows.length : null) || !/^[a-f0-9]{64}$/.test(catalog.projectSetHash)
    || !instant(raw.readWindow.startedAt) || !instant(raw.readWindow.finishedAt) || Date.parse(raw.readWindow.startedAt) > Date.parse(raw.readWindow.finishedAt)) invalid();
  const ids = new Set();
  for (const row of rows) {
    if (!row.projectId || /[\x00-\x1f\x7f/]/.test(row.projectId) || ids.has(row.projectId)) invalid();
    ids.add(row.projectId);
    if (row.retrievedAt !== null && !instant(row.retrievedAt)) invalid();
    if (['FAILED', 'OUT_OF_SCOPE', 'NOT_ATTEMPTED'].includes(row.status) && (row.periodTotals !== null || row.missingWeeks !== null || row.sourceRevision !== null || row.retrievedAt !== null)) invalid();
  }
  for (const [key, status] of Object.entries({ available: 'AVAILABLE', notRecorded: 'NOT_RECORDED', failed: 'FAILED', outOfScope: 'OUT_OF_SCOPE', notAttempted: 'NOT_ATTEMPTED' })) if (counts[key] !== rows.filter(row => row.status === status).length) invalid();
  const checkTotals = value => {
    if (value === null) return false;
    let all = true;
    for (const mode of Object.values(value)) for (const metric of Object.values(mode)) {
      const complete = catalog.complete && rows.length > 0 && metric.included === rows.length;
      if (metric.included < 0 || metric.excluded < 0 || metric.included + metric.excluded !== rows.length
        || metric.complete !== complete || metric.value !== (complete ? metric.partialValue : null) || (metric.included === 0) !== (metric.partialValue === null)) invalid();
      all &&= metric.complete;
    }
    return all;
  };
  const complete = checkTotals(raw.totals);
  if (raw.totals !== null) for (const mode of ['projection', 'actual', 'difference']) for (const metric of ['inflow', 'outflow', 'cumulativeBalance']) {
    const values = rows.map(row => row.periodTotals?.[mode]?.[metric]).filter(value => value !== null && value !== undefined);
    const sum = values.reduce((total, value) => total + BigInt(value), 0n);
    const total = raw.totals[mode][metric];
    if (total.included !== values.length || (values.length ? BigInt(total.partialValue) !== sum : total.partialValue !== null)) invalid();
  }

  if (raw.totalsScope !== (complete ? 'COMPLETE_REGISTERED_PROJECTS' : 'PARTIAL_REGISTERED_PROJECTS')) invalid();
  const weekIds = new Set();
  for (const week of raw.weeks) {
    if (week.weekNo < 1 || week.weekNo > 5 || weekIds.has(week.weekNo) || input.weekNo && week.weekNo !== input.weekNo) invalid();
    weekIds.add(week.weekNo);
    if (week.weekCalendarUniform === true && (!date(week.start) || !date(week.end) || week.start > week.end)) invalid();
    if (week.weekCalendarUniform === false && week.totals !== null) invalid();
    checkTotals(week.totals);
  }
  if (input.weekNo && (raw.weeks.length !== 1 || JSON.stringify(raw.totals) !== JSON.stringify(raw.weeks[0].totals))) invalid();
  const uniform = raw.weeks.some(week => week.weekCalendarUniform === false) ? false : raw.weeks.length && raw.weeks.every(week => week.weekCalendarUniform === true) ? true : null;
  if (raw.weekCalendarUniform !== uniform) invalid();
  return raw;
}
