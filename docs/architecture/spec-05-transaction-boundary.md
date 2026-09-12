# SPEC-05 — 트랜잭션 경계와 인터페이스 분할 한계

**작성:** 2026-08-07 · **위상:** SPEC-01의 **제약 조건**. 충돌 시 이 문서가 우선한다.
**적용:** SPEC-15(소유권 재편), SPEC-01(계층 분리), 모든 Port/Repository 분할 판단

---

## 0. 원칙

> **트랜잭션 안에서 원자적으로 일어나야 하는 일을 이해하지 못한 채 인터페이스를 쪼개면, 설계는 깨끗해 보이고 시스템은 더 위험해진다.**

SPEC-01은 계층 분리를 요구한다. 이 문서는 **어디까지 나눌 수 있는지**의 상한을 정한다. 계층 분리는 목적이 아니라 수단이다. 원자성을 잃으면 수단이 목적을 파괴한다.

---

## 1. 현재 트랜잭션 메커니즘 (코드 확인)

### 1-1. 한 명령 = 한 트랜잭션

`WeeklyExpenseCommandTransactionAspect.java:17-27`

```java
@Around("execution(public * ...WeeklyExpenseCommandService.*(..))")
public Object runInsidePersistenceTransaction(ProceedingJoinPoint joinPoint) {
    return persistence.runCommandTransaction(() -> joinPoint.proceed());
}
```

`WeeklyExpenseCommandService`의 **모든 public 메서드**가 자동으로 하나의 persistence 트랜잭션 안에서 실행된다.

### 1-2. 공유 수단은 thread-local

`FirestoreInheritedWeeklyExpensePersistence.java:193-218`

```java
public <T> T runCommandTransaction(Callable<T> action) {
    if (currentTransaction.get() != null) return call(action);   // 재진입 시 기존 트랜잭션 재사용
    return db.runTransaction(transaction -> {
        currentTransaction.set(transaction);
        transactionDocumentCache.set(new LinkedHashMap<>());
        currentCashflowLeaseScope.remove();
        currentCashflowWriteScope.remove();
        currentCashflowMonthStates.set(new LinkedHashMap<>());
        currentCashflowMonthAmendments.set(new LinkedHashMap<>());
        currentCashflowCumulativeHeads.set(new LinkedHashMap<>());
        currentCashflowCellChanges.set(new ArrayList<>());
        ...
    });
}
```

**하나의 클래스가 하나의 thread-local 집합을 소유하기 때문에** 트랜잭션이 공유된다. 이 집합에는 단순 캐시가 아니라 **누적 상태**가 들어 있다:

| thread-local | 성격 |
|---|---|
| `currentTransaction` | Firestore 트랜잭션 핸들 |
| `transactionDocumentCache` | 읽은 문서 캐시 (읽기 일관성) |
| `currentCashflowMonthStates` | 명령 진행 중 누적되는 월 상태 |
| `currentCashflowMonthAmendments` | 확정월 변경 누적 |
| `currentCashflowCumulativeHeads` | 누적 결산 head 변경 |
| `currentCashflowCellChanges` | 셀 변경 이력 누적 |
| `currentCashflowLeaseScope` / `WriteScope` | 리스·쓰기 권한 스코프 |

`releaseCashflowLeaseAfterSuccessfulFinalCommand()`(`:209`)는 **트랜잭션이 성공했을 때만** 리스를 푼다.

### 1-3. 결과 — 인터페이스가 곧 트랜잭션 경계다

월 확정 하나가 아래를 **한 트랜잭션에서** 처리한다 (SPEC-15 조사 문서 §2 근거):

- `monthly_closes` 상태·revision·snapshotHash
- `monthly_close_versions`
- `cashflow_cumulative_close_heads`
- `cashflow_month_amendments` + 마감후 경고 카운트
- `cashflow_weekly_update_completions` 잠금/해제
- `weekly_api_audit_events`
- `weekly_api_idempotency`
- 시트 월 교체(`cashflow_weeks`)

**`WeeklyExpensePersistence`가 하나이기 때문에 이 원자성이 성립한다.**

---

## 2. 하지 말아야 할 분할

### D-1. `WeeklyExpensePersistence`를 여러 Port로 쪼개기 ❌

예: `MonthClosePort` / `AuditPort` / `IdempotencyPort` / `LedgerPort`로 분리.

**왜 위험한가:** 각 Port가 자기 트랜잭션을 열면 월 확정이 **여러 트랜잭션으로 쪼개진다**. 중간 실패 시 `monthly_closes`는 CLOSED인데 감사 기록이 없거나, 멱등키만 남고 결산이 없는 상태가 생긴다. **확정 후 불변성(SPEC-04)의 근거인 원자성이 사라진다.**

thread-local을 여러 Port가 공유하게 만들면 인터페이스만 나뉘고 결합은 그대로다. 그건 분할이 아니라 **위장**이다. 오히려 "나뉘어 있다"는 착각 때문에 다음 사람이 독립적으로 바꾸다 원자성을 깬다.

**허용되는 경우:** 모든 Port가 **동일한 트랜잭션 컨텍스트를 명시적 인자로 받고**, 그 컨텍스트를 만드는 주체가 하나일 때. 이 경우 thread-local이 아니라 **명시적 전달**이므로 경계가 코드에 드러난다. 다만 이 전환은 그 자체로 대규모 변경이며 별도 스펙이 필요하다.

### D-2. audit / idempotency helper 추출 ⚠️ 조건부

