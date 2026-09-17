# SPEC-12 개정 A — 쓰기 경로 제외, revision 계약은 선행설계로 분리

**작성:** 2026-08-07 · **위상:** `spec-12-query-amplification.md` 를 **수정**한다. 충돌 시 이 문서가 우선한다.
**사유:** 구현 중 SPEC-02 §3 절차로 제기된 스펙 이의를 검증한 결과, 원 스펙의 지시가 틀렸음이 확인됐다.

---

## 1. 확인된 사실

`FirestoreInheritedWeeklyExpensePersistence.java`

```java
:2192  String resultingTargetRevision = computeCashflowTargetRevision(resultingWeeks.values());
:2409  static String computeCashflowTargetRevision(Collection<Map<String, Object>> documents)
```

`computeCashflowTargetRevision`은 **넘겨받은 문서 집합 전체**를 정렬해 해시한다. 따라서 이 값은 "프로젝트 전체 `cashflow_weeks`의 상태"를 뜻한다.

`replaceCashflowSheetMonthsInternal`(`:2231`)의 읽기 범위를 대상 월로 좁히면:

- revision 해시가 **부분 집합 기준**이 되어 의미가 달라진다
- 정상 apply가 conflict로 오판될 수 있다
- 기존 Firestore 트랜잭션 테스트 2건(`monthlyApplyReplacesProjectionAndOnlyTheSheetActualSource`, `resultingRevisionChainsSequentialMonthApplies`)이 실패한다

원 스펙 §3의 지시표에서 **2231행 `replaceCashflowSheetMonthsInternal` → "대상 월 집합으로 제한"** 은 잘못된 지시였다.

> 이 테스트를 통과시키려 기대값을 바꾸는 것은 SPEC-02 G-1 위반이다. 구현자가 되돌리고 중단 보고한 것은 절차상 정확하다.

## 2. 개정 내용

### 2-1. 승인된 전체 스캔 예외

아래 지점은 **의도된 전체 스캔**이다. 좁히지 말 것. 소스에 사유 주석을 남긴다.

| 위치 | 메서드 | 사유 |
|---|---|---|
| `:2231` | `replaceCashflowSheetMonthsInternal` | 전역 targetRevision 계약 |
| `:2047` | `countCashflowActualReplacementWrites` | 위와 동일 계약 경로에 속하는지 **호출부 확인 후 판정**. 속하면 예외, 아니면 좁힌다 |

SPEC-12 §5-5의 "제거 부재 확인" 테스트는 이 예외 목록을 **명시적으로 허용**하도록 작성한다. 예외 목록 자체를 테스트로 고정해 새 무필터 스캔이 몰래 늘어나지 않게 한다.

### 2-2. 이번 작업의 범위 (축소)

| Unit | 내용 | 상태 |
|---|---|---|
| **12-A** | `CashflowQueryScope` 순수 도메인 클래스 + 단위 테스트 | 유지 |
| **12-B** | `monthly_closes` 필드 선택(`select`) | 유지 |
| **12-C** | `cashflow_weeks` 필터 — **읽기 전용 메서드에만** | 축소 |
| ~~12-D~~ | ~~쓰기 경로(revision 계약 관련) 범위 축소~~ | **제외** |

12-C 대상은 revision 계산에 관여하지 않는 읽기 메서드로 한정한다. 각 메서드마다 SPEC-12 §4-2 절차(호출부 전수 확인)를 그대로 적용하고, **revision 계약 경로에 닿는지**를 판정 기준에 추가한다.

### 2-3. 정량 목표 조정

| 축 | 원 목표 | 개정 목표 | 회귀 예산 |
|---|---|---|---|
| 단일 월 **조회**가 읽는 `cashflow_weeks` | 540 → 5 | **540 → 5 (유지)** | ≤ 10 |
| 쓰기 경로(`replace...`)의 읽기 | 540 → 5 | **540 유지 (예외)** | — |
| p95 웜 / 콜드 | ≤1.0s / ≤4.0s | **유지** | ≤2.0s / ≤6.0s |

조회 경로 목표는 그대로다. 사용자가 체감하는 지연은 대시보드 **조회**에서 나오고, 그 경로는 revision 계약과 무관하다.

## 3. 분리된 선행설계 (이번 작업 아님)

**월별 revision 계약 재설계**를 별도 과제로 분리한다.

- 현재: revision = 프로젝트 전체 `cashflow_weeks` 해시 → 쓰기 경로가 전체를 읽어야 함
- 필요: 월 단위 revision 또는 계층적 revision → 쓰기 경로도 범위 제한 가능
- 위험도: **SPEC-15급**. 낙관적 동시성 제어의 기준값을 바꾸는 것이므로 진행 중 apply·결산과 충돌 가능
- 전제: SPEC-04의 확정 후 불변성 — 이미 저장된 `targetRevisionAtFetch`, `appliedTargetRevision` 값과의 호환 판정 필요

**이번 스펙에서 이 설계를 시도하지 마라.** 별도 스펙으로 다룬다.

## 4. 구현자에게

- 이미 작성한 `CashflowQueryScope.java` + 테스트는 유효하다. 유지한다
- 되돌렸던 쓰기 경로 변경은 **되돌린 상태를 유지**한다
- §2-1 예외 지점에 사유 주석을 남기고, 예외 목록을 테스트로 고정한다
- 12-A → 12-B → 12-C 순서로 **각각 커밋**한다 (SPEC-03 F-1/F-2)
