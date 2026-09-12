# SPEC-08 — 3-스트림 실행 설계 (revision v2 · 대시보드 읽기 · 포털 단일화)

**작성:** 2026-08-07 · **작성자:** 메인 세션 (워커 위임 전 직접 설계)
**선행:** spec-01(계층), spec-04(불변성), spec-05(트랜잭션 경계), spec-06(목표 아키텍처), spec-16 설계조사, spec-19 조사, 포털 조사(2026-08-07)

---

## 0. 대원칙 → 구체 장치 매핑

| 대원칙 | 이 설계에서의 구체 장치 |
|---|---|
| 도메인/애플리케이션 영향 분리 | 신규 판정은 전부 도메인 순수 클래스. 검증된 패턴 4건(`CashflowApplyLease`, `CashflowQueryScope`, `CashflowMonthReopenApprovalPolicy`, `ApproverDeadlineCalculator`)과 동일 형태 |
| 설명 가능한 가이드 | 신규 에러 코드는 `api-error-messages.ts` 맵에 등록. 기술 용어 금지, "무엇이 일어났고 무엇을 하면 되는지" 한 문장 |
| 작업 중단 0 | 읽기 경로에서 throw 금지. 비교 불능·데이터 결손은 상태값 + 안내 문장으로 강등 |
| 단방향 의존 | 도메인은 JDK/도메인만 import. api→storage 신규 edge 금지 (기존 3건은 7-1에서 청산) |
| 공통 인터페이스·API 일치 | digest 계산은 JVM 도메인 **단 1곳** (BFF 재구현 금지, opaque token 취급). 연간 합계 산출은 서버 1곳. 포털 전환은 `switchProjectInPlace` 단일 진입점 유지 |

---

## Stream 1 — SPEC-16: revision 계약 v2 (Parallel Change)

### 문제
`targetRevision` = 프로젝트 **전체** 주차 문서의 해시. `LIVE_AMENDED` 검증이 이 전역 해시에 묶여 있어 읽기 범위를 좁힐 수 없다 (SPEC-19 Q4).

### 설계 — 승인된 대안 C

봉투(envelope) 값 객체:

```
{ contractVersion: 2, scope: "MONTH:2026-08", digest: "sha256:..." }
```

**도메인 (신규, 순수):**
- `CashflowRevision` — 파싱/포맷/동등성. **다른 scope 간 비교는 `INDETERMINATE`** — mismatch가 아니다.
- `CashflowMonthDigest` — 월 한정 문서 정규화 해시. `computeCashflowTargetRevision`의 정규화 로직을 재사용하되 입력을 월 문서 집합으로 제한.

**마이그레이션 — Expand → Migrate → Contract:**

| 단계 | 내용 | 배포 특성 |
|---|---|---|
| E1 (expand) | amendment 저장 시 v1 전역 + v2 월별 **dual-write**. 검증은 v1 그대로 | 행동 불변. 단독 배포·revert (F-1/F-2) |
| E2 (migrate) | 검증이 **저장된 envelope의 버전을 따름** (Tolerant Reader). v2면 월 digest 비교 → LIVE_AMENDED 읽기 좁힘 해금 | 과거 v1 기록은 v1으로 계속 검증 |
| E3 (contract) | 신규 amendment에서 v1 기록 중단 | 과거 기록 재작성 절대 금지 (SPEC-04) |

**중단 0:** `INDETERMINATE` → 읽기 응답에 상태 + 안내: "이 확정월은 이전 방식으로 봉인되어 있어요. 조회는 정상이며, 다음 확정 시 새 방식으로 전환됩니다." 쓰기 경로 보호는 유지.

**패턴:** Parallel Change, Value Object, Tolerant Reader, SSOT(digest는 JVM 도메인 단일 구현).

**성공 조건:** ① v1/v2/INDETERMINATE 각 분기 계약 테스트 ② E1 배포 후 저장 문서에 두 필드 공존 확인 ③ 과거 amendment 문서 바이트 변화 0 ④ 사보타주: digest 입력에서 문서 1건 제외 시 검증 실패.

