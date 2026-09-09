import {
  CheckCircle2,
  FileText,
  History,
  Loader2,
  RefreshCcw,
  Tags,
  Trash2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { INTEREST_REFUND_POLICY_LABELS } from '../../../data/types';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';
import {
  describeMigrationAuditActionState,
  getMigrationAuditStatusLabel,
  isMigrationAuditPmRegistration,
} from '../../../platform/project-migration-console';
import {
  describeProjectRequestVersion,
  resolveProjectRequestPayload,
  resolveProjectRequestKind,
} from '../../../platform/project-change-request';
import { buildMigrationReviewDossier } from '../../../platform/project-migration-review-dossier';
import { Badge } from '../../ui/badge';
import { Button } from '../../ui/button';
import { Card, CardContent } from '../../ui/card';
import { ContractDocumentPreview } from '../ContractDocumentPreview';
import { FinancialYearsTable } from './FinancialYearsTable';

interface MigrationAuditDetailPanelProps {
  record: MigrationAuditConsoleRecord | null;
  acting: boolean;
  contractDocumentDownloadURL?: string;
  contractDocumentError?: string;
  onApprove: () => void;
  onReject: () => void;
  onDiscard: () => void;
}

type ReviewTone = 'warning' | 'success' | 'danger' | 'neutral';

interface ReviewFact {
  label: string;
  value: string;
  wide?: boolean;
  missing?: boolean;
}

const ATTACHMENT_CHANGE_KEYS = new Set(['contractDocument', 'quoteDocument', 'proposalDocument']);

function isAttachmentChangeKey(key: string) {
  return ATTACHMENT_CHANGE_KEYS.has(key);
}

function statusStripClass(tone: ReviewTone) {
  if (tone === 'success') return 'border-emerald-200 bg-emerald-50/90 text-emerald-900';
  if (tone === 'danger') return 'border-rose-200 bg-rose-50/90 text-rose-900';
  if (tone === 'neutral') return 'border-slate-300 bg-slate-100 text-slate-900';
  return 'border-amber-200 bg-amber-50/90 text-amber-900';
}

function valueClass(value: string, missing = false) {
  return missing || value === '미입력' ? 'text-rose-700' : value === '-' ? 'text-slate-400' : 'text-slate-950';
}

function formatMoney(value?: number) {
  return Number.isFinite(value) ? `${Number(value).toLocaleString('ko-KR')}원` : '-';
}

function ReviewSection({
  eyebrow,
  title,
  description,
  icon,
  children,
}: {
  eyebrow: string;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 border-t border-slate-200 pt-5 first:border-t-0 first:pt-0">
      <div className="flex items-start gap-3">
        {icon ? (
          <div className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-slate-600">
            {icon}
          </div>
        ) : null}
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">{eyebrow}</p>
          <h3 className="mt-1 text-[15px] font-semibold text-slate-950">{title}</h3>
          {description ? <p className="mt-1 text-[12px] leading-6 text-slate-600">{description}</p> : null}
        </div>
      </div>
      {children}
    </section>
  );
}

function ReviewFactGrid({ items }: { items: ReviewFact[] }) {
  return (
    <dl className="grid overflow-hidden rounded-xl border border-slate-200 bg-white md:grid-cols-2">
      {items.map((item) => (
        <div
          key={`${item.label}-${item.value}`}
          className={`min-w-0 border-b border-slate-100 px-4 py-3 last:border-b-0 md:border-r md:last:border-r-0 ${
            item.wide ? 'md:col-span-2' : ''
          }`}
        >
          <dt className="text-[11px] font-medium text-slate-500">{item.label}</dt>
          <dd className={`mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 font-medium ${valueClass(item.value, item.missing)}`}>
            {item.value || '-'}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function AnalysisList({
  title,
  items,
}: {
  title: string;
  items: string[];
}) {
  return (
    <div>
      <p className="text-[11px] font-semibold text-slate-500">{title}</p>
      {items.length > 0 ? (
        <ul className="mt-2 space-y-2 text-[12px] leading-5 text-slate-700">
          {items.map((item) => (
            <li key={item} className="flex gap-2">
              <span className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-[12px] text-slate-500">-</p>
      )}
    </div>
  );
}

function ChangeRow({
  changeKey,
  label,
  before,
  after,
}: {
  changeKey: string;
  label: string;
  before: string;
  after: string;
}) {
  const isAttachmentChange = isAttachmentChangeKey(changeKey);
  return (
    <div
      className="grid gap-3 border-b border-slate-100 px-4 py-3 last:border-b-0 lg:grid-cols-[150px_minmax(0,1fr)_minmax(0,1fr)]"
    >
      <div>
        <p className={`text-[12px] font-semibold ${isAttachmentChange ? 'text-amber-900' : 'text-slate-700'}`}>{label}</p>
        {isAttachmentChange ? <Badge className="mt-2 bg-amber-100 text-amber-900 hover:bg-amber-100">첨부파일 변경</Badge> : null}
      </div>
      <div className="min-w-0 rounded-lg border border-slate-200 bg-white px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-slate-400">이전</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 text-slate-600">{before}</p>
      </div>
      <div className="min-w-0 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-amber-700">수정사항</p>
        <p className="mt-1 whitespace-pre-wrap break-words text-[12px] leading-5 font-semibold text-slate-950">{after}</p>
      </div>
    </div>
  );
}

export function MigrationAuditDetailPanel({
  record,
  acting,
  contractDocumentDownloadURL = '',
  contractDocumentError = '',
  onApprove,
  onReject,
  onDiscard,
}: MigrationAuditDetailPanelProps) {
  if (!record) {
    return (
      <Card className="border-slate-200/80 bg-white shadow-sm" data-testid="migration-review-dossier">
        <CardContent className="py-24 text-center text-[12px] text-muted-foreground">
          좌측 대기열에서 PM 등록 프로젝트 하나를 고르면, 여기서 포털 원문과 계약/재무·팀/인력을 바로 읽고 조직장 결재를 진행할 수 있습니다.
        </CardContent>
      </Card>
    );
  }

  const dossier = buildMigrationReviewDossier(record.project, record.request);
  const actionState = describeMigrationAuditActionState(record);
  const isPmPortalProject = isMigrationAuditPmRegistration(record);
  const isChangeRequest = resolveProjectRequestKind(record.request) === 'CHANGE';
  const requestVersionDescription = describeProjectRequestVersion({
    request: record.request,
    project: record.project,
    fallbackActorName: record.managerName,
    fallbackRequestedAt: record.requestedAt,
  });
  const useRequestPayloadAsCurrent = isChangeRequest && record.request?.status === 'PENDING';
  const requestPayload = resolveProjectRequestPayload(record.request);
  const totalActualCost = requestPayload?.totalActualCost ?? record.project.totalActualCost;
  const financialYears = requestPayload?.financialYears ?? record.project.financialYears;
  const interestRefundPolicy = requestPayload?.interestRefundPolicy ?? record.project.interestRefundPolicy;
  const registrationNote = requestPayload?.note ?? record.project.note;
  const quoteDocument = requestPayload?.quoteDocument !== undefined ? requestPayload.quoteDocument : record.project.quoteDocument;
  const quoteSubmissionDeferred = requestPayload?.quoteSubmissionDeferred ?? record.project.quoteSubmissionDeferred;
  const registrationConfirmations = requestPayload?.registrationConfirmations ?? record.project.registrationConfirmations;
  const contractDocument = useRequestPayloadAsCurrent
    ? (requestPayload?.contractDocument || record.project.contractDocument || null)
    : (record.project.contractDocument || requestPayload?.contractDocument || null);

  return (
    <Card
      className="overflow-hidden border-slate-200/80 bg-white shadow-sm xl:h-[calc(100vh-8rem)]"
      data-testid="migration-review-dossier"
    >
      <CardContent className="flex h-full flex-col p-0">
        <div className="border-b border-slate-200 bg-white px-6 py-5">
          <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
            <div className="min-w-0 space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border border-slate-200 bg-slate-50 text-slate-700">
                  {getMigrationAuditStatusLabel(record.status)}
                </Badge>
                <Badge variant="outline">{record.cic}</Badge>
                <Badge variant="outline">{record.clientOrg || '계약 대상 미지정'}</Badge>
                {isChangeRequest && record.status === 'PENDING' ? (
                  <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-800">수정 중</Badge>
                ) : null}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                  {isChangeRequest ? 'PM 수정 요청' : isPmPortalProject ? 'PM 등록 요청' : '프로젝트 원장'}
                </p>
                <h2 className="mt-1 text-[24px] font-semibold tracking-[-0.02em] text-slate-950">
                  {record.title}
                </h2>
                <p className="mt-2 max-w-3xl text-[12px] leading-6 text-slate-600">
                  {requestVersionDescription}
                </p>
              </div>
            </div>

            <div className={`shrink-0 rounded-xl border px-4 py-3 xl:w-[260px] ${statusStripClass(actionState.tone)}`}>
              <p className="text-[11px] uppercase tracking-[0.08em]">현재 판단</p>
              <p className="mt-1 text-[14px] font-semibold">{actionState.label}</p>
              <p className="mt-1 text-[11px] leading-5">{actionState.helper}</p>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto px-6 py-6">
          {dossier.missingSubmittedFields.length > 0 ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3">
              <p className="text-[12px] font-semibold text-rose-900">작성 누락 항목 {dossier.missingSubmittedFields.length}건</p>
              <p className="mt-1 text-[12px] leading-6 text-rose-800">
                {dossier.missingSubmittedFields.join(' · ')}
              </p>
            </div>
          ) : null}
          <ReviewSection
            eyebrow="기본 정보"
            title="프로젝트 식별 정보"
            description="계약서, 포털 입력값, 담당조직이 같은 프로젝트를 가리키는지 먼저 확인합니다."
            icon={<Tags className="h-4 w-4" />}
          >
            <ReviewFactGrid
              items={[
                { label: '프로젝트명', value: dossier.headerTitle },
                { label: '공식 계약명', value: dossier.identity.officialContractName },
                { label: '계약 대상', value: dossier.identity.clientOrg },
                { label: '담당조직(CIC)', value: dossier.identity.cic },
                { label: 'PM', value: dossier.identity.pmName },
              ]}
            />
          </ReviewSection>

          {dossier.changes.length > 0 ? (
            <ReviewSection
              eyebrow="PM 재제출 시 변경 사항"
              title="이전 | 수정사항"
              description="PM이 다시 제출하면서 바꾼 항목을 이전 값과 나란히 봅니다."
            >
              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
                {dossier.changes.map((change) => (
                  <ChangeRow
                    key={`${change.key}-${change.before}-${change.after}`}
                    changeKey={change.key}
                    label={change.label}
                    before={change.before}
                    after={change.after}
                  />
                ))}
              </div>
            </ReviewSection>
          ) : null}

          <ReviewSection
            eyebrow="계약/재무"
            title="계약 구조와 재무 계획"
            description="계약·정산 기준과 연도별 금액·입금 계획을 한 번에 확인합니다."
          >
            <ReviewFactGrid
              items={[
                { label: '프로젝트 유형', value: dossier.contract.projectTypeLabel },
                { label: '계약 기간', value: dossier.contract.periodLabel },
                { label: '계약서 유형', value: dossier.contract.contractType },
                { label: '정산 유형', value: dossier.contract.settlementTypeLabel },
                { label: '정산 기준', value: dossier.contract.basisLabel },
                { label: '통장 유형', value: dossier.contract.accountTypeLabel },
                { label: '자금 입력 방식', value: dossier.contract.fundInputModeLabel },
                { label: '계약금액', value: dossier.budget.contractAmountLabel },
                { label: '총매출부가세', value: dossier.budget.salesVatAmountLabel },
                { label: '총수익', value: dossier.budget.totalRevenueAmountLabel },
                { label: '총실비(원가)', value: formatMoney(totalActualCost) },
                { label: '총지원금', value: dossier.budget.supportAmountLabel },
                { label: '정산 시스템', value: dossier.contract.settlementSystemLabel },
                { label: '인건비 정산 기준', value: dossier.contract.laborSettlementBasisLabel },
                { label: '이자 반납 여부', value: interestRefundPolicy ? INTEREST_REFUND_POLICY_LABELS[interestRefundPolicy] : '-' },
                { label: '입금 계획', value: dossier.budget.paymentPlanDesc, wide: true },
                { label: '입금 분할', value: dossier.budget.paymentPlanSplitLabel, wide: true },
                { label: '산출내역서(견적서)', value: quoteDocument?.name || (quoteSubmissionDeferred ? '이후 제출 예정' : '-'), wide: true },
                { label: '제안서(구글드라이브 링크)', value: registrationConfirmations?.proposalPptOriginal || '-', wide: true },
                { label: '발표자료(구글드라이브 링크)', value: registrationConfirmations?.presentationPptOriginal || '-', wide: true },
              ]}
            />
            <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
              <p className="text-[11px] font-medium text-slate-500">연도별 계약/재무</p>
              <div className="mt-2">
                <FinancialYearsTable years={financialYears} />
              </div>
            </div>
          </ReviewSection>

          <ReviewSection
            eyebrow="팀/인력"
            title="PM이 등록한 팀과 참여 인력"
            description="팀명과 참여 인력, 역할, 참여율을 함께 확인합니다."
          >
            <div className="rounded-xl border border-slate-200 bg-white">
              <div className="grid gap-4 border-b border-slate-100 px-4 py-3 xl:grid-cols-[180px_minmax(0,1fr)]">
                <div>
                  <p className="text-[11px] font-medium text-slate-500">팀명</p>
                  <p className={`mt-1 text-[13px] font-semibold ${valueClass(dossier.people.teamName)}`}>{dossier.people.teamName}</p>
                </div>
                <div>
                  <p className="text-[11px] font-medium text-slate-500">실제 투입인력</p>
                  <p className="mt-1 text-[13px] font-medium text-slate-900">{dossier.people.staffingSummary}</p>
                  <p className="mt-3 text-[11px] font-medium text-slate-500">서류상 참여인력</p>
                  <p className="mt-1 text-[12px] leading-5 text-slate-700">
                    {dossier.people.members.length > 0 ? `${dossier.people.members.length}명 등록됨 · ` : ''}
                    월별 참여율 원본은 참여율 시트에서 확인해 주세요.
                    {dossier.people.participationSheetLink ? (
                      <>
                        {' '}
                        <a className="break-all text-blue-700 underline" href={dossier.people.participationSheetLink} target="_blank" rel="noreferrer">참여율 시트 열기</a>
                      </>
                    ) : ' (참여율 시트 링크 미등록)'}
                  </p>
                </div>
              </div>
            </div>
          </ReviewSection>

          <ReviewSection
            eyebrow="목적 및 메모"
            title="판단에 필요한 원문 설명"
            description="프로젝트 목적, 상세 설명, 조건, 비고를 함께 읽습니다."
          >
            <ReviewFactGrid
              items={[
                { label: '프로젝트 목적', value: dossier.notes.projectPurpose, wide: true },
                { label: '참여 조건', value: dossier.notes.participantCondition, wide: true },
                { label: '상세 설명', value: dossier.notes.description, wide: true },
                { label: '등록 메모', value: registrationNote || '-', wide: true },
              ]}
            />
          </ReviewSection>

          <ReviewSection
            eyebrow="제출 원문"
            title="등록·수정 작성값 전체"
            description="승인 판단은 아래 요청 문서 원문을 기준으로 합니다. 비어 있는 필드도 누락하지 않고 표시합니다."
          >
            <ReviewFactGrid items={dossier.submittedFields} />
          </ReviewSection>

          <ReviewSection
            eyebrow="계약 분석 보조 정보"
            title="계약서 요약과 PDF 원문"
            description="분석 메모가 부족하면 PDF 원문을 바로 대조합니다."
            icon={<FileText className="h-4 w-4" />}
          >
            <div className="grid gap-4 2xl:grid-cols-[minmax(300px,0.82fr)_minmax(0,1.18fr)]">
              <div className="space-y-5 rounded-xl border border-slate-200 bg-white p-5">
                <div>
                  <p className="text-[11px] font-semibold text-slate-500">계약서 요약</p>
                  <p className="mt-2 whitespace-pre-wrap text-[13px] leading-6 font-medium text-slate-950">{dossier.analysis.summary}</p>
                </div>
                <AnalysisList title="주의 사항" items={dossier.analysis.warnings} />
                <AnalysisList title="다음 행동" items={dossier.analysis.nextActions} />
                <div className="grid gap-3 border-t border-slate-200 pt-4 sm:grid-cols-2">
                  <div>
                    <p className="text-[11px] text-slate-500">파일명</p>
                    <p className="mt-1 break-words text-[13px] font-semibold text-slate-950">{dossier.contractDocument.name}</p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">업로드일</p>
                    <p className="mt-1 text-[13px] font-medium text-slate-900">{dossier.contractDocument.uploadedAt}</p>
                  </div>
                </div>
              </div>
              <ContractDocumentPreview
                document={contractDocument ? {
                  ...contractDocument,
                  downloadURL: contractDocumentDownloadURL || contractDocument.downloadURL,
                } : null}
                title="계약서 PDF 원문"
                description={contractDocumentError || '분석 결과가 부족하면 여기서 원문을 바로 대조합니다.'}
                descriptionClassName={contractDocumentError ? 'text-rose-700' : 'text-slate-600'}
              />
            </div>
          </ReviewSection>

          <ReviewSection
            eyebrow="접수 및 검토 이력"
            title="요청자와 이전 검토 메모"
            description="누가 언제 올렸고, 누가 어떤 판단을 남겼는지 확인합니다."
            icon={<History className="h-4 w-4" />}
          >
            <ReviewFactGrid
              items={[
                { label: '요청 요약', value: dossier.audit.requestSummary, wide: true },
                { label: '요청 버전', value: dossier.audit.requestVersion },
                { label: '요청자', value: dossier.audit.requestedByName },
                { label: '접수일', value: dossier.audit.requestedAt },
                { label: '수정일시', value: dossier.audit.requestUpdatedAt },
              ]}
            />
            {dossier.audit.history.length > 0 ? (
              <div className="mt-3 space-y-2">
                {dossier.audit.history.map((entry, index) => (
                  <div key={`${entry.statusLabel}-${entry.reviewedAt}-${index}`} className="rounded-xl border border-slate-200 bg-slate-50/80 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">{entry.statusLabel}</Badge>
                      <span className="text-[12px] font-medium text-slate-900">{entry.reviewedByName}</span>
                      <span className="text-[11px] text-slate-500">{entry.reviewedAt}</span>
                    </div>
                    <p className="mt-2 whitespace-pre-wrap text-[12px] leading-6 text-slate-700">{entry.reviewComment}</p>
                  </div>
                ))}
              </div>
            ) : null}
          </ReviewSection>
        </div>

        <div
          className="sticky bottom-0 border-t border-slate-200 bg-white/95 px-6 py-4 backdrop-blur"
          data-testid="migration-review-decision-footer"
        >
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">조직장 결재</p>
              <p className="mt-1 text-[12px] text-slate-600">
                상단이나 좌측이 아니라 여기서만 승인, 수정 요청 후 반려, 중복·폐기를 결정합니다.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" className="h-11 gap-1.5" onClick={onApprove} disabled={acting}>
                {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}
                승인
              </Button>
              <Button type="button" variant="outline" className="h-11 gap-1.5" onClick={onReject} disabled={acting}>
                {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
                수정 요청 후 반려
              </Button>
              <Button
                type="button"
                variant="outline"
                className="h-11 gap-1.5 border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800"
                onClick={onDiscard}
                disabled={acting}
              >
                {acting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                중복·폐기
              </Button>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
