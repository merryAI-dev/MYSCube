# Portal Edit Project

- route: `/portal/edit-project`
- primary users: PM, 프로젝트 정보 수정 담당자
- status: active
- last updated: 2026-09-16

## Purpose

현재 선택된 프로젝트의 기본 정보를 수정하는 화면이다.

## Current UX Summary

- 헤더는 화면 제목과 프로젝트명만 보여준다.
- 현재 프로젝트를 설명문으로 반복하지 않고, 제목 아래 메타 한 줄만 유지한다.
- 공통 프로젝트 에디터에서 팀원은 이름/닉네임 검색형 picker로 수정한다.
- 기존 v2 등록값인 정산시스템·입금 예상월·실제/서류상 인력 구분을 같은 계약으로 수정한다.
- 팀/인력 단계에서는 담당조직(CIC)과 중복되는 사내기업팀, 참여기업 조건을 다시 입력하지 않는다.

## Current Feature Checklist

- [x] 날짜 편집 중 기존 연도별 금액·입금 계획 유지
- [x] 계약기간 밖 연도는 확인 후 제외하고 합계를 다시 계산
- [x] 전각 숫자·원 단위 금액 입력, 형식 오류 시 기존 금액 보존
- [x] 미래 시작·종료 미정 사업의 시작 연도 재무 입력

- [x] 현재 프로젝트 정보 수정 가능
- [x] 화면 제목과 프로젝트명 확인 가능
- [x] 기존 팀원 값을 유지하면서 검색형 팀원 선택 가능
- [x] 중복 조직/조건 필드 없이 PM과 팀원 구성 중심으로 수정 가능
- [x] 중복 subtitle 없이 폼 중심으로 진입 가능
- [x] 자동 생성된 사업관리 폴더 링크 확인 가능

## Recent Changes

- [2026-09-16] 날짜 공란·기간 축소로 연도별 입력을 자동 삭제하지 않게 했다. 잘못된 금액 문자열은 0으로 저장하지 않고 정정할 때까지 저장을 차단한다. 단년도·다년도 전환 시 기존 입금 계획을 해당 연도에 유지한다.

- [2026-07-14] 프로젝트 등록 v2의 구조화 필드와 첨부 7종을 수정 draft·검토·승인 흐름에도 동일하게 연결했다.
- [2026-07-13] 화면 이탈 시 한 번 확인한 뒤 최신 입력을 임시저장하고 수정 lease를 해제하도록 연결했다. 저장 또는 해제 실패 시 현재 화면에 남아 재시도할 수 있다.
- [2026-05-20] 팀원 선택을 긴 dropdown에서 검색형 picker로 바꾸고, 사내기업팀과 참여기업 조건 입력을 제거해 등록 화면과 수정 화면이 같은 간소화된 팀 입력 UX를 사용하게 했다.
- [2026-04-14] `현재 프로젝트:` subtitle을 제거하고 프로젝트명만 남겨 헤더를 더 짧게 정리했다.

## Related Files

- `src/app/components/portal/PortalProjectEdit.tsx`
- `src/app/routes.tsx`

## Related Tests

- `tests/e2e/project-amount-investigation.spec.ts`
- `src/app/platform/project-input-preservation.test.ts`

- `src/app/components/portal/PortalMinimalSweep.layout.test.ts`

## Next Watch Points

- 헤더 아래에 상태성 보조 문구가 다시 늘어나지 않는지
