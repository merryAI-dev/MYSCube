import type { UserRole } from '../../data/types';
import type { AuthGovernanceSummary, AuthGovernanceUserRow } from '../../lib/platform-bff-client';

export interface AuthGovernanceFilters {
  searchText: string;
  role: 'ALL' | UserRole;
  drift: 'ALL' | 'DRIFT_ONLY' | 'CLEAN_ONLY';
  source: 'ALL' | 'AUTH_MISSING' | 'MEMBER_MISSING' | 'BOOTSTRAP';
}

export interface GovernanceOperatorStatus {
  tone: 'success' | 'warning' | 'danger';
  label: string;
  description: string;
}

const FRIENDLY_ISSUE_LABELS: Record<string, string> = {
  missing_auth: '로그인 계정 없음',
  missing_canonical_member: '직원 권한 기록 없음',
  legacy_only: '예전 권한 기록만 있음',
  duplicate_member_docs: '권한 기록이 중복됨',
  legacy_role_mismatch: '예전 기록의 권한이 다름',
  claim_mismatch: '로그인 권한과 화면 권한이 다름',
  bootstrap_admin_not_adopted: '기본 관리자 권한 미반영',
};

function normalizeText(value: string | undefined): string {
  return (value || '').trim().toLowerCase();
}

export function getRecommendedGovernanceRole(row: AuthGovernanceUserRow): UserRole {
  const effective = (row.effectiveRole || '').trim().toLowerCase();
  if (row.bootstrapAdmin) return 'admin';
  if (effective === 'admin' || effective === 'finance' || effective === 'pm' || effective === 'viewer') {
    return effective as UserRole;
  }
  return 'pm';
}

export function filterGovernanceRows(
  rows: AuthGovernanceUserRow[],
  filters: AuthGovernanceFilters,
): AuthGovernanceUserRow[] {
  const q = normalizeText(filters.searchText);
  return rows.filter((row) => {
    if (filters.role !== 'ALL' && getRecommendedGovernanceRole(row) !== filters.role) return false;
    if (filters.drift === 'DRIFT_ONLY' && !row.needsDeepSync) return false;
    if (filters.drift === 'CLEAN_ONLY' && row.needsDeepSync) return false;
    if (filters.source === 'AUTH_MISSING' && !row.driftFlags.includes('missing_auth')) return false;
    if (filters.source === 'MEMBER_MISSING' && !row.driftFlags.includes('missing_canonical_member')) return false;
    if (filters.source === 'BOOTSTRAP' && !row.bootstrapAdmin) return false;
    if (!q) return true;

    const haystack = [
      row.email,
      row.displayName,
      row.authUid || '',
      row.canonicalMember?.docId || '',
      row.canonicalMember?.name || '',
      row.legacyMembers.map((item) => item.docId).join(' '),
      row.driftFlags.join(' '),
    ].join(' ').toLowerCase();
    return haystack.includes(q);
  });
}

export function getFriendlyGovernanceIssueLabels(row: AuthGovernanceUserRow): string[] {
  return row.driftFlags.map((flag) => FRIENDLY_ISSUE_LABELS[flag] || flag);
}

export function getGovernanceOperatorStatus(row: AuthGovernanceUserRow): GovernanceOperatorStatus {
  if (row.driftFlags.includes('missing_auth')) {
    return {
      tone: 'danger',
      label: '로그인 계정 없음',
      description: '먼저 Google 로그인 계정이 만들어져야 권한을 반영할 수 있습니다.',
    };
  }

  if (!row.canonicalMember) {
    return {
      tone: 'warning',
      label: '직원 권한 미승인',
      description: '아래에서 명부와 로그인 계정을 연결한 뒤 승인된 역할을 반영해 주세요.',
    };
  }

  if (row.needsDeepSync) {
    return {
      tone: 'warning',
      label: '확인 필요',
      description: '권한 반영 버튼을 눌러 로그인 권한과 직원 권한을 맞춰야 합니다.',
    };
  }

  return {
    tone: 'success',
    label: '정상',
    description: '로그인 권한과 직원 권한이 맞춰져 있습니다.',
  };
}

export function emptyGovernanceSummary(): AuthGovernanceSummary {
  return {
    total: 0,
    needsDeepSync: 0,
    missingAuth: 0,
    missingCanonicalMember: 0,
    duplicateMemberDocs: 0,
    bootstrapCandidates: 0,
  };
}

export function getCurrentGovernancePermissionLabel(row: AuthGovernanceUserRow, formatRole: (role: string) => string): string {
  return row.canonicalMember?.role ? `현재 권한 ${formatRole(row.canonicalMember.role)}` : '직원 권한 미승인';
}

export function selectVisibleGovernanceRow(rows: AuthGovernanceUserRow[], selectedIdentityKey: string) {
  return rows.find(row => row.identityKey === selectedIdentityKey) || rows[0] || null;
}
