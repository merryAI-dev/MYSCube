import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus, X } from 'lucide-react';
import { featureFlags } from '../../config/feature-flags';
import type { ProjectStaffing, ProjectStaffingOtherRole, ProjectStaffingSlot } from '../../data/types';
import {
  fetchPersonsViaBff,
  fetchProjectStaffingRolesViaBff,
  type PersonRecord,
} from '../../lib/platform-bff-client';
import type { ActorLike } from '../../lib/platform-bff-client';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { MemberPicker } from '../ui/member-picker';
import { cn } from '../ui/utils';
import {
  FIELD_W_MD,
  FIELD_W_SM,
  FIELD_W_XS,
  FORM_CONTROL_CLASS,
  ProjectFormRow,
  ProjectFormSection,
} from './project-form-layout';
import { PROJECT_STAFFING_OTHERS_MAX, PROJECT_STAFFING_ROLE_MAX_LENGTH } from '../../platform/project-editor';
import type { OrgMemberPickerOption } from '../../data/project-team-member-options';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';

/** 미정(비워두기) 선택지의 uid. 인력 명부 personId 와 충돌하지 않는 예약값이다. */
const UNASSIGNED = '__unassigned__';
/** 정산지원 담당 후보. 운영 결정으로 고정된 두 사람이다 - 바뀌면 여기만 고친다. */
const SETTLEMENT_SUPPORT_CHOICES = ['도담', '써니'];
/** 기타 역할명 후보 목록의 datalist id. 한 화면에 이 섹션은 하나뿐이다. */
const ROLE_SUGGESTION_LIST_ID = 'project-staffing-role-suggestions';

function personLabel(person: PersonRecord): string {
  const nickname = String(person.nickname || '').trim();
  const name = String(person.name || '').trim();
  const isPlaceholder = person.employments?.some((employment) => employment.type === 'PLACEHOLDER');
  const base = nickname && name ? `${nickname} · ${name}` : (nickname || name);
  return isPlaceholder ? `${base} (미정 자리)` : base;
}

function toSlot(people: PersonRecord[], personId: string): ProjectStaffingSlot | null {
  if (!personId || personId === UNASSIGNED) return null;
  const person = people.find((item) => item.personId === personId);
  if (!person) return null;
  return {
    personId,
    name: String(person.name || '').trim(),
    nickname: String(person.nickname || '').trim(),
  };
}

/**
 * 실제 투입인력 섹션. 참여율 시트와 독립인 책임 메타데이터를 인력 명부(persons) 기준으로
 * 지정한다. 슬롯을 비워두면 "미정" - 채용 전 자리를 허용한다.
 */
