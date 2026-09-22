import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const editorSource = readFileSync(resolve(import.meta.dirname, 'ProjectEditorWizard.tsx'), 'utf8');
const portalSource = readFileSync(resolve(import.meta.dirname, '../portal/PortalProjectEdit.tsx'), 'utf8');

describe('Project Check out integration shell', () => {
  it('opens the persisted portal editor checkout and keeps trusted document kinds', () => {
    expect(portalSource).toContain('showCheckoutEntry');
    expect(portalSource).toContain("uploadDocument(kind, file)");
    expect(editorSource).toContain('data-testid="project-checkout-entry"');
    expect(editorSource).toContain("item.id === 'financial'");
    expect(editorSource).toContain("'performance_certificate'");
    expect(editorSource).toContain("'tax_invoice'");
    expect(editorSource).toContain("'final_settlement_report'");
  });

  it('states the complete checklist and limits settlement-only work', () => {
    expect(editorSource).toContain('실적증명 원본 5부 이상을 제출했거나 전자 플랫폼 업로드를 완료했습니다.');
    expect(editorSource).toContain('performanceCertificateDocumentApplicable');
    expect(editorSource).toContain('정산 종료 후 모든 정산 자료를 USB에 저장해 재무팀에 제출했습니다.');
    expect(editorSource).toContain('사용 내역은 유지하고 증빙 파일을 삭제했습니다.');
    expect(editorSource).toContain("? [['finalSettlementReportConfirmed'");
    expect(editorSource).toContain('disabled={!draft.checkout.usbEvidenceSubmitted}');
    expect(editorSource).toContain('showCheckoutEntry && showProjectCheckout');
  });

  it('keeps checkout information in the project editor rather than the management list', () => {
    expect(editorSource).toContain('showProjectCheckout');
    expect(editorSource).toContain('performanceCertificateDocumentApplicable');
    expect(editorSource).toContain('finalSettlementReportDocument');
  });
});
