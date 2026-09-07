import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MigrationAuditConsoleRecord } from '../../platform/project-migration-console';
import { buildMigrationReviewDocumentSlots } from './migration-audit/MigrationAuditDocumentDialog';

const pageSource = readFileSync(resolve(import.meta.dirname, 'ProjectMigrationAuditPage.tsx'), 'utf8');
const controlBarSource = readFileSync(resolve(import.meta.dirname, 'migration-audit/MigrationAuditControlBar.tsx'), 'utf8');
const documentSource = readFileSync(resolve(import.meta.dirname, 'migration-audit/MigrationAuditDocumentDialog.tsx'), 'utf8');
const recordListSource = readFileSync(resolve(import.meta.dirname, 'migration-audit/MigrationAuditRecordList.tsx'), 'utf8');
const previewSource = readFileSync(resolve(import.meta.dirname, 'ContractDocumentPreview.tsx'), 'utf8');
const financialYearsTableSource = readFileSync(resolve(import.meta.dirname, 'migration-audit/FinancialYearsTable.tsx'), 'utf8');
const compositeSource = [pageSource, controlBarSource, documentSource, recordListSource, previewSource].join('\n');

describe('ProjectMigrationAuditPage review flow', () => {
  it('keeps a filter-first inbox and opens a formal three-line approval document', () => {
    expect(compositeSource).toContain('data-testid="migration-review-search-bar"');
    expect(compositeSource).toContain('data-testid="migration-review-record-list"');
    expect(compositeSource).toContain('data-testid="migration-review-document"');
    expect(compositeSource).toContain('프로젝트 등록 및 승인서');
    expect(compositeSource).toContain('기안');
    expect(compositeSource).toContain('조직장 승인');
    expect(compositeSource).toContain('경영기획실 합의');
    expect(compositeSource).toContain('실무자 제출/재제출 메모');
    expect(compositeSource).toContain("entry.status === 'PENDING' ? '실무자 제출/재제출 메모'");
    expect(compositeSource).toContain('ApprovalSeal');
    expect(compositeSource).toContain('CIC 필터');
    expect(compositeSource).toContain('상태 필터');
    expect(compositeSource).toContain('프로젝트 검색');
    expect(compositeSource).toContain('문서 열기');
  });

  it('keeps the designated organization-head guard in the UI as defense in depth', () => {
    expect(pageSource).toContain('const designatedApproverId');
    expect(pageSource).toContain('designatedApproverId === authUser.uid');
    expect(pageSource).toContain('if (!canFinalize)');
    expect(pageSource).not.toContain('isSameMigrationAuditCic');
    expect(documentSource).toContain('canFinalize: boolean');
    expect(documentSource).toContain('지정된 조직장만 승인 또는 반려할 수 있습니다.');
    expect(documentSource).toContain(
      'const reviewPayload = record.request ? resolveProjectRequestPayload(record.request) : record.project;',
    );
    expect(documentSource).toContain("const designatedApproverName = reviewPayload?.executiveApproverName || '';");
    expect(documentSource).not.toContain('record.project.executiveApproverName');
  });

  it('exposes an assignee-only portal inbox without broadening the admin review route', () => {
    expect(pageSource).toContain('assigneeOnly?: boolean');
    expect(pageSource).toContain('export function ProjectAssigneeApprovalPage()');
    expect(pageSource).toContain('const { projects, portalUser } = usePortalStore()');
    expect(pageSource).toContain('<ProjectMigrationAuditPageContent assigneeOnly projects={projects} currentUser={portalUser} />');
    expect(pageSource).toContain("const effectiveInboxScope = assigneeOnly ? 'MINE' : inboxScope");
    expect(pageSource).toContain('assigneeOnly={assigneeOnly}');
    expect(controlBarSource).toContain('assigneeOnly?: boolean');
    expect(controlBarSource).toContain('!isManagementPlanning && !assigneeOnly');
    expect(pageSource).toContain('fetchAssignedProjectRequestsViaBff');
    expect(pageSource).toContain('fetchProjectReviewInboxViaBff');
    expect(pageSource).toContain('const assignedInbox = await fetchAssignedProjectRequestsViaBff');
    expect(pageSource).toContain('setRequests(assignedInbox.requests)');
    expect(pageSource).toContain('setAssignedProjects(assignedInbox.projects)');
    expect(pageSource).toContain('assignedProjects.forEach((project) => projectsById.set(project.id, project))');
    expect(pageSource).toContain('buildMigrationAuditConsoleRecords(recordProjects, requests)');
    expect(pageSource).toContain('requestLoadError');
    expect(pageSource).not.toContain("collection(db, 'tenants'");
  });

  it('uses a separate management-planning command only after organization approval', () => {
    expect(pageSource).toContain("reviewStage = 'executive'");
    expect(pageSource).toContain("reviewStage === 'managementPlanning'");
    expect(pageSource).toContain('deriveMigrationAuditStatus(record.project, record.request)');
    expect(pageSource).toContain('reviewProjectManagementPlanningStatusViaBff');
    expect(pageSource).toContain("reviewStatus: actionMode === 'approve' ? 'AGREED' : 'REVISION_REJECTED'");
    expect(pageSource).toContain('프로젝트 코드를 입력해 주세요.');
    expect(pageSource).not.toContain("reviewStatus: 'PLANNING_AGREED'");
    expect(recordListSource).toContain('프로젝트 코드');
  });

  it('prefills and locks an already-issued project code during planning re-review', () => {
    expect(pageSource).toContain("setProjectCode(String(openRecord?.project.projectCode || '').trim())");
    expect(pageSource).toContain('const existingProjectCode = String(openRecord?.project.projectCode || \'\').trim()');
    expect(pageSource).toContain('readOnly={Boolean(existingProjectCode)}');
    expect(pageSource).toContain('이미 부여된 프로젝트 코드는 변경할 수 없습니다.');
  });

  it('matches the BFF 2,000-character approval and rejection memo limit', () => {
    expect(pageSource).toContain('maxLength={2000}');
    expect(pageSource).toContain('{reviewComment.length.toLocaleString()}/2,000자');
  });

  it('shows all seven logical submission slots and fetches each stored original through the BFF', () => {
    expect(documentSource).toContain('data-testid="migration-review-document-slots"');
    expect(documentSource).toContain("number: 1");
    expect(documentSource).toContain("number: 7");
    expect(documentSource).toContain("number: 4, label: '제안서 Word 원본 (선택)'");
    expect(documentSource).toContain("number: 7, label: 'RFP/요청 메일 증빙 (선택)'");
    expect(documentSource).toContain('customerBusinessRegistrationDocument');
    expect(documentSource).toContain('proposalWordOriginalDocument');
    expect(documentSource).toContain('proposalPptOriginalDocument');
    expect(documentSource).toContain('presentationPptOriginalDocument');
    expect(documentSource).toContain('registrationOptionalDocumentNotes');
    expect(pageSource).toContain('usePrivateDraftDocumentPreviews');
    expect(pageSource).toContain('REVIEW_DOCUMENT_FIELDS');
    expect(pageSource).toContain('downloadProjectRequestAttachmentViaBff');
    expect(pageSource).toContain('downloadProjectAttachmentViaBff');
    expect(pageSource).toContain('const reviewPayload = openRecord.request');
    expect(pageSource).not.toContain('requestDocument !== undefined');
    expect(pageSource).toContain('onLoadDocumentPreview={loadDocumentPreview}');
    expect(documentSource).toContain('ContractDocumentPreview');
    expect(documentSource).toContain('onLoadDocumentPreview');
    expect(documentSource).toContain('미첨부 사유');
    expect(previewSource).toContain('data-testid="contract-document-preview"');
    expect(previewSource).toContain('<iframe');
    expect(previewSource).toContain('새 탭');
    expect(documentSource).toContain('제출 원문을 안전하게 불러오는 중입니다.');
    expect(documentSource).toContain('PDF 미리보기가 비어 있으면 새 탭에서 원문을 확인하고');
  });

  it('does not fill an omitted submitted document from the old project', () => {
    const record = {
      project: {
        contractDocument: { name: 'old-contract.pdf', path: 'projects/old-contract.pdf' },
        proposalWordOriginalDocument: { name: 'old-proposal.docx', path: 'projects/old-proposal.docx' },
        registrationOptionalDocumentNotes: {
          proposalWordOriginal: '기존 프로젝트 사유',
          proposalPptOriginal: '',
          presentationPptOriginal: '',
        },
      },
      request: {
        requestKind: 'REGISTRATION',
        payload: {
          customerBusinessRegistrationDocument: { name: 'customer.pdf', path: 'requests/customer.pdf' },
          quoteDocument: { name: 'quote.pdf', path: 'requests/quote.pdf' },
          proposalDocument: null,
          rfpRequestEvidenceDocument: { name: 'request.eml', path: 'requests/request.eml' },
          proposalWordOriginalDocument: null,
          proposalPptOriginalDocument: null,
          presentationPptOriginalDocument: null,
          registrationOptionalDocumentNotes: {
            proposalWordOriginal: '고객사가 Word 원본을 제공하지 않음',
            proposalPptOriginal: '제안서가 PDF로만 작성됨',
            presentationPptOriginal: '별도 발표자료 없음',
          },
          registrationConfirmations: {
            proposalPptOriginal: 'https://drive.google.com/file/d/proposal/view',
            presentationPptOriginal: 'https://docs.google.com/presentation/d/presentation/edit',
          },
        },
      },
    } as unknown as MigrationAuditConsoleRecord;

    const slots = buildMigrationReviewDocumentSlots(record);

    expect(slots).toHaveLength(7);
    expect(slots[0]?.entries).toEqual([]);
    expect(slots[3]?.entries).toEqual([]);
    expect(slots[3]?.note).toBe('고객사가 Word 원본을 제공하지 않음');
    expect(slots[4]?.link).toBe('https://drive.google.com/file/d/proposal/view');
    expect(slots[4]?.note).toBe('제안서가 PDF로만 작성됨');
    expect(slots[5]?.link).toBe('https://docs.google.com/presentation/d/presentation/edit');
    expect(slots[4]?.note).toBe('제안서가 PDF로만 작성됨');
    expect(slots[5]?.note).toBe('별도 발표자료 없음');
    expect(slots[6]?.entries.map((entry) => entry.kind)).toEqual(['rfp_request_evidence']);
    expect(slots.slice(3).every((slot) => slot.optional)).toBe(true);
  });

  it('does not revive cleared or inaccessible metadata', () => {
    const record = {
      project: {
        registrationOptionalDocumentNotes: {
          proposalWordOriginal: '과거 미첨부 사유',
          proposalPptOriginal: '',
          presentationPptOriginal: '',
        },
      },
      request: {
        requestKind: 'REGISTRATION',
        payload: {
          customerBusinessRegistrationDocument: { name: '경로가 없는 파일.pdf' },
          quoteSubmissionDeferred: true,
          proposalDocument: { name: 'proposal.pdf', path: 'requests/proposal.pdf' },
          rfpRequestEvidenceDocument: { name: 'request.eml', path: 'requests/request.eml' },
          registrationOptionalDocumentNotes: null,
        },
      },
    } as unknown as MigrationAuditConsoleRecord;

    const slots = buildMigrationReviewDocumentSlots(record);

    expect(slots[1]?.entries).toEqual([]);
    expect(slots[2]?.note).toBe('이후 제출 예정');
    expect(slots[3]?.entries).toEqual([]);
    expect(slots[3]?.note).toBe('');
    expect(slots[6]?.entries.map((entry) => entry.kind)).toEqual(['rfp_request_evidence']);
  });

  it('shows the submitted contract and finance facts without retired registration assumptions', () => {
    expect(documentSource).toContain('연도별 계약/재무');
    expect(documentSource).toContain('총실비(원가)');
    expect(documentSource).toContain('이자 반납 여부');
    expect(documentSource).not.toContain('최종 입금 재무주차');
    expect(documentSource).not.toContain('row.finalPaymentExpectedWeek');
    // 연도별 계약/재무는 한 줄 문자열 대신 표 안의 표(FinancialYearsTable)로 그린다.
    expect(documentSource).toContain('<FinancialYearsTable years={financialYears} />');
    expect(financialYearsTableSource).toContain("row.isSettled ? '완료' : '미완료'");
    expect(financialYearsTableSource).toContain('advanceInterimBelow70Reason');
    expect(documentSource).toContain('label="등록 메모"');
    expect(documentSource).toContain('산출내역서(견적서)');
    expect(documentSource).toContain('이후 제출 예정');
    expect(documentSource).toContain('선택 · 미제출');
    expect(documentSource).not.toContain('최종 입금 메모');
    // 2026-08-26 보람: 등록 확인 사항 섹션을 걷어낸다. 인건비/고객사 확인 3종은 위저드가
    // 더 이상 수집하지 않는 레거시(항상 미입력)고, 실제 수집되는 모두싸인 여부는 계약/재무의
    // '계약 체결 방식' 한 셀로 접는다.
    expect(documentSource).not.toContain('등록 확인 사항');
    expect(documentSource).not.toContain('인건비 4대보험 포함');
    expect(documentSource).toContain('계약 체결 방식');
    expect(documentSource).toContain('모두싸인');
    // 팀/인력은 dossier 가 늘 담고 있었으나 문서에 그리지 않았다.
    // 서류상 명단의 원천은 참여율 시트다. 문서에는 실제 투입인력과 시트 안내만 남긴다.
    expect(documentSource).toContain('label="실제 투입인력"');
    expect(documentSource).toContain('서류상 참여인력');
    expect(documentSource).toContain('참여율 시트에서 확인해 주세요');
    // 금액 5종이 모두 보여야 합계가 맞아 보인다.
    expect(documentSource).toContain('label="총매출부가세"');
    expect(documentSource).toContain('label="총지원금"');
    expect(documentSource).not.toContain('label="비고"');
  });
});
