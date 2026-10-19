# SPEC-19 — 월 결산 대시보드 읽기 범위 분석

**조사 기준:** worktree `0e82d933`, SPEC-12 성능 커밋 `67586182` 별도 대조  
**결론:** **조건부로 좁힐 수 있다.** 화면은 선택 연도의 주차 상세와 그 밖의 연도의 연간 합계를 표시하므로, 데이터 계약을 선택 연도 최대 60주 + 연간 합계로 바꾸면 540주 원본을 피할 수 있다. 그러나 현재 `CashflowLedgerSource.targetRevision`은 읽은 주차 문서 전체의 해시이고 `LIVE_AMENDED` 검증에 쓰이므로, 무범위 조회를 범위 오버로드로 단순 교체하는 안은 Task #16 없이 안전하지 않다.

## 조사 한계와 증거 기준

- 저장소에는 2026-07-27 단일 스테이지 측정 기록만 있고 이후 동일 환경 재측정 결과나 Firestore export는 없다. 따라서 현재 p95, 현재 응답 바이트, 프로젝트별 실제 평균/최대 문서 수는 **미확인**이다 (`docs/architecture/2026-07-27-jvm-bff-channel-audit.md:68-74`).
- 커밋 `67586182`는 이 worktree HEAD의 조상이 아니다. 아래에서 `[67586182]`로 표시한 줄은 `git show 67586182:<파일>` 기준이다. 그 커밋은 읽기 필드 선택만 바꾸며 HTTP 응답 DTO를 바꾸지 않는다 (`[67586182] server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java:89-92,3480-3500`).
- 정량 p95는 재측정값이 아니라 2026-07-27 관측값에 문서 수 비율을 적용한 **용량계획 예측**이다. 고정 비용과 병렬 읽기 때문에 선형성이 보장되지 않으므로 Freeze Unit의 스테이지 측정으로 판정해야 한다.

## Q1. 540개 `cashflow_weeks` 문서는 어디에 쓰이는가

### 원장 필드별 흐름

| `CashflowLedgerSource` 필드 | 서버 소비처 | 실제 목적 |
|---|---|---|
| `projection` | 각 원장 line을 원시 `projection` 배열로 복사하고 동일 배열에서 월별 `readModel`을 다시 만든다 (`WeeklyExpenseController.java:307-318,328-334,889-915`) | 선택 연도 보드/연간 범위 합계와 전체 사업기간 Projection 합계. JVM 응답 안에서는 원시 배열과 집계 모델이 중복 표현이다 (`CashflowSnapshotResponse.java:7-12,31-65`). |
| `actual` | 각 원장 line을 원시 `actual` 배열로 복사하고 월별 `readModel`을 다시 만든다 (`WeeklyExpenseController.java:319-334,889-915`) | 선택 연도 보드와 Projection-Actual 비교. BFF는 선택 연도 범위를 계산한다 (`server/bff/routes/jvm-weekly-api.mjs:1054-1068,1831-1854`). |
| `weeklyYears` | 선택 연도 이전의 주간 원장 연도를 연간 집계 fallback에서 제외한다 (`WeeklyExpenseController.java:481-487`; `WeeklyExpensePersistence.java:783-817`) | 전년도 opening balance에서 주간 원장과 `cashflow_sheet_year_totals`의 이중 합산 방지. 금액 원본이 아니라 **연도 집합**만 필요하다. |
| `targetRevision` | `CashflowSnapshotResponse`에 싣고, `LIVE_AMENDED`면 저장된 `resultingTargetRevision`과 일치하는지 검사한다 (`WeeklyExpenseController.java:328-334,494-507`) | amended CLOSED 월의 원장 안정성 검증. 화면 계산용 금액이 아니다. |

