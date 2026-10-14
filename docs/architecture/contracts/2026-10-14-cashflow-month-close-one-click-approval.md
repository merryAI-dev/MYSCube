# 월결산 승인 계약 — 조직장 승인은 버튼 한 번

**날짜:** 2026-10-14
**상태:** 구현 완료 · 배포 전
**선행:** [읽기 경로 계약](./2026-08-18-cashflow-read-path-contract.md) · [시트 규칙 불일치 알림 전환](./2026-09-30-cashflow-sheet-notify-amendment.md)

## 원칙

조직장 승인은 그룹웨어·SaaS 결재 버튼과 같다. **"내가 본 그 요청을 승인한다"** 만 확인하고 상태를 바꾼다.
결산 근거는 실무자가 **제출할 때 고정**되고, 조직장은 그 근거를 화면과 문서로 직접 본다.
승인 순간에 시트·주차 데이터를 다시 계산하거나 다시 쓰지 않는다.

성공의 척도는 늘어난 줄이 아니라 **사라진 검사 수**다.

## 발단 — 2026-10-14 라이브

`p1775184851612-2026-10` 승인이 `409 weekly_expense_conflict` "요청을 처리할 수 없습니다. 최신 상태와 입력 내용을 확인해 주세요." 로 반복 실패했다.
조직장은 시트를 바꾸지 않았다. 운영 데이터로 대조한 결과:

| 확인 | 결과 |
|---|---|
| 12개월 target revision 재계산 | 요청 기록값 `sha256:f9be…` 와 **일치** |
| 주차 문서 마지막 수정 | 08:08:26 — 제출(08:09:13) **이전** |
| 45개월 shard 해시 · manifest 해시 | 전부 정상 |
| 요청 상태 · coordinator · 결산 상태 | `PENDING_APPROVAL` / w7 / `SUBMITTED` 정상 |
| 시트 반영 잠금 | `APPLIED` (잠금 아님) |
| 주차 문서 60개 형태 | 전부 표준 |

그런데도 막혔고, **어느 검사가 막았는지 어디에도 남지 않았다.** JVM 은 409 사유를 로그에 쓰지 않고, BFF(`java-weekly-client.mjs`) 는 `weekly_expense_conflict` 원문을 공통 문구로 바꾼다.
같은 시점 승인 대기 12건 중 다수가 10/08~10/12 제출 후 승인되지 못한 채 남아 있다.

## AS-IS — 승인 한 번에 도는 숨은 검사

`POST /month-close/requests/:requestId/status-review` (APPROVE)

```
BFF approveCanonicalCashflowSettlementCycle
  ├─ 입력 형식 검사                                   ~20 조건
  ├─ 정본 상태 재조회 + 일치 검사                       ~17 조건 (health, 요청/월/주기/대상월, revision×3, hash, workflow …)
  ├─ 승인자 capability
  ├─ JVM POST /month-close ─────────────────────────────────────────────┐
  │                                                                     │
  │  JVM closeCashflowMonth                                             │
  │   ├─ 시트 반영 잠금 (requireCashflowSheetPublicationReady)           │
  │   ├─ requireCumulativeCloseApproval                    17 예외      │
  │   │    헤더·주기·45개월 연속성·shard 존재/범위/해시·manifest 해시     │
  │   │    · 결산 상태 SUBMITTED · 누적 범위 확장                        │
  │   ├─ shard 셀 검사  45개월 × 160칸 × (순서·상태·정수·범위)           │
  │   ├─ 대상월 종료 · 월 상태 · ledger revision                         │
  │   └─ replaceCashflowSheetMonthForMonthClose  ← 승인인데 "쓰기"       │
  │        월 열림 · 주차 문서 60개 형태 (쓰기 전/후 2회)                 │
  │        · 12개월 target revision 재계산 비교                          │
  │        · cashflow_weeks 덮어쓰기 · mirror 갱신                       │
  ├─ 응답 receipt 검사                                ~20 조건 (불일치 시 502)
  └─ 정본 재조회
```

