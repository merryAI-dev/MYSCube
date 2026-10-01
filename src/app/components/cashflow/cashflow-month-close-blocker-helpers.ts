import { CASHFLOW_SHEET_LINE_LABELS, type CashflowSheetLineId } from '../../data/types';
import issueGuidance from '../../../../policies/cashflow-sheet-issue-guidance.json';

// 서버는 막는 사유마다 어느 칸인지(셀 주소·주차·구분)까지 보내는데 화면은 첫 줄 문장만 쓰고 버렸다.
// 담당자가 시트 전체를 뒤지지 않도록, 받은 값을 그대로 사람이 읽는 한 줄로 옮긴다.
// 여기서 새로 판정하지 않는다 - 서버가 준 것만 옮겨 적는다.

export interface CashflowMonthCloseIssue {
  code: string;
  message: string;
  details?: unknown;
}

const MODE_LABEL: Record<string, string> = { projection: 'Projection', actual: 'Actual' };

const CALCULATION_LABEL: Record<string, string> = {
  depositTotal: '입금 합계',
  withdrawalTotal: '출금 합계',
  balance: '잔액',
  openingBalance: '전기 이월 잔액',
};

const CONTROL_FIELD_LABEL: Record<string, string> = {
  depositControl: '입금 예정 합계',
  unpaidControl: '미수금 합계',
};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const cell = (value: unknown): string => (text(value) ? `${text(value)} 칸` : '');

function lineLabel(record: Record<string, unknown>): string {
  const lineId = text(record.lineId);
  if (lineId) return CASHFLOW_SHEET_LINE_LABELS[lineId as CashflowSheetLineId] || lineId;
  const derived = text(record.derivedKind);
  return CALCULATION_LABEL[derived] || derived;
}

// field 는 `${kind}:${lineId|derivedKind}` 또는 depositControl/unpaidControl 이다.
function fieldLabel(field: string): string {
  if (CONTROL_FIELD_LABEL[field]) return CONTROL_FIELD_LABEL[field];
  const name = field.includes(':') ? field.slice(field.indexOf(':') + 1) : field;
  return CASHFLOW_SHEET_LINE_LABELS[name as CashflowSheetLineId] || CALCULATION_LABEL[name] || name || '값';
}

function sheetValueLines(details: unknown): string[] {
  return asArray(details).map((entry) => {
    const record = asRecord(entry);
    const where = cell(record.sourceCell);
    const what = fieldLabel(text(record.field));
    const raw = text(record.rawValue);
    if (text(record.code) === 'control_total_missing') {
      return `${where ? `${where} · ` : ''}${what}이(가) 비어 있어요. 값을 채워 주세요.`;
    }
    return `${where ? `${where} · ` : ''}${what}이(가) 숫자가 아니에요${raw ? ` (지금 값: ${raw})` : ''}.`;
  });
}

function calculationLines(details: unknown, kind: 'invalid' | 'mismatch'): string[] {
  return asArray(details).map((entry) => {
    const record = asRecord(entry);
    const mode = MODE_LABEL[text(record.mode)] || text(record.mode);
    const weekNo = Number(record.weekNo);
    const where = `${mode}${Number.isSafeInteger(weekNo) ? ` ${weekNo}주차` : ''}`;
    const matches = asRecord(record.matches);
    const cells = asRecord(record.sourceCells);
    const failed = Object.keys(CALCULATION_LABEL)
      .filter((key) => (kind === 'invalid' ? matches[key] === null : matches[key] === false))
      .map((key) => `${CALCULATION_LABEL[key]}${text(cells[key]) ? `(${text(cells[key])})` : ''}`);
    const named = failed.length > 0 ? failed.join(', ') : '합계·잔액';
    return kind === 'invalid'
      ? `${where} · ${named} 값을 읽지 못했어요. 숫자인지 확인해 주세요.`
      : `${where} · ${named}이(가) 항목을 더한 값과 달라요.`;
  });
}

function controlTotalLines(details: unknown): string[] {
  const record = asRecord(details);
  const lines: string[] = [];
  const deposit = asRecord(record.deposit);
  if (deposit.matches === false) {
    lines.push(`입금 예정 합계${cell(deposit.sourceCell) ? `(${text(deposit.sourceCell)})` : ''}이(가) 주차 합계와 달라요.`);
  }
  for (const entry of asArray(record.rows)) {
    const row = asRecord(entry);
    lines.push(`${lineLabel(row)}${text(row.sourceCell) ? `(${text(row.sourceCell)})` : ''} · 시트 합계와 주차 합계가 달라요.`);
  }
  return lines;
}

