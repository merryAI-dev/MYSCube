# SPEC-21 재무주차 달력 타임존 분석

작성일: 2026-08-07  
기준 커밋: `d67cdbef33174501bc6e446887829c4a4f621bce`  
범위: 코드·테스트 픽스처·로컬 계산만 조사. 운영 Firestore는 조회하지 않았다.

## 결론

현재 코드에서 **같은 날짜(`YYYY-MM-DD`)의 재무주차 라벨은 갈리지 않는다.** Node의 실제 `cashflow-week-core.mjs`와 JVM 공식을 2000-01-01부터 2099-12-31까지 36,525일 실행 대조한 결과 차이는 0건이었다. `Date.UTC`는 여기서 시간대를 가진 업무 시각을 UTC로 바꾸는 용도가 아니라, 날짜 전용 달력 산술을 런타임 로컬 타임존과 무관하게 수행하는 장치다 (`src/app/platform/cashflow-week-core.mjs:23-42`, `:55-71`). JVM도 동일한 `LocalDate`에 대해 같은 월요일 기준 산술을 한다 (`server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java:1477-1482`).

또한 FE/BFF 공유 코어에는 마감이나 `ON_TIME` 판정이 없다. 저장되는 준수 마감과 판정의 생성자는 JVM 한 곳뿐이다 (`…/FirestoreInheritedWeeklyExpensePersistence.java:1681-1683`, `:1745-1767`). 따라서 SPEC-21의 “UTC 마감 구현 대 KST 마감 구현” 및 “목 15:00 UTC ~ 금 00:00 KST의 갈림 창”은 현재 코드에는 존재하지 않는다. 특히 두 시각 표현은 동일한 한 순간이므로 창의 길이는 0초다.

