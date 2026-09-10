# Portal Bank Statement

- route: `/portal/bank-statements`
- primary users: PM, 운영 입력 담당자
- status: retired (page and route removed; stored data retained)
- last updated: 2026-09-10

## Retirement

레거시 페이지 코드, 라우트, 메뉴, 빠른 검색과 연결 버튼을 제거했다. 아래 내용은 과거 기능 기록이며 현재 제공되는 화면이 아니다. 저장된 통장·거래 데이터와 다른 기능에서 사용하는 공유 저장·조회 경로는 보존한다.

## Purpose

은행/카드 원본 파일을 업로드하고 거래를 정리한 뒤 사업비 입력(주간)으로 안전하게 이어주는 원본 intake 화면이다.

## Current UX Summary

- 업로드된 원본 거래 건수와 현재 프로젝트 연결 상태를 보여준다.
- 저장된 통장내역을 주간 사업비 기준본으로 두고 바로 다음 화면으로 이어진다.
- `cashflow항목`은 정책 레이어 기준으로 line label과 내부 enum이 연결된다.

## Current Feature Checklist

- [x] 은행/카드 원본 업로드 가능
- [x] 연결된 거래 건수와 상태 확인 가능
- [x] `사업비 입력(주간)`으로 이어가기 가능
- [x] 별도 queue/wizard 없이 저장 후 바로 주간 사업비 입력으로 이어가기 가능
- [x] 빈 초기 화면은 업로드 CTA와 지원 형식만 보이는 단일 박스로 유지
- [x] 직접작성 사업도 같은 흐름에서 다룰 수 있음
- [x] 환수행, 선사용금, 특이건 보조 액션 없이 기본 표 편집 흐름만 유지
- [x] `cashflow항목` label과 내부 enum은 공용 policy 기준으로 해석됨
- [x] PM 포털 safe fetch 모드에서도 통장내역 화면 진입과 direct handoff 부팅 가능
- [x] XLSX 업로드는 취약 `xlsx` 패키지 없이 `exceljs` 기반 파서로 처리됨
- [ ] 마지막 행 드롭다운 잘림 이슈 완전 해소 확인 필요

## Recent Changes

- [2026-07-13] 같은 계정의 다른 탭에서 작업을 이어 받을 때 기존 lease를 새 fence로 인계하고, 기존 개인 임시저장본을 다시 불러오도록 보강했다. 읽기 모드를 선택하면 같은 차단 안내가 반복되지 않는다.
- [2026-06-19] 보안 취약점이 있는 `xlsx` 직접 의존성을 제거하고 XLSX 파싱을 `exceljs` 기반 공통 파서로 전환했다. 일반 binary `.xls` 업로드는 CSV/XLSX 변환을 안내하고, HTML로 위장된 은행 내보내기는 기존 HTML 파서로만 처리한다.
- [2026-04-15] `cashflow항목` line label/alias/category 해석이 공용 policy 레이어를 통하도록 정리했다.
- [2026-04-15] 통장내역 저장 시 업로드한 은행 행을 현재 주간 사업비 탭 행으로 바로 merge하도록 바꿨다. Queue 없이 `통장내역 -> 사업비 입력(주간)` direct handoff가 이어진다.
- [2026-04-15] PM 역할에서는 portal store가 realtime listen 대신 safe fetch로 초기 데이터를 불러오도록 바꿔, 포털 부팅 시 반복 Listen 400이 통장내역 화면까지 전파되는 위험을 줄였다.
- [2026-04-14] 포털 session active project를 따라 현재 사업이 바뀌어도 같은 화면에서 다른 사업 통장내역을 바로 이어서 볼 수 있게 했다.
- [2026-04-14] `신규 거래 처리 Queue` 카드와 queue-first wizard 액션을 제거하고, 통장내역 저장본에서 바로 사업비 입력으로 이어지는 단일 흐름으로 롤백했다.
- [2026-04-14] 환수행, 선사용금, 특이건 보조 행 추가 액션을 현재 operator-facing 화면에서 제외했다.
- [2026-04-14] 빈 초기 화면에서 walkthrough 3단계와 role notice를 제거하고 업로드 박스 하나로 압축했다.
- [2026-04-14] 미션/가이드 카드를 제거하고 원본, 표, `사업비 입력(주간)` direct handoff 중심으로 화면을 정리했다.
- [2026-04-10] 사업비 입력(주간)으로 이어가는 CTA와 설명 문구를 더 직접적으로 정리했다.
- [2026-04-10] intake queue와 연결 상태 표기를 안정화했다.
- [2026-04-10] 주간 입력 화면과의 align이 약했던 상단 흐름 설명을 보완했다.

## Known Notes

- 이 화면은 자체 완결 화면이 아니라 `사업비 입력(주간)`의 기준본 역할을 한다.
- queue-first triage는 QA 반응으로 롤백됐고, 현재는 기준본 저장 후 바로 다음 입력 화면으로 이어지는 것이 기본 원칙이다.
- 거래 분류와 cashflow 항목 매핑이 이후 주간 입력과 submission 상태에 모두 영향을 준다.
- `cashflow항목`은 화면 라벨과 내부 enum이 다를 수 있으므로, 새 로직은 정책 모듈을 통하지 않는 문자열 비교를 금지한다.

## Related Files

- `src/app/components/portal/PortalBankStatementPage.tsx`
- `src/app/components/portal/PortalWeeklyExpensePage.tsx`
- `src/app/routes.tsx`

## Related Tests

- `src/app/platform/bank-statement.test.ts`
- `src/app/platform/bank-html-parser.test.ts`
- `src/app/platform/bank-import-triage.test.ts`
- `src/app/platform/bank-intake-surface.test.ts`

## Related QA / Ops Context

- `docs/operations/qa-feedback-memory.md`의 `통장내역`, `사업비 입력(주간)`, `증빙/드라이브` 관련 QA와 직접 연결된다.
- 최근 QA에서 마지막 행 드롭다운 잘림, cashflow 항목 선택 난이도, 직접작성 사업의 진입 문제 제기가 있었다.

## Next Watch Points

- 마지막 행의 드롭다운/팝오버가 잘리지 않는지
- `cashflow항목` canonical label과 내부 enum이 다시 drift하지 않는지
- 직접작성 사업에서 버튼 비활성/진입 차단 회귀가 없는지
