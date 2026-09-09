import type { ReactNode } from 'react';
import { Label } from '../ui/label';
import { cn } from '../ui/utils';

/**
 * 등록/수정 폼의 공유 레이아웃 체계. 여러 세션의 바이브 코딩이 제각각의 폭·글자·간격을
 * 만들지 않도록, 폼에 붙는 모든 섹션·행은 반드시 여기 것을 쓴다.
 *
 * 글자는 네 역할만: 섹션 14 / 라벨 12 / 값 13 / 힌트·오류 11.
 * 간격은 세 값만: 8(라벨↔입력) / 16(필드↔필드) / 24(섹션↔섹션).
 * 컨트롤 폭은 행 컨테이너가 max-w-xl 로 통일한다 - 개별 컨트롤에 max-w-* 를 붙이지 않는다.
 */
export const FORM_SECTION_CLASS = 'text-[14px] font-bold leading-tight text-slate-900';
export const FORM_LABEL_CLASS = 'text-[12px] font-semibold leading-5 text-slate-700';
/** 값은 13px. 숫자는 자릿수가 흔들리지 않도록 고정폭(tabular-nums)만 붙인다. */
export const FORM_VALUE_CLASS = 'text-[13px]';
export const FORM_NUMERIC_VALUE_CLASS = 'text-[13px] tabular-nums';
export const FORM_HINT_CLASS = 'text-[11px] font-normal leading-5 text-slate-500';
export const FORM_ERROR_CLASS = 'text-[11px] font-normal leading-5 text-red-700';
export const FORM_FIELD_STACK_CLASS = 'space-y-4';
export const FORM_SECTION_STACK_CLASS = 'space-y-6';
/**
 * 폭은 내용의 힌트다(Baymard: 폭이 기대 입력 길이와 다르면 사용자가 머뭇거린다).
 * 임의 max-w 대신 아래 4토큰만 쓴다. 행 컨테이너(max-w-xl)가 바깥 한계다.
 *   XS: 날짜·월·통화처럼 몇 글자짜리 값
 *   SM: 조직·상태처럼 짧은 선택지
 *   MD: 사람 픽커·이름이 긴 선택지
 *   LG: 계약명·링크 - 행 한계까지
 */
export const FIELD_W_XS = 'w-full max-w-[11rem]';
export const FIELD_W_SM = 'w-full max-w-[16rem]';
export const FIELD_W_MD = 'w-full max-w-[24rem]';
export const FIELD_W_LG = 'w-full max-w-xl';

/** 입력 컨트롤의 기본 높이·글자. 값 13px 규칙을 컨트롤에도 그대로 적용한다. */
export const FORM_CONTROL_CLASS = `h-9 ${FORM_VALUE_CLASS}`;
export const FORM_NUMERIC_CONTROL_CLASS = `h-9 text-right ${FORM_NUMERIC_VALUE_CLASS}`;

export function describeSubmitIssue(message: string) {
  // 라벨 바로 옆이라 항목 이름은 이미 보인다. 뒷말을 붙이면 같은 말이 두 번 나온다.
  return message.endsWith('.') ? message : `${message}을(를) 입력해 주세요.`;
}

export interface ProjectFormSectionProps {
  title: string;
  required?: boolean;
  /** 바로 아래가 표일 때. 표가 자기 윗선을 가지므로 섹션 제목의 밑선을 그리지 않는다. */
  flushBelow?: boolean;
  /** 섹션 제목 밑에 한 줄로 붙는 부연. 필드 도움말과 섞이지 않도록 여기서만 쓴다. */
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}

