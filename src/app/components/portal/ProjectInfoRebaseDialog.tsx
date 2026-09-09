import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/dialog';
import { RadioGroup, RadioGroupItem } from '../ui/radio-group';
import type {
  ProjectInfoRebaseConflict,
  ProjectInfoRebaseResolution,
} from '../../lib/project-info-draft-client';

const FIELD_LABELS: Record<string, string> = {
  name: '프로젝트명',
  officialContractName: '공식 계약명',
  clientOrg: '계약 대상',
  department: '담당조직(CIC)',
  type: '프로젝트 유형',
  status: '프로젝트 진행 상태',
  phase: '프로젝트 구분',
  description: '프로젝트 주요 내용',
  projectPurpose: '프로젝트 목적',
  contractType: '계약서 유형',
  contractStart: '계약 시작일',
  contractEnd: '계약 종료일',
  currency: '통화',
  contractAmount: '계약금액',
  salesVatAmount: '총매출부가세',
  totalRevenueAmount: '총수익',
  totalActualCost: '총실비(원가)',
  supportAmount: '총지원금',
  financialYears: '연도별 재무',
  settlementType: '사업유형',
  basis: '정산 기준',
  accountType: '통장 유형',
  interestRefundPolicy: '이자 반납 여부',
  settlementSystem: '정산 시스템',
  laborSettlementBasis: '인건비 정산 기준',
  paymentPlan: '입금 계획',
  paymentExpectedMonths: '입금 예상월',
  advanceInterimBelow70Reason: '선금·중도금 70% 미만 사유',
  paymentPlanDesc: '입금 계획 메모',
  settlementGuide: '정산 안내',
  note: '특이사항',
  managerName: 'PM',
  executiveApproverName: '최종 결재자 (총괄책임자)',
  teamName: '팀',
  teamMembersDetailed: '참여인력',
  participantCondition: '참여 조건',
  businessManagementGoogleFolderLink: '사업관리 구글폴더링크',
  groupwareName: '그룹웨어명',
  contractDocument: '계약서',
  customerBusinessRegistrationDocument: '고객사 사업자등록증',
  quoteDocument: '산출내역서(견적서)',
  quoteSubmissionDeferred: '산출내역서 이후 제출',
  proposalDocument: '제안서',
  proposalWordOriginalDocument: '제안서(워드)',
  proposalPptOriginalDocument: '제안서 원본(PPT)',
  presentationPptOriginalDocument: '발표자료 원본(PPT)',
  rfpRequestEvidenceDocument: 'RFP',
  performanceCertificateDocument: '수행확인서',
  taxInvoiceDocument: '세금계산서',
  finalSettlementReportDocument: '최종 정산보고서',
  teamMembers: '참여인력 요약',
  settlementSystemOther: '기타 정산 시스템 이름',
  finalPaymentNote: '잔금 관련 메모',
  finalPaymentExpectedWeek: '잔금 예상 주차',
  registrationConfirmations: '등록 확인 항목',
  registrationOptionalDocumentNotes: '선택 제출서류 메모',
  registrationRequirementsVersion: '등록 요건 버전',
  checkout: '완료 처리 항목',
  contractAnalysis: '계약서 자동 분석 결과',
  financialInputFlags: '재무 입력 여부',
  settlementSheetPolicy: '정산 시트 정책',
  laborTransferPlan: '인건비 이체 계획',
  fundInputMode: '자금 입력 방식',
  registeredByName: '등록자',
  managerId: 'PM 계정',
  executiveApproverId: '최종 결재자 계정',
};

