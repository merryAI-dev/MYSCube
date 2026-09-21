import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';
import type { ProjectReviewReadiness } from '../../../lib/platform-bff-client';
import { projectReviewBadges, type ReviewPreviewStates } from '../../../platform/project-review-badges';

export function ProjectSubmissionFormatBadge({ record, readiness, previewStates, detailed = false }: {
  record: MigrationAuditConsoleRecord;
  readiness?: ProjectReviewReadiness;
  previewStates?: ReviewPreviewStates;
  detailed?: boolean;
}) {
  const badges = projectReviewBadges(record, readiness, previewStates);
  if (!badges.length) return null;
  return <div className="space-y-2" data-testid="project-review-badges">
    <div className="flex flex-wrap gap-1">{badges.map((badge) => <span key={badge.key} title={`${badge.detail}\n${badge.action}`} className="inline-flex rounded border border-slate-300 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">{badge.label}</span>)}</div>
    {detailed ? <details className="text-xs leading-5"><summary className="cursor-pointer font-medium">항목별 이유와 조치 방법 보기</summary><div className="mt-2 space-y-3">{badges.map((badge) => <div key={badge.key}><p className="font-semibold">{badge.label}</p><p>{badge.detail}</p><p>조치 방법: {badge.action}</p></div>)}</div></details> : null}
  </div>;
}
