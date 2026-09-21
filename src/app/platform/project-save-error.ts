import { PlatformApiError } from './api-client';

export function resolveProjectSaveErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof PlatformApiError)) return error instanceof Error ? error.message : fallback;
  if (error.code === 'draft_version_conflict') {
    return '서버의 임시저장 내용이 변경되었습니다. 현재 입력은 보관됩니다. 다시 열어 보관된 입력과 확인해 주세요.';
  }
  if (error.status >= 500) return `${fallback} 저장 결과를 다시 확인한 뒤 재시도해 주세요.`;
  if (error.code === 'project_submission_incomplete') {
    const details = error.body as { details?: { requiredFields?: Array<{ message?: string }> } } | undefined;
    const issues = details?.details?.requiredFields?.map(item => item.message).filter(Boolean);
    if (issues?.length) return issues.join(' / ');
  }
  const body = error.body as { details?: { issues?: Array<{ message?: string }> } } | undefined;
  const messages = body?.details?.issues?.map((issue) => issue.message).filter(Boolean);
  if (messages?.length) return messages.join(' / ');
  return error.serverMessage || error.message || fallback;
}
