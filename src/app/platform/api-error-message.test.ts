import { describe, expect, it } from 'vitest';

import { PlatformApiError } from './api-client';
import {
  describeApiError,
  formatApiErrorDescription,
  resolveApiErrorMessage,
  resolveCashflowMonthReopenErrorMessage,
  resolveCashflowWeeklyCompletionErrorMessage,
} from './api-error-message';
import { resolveApiErrorPresentation } from './api-error-messages';

describe('resolveApiErrorMessage', () => {
  it('prefers API body messages when available', () => {
    const error = new PlatformApiError('Bad Request', 400, 'req_1', {
      message: 'validation failed',
    });

    expect(resolveApiErrorMessage(error, 'fallback')).toBe('validation failed');
  });

  it('uses the caller guide instead of exposing an unclassified runtime error', () => {
    expect(resolveApiErrorMessage(
      new Error('Firestore JVM revision invariant failed at adapter line 3918.'),
      '안전한 안내',
    )).toBe('안전한 안내');
  });

  it('returns the provided fallback for unknown values', () => {
    expect(resolveApiErrorMessage(null, 'fallback')).toBe('fallback');
  });

  it('gives formula mismatches an actionable guide instead of the generic 409 message', () => {
    expect(resolveApiErrorPresentation('cashflow_formula_mismatch_confirmation_required', 409)).toEqual({
      guide: '시트의 합계·잔액과 MYSCube 계산 결과가 달라요. 차이를 확인한 뒤 그대로 반영하거나 시트 값을 다시 가져와 주세요.',
      resolution: 'contact',
    });
  });

  it('never exposes a technical upstream message during a month reopen', () => {
    const stable = new PlatformApiError('Conflict', 409, 'req_2', {
      code: 'cashflow_month_reopen_revision_changed',
      message: 'Cashflow month close revision changed. Reload and retry.',
    });
    const legacy = new PlatformApiError('Conflict', 409, 'req_3', {
      code: 'weekly_expense_conflict',
      message: 'Cashflow counter invariant failed at adapter line 3918.',
    });

    expect(resolveCashflowMonthReopenErrorMessage(stable, 'fallback'))
      .toBe('검토 중 월 결산 상태가 바뀌었어요. 최신 상태를 다시 불러온 뒤 요청해 주세요.');
    expect(resolveCashflowMonthReopenErrorMessage(legacy, 'fallback'))
      .toBe('월 결산 재오픈 요청을 처리할 수 없어요. 최신 결산 상태와 권한을 확인해 주세요.');
  });

  it('never exposes the legacy English closed-month message during weekly completion', () => {
    const error = new PlatformApiError('Conflict', 409, 'req_weekly_closed', {
      code: 'cashflow_month_closed',
      message: 'Cashflow month is closed and cannot be changed.',
    });

    const message = resolveCashflowWeeklyCompletionErrorMessage(error, 'fallback');

    expect(message).toBe('이미 누적 결산이 끝난 월이에요. 수정이 필요하면 관리자에게 월 재오픈을 요청해 주세요.');
    expect(message).not.toMatch(/Cashflow|closed|cannot be changed/i);
  });

  it('never exposes an unmapped adapter message during weekly completion', () => {
    const conflict = new PlatformApiError('Conflict', 409, 'req_weekly_conflict', {
      code: 'weekly_expense_conflict',
      message: 'Weekly completion invariant failed at adapter line 1652.',
    });
    const unavailable = new PlatformApiError('Unavailable', 503, 'req_weekly_unavailable', {
      code: 'jvm_weekly_api_internal_error',
      message: 'Java weekly API request failed with 503.',
    });

    const conflictMessage = resolveCashflowWeeklyCompletionErrorMessage(conflict, 'fallback');
    const unavailableMessage = resolveCashflowWeeklyCompletionErrorMessage(unavailable, 'fallback');

    expect(conflictMessage).toBe('주간 정산을 완료할 수 없어요. 최신 월 결산과 주차 상태를 확인해 주세요.');
    expect(unavailableMessage).toBe('주간 정산 처리 상태를 확인하지 못했어요. 잠시 후 최신 상태를 다시 확인해 주세요.');
    expect(`${conflictMessage} ${unavailableMessage}`)
      .not.toMatch(/Weekly|completion|invariant|adapter|Java|API|failed/i);
  });

  it('never exposes authority contract internals through the generic UI resolver', () => {
    const error = new PlatformApiError('Conflict', 409, 'req_authority_invalid', {
      code: 'cashflow_month_close_contract_invalid',
      message: 'Stored cumulative Cashflow authority revision is invalid.',
    });

    const message = resolveApiErrorMessage(error, 'fallback');

    expect(message).toBe('월 결산 기준 정보를 확인할 수 없어 안전하게 중단했어요. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.');
    expect(message).not.toMatch(/Cashflow|Stored|Firestore|revision/i);
  });

  it.each([
    ['cashflow_unknown_conflict', 409, '요청을 처리할 수 없어요. 입력 내용과 권한을 확인해 주세요.'],
    ['jvm_weekly_unknown_failure', 503, '요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'],
    ['java_weekly_api_error', 409, '요청을 처리할 수 없어요. 입력 내용과 권한을 확인해 주세요.'],
    ['internal_error', 500, '요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.'],
  ])('does not expose a technical body for %s', (code, status, expected) => {
    const error = new PlatformApiError('upstream failed', status, 'req_safe_boundary', {
      code,
      message: 'Firestore JVM revision invariant failed at adapter line 3918.',
    });

    const message = resolveApiErrorMessage(error, 'fallback');

    expect(message).toBe(expected);
    expect(message).not.toMatch(/Firestore|JVM|revision|invariant|adapter|line/i);
  });
});

