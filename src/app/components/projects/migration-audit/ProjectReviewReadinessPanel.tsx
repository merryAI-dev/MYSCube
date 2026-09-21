import type { ProjectReviewReadiness } from '../../../lib/platform-bff-client';

export function ProjectReviewReadinessPanel({ readiness }: { readiness?: ProjectReviewReadiness }) {
  if (!readiness?.issues.length) return null;
  return <section aria-label="승인 전 확인사항" className="mb-4 space-y-3 rounded border border-amber-300 bg-amber-50 p-4 text-sm text-slate-800">
    <h3 className="font-semibold">승인 전 확인사항</h3>
    <p className="text-xs">제출 당시 기록을 기준으로 확인한 내용입니다. 자료 열람과 승인 가능 여부는 다릅니다. 아래 항목별 이유와 조치 방법을 확인해 주세요.</p>
    {readiness.issues.map((issue, index) => <div key={`${issue.code}-${issue.field || index}`} className="space-y-1 border-t border-amber-200 pt-2">
      <p className="font-medium">{issue.severity === 'blocking' ? '승인 전 해결 필요' : '검토 참고'} · {issue.title}</p>
      <p className="whitespace-pre-wrap break-words">{issue.detail}</p>
      <p className="whitespace-pre-wrap break-words text-xs"><strong>조치 방법:</strong> {issue.action}</p>
    </div>)}
  </section>;
}
