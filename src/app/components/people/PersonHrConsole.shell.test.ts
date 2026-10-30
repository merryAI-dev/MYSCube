import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  changedPersonProfileFields,
  personProfileFormFromRecord,
  type PersonProfileFormValue,
} from './PersonHrConsole';
import type { PersonRecord } from '../../lib/platform-bff-client';

const source = readFileSync(resolve(import.meta.dirname, 'PersonHrConsole.tsx'), 'utf8');

const PERSON: PersonRecord = {
  personId: 'psn-a', name: '변민욱', nickname: '보람', email: 'mw@mysc.co.kr',
  departmentTop: '대표이사실', departmentMid: 'AXR팀', departmentSub: '',
  title: '팀장', grade: '책임연구원', birthDate: '1996-12-20', workLocation: '서울',
  joinedAt: '2025-04-02', employments: [], uid: null,
};

describe('인사정보 콘솔', () => {
  it('바뀐 칸만 저장 대상으로 추린다 — 부분 갱신이라 안 바뀐 값까지 보내면 감사 기록이 뜻을 잃는다', () => {
    const before = personProfileFormFromRecord(PERSON);
    expect(changedPersonProfileFields(before, before)).toEqual({});

    const after: PersonProfileFormValue = { ...before, grade: '수석컨설턴트', title: '센터장' };
    expect(changedPersonProfileFields(before, after)).toEqual({ grade: '수석컨설턴트', title: '센터장' });
  });

  it('생년월일은 날짜 부분만 폼에 담는다', () => {
    expect(personProfileFormFromRecord({ ...PERSON, birthDate: '1996-12-20T00:00:00.000Z' }).birthDate)
      .toBe('1996-12-20');
    expect(personProfileFormFromRecord({ ...PERSON, birthDate: '' }).birthDate).toBe('');
  });

  it('그룹웨어 인사기록카드 구조를 지킨다 — 기본정보·인사정보조회·상세정보', () => {
    expect(source).toContain('<TabsTrigger value="basic"');
    expect(source).toContain('<TabsTrigger value="records"');
    expect(source).toContain('<TabsTrigger value="detail"');
    expect(source).toContain('데이터가 존재하지 않습니다');
    expect(source).toContain('{count}건');
  });

  it('만 나이·근속·학위 후 경력은 저장값이 아니라 오늘 기준 계산이다', () => {
    expect(source).toContain('deriveAge(person.birthDate, asOf)');
    expect(source).toContain('deriveTenure(person.joinedAt, asOf)');
    // KOICA 제안서가 '학위 취득 후 경력 몇 년' 을 본다. 학력 카드를 열지 않고 머리에서 읽힌다.
    expect(source).toContain('deriveYearsSinceDegree(highestEducation?.degreeYear, asOf)');
    expect(source).toContain('label="최종학력"');
    expect(source).toContain('label="학위취득"');
    expect(source).not.toContain('person.age');
  });

  it('읽는 크기를 지킨다 — 본문 14~15px, 팝업 폭은 sm 변형까지 함께 준다', () => {
    // 기본 DialogContent 에 sm:max-w-lg(512px) 가 박혀 있다. sm 변형을 같이 주지 않으면
    // max-w-[...] 가 640px 이상 화면에서 무시되고 팝업이 512px 로 잘린다.
    expect(source).toContain('sm:max-w-[1000px]');
    expect(source).toContain('max-w-[1000px]');
    expect(source).not.toContain('text-[11px]');
  });

  it('직급은 설정 목록에서 고르되 별도 직급체계는 직접 입력으로 남긴다', () => {
    // 직급 목록도 설정에서 뻗어 나온다. 코드 카탈로그는 설정이 없을 때의 기본값이다.
    expect(source).toContain('usePersonGradeSettings');
    expect(source).toContain('formatGradeOptionLabel(grade)');
    expect(source).toContain('직급과 다른 축입니다');
    // 경영기획실(재경)·사내벤처는 별도 체계를 쓴다. 목록으로 막으면 그 사람들이 저장을 못 한다.
    expect(source).toContain('직접 입력 (별도 직급체계)');
    expect(source).toContain('aria-label="직급 직접 입력"');
  });

  /**
   * 실제로 터졌던 사고다. `educationLabelOf` 는 const 화살표 함수라 호이스팅되지 않는데
   * 위쪽 useMemo 가 먼저 불러서 "Cannot access ... before initialization" 이 났다.
   * 학력 기록이 1건이라도 있는 사람을 열 때만 터져서 오래 숨어 있었다.
   */
  it('라벨 조회 함수를 그것을 쓰는 useMemo 보다 먼저 선언한다', () => {
    const declaredAt = source.indexOf('const educationLabelOf');
    const usedAt = source.indexOf('educationLabelOf(top.attainmentCode)');
    expect(declaredAt).toBeGreaterThan(-1);
    expect(usedAt).toBeGreaterThan(-1);
    expect(declaredAt).toBeLessThan(usedAt);

    const englishDeclaredAt = source.indexOf('const englishLabelOf');
    expect(englishDeclaredAt).toBeGreaterThan(-1);
    expect(englishDeclaredAt).toBeLessThan(source.indexOf('const highestEducation'));
  });

  /**
   * 휴직·퇴사는 인사정보를 보다가 그 자리에서 적는 일이다. 계약 관리 화면으로 튕겨 보내면
   * 보던 맥락이 끊긴다. 다만 퇴사는 재직상태가 아니라 계약을 닫는 일이라 종료일로 처리한다.
   */
  it('휴직·퇴사를 인사정보 안에서 바로 기입한다', () => {
    expect(source).toContain('휴직 · 퇴사');
    expect(source).toContain('changePersonEmploymentViaBff');
    expect(source).toContain('id="hr-leave-date"');
    expect(source).toContain('id="hr-leave-state"');
    // 퇴사는 state 가 아니라 endDate 로 닫는다.
    expect(source).toContain("...(leaveState === 'SEPARATED' ? { endDate: leaveDate } : {})");
  });
});