**문제**

1. 40개 이상 조건이 전부 하나의 409/502 문구로 수렴한다. 사용자는 무엇을 고쳐야 할지 모른다.
2. 승인 시점에 **실시간 시트 상태**를 다시 비교한다. 제출 후 어떤 주차든 바뀌면(당월 PM 입력 포함) 승인이 막히고, 실무자는 회수 → 재요청을 반복한다.
3. 승인이 `cashflow_weeks` 를 덮어쓰는 **쓰기 작업**이다. 결산 snapshot 은 이미 shard 셀로 만들어지므로 이 쓰기는 결산 기록에 기여하지 않는다.

## TO-BE — 승인 = 상태 전환

```
BFF approve
  ├─ 입력: decision=APPROVE, expectedRevision, expectedManifestHash, idempotencyKey
  ├─ ① 지정 승인자인가                     (capability, 실패 시 403 + 사유)
  ├─ ② 내가 본 그 요청인가                 요청 PENDING_APPROVAL && evidenceRevision·manifestHash 일치
  │                                        (아니면 409 "요청이 회수·변경되었습니다" — 화면에 사유 표시)
  ├─ ③ 이미 승인한 같은 요청인가           idempotency replay → 기존 결과 반환
  └─ JVM POST /month-close (settlementCycle)
       ├─ 요청 헤더 ②와 같은 기준으로 재확인 (동시성 보호)
       ├─ shard 를 읽어 snapshot 구성 (해시 재계산·셀 재검사 없음)
       ├─ 쓰기: monthly_closes CLOSED · version · 누적 head/closedRanges
       │        · 요청 APPROVED · coordinator · 결산 상태 LOCKED · 감사 기록
       └─ 실패 시 code=cashflow_month_close_approval_blocked + reason → BFF 가 한국어 사유로 표시
```

### 무엇이 빠지는가

| 검사 | 처리 | 이유 |
|---|---|---|
| 12개월 target revision 재계산 비교 | **삭제** | 제출 후 시트 변경은 허용한다 (결산 근거는 제출 시 고정) |
| `cashflow_weeks` 재기록 · mirror 갱신 | **삭제** | snapshot 은 shard 셀로 만든다. 재기록은 결산 기록에 기여하지 않는다 |
| 주차 문서 형태 검사 (승인 경로) | **삭제** | 재기록이 없으면 읽지 않는다 |
| 시트 반영 잠금 | **삭제** | 승인은 시트를 쓰지 않는다 |
| shard 해시 · manifest 해시 · 셀 재검사 | **삭제** | 제출 단계에서 BFF 가 계산·저장한 값. 조직장이 본 근거는 manifestHash 일치로 확인한다 |
| 결산 상태 `SUBMITTED` 재확인 · 주기/대상월 재확인 | **삭제** | 요청 상태 `PENDING_APPROVAL` 하나로 판단한다 |
| BFF 응답 receipt 20조건 · 정본 재조회 일치 검사 | **축소** | 쓰기 성공 후 502 를 만들지 않는다. `ok`·`status=CLOSED`·`requestId` 만 본다 |
| 승인자 · 요청 상태/근거 일치 · idempotency | **유지** | 결재 버튼의 최소 조건 |
| 누적 범위 확장 (이미 결산된 기간 재결산 방지) | **유지 + 사유 표시** | 데이터 무결성. 실패 시 "이미 결산된 기간입니다" |

### 무엇이 그대로인가

- 승인 결과로 쓰는 문서와 필드 형태(`monthly_closes`, `monthly_close_versions`, `cashflow_cumulative_close_heads`, `closedRanges`, 요청, coordinator, `cashflow_settlement_statuses`). 재오픈 · 다음 달 결산 · 대시보드는 영향 없음.
- 제출 · 회수 · 반려 · 재오픈 경로.
- 결산 대상월 셀 snapshot 내용 (원래도 shard 셀로 구성).
- 옛 방식(비 settlement-cycle) 누적 결산 경로 — 이번 변경 범위 밖.

