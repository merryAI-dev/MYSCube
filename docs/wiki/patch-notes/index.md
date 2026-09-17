# Patch Notes Wiki

화면 단위 변경 이력을 누적 관리하는 운영 위키입니다. 코드와 PR 사이에서 "이 페이지에서 최근 무엇이 바뀌었는가"를 빠르게 복기하고, "지금 실제로 되는 기능이 무엇인가"를 체크리스트로 확인하기 위한 문서 계층입니다.

## Seed Pages

| Page | Route | Last Updated | 현재 구현 체크포인트 |
| --- | --- | --- | --- |
| [admin-project-approvals](./pages/admin-project-approvals.md) | `/approvals`, `/projects/migration-audit` | 2026-09-17 | 승인 상태 필터 및 요약·대기 건수 기준 통일 |
| [portal-dashboard](./pages/portal-dashboard.md) | `/portal` | 2026-04-15 | 포털 홈 safe fetch, 현재 상태 중심, 최소 CTA 유지 |
| [portal-payroll](./pages/portal-payroll.md) | `/portal/payroll` | 2026-04-15 | 포털 경로 fetch 기반 거래 조회, 지급일/공지 확인 유지 |
| [portal-weekly-expense](./pages/portal-weekly-expense.md) | `/portal/weekly-expenses` | 2026-04-14 | 기준본에서 이어쓰기, 저장 상태 구분, overwrite/backspace 복구 |
| [portal-bank-statement](./pages/portal-bank-statement.md) | `/portal/bank-statements` | 2026-04-14 | 원본 업로드, intake queue 정리, 사업비 입력으로 이어가기 |
| [portal-budget](./pages/portal-budget.md) | `/portal/budget` | 2026-04-14 | 가져오기 미리보기, 긴 모달 스크롤, 구조 저장 보호 |
| [portal-cashflow](./pages/portal-cashflow.md) | `/portal/cashflow` | 2026-04-14 | compact import action, projection 작업면 중심 |
| [portal-onboarding](./pages/portal-onboarding.md) | `/login`, `/workspace-select` | 2026-04-14 | Guided Start 제거, 빠른 인증/진입 유지 |
| [portal-project-settings](./pages/portal-project-settings.md) | `/portal/project-settings` | 2026-04-14 | 검색/선택/저장 중심, 상태 배너 제거 |
| [portal-edit-project](./pages/portal-edit-project.md) | `/portal/edit-project` | 2026-04-14 | 중복 subtitle 제거, 폼 진입 단순화 |
| [portal-register-project](./pages/portal-register-project.md) | `/portal/register-project` | 2026-04-14 | 직접입력형 자금 흐름, 초안 저장, 계약 예외 처리 |
| [portal-submissions](./pages/portal-submissions.md) | `/portal/submissions` | 2026-04-14 | 수요일 기준 작성 여부, projection 수정 기준 표시 |
| [admin-dashboard](./pages/admin-dashboard.md) | `/` | 2026-04-14 | 작성 가이드 제거, KPI/이동 액션 중심 |
| [admin-participation](./pages/admin-participation.md) | `/participation` | 2026-04-14 | 프로토콜 가이드 제거, 검증 결과 중심 |
| [admin-cashflow-export](./pages/admin-cashflow-export.md) | `/cashflow` | 2026-04-14 | 사업별/전체 추출, 정산 기준 필터, projection-only export |
| [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md) | `/cashflow/projects/:projectId` | 2026-04-14 | compare mode, close 흐름, 주간 snapshot 해석 |
| [admin-users-auth-governance](./pages/admin-users-auth-governance.md) | `/users` | 2026-04-14 | drift 확인, deep sync, auth/member 정렬 운영 |
| [shared-label-policy](./pages/shared-label-policy.md) | `shared / policy` | 2026-04-15 | cashflow label↔enum↔line id↔export 기준 통합 |
| [shared-portal-architecture](./pages/shared-portal-architecture.md) | `shared / architecture` | 2026-04-15 | Firestore 유지, BFF/API-first, route-scoped provider split과 portal bootstrap loop 분리 |

## How To Use

- 각 페이지 문서의 `Current Feature Checklist`에서 지금 실제로 되는 기능을 먼저 확인합니다.
- 구현이 빠졌거나 제거한 항목은 `[ ]`로 남깁니다.
- 새 기능이 생기면 항목을 추가하고, 불필요해진 항목은 지우거나 체크 해제하면 됩니다.

## High Attention

- [portal-weekly-expense](./pages/portal-weekly-expense.md)
- [portal-dashboard](./pages/portal-dashboard.md)
- [portal-budget](./pages/portal-budget.md)
- [portal-bank-statement](./pages/portal-bank-statement.md)
- [portal-onboarding](./pages/portal-onboarding.md)
- [admin-dashboard](./pages/admin-dashboard.md)
- [admin-participation](./pages/admin-participation.md)
- [admin-cashflow-export](./pages/admin-cashflow-export.md)
- [admin-cashflow-project-sheet](./pages/admin-cashflow-project-sheet.md)
- [admin-users-auth-governance](./pages/admin-users-auth-governance.md)
- [shared-label-policy](./pages/shared-label-policy.md)
- [shared-portal-architecture](./pages/shared-portal-architecture.md)

## Related Repo Context

- QA memory: [qa-feedback-memory.md](../../operations/qa-feedback-memory.md)
- QA memory JSON: [qa-feedback-memory.json](../../operations/qa-feedback-memory.json)
- 설계 문서: [2026-04-14-page-patch-notes-wiki-design.md](../../operations/2026-04-14-page-patch-notes-wiki-design.md)
- 구현 계획: [2026-04-14-page-patch-notes-wiki-plan.md](../../operations/2026-04-14-page-patch-notes-wiki-plan.md)
- 가이드 단순화 설계: [2026-04-14-guide-simplify-and-patchnote-hook-design.md](../../operations/2026-04-14-guide-simplify-and-patchnote-hook-design.md)
- 가이드 단순화 계획: [2026-04-14-guide-simplify-and-patchnote-hook-plan.md](../../operations/2026-04-14-guide-simplify-and-patchnote-hook-plan.md)
- 포털 하이브리드 RFC: [portal-stabilization-hybrid-rfc-2026-04-15.md](../../architecture/portal-stabilization-hybrid-rfc-2026-04-15.md)
- 포털 하이브리드 실행 계획: [2026-04-15-portal-hybrid-stabilization-plan.md](../../operations/2026-04-15-portal-hybrid-stabilization-plan.md)
