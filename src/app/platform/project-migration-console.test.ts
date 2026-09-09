import { describe, expect, it } from 'vitest';
import type { Project, ProjectRequest } from '../data/types';
import {
  buildMigrationAuditConsoleRecords,
  collectMigrationAuditCicOptions,
  describeMigrationAuditActionState,
  deriveMigrationAuditStatus,
  filterMigrationAuditConsoleRecords,
  findMigrationAuditRecord,
  getMigrationAuditStatusLabel,
  isMigrationAuditPmRegistration,
  isSameMigrationAuditCic,
  normalizeCicLabel,
  resolveMigrationReviewApproverId,
  summarizeMigrationAuditConsole,
} from './project-migration-console';

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    slug: 'p-1',
    orgId: 'mysc',
    name: '기본 프로젝트',
    status: 'IN_PROGRESS',
    type: 'C1',
    phase: 'CONFIRMED',
    contractAmount: 0,
    contractStart: '2026-01-01',
    contractEnd: '2026-12-31',
    settlementType: 'TYPE1',
    basis: '공급가액',
    accountType: 'OPERATING',
    paymentPlan: { contract: 0, interim: 0, final: 0 },
    paymentPlanDesc: '',
    clientOrg: '',
    groupwareName: '',
    participantCondition: '',
    contractType: '계약서(날인)',
    department: '',
    teamName: '',
    managerId: '',
    managerName: '',
    budgetCurrentYear: 0,
    taxInvoiceAmount: 0,
    profitRate: 0,
    profitAmount: 0,
    isSettled: false,
    finalPaymentNote: '',
    confirmerName: '',
    lastCheckedAt: '',
    cashflowDiffNote: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    registrationSource: 'pm_portal',
    ...overrides,
  };
}

function makeRequest(overrides: Partial<ProjectRequest> = {}): ProjectRequest {
  return {
    id: 'pr-1',
    tenantId: 'mysc',
    status: 'APPROVED',
    reviewOutcome: 'APPROVED',
    requestedBy: 'u-1',
    requestedByName: '변민욱',
    requestedByEmail: 'pm@example.com',
    requestedAt: '2026-04-20T08:00:00.000Z',
    approvedProjectId: 'p-1',
    payload: {
      name: '기본 프로젝트',
      officialContractName: '기본 프로젝트 공식명',
      type: 'C1',
      description: '설명',
      clientOrg: 'KOICA',
      department: 'CIC-A',
      contractAmount: 10000000,
      salesVatAmount: 0,
      totalRevenueAmount: 10000000,
      totalActualCost: 0,
      supportAmount: 0,
      contractStart: '2026-01-01',
      contractEnd: '2026-12-31',
      settlementType: 'TYPE1',
      basis: '공급가액',
      accountType: 'OPERATING',
      paymentPlanDesc: '계약금 100%',
      settlementGuide: '',
      projectPurpose: '목적',
      managerName: '변민욱',
      teamName: 'CIC-A',
      teamMembers: '변민욱',
      participantCondition: '',
      note: '',
      contractDocument: null,
      contractAnalysis: null,
    },
    ...overrides,
  };
}

