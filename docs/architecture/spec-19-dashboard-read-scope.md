# SPEC-19 — 월 결산 대시보드 읽기 범위 조사

**작성:** 2026-08-07 · **성격: 조사 전용. 코드 수정 금지.**
**선행:** `spec-02`, `spec-04`, `spec-12-amendment-a` 필독
**산출물:** `docs/architecture/spec-19-dashboard-read-scope-analysis.md`

---

## 0. 왜 이 조사가 필요한가

SPEC-12의 헤드라인 목표는 **"월 결산 조회 540→5"**였다. 구현은 완료됐고 테스트도 540→5를 강제한다. 그런데 **실제 사용자 경로는 개선되지 않았다.**

```
WeeklyExpenseController.java:478
  dashboard-source → readCashflowSource(tenantId, projectId)
  → :304 findCashflowLedgerSource(tenantId, projectId)   ← 무범위 오버로드
  → FirestoreInheritedWeeklyExpensePersistence.java:2540
     "SPEC-12 approved full scan: findCashflowLedgerSource serves the all-month dashboard"
```

개선이 적용된 곳은 `readCashflowProjectionActualSummaries`(범위 지정 오버로드)로 **다른 엔드포인트**다.

### 원인은 스펙의 모순

SPEC-12가 두 가지를 동시에 요구했다:
1. "단일 월 조회가 읽는 `cashflow_weeks` 540 → 5"
2. "`monthly_closes`는 필터가 아니라 필드 선택 문제다. **대시보드가 모든 달을 그리는 것은 정당하다**"

구현자는 §4-2 절차(호출부 전수 확인)를 따라 `findCashflowLedgerSource`가 전체 대시보드를 서빙한다고 판정하고 예외로 뒀다. **절차상 정확한 판단이다.** 문제는 두 요구가 모순이라는 것이다.

**이 조사는 그 모순을 사실로 푼다.** "대시보드가 모든 달을 그린다"가 진짜인지, 그렇다면 540건의 원본 주차 문서가 정말 필요한지 확인한다.

---

## 1. 조사 질문 (전부 코드 근거로 답할 것)

### Q1. 대시보드는 540건을 실제로 무엇에 쓰는가
`readCashflowSource`가 반환한 `CashflowLedgerSource`의 각 필드가 응답의 어디로 흘러가는지 추적하라.

- `source.projection()` / `source.actual()` / `source.weeklyYears()` 등 각 접근자의 소비처
- `buildCashflowSnapshot(projectId, source)`가 만드는 응답 구조와, 그중 실제로 프론트가 쓰는 필드
- **전 기간 원본 주차 데이터가 필요한 계산**과 **집계값이면 충분한 계산**을 구분하라

### Q2. 프론트는 무엇을 그리는가
`src/app/components/cashflow/CashflowProjectSheet.tsx`와 관련 컴포넌트가 `month-close` 응답의 어느 필드를 소비하는지 확인하라.

- 화면이 실제로 표시하는 달의 범위
- "모든 달"이 정말 필요한 UI가 있는가, 아니면 선택된 달 + 집계인가
- 사용되지 않고 응답에만 실리는 필드가 있는가 (응답 270KB의 구성)

### Q3. 이미 존재하는 집계 문서로 대체 가능한가
아래 문서들이 무엇을 담고 있고, 대시보드가 필요로 하는 값을 이미 갖고 있는지 확인하라.

| 컬렉션 | 확인할 것 |
|---|---|
| `cashflow_cumulative_close_heads` | 누적 결산 집계. 어떤 필드가 있는가 |
| `cashflow_sheet_year_totals` | 연간 합계. 대시보드가 쓰는 값과 겹치는가 |
| `monthly_closes` | 월별 스냅샷. `snapshot` 안에 무엇이 들어 있는가 |

**주의:** SPEC-12에서 `monthly_closes`는 이미 6필드 `select`로 좁혔다(커밋 `67586182`). 그 6필드가 무엇이고 충분한지 확인하라.

### Q4. targetRevision 제약이 여기에도 걸리는가
`findCashflowLedgerSource`의 무범위 버전이 `computeCashflowTargetRevision`에 흘러드는지 확인하라.

- 흘러든다면 → 범위 축소는 Task #16(월별 revision 계약)의 선행 설계가 필요하다. 그 사실을 명시하라
- 흘러들지 않는다면 → 대시보드 경로는 revision과 무관하게 좁힐 수 있다

**이것이 이 조사의 가장 중요한 분기점이다.**

### Q5. 확정(CLOSED) 월과 진행 중 월의 읽기 경로가 다른가
`currentLedgerView` 분기(`WeeklyExpenseController.java:471-479`)를 보면 CLOSED 월은 `source`가 `null`이다.

- 즉 **확정된 달은 이미 원장을 읽지 않는다**. 그렇다면 540건은 어떤 조건에서 읽히는가
- 진행 중인 달 하나를 보는데 왜 전 기간이 필요한가

### Q6. 실제 부하 조건
- 계약 9년 프로젝트가 실재하는가, 아니면 최악 가정인가 (`cashflow_sheet_year_totals`의 실제 연도 범위)
- 프로젝트당 평균/최대 `cashflow_weeks` 문서 수

---

## 2. 산출물 요구사항

`docs/architecture/spec-19-dashboard-read-scope-analysis.md`에 아래를 담는다.

1. Q1~Q6 각각의 답. **모든 항목에 `파일:줄` 근거.** 확인 못 한 것은 "미확인"으로 명시
2. **결론**: 대시보드 읽기를 좁힐 수 있는가 / 없는가 / 조건부인가
3. 좁힐 수 있다면 **대안 3개**와 각각의 위험도
   - 예: (a) 범위 지정 오버로드로 전환 (b) 집계 문서 활용 (c) 응답 필드 축소
4. 각 대안의 **정량 예측**: 읽기 문서 수, 응답 크기, 예상 p95
5. **Task #16(revision 계약) 의존 여부** — Q4의 답에 따라
6. **SPEC-04 영향**: 확정 월 판정값에 영향이 있는가 (없어야 한다)
7. Freeze Unit 분해 제안
8. 되돌릴 수 없는 변경 후보
9. **권장안과 근거**. 권장하지 않는 안의 이유도 적어라

---

## 3. 금지

- **코드 수정** (산출 문서 생성 제외)
- 추측. 모든 주장에 `파일:줄` 근거를 붙여라
- "좁힐 수 있다"를 근거 없이 쓰기 — 소비처를 전부 확인한 뒤에만 쓴다
- PR 생성
- SPEC-12가 이미 승인한 다른 8개 예외 지점 재검토 (범위 밖)

## 4. 참고 — 기존 측정치

| 지표 | 값 | 출처 |
|---|---|---|
| month-close 콜드 | 14.58초 | 2026-07-27 스테이지 실측 |
| 웜 | 4.15초 | 동일 |
| 응답 크기 | 270KB | 동일 |
| 최악 `cashflow_weeks` | 540문서 (9년) | 데이터 모델 산출 |

이 수치가 **여전히 유효한지**도 확인 대상이다. SPEC-12의 `monthly_closes` 필드 선택(`67586182`)이 응답 크기를 이미 줄였을 수 있다.