무범위 Firestore 쿼리는 `projectId`만 조건으로 프로젝트의 모든 주차 문서를 읽는다 (`FirestoreInheritedWeeklyExpensePersistence.java:2531-2535`). 각 문서의 `projection`과 `weeklyExpenseActualBySheet`를 line 목록으로 확장하고, 같은 문서 전체로 revision을 계산한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2563-2606`).

### 전 기간 원본이 실제로 필요한 계산

현재 코드가 전 기간 원본을 쓰는 곳은 두 가지다.

1. 전체 사업기간 Projection `totalIn`, `SALES_IN + SALES_VAT_IN`, 포함 연도 목록: BFF가 `cashflow.readModel.months` 전체를 순회한다 (`server/bff/routes/jvm-weekly-api.mjs:1233-1247,1263-1292`).
2. 전체 원장 revision: 읽은 모든 문서를 정규화하여 해시한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2601-2620`).

1은 선택 연도 밖에서는 주차 원본이 아니라 행별 연간 합계와 연도 집합이면 충분하다. 2는 현재 계약상 전체 문서가 필요하며 Q4의 Task #16 분기다. `cashflowReadModelForYear`라는 이름과 달리 함수는 `canonical.months`를 필터링하지 않고 선택 연도 `range`만 덧붙인다 (`server/bff/routes/jvm-weekly-api.mjs:1054-1068`). React는 전체 `canonical.months`에서 각 연도 합계를 만들고, 선택 연도에는 주차 상세를 찾는다 (`CashflowProjectSheet.tsx:1767-1787,2112-2129,2418-2434`).

## Q2. 프론트가 month-close 응답에서 쓰는 필드

프론트는 선택한 `yearMonth`로 BFF를 호출한다 (`CashflowProjectSheet.tsx:686-720`). 화면의 원장 관련 소비는 다음과 같다.

- `dashboard.canonical.months/range`: 선택 연도 연간 열, 주차 열, Projection-Actual 차이표 (`CashflowProjectSheet.tsx:1767-1787,2112-2129,2418-2434`).
- `dashboard.totals`: 선택 월 주차값의 fallback (`CashflowProjectSheet.tsx:2122-2129`).
- `dashboard.openingBalances`: 선택 연도 이전의 연간 source와 이월액 (`CashflowProjectSheet.tsx:1772-1787,2113-2121`).
- `dashboard.projectionActualSummary`: 누적 결산 타일 (`CashflowProjectSheet.tsx:2583-2593`).
- `dashboard.summary`: 계약대비 Projection, Actual/확인/정산 진행률과 마감일 (`CashflowProjectSheet.tsx:2577-2639,2844-2844`).
- `snapshotCompatibility`, `monthCloseStatuses`, `deadlineSummary`, `cumulativeCloseScope`, `postCloseAdjustment`: legacy 안내, 월/주 상태, 결산 범위와 사후조정 표시 (`CashflowProjectSheet.tsx:2098-2104,2421-2425,2763-2803,2908-2920,3123-3125`).

프론트에 반환되는 `dashboard.canonical`은 BFF에서 선택 연도 `range`를 붙이지만 `months`는 전체를 그대로 보존한다 (`server/bff/routes/jvm-weekly-api.mjs:1054-1068,1831-1838,2063-2069`). 따라서 현재 응답에는 모든 연도의 월/주 상세가 있고 React도 이를 연도 합계 계산에 소비한다 (`CashflowProjectSheet.tsx:1767-1787`). 다만 UI가 그 상세를 그대로 그리는 것은 아니다. 선택 연도는 최대 12개월/60주를 주차 열로 표시하고, 이전/이후 연도는 `summarizeCanonicalCashflowYear` 결과인 연간 열로 표시한다 (`CashflowProjectSheet.tsx:1758-1787,2105-2129`). 즉 **전 기간 데이터 소비는 맞지만 전 기간 주차 해상도는 불필요하다.**

