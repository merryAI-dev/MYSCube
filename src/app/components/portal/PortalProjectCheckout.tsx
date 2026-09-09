import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { CheckCircle2, FileText, AlertTriangle } from 'lucide-react';
import { Checkbox } from '../ui/checkbox';
import { usePortalStore } from '../../data/portal-store';
import type { Project, ProjectCheckout, ProjectClosureSubmission, ProjectRequest } from '../../data/types';
import { useAuth } from '../../data/auth-store';
import { useFirebase } from '../../lib/firebase-context';
import { fetchLatestProjectRequestViaBff, submitProjectClosureViaBff } from '../../lib/platform-bff-client';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Textarea } from '../ui/textarea';
import { toast } from 'sonner';
import { ProjectClosureDriveContents } from '../projects/ProjectClosureDriveContents';

/**
 * 종료사업 체크아웃.
 *
 * 체크 항목과 증빙은 예전부터 프로젝트에 저장돼 왔지만 그것을 한자리에서 확인하는 화면이
 * 없었다. 등록 편집기 안에 묻혀 있었고 그나마 상태가 완료일 때만 열렸다. 사업을 끝낼 때
 * "무엇이 남았는지" 를 묻는 자리를 여기 하나로 둔다.
 */

type CheckField = keyof Pick<
  ProjectCheckout,
  'finalPaymentReceived' | 'bankBalanceZero' | 'performanceCertificateReceived'
  | 'usbEvidenceSubmitted' | 'evidenceDeletedAfterUsb'
>;
type CheckItem = { field: CheckField; label: string; done: boolean; note?: string };
type UploadItem = { kind: string; label: string; attached: boolean; note?: string };

function readChecklist(project: Project): CheckItem[] {
  const checkout = project.checkout;
  return [
    { field: 'finalPaymentReceived', label: '잔금까지 입금되었음을 확인했습니다.', done: checkout?.finalPaymentReceived === true },
    { field: 'bankBalanceZero', label: '사용한 사업비 전용 통장 잔액을 0원으로 정리했습니다.', done: checkout?.bankBalanceZero === true },
    {
      field: 'performanceCertificateReceived',
      label: '용역실적증명서 원본 제출을 완료했습니다.',
      done: checkout?.performanceCertificateReceived === true,
      note: '원본 수령 시 최소 5부. 온라인 발급 사업은 별도 하드카피 제출 없이 아래에 파일을 업로드합니다.',
    },
  ];
}

function readUploads(project: Project): UploadItem[] {
  const checkout = project.checkout;
  return [
    {
      kind: 'final_report',
      label: '최종 결과보고서 (원본)',
      attached: Boolean(project.finalReportDocument?.path),
      note: '종료사업은 결과보고서 원본을 제출합니다.',
    },
    {
      kind: 'tax_invoice',
      label: '사업 관련 발행 세금계산서 PDF',
      attached: Boolean(project.taxInvoiceDocument?.path),
      note: checkout?.taxInvoiceEvidenceConfirmed ? '해당 사업으로 표시됨' : '해당 시에만 제출합니다.',
    },
    {
      kind: 'performance_certificate',
      label: '고객사 용역수행실적증명서 PDF',
      attached: Boolean(project.performanceCertificateDocument?.path),
      note: checkout?.performanceCertificateDocumentApplicable ? '해당 사업으로 표시됨' : '해당 시에만 제출합니다.',
    },
    {
      kind: 'final_settlement_report',
      label: '회계사 최종 정산리포트',
      attached: Boolean(project.finalSettlementReportDocument?.path),
      note: checkout?.finalSettlementReportConfirmed ? '해당 사업으로 표시됨' : '회계사 정산 사업만 해당합니다.',
    },
  ];
}

