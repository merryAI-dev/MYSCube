# SPEC-13 — 정책 계약 단일소스화 (SSOT)

**작성:** 2026-08-07 · **대상:** codex 독립 세션 · **선행:** `spec-00-shared-contract.md` 필독
**베이스:** `origin/main` (`6b4e160f`) · **브랜치:** `refactor/cashflow-policy-ssot`
**배포 단위:** BFF + 프론트 + JVM (3계층 동시) — **가장 조율이 필요한 스펙**

---

## 1. 문제 — 같은 사실이 3벌 존재한다

### 1-1. 라인 카탈로그 16종

| 계층 | 위치 | 형태 |
|---|---|---|
| 정책 | `src/app/policies/cashflow-policy.json` | `lineEntries` 16개 (lineId·label·direction·aliases) |
| BFF | `server/bff/cashflow-policy.mjs` | 위 JSON에서 파생 ✅ |
| 프론트 | `src/app/platform/cashflow-sheet.ts:4-26` | **하드코딩 배열** (IN 7 + OUT 9) |
| JVM | `.../domain/CashflowLineCatalog.java` | **하드코딩 배열 + 한국어 별칭 맵** |

JVM 별칭 맵에는 오타 변형까지 수기로 들어 있다 (`"MYSC 선입금 - 메입부가세"` — 매입→메입). 시트 헤더가 하나 바뀌면 **JSON·프론트·JVM 세 곳**을 고쳐야 하고, 하나를 빠뜨리면 조용히 매칭이 실패한다.

### 1-2. 160셀 / 주차 5

| 계층 | 형태 |
|---|---|
| JVM | `CashflowSheetLabApplyRequest.FINANCE_WEEK_COUNT = 5`, `EXPECTED_CELL_COUNT = 160` (상수 파생 ✅) |
| BFF | 리터럴 `160`이 `jvm-weekly-api.mjs`에 **8곳 이상 하드코딩** |

`160 = 16라인 × 5주 × 2모드(projection/actual)`. 라인이 하나 추가되면 176이 되는데, BFF는 grep으로 찾아 고쳐야 한다.

### 1-3. 월 결산 기한 (익월 10일) — 3곳

| 위치 | 구현 |
|---|---|
| BFF `jvm-weekly-api.mjs` `cashflowMonthCloseDeadline` | JS. **주석에 "판정 주체는 JVM이며… 같은 규칙이 여기에도 필요하다"고 이중 계약임을 자인** |
| JVM `…Persistence.java:438` | `YearMonth.parse(ym).plusMonths(1).atDay(10)` |
| JVM `…Persistence.java:1111` | `targetMonth.plusMonths(1).atDay(10)` (같은 파일 내 중복) |

### 1-4. 재무주차 달력 — 2개 독립 구현, **타임존이 다르다**

| 계층 | 구현 | 타임존 |
|---|---|---|
| 프론트·BFF | `src/app/platform/cashflow-week-core.mjs` | **UTC** |
| JVM | `…Persistence.java` `financeWeekDeadline` / `weeklyComplianceStatus` | **Asia/Seoul** |

월 경계 주차에서 두 계층이 **다른 주차 판정을 낼 수 있는 구조다.** 현재 사고가 보고되지 않았다고 안전한 것이 아니다.

### 1-5. 계층 역전 8건

`server/bff/*` 가 `src/app/*` 를 import한다 (서버가 프론트 트리에 의존):

```
server/bff/cashflow-canonical-store.mjs   -> src/app/policies/cashflow-policy.json
server/bff/cashflow-canonical-store.mjs   -> src/app/platform/cashflow-week-core.mjs
server/bff/cashflow-comparison.mjs        -> src/app/platform/cashflow-week-core.mjs
server/bff/cashflow-export.mjs            -> src/app/platform/cashflow-week-core.mjs
server/bff/cashflow-policy.mjs            -> src/app/policies/cashflow-policy.json
server/bff/cashflow-sheet-template.mjs    -> src/app/policies/cashflow-policy.json
server/bff/routes/cashflow-sheet-lab.mjs  -> src/app/platform/cashflow-week-core.mjs
server/bff/routes/jvm-weekly-api.mjs      -> src/app/platform/cashflow-week-core.mjs
```

공유 의도는 옳으나 **위치가 잘못됐다.** shared 패키지가 없어서 프론트 트리를 공유물 창고로 쓰고 있다. (import 사이클 전수 검사 결과 캐시플로 영역에 진짜 순환은 없다. 이건 순환이 아니라 방향 문제다.)