function managementLines(details: unknown): string[] {
  const record = asRecord(details);
  const findings = asArray(record.findings).map(text).filter(Boolean);
  if (findings.length > 0) return findings;
  const detail = text(record.detail);
  return detail ? [detail] : [];
}

// 서버가 남긴 양식 진단을 칸 위치와 서버 문구 그대로 옮긴다.
function refreshFailureLines(details: unknown): string[] {
  const record = asRecord(details);
  const diagnostics = asArray(record.diagnostics).map(asRecord);
  const lines = diagnostics.map((diagnostic) => {
    const where = cell(diagnostic.sourceCell);
    const what = text(diagnostic.message) || text(diagnostic.code);
    return `${where ? `${where} · ` : ''}${what}`;
  }).filter(Boolean);
  const total = Number(record.diagnosticCount);
  return Number.isSafeInteger(total) && total > lines.length ? [...lines, `외 ${total - lines.length}건`] : lines;
}

/** 서버가 준 막는 사유·경고 하나를 "무엇이 · 어디서 · 왜" 한 줄들로 편다. */
export function describeCashflowMonthCloseIssue(issue: CashflowMonthCloseIssue | null | undefined): string[] {
  if (!issue) return [];
  const code = text(issue.code);
  if (code === 'SHEET_VALUE_INVALID') return sheetValueLines(issue.details);
  if (code === 'SHEET_CALCULATION_VALUE_INVALID') return calculationLines(issue.details, 'invalid');
  if (code === 'SHEET_CALCULATION_MISMATCH') return calculationLines(issue.details, 'mismatch');
  if (code === 'SHEET_CONTROL_TOTAL_MISMATCH') return controlTotalLines(issue.details);
  if (code.startsWith('MANAGEMENT_CHECK_')) return managementLines(issue.details);
  if (code === 'SHEET_LAST_REFRESH_FAILED') return refreshFailureLines(issue.details);
  return [];
}

const NOTICE_LIST_LIMIT = 10;

function limited(lines: string[], total: number): string[] {
  const shown = lines.slice(0, NOTICE_LIST_LIMIT);
  return total > shown.length ? [...shown, `외 ${total - shown.length}건`] : shown;
}

/** 주정산 완료 응답의 알림을 "어느 주차 · 어느 항목" 한 줄들로 편다. 서버가 준 값만 옮긴다. */
export function describeCashflowWeeklyCompletionNotice(notice: CashflowMonthCloseIssue | null | undefined): string[] {
  if (!notice) return [];
  const record = asRecord(notice);
  const code = text(notice.code);
  if (code === 'PROJECTION_WINDOW_INCOMPLETE') {
    const cells = asArray(record.missingCells).map(asRecord);
    return limited(cells.map((cell) => {
      const weekNo = Number(cell.weekNo);
      const week = `${text(cell.yearMonth)}${Number.isSafeInteger(weekNo) ? ` ${weekNo}주차` : ''}`;
      return `${week} · Projection ${lineLabel(cell)} 미입력`;
    }), cells.length);
  }
  if (code === 'OUT_OF_WINDOW_WEEK_DOCUMENT_INVALID') {
    const documents = asArray(record.documents).map(asRecord);
    const total = Number(record.count);
    return limited(documents.map((doc) => {
      const weekNo = Number(doc.weekNo);
      const week = `${text(doc.yearMonth)}${Number.isSafeInteger(weekNo) && weekNo > 0 ? ` ${weekNo}주차` : ''}`;
      return `${week || text(doc.documentId)} · ${text(doc.problem)}`;
    }), Number.isSafeInteger(total) ? total : documents.length);
  }
  return [];
}

const ISSUE_GUIDES: Record<string, string> = issueGuidance.guides;

/** 알림 코드에 붙일 '고치는 법'. policies/cashflow-sheet-issue-guidance.json 한 곳에서 관리한다. 없으면 빈 문자열. */
export function cashflowSheetIssueGuide(code: string | null | undefined): string {
  return (code && ISSUE_GUIDES[code]) || '';
}
