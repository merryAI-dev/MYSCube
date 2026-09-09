import { useMemo, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import { CASHFLOW_SHEET_LINE_LABELS, type CashflowSheetLineId } from '../../data/types';
import type { CashflowSheetLabStageResult } from '../../lib/sheets-cashflow-readonly-client';

// 시트값 변경 확인 팝업. 두 경우를 같은 표로 보여준다:
//  - closedMonth: 결산이 끝난 달의 값이 바뀜 → 사유 필수 (변경 이력·경고 횟수에 기록)
//  - pendingApproval: 결재 중인 누적 결산과 값이 다름 → 사유 없이 확인만
// 사유·필터 입력은 이 컴포넌트 안에서만 산다. 부모(CashflowProjectSheet, 3,500줄·보드 1,920셀)에 두면
// 글자 하나에 화면 전체가 다시 그려진다.
export type CashflowSheetChangeDialogKind = 'closedMonth' | 'pendingApproval';

export function CashflowLateSheetChangeDialog({
  kind = 'closedMonth',
  stage,
  resumeRequired = false,
  resumeReason = '',
  submitting,
  onCancel,
  onSubmit,
}: {
  kind?: CashflowSheetChangeDialogKind;
  stage: CashflowSheetLabStageResult | null;
  resumeRequired?: boolean;
  // 이어서 완료할 때는 이전 반영이 남긴 사유를 그대로 쓴다.
  resumeReason?: string;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => void;
}) {
  const needsReason = kind === 'closedMonth';
  const [reason, setReason] = useState('');
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState('ALL');
  const [month, setMonth] = useState('ALL');
  const [week, setWeek] = useState('ALL');

  const differences = (kind === 'pendingApproval' ? stage?.pendingApprovalDifferences : stage?.closedMonthDifferences) || [];
  const manifestHash = kind === 'pendingApproval' ? stage?.pendingApprovalDifferenceManifestHash : stage?.closedMonthDifferenceManifestHash;
  const differenceCount = kind === 'pendingApproval' ? stage?.pendingApprovalDifferenceCount : stage?.closedMonthDifferenceCount;
  const rows = useMemo(() => differences.flatMap((entry) => (
    (entry.changes || []).map((change) => ({ ...change, yearMonth: entry.yearMonth }))
  )), [differences]);
  const complete = Boolean(manifestHash)
    && Number.isSafeInteger(differenceCount)
    && differenceCount === rows.length
    && differences.every((entry) => !entry.truncatedChangeCount);
  const filtered = rows.filter((change) => {
    const label = CASHFLOW_SHEET_LINE_LABELS[change.lineId as CashflowSheetLineId] || change.lineId;
    const needle = query.trim().toLocaleLowerCase('ko-KR');
    return (mode === 'ALL' || change.mode === mode)
      && (month === 'ALL' || change.yearMonth === month)
      && (week === 'ALL' || String(change.weekNo) === week)
      && (!needle || `${change.yearMonth} ${change.weekNo}주차 ${label}`.toLocaleLowerCase('ko-KR').includes(needle));
  });
  const months = [...new Set(rows.map((row) => row.yearMonth))];
  const won = (value: number | null | undefined) => `${Number(value ?? 0).toLocaleString('ko-KR')}원`;

  return (
    <AlertDialog
      open={Boolean(stage)}
      onOpenChange={(open) => { if (!open) onCancel(); }}
    >
      <AlertDialogContent className="sm:max-w-[960px]">
        <AlertDialogHeader>
          <AlertDialogTitle>
            {resumeRequired ? '시트 반영 이어서 완료' : kind === 'pendingApproval' ? '결재 중인 누적 결산과 값이 달라요' : '마감 후 시트값 변경'}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {resumeRequired
              ? '이전 반영의 응답을 확인하지 못했습니다. 같은 검토본으로 안전하게 이어서 완료해 주세요.'
              : kind === 'pendingApproval'
                ? '조직장 결재 중인 누적 결산 자료와 시트 값이 다릅니다. 그대로 반영하면 결재 자료와의 차이가 기록됩니다. 아래 변경 내용을 확인한 뒤 계속 반영할까요?'
                : '이미 결산이 완료된 월의 값이 시트에서 변경되었습니다. 사유를 남기면 변경 이력과 경고 횟수에 함께 기록됩니다. 그래도 반영할까요?'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {stage && !resumeRequired && (
          <div className="min-w-0 space-y-3">
            <div className={`rounded-md border px-3 py-2 text-[12px] ${complete ? 'border-slate-300 bg-slate-50 text-slate-700' : 'border-red-300 bg-red-50 text-red-800'}`} role={complete ? 'status' : 'alert'}>
              {complete ? `검토본과 일치하는 변경 ${rows.length.toLocaleString()}건입니다.` : '변경 목록이 검토본과 일치하지 않아 반영할 수 없습니다. 시트 값을 다시 불러온 뒤 비교해 주세요.'}
            </div>
            <div className="grid gap-2 sm:grid-cols-4">
              <Input aria-label="변경 이력 검색" placeholder="월·주·항목 검색" value={query} onChange={(event) => setQuery(event.target.value)} />
              <select aria-label="Projection Actual 필터" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[12px]" value={mode} onChange={(event) => setMode(event.target.value)}>
                <option value="ALL">전체 구분</option><option value="projection">Projection</option><option value="actual">Actual</option>
              </select>
              <select aria-label="월 필터" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[12px]" value={month} onChange={(event) => setMonth(event.target.value)}>
                <option value="ALL">전체 월</option>{months.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <select aria-label="주차 필터" className="h-9 rounded-md border border-slate-300 bg-white px-2 text-[12px]" value={week} onChange={(event) => setWeek(event.target.value)}>
                <option value="ALL">전체 주차</option>{[1, 2, 3, 4, 5].map((weekNo) => <option key={weekNo} value={weekNo}>{weekNo}주차</option>)}
              </select>
            </div>
            <div className="max-h-[min(60dvh,720px)] overflow-auto rounded-md border border-slate-200 bg-slate-50" role="region" aria-label="마감 후 변경 후보 전체 목록" tabIndex={0}>
              <table className="w-full border-collapse text-[12px] leading-4 text-slate-700">
                <caption className="sr-only">월, 주차, 구분, 항목별 이전값과 변경값</caption>
                <thead className="sticky top-0 bg-slate-100">
                  <tr><th className="px-2 py-2 text-left">월·주차</th><th className="px-2 py-2 text-left">구분</th><th className="px-2 py-2 text-left">항목</th><th className="px-2 py-2 text-right">이전값 → 변경값</th></tr>
                </thead>
                <tbody>
                  {filtered.map((change) => (
                    <tr key={`${change.yearMonth}:${change.mode}:${change.weekNo}:${change.lineId}`} className="border-t border-slate-200">
                      <th className="px-2 py-1.5 text-left">{change.yearMonth} {change.weekNo}주차</th>
                      <td className="px-2 py-1.5">{change.mode === 'projection' ? 'Projection' : 'Actual'}</td>
                      <td className="px-2 py-1.5">{CASHFLOW_SHEET_LINE_LABELS[change.lineId as CashflowSheetLineId] || change.lineId}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">
                        <span className={change.beforeHadValue ? 'text-slate-500' : 'text-slate-400'}>{change.beforeHadValue ? won(change.beforeAmount) : '빈칸'}</span>
                        <span className="px-1 text-slate-400">→</span>
                        <strong>{change.afterHadValue ? won(change.afterAmount) : '빈칸'}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {filtered.length === 0
                ? <p className="p-5 text-center text-[12px] text-slate-500">필터와 일치하는 변경 후보가 없습니다.</p>
                : filtered.length !== rows.length
                  ? <p className="px-3 py-2 text-right text-[12px] text-slate-500">전체 {rows.length.toLocaleString()}건 중 {filtered.length.toLocaleString()}건 표시</p>
                  : null}
            </div>
            {needsReason ? (
              <>
                <label className="block text-[12px] font-semibold text-slate-800" htmlFor="late-sheet-change-reason">변경 사유</label>
                <textarea
                  id="late-sheet-change-reason"
                  value={reason}
                  onChange={(event) => setReason(event.target.value.slice(0, 1000))}
                  placeholder="예: 결산 후 확인된 실제 입금액을 시트 기준으로 정정"
                  className="min-h-[96px] w-full resize-y rounded-md border border-slate-300 bg-white px-3 py-2 text-[13px] leading-5 text-slate-900 outline-none focus:border-[#17324D] focus:ring-2 focus:ring-[#17324D]/10"
                  disabled={submitting}
                />
                <div className="text-right text-[12px] text-slate-400">{reason.length}/1000</div>
              </>
            ) : null}
          </div>
        )}
        <AlertDialogFooter>
          {!resumeRequired && <AlertDialogCancel disabled={submitting}>취소</AlertDialogCancel>}
          <Button
            type="button"
            className="bg-[#17324D] hover:bg-slate-800"
            disabled={submitting || !stage || (!resumeRequired && ((needsReason && !reason.trim()) || !complete))}
            onClick={() => onSubmit((resumeRequired ? resumeReason : needsReason ? reason : '').trim())}
          >
            {submitting ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Save className="mr-1.5 h-3.5 w-3.5" />}
            {resumeRequired ? '같은 작업 이어서 완료' : needsReason ? '사유와 함께 반영' : '확인한 값으로 반영'}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
