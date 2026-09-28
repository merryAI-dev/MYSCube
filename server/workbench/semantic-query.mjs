import * as z from 'zod/v4';
import { analyticsError, assertIdentifier } from './analytics-contract.mjs';
import { bindSemanticDefinition, SEMANTIC_DEFINITIONS } from './semantic-catalog.mjs';
import { getMonthFinanceWeeks } from '../../src/app/platform/cashflow-week-core.mjs';

const id = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const scalar = z.union([z.string().max(1000), z.number().finite(), z.boolean()]);
export const SemanticQueryPlanSchema = z.object({
  datasetId: id, definitionVersion: z.string().min(1).max(80),
  select: z.array(id).min(1).max(32).optional(), measures: z.array(id).min(1).max(16).optional(),
  filters: z.array(z.object({ field: id, op: z.enum(['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_null', 'is_not_null']), value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional() }).strict()).max(30).optional(),
  groupBy: z.array(id).max(12).optional(),
  orderBy: z.array(z.object({ field: id, direction: z.enum(['asc', 'desc']) }).strict()).max(8).optional(),
  time: z.object({ yearMonth: z.string().regex(/^20\d{2}-(0[1-9]|1[0-2])$/).optional(), weekNo: z.number().int().min(1).max(5).optional(), weekScope: z.literal('all').optional() }).strict().optional(),
  limit: z.number().int().min(1).max(500).optional(),
}).strict();

const problem = (code, message, extras = {}) => Object.assign(analyticsError(422, code, message), extras);
export const SEMANTIC_SELECTION_POLICY = Object.freeze({ exactlyOneOf: Object.freeze(['select', 'measures']), groupByRequires: 'measures' });
export const SEMANTIC_REQUIRED_FILTER_POLICY = Object.freeze({ operator: 'eq', count: 1, arrayValueAllowed: false });
export function semanticFilterOperators(field) {
  return [...(field.allowedOperators || (['string', 'boolean'].includes(field.type)
    ? ['eq', 'ne', 'in', 'not_in', 'is_null', 'is_not_null']
    : ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'in', 'not_in', 'is_null', 'is_not_null']))];
}
function assertSelection(input) {
  if (SEMANTIC_SELECTION_POLICY.exactlyOneOf.filter((key) => input[key]?.length).length !== 1
    || (input.groupBy.length && !input[SEMANTIC_SELECTION_POLICY.groupByRequires]?.length)) {
    throw problem('semantic_selection_invalid', '개별 행의 항목을 선택하거나, 확정된 지표와 묶음 기준을 선택해 주세요.');
  }
}
const quoted = (value) => `"${assertIdentifier(value)}"`;
const textLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
function literal(value, field) {
  let valid = true;
  if (field.type === 'string') valid = typeof value === 'string' && !/[\u0000-\u001f]/.test(value);
  else if (field.type === 'integer') valid = Number.isSafeInteger(value);
  else if (field.type === 'number') valid = typeof value === 'number' && Number.isFinite(value);
  else if (field.type === 'boolean') valid = typeof value === 'boolean';
  else if (field.type === 'decimal') valid = typeof value === 'string' && /^-?(0|[1-9]\d*)(?:\.\d+)?$/.test(value) && value.replace(/[-.]/g, '').length <= 38 && (value.split('.')[1]?.length || 0) <= (field.scale ?? 0);
  else if (field.type === 'date') valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  else if (field.type === 'timestamp') valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
  else valid = false;
  if (field.enumValues && !field.enumValues.includes(value)) valid = false;
  if (field.min !== undefined && value < field.min) valid = false;
  if (field.max !== undefined && value > field.max) valid = false;
  if (field.format === 'year_month' && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value)) valid = false;
  if (!valid) throw problem('semantic_filter_value_invalid', `${field.label}의 조건 값 형식을 확인해 주세요. 정의되지 않은 상태나 누락 값은 추정하여 조회하지 않습니다.`);
  if (field.type === 'date') return `DATE ${textLiteral(value)}`;
  if (field.type === 'timestamp') return `CAST(${textLiteral(value)} AS TIMESTAMPTZ)`;
  if (field.type === 'decimal') return `CAST(${textLiteral(value)} AS DECIMAL(38,${field.scale ?? 0}))`;
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  return typeof value === 'string' ? textLiteral(value) : String(value);
}

