import { useState } from 'react';
import {
  BookOpen, Plus, Search, Users, CheckSquare, Clock,
  GraduationCap, Loader2, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '../ui/dialog';
import { Checkbox } from '../ui/checkbox';
import { toast } from 'sonner';
import { useTraining } from '../../data/training-store';
import {
  TRAINING_CATEGORY_LABELS,
  TRAINING_STATUS_LABELS,
  ENROLLMENT_STATUS_LABELS,
  type TrainingCourse,
  type TrainingCategory,
  type TrainingStatus,
} from '../../data/types';

const categoryColors: Record<TrainingCategory, string> = {
  technical: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
  compliance: 'bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300',
  'soft-skills': 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300',
  management: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  language: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300',
  other: 'bg-muted text-muted-foreground',
};

const statusColors: Record<TrainingStatus, string> = {
  DRAFT: 'bg-muted text-muted-foreground',
  OPEN: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
  CLOSED: 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300',
  COMPLETED: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
};

const CATEGORY_OPTIONS = Object.entries(TRAINING_CATEGORY_LABELS) as [TrainingCategory, string][];
const STATUS_OPTIONS = Object.entries(TRAINING_STATUS_LABELS) as [TrainingStatus, string][];

// ── 강의 등록 다이얼로그 ──

function CreateCourseDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const { createCourse } = useTraining();
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState<{
    title: string;
    description: string;
    category: TrainingCategory;
    durationHours: number;
    instructor: string;
    startDate: string;
    endDate: string;
    maxParticipants: number;
    isRequired: boolean;
    status: TrainingStatus;
    orgId: string;
    createdBy: string;
  }>({
    title: '',
    description: '',
    category: 'management',
    durationHours: 2,
    instructor: '',
    startDate: '',
    endDate: '',
    maxParticipants: 20,
    isRequired: false,
    status: 'OPEN',
    orgId: 'org001',
    createdBy: 'admin',
  });

  const handleCreate = async () => {
    if (!form.title.trim()) { toast.error('강의명을 입력해 주세요.'); return; }
    if (!form.instructor.trim()) { toast.error('강사명을 입력해 주세요.'); return; }
    if (!form.startDate || !form.endDate) { toast.error('강의 기간을 입력해 주세요.'); return; }
    setSaving(true);
    const id = await createCourse(form);
    setSaving(false);
    if (id) onClose();
  };

  const update = (field: string, value: unknown) => setForm((p) => ({ ...p, [field]: value }));

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>강의 등록</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <Label className="text-[12px] mb-1 block">강의명 *</Label>
            <Input value={form.title} onChange={(e) => update('title', e.target.value)} placeholder="예: 사업관리 기초 교육" className="h-9 text-[13px]" />
          </div>
          <div>
            <Label className="text-[12px] mb-1 block">강의 설명</Label>
            <textarea
              value={form.description}
              onChange={(e) => update('description', e.target.value)}
              placeholder="강의 내용을 간략히 작성해 주세요."
              className="w-full min-h-[80px] rounded-md border border-input bg-input-background px-3 py-2 text-[12px] outline-none resize-none focus:ring-2 focus:ring-ring/50"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px] mb-1 block">카테고리</Label>
              <select value={form.category} onChange={(e) => update('category', e.target.value as TrainingCategory)} className="h-9 w-full rounded-md border border-input bg-input-background px-2 text-[12px]">
                {CATEGORY_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div>
              <Label className="text-[12px] mb-1 block">상태</Label>
              <select value={form.status} onChange={(e) => update('status', e.target.value as TrainingStatus)} className="h-9 w-full rounded-md border border-input bg-input-background px-2 text-[12px]">
                {STATUS_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px] mb-1 block">강사명 *</Label>
              <Input value={form.instructor} onChange={(e) => update('instructor', e.target.value)} placeholder="예: 관리자" className="h-9 text-[13px]" />
            </div>
            <div>
              <Label className="text-[12px] mb-1 block">수강 시간 (h)</Label>
              <Input type="number" min={1} value={form.durationHours} onChange={(e) => update('durationHours', Number(e.target.value))} className="h-9 text-[13px]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px] mb-1 block">시작일 *</Label>
              <Input type="date" value={form.startDate} onChange={(e) => update('startDate', e.target.value)} className="h-9 text-[13px]" />
            </div>
            <div>
              <Label className="text-[12px] mb-1 block">종료일 *</Label>
              <Input type="date" value={form.endDate} onChange={(e) => update('endDate', e.target.value)} className="h-9 text-[13px]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-[12px] mb-1 block">최대 수강 인원</Label>
              <Input type="number" min={1} value={form.maxParticipants} onChange={(e) => update('maxParticipants', Number(e.target.value))} className="h-9 text-[13px]" />
            </div>
            <div className="flex items-end pb-2">
              <label className="flex items-center gap-2 cursor-pointer">
                <Checkbox checked={form.isRequired} onCheckedChange={(v) => update('isRequired', v)} />
                <span className="text-[12px]">필수 교육</span>
              </label>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>취소</Button>
          <Button onClick={handleCreate} disabled={saving}>
            {saving ? <><Loader2 className="w-3.5 h-3.5 mr-1.5 animate-spin" />등록 중...</> : '강의 등록'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── 수강자 목록 패널 ──

function EnrollmentPanel({ courseId, courseTitle }: { courseId: string; courseTitle: string }) {
  const { getEnrollmentsForCourse, completeEnrollment } = useTraining();
  const enrollments = getEnrollmentsForCourse(courseId);
  const [completing, setCompleting] = useState<string | null>(null);

  const handleComplete = async (enrollmentId: string) => {
    setCompleting(enrollmentId);
    await completeEnrollment(enrollmentId);
    setCompleting(null);
  };

  if (enrollments.length === 0) {
    return (
      <div className="py-4 text-center text-[12px] text-muted-foreground">
        수강 신청자가 없습니다.
      </div>
    );
  }

  const enrollmentStatusBg: Record<string, string> = {
    ENROLLED: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300',
    COMPLETED: 'bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300',
    DROPPED: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="space-y-1.5">
      {enrollments.map((e) => (
        <div key={e.id} className="flex items-center justify-between p-2.5 rounded-lg bg-muted/30 border border-border/50">
          <div>
            <p className="text-[12px]" style={{ fontWeight: 600 }}>{e.memberName}</p>
            <p className="text-[11px] text-muted-foreground">신청일: {e.enrolledAt.slice(0, 10)}</p>
          </div>
          <div className="flex items-center gap-2">
            <Badge className={`text-[10px] h-5 border-0 ${enrollmentStatusBg[e.status] || ''}`}>
              {ENROLLMENT_STATUS_LABELS[e.status]}
            </Badge>
            {e.status === 'ENROLLED' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleComplete(e.id)}
                disabled={completing === e.id}
                className="h-6 text-[10px] gap-1"
              >
                {completing === e.id ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckSquare className="w-3 h-3" />}
                이수 처리
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ── 강의 행 ──

function CourseRow({ course }: { course: TrainingCourse }) {
  const { allEnrollments } = useTraining();
  const [expanded, setExpanded] = useState(false);
  const enrollCount = allEnrollments.filter((e) => e.courseId === course.id && e.status !== 'DROPPED').length;
  const completedCount = allEnrollments.filter((e) => e.courseId === course.id && e.status === 'COMPLETED').length;

  return (
    <div className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((p) => !p)}
        className="w-full text-left p-4 hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            {expanded ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" /> : <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0" />}
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap mb-1">
                <Badge className={`text-[10px] h-5 border-0 ${categoryColors[course.category]}`}>
                  {TRAINING_CATEGORY_LABELS[course.category]}
                </Badge>
                {course.isRequired && (
                  <Badge className="text-[10px] h-5 border-0 bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">필수</Badge>
                )}
                <Badge className={`text-[10px] h-5 border-0 ${statusColors[course.status]}`}>
                  {TRAINING_STATUS_LABELS[course.status]}
                </Badge>
              </div>
              <p className="text-[13px] truncate" style={{ fontWeight: 600 }}>{course.title}</p>
              <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1"><GraduationCap className="w-3 h-3" /> {course.instructor}</span>
                <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {course.durationHours}h</span>
                <span>{course.startDate} ~ {course.endDate}</span>
              </div>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <p className="text-[13px]" style={{ fontWeight: 600 }}>
              <span className="text-teal-600">{completedCount}</span>
              <span className="text-muted-foreground"> / {enrollCount}명</span>
            </p>
            <p className="text-[10px] text-muted-foreground">이수 / 신청</p>
          </div>
        </div>
      </button>
      {expanded && (
        <div className="px-4 pb-4 border-t border-border">
          <p className="text-[12px] text-muted-foreground py-3">{course.description}</p>
          <div className="flex items-center gap-2 mb-3">
            <Users className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="text-[12px]" style={{ fontWeight: 600 }}>수강자 목록</span>
          </div>
          <EnrollmentPanel courseId={course.id} courseTitle={course.title} />
        </div>
      )}
    </div>
  );
}

// ── 메인 페이지 ──

export function TrainingManagePage() {
  const { courses, allEnrollments } = useTraining();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | TrainingStatus>('all');
  const [showCreate, setShowCreate] = useState(false);

  const filtered = courses.filter((c) => {
    if (statusFilter !== 'all' && c.status !== statusFilter) return false;
    if (search && !c.title.toLowerCase().includes(search.toLowerCase()) && !c.instructor.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const totalEnrolled = allEnrollments.filter((e) => e.status === 'ENROLLED').length;
  const totalCompleted = allEnrollments.filter((e) => e.status === 'COMPLETED').length;
  const openCourses = courses.filter((c) => c.status === 'OPEN').length;

  return (
    <div className="p-5 max-w-[1200px] mx-auto space-y-5">
      {/* 헤더 */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[18px]" style={{ fontWeight: 700 }}>사내 교육 관리</h1>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            강의를 등록하고 수강자 이수를 처리합니다. 이수 완료 시 경력 프로필에 자동 반영됩니다.
          </p>
        </div>
        <Button onClick={() => setShowCreate(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> 강의 등록
        </Button>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">개설 강의</p>
            <p className="text-[24px] text-teal-600 mt-0.5" style={{ fontWeight: 700 }}>{openCourses}</p>
            <p className="text-[10px] text-muted-foreground">모집 중</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">수강 신청</p>
            <p className="text-[24px] text-blue-600 mt-0.5" style={{ fontWeight: 700 }}>{totalEnrolled}</p>
            <p className="text-[10px] text-muted-foreground">명 (진행 중)</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-[11px] text-muted-foreground">이수 완료</p>
            <p className="text-[24px] text-cyan-600 mt-0.5" style={{ fontWeight: 700 }}>{totalCompleted}</p>
            <p className="text-[10px] text-muted-foreground">명</p>
          </CardContent>
        </Card>
      </div>

      {/* 필터 & 검색 */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="강의명 또는 강사 검색..."
            className="h-9 text-[13px] pl-9"
          />
        </div>
        <div className="flex gap-2">
          {([['all', '전체'], ...STATUS_OPTIONS] as [string, string][]).map(([v, l]) => (
            <button
              key={v}
              onClick={() => setStatusFilter(v as 'all' | TrainingStatus)}
              className={`h-8 px-3 rounded-md text-[11px] border transition-all ${
                statusFilter === v
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'border-border hover:border-primary/50 text-muted-foreground'
              }`}
              style={{ fontWeight: statusFilter === v ? 600 : 400 }}
            >
              {l}
            </button>
          ))}
        </div>
      </div>

      {/* 강의 목록 */}
      {filtered.length === 0 ? (
        <div className="py-16 text-center">
          <BookOpen className="w-10 h-10 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-[13px] text-muted-foreground">등록된 강의가 없습니다.</p>
          <Button variant="outline" onClick={() => setShowCreate(true)} className="mt-4 gap-1.5">
            <Plus className="w-4 h-4" /> 첫 강의 등록하기
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((course) => <CourseRow key={course.id} course={course} />)}
        </div>
      )}

      <CreateCourseDialog open={showCreate} onClose={() => setShowCreate(false)} />
    </div>
  );
}
