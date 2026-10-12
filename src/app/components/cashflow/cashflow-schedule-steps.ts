// 정산 일정 진행 바의 단계 계산. 마감 시각·상태는 서버(BFF)가 준 것을 쓰고, 여기서는
// "지금 어느 단계이고 무엇을 언제까지 해야 하는가" 만 정한다. 새로 판정하지 않는다.
//
// 표시 원칙(2026-08-20 보람): 혼내는 표시가 아니라 다가오는 마감을 알려주는 표시.
// 늦게라도 끝낸 일은 완료로 남기고(보조 라벨로만 초과 표기), 지금 행동이 필요한 것만 빨간색.
// 조직장 마감 초과는 표시만 하고 미준수로 세지 않는다 - 누적은 실무자 마감 기준뿐.

import { isProjectContractEnded } from '../../platform/project-period-state.mjs';

export type ScheduleStepState = 'done' | 'done_late' | 'current' | 'overdue' | 'upcoming';

export interface ScheduleStep {
  key: 'practitioner' | 'approver';
  label: string;
  state: ScheduleStepState;
  /** 단계 아래 한 줄. 완료면 완료 시각, 진행 중이면 남은 기한. */
  detail: string;
}

const KST_OFFSET_MS = 9 * 3_600_000;
const DAY_MS = 86_400_000;
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function kstParts(iso: string | null | undefined): { y: number; m: number; d: number; hh: number; mm: number; dow: number } | null {
  const at = Date.parse(String(iso ?? ''));
  if (!Number.isFinite(at)) return null;
  const shifted = new Date(at + KST_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    dow: shifted.getUTCDay(),
  };
}

/** 마감 시각을 사람이 읽는 말로. 자정 마감은 "그 전날 자정" 으로 적는다 - 금 0시는 목요일 마감이다. */
export function formatDeadlineLabel(iso: string | null | undefined, nowIso: string): string {
  const parts = kstParts(iso);
  if (!parts) return '';
  const midnight = parts.hh === 0 && parts.mm === 0;
  const shownIso = midnight ? new Date(Date.parse(String(iso)) - DAY_MS).toISOString() : String(iso);
  const shown = kstParts(shownIso);
  if (!shown) return '';
  // 남은 일수도 사람이 보는 날(자정 마감이면 그 전날)로 센다 - 그래야 "오늘 자정까지" 가 맞는다.
  const days = daysUntil(shownIso, nowIso);
  const when = midnight ? `${shown.m}/${shown.d}(${WEEKDAYS[shown.dow]}) 자정` : `${shown.m}/${shown.d}(${WEEKDAYS[shown.dow]}) ${String(shown.hh).padStart(2, '0')}:${String(shown.mm).padStart(2, '0')}`;
  if (days === null) return `${when}까지`;
  if (days < 0) return `${when} 지남`;
  if (days === 0) return `오늘 ${when.split(' ').slice(1).join(' ')}까지`;
  if (days === 1) return `내일까지 · ${when}`;
  return `${when}까지 · D-${days}`;
}

/** KST 날짜 기준 남은 일수. 시각이 아니라 날짜로 세야 "오늘/내일" 이 사람 감각과 맞는다. */
function daysUntil(deadlineIso: string | null | undefined, nowIso: string): number | null {
  const deadline = kstParts(deadlineIso);
  const now = kstParts(nowIso);
  if (!deadline || !now) return null;
  const deadlineDay = Date.UTC(deadline.y, deadline.m - 1, deadline.d);
  const nowDay = Date.UTC(now.y, now.m - 1, now.d);
  return Math.round((deadlineDay - nowDay) / DAY_MS);
}

function completedLabel(iso: string | null | undefined, late: boolean): string {
  const parts = kstParts(iso);
  if (!parts) return late ? '기한 초과 완료' : '완료';
  const when = `${parts.m}/${parts.d}(${WEEKDAYS[parts.dow]}) ${String(parts.hh).padStart(2, '0')}:${String(parts.mm).padStart(2, '0')}`;
  return late ? `${when} · 기한 초과` : when;
}

