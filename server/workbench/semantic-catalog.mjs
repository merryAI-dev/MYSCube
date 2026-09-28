import { analyticsError, assertIdentifier, sha256 } from './analytics-contract.mjs';
import { CASHFLOW_INFLOW_DEFINITION, validateCashflowInflowRows } from './cashflow-inflow-definition.mjs';

const statusValues = ['WAITING_FOR_UPDATE', 'PENDING_APPROVAL', 'COMPLETED'];
const overviewSource = { path: 'server/mcp/cashflow-status.mjs', symbol: 'assertOverview / validStatusItem', contractVersion: '5', meaning: '지정한 월의 프로젝트별 주차 상태와 조회 상태를 제공하는 정식 조회 계약' };
const transitionSource = { path: 'server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java', symbol: 'prepareSettlementReopenWrites', meaning: '월결산 재개 시 주차 상태를 업데이트 대기로 돌리는 처리' };
const issueSource = { path: 'server/bff/settlement-agent-query.mjs', symbol: 'selectSettlementIssue', meaning: '상태를 확인하지 못한 자료와 마감 전 자료를 미준수로 단정하지 않는 조회 기준' };
const field = (physicalColumn, type, label, meaning, options = {}) => ({ physicalColumn, type, label, meaning, filterable: true, groupable: true, ...options });
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

export const SEMANTIC_DEFINITIONS = freeze([{
  id: 'weekly_submission', version: '1', label: '주정산 제출·승인 상태',
  meaning: '권한 범위의 분석용 사본에 포함된 사업의 특정 월·주차 현재 상태입니다. 미제출 또는 미준수 명단을 뜻하지 않습니다.',
  grain: { label: '사업 × 정산 월 × 주차의 현재 관측값 한 건', keys: ['project_id', 'year_month', 'week_no'] },
  sourceRefs: [overviewSource, transitionSource, issueSource],
  governance: { status: 'code_verified', activation: '업무 담당자의 대상 사업·마감·제출 의무 정책 확인 후 운영 활성화' },
  fields: {
    project_id: field('project_id', 'string', '사업 식별자', '원본 조회가 반환한 사업의 식별자입니다.', { nullable: false }),
    year_month: field('year_month', 'string', '정산 월', '조회한 주정산의 월입니다. 이전 월의 월결산 대상 월과 다릅니다.', { nullable: false, format: 'year_month' }),
    week_no: field('week_no', 'integer', '주차', '정산 월 안의 1~5주차입니다. 연간 주차 번호가 아닙니다.', { nullable: false, min: 1, max: 5 }),
    status: field('status', 'string', '확인된 주정산 상태', '조회 상태가 정상일 때만 현재 제출·승인 상태로 읽습니다. 확인하지 못한 상태는 null이며 미제출로 바꾸지 않습니다.', { enumValues: statusValues, validWhen: { field: 'health', values: ['OK'] } }),
    recorded_status: field('status', 'string', '저장된 상태 원문', '조회 상태와 함께 확인하는 원문의 상태 값입니다. 정상 여부를 확인하지 않은 원문은 상태별 집계에 사용하지 않습니다.', { enumValues: statusValues, filterable: false, groupable: false }),
    revision: field('revision', 'integer', '상태 버전', '제출·승인·재개 등에 따라 증가하는 상태 버전입니다.', { min: 0, groupable: false }),
    submitted_at: field('submitted_at', 'timestamp', '제출 시각', '원본에서 확인한 제출 시각입니다. 시각이 없다는 이유만으로 한 번도 제출하지 않았다고 판단하지 않습니다.', { groupable: false }),
    approved_at: field('approved_at', 'timestamp', '승인 시각', '원본에서 확인한 승인 시각입니다.', { groupable: false }),
    health: field('health', 'string', '조회 상태', '정상·재확인 중·조회 불가를 구분합니다.', { nullable: false, enumValues: ['OK', 'RECONCILING', 'UNAVAILABLE'] }),
  },
  metrics: {
    project_count: { kind: 'count_distinct', field: 'project_id', label: '포함된 사업 수', meaning: '선택한 기간과 조건에 포함된 사업 식별자의 중복을 제거한 개수입니다. 여러 상태 그룹 사이에서는 합산할 수 없습니다.', approved: true },
    observation_count: { kind: 'count_rows', label: '사업·주차 관측 건수', meaning: '선택한 기간과 조건의 사업 × 월 × 주차 행 수입니다. 여러 주차에서는 한 사업이 여러 번 포함됩니다.', approved: true },
    missing_status_count: { kind: 'count_missing', field: 'status', label: '상태 확인이 필요한 관측 건수', meaning: '상태가 없거나 조회 상태가 정상이 아닌 행 수입니다. 미제출 건수가 아닙니다.', approved: true },
  },
  timeFields: { timezone: 'Asia/Seoul', yearMonth: 'year_month', weekNo: 'week_no', requireYearMonth: true, requireWeekScope: true },
  statusMeaning: {
    WAITING_FOR_UPDATE: '업데이트 대기: 제출 전 상태 또는 재개 후 다시 확인·제출해야 하는 상태일 수 있습니다.',
    PENDING_APPROVAL: '조직장 승인 대기: 제출 후 승인이 완료되지 않은 현재 상태입니다.',
    COMPLETED: '승인 완료: 해당 주차의 현재 승인 상태입니다.',
    null: '확인 안 됨: 누락 또는 조회 상태 문제로 제출·승인 여부를 판단할 수 없습니다.',
  },
  allowedRelations: [],
  limitations: [
    '분석용 사본에 포함된 사업만 조회합니다. 사본에 없는 사업의 상태는 알 수 없습니다.',
    '업데이트 대기에는 재개된 주차가 포함될 수 있습니다. 미제출·지연·미준수는 별도 업무 정의 없이 계산하지 않습니다.',
    '조회 상태가 정상이 아니면 저장된 상태 원문이 있어도 확인된 상태는 미확인으로 표시합니다.',
    '등록 사업이 정산 의무 대상이라는 뜻은 아닙니다. 종료 제외·기한·조직별 정책은 이 정의에 포함되지 않습니다.',
  ],
}, CASHFLOW_INFLOW_DEFINITION]);

