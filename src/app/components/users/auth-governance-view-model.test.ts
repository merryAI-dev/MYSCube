import { selectVisibleGovernanceRow } from './auth-governance-view-model';
import { getCurrentGovernancePermissionLabel } from './auth-governance-view-model';
import { describe, expect, it } from 'vitest';
import {
  emptyGovernanceSummary,
  filterGovernanceRows,
  getFriendlyGovernanceIssueLabels,
  getGovernanceOperatorStatus,
  getRecommendedGovernanceRole,
} from './auth-governance-view-model';
import type { AuthGovernanceUserRow } from '../../lib/platform-bff-client';

const baseRow: AuthGovernanceUserRow = {
  identityKey: 'jslee@mysc.co.kr',
  email: 'jslee@mysc.co.kr',
  authUid: 'uid-jslee',
  displayName: 'JS Lee',
  authDisabled: false,
  bootstrapAdmin: true,
  claimRole: 'pm',
  claimTenantId: 'mysc',
  canonicalMember: {
    docId: 'uid-jslee',
    uid: 'uid-jslee',
    email: 'jslee@mysc.co.kr',
    role: 'pm',
    status: 'ACTIVE',
    name: '이재성',
  },
  legacyMembers: [],
  effectiveRole: 'pm',
  driftFlags: ['bootstrap_admin_not_adopted'],
  needsDeepSync: true,
};

describe('auth governance view model helpers', () => {
  it('recommends admin for bootstrap admin candidates', () => {
    expect(getRecommendedGovernanceRole(baseRow)).toBe('admin');
  });

  it('filters drift-only and text matches', () => {
    const rows = [
      baseRow,
      {
        ...baseRow,
        identityKey: 'pm@mysc.co.kr',
        email: 'pm@mysc.co.kr',
        bootstrapAdmin: false,
        effectiveRole: 'pm',
        driftFlags: [],
        needsDeepSync: false,
      },
    ];

    const filtered = filterGovernanceRows(rows, {
      searchText: 'jslee',
      role: 'ALL',
      drift: 'DRIFT_ONLY',
      source: 'ALL',
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0].email).toBe('jslee@mysc.co.kr');
  });

  it('returns an empty summary shape', () => {
    expect(emptyGovernanceSummary()).toEqual({
      total: 0,
      needsDeepSync: 0,
      missingAuth: 0,
      missingCanonicalMember: 0,
      duplicateMemberDocs: 0,
      bootstrapCandidates: 0,
    });
  });

  it('describes sync issues in non-developer language', () => {
    expect(getFriendlyGovernanceIssueLabels({
      ...baseRow,
      driftFlags: ['claim_mismatch', 'duplicate_member_docs', 'missing_canonical_member'],
    })).toEqual([
      '로그인 권한과 화면 권한이 다름',
      '권한 기록이 중복됨',
      '직원 권한 기록 없음',
    ]);
  });

  it('summarizes whether an operator needs to take action', () => {
    expect(getGovernanceOperatorStatus(baseRow)).toEqual({
      tone: 'warning',
      label: '확인 필요',
      description: '권한 반영 버튼을 눌러 로그인 권한과 직원 권한을 맞춰야 합니다.',
    });

    expect(getGovernanceOperatorStatus({ ...baseRow, needsDeepSync: false, driftFlags: [] })).toEqual({
      tone: 'success',
      label: '정상',
      description: '로그인 권한과 직원 권한이 맞춰져 있습니다.',
    });
  });
});

it('does not label a recommended PM or bootstrap admin as approved access without canonical membership', () => {
  expect(getCurrentGovernancePermissionLabel({ ...baseRow, canonicalMember: null, effectiveRole: 'pm' }, (role) => role)).toBe('직원 권한 미승인');
  expect(getCurrentGovernancePermissionLabel({ ...baseRow, canonicalMember: null, effectiveRole: 'admin', bootstrapAdmin: true }, (role) => role)).toBe('직원 권한 미승인');
  expect(getCurrentGovernancePermissionLabel({ ...baseRow, canonicalMember: { ...baseRow.canonicalMember!, role: 'pm' }, effectiveRole: 'admin' }, (role) => role)).toBe('현재 권한 pm');
});

it('never preserves an action target hidden by the current search', () => {
 const a = {...baseRow, identityKey: 'a', email: 'a@example.com'};
 const b = {...baseRow, identityKey: 'b', email: 'b@example.com'};
 expect(selectVisibleGovernanceRow([b], a.identityKey)).toBe(b);
 expect(selectVisibleGovernanceRow([], a.identityKey)).toBeNull();
});
