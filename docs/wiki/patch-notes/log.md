# Patch Notes Log

## [2026-09-10] patch-note | cashflow-legacy-regressions | 기존 승인 보존 및 레거시 통장내역 화면 제거
- pages: [portal-bank-statement](./pages/portal-bank-statement.md), [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: 동일 제출에 대한 과거 주정산 승인 증거를 보존하고, 새 재제출은 승인 대기로 유지한다. 실제 반영 기록 패널의 제목·배지·필터를 분리해 좁은 폭의 줄바꿈 문제를 수정한다. 레거시 통장내역 페이지·라우트·메뉴·검색·연결 버튼을 제거하며 기존 거래 데이터와 공유 저장 경로는 보존한다.

## [2026-08-12] patch-note | strip-mock-employee-names | 참여율 목데이터와 가짜 인사 공지 제거
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md), [admin-participation](./pages/admin-participation.md)
- summary: 프론트 번들에 직원 실명 75명이 실려 나가고 있었다. `PART_PROJECTS`/`PROJECT_ASSIGNMENTS`/`PARTICIPATION_ENTRIES` 목데이터는 목 프로젝트 id(`eco26` 등)를 쓰고 실제 프로젝트는 `p177…` 형태라 프로덕션에서 아무 역할도 하지 않으면서 이름만 싣고 있었다. 인력변경 알림은 이제 목 프로젝트가 아니라 실제 프로젝트를 받는다. 기본값으로 들어 있던 실존 인물의 가짜 퇴사·전배 공지도 제거했다. 번들 실명 75명 → 33명, 남은 33명은 KOICA·인력변경 화면이 실제로 쓰는 기능 데이터라 별도 슬라이스로 남긴다.

## [2026-08-12] patch-note | people-directory | 인력 명부를 DB로 이관하고 계약 이력 관리 추가
- pages: [admin-people-directory](./pages/admin-people-directory.md), [admin-participation](./pages/admin-participation.md)
- summary: 프론트 코드에 87명 배열로 박혀 있던 직원 명부를 제거하고, 재직자 현황 시트를 원본으로 하는 `orgs/{org}/persons` 를 런타임 근거로 삼는다. 저장되는 진실은 `employments` 배열 하나이고 근로형태·재직상태·퇴사일·근속은 읽을 때 파생시킨다. `/people` 화면에서 계약을 변경(적용일 직전에 기존 계약을 닫고 잇기)하거나 추가할 수 있고, 정규직에서 파트너로의 전환이 이 경로다. 기존 계약은 지우지 않는다. 프로젝트 팀원 드롭다운의 출처는 계정 원장(members)으로 그대로 두었고, 프로덕션 데이터로 드롭다운 79개 옵션과 참여율 그룹핑 80명이 변화 0건임을 확인했다.

## [2026-08-07] patch-note | cashflow-policy-shared-location | 캐시플로 정책 공유 위치 정리
- pages: [shared-label-policy](./pages/shared-label-policy.md)
- summary: 캐시플로 정책 JSON의 내용과 동작은 유지한 채 프론트 전용 경로에서 최상위 공유 정책 경로로 이동했다.

## [2026-08-03] patch-note | portal-budget | 예산 총계 가독성 정리
- pages: [portal-budget](./pages/portal-budget.md)
- summary: 포털 예산 화면의 중복 전체 소진율·집행·잔액 표시를 제거하고 예산·집행·잔액 총계의 글자 크기를 한 단계 키웠다.

## [2026-07-24] hotfix | cashflow-legacy-close-summary | 이전 월 결산 합계 표시 복구
- pages: [portal-cashflow](./pages/portal-cashflow.md)
- summary: 이전 형식의 월 결산 기록에 주차별 `reported` 합계가 없어도 현금흐름 화면이 중단되지 않도록 보강했다. 해당 값이 없을 때는 저장된 행 값의 합계를 사용한다.