---

## Stream 2 — 19-B: OPEN 월 bounded read (15초의 본체)

### 문제
OPEN·LIVE_AMENDED 월에서 `cashflow_weeks` 전건(최대 540) 읽기. 화면은 선택 연도 60주만 주차 해상도로 그린다 (SPEC-19 Q2). 사용자 관측 15초의 지배 항.

### 설계 — 읽기는 BFF, 판정은 JVM (사용자 지시로 개정)

**전제 사실:** BFF와 JVM은 **같은 Firestore를 각자 읽는다** (2026-07-27 감사). 대시보드 조립도 이미 BFF에서 한다(`jvm-weekly-api.mjs:1831-2069`). 현재 구조는 "JVM이 전건을 읽어 270KB를 만들고, BFF가 그걸 받아 다시 조립"이라 **홉과 콜드스타트만 얹고 있다.**

**소유권 분할 — "JVM이 볼 필요 있나?"에 대한 답:**

| 작업 | 담당 | 근거 |
|---|---|---|
| 대시보드 읽기 모델 조립 (OPEN 월 주차·연간 행·타일) | **BFF 직접 읽기** | 저장된 데이터의 필터·합산·정렬뿐. 판정 없음. 인덱스 이미 선언됨(projectId+yearMonth+weekNo) |
| 월 상태·준수·기한 **판정** | **JVM만** | 도메인 규칙. 판정 결과는 **저장값**이고 BFF는 저장값을 그대로 읽는다 — 재유도 금지 |
| 결산·반영·amendment **쓰기** | **JVM만** | 트랜잭션 경계 (SPEC-05). 상태 기계 JVM 단일화(과제 #15)와 정합 |
| LIVE_AMENDED revision 검증 | **JVM만** | 전역 digest 판정. Stream 1 E2 전까지 기존 경로 |

**이중 계약 재발 방지 장치 (필수):** BFF의 읽기는 ①id/연월 필터 ②정책 JSON 기반 합산 ③저장된 판정 필드 **원문 전달**만 허용. 상태 유도·기한 계산·준수 판정 코드가 BFF에 생기면 안 된다 — **소스 스캔 테스트로 고정** (판정 함수명·규칙 상수의 BFF 유입 0건). 이게 없으면 이 개정은 이중 계약을 되살리는 지름길이 된다.

**확정값 전달의 경계 (2026-08-08 사용자 논의로 확정):** "BFF가 읽고 JVM은 판정/연산"은 판정의 **구속력**에 따라 갈린다.
- **자문 판정** (반영 전 검증, 화면 안내): BFF가 넘긴 값으로 JVM 순수 함수 판단 허용 — 저장 없음, 무해.
- **구속 판정** (결산 확정, 반영, amendment): JVM이 **자기 트랜잭션 안에서 월 범위로 재확인** 후에만 쓴다. BFF가 넘긴 값은 참고이지 근거가 아니다. 이를 어기면 TOCTOU 경합과 "BFF 주장 vs 저장값" 형태의 이중 계약이 부활한다.
- **JVM 내부 읽기의 축소**: 쓰기 경로의 판정 입력 읽기도 전건 스캔이 아니라 월 범위(SPEC-12 패턴 확장). 콜드 시에도 부팅+최소 작업만 지불한다. min-instances 는 이 구조 완성 후 재평가 — 현재 보류.

**도메인 (신규, 순수):** `CashflowDashboardReadPlan` (BFF 측 순수 모듈) — 입력(월 상태, 선택 연도, amendment 유무) → 읽기 집합:
- OPEN: `{선택연도 주차 ≤60, 연간집계 연도들, monthly_closes 6필드}` — **JVM 호출 0**
- 일반 CLOSED: `{동결 snapshot}` (현행 유지)
- LIVE_AMENDED: JVM 경유 legacy 플랜 — Stream 1 E2 전까지

**순차 로딩 (화면):** 대시보드를 단계 응답으로 분리 —
1. **1차: 상태·기한·요약 타일** (monthly_closes 6필드 + publication — 소량, 즉시 렌더)
2. **2차: 선택 연도 주차 보드** (≤60건)
3. **3차: 연간 열** (year_totals ≤9건)

각 구간 스켈레톤 표시. 1차가 먼저 그려지므로 **체감 대기는 1차 응답 시간**으로 내려간다. 반영(apply) 직후에는 apply-status 진행 상태를 같은 자리에 표시.

**JVM 측 정리:** Controller의 `readCashflowSource` 직접 호출(api→storage 3건 중 1건)은 OPEN 경로가 BFF로 이관되면 호출부가 줄어든다. 잔여 호출은 `WeeklyExpenseDashboardQueryService` 신설로 이관 — CommandService public 메서드로 만들면 트랜잭션 Aspect가 자동으로 감싸므로(SPEC-05 함정) 별도 읽기 서비스가 맞다. → **7-1을 같은 흐름에서 해소.**

**DTO:** 선택 연도 주차 상세 + 비선택 연도는 `cashflow_sheet_year_totals` 연간 행. `coverage: {selectedYear, annualYears[]}`로 FE가 구분.

**경계 주의 (워커 필수 확인 2건):**
1. dashboard 응답의 `targetRevision`이 sheet apply의 `targetRevisionAtFetch`로 쓰이는지 추적. 쓰인다면 apply 경로는 기존 전역 revision 유지 — dashboard DTO만 분리한다.
2. 15초 분해: apply 실행시간 + apply-status **폴링 주기** + 대시보드 재조회. 폴링 주기가 지배 항이면 별도 보고 (읽기 좁힘만으로 15초가 다 안 빠질 수 있다).

**패턴:** CQRS-lite(Query/Command 서비스 분리), Read Model, Specification(ReadPlan), Facade(DTO 조립).

**성공 조건:** ① 읽기 수 단위 테스트 — 가짜 persistence로 OPEN ≤80건·CLOSED 0건 단언 ② 화면 값 동일성: 선택 연도/이월/전체 연간 열/summary 필드 동일 ③ SPEC-04 필드(late, closeDeadline, snapshotHash, amendmentCount) 바이트 동일 ④ 사보타주: ReadPlan이 연간 연도 하나를 빠뜨리면 테스트 실패.

---

## Stream 3 — 포털 프로젝트 접속 단일화 (URL as SSOT)

### 문제 (2026-08-07 조사 확정)
선택 상태 저장소 3개(React state / sessionStorage / URL 2개 라우트). 폴백 backfill이 **사용자가 안 고른 값**을 sessionStorage에 영속화 → AXR(p1773817948751) 쏠림. URL→store 역동기화 0건. 전환 시 이전 프로젝트 데이터 미초기화.

### 설계 — 사용자 지시 반영: "세션 재현 금지, 단일 접속으로 단일화"

| 단위 | 내용 | 의존 |
|---|---|---|
| U0 | **PortalProvider 렌더 테스트 1건 선행** — 전환 시 이전 프로젝트 행 미노출 + 로딩 표시 단언. 현행 31건은 문자열 매칭이라 회귀를 못 잡는다(실행 확인됨) | 없음 — 최우선 |
| U1 | sessionStorage 부활 제거 + silent backfill 제거. 선택이 스코프에 없으면 primary/첫번째로 쏠리지 말고 **선택 페이지로** | U0 |
| U2 | URL→store 단방향 동기화. `:projectId` 라우트에서 **param이 이긴다.** store는 전환 핸들러를 통해서만 URL 변경 (루프 차단) | U1 |
| U3 | 전환 시 스코프 상태 초기화(`portal-store.tsx:1257` 직전) + 로딩 가시화(`portalBootstrapped` 래치를 프로젝트 변경 시 리셋) | U0 |
| U4 | 가드 차단 시 설명 가이드: "저장이 끝나면 프로젝트를 전환할 수 있어요" (무음 `false` 반환 제거) | 독립 |
| U5 | cmdk 검색 전환 드롭다운 (조직원 콤보박스 패턴). `switchProjectInPlace` 시그니처 불변 조건. PR #180/#333 정리 후 | U1~U3 뒤 |

sessionStorage를 걷어내므로 조사가 경고한 "되채움 루프"의 전제가 사라진다 — U2의 위험 등급이 조사 시점보다 내려간다.

**패턴:** SSOT(URL-as-state), Unidirectional Data Flow, Derived State(selector), Result-with-reason(무음 실패 제거).

**성공 조건:** ① 렌더 테스트에서 P1→P2 전환 시 P1 행 미노출 ② `/portal/cashflow/{id}` 직접 진입이 항상 해당 프로젝트 표시 (딥링크 정확도 100%) ③ 뒤로가기 후 URL과 화면 일치 ④ sessionStorage 키 잔존 0건 (소스 스캔).

---

## Stream 4 — 고정 양식 기반 읽기 최적화 (자료구조·해싱·캐시)

**전제:** 시트는 전사 고정 양식이다 — 라인 카탈로그(policy JSON) × 연간 열 × 주차 그리드(12개월×5주=60칸). 고정이라는 사실이 자료구조를 결정한다. **구현 완료: PR #482** (`server/bff/cashflow-template-index.mjs`, freeze 단위·배선 없음).

| 장치 | 구조 | 실측/효과 |
|---|---|---|
| 셀 좌표 | `Float64Array(16×60)` + `line*60+week` 산술 | 50k 조회 **2.0배** (find 체인 대비) |
| 연월 검증 | 인터닝 — 유한집합(주별 연도당 12개 문자열) | 정규식 문자열당 1회 |
| 셀 상태 | 2비트 팩킹, 960셀=240B | 문자열 맵 대비 ~100배 |
| 달력 | 프로세스 수명 메모 (SPEC-21 결정적) | 재계산 0 |
| 폴링 | revision 키 LRU + single-flight | **35배** (1,000회 요청 실측) |
| 재방문 | revision 기반 ETag → 304 | 동일 revision 본문 전송 0 |

**정직성:** 단건 조회 2.0배는 작다 — 12×5 배열 `find`는 원래 싸다. 지배 항은 **폴링마다 파이프라인 전체를 재구축하는 것**이며 캐시 적중 경로가 35배다. 서버리스 인메모리 캐시는 인스턴스 한정(웜만 유효)이므로 내구 수단은 ETag/304와 읽기 수 자체의 감소다.

**SSOT 경계 (필수):** 캐시 키는 저장된 revision **식별자**로만 만든다. 내용 해시 재계산 금지 — 판정 SSOT는 JVM이다.

### 이 설계가 구조적으로 차단하는 실사고 (2026-08-07, p1773651024850 라이브 확정)

| 증상 | 확정 원인 |
|---|---|
| 연 단위 관리 연도(2025)에 주차 경고 (`2025-12 4주차 매출입금…`) | 낙오 주차 문서 5건 실존 (`p1773651024850-2025-12-w4`: `SALES_IN 7,582,243`). `canonicalCashflowWeeks`가 readModel의 모든 월을 주차로 펼치고 주별/연간 구분을 **문서 존재로 유추** — 낙오 1건이 연도를 "주별 관리"로 둔갑시킴 |
| 2025 Actual 미표시 | 연간 집계 문서의 2025가 시트(317,449,417)가 아니라 낙오 주차 값(7,582,243)과 일치 — 집계가 시트 연간 열이 아닌 주차 문서에서 파생된 정황. 2025가 주별 연도로 분류되며 연간 fallback에서도 제외 |
| 2024 Actual 미표시 | 연간 집계 2024가 전부 EMPTY/ZERO (시트 2024 열도 0 — 표시 정합 확인 필요) |

**해독제 = 주별/연간 경계의 템플릿 상수화.** `weekOrdinal('2025-12', 4) === -1` — 낙오 문서는 행렬에 진입 불가 (테스트 고정). 유추 제거는 과제 #13(정책 단일소스화)에 편입.

**미해결 (후속):** ①연간 집계에 시트 연간 열이 안 실리는 쓰기 경로 추적 ②낙오 문서 5건+α 데이터 정리 — 되돌릴 수 없으므로 사본 확보 + 승인 후 별도 진행.

### 배선 순서
19-B 완료 후 같은 파일에서: 검사 4종의 인덱스 소비 → route ETag/304 → 단계 응답 캐시. (충돌 방지를 위해 의도적으로 분리)

---

## 성능 지표 — 예측치와 SaaS 허용범위

**정직성 원칙:** 아래 "예측"은 2026-07-27 스테이지 실측(콜드 14.58s / 웜 4.15s / 270KB)에 읽기 비례 모델을 적용한 **용량계획 예측**이지 실측이 아니다. 스테이지는 폐기(#401)되어 재측정 경로가 없으므로 판정은 ①읽기 수 단위 테스트(결정적) ②라이브 스팟체크(체감, 실제 프로젝트) 두 개로 한다.

| 지표 | 현재 | 예측 (이 구조) | 목표 | SaaS 허용범위 | 판정 방법 |
|---|---|---|---|---|---|
| Firestore 읽기 (OPEN 월) | 540+ | **≤80** | ≤80 | — (비용 직결) | **단위 테스트 게이트** |
| Firestore 읽기 (일반 CLOSED) | 0 | 0 | 0 유지 | — | 단위 테스트 게이트 |
| month-close 웜 p95 | 4.15s (7/27) + 사용자 관측 15s E2E | 0.6~1.2s | ≤1.5s | 좋음 ≤1s / 허용 ≤2s | 라이브 스팟체크 |
| month-close 콜드 | 14.58s | 2.5~4.5s | ≤4s | 서버리스 콜드 ≤5s | 라이브 스팟체크 |
| **시트 반영→화면 노출 E2E** | **15s (사용자 관측)** | 분해 후 산정 | **≤5s** | 인터랙티브 갱신 ≤5s | 라이브 스팟체크 + 폴링 주기 보고 |
| 응답 크기 | 270KB | 연간 행 대체로 감소 | ≤150KB | ≤200KB | PR에서 fixture 직렬화 기록. **게이트: 비증가** |
| 읽기 경로 409/5xx | 0 (해결됨) | 0 | 0 | 0 | 기존 계약 테스트 |
| 포털 stale-data 창 | 무한 (재현 A) | 0 | **0** | 0 | **렌더 테스트 게이트** |
| 딥링크 정확도 | 불일치 가능 | 100% | 100% | 100% | 렌더 테스트 |
| Firestore 읽기 비용 (해당 엔드포인트) | 기준 | **약 −85%** | — | — | 읽기 수에서 도출 (CTO 보고용) |
| JVM 호출 수 (OPEN 월 읽기) | 1 (경유 + 콜드스타트 노출) | **0** | 0 | — | 계약 테스트 |
| 1차 화면 응답 (상태·요약 타일) | 전체 응답과 동일 (일괄) | 0.3~0.6s | ≤0.8s | 첫 유의미 렌더 ≤1s | 라이브 스팟체크 |

---

## 실행 순서와 충돌 관리

```
병렬: Stream 1 (E1부터)   Stream 2 (ReadPlan+QueryService)   Stream 3 (U0→U1→U3→U2→U4)
충돌: Stream 1·2는 JVM 같은 영역 — 1은 amendment 검증/저장부, 2는 읽기 신설부.
      먼저 CLEAN 되는 쪽 먼저 머지, 나머지 rebase (오늘 #479 방식).
      Stream 3은 FE 전용, 완전 독립.
후속: Stream 1 E2 + Stream 2 완료 → LIVE_AMENDED 좁힘 (19-B 후속, 별도 freeze unit)
      U5 검색 드롭다운은 #180/#333 정리 후
```

## 금지 (3 스트림 공통)

- 과거 amendment/snapshot/판정값 재작성·backfill (SPEC-04)
- BFF에서 digest·연간합계 재구현 (SSOT 위반)
- `WeeklyExpensePersistence` Port 분할 (SPEC-05)
- 읽기 경로 신규 throw
- 테스트만 통과시키는 우회 — 사보타주 검증 필수 (G-1~G-9)