## 2. 정량 목표

이 스펙은 응답시간 목표가 없다. **변경 비용과 사고 확률**이 지표다.

| 축 | 현재 | 목표 | 회귀 예산 |
|---|---|---|---|
| 라인 1종 추가 시 **수정 파일 수** | 3 (JSON+프론트+JVM) | **1** (JSON만) | 1 |
| 주차 수 변경 시 수정 지점 | JVM 상수 1 + BFF 리터럴 8+ | **1** (JSON) | 1 |
| 기한 규칙 구현체 수 | 3 | **1** (JVM) | 1 |
| 주차 달력 구현체 수 | 2 (타임존 상이) | **1** | 1 |
| `server/bff → src/app` import | 8 | **0** | 0 |
| **응답시간** | — | **회귀 없음** | p95 +5% 이내 |
| **참조 횟수** | — | **변경 없음** | 동일 |

**성능을 개선하는 작업이 아니다. 성능을 악화시키지 않는 것이 조건이다.**

## 3. 범위와 단계

이 스펙은 3계층을 건드리므로 **3개 PR로 쪼갠다.** 한 PR로 만들지 말 것.

### PR-A: 공유 위치 확립 (BFF+프론트, JVM 무관)
1. `src/app/policies/cashflow-policy.json` → `policies/cashflow-policy.json` 이동 (`policies/`는 이미 존재하며 `rbac-policy.json` 등이 산다)
2. `src/app/platform/cashflow-week-core.mjs` → `shared/cashflow-week-core.mjs` 이동 (또는 `policies/`와 같은 최상위 공유 위치)
3. import 8건 방향 수정 → `server/bff → src/app` **0건**
4. 프론트 `cashflow-sheet.ts`의 하드코딩 배열을 policy JSON 파생으로 교체
5. BFF `jvm-weekly-api.mjs`의 리터럴 `160`을 policy 파생 상수로 교체

### PR-B: JVM이 같은 정책을 소비 (JVM)
6. `CashflowLineCatalog.java`를 policy JSON에서 **생성**하거나 기동 시 로드
   - 권장: 빌드 시 codegen (런타임 파일 의존을 만들지 않는다)
   - JSON은 `policies/cashflow-policy.json` 하나만 참조한다
7. `FINANCE_WEEK_COUNT` / `EXPECTED_CELL_COUNT`를 policy 파생으로

### PR-C: 판정 주체 단일화 (BFF, JVM 응답 의존)
8. 월 결산 기한: JVM이 응답에 `closeDeadline`을 이미 준다(`CashflowMonthCloseResponse`). BFF `cashflowMonthCloseDeadline` **삭제**하고 응답 필드를 쓴다
9. JVM 내 중복(`:438`, `:1111`)을 한 메서드로 합친다
10. 재무주차: 타임존 불일치를 해소한다. **어느 쪽으로 통일할지는 구현 전에 보고하고 승인받는다** (KST가 업무 기준이나, UTC 기반 기존 저장값과의 호환을 먼저 확인해야 한다)

**PR-C의 10번은 데이터 호환성 판단이 필요하다. 임의로 결정하지 말 것.**

## 4. 요구사항 (SPEC-00 C·D절)

- policy JSON이 **유일한 정의처**다. 어느 계층도 라인·별칭·주차수·셀수를 하드코딩하지 않는다
- JVM이 JSON을 손으로 옮겨 적지 않는다. 생성물이거나 로드다
- 이동한 파일의 **옛 위치를 남기지 않는다** (SPEC-00 H절: 병행 유지 금지)
- 새로 만드는 파생 로직은 순수 함수 + 별도 파일 + 단위 테스트

## 5. 성공 조건

### 5-1. SSOT 강제 (핵심 — 이게 없으면 다시 갈라진다)

1. **소스 스캔 테스트**: `src/app/**`, `server/bff/**`에 라인 ID 문자열(`'SALES_IN'` 등 16종)이 policy JSON과 파생 모듈 외의 곳에 **리터럴로 등장하지 않는다**
2. **소스 스캔 테스트**: `server/**`에 리터럴 `160`이 셀 수 의미로 등장하지 않는다
3. **import 방향 테스트**: `server/bff/**`가 `src/app/**`를 import하는 건수 **정확히 0**
4. JVM 카탈로그와 policy JSON의 라인 집합이 **완전 일치** (JVM 테스트에서 JSON을 읽어 대조 — 생성물이 최신인지 검증)
5. JVM 별칭 맵과 policy JSON `aliases`가 완전 일치 (오타 변형 포함)
6. `EXPECTED_CELL_COUNT == lineEntries.length × FINANCE_WEEK_COUNT × 2` 를 양쪽에서 각각 단언