function isPast(iso: string | null | undefined, nowIso: string | null | undefined): boolean {
  const at = Date.parse(String(iso ?? ''));
  const now = Date.parse(String(nowIso ?? ''));
  return Number.isFinite(at) && Number.isFinite(now) && now > at;
}

export interface ScheduleBarInput {
  practitionerLabel: string;
  approverLabel: string;
  practitionerDeadline: string | null | undefined;
  approverDeadline: string | null | undefined;
  /** 실무자 단계 완료 시각 (주정산: 완료 요청, 월결산: 결산 요청). */
  practitionerDoneAt: string | null | undefined;
  /** 조직장 단계 완료 시각 (주정산: 확정, 월결산: 승인). 서버가 시각을 안 주면 비운다. */
  approverDoneAt: string | null | undefined;
  /** 시각 없이 "확정됨" 만 아는 경우(주정산 확정은 시각이 응답에 없다). 시각을 지어내지 않는다. */
  approverDone?: boolean;
  /** 서버가 실무자 단계를 기한 초과 완료로 판정했는지. 화면이 다시 판정하지 않는다. */
  practitionerLate?: boolean;
  nowIso: string;
}

export function buildScheduleSteps(input: ScheduleBarInput): ScheduleStep[] {
  const {
    practitionerLabel, approverLabel, practitionerDeadline, approverDeadline,
    practitionerDoneAt, approverDoneAt, practitionerLate = false, nowIso,
  } = input;

  const practitionerDone = Boolean(practitionerDoneAt);
  const approverDone = Boolean(approverDoneAt) || input.approverDone === true;

  const practitioner: ScheduleStep = practitionerDone
    ? {
      key: 'practitioner',
      label: practitionerLabel,
      state: practitionerLate ? 'done_late' : 'done',
      detail: completedLabel(practitionerDoneAt, practitionerLate),
    }
    : {
      key: 'practitioner',
      label: practitionerLabel,
      // 마감이 지났는데 아직 안 했다 - 지금 행동이 필요한 유일한 상태.
      state: isPast(practitionerDeadline, nowIso) ? 'overdue' : 'current',
      detail: formatDeadlineLabel(practitionerDeadline, nowIso),
    };

  // 완료 시각을 모르면 초과 여부도 단정하지 않는다 - 판정 불능과 "제때" 는 다르다.
  const approverLate = Boolean(approverDoneAt) && isPast(approverDeadline, approverDoneAt);
  const approver: ScheduleStep = approverDone
    ? {
      key: 'approver',
      label: approverLabel,
      // 조직장 초과는 표시만 - 미준수 누적 대상이 아니다.
      state: approverLate ? 'done_late' : 'done',
      detail: approverDoneAt ? completedLabel(approverDoneAt, approverLate) : '완료',
    }
    : !practitionerDone
      ? { key: 'approver', label: approverLabel, state: 'upcoming', detail: formatDeadlineLabel(approverDeadline, nowIso) }
      : {
        key: 'approver',
        label: approverLabel,
        state: isPast(approverDeadline, nowIso) ? 'overdue' : 'current',
        detail: formatDeadlineLabel(approverDeadline, nowIso),
      };

  return [practitioner, approver];
}

/** 사업 기간 한 줄. 종료가 지났거나 다가오면 그 사실을 덧붙인다 - 종료 시 체크아웃이 붙는다. */
export function formatProjectPeriod(
  start: string | null | undefined,
  end: string | null | undefined,
  nowIso: string = new Date().toISOString(),
): string {
  const from = String(start ?? '').slice(0, 10);
  const to = String(end ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) && !/^\d{4}-\d{2}-\d{2}$/.test(to)) return '';
  const range = `${from || '시작일 미정'} ~ ${to || '종료일 미정'}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(to)) return range;
  const days = daysUntil(`${to}T00:00:00+09:00`, nowIso);
  if (days === null) return range;
  if (isProjectContractEnded(to, nowIso)) return `${range} · 종료됨`;
  if (days === 0) return `${range} · 오늘 종료`;
  if (days <= 30) return `${range} · 종료 D-${days}`;
  return range;
}