export function ProjectStaffingSection({
  orgId,
  actor,
  staffing,
  submissionResponses = {},
  onChange,
  disabled = false,
}: {
  orgId: string;
  actor: (ActorLike & { idToken?: string }) | null;
  staffing: ProjectStaffing;
  submissionResponses?: Record<string, 'NOT_APPLICABLE'>;
  onChange: (next: ProjectStaffing, responses?: Record<string, 'NOT_APPLICABLE'>) => void;
  disabled?: boolean;
}) {
  const [people, setPeople] = useState<PersonRecord[]>([]);
  const [loadError, setLoadError] = useState('');
  const enabled = featureFlags.platformApiEnabled && Boolean(actor?.idToken);

  useEffect(() => {
    if (!enabled || !orgId || !actor) return;
    let cancelled = false;
    fetchPersonsViaBff({ tenantId: orgId, actor })
      .then((result) => { if (!cancelled) { setPeople(result.items); setLoadError(''); } })
      .catch(() => { if (!cancelled) setLoadError('인력 명부를 불러오지 못했습니다. 저장은 가능하고, 지정만 나중에 하면 됩니다.'); });
    return () => { cancelled = true; };
  }, [enabled, orgId, actor]);

  // 다른 사람이 이미 쓴 역할명. 실패해도 직접 입력은 그대로 되므로 오류를 띄우지 않는다.
  const [roleSuggestions, setRoleSuggestions] = useState<string[]>([]);
  useEffect(() => {
    if (!enabled || !orgId || !actor) return;
    let cancelled = false;
    fetchProjectStaffingRolesViaBff({ tenantId: orgId, actor })
      .then((roles) => { if (!cancelled) setRoleSuggestions(roles); })
      .catch(() => { if (!cancelled) setRoleSuggestions([]); });
    return () => { cancelled = true; };
  }, [enabled, orgId, actor]);

  const options = useMemo<OrgMemberPickerOption[]>(() => {
    const rows = people.map((person) => ({
      uid: person.personId,
      name: String(person.name || ''),
      nickname: String(person.nickname || ''),
      email: '',
      label: personLabel(person),
      searchText: `${person.nickname || ''} ${person.name || ''}`.toLocaleLowerCase('ko-KR'),
    }));
    return [
      { uid: UNASSIGNED, name: '', nickname: '', email: '', label: '미정 (비워두기)', searchText: '미정' },
      ...rows,
    ];
  }, [people]);

  const patch = (partial: Partial<ProjectStaffing>) => onChange({ ...staffing, ...partial });
  const patchOther = (index: number, partial: Partial<ProjectStaffingOtherRole>) => patch({
    others: staffing.others.map((item, itemIndex) => (itemIndex === index ? { ...item, ...partial } : item)),
  });
  // 이미 쓰고 있는 역할명도 후보에 넣는다 - 방금 적은 값이 목록에서 빠지면 오타로 보인다.
  const roleOptions = useMemo(() => {
    const seen = new Set<string>();
    return [...roleSuggestions, ...staffing.others.map((item) => item.role)]
      .map((role) => role.trim())
      .filter((role) => role !== '' && !seen.has(role) && seen.add(role));
  }, [roleSuggestions, staffing.others]);
  // 아직 사람을 안 고른 "빈 운영매니저 줄" 수. 저장 모델(operators)에는 채워진 슬롯만 담기고,
  // 빈 줄은 화면 상태다 - 최소 한 줄은 항상 보여 준다.
  const [emptyOperatorSlots, setEmptyOperatorSlots] = useState(0);
  const operatorSlots: Array<ProjectStaffingSlot | null> = [
    ...staffing.operators,
    ...Array.from({ length: emptyOperatorSlots }, () => null),
  ];
  if (operatorSlots.length === 0) operatorSlots.push(null);

  const picker = (
    slot: ProjectStaffingSlot | null,
    apply: (next: ProjectStaffingSlot | null) => void,
    widthClass: string = FIELD_W_MD,
  ) => (
    <MemberPicker
      className={cn(widthClass, FORM_CONTROL_CLASS)}
      options={options}
      value={slot?.personId || ''}
      placeholder="인력 명부에서 선택 (미정 가능)"
      emptyLabel={loadError || '인력 명부를 불러오는 중입니다'}
      disabled={disabled || !enabled}
      onChange={(personId) => apply(toSlot(people, personId))}
    />
  );

  return (
    <ProjectFormSection
      title="실제 투입인력"
      description="참여율 시트와 별개로, 이 사업의 책임 역할을 인력 명부 기준으로 지정합니다. 미정인 자리는 비워둘 수 있습니다."
    >
      {loadError ? <p className="text-[11px] text-amber-700">{loadError}</p> : null}

      <ProjectFormRow label="총괄책임자" note="사업 최종 책임자">
        {picker(staffing.lead, (slot) => patch({ lead: slot }))}
      </ProjectFormRow>
      <ProjectFormRow label="실무책임자" note="실무 책임자 (PM)">
        {picker(staffing.pm, (slot) => patch({ pm: slot }))}
      </ProjectFormRow>

      {operatorSlots.map((slot, index) => (
        <ProjectFormRow
          key={`operator-${index}`}
          label={`운영매니저 ${index + 1}`}
          note={index === 0 ? '운영 매니저 (1인 이상)' : '추가 운영 매니저'}
        >
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              {picker(slot, (next) => {
                const filled = [...staffing.operators];
                if (index < filled.length) {
                  if (next) filled[index] = next;
                  else filled.splice(index, 1);
                } else if (next) {
                  filled.push(next);
                  setEmptyOperatorSlots((count) => Math.max(0, count - 1));
                }
                patch({ operators: filled });
              })}
            </div>
            {operatorSlots.length > 1 ? (
              <Button
                type="button" variant="outline" size="sm" className="h-9 px-2"
                disabled={disabled}
                onClick={() => {
                  if (index < staffing.operators.length) {
                    patch({ operators: staffing.operators.filter((_, itemIndex) => itemIndex !== index) });
                  } else {
                    setEmptyOperatorSlots((count) => Math.max(0, count - 1));
                  }
                }}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            ) : null}
          </div>
        </ProjectFormRow>
      ))}
      <ProjectFormRow label="" note="">
        <Button
          type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
          disabled={disabled}
          onClick={() => setEmptyOperatorSlots((count) => count + 1)}
        >
          <Plus className="h-3.5 w-3.5" /> 운영매니저 추가
        </Button>
      </ProjectFormRow>

      {/*
        기타 역할. 고정 역할로 담기지 않는 자리(멘토·강사 등)를 역할명과 함께 적는다.
        역할명은 프로젝트 문서에 그대로 남고, 서버가 그 값을 모아 다음 사람의 후보로 돌려준다.
      */}
      <datalist id={ROLE_SUGGESTION_LIST_ID}>
        {roleOptions.map((role) => <option key={role} value={role} />)}
      </datalist>
      {staffing.others.map((item, index) => (
        <ProjectFormRow key={`other-${index}`} label={`기타 ${index + 1}`} note="역할명을 직접 적습니다">
          <div className="flex items-center gap-2">
            <Input
              className={cn(FIELD_W_XS, FORM_CONTROL_CLASS)}
              list={ROLE_SUGGESTION_LIST_ID}
              maxLength={PROJECT_STAFFING_ROLE_MAX_LENGTH}
              placeholder="역할명"
              aria-label={`기타 ${index + 1} 역할명`}
              value={item.role}
              disabled={disabled}
              onChange={(event) => patchOther(index, { role: event.target.value })}
            />
            <div className="min-w-0 flex-1">
              {picker(item.slot, (next) => patchOther(index, { slot: next }), 'w-full')}
            </div>
            <Button
              type="button" variant="outline" size="sm" className="h-9 px-2"
              aria-label={`기타 ${index + 1} 삭제`}
              disabled={disabled}
              onClick={() => patch({ others: staffing.others.filter((_, itemIndex) => itemIndex !== index) })}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </div>
        </ProjectFormRow>
      ))}
      <ProjectFormRow
        label={staffing.others.length ? '' : '기타'}
        note={staffing.others.length ? '' : '실제 수행할 역할 기재 (멘토, 강사 등)'}
      >
        <Button
          type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs"
          disabled={disabled || staffing.others.length >= PROJECT_STAFFING_OTHERS_MAX}
          onClick={() => patch({ others: [...staffing.others, { role: '', slot: null }] })}
        >
          <Plus className="h-3.5 w-3.5" /> 기타 역할 추가
        </Button>
      </ProjectFormRow>

      <ProjectFormRow label="정산지원" required issueLabel="staffing.settlementSupport" note="담당자를 선택하거나 해당 없음을 선택해 주세요.">
        <Select
          value={staffing.settlementSupport || (submissionResponses['staffing.settlementSupport'] === 'NOT_APPLICABLE' ? 'NONE' : '')}
          onValueChange={(value) => {
            const responses = { ...submissionResponses };
            if (value === 'NONE') responses['staffing.settlementSupport'] = 'NOT_APPLICABLE';
            else delete responses['staffing.settlementSupport'];
            onChange({ ...staffing, settlementSupport: value === 'NONE' ? '' : value }, responses);
          }}
          disabled={disabled}
        >
          <SelectTrigger aria-label="정산지원" className={cn(FIELD_W_SM, FORM_CONTROL_CLASS)}><SelectValue placeholder="정산지원 선택" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="NONE">해당 없음</SelectItem>
            {SETTLEMENT_SUPPORT_CHOICES.map((choice) => (
              <SelectItem key={choice} value={choice}>{choice}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </ProjectFormRow>
    </ProjectFormSection>
  );
}