권장안은 **저장 데이터와 JVM KST 준수 판정을 그대로 두고, 날짜 전용 코어를 KST 업무 달력으로 명시하는 문서/명명 보강만 별도 Freeze Unit으로 수행**하는 것이다. 이 경로는 저장 레코드 소급 변경 0건이다. 과거 `deadline` 또는 `complianceStatus`를 재계산·마이그레이션하면 SPEC-04의 확정 후 불변성과 직접 충돌한다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-04-temporal-immutability.md:95-112`, `:131-137`).

## 조사 방법과 실행 증거

눈으로 구현을 비교하는 대신 다음 두 독립 실행을 사용했다.

1. Node는 저장소의 실제 export인 `resolveFinanceWeekForDate`와 `getMonthFinanceWeeks`를 import해 호출했다 (`src/app/platform/cashflow-week-core.mjs:103-139`).
2. JVM은 Java 17 작은 probe에서 운영 메서드와 동일한 `YearMonth`, `LocalDate`, `DayOfWeek`, `ZoneId.of("Asia/Seoul")` 식을 실행했다 (`…/FirestoreInheritedWeeklyExpensePersistence.java:1477-1482`, `:1745-1767`). probe는 저장소 밖 `/tmp`에 두었고 제품 코드는 수정하지 않았다.

실행 결과:

```text
date-only exhaustive comparison, 2000-01-01..2099-12-31
tested: 36525
differences: 0
```

월 시작 요일 7가지의 대표 월도 실제 실행했다. `라벨 차이`는 그 달의 모든 유효 날짜에 대한 Node/JVM 대조 결과이며, `JVM w1 마감`은 실행된 `financeWeekDeadline` 등가식 결과다. JS 코어에는 비교할 마감 함수가 없으므로 해당 칸을 “없음”으로 둔다.

| 월 시작 | 대표 월 | Node 라벨 범위 | JVM 라벨 차이 | JS 마감 | JVM w1 마감 |
|---|---|---|---:|---|---|
| 일 | 2020-03 | `20-3-1` … `20-3-5` | 0일 | 없음 | `2020-03-01T15:00:00Z` |
| 월 | 2020-06 | `20-6-1` … `20-6-5` | 0일 | 없음 | `2020-06-04T15:00:00Z` |
| 화 | 2020-09 | `20-9-1` … `20-9-5` | 0일 | 없음 | `2020-09-03T15:00:00Z` |
| 수 | 2020-01 | `20-1-1` … `20-1-5` | 0일 | 없음 | `2020-01-02T15:00:00Z` |
| 목 | 2020-10 | `20-10-1` … `20-10-5` | 0일 | 없음 | `2020-10-01T15:00:00Z` |
| 금 | 2020-05 | `20-5-1` … `20-5-5` | 0일 | 없음 | `2020-05-03T15:00:00Z` |
| 토 | 2020-02(윤년) | `20-2-1` … `20-2-5` | 0일 | 없음 | `2020-02-02T15:00:00Z` |

월 경계 요구사항(SPEC-04 T-4)도 이 100년 전수에 포함된다. 1/1, 12/31, 윤년 2/29, 월 시작 일/월요일을 포함한 **동일 날짜 입력의 라벨 차이는 모두 0건**이다. 다만 동일 `Instant`를 UTC 날짜와 KST 날짜로 각각 잘라 입력하면 매일 `15:00:00Z`부터 `23:59:59.999…Z`까지 날짜 문자열이 하루 다르다. 그 하루가 월 또는 월요일 주차 경계를 넘을 때 라벨도 달라질 수 있으나, 이는 두 달력 공식의 차이가 아니라 **호출 전 timestamp→date 변환 계약의 차이**다. 실제 저장 경로 대부분은 거래일 문자열의 날짜 부분을 먼저 사용한다 (`src/app/platform/settlement-row-derivation.ts:121-132`, `src/app/platform/settlement-sheet-sync.ts:41-60`, `src/app/data/portal-store.persistence.ts:61-67`). BFF 폴백 하나는 비정형 timestamp를 UTC 날짜로 자른다 (`server/bff/cashflow-canonical-store.mjs:103-125`); 이 경로의 실제 timestamp 입력 빈도는 운영 조회 금지로 미확인이다.

## Q1. 실제로 다른 답을 내는 입력

### 라벨

- 동일한 유효 `YYYY-MM-DD`: 36,525건 중 차이 **0건**.
- 동일 `Instant`에서 서로 다른 날짜 문자열을 만든 경우: `15:00Z ≤ t < 24:00Z`에 UTC 날짜와 KST 날짜가 하루 다르다. 그 날짜들이 서로 다른 월 또는 월요일 기반 월내 주차에 속할 때 라벨이 갈린다. 이것은 코어 대 JVM 공식 차이가 아니라 입력 정규화 차이다.
- 저장 키 위험: 현재 확인된 자동 라벨 생성은 FE/BFF 코어가 담당한다. JVM은 완료 요청의 `yearMonth/weekNo`를 받아 검증·저장할 뿐 완료시각으로 라벨을 다시 만들지 않는다 (`…/FirestoreInheritedWeeklyExpensePersistence.java:1341-1357`, `:1660-1683`).

### 마감과 핵심 가설

업무 규칙은 금요일 00:00 KST이며 UTC 표현은 **목요일 15:00Z**다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-04-temporal-immutability.md:21-35`). JVM은 정확히 그 Instant를 만든다 (`…/FirestoreInheritedWeeklyExpensePersistence.java:1753-1758`). `weeklyComplianceStatus`는 시작과 마감 양 끝을 포함하므로 마감과 정확히 같은 Instant는 `ON_TIME`, 그보다 1ns라도 뒤면 `COMPLETED_LATE`다 (`:1761-1767`).

정확한 실재 경계는 다음과 같다.

```text
t <= 해당 주차 JVM deadline(금 00:00 KST = 목 15:00Z): ON_TIME
t >  해당 주차 JVM deadline: COMPLETED_LATE
```

SPEC-21에 적힌 `목 15:00 UTC ~ 금 00:00 KST`는 동일 Instant이므로 **갈림 창은 [t, t], 길이 0초**이고 두 구현 판정이 갈리는가라는 질문은 적용 불가다. FE/BFF 코어에는 준수 판정이 없기 때문이다. 만약 새 UTC 업무 마감(금 00:00Z = 금 09:00 KST)을 가정해 추가한다면 그때의 가상 갈림 창은 정확히 `(목 15:00Z, 금 00:00Z]`이고, JVM KST는 `COMPLETED_LATE`, 가상 UTC는 `ON_TIME`이다. 이는 현재 동작이 아니라 금지해야 할 신규 계약이다.

## Q2. 각 구현의 실제 소비처

### `cashflow-week-core.mjs`

직접 import는 다음 7개 제품 파일이다.