describe('project-migration-console', () => {
  it('requires modern request approvers from the submitted source and preserves legacy fallback', () => {
    const project = makeProject({ executiveApproverId: 'old-head' });
    expect(resolveMigrationReviewApproverId(project, makeRequest({ requestKind: 'CHANGE' }))).toBeUndefined();
    expect(resolveMigrationReviewApproverId(project, makeRequest({ requestKind: 'REGISTRATION', payload: { ...makeRequest().payload, registrationRequirementsVersion: 2 } }))).toBeUndefined();
    expect(resolveMigrationReviewApproverId(project, makeRequest())).toBe('old-head');
    expect(resolveMigrationReviewApproverId(project, null)).toBe('old-head');
  });
  it.each(['REVISION_REJECTED', 'PLANNING_AGREED'] as const)('uses new pending CHANGE over old %s project stage', (executiveReviewStatus) => {
    expect(deriveMigrationAuditStatus(makeProject({ executiveReviewStatus }), makeRequest({ requestKind: 'CHANGE', status: 'PENDING' }))).toBe('PENDING');
  });
  it('uses submitted identity without falling back to confirmed project values', () => {
    const records = buildMigrationAuditConsoleRecords([makeProject({ name: 'OLD', cic: 'OLD', clientOrg: 'OLD', managerName: 'OLD' })], [makeRequest({ payload: { ...makeRequest().payload, name: '', officialContractName: '', department: '', clientOrg: '', managerName: '' } })]);
    expect(records[0]).toMatchObject({ title: '이름 없음', cic: '미지정', clientOrg: '', managerName: '' });
  });
  it('keeps planning-agreed registrations out of the unreviewed queue', () => {
    expect(deriveMigrationAuditStatus(makeProject({ executiveReviewStatus: 'PLANNING_AGREED' }))).toBe('PLANNING_AGREED');
  });

  it('normalizes empty cic to 미지정', () => {
    expect(normalizeCicLabel('')).toBe('미지정');
    expect(normalizeCicLabel(undefined)).toBe('미지정');
    expect(normalizeCicLabel('CIC-A')).toBe('CIC-A');
  });

  it('normalizes equivalent organization labels for display and reviewer matching', () => {
    expect(normalizeCicLabel('CIC 2')).toBe('CIC2');
    expect(normalizeCicLabel('AXR Team')).toBe('AXR팀');
    expect(isSameMigrationAuditCic('CIC2', 'CIC 2')).toBe(true);
    expect(isSameMigrationAuditCic('AXR팀', 'AXR Team')).toBe(true);
    expect(isSameMigrationAuditCic('CIC2', 'CIC3')).toBe(false);
    expect(isSameMigrationAuditCic('미지정', '')).toBe(false);
  });

  it('builds review queue records from PM portal projects only', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-1', name: '에코스타트업', cic: 'CIC-A' }),
        makeProject({ id: 'p-2', name: '기후테크', cic: 'CIC-B', executiveReviewStatus: 'REVISION_REJECTED' }),
        makeProject({ id: 'p-3', registrationSource: 'manual', name: '기존 등록 사업', cic: 'CIC-C' }),
      ],
      [
        makeRequest({ approvedProjectId: 'p-1', payload: { ...makeRequest().payload, department: 'CIC-A' } }),
      ],
    );

    expect(records).toHaveLength(3);
    expect(records.map((record) => record.id)).toEqual(['p-1', 'p-2', 'p-3']);
    expect(records[0].status).toBe('APPROVED');
    expect(records[1].status).toBe('REVISION_REJECTED');
    // p-3 carries no recorded decision. It is awaiting review, not approved.
    expect(records[2].status).toBe('PENDING');
  });

  it('surfaces a migrated project that carries no recorded review decision', () => {
    const records = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-migrated', registrationSource: 'manual', name: '이관된 사업', cic: 'CIC-A' })],
      [],
    );
    expect(records[0].status).toBe('PENDING');
    expect(getMigrationAuditStatusLabel(records[0].status)).toBe('검토 대기');
  });

  it('treats linked pending project request as pending even when registrationSource is missing', () => {
    const records = buildMigrationAuditConsoleRecords(
      [makeProject({
        id: 'p-cts2',
        name: '2026 CTS2',
        registrationSource: undefined,
        executiveReviewStatus: 'PENDING',
      })],
      [makeRequest({
        id: 'pr-cts2',
        status: 'PENDING',
        approvedProjectId: 'p-cts2',
      })],
    );

    expect(records[0]?.status).toBe('PENDING');
    expect(isMigrationAuditPmRegistration(records[0])).toBe(true);
  });

  it('keeps an executive-approved project out of the organization-head pending queue after management planning returns its request to the PM', () => {
    const records = buildMigrationAuditConsoleRecords(
      [makeProject({
        id: 'p-management-returned',
        executiveReviewStatus: 'APPROVED',
        managementPlanningReviewStatus: 'REVISION_REJECTED',
      })],
      [makeRequest({
        id: 'pr-management-returned',
        status: 'PENDING',
        approvedProjectId: 'p-management-returned',
      })],
    );

    expect(records[0]?.status).toBe('APPROVED');
  });

  it.each([
    ['PENDING', 'PENDING'],
    ['REJECTED', 'REVISION_REJECTED'],
    ['APPROVED', 'APPROVED'],
  ] as const)('shows an approved project by its latest %s change request', (requestStatus, expectedStatus) => {
    const records = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-change', executiveReviewStatus: 'APPROVED' })],
      [makeRequest({
        id: 'change-p-change',
        requestKind: 'CHANGE',
        targetProjectId: 'p-change',
        approvedProjectId: 'p-change',
        status: requestStatus,
      })],
    );

    expect(records[0]?.status).toBe(expectedStatus);
  });

  it('keeps rejected projects rejected until the project is explicitly resubmitted', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({
          id: 'p-rejected',
          executiveReviewStatus: 'REVISION_REJECTED',
        }),
        makeProject({
          id: 'p-resubmitted',
          executiveReviewStatus: 'PENDING',
        }),
      ],
      [
        makeRequest({
          id: 'pr-rejected-edit',
          status: 'PENDING',
          approvedProjectId: 'p-rejected',
        }),
        makeRequest({
          id: 'pr-resubmitted-edit',
          status: 'PENDING',
          approvedProjectId: 'p-resubmitted',
        }),
      ],
    );

    expect(records.find((record) => record.id === 'p-rejected')?.status).toBe('REVISION_REJECTED');
    expect(records.find((record) => record.id === 'p-resubmitted')?.status).toBe('PENDING');
  });

  it('filters by cic and review status', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-1', name: '에코스타트업', cic: 'CIC-A' }),
        makeProject({ id: 'p-2', name: '기후테크', cic: 'CIC-B', executiveReviewStatus: 'APPROVED' }),
      ],
      [],
    );

    const filtered = filterMigrationAuditConsoleRecords(records, {
      cic: 'CIC-B',
      status: 'APPROVED',
    });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].project.id).toBe('p-2');
  });

  it('searches project title, requester fields, and raw request payload values', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-cts', name: '일반 프로젝트', cic: 'CIC-A' }),
        makeProject({ id: 'p-other', name: '에코스타트업', cic: 'CIC-A' }),
      ],
      [
        makeRequest({
          id: 'pr-cts',
          approvedProjectId: 'p-cts',
          requestedByName: '김현지(데이지)',
          payload: {
            ...makeRequest().payload,
            name: '2026 CTS2',
            officialContractName: '2023-2026 창업투자 전문기관 CTS 참여기업 역량 강화 용역',
            clientOrg: 'KOICA',
            note: '등록 원문에만 남은 검색 단서',
          },
        }),
      ],
    );

    expect(filterMigrationAuditConsoleRecords(records, {
      cic: 'ALL',
      status: 'ALL',
      searchQuery: 'cts',
    }).map((record) => record.id)).toEqual(['p-cts']);
    expect(filterMigrationAuditConsoleRecords(records, {
      cic: 'CIC-A',
      status: 'APPROVED',
      searchQuery: '검색 단서',
    }).map((record) => record.id)).toEqual(['p-cts']);
    expect(filterMigrationAuditConsoleRecords(records, {
      cic: 'ALL',
      status: 'ALL',
      searchQuery: '데이지',
    }).map((record) => record.id)).toEqual(['p-cts']);
  });

  it('preserves the first authoritative BFF record even when client timestamp comparison differs', () => {
    const records = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-1' })],
      [
        makeRequest({
          id: 'old-request',
          approvedProjectId: 'p-1',
          requestedAt: '2026-04-20T08:00:00.000Z',
          payload: { ...makeRequest().payload, note: 'old' },
        }),
        makeRequest({
          id: 'new-request',
          approvedProjectId: 'p-1',
          requestedAt: '2026-04-21T08:00:00.000Z',
          payload: { ...makeRequest().payload, note: 'new' },
        }),
      ],
    );

    expect(records[0].request?.id).toBe('old-request');
    expect(records[0].request?.payload.note).toBe('old');
  });

  it('summarizes review queue counts by executive outcome across all projects', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-1', executiveReviewStatus: 'APPROVED' }),
        makeProject({ id: 'p-2', executiveReviewStatus: 'REVISION_REJECTED' }),
        makeProject({ id: 'p-3', executiveReviewStatus: 'DUPLICATE_DISCARDED' }),
        makeProject({ id: 'p-4' }),
        makeProject({ id: 'p-5', registrationSource: 'manual' }),
      ],
      [],
    );

    const summary = summarizeMigrationAuditConsole(records);
    // A project with no recorded decision now counts as awaiting review.
    expect(summary.pending).toBe(2);
    expect(summary.approved).toBe(1);
    expect(summary.rejected).toBe(1);
    expect(summary.discarded).toBe(1);
    expect(summary.total).toBe(5);
  });

  it('collects cic options from PM portal projects only', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-1', cic: 'CIC-A', department: 'CIC-A' }),
        makeProject({ id: 'p-2', cic: undefined, department: '투자센터' }),
      ],
      [],
    );

    expect(collectMigrationAuditCicOptions(records)).toEqual(['투자센터', 'CIC-A']);
  });

  it('falls back to the first record when selected id is missing', () => {
    const records = buildMigrationAuditConsoleRecords(
      [
        makeProject({ id: 'p-1', name: '첫번째' }),
        makeProject({ id: 'p-2', name: '두번째' }),
      ],
      [],
    );

    expect(findMigrationAuditRecord(records, 'missing')?.id).toBe('p-1');
    expect(findMigrationAuditRecord(records, 'p-2')?.id).toBe('p-2');
  });

  it('describes action state as executive review progress instead of migration matching', () => {
    const pendingRecord = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-1' })],
      [],
    )[0];
    const approvedRecord = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-2', executiveReviewStatus: 'APPROVED' })],
      [],
    )[0];
    const discardedRecord = buildMigrationAuditConsoleRecords(
      [makeProject({ id: 'p-3', executiveReviewStatus: 'DUPLICATE_DISCARDED' })],
      [],
    )[0];

    expect(describeMigrationAuditActionState(pendingRecord)).toMatchObject({
      label: '검토 대기',
      tone: 'warning',
    });
    expect(describeMigrationAuditActionState(approvedRecord)).toMatchObject({
      label: '승인 완료',
      tone: 'success',
    });
    expect(describeMigrationAuditActionState(discardedRecord)).toMatchObject({
      label: '중복·폐기',
      tone: 'neutral',
    });
  });
});