const fieldTypes = new Set(['string', 'integer', 'number', 'decimal', 'boolean', 'date', 'timestamp']);
function definitionError(code, message, extras = {}) { return Object.assign(analyticsError(422, code, message), extras); }
export function resolveSemanticDefinition(id, version, definitionRegistry = SEMANTIC_DEFINITIONS) {
  const definition = definitionRegistry.find((item) => item.id === id && item.version === version);
  if (!definition) throw definitionError('semantic_definition_unknown', '이 자료의 업무 정의 또는 정의 버전이 등록되어 있지 않습니다. 정의를 먼저 확인해 주세요.');
  assertIdentifier(definition.id);
  if (!definition.sourceRefs?.length || !definition.grain?.keys?.length || !definition.fields || !definition.metrics) throw definitionError('semantic_definition_invalid', '등록된 업무 정의의 근거·행 기준·항목이 완전하지 않습니다.');
  for (const [id, value] of Object.entries(definition.fields)) {
    assertIdentifier(id); assertIdentifier(value.physicalColumn);
    if (!fieldTypes.has(value.type) || !value.meaning || !value.label) throw definitionError('semantic_definition_invalid', '등록된 항목의 형식과 의미를 확인해 주세요.');
    if (value.validWhen && (!definition.fields[value.validWhen.field] || !Array.isArray(value.validWhen.values) || !value.validWhen.values.length)) throw definitionError('semantic_definition_invalid', '등록된 항목의 유효성 조건을 확인해 주세요.');
    if (value.companions?.some((companion) => !definition.fields[companion] || definition.fields[companion].companions?.length)) throw definitionError('semantic_definition_invalid', '금액과 함께 확인할 원본 항목이 올바르지 않습니다.');
  }
  for (const id of definition.grain.keys) if (!Object.hasOwn(definition.fields, id)) throw definitionError('semantic_definition_invalid', '행을 구분하는 항목이 업무 정의에 없습니다.');
  for (const [id, metric] of Object.entries(definition.metrics)) {
    assertIdentifier(id);
    if (Object.hasOwn(definition.fields, id) || !metric.approved || !['count_rows', 'count_distinct', 'count_missing', 'sum', 'sum_complete'].includes(metric.kind) || (metric.kind !== 'count_rows' && !Object.hasOwn(definition.fields, metric.field))) throw definitionError('semantic_definition_invalid', '계산 방법이 확정되지 않은 지표는 사용할 수 없습니다.');
    if (['sum', 'sum_complete'].includes(metric.kind) && !['integer', 'number', 'decimal'].includes(definition.fields[metric.field].type)) throw definitionError('semantic_definition_invalid', '합계 지표는 정의된 숫자 항목만 사용할 수 있습니다.');
    if (metric.companions?.some((companion) => !definition.metrics[companion]?.approved || definition.metrics[companion].companions?.length)) throw definitionError('semantic_definition_invalid', '금액과 함께 확인할 집계 범위 지표가 올바르지 않습니다.');
  }
  return definition;
}

