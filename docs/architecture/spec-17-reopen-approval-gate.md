# SPEC-17 — 월 결산 재오픈 자기승인 금지 강제

**작성:** 2026-08-07 · **선행:** `spec-02`, `spec-03`, `spec-04` 필독
**베이스:** `origin/main` · **브랜치:** `fix/month-close-reopen-self-approval`
**배포 단위:** JVM (+ BFF 검증 보강 시 BFF) · **우선순위: 높음 — 확정된 결산의 무결성 문제**

---

## 1. 확인된 결함

월 결산 재오픈은 **요청 → 결정** 2단계이고, 결정은 확정(CLOSED)된 월을 다시 OPEN으로 되돌린다. 즉 **확정 후 불변성을 해제하는 유일한 경로**다.

그런데 요청자와 결정자가 같은 사람인지 검사하지 않는다.

| 지점 | 코드 | 확인 |
|---|---|---|
| 요청자 UID 저장 | `FirestoreInheritedWeeklyExpensePersistence.java:1857` | `reopenRequest.put("requestedByUid", actor.id())` |
| 결정자 UID 저장 | 같은 파일 `:1963` | `decision.put("decidedByUid", actor.id())` |
| **두 값 비교** | — | **전수 검색 0건** |
| BFF 권한 검사 | `jvm-weekly-api.mjs:4282` | `assertWeeklyWorkspaceOrRoleAllowed(req, ['admin','finance'], ...)` — **역할만** 확인 |

**결과:** `admin` 또는 `finance` 역할을 가진 사람이 자신이 요청한 재오픈을 스스로 승인할 수 있다.

### 대조 — 다른 승인 경로에는 게이트가 있다

| 게이트 | 위치 |
|---|---|
| 월 결산 승인 요청자≠승인자 | `jvm-weekly-api.mjs:322-333` |
| 조직장 지정 시 자기승인 후보 차단 | `jvm-weekly-api.mjs:3436-3437` |
| 검토자는 현재 지정 승인자여야 함 | `jvm-weekly-api.mjs:3917-3927` |

**재오픈 경로만 빠져 있다.** 설계 의도가 아니라 누락으로 보인다. SPEC-04 §4-2가 요구하는 "승인 게이트 보존"과 충돌한다.

## 2. 목표

재오픈 결정 시 **요청자와 결정자가 같으면 거부**한다.

| 축 | 현재 | 목표 |
|---|---|---|
| 재오픈 자기승인 차단 | **0%** (무제한 허용) | **100%** |
| 기존 정상 재오픈 흐름 | 동작 | **변화 없음** |
| 응답시간·참조 횟수 | — | **회귀 없음** (비교 1회 추가) |

## 3. 요구사항

### 3-1. 판정 위치는 JVM

BFF에도 넣고 싶을 수 있으나, **JVM이 소유자**다(SPEC-01: 판정은 소유자만). BFF는 역할 검사만 유지한다.

`requestCashflowMonthReopen`이 쓴 `reopenRequest.requestedByUid`를 `decideCashflowMonthReopen`이 읽어 `actor.id()`와 비교한다.

### 3-2. 트랜잭션 내부에서 검증

재오픈 결정은 이미 트랜잭션 안에서 상태를 재검증한다. **같은 트랜잭션 안에서** 비교해야 요청자가 중간에 바뀌는 경합을 막는다.

### 3-3. 오류 표현

- JVM: 기존 승인 게이트와 같은 예외 계열을 쓴다 (`WeeklyExpenseForbiddenException` 또는 conflict 계열 — 기존 자기승인 거부가 쓰는 방식을 **먼저 확인하고 맞춘다**)
- 코드: `cashflow_month_close_self_approval_forbidden` **재사용**. 새 코드를 만들지 마라 (SPEC-14가 이미 이 코드를 사용자 가이드로 매핑했다)
- 가이드 문구는 이미 존재한다: "요청한 사람은 자신의 월 결산을 승인할 수 없어요. 다른 조직장에게 승인을 요청해 주세요."

### 3-4. 기존 데이터 호환 (SPEC-04)

- `requestedByUid`가 **없는** 과거 요청 문서가 있을 수 있다. 이 경우 **비교를 건너뛰고 허용**한다. 값이 없다고 거부하면 과거 요청이 영구히 막힌다
- 이 폴백은 **명시적으로 관측 가능**해야 한다 (G-5 조용한 폴백 금지). 로그 또는 결과 필드로 남긴다
- 확정된 과거 문서를 수정하지 마라

## 4. Freeze Unit

| Unit | 내용 |
|---|---|
| 17-A | 비교 판정을 순수 함수로 분리 + 단위 테스트 (호출부 0이어도 존재 가능) |
| 17-B | `decideCashflowMonthReopen`에서 호출 + 통합 테스트 |

17-A를 먼저 단독 커밋한다.

## 5. 성공 조건

### 5-1. 핵심
1. 요청자 A, 결정자 A → **거부**, 코드 `cashflow_month_close_self_approval_forbidden`
2. 요청자 A, 결정자 B → **승인 성공** (기존 흐름 불변)
3. 거부 시 `monthly_closes` 상태가 **변경되지 않는다** (부분 상태 없음)
4. 거부 시 주차 잠금 해제(`cashflow_weekly_update_completions` LOCKED→OPEN)도 발생하지 않는다

### 5-2. 경계·오염 (SPEC-00 G절)
5. `requestedByUid` 부재(레거시 문서) → 허용되고, 폴백이 관측 가능하다
6. `requestedByUid`가 `''` / `null` → 5번과 동일 처리
7. UID 대소문자·공백 차이 → **정규화 후 비교**할지 결정하고 그 판단을 보고에 적어라. 임의로 정하지 마라
8. `requestedByUid`가 `__proto__` / 10만 자 → 예외 없이 비교만 수행
9. 결정자가 `admin`이어도 요청자와 같으면 거부 (역할이 게이트를 우회하지 못한다)

### 5-3. 동시성
10. 서로 다른 두 사용자가 동시에 결정 → 하나만 성공 (기존 낙관적 제어 유지)
11. 요청자 본인과 타인이 동시에 결정 → **타인만** 성공

### 5-4. 회귀 방지 쌍 (SPEC-00 G절 9)
12. **유지 존재**: 재오픈 2단계, 역할 검사(admin/finance), 낙관적 revision 재검증, 반려 사유 필수가 전부 그대로 동작
13. **제거 부재**: 자기승인이 성공하는 경로가 남아 있지 않다

### 5-5. 게이트
- JVM 테스트 전체 통과 (기존 MockMvc·Firestore 트랜잭션 테스트 회귀 0)
- `npm test` 통과
- `git diff --check`

## 6. 하지 말 것

- 새 오류 코드 신설 (`cashflow_month_close_self_approval_forbidden` 재사용)
- BFF에 판정 로직 추가 (역할 검사만 유지 — 판정은 JVM 소유)
- 과거 문서 마이그레이션
- 레거시 문서를 거부로 처리 (과거 요청이 영구히 막힌다)
- 다른 승인 경로의 게이트 수정
- 이 스펙 범위 밖 파일 수정
