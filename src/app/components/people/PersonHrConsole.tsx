import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Award,
  Briefcase,
  CalendarClock,
  FileCheck2,
  FileX2,
  GraduationCap,
  Languages,
  Loader2,
  Mail,
  MapPin,
  RefreshCw,
  User,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  changePersonEmploymentViaBff,
  updatePersonProfileViaBff,
  type ActorLike,
  type PersonRecord,
} from '../../lib/platform-bff-client';
import {
  createPersonProfessionalProfileClient,
  type ProfessionalProfileCatalog,
  type StoredProfessionalProfile,
} from '../../lib/person-professional-profile-client';
import {
  EMPLOYMENT_STATE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  resolveCurrentEmployment,
  deriveAge,
  deriveTenure,
  deriveYearsSinceDegree,
  resolveLeaveOrSeparation,
  resolveSeparationDate,
  type EmploymentState,
  type EmploymentType,
} from '../../platform/person-employment';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import { optionsWithCurrentValue } from '../../data/organization-settings';
import { useOrganizationSettings } from '../../data/use-organization-settings';
import { usePersonGradeSettings } from '../../data/use-person-grade-settings';
import { formatGradeOptionLabel } from '../../data/person-grade-settings';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';

/**
 * 인사정보 콘솔.
 *
 * 한 사람의 인적사항·학력·어학·자격증·계약 이력을 한 창에서 읽는다. 예전에는 계약 관리와
 * 전문 프로필이 서로 다른 창이라, 같은 사람을 보면서도 두 번 열어야 했다.
 *
 * 조회(인사정보조회)와 입력(기본정보·상세정보)을 탭으로 나눈 것은 쓰는 사람의 목적이
 * 다르기 때문이다 — 대부분은 "누가 어떤 자격을 갖췄나"를 볼 뿐이고, 고치는 일은 드물다.
 */

const NO_GRADE = '__NO_GRADE__';
const CUSTOM_GRADE = '__CUSTOM_GRADE__';

function formatDate(value?: string | null) {
  return value ? value.slice(0, 10) : '-';
}

/** 그룹웨어 인사기록카드의 요약 줄. 이름 옆에 직급이 붙어야 누구인지 한 번에 읽힌다. */
function SummaryField({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-0.5 text-slate-400" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <p className="text-[14px] text-slate-500">{label}</p>
        <p className="truncate text-[14px] font-medium text-slate-900">{value || '-'}</p>
      </div>
    </div>
  );
}

/** 인사정보조회 카드. 건수를 제목에 두고, 비어 있으면 비어 있다고 분명히 적는다. */
function RecordCard({
  icon,
  title,
  count,
  children,
}: {
  icon: ReactNode;
  title: string;
  count: number;
  children: ReactNode;
}) {
  return (
    <section className="rounded-md border border-slate-300 bg-white">
      {/* 표의 머리와 같은 회색 띠 - 어디까지가 제목이고 어디부터가 값인지 한 번에 갈린다. */}
      <header className="flex items-center justify-between border-b-2 border-slate-300 bg-slate-100 px-3 py-2.5">
        <h4 className="flex items-center gap-1.5 text-[14px] font-semibold text-slate-700">
          <span className="text-slate-500" aria-hidden>{icon}</span>
          {title}
        </h4>
        <span className="text-[13px] tabular-nums text-slate-500">{count}건</span>
      </header>
      <div className="px-3 py-1">
        {count === 0
          ? (
            <div className="flex flex-col items-center gap-2 py-8 text-slate-400">
              <FileX2 className="h-7 w-7" aria-hidden />
              <p className="text-[14px]">데이터가 존재하지 않습니다</p>
            </div>
          )
          : children}
      </div>
    </section>
  );
}

