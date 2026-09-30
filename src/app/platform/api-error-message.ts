import { PlatformApiError } from './api-client';
import { hasApiErrorPresentation, resolveApiErrorPresentation } from './api-error-messages';

const GUARDED_CODE = /^(cashflow_|jvm_weekly_|java_weekly_|weekly_)/;
const HANGUL = /[가-힣]/;
const INTERNAL_TERMS = /Firestore|JVM|Java|invariant|adapter|stack|exception|line \d+/i;

// 서버가 사람에게 보여 주려고 쓴 문구만 그대로 전달한다. 5xx, 영어 기술 메시지, 내부 용어가 담긴 문구는
// 가리고 안내 표 문구를 쓴다 (정산 엔진 내부 메시지를 노출하지 않는 기존 원칙 유지).
export function userFacingServerMessage(error: unknown): string {
  if (!(error instanceof PlatformApiError) || error.status >= 500) return '';
  const message = (error.serverMessage || '').trim();
  if (!message || !HANGUL.test(message) || INTERNAL_TERMS.test(message)) return '';
  return message;
}

export interface ApiErrorDescription {
  /** 어느 단계에서 난 오류인지. 화면이 알려 준다. */
  phase: string;
  /** 서버가 보낸 문구(그대로) 또는 가린 경우 안내 문구. */
  message: string;
  /** 서버 문구를 그대로 보여 줄 때 덧붙이는 고치는 법. 안내 표에 없으면 빈 문자열. */
  guide: string;
  code: string;
  requestId: string;
}

/** 오류를 "단계 · 서버 문구 · 고치는 법 · 문의용 코드" 로 나눈다. */
export function describeApiError(error: unknown, options: { fallback: string; phase?: string }): ApiErrorDescription {
  const phase = options.phase || '';
  if (!(error instanceof PlatformApiError)) {
    return { phase, message: options.fallback, guide: '', code: '', requestId: '' };
  }
  const code = error.code || '';
  const requestId = error.requestId || '';
  const server = userFacingServerMessage(error);
  const mappedGuide = hasApiErrorPresentation(code) ? resolveApiErrorPresentation(code, error.status).guide : '';
  if (server) {
    return { phase, message: server, guide: mappedGuide && mappedGuide !== server ? mappedGuide : '', code, requestId };
  }
  return { phase, message: resolveApiErrorMessage(error, options.fallback), guide: '', code, requestId };
}

/** 한 줄로 보여 줄 때: "[② 반영 검토] 서버 문구 고치는 법 (문의용: 코드 · 요청 ID ...)" */
export function formatApiErrorDescription(description: ApiErrorDescription): string {
  const reference = [description.code, description.requestId ? `요청 ID ${description.requestId}` : '']
    .filter(Boolean)
    .join(' · ');
  return [
    description.phase ? `[${description.phase}]` : '',
    description.message,
    description.guide,
    reference ? `(문의용: ${reference})` : '',
  ].filter(Boolean).join(' ');
}

export function resolveApiErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof PlatformApiError) {
    if (error.code === 'internal_error' || GUARDED_CODE.test(error.code)) {
      const server = userFacingServerMessage(error);
      if (server) {
        const guide = hasApiErrorPresentation(error.code) ? resolveApiErrorPresentation(error.code, error.status).guide : '';
        return guide && guide !== server ? `${server} ${guide}` : server;
      }
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
  if (userFacingServerMessage(error)) return resolveApiErrorMessage(error, fallback);
  if (error.code.startsWith('cashflow_month_reopen_')) {
    return resolveApiErrorPresentation(error.code, error.status).guide;
  }
  return error.status >= 500
    ? '월 결산 재오픈 처리 상태를 확인하지 못했어요. 잠시 후 최신 상태를 다시 확인해 주세요.'
    : '월 결산 재오픈 요청을 처리할 수 없어요. 최신 결산 상태와 권한을 확인해 주세요.';
}

export function resolveCashflowWeeklyCompletionErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PlatformApiError)) return resolveApiErrorMessage(error, fallback);
  if (userFacingServerMessage(error)) return resolveApiErrorMessage(error, fallback);
  if (error.code === 'cashflow_month_closed') {
    return resolveApiErrorPresentation(error.code, error.status).guide;
  }
  return error.status >= 500
    ? '주간 정산 처리 상태를 확인하지 못했어요. 잠시 후 최신 상태를 다시 확인해 주세요.'
    : '주간 정산을 완료할 수 없어요. 최신 월 결산과 주차 상태를 확인해 주세요.';
}
