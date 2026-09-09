import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, Briefcase, CalendarClock, IdCard, Plus, RefreshCw, Search, UserPlus, Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { featureFlags } from '../../config/feature-flags';
import { useAuth } from '../../data/auth-store';
import { useAppStore } from '../../data/store';
import { useFirebase } from '../../lib/firebase-context';
import {
  changePersonEmploymentViaBff,
  createPersonViaBff,
  fetchPersonsViaBff,
  type PersonRecord,
} from '../../lib/platform-bff-client';
import {
  deriveTenure,
  EMPLOYMENT_STATE_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  resolveCurrentEmployment,
  resolveLeaveOrSeparation,
  resolveSeparationDate,
  type EmploymentState,
  type EmploymentType,
  type Person,
  deriveAge,
  deriveYearsSinceDegree,
} from '../../platform/person-employment';
import { normalizeProjectTeamMembers } from '../../platform/project-team-members';
import {
  ANY,
  collectFilterOptions,
  emptyPeopleFilter,
  filterPeopleRows,
  isPeopleFilterActive,
  type PeopleFilterState,
} from '../../platform/people-directory-filters';
import { PageHeader } from '../layout/PageHeader';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent } from '../ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '../ui/dialog';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { Separator } from '../ui/separator';
import {
  DataGrid, DataGridBody, DataGridCell, DataGridEmpty, DataGridGroupCell, DataGridHead,
  DataGridHeadCell, DataGridRow,
} from '../ui/data-grid';
import { PersonHrConsole } from './PersonHrConsole';
import {
  NewPersonProfessionalProfileFields,
  ProfessionalProfileEditor,
} from './ProfessionalProfileEditor';
import { RosterPushPanel } from './RosterPushPanel';
import type { ProfessionalProfileInput } from '../../lib/person-professional-profile-client';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

const TYPE_TONE: Record<EmploymentType, string> = {
  FULL_TIME: 'border-slate-300 bg-white text-slate-700',
  INTERN: 'border-sky-200 bg-sky-50 text-sky-700',
  PARTNER: 'border-amber-200 bg-amber-50 text-amber-800',
  PLACEHOLDER: 'border-dashed border-slate-300 bg-slate-50 text-slate-500',
};

const STATE_TONE: Record<EmploymentState, string> = {
  WORKING: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  ON_LEAVE: 'border-amber-200 bg-amber-50 text-amber-800',
  PARENTAL_LEAVE: 'border-amber-200 bg-amber-50 text-amber-800',
};

function formatDate(value: string | null): string {
  if (!value) return '진행 중';
  const [year, month, day] = value.split('-');
  return `${year}.${month}.${day}`;
}

/** 프로젝트에 이름이 있는데 명부에 없는 사람 — 유령 배정. 이름으로만 맞춰볼 수 있다. */
function findUnregisteredAssignees(
  projects: ReturnType<typeof useAppStore>['projects'],
  people: PersonRecord[],
) {
  const known = new Set(people.map((person) => `${person.name}|${person.nickname}`.replace(/\s/g, '')));
  const knownNames = new Set(people.map((person) => person.name.replace(/\s/g, '')));
  const found = new Map<string, { name: string; nickname: string; projects: string[]; totalRate: number }>();

  projects.forEach((project) => {
    normalizeProjectTeamMembers(project.teamMembersDetailed).forEach((member) => {
      const name = String(member.memberName || '').trim();
      if (!name) return;
      const key = `${name}|${member.memberNickname || ''}`.replace(/\s/g, '');
      if (known.has(key) || knownNames.has(name.replace(/\s/g, ''))) return;
      const entry = found.get(key) || {
        name, nickname: member.memberNickname || '', projects: [], totalRate: 0,
      };
      entry.projects.push(project.shortName || project.name);
      entry.totalRate += member.participationRate || 0;
      found.set(key, entry);
    });
  });

  return [...found.values()].sort((a, b) => b.totalRate - a.totalRate);
}

interface EmploymentDraft {
  mode: 'change' | 'add';
  type: EmploymentType;
  state: EmploymentState;
  effectiveFrom: string;
  endDate: string;
  note: string;
}

function emptyDraft(mode: 'change' | 'add' = 'change'): EmploymentDraft {
  return { mode, type: 'PARTNER', state: 'WORKING', effectiveFrom: today(), endDate: '', note: '' };
}

