# SPEC-12 — Postgres 접근 패턴 청산 (읽기 증폭 제거)

**작성:** 2026-08-07 · **대상:** codex 독립 세션 · **선행:** `spec-00-shared-contract.md` 필독
**베이스:** `origin/main` (`6b4e160f`) · **브랜치:** `perf/cashflow-query-scope`
**배포 단위:** JVM (Cloud Run) — BFF·프론트 무관

> 이 작업의 이름은 "성능 개선"이 아니라 **"Postgres 접근 패턴 청산"**이다. 같은 형태가 다른 쿼리에 남아 있는지 함께 보기 위해서다.

---

## 1. 문제 (측정된 사실)

`server/jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/storage/FirestoreInheritedWeeklyExpensePersistence.java`가 Firestore를 SQL처럼 쓴다:

```java
query(cashflowWeeks(tenantId).whereEqualTo("projectId", projectId))
```

`yearMonth` 필터도 `limit`도 `select`도 없다. SQL이라면 DB가 인덱스로 걸러 주므로 자연스럽지만, Firestore에서는 **문서를 전부 읽어 메모리에 올린다.**

`.limit(` 사용 횟수: **파일 전체에 2회.** (약 4,700줄에서)

### 실측 (2026-07-27 스테이지, 감사 문서 기록)

| 지표 | 값 |
|---|---|
| `GET /api/v1/cashflow/{id}/month-close` 콜드 | **14.58초** |
| 웜 | **4.15초** |
| 응답 크기 | **270KB** |

### 이전 성능 작업이 실패한 이유

`7247ce2` "stabilize cashflow dashboard loading"은 BFF→JVM **HTTP 홉 하나를 없앴을 뿐 Firestore 쿼리를 하나도 건드리지 않았다.** 지배적 비용은 홉이 아니었다. 같은 커밋이 `findings` 배열을 추가해 응답은 오히려 커졌다.

**이 스펙에서 홉 수를 줄이는 변경은 금지한다.** 원인은 읽기 증폭이다.

### 인프라는 이미 준비되어 있다

`firebase/firestore.indexes.json`에 선언된 복합 인덱스:

```
cashflow_weeks  : [projectId, yearMonth, weekNo]
cashflow_weeks  : [projectId, yearMonth, __name__]
cashflow_weeks  : [yearMonth, projectId, weekNo]
monthly_closes  : [projectId, yearMonth]
```

**쿼리가 `yearMonth`를 쓰지 않으므로 이 인덱스는 사용되지 않는다.** 인덱스 추가 배포는 이 작업에 필요 없다.

## 2. 정량 목표 (SPEC-00 E절 규격)

### 최악 조건
계약 9년(2024–2032) 프로젝트. `cashflow_weeks` **540문서**, `monthly_closes` **108문서**.

### 축별 목표

| 축 | 현재 (최악) | 목표 | 회귀 예산 (초과 시 실패) |
|---|---|---|---|
| **참조 횟수** — 단일 월 조회가 읽는 `cashflow_weeks` | **540** | **5** (해당 월 5주) | ≤ 10 |
| **참조 횟수** — `monthly_closes` 문서당 로드 바이트 | 전체 `snapshot` 포함 | 필요 필드만 | 문서 수 108 유지, 필드는 6개 이하 |
| **응답시간** p95 웜 | 4.15초 | **≤ 1.0초** | ≤ 2.0초 |
| **응답시간** p95 콜드 | 14.58초 | **≤ 4.0초** | ≤ 6.0초 |
| **트래픽** 응답 크기 | 270KB | **≤ 80KB** | ≤ 120KB |
| **계층 왕복** BFF→JVM | 2 (dashboard + compliance) | **2 (변경 없음)** | 2 |

**참조 횟수 108× 감소가 이 작업의 본질이다.** 응답시간·트래픽은 그 결과다.

### 검증 방법
- 참조 횟수: **테스트로 상한 단언** (SPEC-00 F절). 로그가 아니라 테스트가 회귀를 막는다
- 응답시간: `cashflow.performance` 로그의 `operation=cashflow.month_close.read`, `phase=jvm_dashboard`의 `durationMs` p50/p95
- 트래픽: 응답 `content-length`

## 3. 범위

### 대상 — 무필터 스캔 지점

`cashflow_weeks` (`cashflowWeeks(tenantId).whereEqualTo("projectId", projectId)`):