export function bindSemanticDefinition(item, { definitionRegistry = SEMANTIC_DEFINITIONS } = {}) {
  if (!item?.semanticDefinitionId || !item?.semanticDefinitionVersion) throw definitionError('semantic_definition_required', '자료는 보관되어 있지만 항목의 의미와 계산 기준이 아직 연결되지 않았습니다. 업무 정의를 연결한 후 조회해 주세요.');
  const definition = resolveSemanticDefinition(item.semanticDefinitionId, item.semanticDefinitionVersion, definitionRegistry);
  const schema = new Map((item.schema || []).map((column) => [column.name, column]));
  for (const value of Object.values(definition.fields)) {
    const column = schema.get(value.physicalColumn);
    if (!column || column.type !== value.type || (value.type === 'decimal' && column.scale !== value.scale)) throw definitionError('semantic_schema_mismatch', `${value.label} 항목의 실제 열 또는 값 형식이 업무 정의와 다릅니다.`, { missingFields: [value.physicalColumn] });
  }
  return { ...item, definition, definitionHash: sha256(JSON.stringify(definition)) };
}

export function resolveSemanticCatalog({ catalogItems, definitionRegistry = SEMANTIC_DEFINITIONS }) {
  const items = []; const unavailable = [];
  for (const item of catalogItems) {
    try { items.push(bindSemanticDefinition(item, { definitionRegistry })); }
    catch (error) { unavailable.push({ datasetId: item.datasetId, code: error.code || 'semantic_definition_invalid', message: error.message }); }
  }
  return { items, unavailable };
}

export function validateSemanticDataset(dataset, { definitionRegistry = SEMANTIC_DEFINITIONS } = {}) {
  if (!dataset.manifest.semanticDefinitionId && !dataset.manifest.semanticDefinitionVersion) return null;
  const { definition, definitionHash } = bindSemanticDefinition({ ...dataset.manifest, datasetId: dataset.datasetId, schema: dataset.schema }, { definitionRegistry });
  const seen = new Set();
  for (const [index, row] of dataset.rows.entries()) {
    for (const value of Object.values(definition.fields)) {
      const actual = row[value.physicalColumn];
      if (actual === null && value.nullable !== false) continue;
      if (actual == null || (value.enumValues && !value.enumValues.includes(actual)) || (value.min !== undefined && actual < value.min) || (value.max !== undefined && actual > value.max) || (value.format === 'year_month' && !/^20\d{2}-(0[1-9]|1[0-2])$/.test(actual))) throw definitionError('semantic_value_invalid', `${index + 1}번째 행의 ${value.label} 값이 업무 정의에 맞지 않습니다. 없는 값을 다른 상태로 채우지 말고 원본을 확인해 주세요.`);
    }
    const keys = definition.grain.keys.map((id) => row[definition.fields[id].physicalColumn]);
    if (keys.some((value) => value == null || value === '')) throw definitionError('semantic_grain_missing', '사업·기간처럼 행을 구분하는 항목이 누락되었습니다.');
    const key = JSON.stringify(keys);
    if (seen.has(key)) throw definitionError('semantic_grain_duplicate', '같은 사업·기간의 현재 상태가 중복되어 있습니다. 이력을 현재 상태와 함께 집계할 수 없습니다.');
    seen.add(key);
  }
  validateCashflowInflowRows(dataset);
  return { id: definition.id, version: definition.version, hash: definitionHash };
}
