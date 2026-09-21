import { describe, expect, it } from 'vitest';
import { projectReviewBadges } from './project-review-badges';
import type { MigrationAuditConsoleRecord } from './project-migration-console';

function record(payload: Record<string, unknown>, extra = {}): MigrationAuditConsoleRecord {
  return { project: { contractDocument: { path: 'must-not-fill' } }, request: { requestKind: 'CHANGE', status: 'PENDING', proposedSnapshot: payload, ...extra } } as unknown as MigrationAuditConsoleRecord;
}
const labels = (input: MigrationAuditConsoleRecord) => projectReviewBadges(input).map((badge) => badge.label);
describe('review badges use submitted evidence', () => {
  it('distinguishes absent, empty, disconnected and present documents without project fallback', () => {
    expect(labels(record({}))).toContain('계약서 제출 기록 없음');
    expect(labels(record({ contractDocument: null }))).toContain('계약서 미제출');
    expect(labels(record({ contractDocument: { name: 'original.pdf' } }))).toContain('계약서 재첨부 필요');
    expect(labels(record({ contractDocument: { path: 'existing' } }))).not.toContain('계약서 미제출');
    expect(labels(record({ contractDocument: { downloadURL: 'https://example.test/file' } }))).not.toContain('계약서 재첨부 필요');
  });
  it('does not flag deferred, explained, not applicable or linked materials as missing', () => {
    const result = labels(record({ quoteSubmissionDeferred: true, proposalPptOriginalDocument: null,
      registrationConfirmations: { proposalPptOriginal: 'https://drive.google.com/file/d/test/view' },
      registrationOptionalDocumentNotes: { proposalWordOriginal: '해당 없음', rfpRequestEvidence: '고객사 미제공', presentationPptOriginal: '해당 없음' } }));
    expect(result.filter((label) => /견적서|제안서|발표자료|RFP/.test(label))).toEqual([]);
  });
  it('does not claim missing files while publication is unknown or processing', () => {
    const input = record({}, { requestKind: 'REGISTRATION', payload: { registrationRequirementsVersion: 2, contractDocument: null } });
    expect(labels(input)).toContain('계약서 첨부 상태 미확인');
    expect(projectReviewBadges(input, { legacy: false, issues: [{ code: 'project_attachments_processing', severity: 'blocking', title: '', detail: '', action: '' }] }).map(b => b.label)).toContain('계약서 첨부 준비 중');
    expect(projectReviewBadges(input, { legacy: false, issues: [] }).map(b => b.label)).toContain('계약서 미제출');
  });
  it('does not turn a read failure into missing or mandatory reupload', () => {
    const input = record({ contractDocument: { path: 'existing' } });
    const before = JSON.stringify(input);
    for (const result of [projectReviewBadges(input, undefined, { contract: { status: 'error' } }), projectReviewBadges(input, { legacy: true, issues: [{ code: 'project_attachment_unavailable', field: 'contractDocument', severity: 'blocking', title: '', detail: '접근 실패', action: '확인 요청' }] })]) {
      expect(result.map(b => b.label)).toContain('계약서 조회 실패');
      expect(result.map(b => b.label)).not.toContain('계약서 재첨부 필요');
    }
    expect(JSON.stringify(input)).toBe(before);
  });
  it('recognizes explicit zero and preserves uncertainty about stored unconfirmed amounts', () => {
    const row = { year: 2026, contractAmount: 100, salesVatAmount: 0, totalRevenueAmount: 20, totalActualCost: 80, supportAmount: 0, inputFlags: { contractAmount: true, salesVatAmount: true, totalRevenueAmount: true, totalActualCost: true, supportAmount: true } };
    expect(labels(record({ financialYears: [row] })).filter(b => b.startsWith('2026'))).toEqual([]);
    expect(labels(record({ financialYears: [{ ...row, totalActualCost: null }] }))).toContain('2026년 실비(원가) 미입력');
    expect(labels(record({ financialYears: [{ ...row, inputFlags: { ...row.inputFlags, totalActualCost: false } }] }))).toContain('2026년 실비(원가) 입력 기록 확인');
  });
});
