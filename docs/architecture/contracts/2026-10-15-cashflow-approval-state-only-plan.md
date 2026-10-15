# 조직장 승인(월결산·주정산) — 상태 전환만 하는 계획안

**날짜:** 2026-10-15 · **상태:** 1단계(JVM) 구현 중 — 지정 승인자 확인은 유지, 결재·검토 과정은 모두 삭제로 확정
**대상:** `/cashflow` 관리자 화면의 조직장 승인 — 월결산, 주정산

## 결정 (사용자)

승인 버튼은 **별도 승인·검토·확인 로직 없이 status 만 바꾼다.**
실무자가 제출 전에 모두 확인했다고 가정한다. 승인 시점에 서버가 다시 검증하지 않는다.

## 배경

- 10/14 `p1775184851612-2026-10` 승인이 `409` 로 반복 실패. 10/15 15:00(KST) 에도 새 JVM(`hotfix-04052926`) 에서 `POST /month-close` 가 `409` (사유 로그 없음).
- #922(JVM)·#923(BFF) 로 검사를 40여 개 → 약 7개로 줄였지만 아직 "상태만 바꾸는" 구조가 아니다.
- 운영 데이터 대조 결과(읽기 전용): 요청 `PENDING_APPROVAL`, 근거 r4 shard 존재, 결산 기록 존재, 지정 승인자 권한 정상. 즉 **데이터 문제가 아니라 승인 경로의 남은 조건 어딘가에서 막힘.**

## 현재 승인 경로와 남은 막힘 후보

### 월결산 (BFF → JVM `POST /month-close`)

| 위치 | 남은 조건 | 승인 시 처리 |
|---|---|---|
| BFF `approveCanonicalCashflowSettlementCycle` | 요청 id·`evidenceRevision`·`manifestHash` 일치, `PENDING_APPROVAL` 아니면 409 | 제거 |
| BFF 동일 | `APPROVE_MONTH_CLOSE` capability(지정 승인자) 아니면 403 | **유지(권한)** — 아래 "남기는 것" |
| BFF 동일 | 영수증 `ok/CLOSED/requestId` 아니면 502, 이후 readback | 영수증 확인만 남기고 readback 으로 막지 않음 |
| JVM `requireSettlementCycleApproval` | 요청 없음 / 요청 불일치(`REQUEST_CHANGED`) | 요청 존재만 확인, 나머지 비교 제거 |
| JVM 동일 | 코디네이터 `finishReview` 위반 → `REQUEST_CHANGED` | 코디네이터 상태만 전환(위반 시 보정) |
| JVM 동일 | 월별 shard 누락 → `EVIDENCE_MISSING` | 제출 때 고정된 값만 사용, 누락이어도 막지 않음 |
| JVM 동일 | 결산 진행 기록 없음 → `SETTLEMENT_STATUS_MISSING` | 없으면 생성 |
| JVM 동일 | 이미 결산된 기간 → `ALREADY_CLOSED` | 이미 승인이면 재처리 없이 성공 응답(idempotent) |
| JVM `closeCashflowMonth` | 대상 월이 끝나기 전이면 409 (`available after the target month ends`) | 제거 |
| JVM 동일 | `expectedRevision` 불일치 → 409 | 제거, 현재 revision 사용 |

### 주정산 (BFF → JVM `POST /settlement-statuses/transition`, `APPROVE`)

| 위치 | 남은 조건 | 승인 시 처리 |
|---|---|---|
| JVM `transitionCashflowSettlementStatus` | 프로젝트 지정 승인자 아니면 403 | **유지(권한)** |
| 동일 | 주차 완료 문서 없음 → `Submit the week before approving` | 제거(문서 없으면 상태만 `COMPLETED`) |
| 동일 | 현재 상태가 `PENDING_APPROVAL` 아니면 `status changed` 409 | 제거, 이미 `COMPLETED` 면 그대로 반환 |
| 동일 | `confirmCashflowWeeklyUpdate`(주차 재확정·시트 동기화) | 제거, `periods.WEEK_n.status=COMPLETED` + `approvedAt/By` 만 기록 |

## 남기는 것 (검증이 아니라 안전장치)

1. **누가 승인할 수 있는가**(역할·지정 승인자). 상태만 바꾸더라도 아무나 승인하면 안 된다. 이것은 "검토 로직"이 아니라 권한이다.
   → 지정 승인자 확인을 없애길 원하시면 별도로 결정 필요.
2. **중복 클릭 보호**(idempotency key). 같은 요청 두 번 눌러도 한 번만 반영.
3. **누가 언제 승인했는지 기록**(`approvedAt/By`, 감사 로그).

## 알려진 부작용 (결정 시 인지된 사항)

- 승인 시 월 결산 스냅샷·누적 결산 헤드를 **다시 계산하지 않는다.** 제출 시점에 고정된 값이 그대로 결산 값이 된다.
- 제출 후 시트가 바뀌어도 승인은 막지 않는다 (이미 #913 의 TO-BE).
- 주정산은 승인 시 시트·완료 문서를 재동기화하지 않으므로, 제출 후 변경분은 승인 후 값에 반영되지 않을 수 있다.
- 조직장이 오래된 화면에서 눌러도 최신 요청이 승인된다. (요청 id 만 일치하면 처리)

## 구현 순서 (배포 분류기 주의)

`atomic_cutover` 분류(JVM + 웹 결산 경로 동시 변경)를 피하기 위해 **PR 을 나눠 순차 배포**한다. 오늘 확인한 규칙:
- JVM(`server/jvm-weekly-api`) 변경과 BFF 결산 경로(`server/bff/routes/jvm-weekly-api.mjs`, `src/app/components/cashflow/` 등) 변경을 한 PR 에 섞지 않는다.
- 배포 후 `Production Deploy` 가 실제로 Vercel 에 나갔는지(Skip 단계가 아닌지) 확인한다. 초록이어도 건너뛰었을 수 있다.

1. **JVM PR** — 위 표의 JVM 항목 완화. 월결산·주정산.
   - 테스트: 새 승인 경로 테스트 갱신(막던 케이스가 성공하도록), `mvn test` 는 CI 에서.
2. **BFF PR** — `approveCanonicalCashflowSettlementCycle` 완화(요청 id 만 확인), 영수증 확인만.
3. **배포 확인** — 각 단계마다 워크플로 결과 확인.
4. **운영 확인** — `p1775184851612-2026-10` 승인, 주정산 승인 1건.

## 롤백

- 태그 `rollback/pre-month-close-approval-20261015` (배포 전 main `7c3bd4ab`).
- JVM: 트래픽을 이전 리비전으로(현재 `hotfix-04052926`, 그 이전 `hotfix-1c6d0817`).
- 웹: Vercel alias 를 이전 배포로.

## 열린 질문

1. ~~지정 승인자(권한) 확인~~ → **유지로 확정.** 적합한 사람이 상태를 한 번에 바꾼다.
2. 주정산도 월결산과 같이 "결산 문서만 남기고 재동기화 없음"으로 가정했다.
3. 이미 막혀 있는 `p1775184851612-2026-10` 은 JVM PR 배포 직후 바로 승인해 볼 수 있다.

## 관련

- `docs/architecture/contracts/2026-10-14-cashflow-month-close-one-click-approval.md` (이전 계약, 40+ → 3 검사)
- `docs/operations/2026-10-14-production-release-unblock.md`
- PR #922, #923