| 소비처 | 용도 |
|---|---|
| `src/app/platform/cashflow-weeks.ts:1-7,27-48` | FE용 wrapper 및 re-export |
| `src/app/platform/project-editor.ts:63` | 프로젝트 연간 주차 생성 |
| `server/bff/cashflow-canonical-store.mjs:1-6,76-125` | 거래행의 라벨/날짜를 저장 scope로 해석 |
| `server/bff/cashflow-comparison.mjs:2,68-72` | 비교 기준일의 주차 scope |
| `server/bff/cashflow-export.mjs:2,53` | export 주차 목록 |
| `server/bff/routes/cashflow-sheet-lab.mjs:26,1491` | 1..5 주차 검증 |
| `server/bff/routes/jvm-weekly-api.mjs:22,611-618,649-656` | JVM read model에 표시할 `weekStart/weekEnd` 보강 |

wrapper의 주요 FE 간접 소비처는 화면 표시(`src/app/components/cashflow/CashflowProjectSheet.tsx:474-488,1810-1819`), Dashboard 현재 주차(`src/app/components/dashboard/DashboardPage.tsx:172-175`), 정산 라벨 생성·동기화(`src/app/platform/settlement-row-derivation.ts:121-155`, `src/app/platform/settlement-sheet-sync.ts:41-60,85-126`), portal 저장 행 라벨(`src/app/data/portal-store.persistence.ts:61-67`)이다.

**저장 라벨/scope 생성자:** BFF는 코어 결과로 문서 ID `${projectId}-${yearMonth}-w${weekNo}`와 `yearMonth/weekNo/weekStart/weekEnd`를 쓴다 (`server/bff/cashflow-canonical-store.mjs:330-365`, `:446-459`, `:529-559`). `cashflow_weeks`에 `label` 필드를 쓰지는 않는다. 즉 SPEC-21의 “라벨이 문서 ID·필드에 저장”은 정확히는 `yearMonth/weekNo`가 ID와 필드에 저장되고 표시 라벨은 이 값에서 재구성된다는 뜻이다.

### JVM

- `financeWeekScope`: 현재 KST 날짜와 legacy tracking 시작 Instant를 compliance 주차로 만든다 (`…/FirestoreInheritedWeeklyExpensePersistence.java:1403-1420`, `:1477-1487`).
- `financeWeekDeadline`: PENDING/MISSED 이력과 완료 판정 마감을 만든다 (`:1431-1443`, `:1681-1683`, `:1745-1759`).
- `weeklyComplianceStatus`: 완료와 immutable version에 저장될 상태를 만든다 (`:1681-1703`, `:1761-1767`).
- JVM도 전달받은 `yearMonth/weekNo`로 `cashflow_weeks`를 물리적으로 쓸 수 있다 (`:4367-4405`, `:4437-4447`). 그러나 날짜/완료 Instant에서 저장 라벨을 생성하지 않고 요청 scope를 사용한다. 따라서 **독립적인 저장 라벨 생성자는 한쪽(FE/BFF 코어)뿐**이며 라벨 이중 계약은 현재 실재하지 않는다.

## Q3. 저장 데이터 실태

### `cashflow_weeks`

- ID: `${projectId}-${yearMonth}-w${weekNo}` (`server/bff/cashflow-canonical-store.mjs:330-332`, JVM read/write는 `…Persistence.java:4345-4379`).
- 필드: `yearMonth`, `weekNo`, `weekStart`, `weekEnd` 등이 있고 BFF의 canonical patch에는 `label`이 없다 (`server/bff/cashflow-canonical-store.mjs:344-365`). JVM projection patch도 `yearMonth/weekNo`를 쓴다 (`…Persistence.java:4394-4405`).
- 최초 scope는 사용자가 고른 연월/주차 또는 거래일·명시 라벨을 코어로 해석해 만들어진다 (`server/bff/cashflow-canonical-store.mjs:88-125`, `:295-327`). JVM은 그 scope를 독립 재계산하지 않는다.

### `cashflow_weekly_update_completions`와 누적

