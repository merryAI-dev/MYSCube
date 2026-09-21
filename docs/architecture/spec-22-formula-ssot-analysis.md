# SPEC-22 — 수식/이월잔액 검증 SSOT 분석

**조사 기준:** `0e82d9337b2450a1aa646e789f55c73f289458fb` (2026-08-07)  
**범위:** 읽기·실행 조사만 수행했으며 운영 Firestore는 조회하지 않았다. 코드 변경은 이 문서뿐이다.

## 요약 결론

현재 JVM `CashflowFormulaValidator`가 저장 직전에도 다시 계산되는 재무 불변식의 판정자다. BFF에는 같은 라인별 덧셈·입금−출금 산술이 있으나, `cashflow-annual-total.mjs`는 이미 저장된 연간 문서의 읽기 모델 요약이고 `cashflow-comparison.mjs`는 화면용 projection−actual 비교이며, `cashflow-sheet-template.mjs`는 외부 시트 형식 어댑터다. 따라서 세 모듈 전체를 “JVM과 동일한 그림자 validator”라고 부르면 범위를 과장한다 (`server/bff/cashflow-annual-total.mjs:14-44`, `server/bff/cashflow-comparison.mjs:82-172`, `server/bff/cashflow-sheet-template.mjs:293-333`, `server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/domain/CashflowFormulaValidator.java:63-127`).

다만 금액 계약은 실제로 갈린다. 동일한 `SALES_IN=9007199254740992` 입력에서 BFF 요약은 안전 정수가 아니라는 이유로 0으로 만들었고 JVM은 정확히 9007199254740992를 계산했다. 소수 `0.1`은 BFF가 0으로 누락하고 JVM은 whole-won 위반 오류를 냈다. 이는 반올림 오차가 아니라 **허용 범위·실패 의미의 불일치**이며, 조용히 0으로 바꾸는 BFF 경로가 더 위험하다 (`server/bff/cashflow-annual-total.mjs:4-7,19-25`; JVM `CashflowFormulaValidator.java:228-256`).

**조건부 권장안:** 지금은 통합 구현을 시작하지 말고 계약 대조 테스트와 책임 경계만 Freeze한다. SPEC-13/19/21의 완료 결과와 SPEC-16 revision 포함 범위가 확정된 뒤, JVM 순수 도메인 validator를 유일한 쓰기 불변식으로 유지하고 BFF에서는 validator성 산술을 제거하되 화면 전용 비교는 명시적 read-model projection으로 남기는 안을 권장한다. 이 판단은 SPEC-19/21/16 결과에 따라 일부 뒤집힐 수 있다.

## Q1. 무엇이 실제로 중복인가