JVM `cashflow`의 원시 `projection`, 원시 `actual`, `targetRevision`은 BFF가 최종 `dashboard` 응답에 그대로 노출하지 않는다. BFF는 `cashflow.readModel`만 연도/합계 계산에 쓰고 최종 반환은 compose 결과다 (`server/bff/routes/jvm-weekly-api.mjs:1831-1854,1931-1950,2008-2069,2596-2625`). 따라서 JVM→BFF 구간의 원시 두 배열은 중복 필드이며 전용 dashboard DTO에서는 제거 가능하다. 최종 270KB에는 `canonical.months`의 전 기간 주차 상세가 남으므로, 선택 연도 밖을 연간 합계로 바꾸면 최종 응답도 줄일 수 있다. 다만 구성별 바이트 측정이 없어 감소량은 아직 미확인이다 (`docs/architecture/2026-07-27-jvm-bff-channel-audit.md:68-74`).

## Q3. 기존 집계 문서로 대체 가능한가

### `cashflow_cumulative_close_heads`

저장/응답 필드는 `status`, `fromMonth`, `closedThrough`, `rootHash`, `revision(headRevision)` 다섯 가지다 (`WeeklyExpensePersistence.java:339-345`; `FirestoreInheritedWeeklyExpensePersistence.java:1495-1509`; `CashflowMonthDashboardSourceResponse.java:22-28`). 결산 범위/체인 검증에는 충분하지만 금액이나 주차 셀은 없으므로 원장 금액 대체재는 아니다.

### `cashflow_sheet_year_totals`

연도별 `projection`, `actual`, 각 mode의 cell state를 제공한다 (`WeeklyExpensePersistence.java:153-159`; `FirestoreInheritedWeeklyExpensePersistence.java:2508-2523`). 현재도 선택 연도 이전 opening balance에서 주간 원장이 없는 연도만 골라 line 합계와 source를 만든다 (`WeeklyExpensePersistence.java:783-824`). 따라서 전년도 연간 열과 opening balance에는 충분하다. 선택 연도의 주차별 5칸 및 월별 비교에는 주차 해상도가 없어 충분하지 않다.

### `monthly_closes`

확정 월은 저장된 `snapshot`에서 `openingBalances`, `ledgerWeeks`와 canonical을 복원하며 원장을 읽지 않는다 (`WeeklyExpenseController.java:471-490,543-557`; `server/bff/routes/jvm-weekly-api.mjs:1802-1838`). 즉 CLOSED/REOPEN_REQUESTED 화면에는 월 snapshot이 충분하다. OPEN 월에는 snapshot이 아직 없어 현재 원장의 선택 범위가 필요하다.

SPEC-12 커밋 `67586182`가 선택한 6필드는 다음과 같다.

1. `contractVersion`
2. `yearMonth`
3. `revision`
4. `reopenCount`
5. `status`
6. `postDeadlineAmendmentWarningCount`

근거는 `[67586182] FirestoreInheritedWeeklyExpensePersistence.java:89-92`이며 두 프로젝트 전체 월 조회가 같은 select를 쓴다 (`[67586182] ...:3480-3500`). 이 6개는 월 상태/경고 카운터 집계에는 충분하지만 `snapshot`, `snapshotHash`, opening balance, 주차 셀, 금액은 없으므로 dashboard 원장 대체에는 불충분하다. 또한 select는 Firestore **문서 수**를 줄이지 않고 필드 바이트만 줄인다.

## Q4. 무범위 조회가 `computeCashflowTargetRevision`에 흐르는가

**그렇다.** 무범위 오버로드는 전체 프로젝트 snapshot을 `cashflowLedgerSource`에 넘기고 (`FirestoreInheritedWeeklyExpensePersistence.java:2531-2535`), 그 메서드는 모든 문서를 `documents`에 모은 뒤 `computeCashflowTargetRevision(documents)`를 `targetRevision`으로 반환한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2556-2606`). revision 함수는 월/주와 actual, adminClosed, projection, sheet별 actual을 포함한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2609-2620`).