| 줄 | 메서드 | 조치 |
|---|---|---|
| 1555 | `completeCashflowWeeklyUpdate` | `yearMonth` 필터 |
| 2047 | `countCashflowActualReplacementWrites` | `yearMonth` 필터 (대상 월 집합) |
| 2231 | `replaceCashflowSheetMonthsInternal` | 대상 월 집합으로 제한 |
| 2533 | `findCashflowLedgerSource` | **판단 필요** — 아래 4-2 |
| 4065 | `replaceActualLines` | `yearMonth` 필터 |
| 4482 | `findWeeklyStatuses` | **판단 필요** |
| 4567 | `readProjectionLines` | **판단 필요** |
| 4583 | `readActualLines` | **판단 필요** |

`monthly_closes`:

| 줄 | 메서드 | 조치 |
|---|---|---|
| 3477 | `readProjectMonthCloses` | **필드 선택**(`select`) — 필터 아님. 4-3 참조 |
| 3491 | `readProjectMonthClosesForRead` | **필드 선택** |

`cashflow_year_totals`:

| 줄 | 메서드 | 조치 |
|---|---|---|
| 2510 | `findCashflowSheetYearTotals` | 연도 범위 제한 검토 |

### 제외
- BFF·프론트엔드 코드
- 인덱스 파일 (`firestore.indexes.json`) — 필요한 인덱스는 이미 있다. **새 인덱스가 필요하다고 판단되면 코드를 고치지 말고 그 사실을 보고한다**
- 저장 스키마 변경
- 홉 수 감소 / 응답 통합 (명시적 금지)

## 4. 요구사항

### 4-1. 호출자가 범위를 넘긴다

무필터 스캔의 근본 원인은 **메서드가 "이 프로젝트 전체"만 받을 수 있다는 것**이다. 시그니처에 범위를 추가한다.

원칙 (SPEC-00 D절 최소권한):
- 한 달을 처리하는 메서드는 그 달만 읽는다
- 여러 달이면 `Collection<String> yearMonths`를 받아 `whereIn`을 쓴다
- **Firestore `whereIn`은 최대 30개다.** 30을 넘으면 청크로 나눠 질의한다. 이 상한은 상수로 선언하고 테스트로 고정한다

### 4-2. "전체가 필요하다"가 진짜인지 검증한다

`findCashflowLedgerSource`, `findWeeklyStatuses`, `readProjectionLines`, `readActualLines`는 호출부에 따라 전체가 필요할 수 있다.

**추측으로 필터를 넣지 말 것.** 각 메서드에 대해:
1. 호출부를 전부 찾는다
2. 실제로 전체 범위를 쓰는 호출부가 하나라도 있으면 → 오버로드를 추가하고 **범위를 아는 호출부만** 좁은 쪽을 쓴다
3. 전부 특정 범위만 쓴다면 → 시그니처를 바꾸고 전체 스캔 버전을 **삭제한다** (SPEC-00 H절: 병행 유지 금지)

판단 결과를 PR 본문에 메서드별로 적는다.

### 4-3. `monthly_closes`는 필터가 아니라 필드 선택

대시보드는 선택된 한 달이 아니라 **모든 달을 그린다.** 따라서 108문서를 읽는 것 자체는 정당하다. 문제는 각 문서가 `snapshot`(160셀 전체)을 통째로 들고 있는데 **정수 2개를 얻으려고 전부 읽는다**는 것이다.

Firestore `select()`로 필요한 필드만 가져온다. 필요 필드를 코드에서 상수로 선언하고, 그 목록을 테스트로 고정한다.

`select()` 사용 시 주의: 반환 문서에 없는 필드를 읽으면 조용히 `null`이 된다. **필드 목록과 실제 사용처가 어긋나면 값이 조용히 사라진다.** 이 조합을 반드시 테스트한다 (5-2의 7번).

### 4-4. 구조 (SPEC-00 D절)

이 작업으로 추가되는 쿼리 범위 계산 로직은 `FirestoreInheritedWeeklyExpensePersistence.java`에 넣지 않는다. 이미 4,700줄이다.

신규: `storage/CashflowQueryScope.java` (또는 동등한 이름)
- 순수 클래스. Firestore 핸들을 받지 않는다
- 책임: 계약기간·요청 범위 → 질의할 `yearMonth` 집합, `whereIn` 청크 분할
- 단위 테스트를 별도 파일로 붙인다

## 5. 성공 조건

### 5-1. 참조 횟수 상한 (핵심)

기존 테스트 하네스가 쿼리를 기록한다. 이를 이용해 **문서 읽기 수를 숫자로 단언**한다.