### 허용하는 동작 변화

- 제출 후 승인 전에 시트·주차 값이 바뀌어도 승인된다. 결산 기록은 **제출 시점 snapshot** 이고, 현재 `cashflow_weeks` 는 그 뒤 값일 수 있다.
  마감 월을 읽는 화면은 snapshot 을 읽는다 (읽기 경로 계약 "CLOSED 면 snapshot").

## 기존 데이터(레거시) 적용

2026-10-14 운영 `cashflow_month_close_requests` 163건 분류:

| 대상 | 건수 | 적용 |
|---|---|---|
| 현재 형식 승인 대기 (`cashflow-cumulative-close-v2`, 주기 2026-10) | 12 | 배포 즉시 새 승인 적용. 데이터 변환 없음. **회수·재요청 불필요** |
| 승인 완료 | 82 | 영향 없음 |
| 결산 주기 전환 이전 2026-08 요청, 이후 결산 승인됨 | 14 | 대체된 기록. 승인 대상 아님 |
| 결산 주기 전환 이전 2026-08 요청, 이후 결산 없음 (`p1775183713143`) | 1 | 현재 화면에서 다시 제출 필요 (담당자 확인) |

## 변경 파일

- `server/jvm-weekly-api/.../FirestoreInheritedWeeklyExpensePersistence.java` — settlement-cycle 승인 분기 축소, 재기록 생략
- `server/jvm-weekly-api/.../api/CashflowMonthCloseApprovalBlockedException.java` (신규) + `WeeklyExpenseController` 핸들러
- `server/bff/routes/jvm-weekly-api.mjs` — `approveCanonicalCashflowSettlementCycle`, receipt 검사 축소
- `server/bff/java-weekly-client.mjs` — `cashflow_month_close_approval_blocked` 사유 표시
- `server/mcp/code-evidence.generated.mjs` — 줄 번호 이동에 따른 재생성 (`node scripts/generate-agent-code-evidence.mjs`)
- 테스트
  - BFF: 한 번 클릭 승인 + 반복 클릭은 JVM 재호출 없이 승인 상태로 응답, 회수·재제출된 요청은 사유 표시, JVM 차단 사유 코드 → 한국어 문장
  - JVM 에뮬레이터: 제출 후 주차 값 변경 + 시트 반영 중이어도 승인되고 `cashflow_weeks` 를 쓰지 않음, 회수된 요청은 `REQUEST_CHANGED`
    (이 테스트는 이전 코드에서 "Cashflow sheet values are being applied" 로 실패함을 확인)

## 배포 주의

운영 JVM 은 `innerplatform-jvm-weekly-api-live-hotfix-1c6d0817` 리비전에 트래픽 100% 로 고정돼 있다.
main 의 JVM 을 배포하면 아직 운영에 없는 #854(정산 규칙 불일치 알림 전환)도 함께 나간다. 머지 전 확인한다.

## 검증

- JVM: `mvn -f server/jvm-weekly-api/pom.xml test`
- BFF: `npm test`, `npm run bff:test:integration`
- JVM 에뮬레이터 통합 테스트(`FirestoreSettlementCycleEmulatorIT`)는 **CI 에 연결돼 있지 않고**, 안내된 실행 스크립트
  (`scripts/test-settlement-cycle-emulator.sh`)도 저장소에 없다. 로컬 실행:
  `FIREBASE_PROJECT_ID=demo-bff-it npx firebase-tools emulators:exec --only firestore --project demo-bff-it --config <rules 없는 설정> "mvn -f server/jvm-weekly-api/pom.xml -Dtest=FirestoreSettlementCycleEmulatorIT -Dsurefire.failIfNoSpecifiedTests=false test"`
- 라이브 확인: 승인 대기 12건 중 1건 승인 → `monthly_closes` CLOSED · head · 결산 상태 LOCKED 확인
