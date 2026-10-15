import { describe, expect, it } from 'vitest';
import { createHttpError, resolveErrorResponse } from './bff-utils.mjs';

describe('resolveErrorResponse', () => {
  it('keeps the message of an error the server wrote on purpose, even at 5xx', () => {
    const error = createHttpError(503, '저장을 처리하는 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.', 'cashflow_jvm_authority_unavailable');

    expect(resolveErrorResponse(error)).toEqual({
      statusCode: 503,
      code: 'cashflow_jvm_authority_unavailable',
      message: '저장을 처리하는 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      exposed: true,
    });
  });

  it('hides the message of an unexpected exception so internals cannot leak', () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'snapshot')");
    error.statusCode = 500;

    const resolved = resolveErrorResponse(error);

    expect(resolved.message).toBe('Internal server error');
    expect(resolved.exposed).toBe(false);
    expect(resolved.message).not.toContain('snapshot');
  });

  it('treats an exception with no status as a hidden 500', () => {
    const resolved = resolveErrorResponse(new Error('ECONNREFUSED 10.1.2.3:5432'));

    expect(resolved).toEqual({
      statusCode: 500,
      code: 'internal_error',
      message: 'Internal server error',
      exposed: false,
    });
  });

  it('still shows 4xx messages, which carry the reason the request was refused', () => {
    const error = createHttpError(409, '시트 값을 원장에 반영 중입니다. 반영이 끝난 뒤 다시 확인해 주세요.', 'cashflow_sheet_apply_in_progress');

    expect(resolveErrorResponse(error).message).toBe('시트 값을 원장에 반영 중입니다. 반영이 끝난 뒤 다시 확인해 주세요.');
  });

  it('does not let a bare statusCode on an unexpected error expose its message', () => {
    // 라이브러리가 statusCode 만 붙여 던지는 경우가 있다. 문구를 우리가 정하지 않았으므로 가려야 한다.
    const error = new Error('connect ETIMEDOUT 169.254.169.254:80');
    error.statusCode = 502;

    const resolved = resolveErrorResponse(error);

    expect(resolved.message).toBe('Internal server error');
    expect(resolved.message).not.toContain('169.254.169.254');
  });

  it('falls back to a code when the error carries none', () => {
    expect(resolveErrorResponse(createHttpError(400, '잘못된 요청입니다.')).code).toBe('request_error');
    expect(resolveErrorResponse({}).code).toBe('internal_error');
  });
});

describe('createHttpError', () => {
  it('marks its errors as safe to show, since a developer wrote the wording', () => {
    expect(createHttpError(503, '담당자에게 문의해 주세요.', 'x').expose).toBe(true);
  });
});

describe('resolveErrorResponse engine reason', () => {
  it('carries the engine reason of a rejection, never of a server failure', () => {
    const rejected = createHttpError(409, '요청을 처리할 수 없습니다. 최신 상태와 입력 내용을 확인해 주세요.', 'weekly_expense_conflict');
    rejected.engineReason = 'Stored weekly cashflow completion scope is invalid.';
    expect(resolveErrorResponse(rejected)).toMatchObject({
      statusCode: 409,
      engineReason: 'Stored weekly cashflow completion scope is invalid.',
    });

    const failed = createHttpError(503, '잠시 후 다시 시도해 주세요.', 'jvm_weekly_api_internal_error');
    failed.engineReason = 'NullPointerException';
    expect(resolveErrorResponse(failed)).not.toHaveProperty('engineReason');
    expect(resolveErrorResponse(createHttpError(409, '충돌', 'x'))).not.toHaveProperty('engineReason');
  });
});