### 5-2. 정책 변경 시뮬레이션 (SSOT가 진짜인지 증명)

7. **테스트용 policy에 17번째 라인을 추가하면**, 프론트·BFF·JVM 파생값이 전부 17개가 되고 셀 수가 170으로 따라간다 — JSON 한 곳만 바꿔서
8. 주차 수를 6으로 바꾸면 셀 수가 192로 따라간다
9. 위 두 시뮬레이션에서 **어느 계층도 수정하지 않는다** (수정이 필요하면 SSOT가 아니다)

### 5-3. 기한·주차 단일화

10. BFF에 기한 계산 구현이 남아 있지 않다 (소스 스캔: `plusMonths`/`atDay(10)` 상당 로직 부재)
11. 기한이 JVM 응답 필드에서 온다 — JVM이 기한을 주지 않는 응답이면 화면은 계산하지 않고 "확인 중"을 표시한다 (임의 추정 금지)
12. 주차 라벨 `26-8-1` 형식이 3계층에서 동일 — 같은 입력에 같은 출력 (교차 검증 테스트)
13. **월 경계 케이스**: 1/1, 12/31, 윤년 2/29, 월 시작이 일요일/월요일인 달 — 3계층 결과 일치

### 5-4. 경계·오염 (SPEC-00 G절)

14. policy JSON이 **없을 때** — 기동 실패로 명확히 알린다. 빈 카탈로그로 조용히 동작하지 않는다
15. policy JSON에 `lineEntries: []` → 기동 실패
16. `lineEntries`에 중복 `lineId` → 기동 실패
17. `direction`이 `IN`/`OUT` 아닌 값 → 기동 실패
18. `aliases`에 빈 문자열·중복·10만 자 → 검증에서 거부
19. `aliases`에 두 라인이 같은 별칭을 주장 → 기동 실패 (매칭 모호성)
20. 프로토타입 오염: `lineId`가 `__proto__` / `constructor` → 카탈로그 조회가 폴백, 오염 없음
21. 별칭 조회에 `Object.create(null)` 또는 `Map` 사용 — `toString`을 별칭으로 조회해도 함수가 반환되지 않는다

> 14~19를 "기동 실패"로 두는 이유: 감사 문서가 기록한 실패 패턴이 **"시작 시점에는 조용하고 첫 요청에서야 드러난다"**는 것이다. 정책 파일은 시작 시 검증한다.

### 5-5. 회귀 방지 쌍 (SPEC-00 G절 9)

22. **유지 존재 확인**: 기존 시트 헤더 별칭 매칭이 전부 동작 (오타 변형 포함 — 실제 시트에서 쓰이는 값이다)
23. **제거 부재 확인**: 옛 파일 경로(`src/app/policies/cashflow-policy.json`, `src/app/platform/cashflow-week-core.mjs`)가 존재하지 않는다
24. `cashflow-week-core.d.mts` 타입 심이 새 위치에서 유효 (프론트 타입 체크 통과)

### 5-6. 게이트

- `npm test`, `npm run build`, JVM 테스트 전부 통과
- **성능 회귀 없음**: `cashflow.performance` p95가 기준선 +5% 이내 (JSON 로드가 요청 경로에 들어가면 실패 — 로드는 기동 시 1회)

## 6. 완료 정의

- [ ] 5절 24개 단언 통과
- [ ] PR 3개로 분리 (A: 공유위치 / B: JVM 소비 / C: 판정 단일화)
- [ ] 5-2 시뮬레이션이 "JSON만 고쳐서" 통과
- [ ] `server/bff → src/app` import 0
- [ ] PR-C 10번(타임존)은 **승인 후** 진행
- [ ] 커밋 예: `refactor(cashflow): move the shared policy out of the app tree`

## 7. 하지 말 것

- 3계층을 한 PR로 묶기
- 옛 위치를 남긴 채 새 위치 추가 (병행 유지)
- 타임존 통일을 임의 결정
- policy JSON을 요청 경로에서 반복 로드 (기동 시 1회)
- 별칭 맵을 "정리"한다며 실제 시트에서 쓰이는 오타 변형 삭제 — **매칭이 깨진다**