function EmploymentForm({
  draft, onChange, disabled,
}: {
  draft: EmploymentDraft;
  onChange: (next: EmploymentDraft) => void;
  disabled: boolean;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div>
        <Label className="text-[13px]">근로형태</Label>
        <Select
          value={draft.type}
          onValueChange={(value) => onChange({ ...draft, type: value as EmploymentType })}
          disabled={disabled}
        >
          <SelectTrigger className="mt-1.5 h-10 text-[14px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(EMPLOYMENT_TYPE_LABELS) as EmploymentType[]).map((type) => (
              <SelectItem key={type} value={type}>{EMPLOYMENT_TYPE_LABELS[type]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-[13px]">재직상태</Label>
        <Select
          value={draft.state}
          onValueChange={(value) => onChange({ ...draft, state: value as EmploymentState })}
          disabled={disabled}
        >
          <SelectTrigger className="mt-1.5 h-10 text-[14px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {(Object.keys(EMPLOYMENT_STATE_LABELS) as EmploymentState[]).map((state) => (
              <SelectItem key={state} value={state}>{EMPLOYMENT_STATE_LABELS[state]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-[13px]">적용일</Label>
        <Input
          type="date" className="mt-1.5 h-10 text-[14px]" value={draft.effectiveFrom} disabled={disabled}
          onChange={(event) => onChange({ ...draft, effectiveFrom: event.target.value })}
        />
        <p className="mt-1 text-[11px] text-slate-500">이 날부터 새 계약이 적용됩니다.</p>
      </div>
      <div>
        <Label className="text-[13px]">종료일 <span className="text-slate-400">(선택)</span></Label>
        <Input
          type="date" className="mt-1.5 h-10 text-[14px]" value={draft.endDate} disabled={disabled}
          onChange={(event) => onChange({ ...draft, endDate: event.target.value })}
        />
        <p className="mt-1 text-[11px] text-slate-500">비워두면 진행 중인 계약이 됩니다.</p>
      </div>
      <div className="sm:col-span-2">
        <Label className="text-[13px]">사유 <span className="text-slate-400">(선택)</span></Label>
        <Input
          className="mt-1.5 h-10 text-[14px]" value={draft.note} disabled={disabled}
          placeholder="예: 퇴사 후 파트너 전환"
          onChange={(event) => onChange({ ...draft, note: event.target.value })}
        />
      </div>
    </div>
  );
}

/** 소속·직위 묶음의 열 개수. 열을 더할 때 여기만 고치면 그룹 머리가 따라온다. */
function countCompanyColumns(): number {
  return 8;
}

interface PersonRow {
  person: PersonRecord;
  current: ReturnType<typeof resolveCurrentEmployment>;
  separatedAt: string | null;
  tenure: ReturnType<typeof deriveTenure>;
  leave: ReturnType<typeof resolveLeaveOrSeparation>;
}

/**
 * 인력 표. 근로형태 열은 두지 않는다 — 이름 옆에 붙는 신분 표시가 되기 때문이다.
 * 계약 형태가 필요한 자리는 계약 관리 다이얼로그뿐이고, 거기서는 그대로 보인다.
 */
function FilterSelect({ label, value, onChange, options }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: Array<[string, string]>;
}) {
  return (
    <label className="grid gap-0.5 text-[10px] font-medium text-slate-500">
      <span>{label}</span>
      <select
        className="h-8 rounded-md border border-slate-300 bg-white px-1.5 text-[12px] text-slate-800"
        value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}
      >
        <option value={ANY}>전체</option>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>{optionLabel}</option>
        ))}
      </select>
    </label>
  );
}

function FilterNumber({ label, placeholder, value, onChange }: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="grid gap-0.5 text-[10px] font-medium text-slate-500">
      <span>{label}</span>
      <Input
        className="h-8 w-16 text-[12px] tabular-nums" inputMode="numeric" placeholder={placeholder}
        value={value} aria-label={label}
        onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, 3))}
      />
    </label>
  );
}

/** 값 아래에 붙는 파생 줄. 근속·만 나이처럼 계산된 값은 옆이 아니라 아래로 내린다. */
function SubLine({ children }: { children: ReactNode }) {
  return <span className="block text-[10px] leading-tight text-slate-400">{children}</span>;
}

