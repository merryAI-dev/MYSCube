import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

function readPortalSource(fileName: string) {
  return readFileSync(resolve(import.meta.dirname, fileName), 'utf8');
}

const submissionsSource = readPortalSource('PortalSubmissionsPage.tsx');
const weeklyExpenseSource = readPortalSource('PortalWeeklyExpensePage.tsx');
const cashflowSource = readPortalSource('PortalCashflowPage.tsx');
const projectEditSource = readPortalSource('PortalProjectEdit.tsx');
const projectRegisterSource = readPortalSource('PortalProjectRegister.tsx');
const projectEditorWizardSource = readFileSync(resolve(import.meta.dirname, '../projects/ProjectEditorWizard.tsx'), 'utf8');

describe('portal minimal sweep', () => {
  it('trims explanatory copy and empty-state coaching from submissions', () => {
    expect(submissionsSource).not.toContain('제출한 항목의 진행 상태(제출/승인/반려)를 한 곳에서 확인합니다.');
    expect(submissionsSource).not.toContain('실제 저장 데이터 기준 자동 반영');
    expect(submissionsSource).not.toContain('필요시만 수동 보정');
    expect(submissionsSource).not.toContain('아직 추적 중인 제출 대상이 없습니다');
    expect(submissionsSource).not.toContain('해당 상태의 인력변경 신청이 없습니다');
  });

  it('removes redundant policy and bottom summary bars from weekly expenses', () => {
    expect(weeklyExpenseSource).not.toContain('현재 정책:');
    expect(weeklyExpenseSource).not.toContain('<span>시트 정책:');
    expect(weeklyExpenseSource).not.toContain('<span>거래:');
    expect(weeklyExpenseSource).not.toContain('<span>기본 폴더:');
  });

  it('removes the weekly expense queue strip and queue-first wizard CTA', () => {
    expect(weeklyExpenseSource).not.toContain('weekly-intake-queue-strip');
    expect(weeklyExpenseSource).not.toContain('통장내역에서 아직 정리되지 않은 거래');
    expect(weeklyExpenseSource).not.toContain('분류/검토 열기');
    expect(weeklyExpenseSource).not.toContain('증빙 이어서 하기');
  });

  it('keeps weekly expenses as a read-only ledger surface', () => {
    expect(weeklyExpenseSource).toContain('ledgerViewOnly');
    expect(weeklyExpenseSource).not.toContain('사업비 입력은 원장 조회 화면입니다.');
    expect(weeklyExpenseSource).not.toContain('입력 정책');
    expect(weeklyExpenseSource).not.toContain('저장 후 actual 반영 상태까지 같은 작업면에서 확인합니다.');
    expect(weeklyExpenseSource).not.toContain('이 화면에서 분류 확인, 행 입력, 저장까지 바로 마무리하세요.');
  });

  it('turns cashflow migration guidance into a compact action instead of a top explainer card', () => {
    expect(cashflowSource).not.toContain('기존 캐시플로 형식 그대로 migration 할 수 있습니다.');
    expect(cashflowSource).not.toContain('권장 형식: 첫 1~2열에 항목명');
  });

  it('drops the redundant current-project subtitle from project edit', () => {
    expect(projectEditSource).not.toContain('현재 프로젝트:');
  });

  it('derives the project status from the contract period instead of letting anyone pick it', () => {
    // 예전에는 PM 이 공유 편집기에서 진행 상태를 직접 골랐다. 손으로 고르게 두니 계약이
    // 끝난 사업이 "진행 중" 으로 남아, 기한에서 따라 나오게 바꿨다.
    expect(projectEditorWizardSource).toContain("mode === 'admin' || mode === 'portal-edit'");
    expect(projectEditorWizardSource).not.toContain("update('status', value as ProjectStatus)");
    expect(projectEditorWizardSource).toContain('deriveProjectStatusFromContractPeriod');
    expect(projectEditorWizardSource).toContain('updateContractPeriod');
  });

  it('removes dash placeholders and review coaching from project register summaries', () => {
    expect(projectRegisterSource).not.toContain('제출 전 최종 확인');
    expect(projectRegisterSource).not.toContain("|| '-'");
    expect(projectRegisterSource).not.toContain("field.value || '-'");
  });

  it('lets rejected pm projects recover from the shared edit screen with contract upload available', () => {
    expect(projectEditSource).toContain('수정 후 다시 제출');
    expect(projectEditSource).toContain('반려 사유');
    expect(projectEditSource).toContain('승인 완료');
    expect(projectEditSource).toContain('검토 대기');
    expect(projectEditSource).not.toContain('다시 제출할 검토 요청 정보를 찾지 못했습니다.');
    expect(projectEditSource).not.toContain("actionId === 'resubmit' && !requestDoc");
    expect(projectEditSource).toContain('draftClient.upload');
    expect(projectEditSource).toContain('onContractFileUpload={async (file) =>');
    expect(projectEditSource).not.toContain('임원 심사 큐');
    expect(projectEditSource).not.toContain('임원 검토 큐');
  });
});