`weekly_api_audit_events`와 `weekly_api_idempotency` 쓰기를 헬퍼로 빼는 것.

**순수 추출(같은 트랜잭션 안에서 호출되는 함수로 분리)은 허용**한다. 감사 기록 형식·멱등키 계산 같은 **판정 로직**은 도메인으로 옮겨도 좋다.

**금지:** 헬퍼가 자기 트랜잭션을 열거나, 비동기로 나가거나, 실패해도 본 명령이 성공하게 만드는 것. 감사 기록은 **결산과 같은 트랜잭션에서 커밋되어야** 감사 근거가 된다. "감사는 부수효과니 실패해도 된다"는 판단은 이 도메인에서 틀렸다.

### D-3. repository 경계 변경 ⚠️ 조건부

**허용:** 읽기 전용 조회를 별도 인터페이스로 분리. 읽기는 원자성 요구가 약하다.

**금지:** 쓰기 경로를 여러 repository로 나누기. 위 D-1과 같은 이유다.

**주의:** `transactionDocumentCache`(`:200`)가 있어 같은 트랜잭션 안의 읽기는 캐시된다. 읽기를 다른 repository로 빼면 이 캐시를 잃어 **읽기 일관성이 깨지고 참조 횟수가 늘 수 있다.** SPEC-12의 성과를 되돌릴 수 있다.

### D-4. BFF에서 business knowledge 제거 ✅ 권장, 단 순서 주의

BFF가 도메인 판정을 갖는 것은 SPEC-01 위반이 맞다. 다만 **BFF의 Firestore 트랜잭션**(월 결산 요청/승인, `jvm-weekly-api.mjs`의 10개 트랜잭션)을 제거할 때는 **JVM이 같은 원자성을 제공한 뒤**여야 한다.

순서를 뒤집으면 — BFF 트랜잭션을 먼저 없애고 JVM 이관이 미완이면 — 원자성 공백이 생긴다. SPEC-15의 PR-A(JVM 엔드포인트 신설) → PR-B(게이트 전환) → PR-C(구 경로 삭제) 순서가 이 이유로 정해져 있다.

---

## 3. 판단 절차 (분할을 제안하기 전에)

인터페이스를 나누자는 제안이 나오면 **아래를 먼저 답한다.**

```
[분할 판단]
1. 이 경계를 넘는 쓰기가 한 트랜잭션에서 일어나야 하는가?
   - 근거: 중간 실패 시 어떤 불일치가 생기는가를 구체적 시나리오로
2. 현재 원자성을 보장하는 메커니즘은 무엇인가? (파일:줄)
3. 분할 후에도 그 메커니즘이 유지되는가? 어떻게?
4. thread-local 공유에 의존하는가? 의존하면 그것은 분할이 아니다
5. 분할하지 않고 목적을 달성할 방법이 있는가?
   - 예: 같은 클래스 안에서 함수 추출, 도메인 판정만 밖으로
```

**1번의 답이 "그렇다"이고 3번에 명확한 답이 없으면 분할하지 않는다.**

---

## 4. 권장 — 나누지 말고 뽑아내라

이 도메인에서 안전한 개선은 **인터페이스 분할이 아니라 판정 로직 추출**이다.

| 대상 | 방법 |
|---|---|
| 결산 기한·주차 달력 | 도메인 순수 함수로 **추출**. persistence는 그 함수를 호출만 |
| 상태 전이 가능 여부 | 순수 판정 함수로 추출 |
| 멱등키 계산·감사 이벤트 형식 | 순수 함수로 추출 |
| 쿼리 범위 계산 | 이미 `CashflowQueryScope`로 추출됨 (SPEC-12) |

**추출(extract)은 트랜잭션 경계를 건드리지 않는다.** persistence 클래스는 여전히 하나이고 원자성은 그대로이면서, 규칙은 테스트 가능한 순수 함수가 된다. SPEC-01이 요구하는 계층 분리의 실질을 얻는다.

`FirestoreInheritedWeeklyExpensePersistence.java`가 6,891줄인 것은 문제다. 그러나 **줄 수를 줄이는 방법이 인터페이스 분할일 필요는 없다.** 판정 로직을 도메인으로 뽑아내면 줄 수는 줄고 원자성은 유지된다.

---

## 5. SPEC-15 수정 사항

SPEC-15 §4-1의 "BFF는 `cashflow_*`에 쓰지 않는다"는 유지한다. 다만 아래를 추가한다.

- **JVM 내부에서 `WeeklyExpensePersistence`를 여러 Port로 쪼개지 마라.** 소유권 이관은 BFF→JVM 이동이지 JVM 내부 재구조화가 아니다
- JVM 내부 정리가 필요하면 **§4의 추출 방식**을 쓴다
- `jvm-weekly-api.mjs` ≤2,500줄 목표는 유지하되, 그 수단은 BFF에서 로직을 **제거**하는 것이지 새 추상 계층을 만드는 것이 아니다

## 6. 금지 요약

- 트랜잭션 경계를 이해하지 않은 인터페이스 분할
- thread-local 공유에 의존하면서 "분리했다"고 주장하기
- 감사·멱등 기록을 본 트랜잭션 밖으로 빼기
- 쓰기 경로를 여러 repository로 분산
- BFF 트랜잭션 제거를 JVM 이관보다 먼저 하기
- 읽기를 다른 repository로 빼서 `transactionDocumentCache`를 잃기
