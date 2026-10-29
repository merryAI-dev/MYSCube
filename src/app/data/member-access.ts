export type MembershipIssue = 'PENDING' | 'INACTIVE' | 'UNAVAILABLE';

export function resolveMembershipIssue(member: { uid?: string; status?: string; role?: string } | undefined, uid: string): MembershipIssue | null {
  if (!member) return 'PENDING';
  if (member.uid !== uid || !['admin', 'tenant_admin', 'finance', 'pm', 'auditor', 'support', 'security', 'viewer'].includes((member.role || '').trim().toLowerCase())) return 'INACTIVE';
  if (member.status !== undefined && member.status !== 'ACTIVE') return member.status === 'PENDING' ? 'PENDING' : 'INACTIVE';
  return null;
}

export function membershipGuidance(issue: MembershipIssue) {
  if (issue === 'PENDING') return { title: '직원 연결과 권한 승인을 기다리고 있습니다', message: 'Google 로그인은 완료됐습니다. 관리자에게 로그인 이메일을 전달하여 인력 명부 연결과 실무자 권한 승인을 요청해 주세요. 승인 전에는 프로젝트를 등록할 수 없습니다.' };
  if (issue === 'INACTIVE') return { title: '직원 권한 확인이 필요합니다', message: '현재 직원 권한으로는 서비스를 이용할 수 없습니다. 관리자에게 계정 연결과 활성 상태를 확인해 달라고 요청해 주세요.' };
  return { title: '직원 권한을 확인하지 못했습니다', message: '네트워크 또는 권한 조회에 문제가 있습니다. 잠시 후 다시 확인해 주세요. 계속되면 관리자에게 문의해 주세요.' };
}