- JVM이 문서 ID, `completedAt`, `deadline`, `complianceStatus`를 한 트랜잭션 흐름에서 저장한다 (`…Persistence.java:1660-1703`, 경로 `:2803-2808`).
- immutable completion versions에서 최신 revision을 골라 history를 만들며 `ON_TIME`, `MISSED`, `COMPLETED_LATE`를 집계한다 (`:1374-1401`, `:1469-1474`).
- 판정 경계의 실제 기록 존재 여부는 `completedAt`과 `deadline` 필드로 정확히 판별 가능하다. 그러나 운영 Firestore 조회가 금지되어 **실제 건수는 미확인**이다. 테스트에는 KST 마감 직전 `2026-12-24T14:59:00Z`가 `ON_TIME`인 사례가 있다 (`server/jvm-weekly-api/src/test/java/dev/merryai/innerplatform/weekly/storage/FirestoreCashflowLeaseGuardTest.java:2725-2736`).

## Q4. 업무 기준과 현재 화면

업무 SSOT는 금요일 00:00 KST이고 JVM 구현은 일치한다 (`spec-04:21-43`, `…Persistence.java:1745-1767`). `cashflow-week-core.mjs`는 마감 판정자가 아니므로 업무 마감과 어긋나는 구간이 없다. “UTC”라는 구현 수단을 업무 타임존으로 읽은 것이 혼동의 원인이다.

사용자가 보는 주차는 FE 코어의 `week.label/weekStart/weekEnd`이고 JVM 준수 상태는 같은 `yearMonth/weekNo` 키로 합쳐진다 (`src/app/components/cashflow/CashflowProjectSheet.tsx:1810-1819`, `:2101-2104`). 동일 date-only scope에 대해 라벨 차이가 0건이므로 **현재 코드 근거로 이미 어긋난 화면은 확인되지 않았다**. 준수 이력 화면도 JVM이 저장한 `yearMonth/weekNo/deadline/status`를 그대로 표시한다 (`:3209-3219`).

단, BFF의 비정형 timestamp 폴백은 UTC 날짜를 사용한다 (`server/bff/cashflow-canonical-store.mjs:103-125`). 명시 라벨도 없고 거래일이 timezone-bearing timestamp인 행이 실제 존재한다면 KST 날짜와 다른 scope가 저장될 가능성이 있다. 운영 데이터 미조회로 화면 발생 여부는 **미확인**이다.

## Q5. 통일 방향별 영향

| 방향 | 저장 레코드 정량 영향 | 화면/업무 영향 | 판단 |
|---|---:|---|---|
| (a) 전부 KST | 기존 `cashflow_weeks` 0건, completion/status 0건(기존 값 미재계산 조건) | date-only 표시는 0건 변화. BFF timestamp 폴백만 미래 입력부터 KST 정규화 가능 | 권장. 과거 불변 + 미래 입력 계약 명시 |
| (b) 전부 UTC | 라벨 공식만 바꾸면 0건. JVM 마감을 금 00:00Z로 바꾸고 과거를 재계산하면 `(KST deadline, UTC deadline]`에 완료된 completion 및 version이 변경 후보 | 업무 마감보다 9시간 늦어짐. 미준수 누적 소급 변경 | 금지 권고 |
| (c) 현상 유지+문서화 | 0건 | 실제 dual deadline은 없으므로 안전. 다만 timestamp 폴백 오해/경계 입력 위험 유지 | 단기 안전, 입력 계약 보강 필요 |

운영 조회 없이 제시 가능한 (b)의 정확한 추정 범위는 다음 predicate다.

```text
cashflow_weekly_update_completions 및 cashflow_weekly_update_completion_versions 중
deadline < completedAt <= deadline + 9시간
```

최솟값은 0건, 최댓값은 저장된 완료/버전 레코드 전건이며 실제 값은 미확인이다. 시간 균등분포를 가정한 `9/168=5.36%` 같은 수치는 데이터 근거가 없으므로 추정치로 사용하지 않는다. (a)와 (c)는 **과거 문서를 재계산하지 않으면 소급 변경 0건**이다.

월 경계 T-4 결과는 세 방향 모두 동일하다. 날짜 전용 라벨 공식은 KST/UTC 어느 Zone 이름을 붙여도 36,525일 차이 0건이다. 차이는 timestamp를 날짜로 자르는 전처리 또는 신규 UTC 마감에만 생긴다.

## 권장 Freeze Units

각 Unit은 독립 배포·검증·롤백 가능해야 하며, 과거 저장 문서를 쓰지 않는다.