| 기능 | BFF | JVM | 입력·출력·경계 비교 | 판정 |
|---|---|---|---|---|
| 연간 합계 | `summarizeCashflowAnnualMode`: 저장 문서의 state/value를 라인별로 모아 입금·출금·net을 만든다 (`cashflow-annual-total.mjs:14-44`). 실제 수집 시점의 합계·주간/연간 화해는 `summarizeAnnualMode`/`buildAnnualCashflowTotals`가 수행한다 (`cashflow-sheet-snapshot.mjs:182-260`). | `validateAnnualPeriods`: 모든 행의 완전성·중복·whole-won을 강제하고, 이월잔액+입금−출금 및 시트 보고값 일치 여부를 반환한다 (`CashflowFormulaValidator.java:63-127`). | 둘 다 라인 합계와 입금−출금을 계산하지만 BFF는 읽기/화해 모델이고 JVM은 완전성 및 보고 수식 검증까지 수행한다. BFF `annual-total`은 비정상 금액을 0으로 만들고 JVM은 거부한다. | **산술은 중복, 계약은 다름.** JVM이 불변식 SSOT다. |
| 월 합계·주차 검증 | `cashflow-comparison`은 주차별 projection/actual 라인을 더하고 차이를 만든다 (`cashflow-comparison.mjs:20-64,82-158`). | `validateMonth`는 2 mode×5주×전체 라인을 요구하고 주차별 opening→입금−출금→closing을 연쇄 계산하며 reported 값을 검증한다 (`CashflowFormulaValidator.java:130-210`). | BFF 출력은 비교표이며 opening carry와 reported 수식 검증이 없다. JVM 출력은 저장 게이트용 검증 결과다. | **덧셈은 중복, 기능은 동일하지 않음.** |
| 이월잔액 | BFF 비교/연간 요약에는 월말→익월초 이월 계산이 없다. 화면은 JVM opening balance를 요구한다 (`server/bff/routes/jvm-weekly-api.mjs:1862-1867`). | 과거 연도 라인에 OUT 부호를 적용해 opening을 계산하고 (`CashflowFormulaValidator.java:28-60`), 연간 balance를 다음 연도로 (`:109-122`), 주간 balance를 다음 주로 이월한다 (`:175-206`). | BFF에 독립 이월 validator는 확인되지 않았다. | **중복 아님. JVM 단독 규칙.** |
| 시트 템플릿 파싱 | 고정 행/열, 라벨, 주차/연도 헤더를 파싱해 mapping과 오류 사유를 만든다 (`cashflow-sheet-template.mjs:3-33,97-111,124-290,293-333`). | 해당 기능 없음. | 외부 Google Sheet 형식에 대한 adapter다. | **중복 아님.** |
| projection−actual 차이 | 라인/주/월 단위로 `projection - actual`을 계산하고 as-of 주차로 자른다 (`cashflow-comparison.mjs:48-64,66-80,82-172`). | 대응 public 메서드 없음 (`CashflowFormulaValidator.java:21-210`). | 화면 read model 파생값이다. | **중복 아님.** |

JVM public 계산 표면은 오버로드를 별개 시그니처로 세면 4개다: `validateMonth(cells,reported)` (`:21-26`), `calculateOpeningBalances` (`:28-61`), `validateAnnualPeriods` (`:63-128`), `validateMonth(cells,reported,opening)` (`:130-211`).

## Q2. 실제 실행 대조

### 실행 방법

- BFF: Node에서 `summarizeCashflowAnnualMode`를 직접 import해 `projection.SALES_IN` 한 행에 각 값을 넣어 실행했다.
- JVM: `CashflowLineCatalog.java`와 `CashflowFormulaValidator.java`를 임시 디렉터리에 `javac`으로 컴파일하고 JShell에서 2024년 projection/actual 전체 16행을 구성해 `validateAnnualPeriods`를 실행했다.
- 양쪽 모두 나머지 행은 `EMPTY`, opening은 0으로 고정했다. 이 실행은 운영 데이터나 Firestore를 사용하지 않았다.

| 입력 유형 | 동일 입력 (`SALES_IN`) | BFF 실행 결과 (`totalIn/net`) | JVM 실행 결과 (`depositTotal/balance`) | 동일? |
|---|---:|---:|---:|---|
| 정상 | `VALUE 100` | `100 / 100` | `100 / 100` | 예 |
| 0 | `ZERO 0` | `0 / 0` | `0 / 0` | 예 |
| 음수 | `VALUE -100` | `-100 / -100` | `-100 / -100` | 예 |
| 소수점 | `VALUE 0.1` | `0 / 0` (행 누락) | 오류: `must be a whole-won value` | **아니오** |
| 큰 값 | `VALUE 9007199254740992` | `0 / 0` (행 누락) | `9007199254740992 / 9007199254740992` | **아니오** |
| 빈 셀 | `EMPTY null` | `0 / 0` | `0 / 0` | 예 |

