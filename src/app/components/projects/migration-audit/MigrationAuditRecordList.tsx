import { FileText } from 'lucide-react';
import type { MigrationAuditConsoleRecord } from '../../../platform/project-migration-console';
import { getMigrationAuditStatusLabel } from '../../../platform/project-migration-console';
import { getManagementPlanningReview } from '../../../platform/project-management-planning-review';
import { Card, CardContent } from '../../ui/card';
import { Button } from '../../ui/button';

interface MigrationAuditRecordListProps {
  records: MigrationAuditConsoleRecord[];
  onOpen: (record: MigrationAuditConsoleRecord) => void;
  reviewStage?: 'executive' | 'managementPlanning';
}

function statusClass(status: MigrationAuditConsoleRecord['status']) {
  if (status === 'APPROVED') return 'border-emerald-300 text-emerald-800';
  if (status === 'REVISION_REJECTED') return 'border-rose-300 text-rose-800';
  if (status === 'DUPLICATE_DISCARDED') return 'border-slate-400 text-slate-700';
  return 'border-amber-300 text-amber-800';
}

// Several requests can arrive on the same day, so the reviewer needs the time too.
function formatReceivedAt(value: string) {
  if (!value) return '-';
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value.slice(0, 10).replace(/-/g, '.');
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(at).replace(/\.\s*$/, '');
}

export function MigrationAuditRecordList({ records, onOpen, reviewStage = 'executive' }: MigrationAuditRecordListProps) {
  const isManagementPlanning = reviewStage === 'managementPlanning';
  const statusLabel = (status: MigrationAuditConsoleRecord['status']) => {
    if (!isManagementPlanning) return getMigrationAuditStatusLabel(status);
    if (status === 'APPROVED') return '합의 완료';
    if (status === 'REVISION_REJECTED') return '반려';
    return '합의 대기';
  };

  return (
    <Card className="overflow-hidden border-slate-300 bg-white shadow-sm" data-testid="migration-review-record-list">
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[840px] border-collapse text-left">
            <thead className="border-b border-slate-300 bg-slate-50 text-[11px] font-semibold text-slate-600">
              <tr>
                <th className="px-4 py-3">상태</th>
                <th className="px-4 py-3">담당조직(CIC)</th>
                <th className="px-4 py-3">프로젝트명</th>
                <th className="px-4 py-3">등록자</th>
                <th className="px-4 py-3">접수일시</th>
                {isManagementPlanning ? <th className="px-4 py-3">프로젝트 코드</th> : null}
                <th className="px-4 py-3 text-right">문서</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {records.map((record) => (
                <tr key={record.id} className="hover:bg-slate-50">
                  <td className="px-4 py-3"><span className={`inline-flex border px-2 py-1 text-[11px] font-semibold ${statusClass(record.status)}`}>{statusLabel(record.status)}</span></td>
                  <td className="px-4 py-3 text-[12px] text-slate-700">{record.cic}</td>
                  <td className="max-w-[330px] px-4 py-3">
                    <p className="truncate text-[13px] font-semibold text-slate-950">{record.title}</p>
                    <p className="mt-1 truncate text-[11px] text-slate-500">{record.clientOrg || '계약 대상 미지정'}</p>
                  </td>
                  <td className="px-4 py-3 text-[12px] text-slate-700">{record.managerName || '-'}</td>
                  <td className="px-4 py-3 text-[12px] text-slate-600">{formatReceivedAt(record.requestedAt)}</td>
                  {isManagementPlanning ? <td className="px-4 py-3 text-[12px] font-medium text-slate-700">{getManagementPlanningReview(record.project).projectCode || '부여 대기'}</td> : null}
                  <td className="px-4 py-3 text-right">
                    <Button type="button" variant="outline" size="sm" className="h-8 rounded-none border-slate-400 text-[11px]" onClick={() => onOpen(record)}>
                      <FileText className="mr-1 h-3.5 w-3.5" />문서 열기
                    </Button>
                  </td>
                </tr>
              ))}
              {records.length === 0 ? <tr><td colSpan={isManagementPlanning ? 7 : 6} className="px-4 py-14 text-center text-[12px] text-slate-500">현재 조건에 맞는 검토 문서가 없습니다.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