function PeopleTable({ rows, loading, onOpen, canReadProfile, asOf }: {
  rows: PersonRow[];
  loading: boolean;
  onOpen: (person: PersonRecord) => void;
  canReadProfile: boolean;
  asOf: string;
}) {
  // 열 수를 손으로 세면 틀린다 - 빈 상태가 한 칸 모자라게 걸쳐지는 식으로.
  const columnCount = canReadProfile ? 15 : 11;

  return (
    <DataGrid minWidth={canReadProfile ? 1480 : 1000}>
      <DataGridHead
        groups={<>
          <DataGridGroupCell rowSpan={2} sticky>이름</DataGridGroupCell>
          <DataGridGroupCell span={2}>개인</DataGridGroupCell>
          <DataGridGroupCell span={6}>소속 · 직위</DataGridGroupCell>
          {canReadProfile ? <DataGridGroupCell span={4}>학력 · 자격</DataGridGroupCell> : null}
          <DataGridGroupCell span={2} last>관리</DataGridGroupCell>
        </>}
      >
        <DataGridHeadCell width="min-w-[64px]">별명</DataGridHeadCell>
        <DataGridHeadCell align="center" width="min-w-[86px]">생년월일</DataGridHeadCell>
        <DataGridHeadCell align="center" width="min-w-[86px]">입사일</DataGridHeadCell>
        <DataGridHeadCell align="center" width="min-w-[86px]">휴직·퇴사</DataGridHeadCell>
        <DataGridHeadCell width="min-w-[92px]">대분류</DataGridHeadCell>
        <DataGridHeadCell width="min-w-[80px]">중분류</DataGridHeadCell>
        <DataGridHeadCell width="min-w-[64px]">직책</DataGridHeadCell>
        <DataGridHeadCell width="min-w-[76px]">직급</DataGridHeadCell>
        {canReadProfile ? <>
          <DataGridHeadCell width="min-w-[124px]">최종학력</DataGridHeadCell>
          <DataGridHeadCell align="center" width="min-w-[62px]">학위취득</DataGridHeadCell>
          <DataGridHeadCell width="min-w-[86px]">어학능력</DataGridHeadCell>
          <DataGridHeadCell width="min-w-[86px]">자격증</DataGridHeadCell>
        </> : null}
        <DataGridHeadCell align="center" width="w-12">인사</DataGridHeadCell>
        <DataGridHeadCell align="center" width="min-w-[70px]" last>재직상태</DataGridHeadCell>
      </DataGridHead>
      <DataGridBody>
        {rows.length === 0 ? (
          <DataGridEmpty
            colSpan={columnCount}
            loading={loading}
            message="조건에 맞는 인력이 없습니다"
          />
        ) : rows.map(({ person, current, separatedAt, tenure, leave }) => (
          <DataGridRow key={person.personId} onClick={() => onOpen(person)}>
            <DataGridCell sticky>
              <span className="font-semibold">{person.name}</span>
              {/* 이메일은 열을 따로 두지 않고 이름 아래로 - 값이 길어 가로를 제일 많이 먹는다. */}
              {person.email ? <SubLine>{person.email.split('@')[0]}</SubLine> : null}
            </DataGridCell>
            <DataGridCell muted>{person.nickname || '-'}</DataGridCell>
            {/* 만 나이·근속·학위 후 경력은 저장값이 아니라 오늘 기준 계산이다. */}
            <DataGridCell align="center" muted>
              {person.birthDate ? <>
                {formatDate(person.birthDate)}
                <SubLine>만 {deriveAge(person.birthDate, asOf) ?? '-'}세</SubLine>
              </> : '-'}
            </DataGridCell>
            <DataGridCell align="center" muted>
              {formatDate(person.joinedAt)}
              {tenure ? <SubLine>{tenure.label}</SubLine> : null}
            </DataGridCell>
            {/* 휴직인지 퇴사인지 라벨 없이 날짜만 두면 읽는 사람이 구분할 수 없다. */}
            <DataGridCell align="center" muted>
              {leave ? <>
                {formatDate(leave.date)}
                <SubLine>{leave.kind === 'LEAVE' ? '휴직' : '퇴사'}</SubLine>
              </> : '-'}
            </DataGridCell>
            <DataGridCell muted>{person.departmentTop || '-'}</DataGridCell>
            <DataGridCell muted>{person.departmentMid || '-'}</DataGridCell>
            {/* 직급과 직책은 다른 축이다 - 한 칸에 섞으면 둘 다 못 읽는다. */}
            <DataGridCell muted>{person.title || '-'}</DataGridCell>
            <DataGridCell>{person.grade || '-'}</DataGridCell>
            {canReadProfile ? <>
              <DataGridCell className="max-w-[160px]" title={[person.hrSummary?.highestEducationMajor, person.hrSummary?.highestEducationInstitution].filter(Boolean).join(' · ')}>
                {/* 학과를 앞세우고 학교는 아래 작은 줄로 - 전공이 먼저 읽혀야 한다. */}
                <span className="block truncate">{person.hrSummary?.highestEducationDisplayText || '-'}</span>
                {person.hrSummary?.highestEducationInstitution && person.hrSummary?.highestEducationMajor ? (
                  <SubLine>
                    <span className="block truncate">{person.hrSummary.highestEducationInstitution}</span>
                  </SubLine>
                ) : null}
              </DataGridCell>
              <DataGridCell align="center" muted>
                {person.hrSummary?.highestDegreeYear ? <>
                  {person.hrSummary.highestDegreeYear}
                  <SubLine>{deriveYearsSinceDegree(person.hrSummary.highestDegreeYear, asOf)}년차</SubLine>
                </> : '-'}
              </DataGridCell>
              {/* 증빙이 제출된 건만 요약에 들어간다 - 서버가 그렇게 만들어 보낸다. */}
              <DataGridCell className="max-w-[120px]" muted title={person.hrSummary?.englishEvidenceDisplayText || ''}>
                <span className="block truncate">{person.hrSummary?.englishEvidenceDisplayText || '-'}</span>
              </DataGridCell>
              <DataGridCell className="max-w-[120px]" muted title={person.hrSummary?.certificationsDisplayText || ''}>
                <span className="block truncate">{person.hrSummary?.certificationsDisplayText || '-'}</span>
              </DataGridCell>
            </> : null}
            <DataGridCell align="center">
              <Button
                variant="ghost" size="sm" className="h-6 w-6 p-0"
                aria-label={`${person.name} 인사정보`}
                onClick={(event) => {
                  event.stopPropagation();
                  onOpen(person);
                }}
              >
                <IdCard className="h-3.5 w-3.5" />
              </Button>
            </DataGridCell>
            <DataGridCell align="center" last>
              {current ? (
                <Badge variant="outline" className={`px-1.5 py-0 text-[10px] ${STATE_TONE[current.state as EmploymentState]}`}>
                  {EMPLOYMENT_STATE_LABELS[current.state as EmploymentState]}
                </Badge>
              ) : (
                <span className="text-[10px] text-slate-500">{separatedAt ? `${formatDate(separatedAt)} 종료` : '계약 종료'}</span>
              )}
            </DataGridCell>
          </DataGridRow>
        ))}
      </DataGridBody>
    </DataGrid>
  );
}

