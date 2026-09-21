import type { MigrationAuditConsoleRecord } from './project-migration-console';
import type { ProjectReviewReadiness } from '../lib/platform-bff-client';
import type { ProjectRequestDocumentKind } from './project-contract-upload';
import { resolveProjectRequestPayload } from './project-change-request';
import { buildMigrationReviewDocumentSlots, REVIEW_DOCUMENT_DEFINITIONS } from './project-review-document-slots';
import { submissionAnnualFinancialNeeds, submissionFormatInfo } from './project-submission-display';

export type ReviewPreviewStates = Partial<Record<ProjectRequestDocumentKind, { status: 'idle' | 'loading' | 'ready' | 'error'; error?: string }>>;
export type ProjectReviewBadge = { key: string; label: string; detail: string; action: string };
const moneyLabels = { contractAmount: '계약금액', salesVatAmount: '매출 부가세', totalRevenueAmount: '수익', totalActualCost: '실비(원가)', supportAmount: '지원금' };

export function projectReviewBadges(record: MigrationAuditConsoleRecord, readiness?: ProjectReviewReadiness, previewStates?: ReviewPreviewStates): ProjectReviewBadge[] {
  if (!record.request) return [{ key: 'request', label: '제출 문서 연결 없음', detail: '이 프로젝트에 연결된 승인 요청 문서를 찾지 못했습니다. 미제출 여부를 단정할 수 없습니다.', action: '운영 담당자에게 기존 제출 문서의 연결 상태를 확인해 달라고 요청해 주세요.' }];
  const payload = resolveProjectRequestPayload(record.request);
  if (!payload) return [{ key: 'payload', label: '제출 내용 연결 없음', detail: '승인 요청은 있지만 제출 당시의 내용을 찾지 못했습니다. 항목별 미제출 여부를 판단할 수 없습니다.', action: '운영 담당자에게 해당 승인 요청의 제출 내용 확인을 요청해 주세요.' }];
  const badges: ProjectReviewBadge[] = [];
  const format = submissionFormatInfo(payload);
  if (format.label !== '현재 등록 양식') badges.push({ key: 'format', ...format, action: '항목별 안내를 확인해 주세요. 파일 저장 위치나 제출 정보가 승인 기준과 맞지 않으면 수정 또는 재첨부 후 최종 제출이 필요합니다.' });
  const issues = readiness?.issues || [];
  for (const slot of buildMigrationReviewDocumentSlots(record)) {
    const name = slot.label.replace(/ PDF$/, '').replace('(구글드라이브 링크)', ' 링크');
    const field = REVIEW_DOCUMENT_DEFINITIONS.find((definition) => slot.kinds.includes(definition.kind))?.field;
    const issue = issues.find((item) => item.field === field && item.code === 'project_attachment_unavailable');
    const failed = slot.kinds.some((kind) => previewStates?.[kind]?.status === 'error');
    let state = ''; let detail = ''; let action = '';
    if (failed || issue) {
      state = '조회 실패'; detail = issue?.detail || '제출된 파일을 불러오지 못했습니다. 파일 미제출을 뜻하지 않으며 접근 권한이나 일시적인 오류일 수 있습니다.';
      action = issue?.action || '문서를 다시 열어 주세요. 계속 실패하면 운영 담당자에게 파일 확인을 요청하고, 재첨부가 필요하다고 확인된 경우에만 작성자가 다시 첨부해 최종 제출해 주세요.';
    } else if (slot.conflict) {
      state = '제출·해당 없음 중복'; detail = '파일 또는 링크와 해당 없음 선택이 함께 제출되어 있습니다.'; action = '작성자가 파일·링크를 유지할지 해당 없음으로 처리할지 선택한 뒤 최종 제출해 주세요.';
    } else if (slot.submissionState === 'EMPTY' || slot.submissionState === 'UNRECORDED') {
      const attachment = field ? payload?.[field] : undefined;
      const hasMetadata = attachment != null && typeof attachment === 'object';
      const preparing = issues.some((item) => item.code === 'project_attachments_processing' && (!item.field || item.field === field));
      const unchecked = !readiness && record.request.status === 'PENDING' && record.request.requestKind === 'REGISTRATION' && payload.registrationRequirementsVersion === 2 && !record.request.registrationAttachmentsPublishedAt;
      state = preparing ? '첨부 준비 중' : unchecked ? '첨부 상태 미확인' : hasMetadata ? '재첨부 필요' : slot.submissionState === 'EMPTY' ? '미제출' : '제출 기록 없음';
      detail = unchecked && !preparing ? '첨부파일의 연결 완료 여부를 아직 확인하지 않았습니다. 미제출로 판단하지 않습니다.' : preparing ? '제출 파일을 승인 문서에 연결하는 작업이 아직 확인되지 않았습니다. 미제출로 판단하지 않습니다.'
        : hasMetadata ? '첨부 정보는 있지만 파일을 열 수 있는 저장 위치와 다운로드 주소가 모두 없습니다. 파일 자체가 삭제되었다는 뜻은 아닙니다.'
        : slot.submissionState === 'EMPTY' ? '제출 당시 이 항목이 비어 있으며 파일 또는 링크가 연결되어 있지 않습니다.'
        : '이전 제출본에 이 항목의 기록이 없습니다. 실제 미제출인지 이전 양식에서 기록되지 않은 것인지 확인이 필요합니다.';
      action = unchecked && !preparing ? '문서를 열어 서버의 첨부 확인 결과를 확인해 주세요.' : preparing ? '잠시 후 문서를 다시 열어 주세요. 계속되면 운영 담당자에게 첨부 준비 상태 확인을 요청해 주세요.'
        : hasMetadata ? '작성자가 기존 원본 파일을 찾아 해당 항목에 다시 첨부한 뒤 최종 제출해 주세요.'
        : slot.submissionState === 'EMPTY' ? `작성자가 ${name}을 제출${slot.noteField ? '하거나 해당 없음·미제출 사유를 입력' : slot.kinds.includes('quote') ? '하거나 이후 제출을 선택' : ''}한 뒤 최종 제출해 주세요.`
        : '작성자 또는 운영 담당자와 기존 제출 자료를 대조해 주세요. 보완이 필요한 것으로 확인되면 해당 자료를 첨부해 최종 제출해 주세요.';
    }
    if (state) badges.push({ key: `document:${slot.number}`, label: `${name} ${state}`, detail, action });
  }
  for (const need of submissionAnnualFinancialNeeds(payload.financialYears, payload)) {
    const row = payload.financialYears?.find((item) => item.year === need.year);
    for (const field of need.fields) {
      const value = row?.[field];
      const missing = value == null || (value === 0 && row?.inputFlags?.[field] === false);
      badges.push({ key: `financial:${need.year}:${field}`, label: `${need.year}년 ${moneyLabels[field]} ${missing ? '미입력' : '입력 기록 확인'}`, detail: need.message, action: '작성자가 프로젝트 수정의 계약/재무에서 해당 연도 금액을 확인한 뒤 최종 제출해 주세요. 금액이 없으면 0원을 직접 입력해 주세요.' });
    }
  }
  return badges;
}
