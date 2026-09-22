import type { IncidentStatus } from '../../lib/product-operations-client';
import type { OperationKey } from '../../../../shared/product-operations.mjs';

export const operationLabels: Record<OperationKey, string> = {
  'registration.draft.save': '프로젝트 등록 임시저장', 'registration.submit': '프로젝트 등록 최종 제출',
  'project-change.draft.save': '프로젝트 수정 임시저장', 'project-change.submit': '프로젝트 수정 최종 제출',
  'project.executive-review': '조직장 결재 저장',
};
export const statusLabels: Record<IncidentStatus, string> = {
  investigating: '조사 중', confirmed: '원인 확인', fixing: '수정 중', monitoring: '배포 후 관찰', resolved: '해결',
};
export const formatTime = (value: string) => new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