export function PeopleDirectoryPage() {
  const { user: authUser } = useAuth();
  const { orgId } = useFirebase();
  const { projects } = useAppStore();
  const authUserRef = useRef(authUser);
  authUserRef.current = authUser;

  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState('');
  const [typeFilter, setTypeFilter] = useState<'ALL' | EmploymentType | 'SEPARATED'>('ALL');
  const [filter, setFilter] = useState<PeopleFilterState>(emptyPeopleFilter);
  const [selected, setSelected] = useState<PersonRecord | null>(null);
  const [profilePerson, setProfilePerson] = useState<PersonRecord | null>(null);
  const [hrPerson, setHrPerson] = useState<PersonRecord | null>(null);
  const [profileCapabilities, setProfileCapabilities] = useState({ read: false, write: false });
  const [draft, setDraft] = useState<EmploymentDraft>(emptyDraft());
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [newPerson, setNewPerson] = useState({ name: '', nickname: '', departmentTop: '', title: '' });
  const [newProfessionalProfile, setNewProfessionalProfile] = useState<ProfessionalProfileInput | null>(null);
  const [newProfessionalProfileValid, setNewProfessionalProfileValid] = useState(true);
  const peopleLoadSequenceRef = useRef(0);
  const peopleLoadControllerRef = useRef<AbortController | null>(null);
  const loadedDirectoryScopeRef = useRef<string | null>(null);
  const createAttemptRef = useRef<{ fingerprint: string; key: string } | null>(null);
  const mutationSequenceRef = useRef(0);

  const actorReady = Boolean(authUser?.idToken);
  const directoryScopeKey = `${orgId}\u0000${authUser?.uid || ''}\u0000${authUser?.role || ''}\u0000${actorReady ? 'ready' : 'not-ready'}`;
  const directoryScopeRef = useRef(directoryScopeKey);
  directoryScopeRef.current = directoryScopeKey;
  const enabled = featureFlags.platformApiEnabled && actorReady;
  const asOf = today();
  const directoryScopeLoaded = loadedDirectoryScopeRef.current === directoryScopeKey;
  const scopedPeople = directoryScopeLoaded ? people : [];
  // 인적사항 수정은 명부 쓰기 역할이 한다. 최종 판단은 BFF 가 하고 화면은 미리 가린다.
  const canWritePersonProfile = ['admin', 'tenant_admin', 'finance'].includes(String(authUser?.role || ''));
  const scopedProfileCapabilities = directoryScopeLoaded
    ? profileCapabilities
    : { read: false, write: false };

  const load = async () => {
    if (directoryScopeRef.current !== directoryScopeKey) return;
    peopleLoadControllerRef.current?.abort();
    peopleLoadControllerRef.current = null;
    const sequence = peopleLoadSequenceRef.current + 1;
    peopleLoadSequenceRef.current = sequence;
    loadedDirectoryScopeRef.current = null;
    setError(null);
    setPeople([]);
    setProfileCapabilities({ read: false, write: false });
    setProfilePerson(null);
    setNewProfessionalProfile(null);
    const actor = authUserRef.current;
    if (!actor || !actor.idToken || !featureFlags.platformApiEnabled) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    peopleLoadControllerRef.current = controller;
    setLoading(true);
    try {
      const response = await fetchPersonsViaBff({
        tenantId: orgId,
        actor,
        signal: controller.signal,
      });
      if (directoryScopeRef.current !== directoryScopeKey
        || sequence !== peopleLoadSequenceRef.current || controller.signal.aborted) return;
      const professionalProfileRead = response.capabilities
        && response.capabilities.professionalProfileRead === true;
      const professionalProfileWrite = response.capabilities
        && response.capabilities.professionalProfileWrite === true;
      loadedDirectoryScopeRef.current = directoryScopeKey;
      setPeople(response.items);
      setProfileCapabilities({ read: professionalProfileRead, write: professionalProfileWrite });
      if (!professionalProfileRead) setProfilePerson(null);
      if (!professionalProfileWrite) setNewProfessionalProfile(null);
    } catch (err: any) {
      if (directoryScopeRef.current !== directoryScopeKey
        || sequence !== peopleLoadSequenceRef.current || controller.signal.aborted) return;
      setProfileCapabilities({ read: false, write: false });
      setProfilePerson(null);
      setNewProfessionalProfile(null);
      loadedDirectoryScopeRef.current = directoryScopeKey;
      setError(err?.message || '인력 명부를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      if (directoryScopeRef.current === directoryScopeKey
        && sequence === peopleLoadSequenceRef.current && !controller.signal.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    mutationSequenceRef.current += 1;
    setSaving(false);
    setSelected(null);
    setSearchText('');
    setNewPerson({ name: '', nickname: '', departmentTop: '', title: '' });
    setDraft(emptyDraft());
    setAddOpen(false);
    setNewProfessionalProfile(null);
    setNewProfessionalProfileValid(true);
    createAttemptRef.current = null;
    void load();
    return () => {
      peopleLoadSequenceRef.current += 1;
      peopleLoadControllerRef.current?.abort();
    };
  }, [orgId, authUser?.uid, authUser?.role, actorReady]);

  const rows = useMemo(() => {
    const built = scopedPeople.map((person) => {
      const current = resolveCurrentEmployment(person as unknown as Person, asOf);
      return {
        person,
        current,
        separatedAt: current ? null : resolveSeparationDate(person as unknown as Person),
        tenure: deriveTenure(person.joinedAt, asOf),
        leave: resolveLeaveOrSeparation(person as unknown as Person, asOf),
      };
    });
    // 검색·계약 종료 버튼과 칸별 필터를 한 곳에서 건다. 나이·근속·학위 후 경력은
    // 저장값이 아니라 오늘 기준 계산이라 화면 숫자와 필터 결과가 늘 같다.
    const merged = { ...filter, search: searchText, status: typeFilter === 'SEPARATED' ? 'SEPARATED' : filter.status };
    // 기본 정렬은 입사순이다. 가나다순은 조직에서 누가 오래 다녔는지를 못 읽게 한다.
    // 입사일이 없는 사람은 뒤로 보내고 그 안에서만 이름순으로 정리한다.
    return filterPeopleRows(built, merged, asOf).sort((left, right) => {
      const leftJoined = String(left.person.joinedAt || '');
      const rightJoined = String(right.person.joinedAt || '');
      if (leftJoined && rightJoined && leftJoined !== rightJoined) return leftJoined.localeCompare(rightJoined);
      if (leftJoined !== rightJoined) return leftJoined ? -1 : 1;
      return left.person.name.localeCompare(right.person.name, 'ko');
    });
  }, [scopedPeople, searchText, typeFilter, filter, asOf]);

  // 근로형태는 이름 옆에 붙는 신분 표시라 목록에서 보여주지 않는다. 인턴은 섞지 않고
  // 아래 별도 표로 뗀다 - 한 표에 두면 근로형태를 가려도 순서와 빈칸으로 드러난다.
  // 계약을 바꾸는 자리(계약 관리)에서는 그대로 보인다. 거기서는 필요한 정보다.
  const mainRows = useMemo(
    () => rows.filter((row) => row.current?.type !== 'INTERN'),
    [rows],
  );
  const internRows = useMemo(
    () => rows.filter((row) => row.current?.type === 'INTERN'),
    [rows],
  );

  const filterOptions = useMemo(() => collectFilterOptions(scopedPeople), [scopedPeople]);
  const educationOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const person of scopedPeople) {
      const code = String(person.hrSummary?.highestEducationCode || '').trim();
      const text = String(person.hrSummary?.highestEducationDisplayText || '').split(' · ')[0];
      if (code && !seen.has(code)) seen.set(code, text || code);
    }
    return [...seen.entries()].sort((left, right) => left[1].localeCompare(right[1], 'ko'));
  }, [scopedPeople]);

  const counts = useMemo(() => {
    const base = { MAIN: 0, INTERN: 0, SEPARATED: 0 };
    scopedPeople.forEach((person) => {
      const current = resolveCurrentEmployment(person as unknown as Person, asOf);
      if (!current) base.SEPARATED += 1;
      else if (current.type === 'INTERN') base.INTERN += 1;
      else base.MAIN += 1;
    });
    return base;
  }, [scopedPeople, asOf]);

  const unregistered = useMemo(
    () => (directoryScopeLoaded ? findUnregisteredAssignees(projects, scopedPeople) : []),
    [directoryScopeLoaded, projects, scopedPeople],
  );

  const openPerson = (person: PersonRecord) => {
    setHrPerson(person);
  };

  /** 인사정보 콘솔에서 계약 변경으로 넘어가는 자리. 계약 폼은 기존 흐름을 그대로 쓴다. */
  const openEmploymentManager = (person: PersonRecord) => {
    setSelected(person);
    setDraft(emptyDraft('change'));
  };

  const openNewPerson = (prefill = { name: '', nickname: '', departmentTop: '', title: '' }) => {
    setNewPerson(prefill);
    setDraft(emptyDraft('add'));
    setNewProfessionalProfile(null);
    setNewProfessionalProfileValid(true);
    setAddOpen(true);
  };

  const submitEmployment = async () => {
    if (!authUser || !selected) return;
    const submitScope = directoryScopeKey;
    const mutationSequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = mutationSequence;
    setSaving(true);
    try {
      const result = await changePersonEmploymentViaBff({
        tenantId: orgId,
        actor: authUser,
        personId: selected.personId,
        mode: draft.mode,
        type: draft.type,
        state: draft.state,
        effectiveFrom: draft.effectiveFrom,
        endDate: draft.endDate || null,
        note: draft.note || undefined,
      });
      if (directoryScopeRef.current !== submitScope || mutationSequenceRef.current !== mutationSequence) return;
      const updated = { ...selected, employments: result.employments };
      setPeople((prev) => prev.map((item) => (item.personId === updated.personId ? updated : item)));
      setSelected(updated);
      setDraft(emptyDraft('change'));
      toast.success(`${selected.name}님의 계약을 ${draft.mode === 'add' ? '추가' : '변경'}했습니다.`);
    } catch (err: any) {
      if (directoryScopeRef.current !== submitScope || mutationSequenceRef.current !== mutationSequence) return;
      toast.error(err?.message || '계약을 저장하지 못했습니다.');
    } finally {
      if (directoryScopeRef.current === submitScope && mutationSequenceRef.current === mutationSequence) {
        setSaving(false);
      }
    }
  };

  const submitNewPerson = async (employment: EmploymentDraft) => {
    if (!authUser) return;
    if (!newPerson.name.trim()) { toast.error('이름을 입력해 주세요.'); return; }
    const personPayload = {
      name: newPerson.name.trim(),
      nickname: newPerson.nickname.trim(),
      departmentTop: newPerson.departmentTop.trim(),
      title: newPerson.title.trim(),
      employment: {
        type: employment.type,
        state: employment.state,
        effectiveFrom: employment.effectiveFrom,
        endDate: employment.endDate || null,
        note: employment.note || undefined,
      },
      ...(newProfessionalProfile ? { professionalProfile: newProfessionalProfile } : {}),
    };
    const fingerprint = JSON.stringify(personPayload);
    if (createAttemptRef.current?.fingerprint !== fingerprint) {
      createAttemptRef.current = {
        fingerprint,
        key: `person-create:${crypto.randomUUID()}`,
      };
    }
    const submitScope = directoryScopeKey;
    const mutationSequence = mutationSequenceRef.current + 1;
    mutationSequenceRef.current = mutationSequence;
    setSaving(true);
    try {
      await createPersonViaBff({
        tenantId: orgId,
        actor: authUser,
        idempotencyKey: createAttemptRef.current.key,
        person: personPayload,
      });
      if (directoryScopeRef.current !== submitScope || mutationSequenceRef.current !== mutationSequence) return;
      createAttemptRef.current = null;
      toast.success(`${newPerson.name}님을 명부에 등록했습니다.`);
      setAddOpen(false);
      setNewPerson({ name: '', nickname: '', departmentTop: '', title: '' });
      setNewProfessionalProfile(null);
      setNewProfessionalProfileValid(true);
      await load();
    } catch (err: any) {
      if (directoryScopeRef.current !== submitScope || mutationSequenceRef.current !== mutationSequence) return;
      toast.error(err?.message || '인력을 등록하지 못했습니다.');
    } finally {
      if (directoryScopeRef.current === submitScope && mutationSequenceRef.current === mutationSequence) {
        setSaving(false);
      }
    }
  };

  if (!enabled) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={Users}
          iconGradient="linear-gradient(135deg, #0176d3 0%, #2e844a 100%)"
          title="인력 명부"
          description="재직자·인턴·파트너를 한 곳에서 관리합니다"
        />
        <Card><CardContent className="py-10 text-center text-sm text-slate-600">
          인력 명부는 플랫폼 서버에 연결된 환경에서만 사용할 수 있습니다.
        </CardContent></Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Users}
        iconGradient="linear-gradient(135deg, #0176d3 0%, #2e844a 100%)"
        title="인력 명부"
        description="재직자·인턴·파트너를 한 곳에서 관리합니다. 참여율과 정산 서류가 이 명부를 근거로 삼습니다."
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative max-w-xs flex-1">
          <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="h-8 pl-9 text-[13px]" placeholder="이름·별명·대분류 검색…"
            value={directoryScopeLoaded ? searchText : ''}
            onChange={(event) => setSearchText(event.target.value)}
          />
        </div>
        {/* 근로형태별 필터를 없앴다. 필터를 누르는 것만으로도 누가 어느 형태인지 드러난다. */}
        {([
          ['ALL', `전체 ${counts.MAIN + counts.INTERN}`],
          ['SEPARATED', `계약 종료 ${counts.SEPARATED}`],
        ] as const).map(([value, label]) => (
          <Button
            key={value} size="sm" className="h-7 px-2.5 text-xs"
            variant={typeFilter === value ? 'default' : 'outline'}
            onClick={() => setTypeFilter(value as typeof typeFilter)}
          >
            {label}
          </Button>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => void load()} disabled={loading || !directoryScopeLoaded}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} /> 새로고침
          </Button>
          <Button size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openNewPerson()}>
            <UserPlus className="h-3.5 w-3.5" /> 인력 등록
          </Button>
        </div>
      </div>

      {/* ── 칸별 필터: 적정 대상을 빠르게 좁힌다 ── */}
      <div className="flex flex-wrap items-end gap-1.5 rounded-lg border border-slate-200 bg-white px-2.5 py-2">
        <FilterSelect
          label="재직상태" value={filter.status} onChange={(value) => setFilter({ ...filter, status: value })}
          options={[['WORKING', '재직'], ['ON_LEAVE', '휴직'], ['PARENTAL_LEAVE', '육아휴직'], ['SEPARATED', '계약 종료']]}
        />
        <FilterSelect
          label="대분류" value={filter.departmentTop} onChange={(value) => setFilter({ ...filter, departmentTop: value })}
          options={filterOptions.departmentTop.map((option) => [option, option])}
        />
        <FilterSelect
          label="중분류" value={filter.departmentMid} onChange={(value) => setFilter({ ...filter, departmentMid: value })}
          options={filterOptions.departmentMid.map((option) => [option, option])}
        />
        <FilterSelect
          label="직급" value={filter.grade} onChange={(value) => setFilter({ ...filter, grade: value })}
          options={filterOptions.grade.map((option) => [option, option])}
        />
        <FilterSelect
          label="직책" value={filter.title} onChange={(value) => setFilter({ ...filter, title: value })}
          options={filterOptions.title.map((option) => [option, option])}
        />
        {scopedProfileCapabilities.read ? (
          <FilterSelect
            label="최종학력" value={filter.educationCode} onChange={(value) => setFilter({ ...filter, educationCode: value })}
            options={educationOptions}
          />
        ) : null}
        <FilterNumber
          label="만 나이" placeholder="최소" value={filter.ageMin}
          onChange={(value) => setFilter({ ...filter, ageMin: value })}
        />
        <FilterNumber
          label="~" placeholder="최대" value={filter.ageMax}
          onChange={(value) => setFilter({ ...filter, ageMax: value })}
        />
        <FilterNumber
          label="근속(년) 이상" placeholder="예: 3" value={filter.tenureMinYears}
          onChange={(value) => setFilter({ ...filter, tenureMinYears: value })}
        />
        {scopedProfileCapabilities.read ? (
          <FilterNumber
            label="학위 후(년) 이상" placeholder="예: 5" value={filter.degreeYearsMin}
            onChange={(value) => setFilter({ ...filter, degreeYearsMin: value })}
          />
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{rows.length}명</span>
          {isPeopleFilterActive(filter) ? (
            <Button variant="outline" size="sm" className="h-9 text-sm" onClick={() => setFilter(emptyPeopleFilter())}>
              필터 초기화
            </Button>
          ) : null}
        </div>
      </div>

      {directoryScopeLoaded && error ? (
        <Card className="border-rose-200 bg-rose-50">
          <CardContent className="py-4 text-sm text-rose-800">{error}</CardContent>
        </Card>
      ) : null}

      {unregistered.length > 0 ? (
        <Card className="border-amber-300 bg-amber-50/60">
          <CardContent className="py-4">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
              <div className="flex-1">
                <p className="text-sm font-semibold text-amber-900">
                  사업에 배정됐지만 명부에 없는 인력 {unregistered.length}명
                </p>
                <p className="mt-0.5 text-xs text-amber-800">
                  참여율은 차지하는데 근거가 되는 계약이 없습니다. 아래에서 등록하면 계약 기간 기준으로 참여율을 판정할 수 있습니다.
                </p>
                <div className="mt-3 space-y-1.5">
                  {unregistered.map((item) => (
                    <div key={`${item.name}-${item.nickname}`} className="flex flex-wrap items-center gap-2 text-xs">
                      <span className="font-semibold text-amber-900">
                        {item.name}{item.nickname ? `(${item.nickname})` : ''}
                      </span>
                      <span className="tabular-nums text-amber-800">합계 {item.totalRate}%</span>
                      <span className="text-amber-700">{item.projects.join(' · ')}</span>
                      <Button
                        size="sm" variant="outline"
                        className="h-6 gap-1 border-amber-300 bg-white px-2 text-[11px] text-amber-900"
                        onClick={() => {
                          openNewPerson({ name: item.name, nickname: item.nickname, departmentTop: '', title: '' });
                        }}
                      >
                        <Plus className="h-3 w-3" /> 명부에 등록
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <PeopleTable
        rows={mainRows} loading={loading || !directoryScopeLoaded} onOpen={openPerson}
        canReadProfile={scopedProfileCapabilities.read} asOf={asOf}
      />

      {internRows.length > 0 || counts.INTERN > 0 ? (
        <section className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13px] font-semibold text-slate-900">인턴</h2>
            <span className="text-[11px] tabular-nums text-slate-500">{counts.INTERN}명</span>
          </div>
          <PeopleTable
            rows={internRows} loading={loading || !directoryScopeLoaded} onOpen={openPerson}
            canReadProfile={scopedProfileCapabilities.read} asOf={asOf}
          />
        </section>
      ) : null}

      <p className="text-[11px] text-slate-500">
        근속은 입사일과 오늘({asOf}) 기준으로 매번 다시 계산합니다. 계약 이력은 지우지 않고 쌓습니다 —
        지난 기간의 참여율이 왜 그 기준이었는지 설명할 근거가 남아야 하기 때문입니다.
      </p>

      {/* ── 참여율 시트 명단 동기화: 명부를 고쳤으면 시트에 미는 것까지가 한 동선 ── */}
      {authUser ? <RosterPushPanel orgId={orgId} actor={authUser} /> : null}

      {/* ── 계약 관리 ── */}
      <Dialog open={!!selected && directoryScopeLoaded} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="flex max-h-[92vh] w-[92vw] max-w-[980px] flex-col overflow-hidden sm:max-w-[980px]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Briefcase className="h-4 w-4" />
              {selected?.name}{selected?.nickname ? `(${selected.nickname})` : ''} — 계약 관리
            </DialogTitle>
            <DialogDescription>
              {selected?.departmentTop || '대분류 미지정'}
              {selected?.grade ? ` · ${selected.grade}` : ''}
              {selected?.joinedAt ? ` · 입사 ${formatDate(selected.joinedAt)}` : ''}
            </DialogDescription>
          </DialogHeader>

          <div className="-mx-6 flex-1 overflow-y-auto px-6">
            <h4 className="text-[12px] font-semibold text-slate-700">계약 이력</h4>
            <div className="mt-2 space-y-1.5">
              {(selected?.employments || []).map((item) => (
                <div key={item.id} className="flex flex-wrap items-center gap-2 rounded-md border bg-white px-3 py-2 text-xs">
                  <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
                  <span className="tabular-nums text-slate-700">
                    {formatDate(item.startDate)} ~ {formatDate(item.endDate)}
                  </span>
                  <Badge variant="outline" className={`text-[10px] ${TYPE_TONE[item.type as EmploymentType]}`}>
                    {EMPLOYMENT_TYPE_LABELS[item.type as EmploymentType]}
                  </Badge>
                  <Badge variant="outline" className={`text-[10px] ${STATE_TONE[item.state as EmploymentState]}`}>
                    {EMPLOYMENT_STATE_LABELS[item.state as EmploymentState]}
                  </Badge>
                  {item.note ? <span className="text-slate-500">{item.note}</span> : null}
                </div>
              ))}
              {(selected?.employments || []).length === 0 ? (
                <p className="text-xs text-slate-500">등록된 계약이 없습니다.</p>
              ) : null}
            </div>

            <Separator className="my-4" />

            <div className="flex items-center gap-2">
              <Button
                size="sm" className="h-7 px-2.5 text-xs"
                variant={draft.mode === 'change' ? 'default' : 'outline'}
                onClick={() => setDraft({ ...draft, mode: 'change' })}
              >
                계약 변경
              </Button>
              <Button
                size="sm" className="h-7 px-2.5 text-xs"
                variant={draft.mode === 'add' ? 'default' : 'outline'}
                onClick={() => setDraft({ ...draft, mode: 'add' })}
              >
                계약 추가
              </Button>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">
              {draft.mode === 'change'
                ? '적용일 직전에 지금 계약을 끝내고 새 계약을 잇습니다. 정규직에서 파트너로 넘어가는 경우가 여기입니다.'
                : '기존 계약을 그대로 두고 겹치지 않는 별도 구간을 끼워 넣습니다. 공백기를 두고 다시 합류하는 경우에 씁니다.'}
            </p>

            <div className="mt-3">
              <EmploymentForm draft={draft} onChange={setDraft} disabled={saving} />
            </div>
          </div>

          <div className="flex justify-end gap-2 border-t pt-3">
            <Button variant="outline" size="sm" onClick={() => setSelected(null)} disabled={saving}>닫기</Button>
            <Button size="sm" onClick={() => void submitEmployment()} disabled={saving}>
              {saving ? '저장 중…' : draft.mode === 'add' ? '계약 추가' : '계약 변경'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── 인사정보: 인적사항·학력/어학/자격·계약 이력을 한 창에서 ── */}
      {hrPerson && directoryScopeLoaded && authUser ? (
        <PersonHrConsole
          tenantId={orgId}
          actor={authUser}
          person={scopedPeople.find((item) => item.personId === hrPerson.personId) || hrPerson}
          canReadProfile={scopedProfileCapabilities.read}
          canWriteProfile={scopedProfileCapabilities.write}
          canWritePerson={canWritePersonProfile}
          asOf={asOf}
          onClose={() => setHrPerson(null)}
          onPersonUpdated={() => { void load(); }}
          onManageEmployment={() => { openEmploymentManager(hrPerson); setHrPerson(null); }}
          onEditProfessionalProfile={() => { setProfilePerson(hrPerson); setHrPerson(null); }}
        />
      ) : null}

      {profilePerson && scopedProfileCapabilities.read && authUser ? (
        <ProfessionalProfileEditor
          tenantId={orgId}
          actor={authUser}
          personId={profilePerson.personId}
          personName={profilePerson.name}
          canWrite={scopedProfileCapabilities.write}
          onClose={() => setProfilePerson(null)}
        />
      ) : null}

      {/* ── 인력 등록 ── */}
      <Dialog
        open={addOpen && directoryScopeLoaded}
        onOpenChange={(open) => {
          if (!open && !saving) {
            setAddOpen(false);
            setNewProfessionalProfile(null);
            setNewProfessionalProfileValid(true);
          }
        }}
      >
        <DialogContent className="max-h-[94vh] w-[94vw] max-w-[1160px] overflow-y-auto sm:max-w-[1160px]">
          <DialogHeader>
            <DialogTitle className="text-base">인력 등록</DialogTitle>
            <DialogDescription>
              재직자 명단(시트)에 없는 인력을 등록합니다. 파트너·외부 인력이나 아직 채용되지 않은 자리가 여기 해당합니다.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="text-[13px]">이름</Label>
              <Input
                className="mt-1.5 h-10 text-[14px]" value={newPerson.name} disabled={saving}
                onChange={(event) => setNewPerson({ ...newPerson, name: event.target.value })}
              />
            </div>
            <div>
              <Label className="text-[13px]">별명 <span className="text-slate-400">(선택)</span></Label>
              <Input
                className="mt-1.5 h-10 text-[14px]" value={newPerson.nickname} disabled={saving}
                onChange={(event) => setNewPerson({ ...newPerson, nickname: event.target.value })}
              />
            </div>
            <div>
              <Label className="text-[13px]">대분류 <span className="text-slate-400">(선택)</span></Label>
              <Input
                className="mt-1.5 h-10 text-[14px]" value={newPerson.departmentTop} disabled={saving}
                onChange={(event) => setNewPerson({ ...newPerson, departmentTop: event.target.value })}
              />
            </div>
            <div>
              <Label className="text-[13px]">직책 <span className="text-slate-400">(선택)</span></Label>
              <Input
                className="mt-1.5 h-10 text-[14px]" value={newPerson.title} disabled={saving}
                onChange={(event) => setNewPerson({ ...newPerson, title: event.target.value })}
              />
            </div>
          </div>

          <Separator className="my-1" />
          <p className="text-[12px] font-semibold text-slate-700">첫 계약</p>
          <EmploymentForm draft={draft} onChange={setDraft} disabled={saving} />

          {scopedProfileCapabilities.write ? (
            <>
              <Separator className="my-1" />
              <NewPersonProfessionalProfileFields
                tenantId={orgId}
                actor={authUser!}
                disabled={saving}
                onChange={(profile, valid) => {
                  setNewProfessionalProfile(profile);
                  setNewProfessionalProfileValid(valid);
                }}
              />
            </>
          ) : null}

          <div className="flex justify-end gap-2 pt-2">
            <Button
              variant="outline" size="sm"
              onClick={() => {
                setAddOpen(false);
                setNewProfessionalProfile(null);
                setNewProfessionalProfileValid(true);
              }}
              disabled={saving}
            >취소</Button>
            <Button size="sm" onClick={() => void submitNewPerson(draft)} disabled={saving || !newProfessionalProfileValid}>
              {saving ? '등록 중…' : '등록'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