export function compileSemanticQuery({ plan, catalogItems, definitionRegistry = SEMANTIC_DEFINITIONS }) {
  const parsed = SemanticQueryPlanSchema.safeParse(plan);
  if (!parsed.success) throw problem('semantic_plan_invalid', '자료·항목·조건·기간을 정해진 조회 형식으로 확인해 주세요. SQL이나 임의 계산식은 사용할 수 없습니다.');
  const input = parsed.data;
  const item = catalogItems.find((value) => value.datasetId === input.datasetId);
  if (!item) throw problem('semantic_dataset_unavailable', '현재 권한 범위에서 이 분석용 자료를 찾을 수 없습니다.');
  if (!/^[a-f0-9]{64}$/.test(item.version)) throw problem('semantic_dataset_version_invalid', '분석용 자료의 고정 버전을 확인할 수 없습니다.');
  const { definition, definitionHash } = bindSemanticDefinition(item, { definitionRegistry });
  if (input.definitionVersion !== definition.version) throw problem('semantic_definition_version_mismatch', '요청한 업무 정의가 현재 자료에 연결된 정의 버전과 다릅니다. 자료와 정의를 다시 확인해 주세요.');
  const getField = (fieldId) => {
    if (!Object.hasOwn(definition.fields, fieldId)) throw problem('semantic_field_unknown', `등록되지 않은 항목(${fieldId})은 조회하거나 계산할 수 없습니다.`);
    return definition.fields[fieldId];
  };
  const expression = (fieldId) => {
    const field = getField(fieldId); const column = quoted(field.physicalColumn);
    if (!field.validWhen) return column;
    const condition = getField(field.validWhen.field);
    const clauses = [`${quoted(condition.physicalColumn)} IN (${field.validWhen.values.map((value) => literal(value, condition)).join(', ')})`];
    if (field.enumValues) clauses.push(`${column} IN (${field.enumValues.map((value) => literal(value, field)).join(', ')})`);
    return `CASE WHEN ${clauses.join(' AND ')} THEN ${column} ELSE NULL END`;
  };
  const timeFields = definition.timeFields || {};
  const missingFields = [];
  if (timeFields.requireYearMonth && !input.time?.yearMonth) missingFields.push('time.yearMonth');
  if (timeFields.requireWeekScope && input.time?.weekNo === undefined && input.time?.weekScope !== 'all') missingFields.push('time.weekNo');
  if (missingFields.length) throw problem('semantic_clarification_required', '조회할 정산 월과 주차를 알려주세요. 월 전체를 보려면 전체 주차를 명시해 주세요.', {
    missingFields, details: { missingFields: missingFields.map((field) => field === 'time.yearMonth'
      ? { field, reason: '조회할 정산 월이 정해지지 않았습니다.', question: '어느 연도와 월의 주정산을 확인할까요?', options: [] }
      : { field, reason: '전체 주차와 특정 주차는 조회 대상과 건수가 달라집니다.', question: '해당 월의 전체 주차를 볼까요, 특정 주차를 볼까요?', options: [{ id: 'all', label: '월 전체 주차' }, { id: 'specific', label: '특정 주차 지정' }] }) },
  });
  if (input.time?.weekNo !== undefined && input.time?.weekScope) throw problem('semantic_time_conflict', '특정 주차와 전체 주차를 동시에 선택할 수 없습니다.');
  if ((input.time?.yearMonth && !timeFields.yearMonth) || ((input.time?.weekNo !== undefined || input.time?.weekScope) && !timeFields.weekNo)) throw problem('semantic_time_not_defined', '이 자료에는 요청한 기간 항목의 의미가 정의되어 있지 않습니다.');
  if (timeFields.requireCopiedWeeks) {
    const requestedWeeks = input.time.weekScope === 'all' ? [1, 2, 3, 4, 5] : [input.time.weekNo];
    if (item.timeCoverage?.yearMonth !== input.time.yearMonth || requestedWeeks.some((week) => !item.timeCoverage?.weekNos?.includes(week))) throw problem('semantic_period_copy_missing', '요청한 정산 월·주차의 사본이 모두 준비되지 않았습니다. 준비된 일부 주차를 월 전체 금액으로 계산할 수 없습니다.');
  }
  for (const requirement of definition.requiredFilters || []) {
    const matches = (input.filters || []).filter((filter) => filter.field === requirement.field);
    if (matches.length === 0) throw problem('semantic_clarification_required', requirement.question, { details: { missingFields: [requirement] } });
    if (matches.length !== SEMANTIC_REQUIRED_FILTER_POLICY.count || matches[0].op !== SEMANTIC_REQUIRED_FILTER_POLICY.operator || matches[0].value === undefined || (!SEMANTIC_REQUIRED_FILTER_POLICY.arrayValueAllowed && Array.isArray(matches[0].value))) throw problem('semantic_required_filter_invalid', `${getField(requirement.field).label} 기준을 하나만 선택해 주세요. 서로 다른 입금 기준은 한 합계로 섞을 수 없습니다.`);
  }
  const groups = input.groupBy || []; let measures = input.measures || []; let selected = input.select || [];
  for (const values of [groups, measures, selected, (input.orderBy || []).map((order) => order.field)]) if (new Set(values).size !== values.length) throw problem('semantic_plan_duplicate', '같은 조회 항목이나 정렬 조건을 중복해서 사용할 수 없습니다.');
  assertSelection({ measures, select: selected, groupBy: groups });
  measures = [...new Set([...measures, ...measures.flatMap((key) => definition.metrics[key]?.companions || [])])];
  selected = [...new Set([...selected, ...selected.flatMap((key) => definition.fields[key]?.companions || [])])];
  for (const fieldId of groups) if (!getField(fieldId).groupable) throw problem('semantic_group_not_allowed', '이 항목은 묶음별 집계 기준으로 사용할 수 없습니다.');
  const metricExpression = (metricId) => {
    if (!Object.hasOwn(definition.metrics, metricId) || !definition.metrics[metricId].approved) throw problem('semantic_metric_unknown', `계산 기준이 등록되지 않은 지표(${metricId})입니다. 의미와 계산 기준을 먼저 확인해 주세요.`, { missingFields: ['measures'], clarification: { reason: 'metric_undefined', metric: metricId } });
    const metric = definition.metrics[metricId];
    if (metric.kind === 'count_rows') return 'COUNT(*)';
    const value = expression(metric.field);
    if (metric.kind === 'count_distinct') return `COUNT(DISTINCT ${value})`;
    if (metric.kind === 'count_missing') return `(COUNT(*) - COUNT(${value}))`;
    if (metric.kind === 'sum') return `SUM(${value})`;
    if (metric.kind === 'sum_complete') return `CASE WHEN COUNT(*) = COUNT(${value}) THEN SUM(${value}) ELSE NULL END`;
    throw problem('semantic_metric_unknown', '계산 기준이 등록되지 않은 지표입니다.');
  };
  const fields = measures.length ? [...groups.map((key) => `${expression(key)} AS ${quoted(key)}`), ...measures.map((key) => `${metricExpression(key)} AS ${quoted(key)}`)] : selected.map((key) => `${expression(key)} AS ${quoted(key)}`);
  const clauses = []; const appliedFilters = [];
  if (input.time?.yearMonth) clauses.push(`${expression(timeFields.yearMonth)} = ${literal(input.time.yearMonth, getField(timeFields.yearMonth))}`);
  if (input.time?.weekNo !== undefined) clauses.push(`${expression(timeFields.weekNo)} = ${literal(input.time.weekNo, getField(timeFields.weekNo))}`);
  const symbol = { eq: '=', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };
  for (const filter of input.filters || []) {
    const field = getField(filter.field);
    if (!field.filterable) throw problem('semantic_filter_not_allowed', '이 항목은 조건으로 사용할 수 없습니다. 확인된 상태 항목을 사용해 주세요.');
    if ([timeFields.yearMonth, timeFields.weekNo].includes(filter.field)) throw problem('semantic_time_filter_conflict', '정산 월과 주차는 기간 선택으로 지정해 주세요. 서로 다른 기간 조건을 중복 적용할 수 없습니다.');
    const allowed = semanticFilterOperators(field);
    if (!allowed.includes(filter.op)) throw problem('semantic_filter_operator_invalid', `${field.label}에 사용할 수 없는 비교 방식입니다.`);
    const column = expression(filter.field);
    if (['is_null', 'is_not_null'].includes(filter.op)) {
      if (filter.value !== undefined) throw problem('semantic_filter_value_invalid', '누락 여부를 확인하는 조건에는 비교 값을 넣지 않습니다.');
      clauses.push(`${column} IS ${filter.op === 'is_not_null' ? 'NOT ' : ''}NULL`);
    } else if (['in', 'not_in'].includes(filter.op)) {
      if (!Array.isArray(filter.value)) throw problem('semantic_filter_value_invalid', '여러 값과 비교하는 조건에는 값 목록이 필요합니다.');
      clauses.push(`${column} ${filter.op === 'not_in' ? 'NOT ' : ''}IN (${filter.value.map((value) => literal(value, field)).join(', ')})`);
    } else {
      if (filter.value === undefined || Array.isArray(filter.value)) throw problem('semantic_filter_value_invalid', '비교할 값 하나를 올바른 형식으로 입력해 주세요.');
      clauses.push(`${column} ${symbol[filter.op]} ${literal(filter.value, field)}`);
    }
    appliedFilters.push(filter);
  }
  const outputFields = new Set(measures.length ? [...groups, ...measures] : selected);
  const order = (input.orderBy || []).map((value) => {
    if (!outputFields.has(value.field)) throw problem('semantic_order_invalid', '결과에 포함된 항목만 정렬할 수 있습니다.');
    return `${quoted(value.field)} ${value.direction.toUpperCase()} NULLS LAST`;
  });
  const limit = input.limit ?? 100;
  const sql = `SELECT ${fields.join(', ')} FROM ${quoted(input.datasetId)}${clauses.length ? ` WHERE ${clauses.map((value) => `(${value})`).join(' AND ')}` : ''}${groups.length ? ` GROUP BY ${groups.map(expression).join(', ')}` : ''}${order.length ? ` ORDER BY ${order.join(', ')}` : ''} LIMIT ${limit}`;
  const weeks = timeFields.basis === 'finance_week' ? getMonthFinanceWeeks(input.time.yearMonth).filter((week) => input.time.weekScope === 'all' || week.weekNo === input.time.weekNo) : [];
  if (sql.length > 16000) throw problem('semantic_plan_too_large', '조회 조건이 너무 많습니다. 필요한 조건만 남겨 주세요.');
  return {
    sql, datasetVersions: { [input.datasetId]: item.version },
    appliedPlan: { ...input, ...(measures.length ? { measures } : {}), ...(selected.length ? { select: selected } : {}), filters: appliedFilters, groupBy: groups, limit },
    definitionVersions: { [input.datasetId]: { id: definition.id, version: definition.version, hash: definitionHash } },
    definitionLabel: definition.label,
    ...(weeks.length ? { period: { basis: 'finance_week', start: weeks[0].weekStart, end: weeks.at(-1).weekEnd } } : {}),
    columnLabels: Object.fromEntries([...outputFields].map((key) => [key, (definition.fields[key] || definition.metrics[key]).label])),
    sourceRefs: definition.sourceRefs, limitations: definition.limitations || [],
  };
}
