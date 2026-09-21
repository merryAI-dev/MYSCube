import type { ProjectRequest } from '../../../data/types';
import { resolveProjectRequestPayload } from '../../../platform/project-change-request';
import { submissionFormatInfo } from '../../../platform/project-submission-display';

export function ProjectSubmissionFormatBadge({ request }: { request: ProjectRequest | null }) {
  const info = request ? submissionFormatInfo(resolveProjectRequestPayload(request)) : {
    label: '제출 문서 확인 필요', detail: '승인을 요청한 문서를 찾을 수 없습니다. 현재 등록된 프로젝트 정보를 보여드립니다.',
  };
  if (info.label === '현재 등록 양식') return null;
  return <span title={info.detail} className="inline-flex rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">{info.label}</span>;
}
