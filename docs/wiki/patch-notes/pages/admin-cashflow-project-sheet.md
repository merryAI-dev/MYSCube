# Admin Cashflow Project Sheet

- route: `/cashflow/projects/:projectId`
- primary users: admin, finance, 사업 운영 검토자
- status: active
- last updated: 2026-10-16

## Purpose

개별 사업의 projection, actual, compare, 제출/마감, 엑셀 export를 다루는 상세 캐시플로 작업 화면이다.

## Current UX Summary

- 월별 projection과 actual 비교, compare mode, 제출/마감 흐름이 한 화면에 모인다.
- 주간 accounting snapshot과 audit trail이 화면 해석의 근거가 된다.
- dirty state와 close 정책이 강하게 엮여 있어 변경 영향 범위가 넓다.

## Current Feature Checklist

- [x] 사업별 projection 확인 가능
- [x] actual과 compare mode 확인 가능
- [x] 제출 및 마감 흐름 처리 가능
- [x] dirty state 경고와 저장 차단 정책 존재
- [x] 주간 accounting snapshot과 audit trail 확인 가능
- [x] project 단위 export 흐름과 연결됨
- [x] 시트 표시값의 `미입력`, `0`, 금액 구분과 행별 이월값 보존
- [x] 월 결산 스냅샷과 시트 반영 revision을 같은 서버 증거로 검증
- [x] 시트 반영과 월 결산 동시 실행 차단 및 불확실한 요청 복구

## Recent Changes

- [2026-10-16] 결산 기록이 없는 프로젝트의 첫 월결산 구간을 2023-01이 아니라 결산 대상 월이 속한 해의 1월부터 계산하도록 JVM을 고쳤다(#933). 2026-09까지 첫 결산하면 45개월로 계산되어 44개월 한도에 걸려 조직장 승인이 실패하던 문제다. 기존 2023-01 시작 기록과 그 재오픈 범위는 바뀌지 않는다. 함께 운영 DB에서 화면으로 지울 수 없던 다른 연도 시트 연동(2027 1건, 2025 2건)을 정리했다. 다시 불러오기는 연도별 데이터를 기존 검토본에 덧붙이므로, 남은 연동으로 다른 연도를 불러오면 시트 반영이 `cashflow_sheet_formula_evidence_incomplete` 로 막힌다.
- [2026-07-24] 월 결산 스냅샷이 시트 반영 중간 상태를 읽지 못하도록 publication fence를 추가했다. 결산 증거는 고정된 revision과 hash를 사용하고, 결산 후 수정은 원본 스냅샷·현재 원장·수정 사유를 함께 남긴다. 재시도 시에는 브라우저 캐시가 아니라 서버가 보관한 입력을 사용해 중복 또는 다른 값의 반영을 막는다.
- [2026-07-20] 명시적 시트값 불러오기 뒤 다월 변경분을 JVM 원장에 반영하고, 반환된 프로젝트·월·금액을 시트 고정본과 재검증하도록 보강했다. 운영 대시보드와 주요 관리 항목은 반영된 JVM 원장을 우선 사용하며, 인건비 3주차 외 입력 위치와 Projection 잔액 마이너스 구간을 간결하게 표시한다. 불러오기·원장 반영 이력에는 수행자를 함께 남긴다.
- [2026-07-13] 화면 내부 이동 시 남은 캐시플로 입력을 개인 임시저장본에 저장한 뒤 수정 lease를 해제하도록 바꿨다. 저장에 실패하면 현재 화면에 남아 다시 시도한다.
- [2026-04-09] admin export 흐름과 project sheet의 workbook contract를 더 밀접하게 맞췄다.
- [2026-04-05] lazy heavy module 로딩 안정화를 넣었다.
- [2026-04-04] compare mode, guide preview, weekly accounting snapshot, audit trail, soft gate를 강화했다.
- [2026-03-18] close 흐름을 projection 기준으로 옮기고 settlement close 이후 projection 수정 허용으로 바꿨다.

## Known Notes

- 이 화면은 admin cashflow export와 별개가 아니라 같은 데이터 해석 체계 위에 있다.
- compare/close/dirty blocking 정책은 운영 규칙 변경 시 가장 먼저 영향을 받는다.

## Related Files

- `src/app/components/cashflow/CashflowProjectSheet.tsx`
- `src/app/components/cashflow/ProjectCashflowSheetPage.tsx`
- `src/app/components/cashflow/SettlementLedgerPage.tsx`
- `server/bff/routes/cashflow-sheet-lab.mjs`
- `server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java`
- `src/app/routes.tsx`

## Related Tests

- `src/app/components/cashflow/cashflow-unsaved.test.ts`
- `src/app/platform/cashflow-sheet.test.ts`
- `src/app/platform/weekly-accounting-state.test.ts`
- `src/app/platform/__tests__/settlement-e2e-scenarios.test.ts`
- `server/bff/routes/cashflow-sheet-lab.test.mjs`
- `server/jvm-weekly-api/src/test/java/dev/merryai/innerplatform/weekly/storage/FirestoreCashflowLeaseGuardTest.java`

## Related QA / Ops Context

- projection 저장, close 정책, dirty blocking, guide preview는 운영팀 질문이 다시 생기기 쉬운 포인트다.

## Next Watch Points

- compare mode와 close 정책이 export contract와 다시 어긋나지 않는지
- dirty blocking이 정상 저장 이후에도 남지 않는지
- weekly snapshot과 audit trail이 projection/actual 해석과 계속 일치하는지
- 시트 반영과 월 결산 race가 발생해도 close snapshot이 생성되지 않는지
- 연도 시트 연동을 화면에서 지울 수 없어, 다른 연도 연동이 다시 남지 않는지(2027 전환 전 다년도 시트·연도 연동 삭제 UI 필요)
- BFF 월결산 근거 생성 범위(2023-01~, 최대 240개월)가 JVM(대상 연도 1월~, 44개월 한도)과 아직 다르다
- 검토본이 STALE로 남은 프로젝트(연동 시트 교체 후 불러오기 실패)는 월결산 전에 다시 불러와야 한다