1. 최악 조건(9년 540문서) 픽스처에서 단일 월 `month-close` 조회 → 읽은 `cashflow_weeks` 문서 **≤ 10**
2. 같은 픽스처, 필터 적용 전 동작을 재현하면 540 → **개선 전후를 같은 테스트에서 대비**
3. `monthly_closes` 조회가 `select`한 필드 목록이 선언된 상수와 정확히 일치
4. 3개월 배치 반영 → 읽은 `cashflow_weeks` ≤ 15 (3 × 5)

### 5-2. 정확성 (필터가 값을 잃지 않는다)

5. 필터 적용 전후 결과가 **동일**하다 — 최악 조건 픽스처로 전체 응답을 비교
6. 월 경계: 12월 요청이 다음 해 1월 문서를 끌어오지 않는다 / 1월 요청이 전년 12월을 끌어오지 않는다
7. **`select` 필드 목록에서 하나를 빼면 테스트가 실패한다** — 필드와 사용처가 어긋나면 조용히 `null`이 되는 것을 잡는 테스트
8. `yearMonth`가 없는 레거시 문서가 섞여 있어도 누락·예외 없이 처리된다 (`readProjectMonthClosesForRead`가 문서 ID에서 복원하는 기존 동작 유지)

### 5-3. `whereIn` 경계 (SPEC-00 G절 1·6)

9. 대상 월 **29개** → 단일 질의
10. 대상 월 **30개** → 단일 질의 (경계값)
11. 대상 월 **31개** → 2개 질의로 분할, 결과는 합쳐서 31개월 전부 포함
12. 대상 월 **108개**(9년 전체) → 4개 질의, 중복·누락 0
13. 대상 월 **0개** → 질의 0회, 빈 결과 (Firestore `whereIn`에 빈 배열을 넘기면 예외다. 반드시 막는다)

### 5-4. 오염·비정상 입력 (SPEC-00 G절 2·3·4·5)

14. `yearMonth`가 `null` / `''` / `"2026-13"` / `"26-8"` / `"2026-08-01"` → 예외 메시지가 명확하고, 무필터 전체 스캔으로 **폴백하지 않는다** (조용한 성능 회귀 방지)
15. `projectId`가 `''` → 질의를 보내지 않는다 (Firestore에서 빈 문자열 동등 질의는 전체를 반환하지 않지만, 의도치 않은 질의 자체를 막는다)
16. `yearMonth` 목록에 중복 30개 → 중복 제거 후 1개 질의
17. `yearMonth` 목록에 10만 자 문자열 → 검증 단계에서 거부
18. 계약기간이 역순(종료 < 시작) → 빈 집합, 질의 0회

### 5-5. 회귀 방지 쌍 (SPEC-00 G절 9)

19. **유지 대상 존재 확인**: 대시보드가 여전히 모든 달을 그린다 (`monthly_closes` 108문서가 전부 응답에 반영). 필드 선택이 "달 수 감소"로 번지지 않았는지
20. **제거 대상 부재 확인**: `cashflowWeeks(...).whereEqualTo("projectId", projectId)` 무필터 형태가 소스에 남아 있지 않다 (4-2에서 정당한 것으로 판정된 지점은 예외 목록으로 명시하고, 그 목록도 테스트로 고정)

### 5-6. 게이트

- JVM 테스트 전체 통과 (`mvn test` 또는 프로젝트 표준 명령)
- 기존 MockMvc·Firestore 트랜잭션 테스트 회귀 0
- **`npm test`도 통과** (BFF 계약 테스트가 JVM 응답 형태를 검증한다)

## 6. 완료 정의

- [ ] 5절 20개 단언 전부 통과
- [ ] 참조 횟수 540 → ≤10 을 테스트가 강제
- [ ] 4-2 판단 결과가 메서드별로 PR 본문에 기록
- [ ] 전체 스캔 버전이 남아 있지 않음 (또는 예외 목록에 근거와 함께 명시)
- [ ] 새 인덱스 불필요 확인 (필요하면 코드 대신 보고)
- [ ] 커밋: `perf(cashflow): scope Firestore reads to the requested months`

## 7. 하지 말 것

- 홉 수 감소 / 응답 통합 (이전에 실패한 접근이다)
- 인덱스 파일 수정
- 캐시 계층 도입 (원인이 아니다)
- 추측 기반 필터링 (4-2 절차 필수)
- 성능 수치를 측정 없이 주장하기