## [2026-07-24] patch-note | cashflow-sheet-close-atomicity | 시트 표시값·월 결산 증거 원자성
- pages: [portal-cashflow](./pages/portal-cashflow.md), [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md)
- pr: [#353](https://github.com/merryAI-dev/MYSCube/pull/353)
- commit: `b50afea`
- stage: `innerplatform-jvm-weekly-api-lease-stage-00020-ptw`
- summary: 공식 Google Sheet의 표시값을 재계산하지 않고 `미입력`, `0`, 금액과 전년도 행별 이월값까지 그대로 고정한다. 시트 반영과 월 결산이 겹치면 JVM이 미완료 revision의 결산을 차단하고, 결산 후 변경은 원본 스냅샷·사유·경고 누적을 남긴다. 중단된 반영은 서버 입력과 상태를 기준으로 복구하며 Stage 프론트와 JVM에 같은 main SHA를 배포했다.

## [2026-07-20] patch-note | project-registration-approval-code-flow | 프로젝트 등록 승인·코드 부여 흐름
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 프로젝트 등록/수정의 제출 서류와 결재선을 기획안 기준으로 정렬하고, 조직장 승인과 경영기획실 코드 부여를 분리했다. 지정 조직장 외 승인, PM self-approval, 코드 중복 부여를 BFF에서 차단하고, 경영기획실 반려는 PM 재제출 흐름으로 되돌린다.

## [2026-07-20] patch-note | cashflow-source-consistency | 시트·JVM 원장 단일 기준 정렬
- pages: [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md)
- summary: 시트값 불러오기 뒤 변경 월을 JVM 원장에 순차 반영하고 응답 금액을 재검증한다. 대시보드와 주요 관리 항목은 반영된 원장을 우선 사용하며, 인건비 3주차 외 입력·Projection 마이너스 구간·수행자 감사 이력을 함께 표시한다.

## [2026-07-14] patch-note | project-management-deck-alignment | 프로젝트 관리 기획안 정렬
- pages: [portal-onboarding](./pages/portal-onboarding.md)
- summary: 프로젝트 목록을 등록 프로젝트와 계약 전 상태로 구분하고 상태·정산 유형·조직·검색 조건을 결합했다. 등록·승인 CTA는 역할 권한에 맞게 제한하고, workspace 선택과 기능 검색의 `PM 포털` 표기는 기획안 기준 `실무자 포털`로 통일했다.

## [2026-07-13] patch-note | portal-project-safe-exit | 프로젝트 임시저장 후 이탈
- pages: [portal-register-project](./pages/portal-register-project.md), [portal-edit-project](./pages/portal-edit-project.md)
- summary: 프로젝트 등록·수정에서 화면을 떠날 때 최신 입력을 임시저장한 뒤 수정 lease를 해제한다. 저장 또는 해제에 실패하면 이동하지 않는다.

## [2026-07-13] patch-note | cashflow-safe-exit | 캐시플로 임시저장 후 이탈
- pages: [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md)
- summary: 캐시플로 상세에서 화면을 떠날 때 남은 입력을 작성자 전용 임시저장본에 보관하고 lease를 해제한 뒤 이동한다. 저장 실패 시 이동하지 않는다.

## [2026-07-13] patch-note | edit-lease-session-handoff | 동일 사용자 수정 세션 이어쓰기
- pages: [portal-bank-statement](./pages/portal-bank-statement.md), [portal-submissions](./pages/portal-submissions.md), [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: 수정 중인 사람의 이름과 읽기 전용 안내를 표시하고, 같은 계정은 명시적으로 이전 수정 세션을 이어 받을 수 있게 했다. 새 session은 새 lease ID와 fence를 받아 이전 탭의 저장을 차단한다.

## [2026-07-13] patch-note | stage-lease-bff-boundary | 프로젝트별 수정 lease와 BFF canonical write 경계
- pages: [portal-submissions](./pages/portal-submissions.md), [portal-weekly-expense](./pages/portal-weekly-expense.md), [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 프로젝트 등록/수정과 cashflow에 30분 서버 lease, 세션·fence 검증, 임시저장/최종저장 경계를 적용하고 canonical Firestore browser write를 차단했다. Stage에서만 검증·배포한다.

## [2026-06-19] patch-note | shared-portal-architecture | Cashflow service account and portal stability
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: Cashflow Sheet Lab의 Google Sheets 접근을 사용자 OAuth token pass-through에서 서버 서비스 계정 전용으로 전환하고, 설정 저장은 시트 검증 없이 config만 저장하도록 분리했다. `/portal/cashflow`는 route-scoped provider만 로딩하고, 프로젝트 catalog 권한 오류가 있어도 배정 프로젝트 선택을 유지하며 labor risk 배경 요청이 cashflow week stream 변화마다 반복되지 않도록 고정했다.

## [2026-06-19] patch-note | portal-bank-statement | secure XLSX parser
- pages: [portal-bank-statement](./pages/portal-bank-statement.md)
- summary: 통장내역 업로드의 XLSX 파싱을 취약 `xlsx` 직접 의존성에서 `exceljs` 기반 공통 파서로 전환하고, 일반 binary `.xls`는 CSV/XLSX 변환 안내로 제한했다. HTML로 위장된 은행 내보내기는 기존 HTML 파서 경로만 유지한다.

## [2026-06-02] patch-note | portal-weekly-expense, shared-portal-architecture | portal edit stability and document uploads
- pages: [portal-weekly-expense](./pages/portal-weekly-expense.md), [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 주간 사업비 입력의 빠른 추가 액션을 단일 `행 추가`로 통합하고 Actual 동기화 결과가 현재 화면에 즉시 반영되도록 보강했다. 프로젝트 등록/수정은 프로젝트명과 그룹웨어 등록명을 같은 값으로 저장하며, 계약서 외 견적서/제안서 첨부와 1GB Firebase Storage direct upload 경로를 추가했다.

## [2026-05-21] patch-note | admin-dashboard, portal-onboarding | MYSCube feature search entry
- pages: [admin-dashboard](./pages/admin-dashboard.md), [portal-onboarding](./pages/portal-onboarding.md)
- summary: Admin 첫 화면을 사이드바 없는 전체 기능 검색 화면으로 전환하고, 로그인 직후 workspace 선택 화면도 관리자/PM 색상 구분형 feature map으로 맞췄다. MYSCube 로고 자산을 공통 brand component에 연결하고, 기능 검색 headline은 사용자 이름 기반 인사로 바꾸며 검색창 hover/focus affordance를 강화했다.

## [2026-05-21] patch-note | admin-dashboard | LAB shell visibility and dashboard polish
- pages: [admin-dashboard](./pages/admin-dashboard.md)
- summary: Admin/Portal shell에 공통 LAB visibility policy를 추가하고, 대시보드 이상 징후, 시스템 상태, 최근 활동, 상태바, 알림 패널, 404 quick links, 캐시플로 허브 카드까지 같은 정책으로 필터링했다. 알림 패널 모바일 폭 잘림과 Sheet 접근성 경고도 함께 정리했다.

## [2026-05-20] patch-note | portal-register-project, portal-edit-project | searchable team member picker
- pages: [portal-register-project](./pages/portal-register-project.md), [portal-edit-project](./pages/portal-edit-project.md)
- summary: 공통 프로젝트 에디터의 팀원 선택을 긴 dropdown에서 이름/닉네임 검색형 picker로 교체해 신규 등록과 수정 루프에서 80명+ 팀원 목록을 같은 방식으로 빠르게 찾게 했다. 팀/인력 단계는 담당조직(CIC)과 중복되는 사내기업팀/참여기업 조건 입력을 제거하고, 기존 저장값이 canonical 옵션 밖에 있어도 표시와 닉네임을 유지하며, 이미 추가된 팀원은 중복 선택하지 못하도록 표시한다.

## [2026-05-20] patch-note | admin-participation | Salesforce-style participation source lanes
- pages: [admin-participation](./pages/admin-participation.md)
- summary: 참여율 관리 화면을 e나라도움, KOICA, 회계사정산, 민간/기타 원천 구분 lane이 먼저 보이는 Salesforce형 운영 뷰로 정리했다. 프로젝트 팀 연동 행은 표시용으로 합산하되 공식 위험 카운트와 JSON 내보내기는 formal 참여율만 사용하도록 분리하고, stale `PROJECT_TEAM_SYNC` 행과 이름/닉네임 중복을 막는 회귀 테스트를 추가했다.

## [2026-05-20] patch-note | admin-dashboard, admin-participation, portal-dashboard, shared-portal-architecture | project registration review flow alignment
- pages: [admin-dashboard](./pages/admin-dashboard.md), [admin-participation](./pages/admin-participation.md), [portal-dashboard](./pages/portal-dashboard.md), [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 프로젝트 등록, 포털 수정, Admin 승인 화면을 공통 5단계 프로젝트 에디터로 정렬하고, `프로젝트/계약 대상/PM/CIC 대표 검토` 용어와 dropdown 값을 통일했다. 승인/재제출의 project-request 상태 동기화는 같은 Firestore transaction으로 묶고, canonical `project_requests` index와 legacy fallback을 보강했다.

## [2026-04-22] patch-note | portal-budget | sub-sub-item delete editor state fix
- pages: [portal-budget](./pages/portal-budget.md)
- summary: 구조 편집에서 세세목을 여러 개 추가한 뒤 하나를 삭제하면 편집 영역 전체가 예상보다 빨리 접히던 문제를 줄였고, 마지막 빈 세세목만 기본 상태로 돌아가도록 정리했다.

## [2026-04-21] patch-note | portal-budget, portal-weekly-expense, shared-portal-architecture | budget tree v2 sub-sub-category flow
- pages: [portal-budget](./pages/portal-budget.md), [portal-weekly-expense](./pages/portal-weekly-expense.md), [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 세세목이 필요한 프로젝트는 `budget_tree_v2`를 원본으로 사용하고, 예산 편집의 세목 부모 예산과 불일치 경고를 추가했으며, 주간 사업비 입력은 tree 기반 세세목 dropdown과 2단 파생 codebook 동기화로 연결했다.

## [2026-04-16] patch-note | portal-payroll, portal-dashboard, admin-dashboard | payroll amount vs projection monitoring
- pages: [portal-payroll](./pages/portal-payroll.md), [portal-dashboard](./pages/portal-dashboard.md), [admin-dashboard](./pages/admin-dashboard.md)
- summary: PM이 이번 달 인건비 금액을 입력하고 cashflow projection 주차의 `MYSC 인건비`와 비교하도록 바꿨고, 금액 불일치와 각 기준별 잔액 부족을 포털 홈, 포털 지급 화면, 어드민 관제면에서 함께 보이도록 정리했다.

## [2026-04-16] patch-note | portal-dashboard, portal-payroll | payroll entry visibility recovery
- pages: [portal-dashboard](./pages/portal-dashboard.md), [portal-payroll](./pages/portal-payroll.md)
- summary: 포털 사이드바의 `인건비/공지`를 숨김 없이 노출하고, `/portal` 홈에도 상태형 `이번 달 인건비 확인` CTA를 상시 배치해 인건비 화면 발견성을 복구했다.

## [2026-04-16] patch-note | portal-payroll, portal-dashboard, admin-dashboard | payroll review loop and realtime finish-state polish
- pages: [portal-payroll](./pages/portal-payroll.md), [portal-dashboard](./pages/portal-dashboard.md), [admin-dashboard](./pages/admin-dashboard.md)
- summary: PM 적요 판단, Admin 최종 확정, 지급 완료 상태를 같은 용어와 badge 체계로 통일했고, scoped payroll store를 realtime snapshot으로 바꿔 Admin 확정이 PM 포털에도 즉시 반영되도록 정리했다.

## [2026-04-15] patch-note | shared-portal-architecture | portal bootstrap fetch loop split
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: `portal-store`의 단일 bootstrap effect를 `projects catalog`, `current project scope`, `weekly submission scope`로 분리하고, 동일한 project snapshot은 다시 state에 밀지 않도록 해 `/portal` 진입 시 반복 fetch/listen churn 후보를 줄였다.

## [2026-04-15] patch-note | shared-portal-architecture | route-scoped provider and access policy split
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md), [portal-dashboard](./pages/portal-dashboard.md), [portal-payroll](./pages/portal-payroll.md)
- summary: App 루트 broad provider tree를 admin/portal route shell로 분리하고, 각 shell이 `admin-live` 또는 `portal-safe` Firestore access mode를 주입하도록 바꿨다. provider들은 더 이상 `window.location`이나 pathname hook으로 realtime 여부를 스스로 판단하지 않는다.

## [2026-04-15] patch-note | shared-portal-architecture | 포털 안정화 장기안 정리
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 포털 안정화의 기본안을 `Firestore 유지 + BFF/API-first hybrid`로 고정하고, 6~8주 동안 provider split, read model API, critical write command, admin summary cutover 순서를 따르는 RFC와 실행 계획을 문서화했다.

## [2026-04-15] patch-note | portal-dashboard | route-aware realtime mode fix
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 포털 전역 provider가 route 변경으로 다시 평가되지 않아 이전 admin/live mode가 `/portal`에서도 남아 있던 문제를 수정하고, pathname 구독 기반으로 safe fetch 판단이 즉시 갱신되도록 바꿨다.

## [2026-04-15] patch-note | portal-onboarding, portal-project-select | 시작 카드 실제 라우트 복구
- pages: [portal-onboarding](./pages/portal-onboarding.md), [portal-project-select](./pages/portal-project-select.md)
- summary: 포털 시작 선택 카드가 deep route에서도 fallback 선택 화면에 다시 덮이지 않도록 standalone entry 경로 판정을 layout과 navigation 정책에서 공통화했고, `기존 사업 선택`은 실제 사업 선택 step으로 연결했다.

## [2026-04-15] patch-note | portal-onboarding | 선택 카드 실제 이동 복구
- pages: [portal-onboarding](./pages/portal-onboarding.md)
- summary: 포털 미등록 사용자가 온보딩 선택 카드에서 `기존 사업 선택`, `증빙 업로드`, `새 사업 등록`을 눌렀을 때 강제 온보딩 리다이렉트에 다시 덮이지 않고 실제 다음 화면으로 이동하도록 복구했다.

## [2026-04-15] patch-note | portal-dashboard, portal-payroll | residual portal listen 제거
- pages: [portal-dashboard](./pages/portal-dashboard.md), [portal-payroll](./pages/portal-payroll.md)
- summary: `/portal` 홈과 인건비 화면이 직접 붙이던 `transactions` realtime listener를 제거하고, 포털 경로에서는 route-aware safe fetch만 사용하도록 고정했다.

## [2026-04-15] patch-note | portal-dashboard | PM safe fetch stabilization
- pages: [portal-dashboard](./pages/portal-dashboard.md), [portal-bank-statement](./pages/portal-bank-statement.md), [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: PM/viewer 포털 경로의 portal store, board, training, HR surface는 역할 기반 safe fetch 모드로 전환해 반복 Firestore Listen 400이 포털 전체를 재시도 루프로 흔드는 구조를 줄였다.

## [2026-04-15] patch-note | portal-dashboard | payroll listen hardening
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: PM 포털 전역 payroll provider가 `projectId + orderBy` 복합 listen 없이 동작하도록 단순화해 남아 있던 Firestore Listen 400 후보를 추가로 제거했다.

## [2026-04-15] patch-note | admin-dashboard | 웰컴/검증 표면 제거
- pages: [admin-dashboard](./pages/admin-dashboard.md)
- summary: 어드민 첫 화면에서 웰컴 배너와 validation/reminder 보조 UI를 제거하고 KPI, 리스크, 집계, 작업 진입만 남는 운영판으로 더 압축했다.

## [2026-04-14] patch-note | portal-bank-statement | queue-first flow rollback
- pages: [portal-bank-statement](./pages/portal-bank-statement.md), [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: QA 반응이 좋지 않았던 신규 거래 queue와 triage wizard 강제 흐름을 제거하고, 통장내역 저장본에서 바로 주간 사업비 입력으로 이어가는 단일 handoff로 복귀했다.

## [2026-04-15] patch-note | shared-label-policy | cashflow label enum policy 통합
- pages: [shared-label-policy](./pages/shared-label-policy.md), [admin-cashflow-export](./pages/admin-cashflow-export.md), [portal-bank-statement](./pages/portal-bank-statement.md)
- summary: `cashflow`의 화면 라벨, 내부 enum, sheet line id, export 라벨 기준을 JSON source of truth와 policy API로 통합했다.

## [2026-04-14] patch-note | portal-minimal-sweep | 빈 상태/가이드/placeholder 감산
- pages: [portal-submissions](./pages/portal-submissions.md), [portal-bank-statement](./pages/portal-bank-statement.md), [portal-weekly-expense](./pages/portal-weekly-expense.md), [portal-register-project](./pages/portal-register-project.md), [portal-cashflow](./pages/portal-cashflow.md), [portal-project-settings](./pages/portal-project-settings.md), [portal-edit-project](./pages/portal-edit-project.md)
- summary: 남은 포털 화면들에서 helper copy, role notice, 중복 상태 bar, `-` placeholder를 걷어내고 작업면 중심의 더 얇은 운영 화면으로 정리했다.

## [2026-04-14] patch-note | portal-submissions | enterprise tone alignment
- pages: [portal-submissions](./pages/portal-submissions.md)
- summary: 내 제출 현황의 header slab, ledger table, 상태칩, 탭, 보조 카드 톤을 portal dashboard와 같은 Salesforce형 enterprise palette로 맞췄다.

## [2026-04-14] bootstrap | patch-notes-wiki | 초기 위키 scaffold
- pages: [portal-weekly-expense](./pages/portal-weekly-expense.md), [portal-bank-statement](./pages/portal-bank-statement.md), [portal-budget](./pages/portal-budget.md), [portal-register-project](./pages/portal-register-project.md), [portal-submissions](./pages/portal-submissions.md), [admin-cashflow-export](./pages/admin-cashflow-export.md), [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md), [admin-users-auth-governance](./pages/admin-users-auth-governance.md)
- summary: GitHub 내부에 화면 단위 누적 패치노트 위키 구조를 신설했다.

## [2026-04-14] patch-note | admin-users-auth-governance | auth deep sync 운영면 신설
- pages: [admin-users-auth-governance](./pages/admin-users-auth-governance.md)
- commits: `4787138`
- summary: shallow 사용자 목록을 auth governance 대시보드로 교체하고 member role, legacy member, custom claim drift를 한 화면에서 정렬할 수 있게 했다.

## [2026-04-14] patch-note | admin-cashflow-export | 운영툴형 캐시플로 추출 화면 정리
- pages: [admin-cashflow-export](./pages/admin-cashflow-export.md)
- commits: `9428009`, `416fab5`, `5c1ac13`, `e1e957f`, `29e4a60`, `71f5769`, `e77dbe7`, `b51f12c`, `d351407`
- summary: server-side export 전환과 함께 경영기획실 전용 모노톤 운영툴 화면으로 재편했다.

## [2026-04-14] patch-note | admin-cashflow-project-sheet | compare/close/weekly snapshot 작업면 기록
- pages: [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md)
- commits: `0c7cb49`, `33bb7d9`, `e3c7757`, `d5ef374`, `bde5143`, `f517792`, `228ee3d`
- summary: 개별 사업 캐시플로 상세 작업면의 compare, close, snapshot, audit trail 관련 변화 포인트를 묶었다.

## [2026-04-14] patch-note | portal-weekly-expense | 저장 차단/자동 가이드/흐름 카피 정리
- pages: [portal-weekly-expense](./pages/portal-weekly-expense.md), [portal-bank-statement](./pages/portal-bank-statement.md)
- commits: `afc2098`, `0fb32ff`, `c6508c0`, `a6ff87b`, `eb2dc13`
- summary: 입력 화면 진입을 단순화하고, 통장내역에서 현재 탭 입력으로 이어지는 작업 흐름을 더 직접적으로 보이게 했다.

## [2026-04-14] patch-note | portal-budget | 모달 레이아웃과 구조 저장 보호 정리
- pages: [portal-budget](./pages/portal-budget.md)
- commits: `d9739d1`, `2189d8d`, `cafb5b4`, `7a31980`
- summary: 예산총괄 가져오기 안내 가독성, 긴 모달 스크롤, budget code book 보호를 정리했다.

## [2026-04-14] patch-note | portal-register-project | 직접입력형 자금 흐름과 등록 흐름 확장
- pages: [portal-register-project](./pages/portal-register-project.md)
- commits: `d6eb497`, `87d9953`, `6e623d4`, `2f5bb62`, `32eefdc`, `6f527fc`, `db5698d`
- summary: 직접 입력형 자금 흐름 등록, draft autosave, 단계 게이팅 완화, 계약 예외 흐름을 묶었다.

## [2026-04-14] patch-note | portal-submissions | 주간 작성 여부와 projection 기준 해석 정리
- pages: [portal-submissions](./pages/portal-submissions.md)
- commits: `afc2098`
- summary: 이번주 작성 여부와 최근 업데이트(Projection) 기준을 화면에서 더 명확하게 읽히도록 정리했다.

## [2026-04-14] patch-note | guide-simplify-and-hook | 설명성 UI 축소와 patch-note guard 추가
- pages: [portal-dashboard](./pages/portal-dashboard.md), [portal-weekly-expense](./pages/portal-weekly-expense.md), [portal-bank-statement](./pages/portal-bank-statement.md), [portal-budget](./pages/portal-budget.md), [portal-submissions](./pages/portal-submissions.md), [portal-onboarding](./pages/portal-onboarding.md), [admin-dashboard](./pages/admin-dashboard.md), [admin-participation](./pages/admin-participation.md)
- summary: 주요 운영 화면에서 미션/가이드/프로토콜 패널을 제거하고, 대응 patch-note page와 log가 같이 staged되지 않으면 커밋을 막는 hook을 추가했다.

## [2026-04-14] patch-note | portal-dashboard-saas-shell | 상단 workspace형 SaaS 재편
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 내사업 현황을 좌측 포털형 툴에서 상단 workspace bar, 앱 탭, 사업 전환 rail을 가진 cold enterprise SaaS 구조로 재편했다.

## [2026-06-19] patch-note | shared-portal-architecture | finance week 공통화 hotfix
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: cashflow/actual/projection/expense 주차 계산을 stage/live 공통 core로 모으고, 2026년 8월처럼 raw 6주차가 생기는 달은 financeWeek 5에 강제 산입되도록 저장/API/export 경로를 맞췄다.

## [2026-04-14] patch-note | portal-dashboard | 0건 운영 정보 축소와 주간 상태 전면 배치
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 0건 운영 알림과 설정성 바로가기를 걷어내고, 이번 주 Projection 작성 여부·최근 Projection 수정일·사업비 입력 상태를 홈 첫 화면에서 바로 보이도록 압축했다.

## [2026-04-14] patch-note | portal-dashboard-shell | 검색/알림/사용자 액션 연결
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 상단 search, bell, user affordance를 실제 command palette와 dropdown action으로 연결해 관리자 이동, 내 프로필, 로그아웃, 처리할 알림 확인이 가능하도록 마감했다.

## [2026-04-14] patch-note | portal-dashboard-shell | section label 감산
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 상단 shell에서 정보량이 없는 `My Work` 보조 라벨을 제거하고 현재 화면명만 남겨 더 미니멀한 heading 구조로 정리했다.

## [2026-04-14] patch-note | portal-dashboard-shell | 현재 사업 검색 이동 보정
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: command search에서 현재 담당 사업을 선택했을 때 `setActiveProject` no-op 때문에 이동이 막히던 문제를 제거했다.

## [2026-04-14] patch-note | portal-dashboard-brand-slab | 로고 교체와 단일 헤더 슬랩
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 상단 폴더 아이콘을 MYSC 로고로 교체하고 workspace 문구를 제거했으며, 첫 화면의 사업 정보와 주간 상태를 한 장의 세로형 헤더 슬랩으로 다시 묶었다.

## [2026-04-14] patch-note | portal-dashboard-minimal-pass | 중복 CTA 제거와 단일 세로 흐름
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 홈 첫 화면에서 중복 이동 버튼과 작업 카드 묶음을 제거하고, 상태 slab와 자금 요약만 남는 더 미니멀한 세로 흐름으로 압축했다.

## [2026-04-14] patch-note | portal-dashboard-two-axis-hero | 상세/주간상태 한 판 통합
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 자금 요약을 사업명 아래 4칸으로 올리고, 같은 hero 안에서 좌측 프로젝트 상세와 우측 이번 주 작업 상태가 한 번에 보이도록 재구성했다.

## [2026-04-14] patch-note | portal-dashboard-finance-typography | 자금 요약 가독성 정리
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 자금 요약 4칸의 장식 아이콘을 제거하고 라벨과 숫자 크기를 키워 더 미니멀하고 읽기 쉬운 밀도로 다듬었다.

## [2026-04-14] patch-note | portal-dashboard-balance-tone | 좌우 비중과 gray hierarchy 조정
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 프로젝트 상세와 이번 주 작업 상태의 좌우 비중을 다시 맞추고, hero 내부에 slate 회색 계층을 추가해 덜 허옇고 더 전문적인 운영툴 톤으로 정리했다.

## [2026-04-14] patch-note | portal-dashboard-white-boxes | 흰 박스 유지와 배경 대비 강화
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 정보 박스는 다시 흰색으로 통일하고, hero 바탕 회색만 더 진하게 조정해 박스 대비와 가독성을 높였다.

## [2026-04-14] patch-note | portal-shell-project-search | 담당 사업 검색 전환 지원
- pages: [portal-dashboard](./pages/portal-dashboard.md)
- summary: 헤더의 중복 `사업비 입력` 버튼을 제거하고, 상단 command search가 담당 사업 전체를 검색해 선택 시 해당 사업으로 전환 후 이동하도록 확장했다.

## [2026-04-14] patch-note | portal-session-active-project | 세션 사업 전환과 진입 step 분리
- pages: [portal-weekly-expense](./pages/portal-weekly-expense.md), [portal-bank-statement](./pages/portal-bank-statement.md), [portal-submissions](./pages/portal-submissions.md)
- summary: 저장된 주사업과 별도로 session active project를 도입하고, 포털 진입을 `project-select` step으로 분리해 같은 화면을 유지한 채 사업 전환이 가능하도록 정리했다.

## [2026-04-14] patch-note | portal-project-select-shell | 포털 진입 사업 선택 step 신설
- pages: [portal-project-select](./pages/portal-project-select.md), [portal-dashboard](./pages/portal-dashboard.md)
- summary: 로그인 후 포털 진입을 `project-select` step으로 라우팅하고, 상단 search는 메뉴 이동이 아니라 담당 사업 전환과 관리자 공간 이탈만 담당하도록 정리했다.

## [2026-04-14] patch-note | portal-project-select-redirect | wrapped redirect 보존
- pages: [portal-project-select](./pages/portal-project-select.md)
- summary: 이미 `project-select?redirect=...` 형태인 포털 진입 URL을 다시 해석할 때도 redirect query를 지우지 않도록 안정성을 보강했다.

## [2026-04-15] patch-note | portal-onboarding-workspace-choice | 명시적 workspace 선택 우선
- pages: [portal-onboarding](./pages/portal-onboarding.md), [portal-project-select](./pages/portal-project-select.md)
- summary: workspace 선택 화면에서는 이전 admin redirect를 무조건 재사용하지 않고, 사용자가 고른 공간과 같은 성격의 경로만 유지하도록 정리했다.

## [2026-04-14] patch-note | portal-dashboard-submission-merge | 제출 상태 홈 흡수
- pages: [portal-dashboard](./pages/portal-dashboard.md), [portal-submissions](./pages/portal-submissions.md)
- summary: `내 제출 현황`의 핵심 제출 상태를 `/portal` 홈 안으로 흡수하고, 중복이던 `인력변경 신청`, `주간 제출 체크`, `사업비 입력(주간) 작성/제출` 블록은 홈 통합 섹션 밖으로 뺐다.

## [2026-04-14] patch-note | portal-weekly-expense | navigation guard와 bank wizard 회귀 복구
- pages: [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: 미저장 사업비 입력 편집은 화면 이동 전에 확인 다이얼로그로 막도록 복구했고, bank import triage wizard의 cashflow category 선택과 fullscreen/주간입력 연계 E2E도 다시 통과하도록 정리했다.

## [2026-04-15] patch-note | portal-bank-statement, portal-weekly-expense | direct handoff row projection
- pages: [portal-bank-statement](./pages/portal-bank-statement.md), [portal-weekly-expense](./pages/portal-weekly-expense.md)
- summary: 통장내역 저장 시 신규 은행 행을 현재 주간 사업비 탭으로 바로 merge하도록 바꿔, Queue 없이 `통장내역 -> 사업비 입력(주간)` 운영 경로가 실제로 이어지게 복구했다.

## [2026-04-15] patch-note | portal-cashflow, portal-dashboard | PM cashflow listen hardening
- pages: [portal-cashflow](./pages/portal-cashflow.md), [portal-dashboard](./pages/portal-dashboard.md)
- summary: PM용 cashflow 주차 구독은 Firestore에서 project 기준으로만 listen하고, 연도 범위는 클라이언트에서 필터링하도록 바꿔 PM 포털 부팅이 cashflow composite index drift에 직접 막히지 않게 보강했다.

## [2026-05-21] patch-note | portal-onboarding-feature-search | 로그인 후 검색 엔트리 정리
- pages: [portal-onboarding](./pages/portal-onboarding.md)
- summary: 로그인 성공 후 빈 화면 대신 짧은 전환 화면을 거쳐 기능 검색 엔트리로 이동하게 하고, 업무 화면 진입 후에는 `기능 검색` 자기 참조 메뉴를 제거했으며, 프로젝트 등록 검색은 기능 결과만 노출되도록 정리했다.

## [2026-07-21] patch-note | portal-project-registration | 사업관리 폴더와 다년도 재무 입력 복구
- pages: [shared-portal-architecture](./pages/shared-portal-architecture.md)
- summary: 프로젝트 등록·수정의 계약 대상 아래에 사업관리 Google Drive 폴더 링크를 추가하고, 다년도 사업은 연도별 계약금액·매출부가세·수익·지원금의 합계만 상단에 반영하도록 정리했다. 계약기간의 한 해라도 빠지거나 확인하지 않으면 BFF가 저장을 거절한다.

## [2026-08-09] patch-note | cashflow-month-cell-count | 결산 셀 수를 정책 파생 상수로 통합
- pages: [shared-label-policy](./pages/shared-label-policy.md)
- summary: 한 달 결산 셀 수를 policy JSON 파생 상수(`CASHFLOW_MONTH_CELL_COUNT`)로 통합했다. BFF 라우트의 리터럴 160과 안내 문구가 상수를 따르고, JVM 하드코딩 카탈로그는 같은 JSON 을 대조하는 parity 테스트로 고정된다. 라인이 추가되면 두 런타임이 함께 움직인다.

## [2026-08-25] patch-note | admin-participation-profile | 전문 프로필 레이블과 서버 필터
- pages: [admin-participation](./pages/admin-participation.md)
- summary: 참여율 표에 최종학력·영어·자격증 레이블을 추가하고, 권한이 있는 관리자에게만 URL 동기화 데이터 필터를 제공한다. 자격증은 최대 20개까지 선택하며 연속 선택 요청은 짧게 묶어 서버 집계를 조회한다.