그 revision은 `LIVE_AMENDED`의 저장된 `resultingTargetRevision`과 비교되어 불일치 시 재시도/충돌로 처리된다 (`WeeklyExpenseController.java:494-507`). 따라서 범위 지정 오버로드로 단순 변경하면 부분 집합 해시가 되어 amended CLOSED 계약을 깨뜨린다. **대안 A(단순 범위 교체)는 Task #16 월별/계층적 revision 계약 선행이 필수다.**

단, 화면 금액 DTO와 revision 검증을 분리하여 OPEN에서는 선택 연도 원장만 읽고, `LIVE_AMENDED`만 기존 전체 revision 경로를 유지하는 단계적 안은 Task #16 없이 가능하다. 이 경우 amended CLOSED의 최악 540 읽기는 남는다.

## Q5. 540건은 정확히 언제 읽히는가

분기는 다음과 같다.

- `OPEN`: `currentLedgerView=true`, 무범위 원장 읽기, live cashflow와 opening balance 생성 (`WeeklyExpenseController.java:462-490`).
- amendment가 있고 amendment snapshot hash가 현재 snapshot hash와 같은 `CLOSED`: `currentLedgerView=true`, 무범위 원장 읽기 후 전체 revision 안정성 재검증 (`WeeklyExpenseController.java:464-479,494-509`).
- 일반 `CLOSED` 또는 `REOPEN_REQUESTED`: `source=null`; 동결 snapshot/opening balance와 별도 범위 projection-actual summary를 사용 (`WeeklyExpenseController.java:471-490,516-529`).

따라서 일반 확정월은 이미 540건을 읽지 않는다. 540건 문제는 **OPEN 월과 LIVE_AMENDED 월**에 한정된다. OPEN 월에서 전 기간이 필요한 이유는 화면이 전 기간 월을 그려서가 아니라 (a) 전체 사업기간 Projection 계약대비 합계를 원장 월들로 다시 만들고, (b) weeklyYears로 연간 fallback 중복을 막고, (c) 현재 DTO가 항상 전역 revision을 함께 만들기 때문이다 (`server/bff/routes/jvm-weekly-api.mjs:1233-1292`; `WeeklyExpensePersistence.java:783-824`; `FirestoreInheritedWeeklyExpensePersistence.java:2601-2606`). 세 요구 모두 화면의 선택 월 주차 원본 540개와 동일한 것은 아니다.

## Q6. 실제 부하 조건