function fieldLabel(field: string) {
  return FIELD_LABELS[field] || field;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

// The dialog shows what the person sees on the form, never the stored shape.
function displayValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '입력하지 않음';
  if (typeof value === 'boolean') return value ? '예' : '아니오';
  if (typeof value === 'number') return value.toLocaleString('ko-KR');
  if (typeof value === 'string') return value;

  if (Array.isArray(value)) {
    if (value.length === 0) return '없음';
    const people = value
      .map((entry) => {
        if (!isRecord(entry)) return '';
        const name = text(entry.memberName) || text(entry.name);
        if (!name) return '';
        const nickname = text(entry.memberNickname);
        const role = text(entry.role);
        return `${name}${nickname ? `(${nickname})` : ''}${role ? ` · ${role}` : ''}`;
      })
      .filter(Boolean);
    if (people.length === value.length) return people.join(', ');
    const years = value
      .map((entry) => (isRecord(entry) && entry.year ? String(entry.year) : ''))
      .filter(Boolean);
    if (years.length === value.length) return `${years.join(', ')}년`;
    return `${value.length}개 항목`;
  }

  if (isRecord(value)) {
    // Attachments: the file is what the person recognizes, not its storage path.
    const fileName = text(value.name);
    if (fileName && (value.size !== undefined || value.contentType !== undefined)) {
      const size = typeof value.size === 'number' ? ` · ${(value.size / 1024 / 1024).toFixed(1)}MB` : '';
      return `${fileName}${size}`;
    }
    // Amount or month maps such as 선금/중도금/잔금.
    const MONEY_LABELS: Record<string, string> = { contract: '선금', interim: '중도금', final: '잔금' };
    const parts = Object.entries(value)
      .filter(([key]) => key in MONEY_LABELS)
      .map(([key, entry]) => {
        const shown = entry === null || entry === undefined || entry === ''
          ? '미정'
          : typeof entry === 'number' ? `${entry.toLocaleString('ko-KR')}원` : String(entry);
        return `${MONEY_LABELS[key]} ${shown}`;
      });
    if (parts.length > 0) return parts.join(' · ');
    const filled = Object.values(value).filter((entry) => entry !== null && entry !== undefined && entry !== '').length;
    return filled === 0 ? '입력하지 않음' : `${filled}개 항목 입력됨`;
  }
  return String(value);
}

export function ProjectInfoRebaseDialog({
  open,
  conflicts,
  autoMerged,
  busy,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  conflicts: ProjectInfoRebaseConflict[];
  autoMerged: Array<{ field: string; value: unknown }>;
  busy: boolean;
  onConfirm: (resolutions: Record<string, ProjectInfoRebaseResolution>) => void;
  onCancel: () => void;
}) {
  const [resolutions, setResolutions] = useState<Record<string, ProjectInfoRebaseResolution>>({});

  useEffect(() => {
    if (open) setResolutions({});
  }, [open, conflicts]);

  const unresolvedCount = useMemo(
    () => conflicts.filter((conflict) => !resolutions[conflict.field]).length,
    [conflicts, resolutions],
  );

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onCancel(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>수정하는 동안 프로젝트가 변경되었습니다</DialogTitle>
          <DialogDescription>
            {conflicts.length > 0
              ? '아래 항목은 내가 입력한 값과 임시저장된 최근 값이 서로 다릅니다. 어느 값을 남길지 선택해 주세요.'
              : '변경된 내용은 모두 자동으로 반영할 수 있습니다. 확인 후 계속 진행해 주세요.'}
          </DialogDescription>
        </DialogHeader>

        {autoMerged.length > 0 ? (
          <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 text-[12px] text-slate-700">
            <p className="font-medium">자동으로 반영되는 항목 {autoMerged.length}건</p>
            <p className="mt-1 text-[11px] text-slate-500">
              내가 입력하지 않은 항목이라 최근 값을 그대로 가져옵니다.
            </p>
            <ul className="mt-2 grid gap-1">
              {autoMerged.map((entry) => (
                <li key={entry.field}>
                  {fieldLabel(entry.field)} · {displayValue(entry.value)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {conflicts.length > 0 ? (
          <div className="max-h-[46vh] space-y-3 overflow-y-auto">
            {conflicts.map((conflict) => (
              <div key={conflict.field} className="rounded-lg border border-slate-200 px-4 py-3">
                <p className="text-[12px] font-medium text-slate-900">{fieldLabel(conflict.field)}</p>
                {conflict.base === null || conflict.base === undefined ? null : (
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    수정 시작 시점: {displayValue(conflict.base)}
                  </p>
                )}
                <RadioGroup
                  className="mt-2 grid gap-2"
                  value={resolutions[conflict.field] || ''}
                  onValueChange={(value) => setResolutions((previous) => ({
                    ...previous,
                    [conflict.field]: value as ProjectInfoRebaseResolution,
                  }))}
                >
                  <label className="flex items-start gap-2 text-[12px] text-slate-700">
                    <RadioGroupItem value="MINE" className="mt-0.5" />
                    <span>내가 입력한 값 · <strong>{displayValue(conflict.mine)}</strong></span>
                  </label>
                  <label className="flex items-start gap-2 text-[12px] text-slate-700">
                    <RadioGroupItem value="THEIRS" className="mt-0.5" />
                    <span>임시저장된 최근 값 · <strong>{displayValue(conflict.theirs)}</strong></span>
                  </label>
                </RadioGroup>
              </div>
            ))}
          </div>
        ) : null}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>
            취소
          </Button>
          <Button
            type="button"
            onClick={() => onConfirm(resolutions)}
            disabled={busy || unresolvedCount > 0}
          >
            {busy
              ? '반영 중...'
              : unresolvedCount > 0
                ? `${unresolvedCount}건 선택 필요`
                : '선택한 내용으로 계속'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
