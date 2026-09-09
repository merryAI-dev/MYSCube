export interface ApiErrorPresentation {
  guide: string;
  resolution: 'retry' | 'wait' | 'contact';
}

const presentations = new Map<string, ApiErrorPresentation>([
  ['cashflow_sheet_apply_in_progress', {
    guide: '시트 값을 반영하는 중이에요. 잠시 뒤 자동으로 풀리면 다시 확인해 주세요.',
    resolution: 'wait',
  }],
  ['cashflow_sheet_operation_uncertain', {
    guide: '반영 결과를 확인하는 중이에요. 같은 요청으로 다시 시도해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_close_request_conflict', {
    guide: '이미 같은 월의 결산 요청이 있어요. 기존 요청의 진행 상태를 확인해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_close_approver_required', {
    guide: '월 결산을 맡을 조직장이 지정되지 않았어요. 프로젝트에서 조직장을 지정해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_close_approver_locked', {
    guide: '승인 대기 중인 월 결산이 있어 조직장을 바꿀 수 없어요. 현재 결재를 먼저 마친 뒤 다시 지정해 주세요.',
    resolution: 'wait',
  }],
  ['cashflow_pending_approval_contract_unsupported', {
    guide: '기존 결재 요청의 근거 형식을 확인할 수 없어요. 결재 요청을 먼저 정리한 뒤 시트 값을 다시 불러와 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_refresh_response_invalid', {
    guide: '시트 값은 저장됐지만 화면 확인이 끝나지 않았어요. 최신 시트 값을 다시 불러와 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_sheet_mirror_revision_conflict', {
    guide: '검토한 뒤 시트 고정본이 변경됐어요. 최신 시트 내용을 다시 검토해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_template_unsupported', {
    guide: '시트 양식이 표준과 달라요. cashflow(사용내역 연동) 탭의 고정된 행과 열을 확인한 뒤 다시 불러와 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_config_required', {
    guide: '먼저 프로젝트의 시트 링크와 탭 이름을 저장해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_mirror_required', {
    guide: '먼저 시트 값을 가져와 최신 고정본을 만든 뒤 진행해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_pending_approval_confirmation_required', {
    guide: '결재 중인 누적 결산과 달라지는 값이 있어요. 달라지는 전체 값을 확인한 뒤 반영해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_pending_approval_evidence_stale', {
    guide: '확인하는 동안 결재 중인 누적 결산이 변경됐어요. 시트 값을 다시 가져와 검토해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_formula_mismatch_confirmation_required', {
    guide: '시트의 합계·잔액과 MYSCube 계산 결과가 달라요. 차이를 확인한 뒤 그대로 반영하거나 시트 값을 다시 가져와 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_formula_evidence_incomplete', {
    guide: '시트의 합계·잔액 확인 정보를 찾을 수 없어요. 시트 값을 다시 가져와 최신 검토본을 만들어 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_sheet_stage_evidence_missing', {
    guide: '검토한 시트 고정본이 만료됐어요. 시트 값을 다시 가져온 뒤 반영해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_sheet_target_revision_conflict', {
    guide: '검토 중 MYSCube 값이 변경됐어요. 최신 시트 값을 다시 가져와 검토해 주세요.',
    resolution: 'retry',
  }],
  ['weekly_expense_conflict', {
    guide: '검토하는 동안 MYSCube의 캐시플로우 값이 변경됐어요. 최신 시트 값을 다시 가져온 뒤 반영해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_sheet_month_incomplete', {
    guide: '해당 월의 주차 값이 모두 채워지지 않았어요. 월 1주차부터 5주차까지 확인한 뒤 다시 가져와 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_sheet_annual_incomplete', {
    guide: '연간 합계의 Projection·Actual 항목이 모두 채워지지 않았어요. 시트의 연간 영역을 확인한 뒤 다시 가져와 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_jvm_calculation_verification_failed', {
    guide: '저장 서버의 계산 근거가 완전하지 않아 반영하지 않았어요. 시트 값을 다시 가져와 다시 시도해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_jvm_apply_verification_failed', {
    guide: '저장 결과가 시트 값과 일치하는지 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.',
    resolution: 'retry',
  }],
  ['jvm_weekly_api_identity_token_unavailable', {
    guide: '서버 인증 설정을 확인할 수 없어요. 시스템 담당자에게 문의해 주세요.',
    resolution: 'contact',
  }],
  ['jvm_weekly_api_token_unconfigured', {
    guide: '서버 연결 설정을 확인할 수 없어요. 시스템 담당자에게 문의해 주세요.',
    resolution: 'contact',
  }],
  ['jvm_weekly_api_internal_error', {
    guide: '서버에서 요청을 마치지 못했어요. 잠시 후 다시 시도해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_close_route_timeout', {
    guide: '월 결산 처리 시간이 초과됐어요. 잠시 후 진행 상태를 확인하고 다시 시도해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_close_reconciliation_pending', {
    guide: '승인 결과를 확인하고 있어요. 잠시 후 월 결산 상태를 확인해 주세요.',
    resolution: 'wait',
  }],
  ['cashflow_weekly_reopen_not_locked', {
    guide: '완료 요청되거나 확정된 주간 정산만 되돌릴 수 있어요. 화면을 다시 불러온 뒤 상태를 확인해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_weekly_reopen_reason_required', {
    guide: '조직장이 확정한 주간 정산은 사유와 함께 재오픈해야 해요.',
    resolution: 'contact',
  }],
  ['cashflow_weekly_reopen_forbidden', {
    guide: '확정된 주간 정산은 프로젝트 조직장이나 관리자만 되돌릴 수 있어요.',
    resolution: 'contact',
  }],
  ['cashflow_weekly_confirm_not_submitted', {
    guide: '완료 요청된 주간 정산만 확정할 수 있어요. 화면을 다시 불러온 뒤 상태를 확인해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_weekly_confirm_forbidden', {
    guide: '주간 정산 확정은 프로젝트 조직장만 할 수 있어요.',
    resolution: 'contact',
  }],
  ['cashflow_month_closed', {
    guide: '이미 누적 결산이 끝난 월이에요. 수정이 필요하면 관리자에게 월 재오픈을 요청해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_close_contract_invalid', {
    guide: '월 결산 기준 정보를 확인할 수 없어 안전하게 중단했어요. AXR 현금흐름 기간·마감 정책에서 상태를 확인해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_reopen_decision_forbidden', {
    guide: '현재 프로젝트의 활성 조직장 또는 Runtime 관리자만 재오픈을 결정할 수 있어요. 담당 조직장을 확인해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_reopen_latest_horizon_only', {
    guide: '가장 최근 누적 월 결산만 다시 열 수 있어요. 최신 결산 월을 확인한 뒤 요청해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_reopen_month_not_closed', {
    guide: '해당 월은 아직 마감되지 않았어요. 마감 상태를 확인해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_reopen_revision_changed', {
    guide: '검토 중 월 결산 상태가 바뀌었어요. 최신 상태를 다시 불러온 뒤 요청해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_reopen_latest_request_required', {
    guide: '현재 최신 월 결산 요청이 바뀌었어요. 최신 요청을 다시 불러와 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_reopen_request_missing', {
    guide: '재오픈할 월 결산 요청을 찾을 수 없어요. 목록을 새로고침한 뒤 요청을 확인해 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_reopen_not_awaiting_decision', {
    guide: '이 재오픈 요청은 이미 처리됐거나 승인 대기 상태가 아니에요. 최신 상태를 다시 불러와 주세요.',
    resolution: 'retry',
  }],
  ['cashflow_month_reopen_counter_invalid', {
    guide: '재오픈 이력 값이 올바르지 않아 안전하게 중단했어요. 시스템 담당자에게 문의해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_reopen_decision_invalid', {
    guide: '재오픈 결정값이 올바르지 않아요. 승인 또는 반려를 선택해 주세요.',
    resolution: 'contact',
  }],
  ['cashflow_month_reopen_period_invalid', {
    guide: '결산 월 형식이 올바르지 않아요. 대상 월을 확인해 주세요.',
    resolution: 'contact',
  }],
  ['internal_error', {
    guide: '요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.',
    resolution: 'retry',
  }],
  ['forbidden', {
    guide: '이 작업을 수행할 권한이 없어요. 프로젝트 담당자에게 권한을 확인해 주세요.',
    resolution: 'contact',
  }],
]);

export function resolveApiErrorPresentation(code: string, statusCode: number): ApiErrorPresentation {
  const mapped = typeof code === 'string' ? presentations.get(code) : undefined;
  if (mapped) return { ...mapped };

  return Number.isFinite(statusCode) && statusCode >= 500
    ? { guide: '요청을 처리하는 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요.', resolution: 'retry' }
    : { guide: '요청을 처리할 수 없어요. 입력 내용과 권한을 확인해 주세요.', resolution: 'contact' };
}