1. **FU-1 계약 고정(문서/테스트):** date-only 재무주차와 `Asia/Seoul` 업무 마감을 명시. 7개 시작 요일, 1/1, 12/31, 2/29 및 36,525일 Node/JVM parity를 runnable test로 고정. 저장 변경 0건.
2. **FU-2 입력 경계:** `cashflow-canonical-store.mjs`의 비정형 timestamp→업무일 변환만 KST로 명시하고 경계 테스트 추가. 명시적 date-only/label 경로는 유지. 과거 저장 변경 0건.
3. **FU-3 미래 판정 계약 버전:** 새 completion에 정책 버전을 기록하되 기존 completion/version은 수정하지 않음. JVM KST 판정 결과가 이전과 바이트 동일함을 검증.
4. **FU-4 선택적 감사 보고:** 승인된 경우에만 운영 read-only 집계로 위 predicate 후보 건수를 산출. 이 조사에서는 수행 금지.

FU-1과 FU-2를 묶지 않는다. 문서/회귀 게이트와 입력 의미 변경은 실패·롤백 단위가 다르다.

## 되돌릴 수 없는 변경 후보

- 기존 `cashflow_weekly_update_completions` 또는 immutable `cashflow_weekly_update_completion_versions`의 `deadline/complianceStatus` 재계산·덮어쓰기.
- 기존 `cashflow_weeks`의 ID, `yearMonth`, `weekNo`, `weekStart`, `weekEnd` 마이그레이션.
- 과거 compliance history의 `MISSED/COMPLETED_LATE/ON_TIME` 재집계 결과를 저장해 기존 감사 근거를 대체하는 작업.
- CLOSED 월 snapshot/hash에 새 주차 판정을 반영하는 작업.

위 작업은 모두 중단·별도 승인 대상이다. SPEC-04는 구 문서를 신 경로가 수정 없이 읽고, 확정 결과를 소급 계산하지 않도록 요구한다 (`spec-04:95-112`, `:131-137`).

## 스펙 이의

### 이의 1 — 두 마감 구현

- 스펙 주장: FE/BFF UTC 마감과 JVM KST 마감이 9시간 차이로 준수 판정을 갈라 놓는다 (`spec-21-week-calendar-timezone.md:10-17,28-33`).
- 실제 관찰: FE/BFF 코어는 날짜 버킷만 계산하며 deadline/compliance 함수가 없다 (`src/app/platform/cashflow-week-core.mjs:1-149`). 저장 판정은 JVM 단독이다 (`…Persistence.java:1681-1703,1745-1767`).
- 위험: 존재하지 않는 dual deadline을 통일하려 JVM의 올바른 KST 판정을 UTC로 옮기면 오히려 신규 9시간 갈림과 과거 소급 위험을 만든다.
- 대안: JVM KST 판정을 유지하고 timestamp→date 입력 계약만 별도 다룬다.

### 이의 2 — 갈림 창 표기

- 스펙 주장: `목 15:00 UTC ~ 금 00:00 KST`가 9시간 창이다 (`spec-21-week-calendar-timezone.md:31-33`).
- 실제 관찰: 두 표현은 같은 Instant다.
- 대안: 가상 UTC 마감과 비교하려면 `(목 15:00Z, 금 00:00Z]`로 써야 한다. 단, 이것은 현재 구현이 아니다.

### 이의 3 — 저장 라벨 필드

- 스펙 주장: `26-8-1` 라벨이 `cashflow_weeks` 문서 ID·필드에 저장된다 (`spec-21-week-calendar-timezone.md:19-22`).
- 실제 관찰: ID와 canonical fields는 `projectId/yearMonth/weekNo`; BFF/JVM write patch에서 `label` 필드는 확인되지 않았다 (`server/bff/cashflow-canonical-store.mjs:330-365`, `…Persistence.java:4394-4405`). 표시 라벨은 파생값이다.
- 대안: 위험 모델을 “저장된 scope(`yearMonth/weekNo`)”와 “파생 표시 라벨”로 구분한다.

## 미확인 사항

- 운영 컬렉션에서 비정형 timezone-bearing 거래일이 BFF UTC 폴백을 탄 실제 건수.
- 운영 completion 중 가상 UTC 변경 후보 predicate에 해당하는 건수.
- 과거 배포 버전 중 현재 코드와 다른 deadline 판정자가 존재했는지 여부. 현재 베이스 커밋과 테스트만 조사했다.

이 세 항목은 운영 Firestore 조회 금지 및 현재 작업 범위 때문에 미확인으로 남긴다.