근거가 되는 경계는 BFF의 `Number.isSafeInteger` 필터 (`cashflow-annual-total.mjs:4-7,19-25`)와 JVM의 `BigDecimal.longValueExact()` whole-won 검사 (`CashflowFormulaValidator.java:244-251`)다. `9007199254740992`는 Java `long` 범위에는 있지만 JS safe integer 범위 밖이라 갈렸다. 소수점은 둘 다 계산에 반올림하여 포함하지 않았지만 BFF는 조용히 0으로 축약하고 JVM은 명시적으로 거부했다. 따라서 **이번 입력 범위에서 BigDecimal 대 number의 “반올림 값 차이”는 없었고, 실제 차이는 오류/범위 계약이었다.** BFF 비교 모듈은 `Number.isFinite`만 검사하여 소수를 그대로 합산한다 (`cashflow-comparison.mjs:15-18,31,38-45`); 따라서 그 read model까지 범위에 포함하면 JVM whole-won 계약과도 다르다.

이월 시점 대조는 동일 기능의 BFF 구현이 없어 양쪽 실행 대조 자체가 성립하지 않는다. JVM에서만 annual `balances.put(mode,balance)` 및 weekly `priorBalance=balance`가 실제 이월을 수행한다 (`CashflowFormulaValidator.java:109-122,175-206`). 이 사실을 “같다”로 추정하지 않고 **BFF 대응 구현 없음**으로 기록한다.

## Q3. BFF 결과의 최종 사용처와 저장 여부

| BFF 결과 | 최종 사용 | 저장 | JVM 대조 안전장치 |
|---|---|---|---|
| `summarizeCashflowAnnualMode` | `cashflow_sheet_year_totals` 문서를 읽어 연간 ledger view에 반환 (`cashflow-sheet-lab.mjs:177-190,204-229`) | 함수 자체는 읽기 전용. 그러나 원재료인 annual totals는 canonical annual 문서와 snapshot year 문서로 저장된다 (`cashflow-sheet-lab.mjs:1410-1424,1968-2035`). | 반영 전 JVM annual/weekly preflight 호출 (`cashflow-sheet-lab.mjs:3119-3125`) 및 저장 명령 내부 재계산이 있다 (`WeeklyExpenseCommandService.java:1726-1744,1883-1929`). |
| `buildAnnualCashflowTotals` | mirror `sheetFacts.annualCashflowTotals`, reconciliation warning 생성 (`cashflow-sheet-lab.mjs:752-766,768-791`) | **예.** mirror에 포함되고 snapshot year에도 projection/actual로 복제된다 (`cashflow-sheet-lab.mjs:1410-1424`). | JVM은 시트 derived totals와 자체 계산을 대조하며 mismatch 미수락 시 409 (`WeeklyExpenseCommandService.java:1922-1929,2033-2066`). |
| `buildCashflowProjectionActualComparison` | JVM cashflow 응답에 화면용 comparison을 붙인다 (`jvm-weekly-api.mjs:4340-4379`); 월 결산 dashboard에도 사용한다 (`jvm-weekly-api.mjs:1845-1876`). | 이 모듈 결과를 직접 Firestore에 저장하는 호출은 전수 검색에서 확인되지 않았다. | JVM과 동일 결과를 대조하는 코드는 확인되지 않았다. 다만 입력이 JVM read model인 경로가 있다 (`jvm-weekly-api.mjs:4358-4367`). |
| `analyzeCashflowSheetTemplate` | 시트 행/열 mapping과 오류 사유를 만들어 sheet-lab 수집을 조정 (`cashflow-sheet-template.mjs:293-333`; import `cashflow-sheet-lab.mjs:11`). | mapping에서 읽은 cells/derived cells가 mirror와 stage snapshot으로 저장된다 (`cashflow-sheet-lab.mjs:734-790,1693-1705`). parser 반환 객체 자체의 저장 여부는 미확인. | 금액은 JVM preflight/apply에서 다시 검증하지만 레이아웃 자체의 JVM 대조는 없다. |

### SPEC-04 영향

