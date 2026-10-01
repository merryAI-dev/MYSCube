import type {
  CashflowSettlementPeriod,
  CashflowSettlementStatusItem,
  CashflowSettlementStatusesResult,
} from '../lib/platform-bff-client';
import { addDays } from './business-days';
import { resolveFinanceWeekForDate } from './cashflow-weeks';

export interface CashflowExportRecentWeek {
  yearMonth: string;
  weekNo: number;
  period: CashflowSettlementPeriod;
  displayLabel: string;
}

export function resolveCashflowExportRecentWeeks(todayIso: string): CashflowExportRecentWeek[] {
  const current = resolveFinanceWeekForDate(todayIso);
  if (!current) return [];
  const previous = resolveFinanceWeekForDate(addDays(current.weekStart, -1));
  if (!previous) return [];
  return [previous, current].map((week) => ({
    yearMonth: week.yearMonth,
    weekNo: week.weekNo,
    period: `WEEK_${week.weekNo}` as CashflowSettlementPeriod,
    displayLabel: `${week.financeMonth}월 ${week.weekNo}주차`,
  }));
}

// 주간 현황 조회는 JVM이 사업마다 2023-01부터의 주차 기록을 펼쳐 계산한다.
// 70개를 한 번에 보내면 JVM(512MiB)이 메모리 부족으로 죽어 전체가 실패했다(2026-10-01 운영 로그).
export const CASHFLOW_EXPORT_STATUS_CHUNK_SIZE = 10;

export function chunkCashflowExportProjectIds(
  projectIds: string[],
  size = CASHFLOW_EXPORT_STATUS_CHUNK_SIZE,
): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < projectIds.length; index += size) {
    chunks.push(projectIds.slice(index, index + size));
  }
  return chunks;
}

// 묶음을 하나씩 차례로 보낸다. 한 묶음이 실패해도 다음 묶음은 계속 불러온다.
export async function loadCashflowExportChunksInSequence<T>(params: {
  chunks: string[][];
  loadChunk: (chunk: string[]) => Promise<T>;
  onChunk: (chunk: string[], result: PromiseSettledResult<T>) => void;
  isActive: () => boolean;
}): Promise<void> {
  for (const chunk of params.chunks) {
    if (!params.isActive()) return;
    let result: PromiseSettledResult<T>;
    try {
      result = { status: 'fulfilled', value: await params.loadChunk(chunk) };
    } catch (reason) {
      result = { status: 'rejected', reason };
    }
    if (!params.isActive()) return;
    params.onChunk(chunk, result);
  }
}

export function findCashflowExportSettlementStatus(
  results: CashflowSettlementStatusesResult[],
  projectId: string,
  week: CashflowExportRecentWeek,
): CashflowSettlementStatusItem | null {
  const projectResults = results.filter((result) => (
    result.projectId === projectId && result.yearMonth === week.yearMonth
  ));
  if (projectResults.length !== 1) return null;
  const statuses = projectResults[0].items.filter((item) => item.period === week.period);
  return statuses.length === 1 ? statuses[0] : null;
}