/** 섹션 제목 + 굵은 밑줄. 단계 안의 묶음은 모두 이 모양 하나로 통일한다. */
export function ProjectFormSection({ title, required, description, action, flushBelow, children }: ProjectFormSectionProps) {
  return (
    <section className="space-y-4">
      <div className={cn('flex items-end justify-between gap-4 pb-2', flushBelow ? '' : 'border-b border-slate-200')}>
        <div>
          <h3 className={FORM_SECTION_CLASS}>
            {title}
          </h3>
          {description ? <p className={cn('mt-1', FORM_HINT_CLASS)}>{description}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      <div className={FORM_FIELD_STACK_CLASS}>{children}</div>
    </section>
  );
}

export interface ProjectFormRowProps {
  label: string;
  required?: boolean;
  /** 라벨 아래에 붙는 짧은 부연. 항목 이름만으로 부족할 때만. */
  note?: string;
  /** 입력 아래 `·` 불릿으로 붙는 도움말. 자리를 여기 하나로 고정한다. */
  hints?: ReactNode[];
  /** 도움말과 같은 자리에 색만 바꿔 보여주는 오류. submitIssues 문구를 그대로 받는다. */
  errors?: string[];
  /**
   * 단계 이동 후 이 필드로 스크롤·포커스하기 위한 표식.
   * submitIssues 의 label 과 같은 값을 넣는다(판정에는 쓰지 않고 위치만 찾는다).
   */
  issueLabel?: string;
  children: ReactNode;
}

/**
 * 필드 한 줄의 골격. 라벨 열(고정폭) + 오른쪽 입력 영역이고,
 * 필수 표시 · 부연 · 도움말 · 오류의 자리를 여기서 한 번만 정한다.
 *
 * 라벨 열이 고정폭이라 `*` 는 저절로 세로로 정렬된다. 왼쪽 세로 마커는 따로 두지 않는다.
 */
export function ProjectFormRow({ label, required, note, hints, errors, issueLabel, children }: ProjectFormRowProps) {
  const visibleHints = (hints || []).filter(Boolean);
  const visibleErrors = (errors || []).filter(Boolean);
  return (
    /*
     * 지금 입력하는 줄을 눈에 띄게 둔다. `focus-within` 이라 상태를 새로 들지 않고,
     * 왼쪽 얇은 액센트 막대와 라벨 색만 바뀐다. 배경까지 칠하면 값이 읽히지 않는다.
     */
    <div
      data-issue-label={issueLabel}
      className={cn(
        'grid gap-2 rounded-md border-l-2 border-transparent pl-2 transition-colors lg:grid-cols-[168px_minmax(0,1fr)] lg:gap-x-6',
        'focus-within:border-l-[#0176D3] focus-within:bg-[#0176D3]/[0.04]',
      )}
    >
      <div className="lg:pt-2">
        <Label className={cn('inline-flex text-slate-700 [div:focus-within>&]:text-[#0176D3]', FORM_LABEL_CLASS)}>
          <span>
            {label}
          </span>
        </Label>
        {note ? <p className={cn('mt-1', FORM_HINT_CLASS)}>{note}</p> : null}
      </div>
      {/* 컨트롤 폭 통일점: 드롭다운과 인풋이 같은 오른쪽 끝선을 갖는다. 개별 max-w 금지. */}
      <div className="min-w-0 max-w-xl">
        {children}
        {visibleHints.length > 0 ? (
          <ul className={cn('mt-2 space-y-1', FORM_HINT_CLASS)}>
            {visibleHints.map((hint, index) => (
              <li key={index} className="flex gap-1.5">
                <span aria-hidden className="shrink-0">•</span>
                <span className="min-w-0">{hint}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {visibleErrors.length > 0 ? (
          <ul className={cn('mt-2 space-y-1', FORM_ERROR_CLASS)} role="alert">
            {visibleErrors.map((message) => (
              <li key={message} className="flex gap-1.5">
                <span aria-hidden className="shrink-0">•</span>
                <span className="min-w-0">{describeSubmitIssue(message)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 짧은 필드 둘을 한 줄에 나란히 둔다. 한 항목이 한 줄씩 차지하면 화면이 세로로만 길어져
 * 짝지어 읽어야 할 값(시작일-종료일, 상태-구분)이 멀어진다. 좁은 화면에서는 다시 한 줄씩이다.
 */
export function ProjectFormFieldPair({ children }: { children: ReactNode }) {
  return <div className="grid gap-4 lg:grid-cols-2 lg:gap-x-8">{children}</div>;
}