describe('server message pass-through', () => {
  it('shows a Korean server message as-is and appends the mapped fix guide', () => {
    const error = new PlatformApiError('Conflict', 409, 'req_month', {
      error: 'cashflow_sheet_month_incomplete',
      message: '2026-05 시트 값이 월 전체 구조를 충족하지 않습니다. 월 1주차부터 다시 연동해 주세요.',
    });

    const message = resolveApiErrorMessage(error, 'fallback');

    expect(message.startsWith('2026-05 시트 값이 월 전체 구조를 충족하지 않습니다.')).toBe(true);
    expect(message).toContain(resolveApiErrorPresentation('cashflow_sheet_month_incomplete', 409).guide);
  });

  it('shows a Korean server message for a code without a guide instead of the generic text', () => {
    const error = new PlatformApiError('Bad Request', 400, 'req_range', {
      error: 'cashflow_week_range_not_in_sheet',
      message: '시작/종료 주차가 시트 헤더에 없습니다: 26-1-1',
    });

    expect(resolveApiErrorMessage(error, 'fallback')).toBe('시작/종료 주차가 시트 헤더에 없습니다: 26-1-1');
  });

  it.each([
    ['a 5xx Korean message', 502, 'JVM 월 결산 재오픈 상태를 다시 확인하지 못했습니다.'],
    ['a Korean message naming internals', 409, 'JVM 응답의 revision 이 다릅니다.'],
    ['an English engine message', 409, 'Cashflow month contains malformed or non-canonical week documents.'],
  ])('still hides %s', (_label, status, serverMessage) => {
    const error = new PlatformApiError('failed', status, 'req_hidden', {
      error: 'cashflow_sheet_stage_run_blocked',
      message: serverMessage,
    });

    expect(resolveApiErrorMessage(error, 'fallback')).not.toContain(serverMessage);
  });

  it('describes the phase, the server message, the guide and the reference code', () => {
    const error = new PlatformApiError('Conflict', 409, 'req_abc', {
      error: 'cashflow_sheet_month_incomplete',
      message: '2026-05 시트 값이 월 전체 구조를 충족하지 않습니다.',
    });

    const description = describeApiError(error, { fallback: 'fallback', phase: '② 반영 검토' });

    expect(description).toMatchObject({
      phase: '② 반영 검토',
      message: '2026-05 시트 값이 월 전체 구조를 충족하지 않습니다.',
      code: 'cashflow_sheet_month_incomplete',
      requestId: 'req_abc',
    });
    expect(formatApiErrorDescription(description)).toBe(
      `[② 반영 검토] 2026-05 시트 값이 월 전체 구조를 충족하지 않습니다. ${description.guide} (문의용: cashflow_sheet_month_incomplete · 요청 ID req_abc)`,
    );
  });

  it('passes a Korean server message through weekly completion and month reopen', () => {
    const weekly = new PlatformApiError('Conflict', 409, 'req_w', {
      error: 'cashflow_weekly_confirm_not_submitted',
      message: '완료 요청된 주간 정산만 확정할 수 있습니다.',
    });
    const reopen = new PlatformApiError('Conflict', 409, 'req_r', {
      error: 'cashflow_month_reopen_conflict',
      message: '변경되었거나 처리된 재오픈 요청입니다.',
    });

    expect(resolveCashflowWeeklyCompletionErrorMessage(weekly, 'fallback')).toContain('완료 요청된 주간 정산만 확정할 수 있습니다.');
    expect(resolveCashflowMonthReopenErrorMessage(reopen, 'fallback')).toContain('변경되었거나 처리된 재오픈 요청입니다.');
  });
});
