import { PlatformApiError } from './api-client';
import { resolveApiErrorPresentation } from './api-error-messages';

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PlatformApiError) {
    if (/^(draft_|canonical_version_conflict$|project_document_conflict$)/.test(error.code)) {
      return resolveProjectErrorMessage(error, fallback);
    }
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

export function resolveProjectErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PlatformApiError)) {
    if (error instanceof Error && /^Invalid project (?:information|registration)/.test(error.message)) return '서버의 프로젝트 저장·비교 결과를 확인하지 못했어요. 입력을 유지하고 최신 상태를 다시 확인해 주세요.';
    return error instanceof Error ? error.message || fallback : fallback;
  }
  if (error.code === 'draft_not_active') return '이미 제출되었거나 종료된 임시저장이에요. 입력을 유지하고 최근 제출·임시저장 상태를 확인해 주세요.';
  if (['draft_version_conflict', 'draft_source_conflict', 'canonical_version_conflict', 'project_document_conflict', 'idempotency_conflict', 'idempotency_in_progress', 'edit_lease_expired', 'edit_lease_held', 'draft_attachment_invalid', 'draft_attachment_size_mismatch', 'draft_attachment_incoming_missing'].includes(error.code)) {
    return resolveApiErrorPresentation(error.code, error.status).guide;
  }
  if (error.status === 403) return resolveApiErrorPresentation('forbidden', error.status).guide;
  if (error.status === 401) return '로그인이 만료됐거나 인증을 확인하지 못했어요. 입력을 보관하고 다시 로그인한 뒤 최근 저장 내용을 확인해 주세요.';
  if (error.status === 404) return '요청한 임시저장에 접근할 수 없어요. 입력을 유지하고 현재 계정과 임시저장 목록을 확인해 주세요.';
  if (error.status === 410) return resolveApiErrorPresentation('edit_lease_expired', error.status).guide;
  if (error.status === 423) return resolveApiErrorPresentation('edit_lease_held', error.status).guide;
  if (error.status === 413) return '입력 내용이나 첨부파일 크기가 저장 제한을 초과했어요. 입력 분량과 화면의 파일 크기 제한을 확인해 주세요.';
  if (error.status === 422 || error.status === 400) return '필수 입력과 첨부파일 형식을 확인해 주세요. 서버 첨부 목록에서 누락된 파일도 확인해 주세요.';
  if (error.status === 409) return '저장 상태가 변경됐어요. 입력을 유지하고 최근 저장·제출 내용을 확인해 주세요.';
  return '저장 결과를 확인하지 못했어요. 입력을 유지하고 서버의 저장 상태를 먼저 확인해 주세요.';
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
