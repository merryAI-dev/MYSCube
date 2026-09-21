# SPEC-20 — JVM 락 판정에 임대 만료 적용 (사고 원인 #1의 나머지 절반)

**작성:** 2026-08-07 · **선행:** `spec-02`, `spec-03`, `spec-05` 필독
**베이스:** `origin/main` (`d67cdbef`) · **브랜치:** `fix/jvm-apply-lease-parity`
**배포 단위:** JVM 단독 · **우선순위: 최고 — 2026-08-06 사고 원인의 미해결 절반**

---

## 1. 문제

2026-08-06 사고: 시트 반영 중단 → `cashflow_sheet_publications.status=APPLYING` 영구 잔존 → 월 결산 전면 409.

PR #470이 **BFF 쪽**에 임대(lease) 만료를 도입했다:
- `server/bff/cashflow-apply-lease.mjs` — `applyStartedAt` + 기본 10분, `CASHFLOW_APPLY_LEASE_MS` env (0=비활성)
- 만료 시 차단 해제 + 락 자동 정리

그러나 **JVM 쪽 같은 판정은 그대로다.**

`FirestoreInheritedWeeklyExpensePersistence.java:3792-3805`:

```java
private void requireCashflowSheetPublicationReady(String tenantId, String projectId) {
    DocumentSnapshot publicationSnapshot = get(db.document(
        "orgs/" + tenantId + "/cashflow_sheet_publications/" + projectId
    ));
    if (!publicationSnapshot.exists()) return;
    String status = text(data(publicationSnapshot).get("status"), "").toUpperCase(Locale.ROOT);
    if ("APPLYING".equals(status)) {
        throw new WeeklyExpenseConflictException(
            "Cashflow sheet values are being applied. Retry the month close after the apply finishes."
        );
    }
}
```

`applyStartedAt` / lease 참조: **파일 전체 0건** (검증 완료).

**결과:** BFF 임대가 만료돼 조회를 열어줘도, JVM은 월 결산 명령을 **무기한 거부**한다. 락 문서를 고아 상태로 만드는 어떤 장애에서도 월 결산이 영구 차단된다.

## 2. 목표

BFF와 **동일한 임대 시맨틱**을 JVM 판정에 적용한다.

| 축 | 현재 | 목표 |
|---|---|---|
| JVM 월 결산 차단 (락 고아 시) | **무기한** | **최대 10분** |
| BFF·JVM 판정 일치 | 불일치 (BFF만 임대) | **동일 규칙** |
| 기존 정상 차단 (임대 유효 중) | 동작 | **변화 없음** |

## 3. 요구사항

### 3-1. 판정 규칙 — BFF와 바이트 단위로 같은 의미

`server/bff/cashflow-apply-lease.mjs`의 `readCashflowApplyLeaseState`가 원본 계약이다. **먼저 읽고 그대로 옮겨라:**

- `blocked = status=='APPLYING' && !expired`
- `expired = applying && leaseEnabled && startedAt!=null && now - startedAt >= leaseMs`
- `applyStartedAt`이 **없거나 파싱 불가**하면 만료로 취급하지 않는다 (`missingStartedAt` → 계속 차단). 이 문서를 이 경로가 쓴 게 아니므로 시간으로 판단하지 않는다
- lease 값 0 = 비활성 (기존 무기한 차단 동작)

### 3-2. 설정 — 같은 env, 같은 기본값

- env 이름 **`CASHFLOW_APPLY_LEASE_MS`** 를 BFF와 공유한다. 다른 이름을 만들지 마라 (운영자가 한 값만 관리)
- 기본값 10분 (600000)
- Spring 주입 방식은 기존 관례를 따르라 (`application.yml` + `@Value` — 기존 `weekly.*` 설정 참조)
- **주의:** 이 값의 SSOT는 후속 SPEC-13에서 policy로 갈 수 있다. 지금은 env 공유까지만 하고, 하드코딩 상수를 여러 곳에 만들지 마라

### 3-3. JVM은 락을 **해제하지 않는다**

락 문서의 writer는 BFF다 (소유권). JVM은 **만료된 임대를 차단하지 않는 것까지만** 한다. `cashflow_sheet_publications`에 쓰지 마라. 해제·정리는 BFF의 기존 경로가 한다.

### 3-4. 계층 (SPEC-01/05/06)

- 임대 판정을 **순수 도메인 클래스**로 분리 (`domain/` 패키지). Firestore 핸들·Clock 직접 참조 금지 — `nowMs`, `leaseMs`, 문서 필드 값을 **인자로** 받는다
- `FirestoreInheritedWeeklyExpensePersistence.java`(6,891줄)에는 **호출 한 줄만** 추가한다
- BFF `cashflow-apply-lease.test.mjs`의 8개 케이스를 Java 테스트로 **미러링**한다 — 두 구현이 갈리면 테스트가 먼저 알도록 같은 픽스처 값을 쓴다

### 3-5. 시간 소스

`requireCashflowSheetPublicationReady`는 트랜잭션 안에서 호출될 수 있다. 기존 코드가 쓰는 시간 소스(`clock.instant()` 등)를 확인하고 **같은 것**을 쓰라. `System.currentTimeMillis()` 직접 호출을 새로 만들지 마라. 판단 근거를 보고에 적어라.

## 4. Freeze Unit

| Unit | 내용 | 단독 동결 |
|---|---|---|
| 20-A | 임대 판정 순수 도메인 클래스 + BFF 미러 테스트 8종 | ✅ 호출부 0 |
| 20-B | `requireCashflowSheetPublicationReady`에 연결 + 통합 테스트 | 20-A 이후 |

## 5. 성공 조건

### 5-1. 판정 동등성 (핵심)
1. BFF 테스트 8케이스와 **같은 입력 → 같은 blocked/expired** (미러 테스트)
2. 임대 유효 중 → 월 결산 차단 유지 (기존 동작, 회귀 방지)
3. 임대 만료 → 월 결산 **진행** (신규)
4. `applyStartedAt` 없음/파싱불가 → 계속 차단
5. lease=0 → 무기한 차단 (롤백 경로)

### 5-2. 소유권
6. **JVM이 `cashflow_sheet_publications`에 쓰지 않는다** — diff에 해당 컬렉션 write가 0건 (소스 스캔 단언)

### 5-3. 경계·오염 (SPEC-00 G절)
7. `applyStartedAt`이 `"not-a-date"` / 숫자 / 10만 자 → 예외 없이 "차단 유지"
8. `status`가 소문자 `applying` / 공백 포함 → 기존 대문자 정규화 유지
9. 미래 시각 `applyStartedAt` → 만료 아님 (음수 경과 처리)
10. 경계값: 경과 == leaseMs 정확히 → BFF와 같은 판정 (`>=` — BFF 코드로 확인하라)

### 5-4. 게이트
- `mvn test` 전체 (기존 회귀 0) / `npm test` / `git diff --check`

## 6. 하지 말 것

- JVM에서 락 해제·정리 (BFF 소유)
- 새 env 이름 발명
- 판정을 persistence 클래스 안에 직접 구현 (도메인 분리)
- BFF 코드 수정
- `WeeklyExpenseConflictException` 메시지 계열 변경 (SPEC-14 매핑과 얽힘) — 만료 시에는 예외를 던지지 않는 것이지, 던질 때의 메시지를 바꾸는 것이 아니다
