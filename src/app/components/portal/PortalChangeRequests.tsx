import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  ArrowRightLeft, Plus, Send, Clock, CheckCircle2,
  XCircle, FileText, Users, UserPlus, UserMinus,
  Percent, ArrowUpDown, Calendar, Eye, AlertTriangle,
  Megaphone, Bell, ChevronRight, X, Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import { Separator } from '../ui/separator';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { PageHeader } from '../layout/PageHeader';
import { usePortalStore } from '../../data/portal-store';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '../ui/alert-dialog';
import {
  useHrAnnouncements,
  HR_EVENT_LABELS, HR_EVENT_COLORS,
  type ProjectChangeAlert,
} from '../../data/hr-announcements-store';
import {
  STATE_LABELS,
  type ChangeRequest, type ChangeRequestState, type StaffChangeItem,
} from '../../data/personnel-change-data';

const stateStyles: Record<ChangeRequestState, string> = {
  DRAFT: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
  SUBMITTED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400',
  APPROVED: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400',
  REJECTED: 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-400',
  REVISION_REQUESTED: 'bg-orange-100 text-orange-700 dark:bg-orange-900/50 dark:text-orange-400',
};

const stateIcons: Record<ChangeRequestState, typeof Clock> = {
  DRAFT: FileText,
  SUBMITTED: Clock,
  APPROVED: CheckCircle2,
  REJECTED: XCircle,
  REVISION_REQUESTED: AlertTriangle,
};

const changeTypeLabels: Record<string, string> = {
  ADD: '신규 투입',
  REMOVE: '투입 해제',
  RATE_CHANGE: '투입율 변경',
  GRADE_CHANGE: '등급 변경',
  MONTHS_CHANGE: '투입기간 변경',
  REPLACEMENT: '대체 투입',
};

const changeTypeColors: Record<string, string> = {
  ADD: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400',
  REMOVE: 'bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-400',
  RATE_CHANGE: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400',
  GRADE_CHANGE: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-400',
  MONTHS_CHANGE: 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-400',
  REPLACEMENT: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/50 dark:text-cyan-400',
};

const DISMISSED_ALERT_STORAGE_PREFIX = 'mysc-dismissed-hr-alerts';

function getDismissedAlertStorageKey(projectId: string): string {
  return `${DISMISSED_ALERT_STORAGE_PREFIX}:${projectId}`;
}

// HR 이벤트 → 인력변경 유형 매핑
const HR_EVENT_TO_CHANGE_TYPE: Record<string, StaffChangeItem['changeType']> = {
  RESIGNATION: 'REMOVE',
  LEAVE: 'REMOVE',
  TRANSFER: 'REMOVE',
  ROLE_CHANGE: 'GRADE_CHANGE',
  RETURN: 'ADD',
};

