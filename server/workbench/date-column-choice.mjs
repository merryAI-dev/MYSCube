import { randomUUID } from 'node:crypto';
import * as z from 'zod/v4';
import { createHttpError } from '../bff/bff-utils.mjs';
import { bindTableQuery } from './table-query.mjs';

const digest = z.string().regex(/^[a-f0-9]{64}$/), id = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const date = z.string().regex(/^20\d{2}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
const range = z.object({ start: date, end: date }).strict().refine(value => value.start <= value.end);
export const DateColumnSelectionSchema = z.object({ clarificationId: z.string().uuid(), optionId: z.string().uuid() }).strict();
const choice = z.object({ datasetId: id, definitionHash: digest, datasetVersion: digest,
  period: range.nullable(), options: z.array(z.object({ id: z.string().uuid(), field: id, label: z.string().min(1).max(100) }).strict()).min(1).max(64) }).strict();
const issued = z.object({ sessionId: z.string().uuid(), turnId: z.string().uuid(), version: z.number().int().positive(), scopeFingerprint: digest }).strict();
const basisSchema = choice.omit({ options: true }).extend({ field: id, label: z.string().min(1).max(100), clarificationId: z.string().uuid(), optionId: z.string().uuid(),
  issued, selectedTurnId: z.string().uuid(), selectedAt: z.string().datetime(), selectedAgainstVersion: z.number().int().nonnegative() }).strict();
const invalid = (code = 'conversation_date_choice_stale') => createHttpError(409, '날짜 기준 선택이 현재 대화나 자료와 맞지 않습니다. 최신 대화에서 날짜 기준을 다시 확인해 주세요.', code);

function sameDefinition(item, definitionHash) {
  try { return bindTableQuery(item).definitionHash === definitionHash; } catch { return false; }
}

export function issueDateColumnChoice({ datasetId, catalogItems, message, pendingClarification, period, reason = '같은 기간이라도 날짜 항목에 따라 조회 결과가 달라집니다.' }) {
  const item = catalogItems.find(item => item.datasetId === datasetId);
  const bound = bindTableQuery(item), columns = bound.columns.filter(column => column.type === 'date');
  if (!columns.length || !digest.safeParse(item.version).success) throw invalid('conversation_date_columns_unavailable');
  const details = choice.parse({ datasetId, definitionHash: bound.definitionHash, datasetVersion: item.version,
    period: period ? { start: period.start, end: period.end } : null, options: columns.map(column => ({ id: randomUUID(), field: column.name, label: column.label || column.name })) });
  return { id: randomUUID(), kind: 'date_column', question: '어느 날짜 항목을 기준으로 조회할까요?', reason, field: 'date_column',
    options: details.options.map(({ id, label }) => ({ id, label })), originalMessage: pendingClarification?.originalMessage || message, dateColumn: details };
}

export function anchorDateColumnChoice(pending, { sessionId, turnId, version, scopeFingerprint }) {
  if (pending?.kind !== 'date_column') return pending;
  choice.parse(pending.dateColumn);
  const origin = pending.issued ? issued.parse(pending.issued) : null;
  if (origin && (origin.sessionId !== sessionId || origin.scopeFingerprint !== scopeFingerprint)) throw invalid();
  return { ...pending, issued: issued.parse({ sessionId, turnId: origin?.turnId || turnId, version, scopeFingerprint }) };
}

export function selectDateColumnChoice({ pending, selection, context, sessionId, version, turnId, at, catalogItems }) {
  const selected = DateColumnSelectionSchema.parse(selection);
  if (pending?.kind !== 'date_column' || pending.id !== selected.clarificationId) throw invalid();
  const origin = issued.safeParse(pending.issued), details = choice.safeParse(pending.dateColumn);
  if (!origin.success || !details.success || origin.data.sessionId !== sessionId || origin.data.version !== version
    || origin.data.scopeFingerprint !== context.analyticsScope?.fingerprint) throw invalid();
  const option = details.data.options.find(option => option.id === selected.optionId);
  if (!option) throw invalid('conversation_date_option_invalid');
  if (!context.analyticsScope.datasetIds.includes(details.data.datasetId)) throw invalid();
  const item = catalogItems?.find(item => item.datasetId === details.data.datasetId);
  if (!sameDefinition(item, details.data.definitionHash)) throw invalid();
  const { options: _options, ...basis } = details.data;
  return basisSchema.parse({ ...basis, field: option.field, label: option.label, ...selected, issued: origin.data,
    selectedTurnId: turnId, selectedAt: at, selectedAgainstVersion: version });
}

export function dateBasisForScope(value, context) {
  if (!value) return null;
  const parsed = basisSchema.safeParse(value);
  if (!parsed.success) throw invalid('conversation_date_basis_invalid');
  return parsed.data.issued.scopeFingerprint === context.analyticsScope?.fingerprint ? parsed.data : null;
}

export function dateBasisDisplay(value, context, catalogItems) {
  const basis = dateBasisForScope(value, context);
  if (!basis) return {};
  try {
    const item = catalogItems.find(item => item.datasetId === basis.datasetId);
    if (bindTableQuery(item).definitionHash !== basis.definitionHash) throw invalid();
    return { dateBasis: { datasetId: basis.datasetId, field: basis.field, label: basis.label } };
  } catch { return { dateBasisNotice: '자료 항목이 바뀌어 날짜 기준을 다시 선택해 주세요.' }; }
}

export function publicDateClarification(value) {
  if (!value || value.kind !== 'date_column') return value;
  const { dateColumn: _details, issued: _issued, ...publicValue } = value;
  return publicValue;
}

export function publicDateResult(value) {
  if (!value) return value;
  const { dateBasisProvenance: _provenance, ...result } = value;
  return result.clarification ? { ...result, clarification: publicDateClarification(result.clarification) } : result;
}

export function publicDateTurn(value) {
  const { selection: _selection, ...turn } = value;
  return turn.result ? { ...turn, result: publicDateResult(turn.result) } : turn;
}

export function assertDateBasisPlan({ basis, selected, plan, queryContext, previous, catalogItems }) {
  if (!basis) return;
  if (selected && plan.datasetId !== basis.datasetId) throw createHttpError(400, '선택한 날짜 기준의 자료를 다른 자료로 바꾸지 않았습니다. 원래 조회 조건을 확인해 주세요.', 'conversation_date_basis_mismatch');
  if (plan.datasetId !== basis.datasetId) return;
  const item = catalogItems.find(item => item.datasetId === basis.datasetId);
  if (!sameDefinition(item, basis.definitionHash)) throw invalid();
  const period = selected && basis.period ? basis.period : queryContext.period || previous.period || basis.period;
  if (!period || selected && basis.period && queryContext.period && (queryContext.period.start !== basis.period.start || queryContext.period.end !== basis.period.end)) {
    throw createHttpError(400, '선택한 날짜 기준에 적용할 기간을 확인해 주세요. 확인한 기간을 생략하거나 바꾸어 조회하지 않았습니다.', 'conversation_date_period_missing');
  }
  const filters = plan.filters || [], matched = filters.some(filter => filter.field === basis.field && filter.op === 'gte' && filter.value === period.start
    && filters.some(other => other.field === basis.field && other.op === 'lte' && other.value === period.end))
    || period.start === period.end && filters.some(filter => filter.field === basis.field && filter.op === 'eq' && filter.value === period.start);
  if (plan.kind !== 'table' || !matched) throw createHttpError(400, 'AI가 만든 조회 조건이 선택하신 날짜 기준과 달라 실행하지 않았습니다. 선택한 기준은 저장되어 있으니 다시 조회해 주세요.', 'conversation_date_basis_mismatch');
}