저장되는 BFF 파생값(`annualCashflowTotals`, snapshot year projection/actual, stage `calculationChecks`)은 이후 CLOSED 월 snapshot/evidence에 포획될 수 있다. SPEC-04는 CLOSED 문서의 소급 재계산과 저장 판정값의 실시간 재계산 대체를 금지한다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-04-temporal-immutability.md:95-112,174-180`). 따라서 SSOT 통합 시 과거 저장값을 새 계산으로 덮어쓰면 안 된다. 새 계산 계약은 새 revision/정책 버전에만 적용하고 기존 snapshot은 그대로 읽어야 한다.

## Q4. 계층 배치

| 조각 | 현재 위치 | SPEC-06 목표 계층 | 지금 이동 가능성 |
|---|---|---|---|
| 수식/whole-won/부호/이월 규칙 | JVM `domain/CashflowFormulaValidator`; 일부 JS 산술은 BFF 평면 모듈 | 도메인. SPEC-06이 수식·이월 검증을 명시한다 (`spec-06-target-architecture.md:45-55`). | JVM은 이미 맞는 위치. JS validator성 규칙 제거는 선행 스펙 확정 뒤 가능. |
| 시트 형식 파싱 | `cashflow-sheet-template.mjs`, `cashflow-sheet-snapshot.mjs` | 애플리케이션 서비스의 외부 I/O adapter. 도메인 아님 (`spec-06-target-architecture.md:35-42`). | mapping 계약을 유지한 순수 추출은 가능하나 지금은 SPEC-13/21과 파일 충돌 위험. |
| projection−actual 비교 | `cashflow-comparison.mjs` | 화면용 범위 선택/조정은 애플리케이션 서비스, 순수 difference 산술은 read-model projection helper | SPEC-19가 입력 범위와 API 경계를 정한 뒤 결정. **뒤집힐 수 있음.** |
| 오류 표현 | BFF parser의 한국어 `message` | 도메인/adapter는 구조화 사유, 서비스가 문구 번역 (`spec-06-target-architecture.md:103-108`) | 본 조사 범위 밖. |

`cashflow-sheet-template.mjs` 자체는 형식 parsing/mapping만 하며 재무 합계를 계산하지 않는다. 그러나 `cashflow-sheet-snapshot.mjs` 한 파일에는 셀 문자열 parsing/classification (`:28-145`)과 whole-won 합계·net·화해 규칙 (`:182-260`)이 함께 있다. 즉 **외부 형식 adapter와 도메인성 산술은 현재 한 파일에 섞여 있다.** 이것이 최소 추출 후보이나, SPEC-13 policy/line catalog 결과가 확정되기 전에는 새 JS 도메인 계층을 만들지 않는다.

## Q5. 트랜잭션 경계

JVM 수식 검증은 두 의미로 호출된다.

1. `validateCashflowSheetFormulas` preflight는 `WeeklyExpenseCommandService`의 public 메서드다 (`WeeklyExpenseCommandService.java:1871-1936`). Aspect가 그 클래스의 모든 public 메서드를 `persistence.runCommandTransaction`으로 감싸므로 기술적으로 transaction 안에서 실행된다 (`WeeklyExpenseCommandTransactionAspect.java:17-27`; SPEC-05 확인 `spec-05-transaction-boundary.md:16-30`). 그러나 이 메서드는 검증 응답만 반환하고 쓰기를 하지 않아 의미는 **사전 점검**이다.
2. 실제 단월/배치 apply도 같은 public service transaction 안에서 입력 cells와 reported checks를 다시 계산하고 mismatch를 확인한 다음 persistence replacement·audit·idempotency를 수행한다 (`WeeklyExpenseCommandService.java:1559-1574,1726-1767,1828-1867`). mismatch 미수락 시 예외를 던진다 (`:2057-2066`), Aspect가 RuntimeException을 다시 던지므로 (`WeeklyExpenseCommandTransactionAspect.java:19-25`) 뒤의 저장은 커밋되지 않는다. 이것이 **원자적 쓰기 불변식**이다.

BFF 계산은 Node 순수 함수 및 Firestore/HTTP orchestration에서 수행되어 JVM `runCommandTransaction` 밖이다. BFF가 먼저 JVM preflight를 호출하는 지점 (`cashflow-sheet-lab.mjs:3119-3125`)은 사전 점검일 뿐이고, 안전성은 JVM apply 내부 재검증이 제공한다. 따라서 BFF 계산을 JVM 검증과 같은 강도의 불변식으로 보아서는 안 된다. SPEC-05의 권고대로 persistence를 쪼개지 않고 순수 판정자 호출을 transaction 안에 유지해야 한다 (`spec-05-transaction-boundary.md:138-151`).

## Q6. 선행 스펙 완료 후 예상 상태

| 시점/선행 | 현재 상태 | 완료 후 예상 | 이 조사 판단에 미치는 영향 |
|---|---|---|---|
| 현재 (`0e82d933`) | BFF policy JSON 소비가 시작됐고, JVM은 Java `CashflowLineCatalog`를 쓴다 (`cashflow-sheet-template.mjs:1-7`; `CashflowLineCatalog.java:7-31`). | 해당 없음 | 라인/상수와 계산 엔진 중복을 한 번에 정리하면 진행 중 변경과 충돌한다. 지금은 구현 보류. |
| SPEC-13 완료 | 라인 카탈로그가 JS policy와 Java 상수로 이중 표현된다. | BFF/JVM이 동일 policy 값을 소비할 것으로 기대되지만 정확한 로딩/생성 방식은 **SPEC-13 결과에 따라 달라짐**. | 상수 차이는 줄지만 JS number 대 BigDecimal, 실패 계약, 이월 알고리즘 중복은 남는다. SSOT는 “같은 상수”만으로 달성되지 않는다. |
| SPEC-19 완료 | comparison은 JVM 전체 read model과 월 결산 dashboard의 canonical 범위를 입력으로 받는다 (`jvm-weekly-api.mjs:1845-1876,4340-4379`). | query range/응답 크기/소유 계층이 바뀔 수 있다 (`spec-06-target-architecture.md:187-191,202-212`). | comparison을 유지·이동·서버 계산할지 **SPEC-19 결과에 따라 뒤집힘**. |
| SPEC-21 완료 | comparison as-of는 `resolveFinanceWeekForDate`와 Asia/Seoul을 사용한다 (`cashflow-comparison.mjs:2,7-13,66-80`); template은 `YY-M-W` 라벨만 파싱한다 (`cashflow-sheet-template.mjs:97-111`). | 월 경계 주차 귀속/주차수가 바뀔 수 있다. 정확한 영향은 **SPEC-21 결과에 따라 달라짐**. | 주간 aggregation과 이월 시점 fixture를 SPEC-21 확정 계약으로 다시 생성해야 한다. 기존 CLOSED snapshot은 재계산 금지. |
| SPEC-16 완료 | BFF sourceRevision은 sources/cells/annual/derived/total cells의 hash다 (`cashflow-sheet-lab.mjs:721-735`). 계산 결과 일부가 별도 stage/checkpoint에도 저장된다. | formula 결과·policy version이 revision에 포함되는지는 **SPEC-16 결과에 따라 달라짐**. | 포함되면 SSOT 전환은 revision 계약 변경이므로 dual-read/새 버전이 필요할 수 있다. 포함되지 않으면 계산 계약 버전을 별도로 저장해야 한다. **뒤집힐 수 있음.** |

## 통합 대안

### 대안 A — JVM validator 단일 쓰기 SSOT + BFF read-model projection 유지 (권장)

- JVM `CashflowFormulaValidator`를 유일한 저장 불변식으로 유지하고 apply transaction 안 재검증을 보존한다.
- BFF `comparison`은 사용자 화면 전용 projection으로 명시하되 whole-won 입력 계약을 JVM과 맞춘다. 저장 판단에 사용하지 않는다.
- `cashflow-sheet-snapshot`의 adapter parsing과 산술을 분리하고, BFF에 남는 annual 요약은 JVM 검증된 canonical 결과를 표시하는 최소 projection으로 축소한다.
- 전제: SPEC-13 policy 소비 방식, SPEC-19 comparison 입력 범위, SPEC-21 week 계약, SPEC-16 revision 범위 확정.
- 위험: JVM HTTP 의존으로 preflight latency/부분 실패가 생길 수 있다. 다만 실제 apply는 이미 JVM 소유이며 BFF 사전 점검 실패가 저장 원자성을 대체해서는 안 된다.

### 대안 B — 정책에서 언어별 validator 생성 + cross-language contract suite

- policy schema에서 line/state/whole-won 규칙을 정의하고 Java/JS 구현을 생성하거나 동일 fixture로 검증한다.
- 전제: SPEC-13이 계산 계약까지 policy schema로 소유한다고 결정해야 한다.
- 위험: 두 런타임 구현은 계속 존재해 number/BigDecimal 차이를 제거하지 못하며 generator·schema라는 새 추상화가 생긴다. 현재 사용처 수와 문제 규모에 비해 과하고, 생성물이 divergence를 숨길 수 있어 비권장이다.

### 대안 C — BFF validator를 유일 SSOT로 이동

- JVM이 BFF 계산 결과를 신뢰하거나 HTTP로 호출한다.
- 위험: 도메인이 상위/I/O에 의존하여 SPEC-06 단방향 규칙을 위반하고 (`spec-06-target-architecture.md:118-133`), transaction 내 불변식이 외부 호출 실패에 종속된다. BigDecimal whole-won 검증도 약화된다. **권장하지 않는다.**

## 선행 조건과 뒤집힐 수 있는 판단

### 착수 선행 조건

1. **SPEC-13:** line catalog, 160-cell/주차수 policy의 최종 소비 API와 버전 확정.
2. **SPEC-19:** comparison이 읽을 canonical 범위와 소유 계층 확정.
3. **SPEC-21:** Asia/Seoul 기준 주차 경계·월 귀속·이월 fixture 확정.
4. **SPEC-16:** source/target revision에 formula 결과와 policy version을 포함하는지 확정.
5. **SPEC-04 준수 계획:** CLOSED snapshot 무수정, 새 계약의 적용 시점과 version 기록.

### 뒤집힐 수 있는 판단

- `cashflow-comparison.mjs`를 BFF에 남긴다 → **SPEC-19 결과에 따라 달라짐**.
- 주차 합계를 JVM validator에 추가한다 → **SPEC-21이 주차를 계산 입력으로 정의하는 방식에 따라 달라짐**.
- 기존 sourceRevision을 그대로 유지한다 → **SPEC-16 결과에 따라 달라짐**.
- policy JSON에서 Java 코드를 생성한다 → **SPEC-13 결과에 따라 달라짐**; 현재는 비권장.
- annual read model을 재계산해 저장한다 → SPEC-04 때문에 기존 CLOSED 데이터에는 **항상 금지**, 새 revision에서의 적용 방식만 SPEC-16에 따라 달라짐.

## 구현 시 Freeze Unit

| Unit | 동결 범위 | 독립 통과 기준 | 선행 |
|---|---|---|---|
| F1 계약 fixture | 정상/0/음수/소수/JS-safe 경계/Java-long 경계/EMPTY/누락/중복, IN/OUT 부호 | 현재 두 구현의 차이를 golden 결과로 고정; 조용한 0 축약을 명시적으로 실패시키는 목표 계약 승인 | SPEC-13 |
| F2 주차·이월 fixture | 5주 연쇄, 12월→1월, 윤년/월경계 | SPEC-21 확정 시간대에서 JVM 결과와 기대값 일치; CLOSED fixture 바이트 동일 | SPEC-21, SPEC-04 |
| F3 JVM 쓰기 게이트 | preflight와 single/batch apply 재검증 | mismatch 미수락 시 저장/audit/idempotency 모두 롤백; 수락 정책은 기존과 동일 | SPEC-05 |
| F4 BFF adapter 분리 | sheet layout parsing/classification만 | 실제 시트 fixture mapping이 전후 동일; 산술 import 없음 | SPEC-13, SPEC-21 |
| F5 read-model projection | annual display/comparison | JVM canonical 입력에서 화면 결과 동일, 비정상 금액은 조용히 0이 되지 않음 | SPEC-19 |
| F6 revision/불변성 | source/target revision, policy/formula version | 기존 CLOSED hash·필드 무변경; 새 문서에만 승인된 contract version 적용 | SPEC-16, SPEC-04 |
| F7 구 경로 제거 | 중복 validator 호출부 | 전수 검색 0, 동일 E2E apply/browser 결과, 옛 경로 병행 없음 | F1~F6 |

## 되돌릴 수 없는 변경 후보

- 기존 CLOSED month/snapshot/year total을 새 산식으로 backfill 또는 덮어쓰기.
- 계산 결과나 policy version을 기존 revision hash에 소급 포함해 기존 hash를 바꾸기.
- 기존 `EMPTY`/invalid가 0으로 저장된 문서를 “정정”하는 데이터 마이그레이션.
- 주차 타임존 변경으로 과거 월/주차 귀속 및 opening balance를 재작성하기.
- JVM apply 내부 재검증을 제거한 뒤 BFF preflight만 신뢰하기(원자성 공백).

위 항목은 SPEC-04가 요구하는 “되돌릴 수 없는 변경이 있으면 구현 중단” 대상이다 (`spec-04-temporal-immutability.md:157-170`).

## 최종 권장과 근거

**지금:** 코드 통합 금지. F1 대조 계약과 F2 시간 경계 입력만 합의하고, 진행 중 스펙 결과를 기다린다. 현재 바로 JS helper를 새로 만들면 SPEC-13/19/21이 같은 경계를 다시 바꿔 또 다른 이중 계약이 된다.

**SPEC-13/19/21/16 완료 후:** 대안 A로 간다. JVM pure domain validator와 apply-transaction 재검증을 유지하고, BFF의 시트 adapter와 화면 projection만 남긴다. 이유는 (1) JVM이 실제 저장 명령 안에서 재검증한다, (2) 실행 대조에서 JS number 계약이 이미 두 입력에서 갈렸다, (3) SPEC-05는 transaction을 쪼개지 말고 순수 판정만 추출하라고 요구하며 (`spec-05-transaction-boundary.md:138-151`), (4) SPEC-06은 수식·이월 검증을 도메인 책임으로 둔다 (`spec-06-target-architecture.md:45-55`).

대안 B는 두 계산 엔진을 유지하고 생성 계층까지 추가하므로 divergence 면적을 줄이지 못한다. 대안 C는 JVM transaction 불변식을 BFF/I/O에 종속시켜 아키텍처와 원자성을 동시에 약화하므로 제외한다.

## 미확인 사항

- SPEC-13/19/21/16의 최종 산출물은 본 조사 시점에 완료되지 않았으므로 예상 상태는 위 표 이상으로 단정하지 않았다.
- 운영 Firestore의 기존 비정상/큰 값 분포와 CLOSED 문서 영향 건수는 금지 조건에 따라 조회하지 않아 미확인이다.
- `cashflow-comparison` 결과를 별도 비동기 경로가 저장하는지는 저장소 내 직접 호출 전수 검색에서는 발견되지 않았지만, 저장소 밖 소비자는 미확인이다.