export function PortalChangeRequests() {
  const navigate = useNavigate();
  const { isLoading, portalUser, myProject, changeRequests, addChangeRequest, submitChangeRequest } = usePortalStore();
  const {
    getProjectAlerts, acknowledgeAlert, markAlertResolved,
    announcements,
  } = useHrAnnouncements();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedReq, setSelectedReq] = useState<ChangeRequest | null>(null);
  const [submitConfirm, setSubmitConfirm] = useState<string | null>(null);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());

  const [form, setForm] = useState({
    title: '',
    reason: '',
    staffName: '',
    changeType: 'ADD' as StaffChangeItem['changeType'],
    rateBefore: 0,
    rateAfter: 0,
  });

  if (isLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-5 h-5 mx-auto animate-spin text-muted-foreground" />
          <p className="mt-2 text-[12px] text-muted-foreground">인력변경 데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (!portalUser || !myProject) {
    return (
      <div className="text-center py-16">
        <AlertTriangle className="w-10 h-10 mx-auto text-muted-foreground/30 mb-3" />
        <p className="text-[14px] text-muted-foreground">사업이 선택되지 않았습니다.</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate('/portal/project-select')}>
          사업 선택하기
        </Button>
      </div>
    );
  }

  // ── 내 사업의 HR 알림 ──
  const myAlerts = getProjectAlerts(myProject.id);
  const unacknowledgedAlerts = myAlerts.filter(a => !a.acknowledged && !dismissedAlerts.has(a.id));
  const pendingAlerts = myAlerts.filter(a => !a.changeRequestCreated);

  const myRequests = changeRequests.filter(r => r.projectId === myProject.id);
  const submitReq = submitConfirm ? myRequests.find((r) => r.id === submitConfirm) || null : null;

  const kpi = {
    total: myRequests.length,
    draft: myRequests.filter(r => r.state === 'DRAFT').length,
    submitted: myRequests.filter(r => r.state === 'SUBMITTED').length,
    approved: myRequests.filter(r => r.state === 'APPROVED').length,
    rejected: myRequests.filter(r => r.state === 'REJECTED' || r.state === 'REVISION_REQUESTED').length,
  };

  useEffect(() => {
    const storageKey = getDismissedAlertStorageKey(myProject.id);
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) {
        setDismissedAlerts(new Set());
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        setDismissedAlerts(new Set());
        return;
      }
      const ids = parsed.filter((item): item is string => typeof item === 'string');
      setDismissedAlerts(new Set(ids));
    } catch {
      setDismissedAlerts(new Set());
    }
  }, [myProject.id]);

  useEffect(() => {
    const storageKey = getDismissedAlertStorageKey(myProject.id);
    try {
      localStorage.setItem(storageKey, JSON.stringify(Array.from(dismissedAlerts)));
    } catch {
      // ignore localStorage failures (private mode / quota)
    }
  }, [dismissedAlerts, myProject.id]);

  useEffect(() => {
    if (dismissedAlerts.size === 0) return;
    const validIds = new Set(myAlerts.map((alert) => alert.id));
    setDismissedAlerts((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((id) => {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [dismissedAlerts.size, myAlerts]);

  // ── HR 알림에서 인력변경 시작 ──
  const handleStartChangeFromAlert = (alert: ProjectChangeAlert) => {
    const ann = announcements.find(a => a.id === alert.announcementId);
    const eventLabel = HR_EVENT_LABELS[alert.eventType] || alert.eventType;
    const changeType = HR_EVENT_TO_CHANGE_TYPE[alert.eventType] || 'REMOVE';

    const newReq: ChangeRequest = {
      id: `cr-hr-${Date.now()}`,
      projectId: myProject.id,
      projectName: myProject.name,
      projectShortName: myProject.name.slice(0, 20),
      title: `${alert.employeeName} ${eventLabel} 대응 인력변경`,
      description: ann?.description || `${alert.employeeName} ${eventLabel}(${alert.effectiveDate})에 따른 인력변경`,
      state: 'DRAFT',
      priority: 'HIGH',
      requestedBy: portalUser.name,
      requestedAt: new Date().toISOString(),
      effectiveDate: alert.effectiveDate,
      changes: [{
        staffName: alert.employeeName,
        changeType,
        description: `${alert.employeeName} ${eventLabel} (${alert.effectiveDate})`,
        before: { rate: 0 },
        after: { rate: 0 },
        requiredDocs: ['CHANGE_REQUEST_FORM'],
      }],
      documents: [],
      timeline: [
        {
          id: `tl-${Date.now()}-1`,
          action: `인사공지 연동 — ${alert.employeeName} ${eventLabel}`,
          actor: '시스템',
          timestamp: alert.createdAt,
          type: 'COMMENT',
          comment: ann?.description,
        },
        {
          id: `tl-${Date.now()}-2`,
          action: '인력변경 요청 생성 (인사공지 기반)',
          actor: portalUser.name,
          timestamp: new Date().toISOString(),
          type: 'CREATE',
        },
      ],
      costImpact: { beforeTotal: 0, afterTotal: 0, difference: 0 },
    };

    addChangeRequest(newReq);
    markAlertResolved(alert.id);
    setSelectedReq(newReq);
  };

  // ── 일반 신청 생성 ──
  const handleCreate = () => {
    if (!form.title || !form.staffName) return;

    const newReq: ChangeRequest = {
      id: `cr-${Date.now()}`,
      projectId: myProject.id,
      projectName: myProject.name,
      projectShortName: myProject.name.slice(0, 20),
      title: form.title,
      description: form.reason,
      state: 'DRAFT',
      priority: 'MEDIUM',
      requestedBy: portalUser.name,
      requestedAt: new Date().toISOString(),
      effectiveDate: new Date().toISOString().slice(0, 10),
      changes: [{
        staffName: form.staffName,
        changeType: form.changeType,
        description: form.reason,
        before: { rate: form.rateBefore },
        after: { rate: form.rateAfter },
        requiredDocs: ['CHANGE_REQUEST_FORM'],
      }],
      documents: [],
      timeline: [{
        id: `tl-${Date.now()}`,
        action: '요청서 작성',
        actor: portalUser.name,
        timestamp: new Date().toISOString(),
        type: 'CREATE',
      }],
      costImpact: { beforeTotal: 0, afterTotal: 0, difference: 0 },
    };

    addChangeRequest(newReq);
    setShowCreate(false);
    setForm({ title: '', reason: '', staffName: '', changeType: 'ADD', rateBefore: 0, rateAfter: 0 });
  };

  // D-day 계산
  const daysUntil = (dateStr: string) => {
    const diff = Math.ceil((new Date(dateStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
    if (diff < 0) return `${Math.abs(diff)}일 경과`;
    if (diff === 0) return '오늘';
    return `D-${diff}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={ArrowRightLeft}
        iconGradient="linear-gradient(135deg, #0f766e 0%, #0891b2 100%)"
        title="인력변경 신청"
        description="인력 투입/해제/변경을 신청하고 관리자 승인을 받습니다"
        badge={`${kpi.total}건`}
        headingVisible={false}
        actions={
          <Button size="sm" className="h-8 text-[12px] gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus className="w-3.5 h-3.5" /> 새 변경 신청
          </Button>
        }
      />

      {/* HR 알림 배너 */}
      {unacknowledgedAlerts.length > 0 && (
        <div className="space-y-2">
          {unacknowledgedAlerts.map(alert => {
            const ann = announcements.find(a => a.id === alert.announcementId);
            const isUrgent = new Date(alert.effectiveDate).getTime() - Date.now() < 30 * 24 * 60 * 60 * 1000; // 30일 이내
            return (
              <Card
                key={alert.id}
                className={`overflow-hidden border-l-4 ${
                  isUrgent
                    ? 'border-l-rose-500 bg-rose-50/50 dark:bg-rose-950/20'
                    : 'border-l-amber-500 bg-amber-50/50 dark:bg-amber-950/20'
                }`}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-3">
                    {/* 아이콘 */}
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${
                      isUrgent ? 'bg-rose-100 dark:bg-rose-900/40' : 'bg-amber-100 dark:bg-amber-900/40'
                    }`}>
                      <Megaphone className={`w-4 h-4 ${isUrgent ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400'}`} />
                    </div>

                    {/* 내용 */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                        <span className="text-[12px]" style={{ fontWeight: 700 }}>
                          {alert.employeeName} {HR_EVENT_LABELS[alert.eventType]}
                        </span>
                        <Badge className={`text-[9px] h-4 px-1.5 ${HR_EVENT_COLORS[alert.eventType]}`}>
                          {HR_EVENT_LABELS[alert.eventType]}
                        </Badge>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          isUrgent ? 'bg-rose-200/60 text-rose-700 dark:bg-rose-800/40 dark:text-rose-300' : 'bg-amber-200/60 text-amber-700 dark:bg-amber-800/40 dark:text-amber-300'
                        }`} style={{ fontWeight: 600 }}>
                          {daysUntil(alert.effectiveDate)}
                        </span>
                      </div>

                      <p className="text-[11px] text-muted-foreground">
                        적용일 <strong>{alert.effectiveDate}</strong>
                        {ann?.description && <> · {ann.description}</>}
                      </p>

                      {/* 액션 버튼 */}
                      <div className="flex items-center gap-2 mt-2">
                        <Button
                          size="sm"
                          className="h-7 text-[11px] gap-1"
                          onClick={() => handleStartChangeFromAlert(alert)}
                        >
                          <ArrowRightLeft className="w-3 h-3" /> 인력변경 시작
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-[11px] gap-1"
                          onClick={() => {
                            acknowledgeAlert(alert.id);
                            setDismissedAlerts(prev => new Set([...prev, alert.id]));
                          }}
                        >
                          <Eye className="w-3 h-3" /> 확인
                        </Button>
                      </div>
                    </div>

                    {/* 닫기 (세션 내 dismiss) */}
                    <button
                      aria-label="알림 닫기"
                      className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/5 text-muted-foreground shrink-0"
                      onClick={() => setDismissedAlerts(prev => new Set([...prev, alert.id]))}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* 확인 완료 + 미처리 알림 요약 배지 (배너 dismiss 후에도 보임) */}
      {pendingAlerts.length > 0 && unacknowledgedAlerts.length === 0 && (
        <Card className="border-l-4 border-l-teal-500 bg-teal-50/30 dark:bg-teal-950/10">
          <CardContent className="p-2.5 flex items-center gap-2 text-[11px]">
            <Bell className="w-3.5 h-3.5 text-teal-600 dark:text-teal-400 shrink-0" />
            <span className="text-muted-foreground">
              인사 공지 관련 미처리 인력변경이 <strong className="text-teal-700 dark:text-teal-300">{pendingAlerts.length}건</strong> 남아 있습니다.
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 text-[10px] ml-auto text-teal-700 dark:text-teal-300"
              onClick={() => setDismissedAlerts(new Set())}
            >
              다시 보기
            </Button>
          </CardContent>
        </Card>
      )}

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: '초안', count: kpi.draft, color: '#64748b' },
          { label: '제출 (승인대기)', count: kpi.submitted, color: '#f59e0b' },
          { label: '승인', count: kpi.approved, color: '#059669' },
          { label: '반려/수정요청', count: kpi.rejected, color: '#e11d48' },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="p-3 text-center">
              <p className="text-[18px]" style={{ fontWeight: 700, color: k.color }}>{k.count}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{k.label}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 요청 리스트 */}
      <div className="flex flex-col lg:flex-row gap-4">
        <div className={selectedReq ? 'lg:w-[360px] shrink-0' : 'w-full'}>
          {myRequests.length === 0 ? (
            <Card className="p-8 text-center">
              <ArrowRightLeft className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-[13px] text-muted-foreground">인력변경 신청 내역이 없습니다</p>
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => setShowCreate(true)}>
                <Plus className="w-3.5 h-3.5" /> 첫 신청 만들기
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {myRequests.map(req => {
                const StateIcon = stateIcons[req.state];
                // HR 공지 연동 여부 표시 (id 패턴으로 구분)
                const isFromHr = req.id.startsWith('cr-hr-');
                return (
                  <Card
                    key={req.id}
                    className={`cursor-pointer transition-all hover:shadow-sm ${req.id === selectedReq?.id ? 'ring-2 ring-cyan-500/40' : ''}`}
                    onClick={() => setSelectedReq(req)}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <div className="flex items-center gap-1.5 min-w-0">
                          {isFromHr && (
                            <Megaphone className="w-3 h-3 text-rose-500 shrink-0" />
                          )}
                          <span className="text-[12px] truncate" style={{ fontWeight: 600 }}>{req.title}</span>
                        </div>
                        <Badge className={`text-[9px] h-4 px-1.5 shrink-0 ${stateStyles[req.state]}`}>
                          <StateIcon className="w-2.5 h-2.5 mr-0.5" />
                          {STATE_LABELS[req.state]}
                        </Badge>
                      </div>
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground flex-wrap">
                        <span>{new Date(req.requestedAt).toLocaleDateString('ko-KR')}</span>
                        <span>{req.changes.length}건 변경</span>
                        {req.changes.map((sc, i) => (
                          <Badge key={i} className={`text-[8px] h-3.5 px-1 ${changeTypeColors[sc.changeType]}`}>
                            {changeTypeLabels[sc.changeType]}
                          </Badge>
                        ))}
                      </div>
                      {req.state === 'DRAFT' && (
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 text-[10px] gap-1 mt-2"
                          onClick={e => { e.stopPropagation(); setSubmitConfirm(req.id); }}
                        >
                          <Send className="w-3 h-3" /> 제출하기
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* 상세 */}
        {selectedReq && (
          <div className="flex-1 min-w-0">
            <Card>
              <CardContent className="p-4 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      {selectedReq.id.startsWith('cr-hr-') && (
                        <Badge className="text-[9px] h-4 px-1.5 bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-400 gap-0.5">
                          <Megaphone className="w-2.5 h-2.5" /> 인사공지 연동
                        </Badge>
                      )}
                      <h3 className="text-[14px]" style={{ fontWeight: 700 }}>{selectedReq.title}</h3>
                    </div>
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {selectedReq.requestedBy} · {new Date(selectedReq.requestedAt).toLocaleDateString('ko-KR')}
                      {selectedReq.effectiveDate && <> · 적용일 {selectedReq.effectiveDate}</>}
                    </p>
                  </div>
                  <Badge className={`text-[10px] h-5 px-2 ${stateStyles[selectedReq.state]}`}>
                    {STATE_LABELS[selectedReq.state]}
                  </Badge>
                </div>

                {selectedReq.description && (
                  <div>
                    <p className="text-[10px] text-muted-foreground mb-1">변경 사유</p>
                    <p className="text-[12px] p-2.5 rounded-lg bg-muted/30">{selectedReq.description}</p>
                  </div>
                )}

                <Separator />

                {/* 변경 내역 */}
                <div>
                  <p className="text-[11px] mb-2" style={{ fontWeight: 600 }}>변경 내역</p>
                  {selectedReq.changes.map((sc, i) => (
                    <div key={i} className="p-3 rounded-lg border border-border mb-2">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="text-[12px]" style={{ fontWeight: 600 }}>{sc.staffName}</span>
                        <Badge className={`text-[9px] h-4 px-1.5 ${changeTypeColors[sc.changeType]}`}>
                          {changeTypeLabels[sc.changeType]}
                        </Badge>
                      </div>
                      {sc.description && (
                        <p className="text-[10px] text-muted-foreground mb-2">{sc.description}</p>
                      )}
                      <div className="grid grid-cols-2 gap-3 text-[10px]">
                        <div className="p-2 rounded bg-muted/30">
                          <p className="text-muted-foreground mb-0.5">변경 전</p>
                          <p style={{ fontWeight: 600 }}>투입율: {sc.before?.rate ?? '-'}%</p>
                          {sc.before?.grade && <p>등급: {sc.before.grade}</p>}
                        </div>
                        <div className="p-2 rounded bg-teal-50 dark:bg-teal-950/20">
                          <p className="text-muted-foreground mb-0.5">변경 후</p>
                          <p style={{ fontWeight: 600 }}>투입율: {sc.after?.rate ?? '-'}%</p>
                          {sc.after?.grade && <p>등급: {sc.after.grade}</p>}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                {/* 타임라인 */}
                {selectedReq.timeline.length > 0 && (
                  <div>
                    <p className="text-[11px] mb-2" style={{ fontWeight: 600 }}>이력</p>
                    <div className="space-y-2">
                      {selectedReq.timeline.map((t) => (
                        <div key={t.id} className="flex items-start gap-2 text-[10px]">
                          <div className={`w-1.5 h-1.5 rounded-full mt-1.5 shrink-0 ${
                            t.actor === '시스템' ? 'bg-rose-400' : 'bg-muted-foreground'
                          }`} />
                          <div>
                            <span style={{ fontWeight: 500 }}>{t.action}</span>
                            <span className="text-muted-foreground"> · {t.actor} · {new Date(t.timestamp).toLocaleDateString('ko-KR')}</span>
                            {t.comment && <p className="text-muted-foreground mt-0.5">{t.comment}</p>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* 반려 코멘트 */}
                {selectedReq.reviewComment && (selectedReq.state === 'REJECTED' || selectedReq.state === 'REVISION_REQUESTED') && (
                  <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-800/40">
                    <p className="text-[10px] text-rose-700 dark:text-rose-300" style={{ fontWeight: 600 }}>관리자 코멘트</p>
                    <p className="text-[11px] mt-0.5">{selectedReq.reviewComment}</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* 제출 확인 */}
      <AlertDialog open={!!submitConfirm} onOpenChange={(open) => { if (!open) setSubmitConfirm(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>인력변경 요청을 제출하시겠습니까?</AlertDialogTitle>
            <AlertDialogDescription>
              제출 후 관리자가 검토합니다.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {submitReq && (
            <div className="text-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">요청명</span>
                <span className="truncate max-w-[220px]" style={{ fontWeight: 700 }}>{submitReq.title}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">변경 건수</span>
                <span style={{ fontWeight: 700 }}>{submitReq.changes.length}건</span>
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>취소</AlertDialogCancel>
            <AlertDialogAction
              onClick={async (e) => {
                e.preventDefault();
                if (!submitReq) return;
                const ok = await submitChangeRequest(submitReq.id);
                if (ok) {
                  toast.success('제출했습니다.');
                  setSubmitConfirm(null);
                }
              }}
            >
              제출
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* 새 신청 다이얼로그 */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle className="text-[14px]">인력변경 신청</DialogTitle></DialogHeader>
          <div className="space-y-3 py-2">
            <div>
              <Label className="text-[12px]">신청 제목</Label>
              <Input value={form.title} onChange={e => setForm(p => ({ ...p, title: e.target.value }))} placeholder="예: 홍길동 투입율 변경 요청" className="h-9 text-[12px] mt-1" />
            </div>
            <div>
              <Label className="text-[12px]">변경 유형</Label>
              <Select value={form.changeType} onValueChange={v => setForm(p => ({ ...p, changeType: v as any }))}>
                <SelectTrigger className="h-9 text-[12px] mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(changeTypeLabels).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-[12px]">대상자</Label>
              <Input value={form.staffName} onChange={e => setForm(p => ({ ...p, staffName: e.target.value }))} placeholder="인력 이름" className="h-9 text-[12px] mt-1" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-[11px]">변경 전 투입율 (%)</Label>
                <Input type="number" value={form.rateBefore || ''} onChange={e => setForm(p => ({ ...p, rateBefore: Number(e.target.value) }))} className="h-8 text-[12px] mt-1" />
              </div>
              <div>
                <Label className="text-[11px]">변경 후 투입율 (%)</Label>
                <Input type="number" value={form.rateAfter || ''} onChange={e => setForm(p => ({ ...p, rateAfter: Number(e.target.value) }))} className="h-8 text-[12px] mt-1" />
              </div>
            </div>
            <div>
              <Label className="text-[12px]">변경 사유</Label>
              <Textarea value={form.reason} onChange={e => setForm(p => ({ ...p, reason: e.target.value }))} className="text-[12px] mt-1 min-h-[60px]" placeholder="변경 사유를 입력해 주세요" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>취소</Button>
            <Button size="sm" onClick={handleCreate} disabled={!form.title || !form.staffName}>생성</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
