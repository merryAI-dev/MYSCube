import { useMemo, useState } from 'react';
import {
  Megaphone, Plus, UserMinus, Clock, ArrowRightLeft,
  CheckCircle2, AlertTriangle, Calendar, Users, Building2,
  RefreshCw, Eye, Briefcase, ChevronRight,
} from 'lucide-react';
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
import { useAppStore } from '../../data/store';
import {
  useHrAnnouncements,
  HR_EVENT_LABELS, HR_EVENT_COLORS,
  type HrEventType,
} from '../../data/hr-announcements-store';
import { fmtKRW } from '../../data/budget-data';

// ═══════════════════════════════════════════════════════════════
// AdminHrAnnouncementPage — 관리자 인사 공지 관리
// 퇴사·휴직·전배 등록 → 영향 사업에 자동 인력변경 알림
// ═══════════════════════════════════════════════════════════════

export function AdminHrAnnouncementPage() {
  const { participationEntries, persons, projects } = useAppStore();
  const {
    announcements, alerts,
    createAnnouncement, resolveAnnouncement,
    acknowledgeAlert, markAlertResolved,
    getUnacknowledgedCount, getAllPendingCount,
  } = useHrAnnouncements();

  const [showCreate, setShowCreate] = useState(false);
  const [selectedAnn, setSelectedAnn] = useState<string | null>(null);
  const [form, setForm] = useState({
    employeeId: '',
    eventType: 'RESIGNATION' as HrEventType,
    effectiveDate: '',
    description: '',
  });

  // 대상 직원 목록은 인력 명부(persons)에서 온다. 코드에 박힌 명단을 쓰면 신규 입사자가
  // 배포 전까지 목록에 없고, 퇴사자는 영원히 남는다.
  const employeeOptions = useMemo(() => persons
    .map((person) => ({ id: person.personId, realName: person.name, nickname: person.nickname }))
    .sort((a, b) => a.realName.localeCompare(b.realName, 'ko')), [persons]);

  // 선택된 직원의 참여 사업 미리보기
  const selectedEmployee = employeeOptions.find(e => e.id === form.employeeId);
  const affectedProjects = selectedEmployee
    ? [...new Set(
        participationEntries
          .filter(e => e.memberId === form.employeeId && e.rate > 0)
          .map(e => {
            const proj = projects.find(p => e.projectId === p.id);
            return proj ? { id: proj.id, name: proj.name, shortName: proj.shortName || proj.name } : null;
          })
          .filter(Boolean)
      )]
    : [];

  const handleCreate = () => {
    if (!form.employeeId || !form.effectiveDate) return;
    const emp = employeeOptions.find(e => e.id === form.employeeId);
    if (!emp) return;

    createAnnouncement({
      employeeId: emp.id,
      employeeName: emp.realName,
      employeeNickname: emp.nickname,
      eventType: form.eventType,
      effectiveDate: form.effectiveDate,
      announcedBy: '관리자',
      description: form.description || `${emp.realName}(${emp.nickname}) ${HR_EVENT_LABELS[form.eventType]} - ${form.effectiveDate}`,
    }, participationEntries, projects);

    setShowCreate(false);
    setForm({ employeeId: '', eventType: 'RESIGNATION', effectiveDate: '', description: '' });
  };

  const selAnn = selectedAnn ? announcements.find(a => a.id === selectedAnn) : null;
  const selAlerts = selectedAnn ? alerts.filter(a => a.announcementId === selectedAnn) : [];

  const pendingCount = getAllPendingCount();
  const unackCount = getUnacknowledgedCount();

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Megaphone}
        iconGradient="linear-gradient(135deg, #e11d48 0%, #f43f5e 100%)"
        title="인사 공지 관리"
        description="퇴사·휴직·전배 공지를 등록하면 영향 사업에 자동 인력변경 알림이 발송됩니다"
        badge={`${announcements.length}건`}
        actions={
          <Button size="sm" className="h-8 text-[12px] gap-1.5" onClick={() => setShowCreate(true)}>
            <Plus className="w-3.5 h-3.5" /> 인사 공지 등록
          </Button>
        }
      />

      {/* KPI */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: '전체 공지', count: announcements.length, color: '#0891b2', icon: Megaphone },
          { label: '미해결', count: announcements.filter(a => !a.resolved).length, color: '#f59e0b', icon: AlertTriangle },
          { label: '미확인 알림', count: unackCount, color: '#e11d48', icon: Clock },
          { label: '인력변경 필요', count: pendingCount, color: '#0d9488', icon: ArrowRightLeft },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="p-3 flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: `${k.color}15` }}>
                <k.icon className="w-4 h-4" style={{ color: k.color }} />
              </div>
              <div>
                <p className="text-[10px] text-muted-foreground">{k.label}</p>
                <p className="text-[18px]" style={{ fontWeight: 700, color: k.count > 0 ? k.color : undefined }}>{k.count}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 공지 리스트 + 상세 */}
      <div className="flex flex-col lg:flex-row gap-4">
        {/* 리스트 */}
        <div className={selAnn ? 'lg:w-[380px] shrink-0' : 'w-full'}>
          {announcements.length === 0 ? (
            <Card className="p-8 text-center">
              <Megaphone className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
              <p className="text-[13px] text-muted-foreground">등록된 인사 공지가 없습니다</p>
              <Button size="sm" className="mt-3 gap-1.5" onClick={() => setShowCreate(true)}>
                <Plus className="w-3.5 h-3.5" /> 첫 공지 등록
              </Button>
            </Card>
          ) : (
            <div className="space-y-2">
              {announcements.map(ann => {
                const annAlerts = alerts.filter(a => a.announcementId === ann.id);
                const pendingAlerts = annAlerts.filter(a => !a.changeRequestCreated).length;
                return (
                  <Card
                    key={ann.id}
                    className={`cursor-pointer transition-all hover:shadow-sm ${ann.id === selectedAnn ? 'ring-2 ring-rose-500/40 shadow-sm' : ''}`}
                    onClick={() => setSelectedAnn(ann.id)}
                  >
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <UserMinus className="w-4 h-4 text-rose-500 shrink-0" />
                          <div>
                            <p className="text-[12px]" style={{ fontWeight: 600 }}>
                              {ann.employeeName} ({ann.employeeNickname})
                            </p>
                            <p className="text-[10px] text-muted-foreground">
                              {ann.effectiveDate} · {ann.announcedBy}
                            </p>
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 shrink-0">
                          <Badge className={`text-[9px] h-4 px-1.5 ${HR_EVENT_COLORS[ann.eventType]}`}>
                            {HR_EVENT_LABELS[ann.eventType]}
                          </Badge>
                          {ann.resolved ? (
                            <Badge className="text-[9px] h-4 px-1.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-400">완료</Badge>
                          ) : pendingAlerts > 0 ? (
                            <Badge className="text-[9px] h-4 px-1.5 bg-rose-100 text-rose-700 dark:bg-rose-900/50 dark:text-rose-400">
                              {pendingAlerts}건 미처리
                            </Badge>
                          ) : null}
                        </div>
                      </div>
                      <p className="text-[10px] text-muted-foreground line-clamp-2">{ann.description}</p>
                      <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                        {ann.affectedProjectIds.map(pid => {
                          const proj = projects.find(p => p.id === pid);
                          return (
                            <Badge key={pid} variant="outline" className="text-[8px] h-3.5 px-1 bg-muted/30">
                              {proj?.shortName || pid}
                            </Badge>
                          );
                        })}
                      </div>
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          )}
        </div>

        {/* 상세 */}
        {selAnn && (
          <div className="flex-1 min-w-0">
            <Card>
              <CardContent className="p-4 space-y-4">
                {/* 헤더 */}
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-[14px]" style={{ fontWeight: 700 }}>
                        {selAnn.employeeName} ({selAnn.employeeNickname})
                      </h3>
                      <Badge className={`text-[10px] h-5 px-2 ${HR_EVENT_COLORS[selAnn.eventType]}`}>
                        {HR_EVENT_LABELS[selAnn.eventType]}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                      <span className="flex items-center gap-1"><Calendar className="w-3 h-3" /> 적용일: {selAnn.effectiveDate}</span>
                      <span>등록: {new Date(selAnn.announcedAt).toLocaleDateString('ko-KR')}</span>
                      <span>by {selAnn.announcedBy}</span>
                    </div>
                  </div>
                  {!selAnn.resolved && (
                    <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1"
                      onClick={() => resolveAnnouncement(selAnn.id)}
                      disabled={selAlerts.some(a => !a.changeRequestCreated)}>
                      <CheckCircle2 className="w-3 h-3" /> 해결 완료
                    </Button>
                  )}
                </div>

                <div className="p-3 rounded-lg bg-muted/30 text-[11px]">
                  {selAnn.description}
                </div>

                <Separator />

                {/* 영향 사업별 알림 상태 */}
                <div>
                  <p className="text-[11px] mb-2" style={{ fontWeight: 600 }}>
                    영향 사업 ({selAnn.affectedProjectIds.length}개)
                  </p>
                  <div className="space-y-2">
                    {selAlerts.map(alert => {
                      const proj = projects.find(p => p.id === alert.projectId);
                      return (
                        <div key={alert.id} className={`p-3 rounded-lg border transition-colors ${
                          alert.changeRequestCreated
                            ? 'border-emerald-200 dark:border-emerald-800 bg-emerald-50/30 dark:bg-emerald-950/10'
                            : alert.acknowledged
                              ? 'border-amber-200 dark:border-amber-800 bg-amber-50/30 dark:bg-amber-950/10'
                              : 'border-rose-200 dark:border-rose-800 bg-rose-50/30 dark:bg-rose-950/10'
                        }`}>
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 min-w-0">
                              <Building2 className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                              <div className="min-w-0">
                                <p className="text-[11px] truncate" style={{ fontWeight: 600 }}>
                                  {proj?.shortName || alert.projectName}
                                </p>
                                <p className="text-[9px] text-muted-foreground truncate">{alert.projectName}</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-1.5 shrink-0">
                              {alert.changeRequestCreated ? (
                                <Badge className="text-[8px] h-3.5 px-1 bg-emerald-100 text-emerald-700">
                                  <CheckCircle2 className="w-2 h-2 mr-0.5" /> 변경완료
                                </Badge>
                              ) : alert.acknowledged ? (
                                <Badge className="text-[8px] h-3.5 px-1 bg-amber-100 text-amber-700">
                                  <Eye className="w-2 h-2 mr-0.5" /> 확인됨
                                </Badge>
                              ) : (
                                <Badge className="text-[8px] h-3.5 px-1 bg-rose-100 text-rose-700">
                                  <AlertTriangle className="w-2 h-2 mr-0.5" /> 미확인
                                </Badge>
                              )}
                              {!alert.changeRequestCreated && (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-[10px] px-2"
                                  onClick={() => markAlertResolved(alert.id)}
                                >
                                  처리 완료
                                </Button>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>

      {/* 새 공지 다이얼로그 */}
      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-[14px] flex items-center gap-2">
              <Megaphone className="w-4 h-4 text-rose-500" /> 인사 공지 등록
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            {/* 대상 직원 */}
            <div>
              <Label className="text-[12px]">대상 직원</Label>
              <Select value={form.employeeId} onValueChange={v => setForm(p => ({ ...p, employeeId: v }))}>
                <SelectTrigger className="h-9 text-[12px] mt-1"><SelectValue placeholder="직원 선택" /></SelectTrigger>
                <SelectContent className="max-h-[300px]">
                  {employeeOptions.length === 0 ? (
                    <div className="px-3 py-6 text-center text-[12px] text-slate-500">
                      인력 명부를 불러오는 중입니다.
                    </div>
                  ) : employeeOptions.map(e => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.realName}{e.nickname ? ` (${e.nickname})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 이벤트 유형 */}
            <div>
              <Label className="text-[12px]">유형</Label>
              <Select value={form.eventType} onValueChange={v => setForm(p => ({ ...p, eventType: v as HrEventType }))}>
                <SelectTrigger className="h-9 text-[12px] mt-1"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(HR_EVENT_LABELS).map(([k, v]) => (
                    <SelectItem key={k} value={k}>{v}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* 적용일 */}
            <div>
              <Label className="text-[12px]">적용일 (실제 퇴사일/휴직 시작일 등)</Label>
              <Input type="date" value={form.effectiveDate} onChange={e => setForm(p => ({ ...p, effectiveDate: e.target.value }))} className="h-9 text-[12px] mt-1" />
            </div>

            {/* 상세 */}
            <div>
              <Label className="text-[12px]">설명 (선택)</Label>
              <Textarea
                value={form.description}
                onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
                placeholder="상세 내용을 입력하세요"
                className="text-[12px] mt-1 min-h-[60px]"
              />
            </div>

            {/* 영향 사업 미리보기 */}
            {selectedEmployee && (
              <div className="p-3 rounded-lg bg-amber-50 dark:bg-amber-950/20 border border-amber-200/60 dark:border-amber-800/40">
                <p className="text-[10px] text-amber-700 dark:text-amber-400 mb-1.5" style={{ fontWeight: 600 }}>
                  <AlertTriangle className="w-3 h-3 inline mr-0.5" />
                  {selectedEmployee.realName}({selectedEmployee.nickname}) 참여 사업에 자동 알림 발송
                </p>
                {affectedProjects.length > 0 ? (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {(affectedProjects as any[]).map((p: any) => (
                      <Badge key={p.id} variant="outline" className="text-[9px] h-4 px-1.5 bg-white/60 dark:bg-slate-800/60">
                        {p.shortName}
                      </Badge>
                    ))}
                  </div>
                ) : (
                  <p className="text-[10px] text-amber-600/80">참여율 데이터에서 참여 사업을 찾을 수 없습니다</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setShowCreate(false)}>취소</Button>
            <Button size="sm" onClick={handleCreate} disabled={!form.employeeId || !form.effectiveDate} className="gap-1.5">
              <Megaphone className="w-3.5 h-3.5" /> 공지 등록
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