function RecordRow({ primary, secondary, hasEvidence }: {
  primary: string;
  secondary?: string;
  hasEvidence?: boolean;
}) {
  return (
    <div className="border-b border-slate-200 py-2.5 last:border-b-0">
      <p className="flex items-center gap-1.5 text-[14px] font-medium text-slate-900">
        <span className="min-w-0 truncate">{primary}</span>
        {/* 증빙이 붙은 항목만 표시한다 - 없는 것을 빨갛게 알리면 화면이 경고로 뒤덮인다. */}
        {hasEvidence ? <FileCheck2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" aria-label="증빙 있음" /> : null}
      </p>
      {secondary ? <p className="mt-0.5 text-[13px] text-slate-500">{secondary}</p> : null}
    </div>
  );
}

export interface PersonProfileFormValue {
  nickname: string;
  email: string;
  birthDate: string;
  grade: string;
  title: string;
  departmentTop: string;
  departmentMid: string;
  workLocation: string;
}

export function personProfileFormFromRecord(person: PersonRecord): PersonProfileFormValue {
  return {
    nickname: person.nickname || '',
    email: person.email || '',
    birthDate: (person.birthDate || '').slice(0, 10),
    grade: person.grade || '',
    title: person.title || '',
    departmentTop: person.departmentTop || '',
    departmentMid: person.departmentMid || '',
    workLocation: person.workLocation || '',
  };
}

/** 저장할 값만 추린다. 서버는 부분 갱신이라 안 바뀐 칸까지 보내면 감사 기록이 뜻을 잃는다. */
export function changedPersonProfileFields(
  before: PersonProfileFormValue,
  after: PersonProfileFormValue,
): Partial<PersonProfileFormValue> {
  const changed: Partial<PersonProfileFormValue> = {};
  (Object.keys(after) as Array<keyof PersonProfileFormValue>).forEach((key) => {
    if (before[key] !== after[key]) changed[key] = after[key];
  });
  return changed;
}

export function PersonHrConsole({
  tenantId,
  actor,
  person,
  canReadProfile,
  canWriteProfile,
  canWritePerson,
  onClose,
  onPersonUpdated,
  onManageEmployment,
  onEditProfessionalProfile,
  asOf,
}: {
  tenantId: string;
  actor: ActorLike;
  person: PersonRecord;
  canReadProfile: boolean;
  canWriteProfile: boolean;
  canWritePerson: boolean;
  onClose: () => void;
  onPersonUpdated: () => void;
  onManageEmployment: () => void;
  onEditProfessionalProfile: () => void;
  asOf: string;
}) {
  const [form, setForm] = useState<PersonProfileFormValue>(() => personProfileFormFromRecord(person));
  const [saving, setSaving] = useState(false);
  const [customGrade, setCustomGrade] = useState(false);
  const { groups: organizationGroups } = useOrganizationSettings();
  const { grades: gradeSettings } = usePersonGradeSettings();
  const [profile, setProfile] = useState<StoredProfessionalProfile | null>(null);
  const [catalog, setCatalog] = useState<ProfessionalProfileCatalog | null>(null);
  const [profileLoading, setProfileLoading] = useState(canReadProfile);
  const [profileError, setProfileError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const baselineRef = useRef(personProfileFormFromRecord(person));

  useEffect(() => {
    const next = personProfileFormFromRecord(person);
    baselineRef.current = next;
    setForm(next);
  }, [person]);

  useEffect(() => {
    if (!canReadProfile) {
      setProfile(null);
      setProfileLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    const client = createPersonProfessionalProfileClient({ tenantId, actor });
    setProfileLoading(true);
    setProfileError('');
    void Promise.all([
      client.getCatalog(controller.signal),
      client.get(person.personId, controller.signal),
    ]).then(([nextCatalog, response]) => {
      if (controller.signal.aborted) return;
      setCatalog(nextCatalog);
      setProfile(response.profile);
    }).catch(() => {
      if (controller.signal.aborted) return;
      // 인사정보를 못 읽어도 인적사항·계약 이력은 그대로 보여준다.
      setProfileError('학력·어학·자격 정보를 불러오지 못했습니다.');
    }).finally(() => {
      if (!controller.signal.aborted) setProfileLoading(false);
    });
    return () => controller.abort();
  }, [tenantId, actor, person.personId, canReadProfile, reloadToken]);

  // 직급 선택지도 설정에서 뻗어 나온다. 숨긴 직급은 새로 고를 수 없지만 이미 그 값인 사람은 그대로다.
  const gradeOptions = useMemo(() => gradeSettings.filter((grade) => grade.active), [gradeSettings]);
  const knownGradeLabels = useMemo(() => gradeOptions.map((grade) => grade.label), [gradeOptions]);

  // 대분류·중분류 선택지는 조직 목록에서 뻗어 나온다. 대분류를 고르면 그 아래 중분류만 보인다.
  const groupOptions = useMemo(
    () => organizationGroups.filter((group) => group.active).map((group) => group.label),
    [organizationGroups],
  );
  const teamOptions = useMemo(() => {
    const selected = organizationGroups.find((group) => group.label === form.departmentTop);
    const source = selected ? [selected] : organizationGroups;
    return source.flatMap((group) => group.teams.filter((team) => team.active).map((team) => team.label));
  }, [organizationGroups, form.departmentTop]);

  const current = useMemo(() => resolveCurrentEmployment(person, asOf), [person, asOf]);
  const separated = useMemo(() => resolveSeparationDate(person), [person]);
  const leaveOrSeparation = useMemo(() => resolveLeaveOrSeparation(person, asOf), [person, asOf]);
  const tenure = useMemo(() => deriveTenure(person.joinedAt, asOf), [person.joinedAt, asOf]);
  const age = useMemo(() => deriveAge(person.birthDate, asOf), [person.birthDate, asOf]);

  const educationLabelOf = (code: string) => (
    catalog?.educationAttainments.find((entry) => entry.code === code)?.label || code
  );
  const englishLabelOf = (testCode: string, otherName?: string | null) => {
    if (testCode === 'OTHER') return otherName || '기타';
    return catalog?.englishTests.find((entry) => entry.code === testCode)?.displayLabel || testCode;
  };

  /**
   * 최고 학력 한 줄. 학력 구분의 순위(catalog rank)가 기준이며, 학위취득년도는 졸업증에 찍힌 해다.
   * 목록에서 오는 요약이 있으면 그것을 먼저 쓴다 - 상세를 열기 전에도 같은 값이 보이게.
   */
  const highestEducation = useMemo(() => {
    const records = profile?.educationRecords || [];
    if (records.length === 0) {
      const summary = person.hrSummary?.highestEducationDisplayText || '';
      return summary
        ? { summary, degreeYear: person.hrSummary?.highestDegreeYear || '' }
        : null;
    }
    const ranked = [...records].sort((left, right) => (
      (catalog?.educationAttainments.find((entry) => entry.code === right.attainmentCode)?.rank || 0)
      - (catalog?.educationAttainments.find((entry) => entry.code === left.attainmentCode)?.rank || 0)
    ));
    const top = ranked[0];
    // 학과를 앞세운다 - 사람을 고를 때 전공이 학교보다 먼저 읽혀야 한다.
    const parts = [educationLabelOf(top.attainmentCode), top.major, top.institutionName].filter(Boolean);
    return { summary: parts.join(' · '), degreeYear: top.degreeYear || '' };
  }, [profile, catalog, person.hrSummary]);

  const yearsSinceDegree = useMemo(
    () => deriveYearsSinceDegree(highestEducation?.degreeYear, asOf),
    [highestEducation, asOf],
  );

  const statusText = separated
    ? `${formatDate(separated)} 퇴사`
    : current
      ? `${EMPLOYMENT_STATE_LABELS[current.state as EmploymentState]}${tenure ? ` (${tenure.label})` : ''}`
      : '계약 없음';

  const dirty = Object.keys(changedPersonProfileFields(baselineRef.current, form)).length > 0;

  /**
   * 휴직·퇴사 기입.
   *
   * 계약 관리 화면을 따로 열지 않고 여기서 바로 적는다 — 인사담당자가 인사정보를 보다가
   * "이 사람 이 날부터 휴직" 을 적는 자리가 여기이기 때문이다.
   * 근로형태는 지금 계약의 것을 그대로 이어간다. 형태를 바꾸는 일은 계약 관리의 몫이다.
   */
  // 퇴사는 재직상태가 아니다 - 계약을 닫는 일이라 이 칸에서만 쓰는 별도 선택지로 둔다.
  type LeaveChoice = EmploymentState | 'SEPARATED';
  const [leaveState, setLeaveState] = useState<LeaveChoice>('ON_LEAVE');
  const [leaveDate, setLeaveDate] = useState('');
  const [leaveSaving, setLeaveSaving] = useState(false);

  const applyLeave = async () => {
    if (!current || !leaveDate || leaveSaving) return;
    setLeaveSaving(true);
    try {
      await changePersonEmploymentViaBff({
        tenantId,
        actor,
        personId: person.personId,
        mode: 'change',
        type: current.type,
        state: leaveState === 'SEPARATED' ? 'WORKING' : leaveState,
        effectiveFrom: leaveDate,
        // 퇴사는 상태가 아니라 계약을 닫는 일이다 - 종료일을 주는 것으로 끝난다.
        ...(leaveState === 'SEPARATED' ? { endDate: leaveDate } : {}),
      });
      toast.success(leaveState === 'SEPARATED' ? '퇴사일을 기록했습니다.' : '휴직을 기록했습니다.');
      setLeaveDate('');
      onPersonUpdated();
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '휴직·퇴사 기록에 실패했습니다.'));
    } finally {
      setLeaveSaving(false);
    }
  };

  const saveProfileFields = async () => {
    const changed = changedPersonProfileFields(baselineRef.current, form);
    if (Object.keys(changed).length === 0) return;
    setSaving(true);
    try {
      await updatePersonProfileViaBff({
        tenantId,
        actor,
        personId: person.personId,
        profile: {
          ...changed,
          ...(changed.birthDate !== undefined ? { birthDate: changed.birthDate || null } : {}),
        },
      });
      baselineRef.current = form;
      toast.success('인적사항을 저장했습니다.');
      onPersonUpdated();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '인적사항을 저장하지 못했습니다.');
    } finally {
      setSaving(false);
    }
  };

  // 목록 밖 값(별도 직급체계)은 직접 입력 칸으로 보여 준다 - 지우거나 목록 값으로 바꿔치지 않는다.
  const usesCustomGrade = customGrade || (!!form.grade && !knownGradeLabels.includes(form.grade));
  const gradeOptionValue = usesCustomGrade
    ? CUSTOM_GRADE
    : (form.grade && knownGradeLabels.includes(form.grade) ? form.grade : NO_GRADE);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex max-h-[94vh] w-[96vw] max-w-[1400px] flex-col overflow-hidden p-0 sm:max-w-[1400px]">
        <DialogHeader className="sr-only">
          <DialogTitle>{person.name} 인사정보</DialogTitle>
          <DialogDescription>인적사항, 학력·어학·자격, 계약 이력을 확인하고 수정합니다.</DialogDescription>
        </DialogHeader>

        {/* ── 인사기록카드 머리 — 누구인지, 지금 어떤 상태인지 한 줄에 ── */}
        <div className="border-b border-slate-200 bg-white px-7 py-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full border border-slate-200 bg-slate-50 text-slate-400">
                <User className="h-8 w-8" aria-hidden />
              </div>
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <span className="text-[22px] font-semibold text-slate-950">{person.name}</span>
                  {person.grade ? <span className="text-[16px] font-medium text-slate-700">{person.grade}</span> : null}
                  {person.nickname ? <span className="text-[14px] text-slate-500">({person.nickname})</span> : null}
                </p>
                <p className="mt-1 text-[14px] text-slate-600">
                  {[person.departmentTop, person.departmentMid, person.title].filter(Boolean).join(' · ') || '대분류 미지정'}
                </p>
                <p className="mt-1 text-[14px] text-slate-600">
                  {person.joinedAt ? `${formatDate(person.joinedAt)} 입사` : '입사일 미등록'}
                  {' · '}
                  <span className={separated ? 'text-slate-500' : 'font-medium text-slate-800'}>{statusText}</span>
                  {current ? ` · ${EMPLOYMENT_TYPE_LABELS[current.type as EmploymentType]}` : ''}
                </p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:w-[400px]">
              <SummaryField
                icon={<CalendarClock className="h-4 w-4" />}
                label="생년월일"
                value={person.birthDate ? `${formatDate(person.birthDate)}${age === null ? '' : ` (만 ${age}세)`}` : '미등록'}
              />
              <SummaryField icon={<Mail className="h-4 w-4" />} label="이메일" value={person.email || '미등록'} />
              <SummaryField
                icon={<Briefcase className="h-4 w-4" />}
                label="근속"
                value={tenure ? tenure.label : '입사일 필요'}
              />
              <SummaryField icon={<MapPin className="h-4 w-4" />} label="근무지" value={person.workLocation || '미등록'} />
              {/* KOICA 제안서가 '학위 취득 후 경력 몇 년' 을 본다. 학력 카드를 열지 않고 여기서 읽힌다. */}
              <SummaryField
                icon={<GraduationCap className="h-4 w-4" />}
                label="최종학력"
                value={highestEducation ? highestEducation.summary : (canReadProfile ? '미등록' : '조회 권한 없음')}
              />
              <SummaryField
                icon={<CalendarClock className="h-4 w-4" />}
                label="학위취득"
                value={highestEducation?.degreeYear
                  ? `${highestEducation.degreeYear}년${yearsSinceDegree === null ? '' : ` · 취득 후 ${yearsSinceDegree}년`}`
                  : '미등록'}
              />
            </div>
          </div>
        </div>

        <Tabs defaultValue="records" className="flex min-h-0 flex-1 flex-col">
          <TabsList className="mx-7 mt-5 w-fit">
            <TabsTrigger value="basic" className="px-4 py-2 text-[14px]">기본정보</TabsTrigger>
            <TabsTrigger value="records" className="px-4 py-2 text-[14px]">인사정보조회</TabsTrigger>
            <TabsTrigger value="detail" className="px-4 py-2 text-[14px]">상세정보</TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto px-7 pb-6 pt-4">
            {/* ── 기본정보: 사람이 적는 인적사항 ── */}
            <TabsContent value="basic" className="mt-0 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label className="text-[14px]">이름</Label>
                  <Input className="mt-1.5 h-10" value={person.name} disabled readOnly />
                  <p className="mt-1 text-[14px] text-slate-500">이름은 재직자 명단이 정하므로 여기서 고치지 않습니다.</p>
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-nickname">닉네임</Label>
                  <Input
                    id="hr-nickname" className="mt-1.5 h-10" value={form.nickname} disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, nickname: event.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-birth">생년월일</Label>
                  <Input
                    id="hr-birth" type="date" className="mt-1.5 h-10 tabular-nums" value={form.birthDate}
                    disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, birthDate: event.target.value })}
                  />
                  <p className="mt-1 text-[14px] text-slate-500">
                    만 나이는 저장하지 않고 오늘({asOf}) 기준으로 계산합니다.
                  </p>
                </div>
                <div>
                  <Label className="text-[14px]">직급</Label>
                  <Select
                    value={gradeOptionValue}
                    disabled={!canWritePerson || saving}
                    onValueChange={(value) => {
                      if (value === NO_GRADE) setForm({ ...form, grade: '' });
                      else if (value === CUSTOM_GRADE) setCustomGrade(true);
                      else { setCustomGrade(false); setForm({ ...form, grade: value }); }
                    }}
                  >
                    <SelectTrigger className="mt-1.5 h-10 text-[14px]" aria-label="직급"><SelectValue placeholder="직급 선택" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_GRADE}>미지정</SelectItem>
                      {gradeOptions.map((grade) => (
                        <SelectItem key={grade.id} value={grade.label}>{formatGradeOptionLabel(grade)}</SelectItem>
                      ))}
                      <SelectItem value={CUSTOM_GRADE}>직접 입력 (별도 직급체계)</SelectItem>
                    </SelectContent>
                  </Select>
                  {usesCustomGrade ? (
                    <>
                      <Input
                        className="mt-2 h-9" maxLength={100} value={form.grade}
                        disabled={!canWritePerson || saving}
                        placeholder="예: 매니저"
                        aria-label="직급 직접 입력"
                        onChange={(event) => setForm({ ...form, grade: event.target.value })}
                      />
                      <p className="mt-1 text-[14px] text-slate-500">
                        경영기획실(재경)과 사내벤처는 별도 직급체계를 씁니다. 그 외에는 목록에서 골라 주세요.
                      </p>
                    </>
                  ) : (
                    <p className="mt-1 text-[14px] text-slate-500">괄호 안은 대외 문서용 대응 직급입니다.</p>
                  )}
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-title">직책</Label>
                  <Input
                    id="hr-title" className="mt-1.5 h-10" value={form.title} disabled={!canWritePerson || saving}
                    placeholder="예: 팀장" onChange={(event) => setForm({ ...form, title: event.target.value })}
                  />
                  <p className="mt-1 text-[14px] text-slate-500">직급과 다른 축입니다. 맡은 역할을 적습니다.</p>
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-email">이메일</Label>
                  <Input
                    id="hr-email" className="mt-1.5 h-10" value={form.email} disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, email: event.target.value })}
                  />
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-dept-top">대분류</Label>
                  {/* 선택지는 설정 > 조직에서 온다. 지금 저장된 값이 목록에 없어도 지우지 않고 남긴다. */}
                  <select
                    id="hr-dept-top"
                    className="mt-1.5 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-[14px] disabled:opacity-50"
                    value={form.departmentTop} disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, departmentTop: event.target.value, departmentMid: '' })}
                  >
                    <option value="">미지정</option>
                    {optionsWithCurrentValue(groupOptions, form.departmentTop).map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-dept-mid">중분류</Label>
                  <select
                    id="hr-dept-mid"
                    className="mt-1.5 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-[14px] disabled:opacity-50"
                    value={form.departmentMid} disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, departmentMid: event.target.value })}
                  >
                    <option value="">미지정</option>
                    {optionsWithCurrentValue(teamOptions, form.departmentMid).map((option) => (
                      <option key={option} value={option}>{option}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label className="text-[14px]" htmlFor="hr-location">근무지</Label>
                  <Input
                    id="hr-location" className="mt-1.5 h-10" value={form.workLocation} disabled={!canWritePerson || saving}
                    onChange={(event) => setForm({ ...form, workLocation: event.target.value })}
                  />
                </div>
              </div>

              {/* ── 휴직·퇴사 ── 입사일 옆 칸에 그대로 나타난다. */}
              <div className="rounded-md border border-slate-300 bg-white">
                <header className="flex items-center gap-1.5 border-b-2 border-slate-300 bg-slate-100 px-3 py-2.5">
                  <CalendarClock className="h-4 w-4 text-slate-500" aria-hidden />
                  <h4 className="text-[14px] font-semibold text-slate-700">휴직 · 퇴사</h4>
                </header>
                <div className="px-3 py-3">
                  <p className="text-[14px] text-slate-600">
                    현재 <span className="font-medium text-slate-900">{statusText}</span>
                    {leaveOrSeparation
                      ? ` · ${formatDate(leaveOrSeparation.date)} ${leaveOrSeparation.kind === 'LEAVE' ? '휴직 시작' : '퇴사'}`
                      : ''}
                  </p>
                  {canWritePerson && current ? (
                    <div className="mt-3 grid gap-3 sm:grid-cols-[220px_200px_auto] sm:items-end">
                      <div>
                        <Label className="text-[14px]" htmlFor="hr-leave-state">구분</Label>
                        <select
                          id="hr-leave-state" value={leaveState} disabled={leaveSaving}
                          onChange={(event) => setLeaveState(event.target.value as LeaveChoice)}
                          className="mt-1.5 h-10 w-full rounded-md border border-slate-300 bg-white px-2 text-[14px] text-slate-800"
                        >
                          <option value="ON_LEAVE">휴직</option>
                          <option value="PARENTAL_LEAVE">육아휴직</option>
                          <option value="WORKING">복직</option>
                          <option value="SEPARATED">퇴사</option>
                        </select>
                      </div>
                      <div>
                        <Label className="text-[14px]" htmlFor="hr-leave-date">
                          {leaveState === 'SEPARATED' ? '퇴사일' : leaveState === 'WORKING' ? '복직일' : '휴직 시작일'}
                        </Label>
                        <Input
                          id="hr-leave-date" type="date" className="mt-1.5 h-10" value={leaveDate}
                          disabled={leaveSaving}
                          onChange={(event) => setLeaveDate(event.target.value)}
                        />
                      </div>
                      <Button
                        size="sm" variant="outline" className="h-10"
                        onClick={() => void applyLeave()} disabled={leaveSaving || !leaveDate}
                      >
                        {leaveSaving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                        {leaveSaving ? '기록 중…' : '기록'}
                      </Button>
                    </div>
                  ) : null}
                  {canWritePerson && !current ? (
                    <p className="mt-2 text-[14px] text-slate-500">
                      진행 중인 계약이 없습니다. 계약 이력에서 계약을 먼저 등록해 주세요.
                    </p>
                  ) : null}
                </div>
              </div>

              {canWritePerson ? (
                <div className="flex justify-end">
                  <Button size="sm" onClick={() => void saveProfileFields()} disabled={saving || !dirty}>
                    {saving ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : null}
                    {saving ? '저장 중…' : '인적사항 저장'}
                  </Button>
                </div>
              ) : (
                <p className="text-[14px] text-slate-500">조회 권한만 있어 인적사항을 고칠 수 없습니다.</p>
              )}
            </TabsContent>

            {/* ── 인사정보조회: 학력·어학·자격·계약을 카드로 훑는다 ── */}
            <TabsContent value="records" className="mt-0 space-y-3">
              {!canReadProfile ? (
                <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-4 text-[14px] text-slate-600">
                  학력·어학·자격 정보를 볼 권한이 없습니다. 계약 이력은 상세정보 탭에서 확인할 수 있습니다.
                </p>
              ) : profileLoading ? (
                <p className="py-10 text-center text-[14px] text-slate-500">인사정보를 불러오는 중…</p>
              ) : profileError ? (
                <div className="rounded-md border border-rose-200 bg-white px-3 py-3 text-[14px] text-rose-700" role="alert">
                  <p>{profileError}</p>
                  <Button
                    variant="outline" size="sm" className="mt-2 h-7 gap-1 text-[14px]"
                    onClick={() => setReloadToken((token) => token + 1)}
                  >
                    <RefreshCw className="h-3 w-3" /> 다시 불러오기
                  </Button>
                </div>
              ) : (
                <>
                  <div className="grid gap-3 lg:grid-cols-3">
                    <RecordCard
                      icon={<GraduationCap className="h-3.5 w-3.5" />}
                      title="학력"
                      count={profile?.educationRecords.length || 0}
                    >
                      {(profile?.educationRecords || []).map((record, index) => (
                        <RecordRow
                          key={`${record.attainmentCode}-${index}`}
                          primary={[record.major, record.institutionName].filter(Boolean).join(' · ') || educationLabelOf(record.attainmentCode)}
                          secondary={[
                            educationLabelOf(record.attainmentCode),
                            record.admissionYear || record.degreeYear
                              ? `${record.admissionYear || '?'}~${record.degreeYear || '?'}`
                              : '',
                          ].filter(Boolean).join(' · ')}
                          hasEvidence={!!record.evidence?.path}
                        />
                      ))}
                    </RecordCard>

                    <RecordCard
                      icon={<Languages className="h-3.5 w-3.5" />}
                      title="어학"
                      count={profile?.englishEvidence.length || 0}
                    >
                      {(profile?.englishEvidence || []).map((evidence, index) => (
                        <RecordRow
                          key={`${evidence.testCode}-${index}`}
                          primary={`${englishLabelOf(evidence.testCode, evidence.otherTestName)} ${evidence.resultValue}`}
                          secondary={evidence.testedAt ? `${evidence.testedAt} 취득` : ''}
                          hasEvidence={!!evidence.evidence?.path}
                        />
                      ))}
                    </RecordCard>

                    <RecordCard
                      icon={<Award className="h-3.5 w-3.5" />}
                      title="자격면허"
                      count={profile?.certifications.length || 0}
                    >
                      {(profile?.certifications || []).map((certification) => (
                        <RecordRow
                          key={certification.key}
                          primary={certification.label}
                          secondary={certification.acquiredAt ? `${certification.acquiredAt} 취득` : ''}
                          hasEvidence={!!certification.evidence?.path}
                        />
                      ))}
                    </RecordCard>
                  </div>

                  {canWriteProfile ? (
                    <div className="flex justify-end">
                      <Button variant="outline" size="sm" onClick={onEditProfessionalProfile}>
                        학력·어학·자격 수정
                      </Button>
                    </div>
                  ) : null}
                </>
              )}
            </TabsContent>

            {/* ── 상세정보: 계약 이력 — 참여율의 근거가 되는 기간이다 ── */}
            <TabsContent value="detail" className="mt-0 space-y-3">
              <RecordCard
                icon={<Briefcase className="h-3.5 w-3.5" />}
                title="계약 이력"
                count={person.employments.length}
              >
                <div className="space-y-1.5">
                  {person.employments.map((item) => (
                    <div key={item.id} className="flex flex-wrap items-center gap-2 border-b border-slate-100 py-1.5 last:border-b-0">
                      <span className="text-[13px] tabular-nums text-slate-700">
                        {formatDate(item.startDate)} ~ {formatDate(item.endDate)}
                      </span>
                      <Badge variant="outline" className="text-[13px]">
                        {EMPLOYMENT_TYPE_LABELS[item.type as EmploymentType]}
                      </Badge>
                      <Badge variant="outline" className="text-[13px]">
                        {EMPLOYMENT_STATE_LABELS[item.state as EmploymentState]}
                      </Badge>
                      {item.note ? <span className="text-[14px] text-slate-500">{item.note}</span> : null}
                    </div>
                  ))}
                </div>
              </RecordCard>
              <p className="text-[14px] text-slate-500">
                계약 이력은 지우지 않고 쌓습니다 — 지난 기간의 참여율이 왜 그 기준이었는지 설명할 근거가 남아야 합니다.
              </p>
              {canWritePerson ? (
                <div className="flex justify-end">
                  <Button variant="outline" size="sm" onClick={onManageEmployment}>계약 변경·추가</Button>
                </div>
              ) : null}
            </TabsContent>
          </div>
        </Tabs>

        <div className="flex justify-end border-t border-slate-200 px-7 py-4">
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>닫기</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
