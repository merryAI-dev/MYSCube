const messages: Record<string, string> = {
  auth_identity_changed: '로그인 계정이 변경되었습니다. 계정과 직원 기록을 다시 확인해 주세요.',
  email_domain_not_allowed: '허용된 회사 이메일 계정만 연결할 수 있습니다.',
  people_uid_unlinked: '인력 명부의 직원과 로그인 계정을 먼저 연결한 뒤 권한을 반영해 주세요.',
  people_uid_ambiguous: '같은 로그인 계정에 직원 기록이 여러 건 연결되어 있습니다. 중복 연결을 확인해 주세요.',
  people_email_ambiguous: '같은 이메일을 가진 직원 기록이 여러 건입니다. 명부를 확인해 주세요.',
  people_email_conflict: '직원 명부의 이메일과 로그인 이메일이 다릅니다. 본인 확인 후 명부를 정정해 주세요.',
  people_uid_conflict: '이 직원은 다른 로그인 계정에 연결되어 있습니다. 기존 연결을 확인해 주세요.',
  member_identity_conflict: '직원 권한 기록이 다른 계정과 연결되어 있습니다. 기존 연결을 확인해 주세요.',
  people_identity_changed: '직원 기록이 변경되었습니다. 목록을 다시 확인한 뒤 연결해 주세요.',
  people_not_found: '선택한 직원 기록을 찾을 수 없습니다. 명부를 다시 확인해 주세요.',
  auth_identity_missing: '대상 사용자가 회사 Google 계정으로 먼저 로그인해야 합니다.',
  auth_identity_unverified: '검증된 회사 Google 로그인 계정만 연결할 수 있습니다.',
  auth_identity_disabled: '사용 중지된 로그인 계정은 연결할 수 없습니다.',
  forbidden: '이 작업을 승인할 관리자 권한이 없습니다. 승인 가능한 관리자에게 요청해 주세요.',
  member_authority_required: '현재 관리자 권한을 확인할 수 없습니다. 관리자 계정 연결과 활성 상태를 확인해 주세요.',
  auth_governance_target_changed: '직원 권한 기록이 변경되었습니다. 목록을 다시 확인한 뒤 반영해 주세요.',
  last_admin_lockout: '마지막 관리자의 권한은 해제할 수 없습니다.',
  idempotency_in_progress: '같은 요청을 처리 중입니다. 잠시 후 결과를 확인해 주세요.',
  idempotency_conflict: '이전 요청과 내용이 다릅니다. 목록에서 현재 상태를 확인한 뒤 새로 요청해 주세요.',
};

export function governanceErrorMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return messages[code] || '요청 결과를 확인하지 못했습니다. 현재 상태를 다시 조회해 주세요. 계속되면 관리자에게 문의해 주세요.';
}