export function PortalProjectCheckout() {
  const { user } = useAuth();
  const { orgId } = useFirebase();
  const { activeProjectId, projects, updateProjectCheckout, uploadProjectCheckoutDocument } = usePortalStore();
  const project = useMemo(
    () => projects.find((candidate) => candidate.id === activeProjectId) || null,
    [activeProjectId, projects],
  );

  const checklist = useMemo(() => (project ? readChecklist(project) : []), [project]);
  const uploads = useMemo(() => (project ? readUploads(project) : []), [project]);
  const [closureRequest, setClosureRequest] = useState<ProjectRequest | null>(null);
  const [requestLoading, setRequestLoading] = useState(true);
  const [requestError, setRequestError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [saving, setSaving] = useState(0);
  const contextKey = `${orgId}:${user?.uid}:${project?.id}`;
  const activeContext = useRef(contextKey);
  activeContext.current = contextKey;
  const [details, setDetails] = useState<ProjectClosureSubmission>({ retentionStartDate: '', retentionPeriodYears: 5,
    driveFolderLink: '', handoverNote: '', driveDeletedAt: '', note: '' });
  useEffect(() => {
    let disposed = false;
    setClosureRequest(null);
    setRequestLoading(true);
    setRequestError('');
    setDetails({ retentionStartDate: '', retentionPeriodYears: 5, driveFolderLink: project?.businessManagementGoogleFolderLink || '', handoverNote: '', driveDeletedAt: '', note: '' });
    if (!project || !user) { setRequestLoading(false); return; }
    void fetchLatestProjectRequestViaBff({ tenantId: orgId, actor: user, projectId: project.id, requestKind: 'CLOSURE' })
      .then((item) => {
        if (disposed) return;
        if (item?.requestKind === 'CLOSURE') {
          setClosureRequest(item);
          if (item.closureSubmission) setDetails(item.closureSubmission);
        }
      }).catch(() => { if (!disposed) setRequestError('종료 요청 상태를 확인하지 못했습니다. 새로고침 후 다시 확인해 주세요.'); })
      .finally(() => { if (!disposed) setRequestLoading(false); });
    return () => { disposed = true; };
  }, [project?.id, project?.closureRequestId, orgId, user?.uid]);
  const locked = requestLoading || submitting || saving > 0 || Boolean(project?.closure) || closureRequest?.status === 'PENDING';
  async function saveEvidence(save: () => Promise<boolean>) {
    setSaving((count) => count + 1);
    try { await save(); }
    catch { toast.error('저장하지 못했습니다. 다시 확인해 주세요.'); }
    finally { setSaving((count) => count - 1); }
  }
  async function submitClosure() {
    if (!project || !user || locked || requestError) return;
    setSubmitting(true);
    try {
      const result = await submitProjectClosureViaBff({ tenantId: orgId, actor: user, projectId: project.id,
        expectedProjectVersion: project.version || 0, submission: details });
      if (activeContext.current !== contextKey) return;
      setClosureRequest(result);
      toast.success('조직장에게 사업 종료 승인을 요청했습니다.');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '종료 신청에 실패했습니다. 최신 상태를 확인해 주세요.');
    } finally { setSubmitting(false); }
  }

  if (!project) {
    return (
      <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-8 text-center text-[13px] text-slate-500">
        먼저 사업을 선택해 주세요.
      </div>
    );
  }

  const settlementClosed = project.checkout?.usbEvidenceSubmitted === true;
  const evidenceDeleted = project.checkout?.evidenceDeletedAfterUsb === true;
  const remaining = checklist.filter((item) => !item.done).length
    + uploads.filter((item) => !item.attached).length;

  return (
    <div className="space-y-6">
      <header className="space-y-1">
        <h1 className="text-[20px] font-semibold text-slate-900">종료사업 체크아웃</h1>
        <p className="text-[13px] text-slate-600">
          사업이 마무리된 뒤 최종 마무리 액션을 취했는지, 받아야 할 서류는 받았는지 확인합니다.
        </p>
        <p className="text-[13px] text-slate-500">{project.name}</p>
      </header>

      {remaining > 0 ? (
        <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-[13px] text-amber-800">
          <AlertTriangle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>아직 확인되지 않은 항목이 {remaining}개 있습니다.</span>
        </p>
      ) : (
        <p className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-[13px] text-emerald-800">
          <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          <span>체크아웃 항목이 모두 확인되었습니다.</span>
        </p>
      )}

      <section className="space-y-3">
        <h2 className="border-b border-slate-200 pb-2 text-[12px] font-semibold text-slate-700">체크리스트</h2>
        <ul className="space-y-2">
          {checklist.map((item) => (
            <li key={item.field} className="text-[13px]">
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  disabled={locked}
                  className="mt-0.5"
                  checked={item.done}
                  onCheckedChange={(checked) => {
                    void saveEvidence(() => updateProjectCheckout(project.id, { [item.field]: checked === true }));
                  }}
                />
                <span className="min-w-0">
                  <span className={item.done ? 'text-slate-900' : 'text-slate-600'}>{item.label}</span>
                  {item.note ? <span className="mt-0.5 block text-[12px] text-slate-500">{item.note}</span> : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="border-b border-slate-200 pb-2 text-[12px] font-semibold text-slate-700">업로드</h2>
        <p className="text-[12px] text-slate-500">제출 자료는 향후 인수인계 및 제안서 작성 시 유사 실적 증빙으로 활용됩니다.</p>
        <ul className="space-y-2">
          {uploads.map((item) => (
            <li key={item.kind} className="flex items-start gap-2 text-[13px]">
              <FileText aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${item.attached ? 'text-[#047857]' : 'text-slate-300'}`} />
              <span className="min-w-0 flex-1">
                <span className={item.attached ? 'text-slate-900' : 'text-slate-600'}>{item.label}</span>
                <span className="ml-2 text-[12px] text-slate-500">{item.attached ? '첨부됨' : '미첨부'}</span>
                {item.note ? <span className="mt-0.5 block text-[12px] text-slate-500">{item.note}</span> : null}
                <label className="mt-1 inline-flex cursor-pointer items-center gap-1 text-[12px] text-[#0176D3] underline underline-offset-2">
                  {item.attached ? '자료 교체' : '자료 올리기'}
                  <input
                    type="file"
                    disabled={locked}
                    accept="application/pdf,.pdf"
                    className="hidden"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = '';
                      if (file) void saveEvidence(() => uploadProjectCheckoutDocument(project.id, item.kind, file));
                    }}
                  />
                </label>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="border-b border-slate-200 pb-2 text-[12px] font-semibold text-slate-700">정산사업 마감</h2>
        <ul className="space-y-2 text-[13px]">
          {([
            ['usbEvidenceSubmitted', '사업비 시트 및 정산자료를 USB에 저장하여 재경팀에 제출했습니다.', settlementClosed],
            ['evidenceDeletedAfterUsb', 'Google Drive에서 정산자료를 삭제했습니다. 사업비 시트는 유지합니다.', evidenceDeleted],
          ] as Array<[CheckField, string, boolean]>).map(([field, label, done]) => (
            <li key={field}>
              <label className="flex cursor-pointer items-start gap-2">
                <Checkbox
                  disabled={locked}
                  className="mt-0.5"
                  checked={done}
                  onCheckedChange={(checked) => {
                    void saveEvidence(() => updateProjectCheckout(project.id, { [field]: checked === true }));
                  }}
                />
                <span className={done ? 'text-slate-900' : 'text-slate-600'}>{label}</span>
              </label>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3" aria-label="사업 종료 승인 요청">
        <h2 className="border-b border-slate-200 pb-2 text-[12px] font-semibold text-slate-700">사업 종료 승인 요청</h2>
        <p className="text-[13px] text-slate-600">조직장이 승인·합의하면 계약 종료일과 관계없이 주정산·월결산 대상에서 즉시 제외됩니다. 과거 자료는 유지됩니다.</p>
        {project.closure ? <p role="status">종료 승인 완료 · {project.closure.approvedAt.slice(0, 10)}</p>
          : closureRequest?.status === 'PENDING' ? <p role="status">조직장 종료 승인 대기</p>
          : closureRequest?.status === 'REJECTED' ? <p role="status">보완 요청: {closureRequest.reviewComment}</p> : null}
        {requestError ? <p role="alert" className="text-red-700">{requestError}</p> : null}
        <fieldset disabled={locked || Boolean(requestError)} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm">보관 기산일<Input aria-required type="date" value={details.retentionStartDate} onChange={(e) => setDetails({ ...details, retentionStartDate: e.target.value })} /></label>
          <label className="text-sm">보관 기간(년)<Input aria-required type="number" min={1} max={100} value={details.retentionPeriodYears} onChange={(e) => setDetails({ ...details, retentionPeriodYears: Number(e.target.value) })} /></label>
          <label className="text-sm sm:col-span-2">정산자료 Google Drive 링크<Input type="url" value={details.driveFolderLink} onChange={(e) => setDetails({ ...details, driveFolderLink: e.target.value })} /></label>
          <label className="text-sm">재경팀 인계·보관 위치<Textarea value={details.handoverNote} onChange={(e) => setDetails({ ...details, handoverNote: e.target.value })} /></label>
          <label className="text-sm">드라이브 정리일(사람이 처리한 경우)<Input type="date" value={details.driveDeletedAt} onChange={(e) => setDetails({ ...details, driveDeletedAt: e.target.value })} /></label>
          <label className="text-sm sm:col-span-2">기타 메모<Textarea value={details.note} onChange={(e) => setDetails({ ...details, note: e.target.value })} /></label>
        </fieldset>
        <ProjectClosureDriveContents projectId={project.id} link={details.driveFolderLink} />
        <p className="text-xs text-slate-500">보관 기산일은 재경팀 인계 확인 기준으로 입력해 주세요. 파일 삭제는 사람이 수행하며 시스템은 삭제하지 않습니다.</p>
        <Button onClick={() => void submitClosure()} disabled={locked || Boolean(requestError) || !details.retentionStartDate}>
          {submitting ? '신청 중…' : closureRequest?.status === 'REJECTED' ? '보완 후 종료 재신청' : '종료 승인 요청'}
        </Button>
      </section>

      <p className="text-[13px] text-slate-600">
        체크와 증빙은 바로 저장됩니다. 종료 승인 요청은 기존 프로젝트 검토함의 ‘사업 종료’ 유형으로 접수되며 등록 결재는 변경하지 않습니다. 사업 내용을 고치려면{' '}
        <Link className="font-medium text-[#0176D3] underline underline-offset-2" to={`/portal/edit-project/${project.id}`}>
          프로젝트 수정
        </Link>
        {' '}화면에서 입력합니다.
      </p>
    </div>
  );
}