- 9년은 단순 허구가 아니다. 공통 계약 문서는 실제 `cashflow_sheet_year_totals`에 2024~2032 범위가 존재한다고 명시한다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-00-shared-contract.md:64-67`).
- 그 범위에서 모델상 최대는 `9년 × 12월 × 5주 = 540 cashflow_weeks`, `108 monthly_closes`다 (`spec-00-shared-contract.md:64-68`).
- 그러나 이 worktree에는 Firestore export 또는 프로젝트별 count 결과가 없다. 따라서 **프로젝트당 실제 평균/최대 `cashflow_weeks` 문서 수는 미확인**이다. 540은 실제 연도 범위에 기반한 완전 충전(worst-case) 산출이지, 저장된 `cashflow_weeks` 540개를 count한 증거는 아니다.

## 기존 측정치의 현재 유효성

| 지표 | 판정 | 근거 |
|---|---|---|
| 콜드 14.58s / 웜 4.15s / 270KB | 과거 baseline으로 유효, 현재값은 미확인 | 유일한 스테이지 기록은 2026-07-27 측정이다 (`docs/architecture/2026-07-27-jvm-bff-channel-audit.md:68-74`). 이후 동일 조건 측정 artifact가 없다. |
| 540문서 | worst-case 모델로 유효 | 실제 2024~2032 연도 범위와 5주 모델 (`spec-00-shared-contract.md:64-67`). 실제 프로젝트 count는 미확인. |
| `67586182` 이후 270KB 감소 | 입증 안 됨 | 커밋은 `monthly_closes`의 6개 필드 select이고 HTTP DTO 변경이 아니다 (`[67586182] ...FirestoreInheritedWeeklyExpensePersistence.java:89-92,3480-3500`). 최종 응답 크기 감소 여부는 재측정해야 한다. 이 worktree에는 해당 커밋도 포함되지 않는다. |

## 대안 3개와 정량 예측

예측 기준은 540문서, 콜드 14.58s, 웜 4.15s, 270KB baseline이다 (`spec-00-shared-contract.md:64-67`; `2026-07-27-jvm-bff-channel-audit.md:68-74`). p95는 baseline에 `대상 cashflow_weeks / 540`을 곱한 순수 읽기 비례치로, 검증 전 목표값이다.

| 대안 | `cashflow_weeks` 읽기 | 최종 응답 크기 예측 | 예상 p95(콜드/웜) | Task #16 | 위험 |
|---|---:|---:|---:|---|---|
| A. 무범위 호출을 선택 연도 범위 오버로드로 단순 교체 | 최대 60 (12×5) | 약 270KB를 상한으로 보되 현재 연간 열 데이터가 사라져 **기능 불충족** | 약 1.62s / 0.46s의 순수 읽기비례 모델; 고정비 포함 실측 필요 | **필수** | 부분 revision을 만들고 선택 연도 밖 연간 열도 잃는다. 현 상태에서 권장하지 않음. |
| B. 화면 DTO와 revision 분리: OPEN은 선택 연도 60주 + `cashflow_sheet_year_totals` 최대 8건, LIVE_AMENDED는 기존 전체 revision 유지 | OPEN 최대 60주 + 8 연간 집계; LIVE_AMENDED 최대 540; 일반 CLOSED 0 | **≤270KB 목표**; 선택 연도 밖 주차 상세를 연간 행으로 대체, 정확한 KB는 fixture 측정 | OPEN 약 1.62s / 0.46s 순수 읽기비례 모델 + 집계 8건; amended는 14.58s / 4.15s baseline 유지 | **OPEN 최적화는 불필요**, amended 최적화는 필요 | 프론트 연간 열 계약과 서버 DTO를 함께 바꿔야 함. 가장 작은 안전한 완결안. |
| C. 집계 중심 전용 dashboard 계약: B에 더해 cumulative head 1, bounded month status, JVM 원시 projection/actual 제거 | 최대 60 (+ 집계문서 최대 9개, 월 상태 문서는 별도) | **B 이하 목표**, JVM→BFF 원시 line 중복도 제거; 정확한 KB는 fixture 직렬화 측정 필요 | 약 1.62s / 0.46s 순수 읽기비례 모델, 집계 9건 고정비 추가 | global revision을 응답 계약에서 제거하면 OPEN 불필요; amended는 별도 계약 필요 | DTO/검증 계약 변경 면적이 가장 큼. |

응답 크기는 현재 270KB 구성별 측정 artifact가 없어 임의 비율을 제시하지 않았다. B/C는 전 기간 `canonical.months`의 주차 상세를 연간 합계로 바꾸므로 `≤270KB`를 acceptance target으로 두되, 정확한 수치는 540주 실제 fixture로 `JSON.stringify` 바이트와 JVM proxy body 바이트를 각각 기록해야 한다.

## SPEC-04 영향

일반 CLOSED 월은 이미 동결 snapshot을 사용하므로 OPEN 읽기 최적화가 저장된 `late`, `closeDeadline`, `snapshotHash`, `amendmentCount`를 바꿀 이유가 없다 (`WeeklyExpenseController.java:471-490`; `/private/tmp/myscube-spec-docs/docs/architecture/spec-04-temporal-immutability.md:70-82,95-102`). 변경 acceptance는 이 값들의 바이트 동일성을 요구해야 한다 (`spec-04-temporal-immutability.md:95-102`).

위험 지점은 `LIVE_AMENDED`의 `resultingTargetRevision` 검증이다. 부분 revision으로 바꾸면 과거 amendment 증거의 의미가 달라지므로 Task #16 없이 수정하면 안 된다 (`WeeklyExpenseController.java:494-507`). snapshot/hash를 재작성하거나 과거 CLOSED 판정값을 backfill하는 안은 SPEC-04 위반 후보라 권장하지 않는다.

## Freeze Unit 제안

1. **19-A — 관측 baseline(문서/테스트만):** 540주 실제 fixture로 현재 OPEN, CLOSED, LIVE_AMENDED의 Firestore read count, JVM body bytes, BFF body bytes, cold/warm p95를 고정한다. pass: 기존 화면 값과 SPEC-04 필드 hash 기록. 코드 경로 근거는 BFF trace 구간 (`server/bff/routes/jvm-weekly-api.mjs:2522-2543,2596-2625`).
2. **19-B — OPEN bounded read + 연간 DTO:** 선택 연도 60주 + 기존 annual totals로 전환하고 React의 이전/이후 연간 열을 그 DTO로 읽는다. pass: OPEN `cashflow_weeks ≤60`, 일반 CLOSED `0`, UI의 선택 연도/이월/모든 연간 열/전체 Projection/summary 동일. `LIVE_AMENDED`는 기존 540 경로 유지.
3. **19-C — 전용 DTO/중복 제거:** JVM 원시 `projection`/`actual`을 dashboard 응답에서 제거하고 필요한 readModel/aggregate만 전달한다. pass: JVM→BFF byte 감소, 최종 BFF 응답 비증가, React 소비 필드 전부 동일.
4. **Task #16 별도 Freeze Unit:** 월별 또는 계층 revision 도입, 기존 global revision/저장된 amendment 호환 검증 후에만 LIVE_AMENDED를 60주 이하로 좁힌다.

각 Unit은 독립 커밋/롤백 가능해야 하며 19-B가 통과하기 전 19-C로 넘어가지 않는다.

## 되돌릴 수 없는 변경 후보

- 저장된 `targetRevisionAtFetch`, `appliedTargetRevision`, amendment `resultingTargetRevision`의 의미를 global에서 월별로 바꾸거나 backfill하는 것.
- 기존 `monthly_closes.snapshot`, `snapshotHash`, CLOSED 판정값을 새 집계 구조로 재작성하는 것.
- `cashflow_sheet_year_totals`를 새로운 authoritative source로 선언하면서 과거 주간 원장과의 우선순위를 영구 변경하는 것.

이 셋은 단순 읽기 최적화에 포함하지 말고 별도 migration/호환 계약과 복구 사본을 전제로 해야 한다. SPEC-04는 CLOSED snapshot hash와 amendment 기록 보존을 요구한다 (`spec-04-temporal-immutability.md:70-82,95-102`).

## 권장안

**대안 B를 1차 권장한다.** OPEN 월은 화면에 필요한 선택 연도 최대 60주만 읽고, 전년도는 이미 존재하는 `cashflow_sheet_year_totals`, 전체 누적 비교는 이미 범위 지정된 `projectionActualSummary`를 재사용한다 (`WeeklyExpensePersistence.java:783-824`; `WeeklyExpenseCommandService.java:274-285`). 일반 CLOSED는 현행 0주를 유지하고, LIVE_AMENDED만 Task #16 전까지 540주 global revision 검증을 유지한다.

대안 A는 가장 짧은 diff지만 revision 의미를 깨므로 거부한다. 대안 C는 최종 형태로 유망하지만 현재 270KB 구성별 측정이 없고 계약 변경 면적이 크므로 19-B 실측 뒤에만 진행한다. 최종적으로 LIVE_AMENDED까지 60주 이하로 만들려면 Task #16이 선행되어야 한다.
