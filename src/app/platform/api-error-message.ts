import { PlatformApiError } from './api-client';
import { resolveApiErrorPresentation } from './api-error-messages';

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PlatformApiError) {
    if (error.code === 'internal_error' || /^(cashflow_|jvm_weekly_|java_weekly_|weekly_)/.test(error.code)) {
      return resolveApiErrorPresentation(error.code, error.status).guide;
    }
    const message = typeof error.body === 'object' && error.body && 'message' in (error.body as Record<string, unknown>)
      ? String((error.body as Record<string, unknown>).message || '')
      : '';
    return message || error.message || fallback;
  }

  return fallback;
}

export function resolveCashflowMonthReopenErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PlatformApiError)) return resolveApiErrorMessage(error, fallback);
  if (error.code.startsWith('cashflow_month_reopen_')) {
    return resolveApiErrorPresentation(error.code, error.status).guide;
  }
  return error.status >= 500
    ? '월 결산 재오픈 처리 상태를 확인하지 못했어요. 잠시 후 최신 상태를 다시 확인해 주세요.'
    : '월 결산 재오픈 요청을 처리할 수 없어요. 최신 결산 상태와 권한을 확인해 주세요.';
}

export function resolveCashflowWeeklyCompletionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PlatformApiError)) return resolveApiErrorMessage(error, fallback);
  if (error.code === 'cashflow_month_closed') {
    return resolveApiErrorPresentation(error.code, error.status).guide;
  }
  return error.status >= 500
    ? '주간 정산 처리 상태를 확인하지 못했어요. 잠시 후 최신 상태를 다시 확인해 주세요.'
    : '주간 정산을 완료할 수 없어요. 최신 월 결산과 주차 상태를 확인해 주세요.';
}
