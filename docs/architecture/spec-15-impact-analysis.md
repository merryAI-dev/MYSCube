# SPEC-15 월 결산 소유권 이전 영향 분석

**조사일:** 2026-08-07  
**베이스:** `6b4e160f fix(cashflow): recover uncertain sheet applies (#469)`  
**범위:** 구현 전 읽기 전용 조사. 코드·데이터 변경 없음.

## 0. 결론과 착수 게이트

SPEC-15 구현은 아직 착수하면 안 된다. SPEC-13 완료, PR #406/#408 순서 조율, 조직 승인이 선행 조건이다. 특히 현재 베이스의 정적 수치가 SPEC-15와 다르고, 재오픈 자기승인 금지가 실제 JVM 경로에 강제되지 않아 먼저 스펙/보호 규칙을 확정해야 한다.

| 게이트 | 조사 결과 | 근거 |
|---|---|---|
| SPEC-13 완료 | 미확인 | 이 조사 범위에서 완료 증거를 확인하지 않음 |
| PR #406/#408 조율 | 미충족 | `gh pr view`: #406 MERGED, #408 OPEN; 충돌 범위는 §11 |
| 조직 승인 | 미확인 | 저장소에서 승인 기록 확인 불가 |

## 1. BFF 월 결산 쓰기 지점 전수

### 1-1. 정적 계수 정정

현재 `server/bff/routes/jvm-weekly-api.mjs`에는 `transaction.set(` 정적 호출이 **23곳**, 이를 포함하는 월 결산 `runTransaction` 블록이 **10곳**이다. shard 반복과 `completeMonthSettlement()` 호출 때문에 런타임 실제 write 수는 입력/분기에 따라 달라진다. 아래는 현재 코드의 23개 호출 전수다.

| # | 호출 지점 | 쓰는 문서/의미 |
|---:|---|---|
| 1 | `server/bff/routes/jvm-weekly-api.mjs:3281` | 없는 누적 근거 shard를 `cashflow_month_close_request_months/{requestId}-r{revision}-{yearMonth}`에 생성 |
| 2 | `server/bff/routes/jvm-weekly-api.mjs:3283` | 누적 요청 header를 `cashflow_month_close_requests/{requestId}`에 저장(PENDING, revision, manifest, totals, 승인자/요청자, 멱등 fingerprint) |
| 3 | `server/bff/routes/jvm-weekly-api.mjs:3290-3306` | `cashflow_settlement_statuses/{projectId}-{yearMonth}`의 MONTH를 `PENDING_APPROVAL`로 merge |
| 4 | `server/bff/routes/jvm-weekly-api.mjs:3308-3323` | 요청/재요청 audit(`REQUESTED`/`RESUBMITTED`) 저장 |
| 5 | `server/bff/routes/jvm-weekly-api.mjs:3469-3476` | `projects/{projectId}`에 조직장 필드와 version 저장 |
| 6 | `server/bff/routes/jvm-weekly-api.mjs:3477-3490` | 조직장 변경 audit(`APPROVER_UPDATED`) 저장 |
| 7 | `server/bff/routes/jvm-weekly-api.mjs:3773-3789` | legacy 요청 생성 시 정산 MONTH를 `PENDING_APPROVAL`로 merge |
| 8 | `server/bff/routes/jvm-weekly-api.mjs:3822` | 반려된 legacy 요청을 PENDING 새 revision으로 재제출 |
| 9 | `server/bff/routes/jvm-weekly-api.mjs:3824-3836` | legacy `RESUBMITTED` audit 저장 |
| 10 | `server/bff/routes/jvm-weekly-api.mjs:3860` | 신규 legacy 요청 header(PENDING, requestPayload, monthSnapshot 등) 저장 |
| 11 | `server/bff/routes/jvm-weekly-api.mjs:3862-3874` | legacy `REQUESTED` audit 저장 |
| 12 | `server/bff/routes/jvm-weekly-api.mjs:3937-3952` | 승인 완료 시 정산 MONTH를 `COMPLETED`로 merge하는 공통 helper; 호출은 :4055, :4238 |
| 13 | `server/bff/routes/jvm-weekly-api.mjs:4003` | 누적 요청을 `REJECTED`로 전이 |
| 14 | `server/bff/routes/jvm-weekly-api.mjs:4004-4020` | 누적 `REJECTED` audit 저장 |
| 15 | `server/bff/routes/jvm-weekly-api.mjs:4054` | 누적 요청을 `APPROVED`로 전이 |
| 16 | `server/bff/routes/jvm-weekly-api.mjs:4056-4072` | 누적 `APPROVED` audit 저장 |
| 17 | `server/bff/routes/jvm-weekly-api.mjs:4121` | legacy 요청을 `REJECTED`, revision+1로 전이 |
| 18 | `server/bff/routes/jvm-weekly-api.mjs:4122-4135` | legacy `REJECTED` audit 저장 |
| 19 | `server/bff/routes/jvm-weekly-api.mjs:4176-4185` | legacy 승인 시작 상태 `APPROVING`과 preparedCloseBody 저장 |
| 20 | `server/bff/routes/jvm-weekly-api.mjs:4208-4212` | JVM 결과 불확실 시 legacy 요청을 `UNCERTAIN`으로 저장 |
| 21 | `server/bff/routes/jvm-weekly-api.mjs:4237` | JVM 결산 확인 뒤 legacy 요청을 `APPROVED`로 전이하고 임시 근거 삭제 |
| 22 | `server/bff/routes/jvm-weekly-api.mjs:4239-4253` | legacy `APPROVED` audit와 JVM 멱등키 저장 |
| 23 | `server/bff/routes/jvm-weekly-api.mjs:4313-4318` | JVM 재오픈 승인 뒤 BFF 요청 read-model을 `REOPENED`로 맞춤(실패는 :4321-4323에서 삼킴) |

10개 트랜잭션 경계는 `:3145`, `:3409`, `:3740`, `:3985`, `:4027`, `:4093`, `:4157`, `:4199`, `:4219`, `:4303`이다. 즉 “11개”를 삭제 단위로 사용할 수 없고, 컬렉션/상태 전이별로 다시 산정해야 한다.

## 2. JVM 월 결산 쓰기 지점 전수

JVM의 실제 Firestore 쓰기는 공통 `set()`이 독립 실행이면 merge-set, 트랜잭션 안이면 transaction merge-set을 한다(`FirestoreInheritedWeeklyExpensePersistence.java:4728-4748`). 아래 표의 `...Persistence.java`는 이 파일을 뜻한다. 월 결산 command transaction에 포함되는 직접/부수 쓰기는 다음과 같다.

| 소유 동작 | 쓰기 문서 | 근거 |
|---|---|---|
| CLOSED 월 amendment 메타 갱신 | 기존 `monthly_closes/{projectId}-{yearMonth}` revision/count/사유/근거 merge | `...Persistence.java:640-653` |
| amendment 불변 근거 생성 | `cashflow_month_amendments/{hash-id}` | `...Persistence.java:654-675` |
| 월 확정 | `monthly_closes/{projectId}-{yearMonth}` 전체 close snapshot/status/hash/counters | `...Persistence.java:1255-1286` |
| immutable close version | `cashflow_month_close_versions/{projectId}-{yearMonth}-r{revision}` | `...Persistence.java:1287-1306` |
| 누적 결산 head | `cashflow_cumulative_close_heads/{projectId}` CLOSED horizon/rootHash/request 연결 | `...Persistence.java:1307-1325` |
| 월 확정 원본 반영 | 결산 입력으로 변경된 `cashflow_weeks` 문서를 replace | `...Persistence.java:1217-1224`, 실제 write `:2373-2385` |
| 재오픈 요청 | `monthly_closes`를 `REOPEN_REQUESTED`, revision+1, reopenRequest로 변경 | `...Persistence.java:1827-1865` |
| 누적 재오픈 요청 | cumulative head를 `REOPEN_REQUESTED`로 변경 | `...Persistence.java:1866-1876` |
| 재오픈 결정 | `monthly_closes`를 승인 시 OPEN/거절 시 CLOSED로 변경, reopenDecision 저장 | `...Persistence.java:1888-1973` |
| 누적 재오픈 결정 | cumulative head의 horizon/status/reopenDecision 변경 | `...Persistence.java:1974-1996` |
| 월 재오픈에 따른 주차 해제 | 대상 `cashflow_weekly_update_completions` LOCKED→OPEN | `...Persistence.java:1922-1958`, `:1998-2000` |
| close/reopen audit | `weekly_api_audit_events`에 close 상태/hash/request 연결 metadata 저장 | `WeeklyExpenseCommandService.java:1035-1042`, `:1451-1462`, `:1506-1517`, helper `:3740-3775`; write `...Persistence.java:4155-4173` |
| close/reopen 멱등 결과 | `weekly_api_idempotency`에 command/requestHash/response 저장 | `WeeklyExpenseCommandService.java:1043-1050`, `:1463-1470`, `:1518-1525`; write `...Persistence.java:3913-3928` |

월 확정은 command aspect가 persistence transaction wrapper를 호출하고(`WeeklyExpenseCommandTransactionAspect.java:14-23`), Firestore 구현이 같은 transaction을 thread-local로 공유하므로(`FirestoreInheritedWeeklyExpensePersistence.java:191-220`), close/version/head 및 시트 월 교체가 한 트랜잭션을 공유한다. 월 close의 persistence 진입은 `WeeklyExpenseCommandService.java:992-1034`다.

## 3. 계층 간 상호 문서 검증

| 읽는 계층 → 소유 문서 | 검증 내용 | 근거 |
|---|---|---|
| JVM → BFF request header | contractVersion, requestId, projectId, yearMonth, fromMonth, status=APPROVING, revision, manifestHash, approverUid, reviewIdempotencyKey 일치 | `...Persistence.java:3053-3075` |
| JVM → BFF month shards | 각 shard 존재/scope, 정확히 160 cells, cell 순서·state·정수/안전범위, shardHash 재계산 | `...Persistence.java:3094-3137`, `:3175-3221` |
| JVM → BFF manifest | 연속 월 수 및 canonical manifestHash 재계산 대조 | `...Persistence.java:3086-3092`, `:3138-3147` |
| JVM → BFF legacy approval | status=APPROVING, project/month, approverUid=reviewedByUid=JVM actor | `...Persistence.java:3295-3306` |
| BFF → JVM monthly close | close 결과 projectId/yearMonth/status=CLOSED/revision 증가 확인 | `jvm-weekly-api.mjs:2958-2972`, 결과 validator `:1458-1487` |
| BFF → JVM 결과 화해 | mutation 실패 후 month-close read로 idempotency/snapshot 증거를 확인, 증명 실패 시 reconciliation_pending | `jvm-weekly-api.mjs:2973-2982`, `:2986-3034` |
| BFF 자체 → BFF shards | shardHash와 160 cells 재계산, manifestHash 대조 | `jvm-weekly-api.mjs:3328-3350` |
| BFF → JVM reopen | JVM 응답의 projectId/yearMonth/status=OPEN 검증 후 BFF read-model 갱신 | `jvm-weekly-api.mjs:4291-4318` |

이 중 JVM의 header/shard/manifest 대조는 계층 분할 때문에 생긴 경계 검증이지만, shard·manifest 무결성 자체는 감사 근거이므로 소유권 통합 뒤에도 JVM 내부 검증으로 보존해야 한다.

## 4. 시간 결합 규칙 전수

| 규칙 | 현재 코드 확인 | 저장/재계산 성질 |
|---|---|---|
| business date | `Asia/Seoul`의 `LocalDate.now` | `...Persistence.java:3695-3697` |
| legacy 월 결산 기한 | 대상월 익월 10일 | `...Persistence.java:3788-3790` |
| cumulative 결산 기한 | settlement cycle 월의 10일(plusMonths 없음) | `...Persistence.java:3788-3790`; SPEC-04 표에 누락된 분기 |
| close 가능 시점 | closeThrough가 현재 business month보다 앞서야 함 | `...Persistence.java:1153-1160` |
| 확정 시 late 저장 | close 시 business date가 deadline 뒤인지 저장 | `...Persistence.java:1251-1270` |
| OPEN 응답의 late | 조회 시 현재 business date로 재계산; CLOSED는 저장 `late` 사용 | `...Persistence.java:3745-3775` |
| amendment 마감후 경고 | 익월 10일을 지나면 warning count +1 | `...Persistence.java:538-581`, `:590-599`, 저장 `:640-650` |
| 재무주차 시작/끝 | 월 1일/first Monday를 기준으로 5개 주차 산정 | `...Persistence.java:1745-1752` |
| 재무주차 마감 | 주차 안 첫 목요일의 다음날 00:00 KST; 목요일 없으면 end+1일 | `...Persistence.java:1753-1758` |
| 주간 준수 | completedAt이 시작 00:00 KST 이상, deadline 이하이면 ON_TIME, 아니면 COMPLETED_LATE | `...Persistence.java:1761-1767`; 저장 `:1681-1701` |
| 정산주차 확인 TTL | settled-week confirmation 10분 | `...Persistence.java:96`, 소비 검증 `:2228-2248` |
| edit lease 만료 | 저장 expiresAt이 현재 Instant보다 뒤이고 ACTIVE여야 함 | `...Persistence.java:262-280` |
| publication APPLYING 차단 | 현재 JVM은 시간 임대가 아니라 상태가 APPLYING이면 무조건 결산 거부 | `...Persistence.java:3792-3804` |

SPEC-04의 “applyStartedAt + 10분(`cashflow-apply-lease.mjs`)”은 현재 베이스에서 **미확인**이다. 해당 파일은 존재하지 않고, JVM publication guard에도 10분 판정이 없다. 이는 과거 PR 상태를 서술한 것으로 보이며 현재 코드 근거로 채택할 수 없다.

## 5. 확정 후 불변성 강제 지점 전수

| 불변식 | 강제 지점 |
|---|---|
| CLOSED/누적 CLOSED 월 일반 수정 차단 | 상태 조회 후 amendment 권한 없으면 `requireMutableMonthStatus` 호출 (`...Persistence.java:504-517`); 시트 교체 입구도 `requireCashflowMonthsOpen` (`:2205-2207`) |
| CLOSED 변경 사유 필수 | 닫힌 월이 하나라도 있고 reason이 비면 `cashflow_closed_month_reason_required` (`:538-571`) |
| snapshotHash 형식/존재 | `sha256:[a-f0-9]{64}` 아니면 변경 거부 (`:582-588`) |
| amendment 카운터/마감후 경고 | overflow-safe 증가 후 close와 amendment evidence에 저장 (`:590-599`, `:640-675`) |
| close snapshot hash chain | canonical snapshot SHA-256, previousSnapshotHash, immutable version 저장 (`:1251-1306`) |
| 누적 root/head 보존 | manifestHash를 snapshot rootHash와 cumulative head rootHash로 저장 (`:1244`, `:1307-1325`, snapshot fields `:3244-3269`) |
| 비정규 legacy 상태 차단 | canonical status가 아니면 migration_required 계열 (`:2860-2951`, 직접 변환 `:2969-2980`) |
| 재오픈은 상태/revision gate | CLOSED만 요청 가능, REOPEN_REQUESTED만 결정 가능, expectedRevision 일치 (`:1842-1852`, `:1904-1914`) |
| 최신 누적 horizon만 재오픈 | settlementMonth와 일치하지 않으면 거부 (`:1833-1841`, `:1894-1903`) |
| 요청 근거 변조 탐지 | BFF shard 기존값 byte-equivalent 비교 및 hash/manifest 검증 (`jvm-weekly-api.mjs:3246-3253`, `:3328-3350`); JVM 재검증은 §3 |

## 6. 승인 게이트 전수

| 게이트 | 강제 지점 | 판정 |
|---|---|---|
| 조직장 필수 | project.executiveApproverId 없으면 거부 | `jvm-weekly-api.mjs:322-333` |
| 요청자≠승인자 | canonical approver 조회 시 requesterUid와 비교 | `jvm-weekly-api.mjs:322-333` |
| 조직장 지정 시 자기승인 후보 차단 | actor/registeredById/managerId 중 누구와도 같은 approver 금지 | `jvm-weekly-api.mjs:3436-3437` |
| 활성 요청 중 조직장 변경 금지 | PENDING/APPROVING/UNCERTAIN 존재 시 locked | `jvm-weekly-api.mjs:3403-3443` |
| 요청 시 승인자/version 고정 | expectedApproverUid와 expectedProjectVersion 검증 | `jvm-weekly-api.mjs:3657-3673`, 트랜잭션 재검증 `:3748-3765` |
| 검토자는 현재 지정 승인자 | request approver와 canonical approver 모두 actor와 일치 | `jvm-weekly-api.mjs:3917-3927` |
| 승인/반려 1회성·낙관적 revision | 상태, revision, manifest, active reviewer를 트랜잭션에서 재검증 | `jvm-weekly-api.mjs:3976-4044`, `:4091-4110` |
| 반려 사유 필수 | REJECT이면 reason 필수, 최대 1,000자 | `jvm-weekly-api.mjs:3887-3900` |
| 재오픈 2단계 | JVM 별도 request/decision 엔드포인트 및 상태 전이 | `WeeklyExpenseController.java:681-714`, persistence `:1827-2001` |
| 재오픈 결정 역할 | BFF는 admin/finance만 허용 | `jvm-weekly-api.mjs:4281-4289` |
| 재오픈 요청자≠결정자 | **강제 지점 없음** | 요청 UID 저장 `...Persistence.java:1854-1858`, 결정 UID 저장 `:1960-1965`; 비교 코드 전수 검색 0건 |

## 7. `cashflow_month_close_*` 오류 코드와 사용자 행동

프로덕션 소스에서 컬렉션명 3개를 제외하면 **37개**가 확인된다. “계층 분할 전용”은 소유권 경계/저장소 구현/화해 때문에 생기는 코드만 그렇게 분류했다. 그 외는 사용자 행동 또는 감사·권한·입력 구분을 보존해야 한다.

| 코드 | 사용자가 해야 할 행동 | 분류/근거 |
|---|---|---|
| `approval_required` | 요청을 만들고 지정 승인자 승인 대기 | 사용자 필요; `jvm-weekly-api.mjs:4258-4266` |
| `approver_required` | 프로젝트 조직장 지정 | 사용자 필요; `:322-333` |
| `self_approval_forbidden` | 다른 조직장을 지정/다른 승인자가 처리 | 사용자 필요; `:329-330`, `:3436-3437` |
| `approver_expectation_required` | 화면 새로고침 후 확정 조직장/version과 재요청 | 사용자 필요; `:3657-3662` |
| `approver_invalid` | 유효한 조직장/월/version 입력 | 사용자 필요; `:3386-3396` |
| `approver_locked` | 대기 요청을 먼저 처리한 뒤 조직장 변경 | 사용자 필요; `:3439-3443` |
| `approver_mismatch` | 현재 지정 승인자로 로그인/담당자 확인 | 사용자 필요; `:3917-3927` |
| `approver_stale` | 최신 조직장 정보를 다시 확인해 재요청 | 사용자 필요; `:3158-3164`, `:3752-3759` |
| `member_inactive` | 활성 구성원 계정으로 전환/관리자 문의 | 사용자 필요; `:290-304` |
| `project_forbidden` | 프로젝트 권한 확인 | 사용자 필요; `:3165-3168`, `:3761-3765` |
| `request_forbidden` | 요청 당사자/승인자 권한 확인 | 사용자 필요; `:3508-3529` |
| `human_review_required` | 시트/결산 항목 직접 검토 후 재시도 | 사용자 필요; `:2071-2080` |
| `cells_incomplete` | 160개 셀을 모두 확인/보완 | 사용자 필요; `:2082-2091` |
| `confirmations_incomplete` | 160개 확인 상태 완료 | 사용자 필요; `:2144-2153` |
| `canonical_review_required` | 직접 close 대신 저장된 결재 요청 승인 | 사용자 필요; `:2704-2711` |
| `request_invalid` | yearMonth/scope/review 입력 수정 | 사용자 필요; `:2071-2077`, `:2502`, `:3503` |
| `review_invalid` | APPROVE/REJECT, revision, 반려 사유/길이 수정 | 사용자 필요; `:3887-3900` |
| `request_too_large` | 시트 범위/입력 크기 축소·확인 | 사용자 필요; `:281-287` |
| `request_not_found` | 목록 새로고침/올바른 요청 선택 | 사용자 필요; `:3905-3912` |
| `request_conflict` | 기존 요청 처리 또는 같은 멱등키에 같은 입력 사용 | 사용자 필요; `:3169-3212`, `:3685-3691` |
| `request_already_reviewed` | 최신 상태 새로고침; 이미 처리된 결과 확인 | 사용자 필요; `:3976-4044`, `:4077-4174` |
| `request_revision_stale` | 최신 승인 상태/요청 revision 재조회 | 사용자 필요; `:4080-4088`, `:4219-4231` |
| `revision_stale` | 최신 월결산 자료를 다시 검토 | 사용자 필요; `:2897-2902` |
| `status_review_unsupported` | 누적 계약에는 status-review, legacy에는 일반 review 사용 | 경계/계약 버전 호환 필요; `:3914-3915` |
| `request_building` | shard 저장 완료 후 재시도 | BFF 분할 저장 단계 전용; `:3554-3557` |
| `request_horizon_invalid` | 자동 복구 금지, 운영자/개발자 조사 | 감사/구문서 호환 필요; `:3217-3230` |
| `request_evidence_invalid` | 요청 근거 재생성 또는 운영자 조사 | 감사 필요; `:3035-3059`, `:3621` |
| `request_evidence_tampered` | 진행 중단, 운영자 감사/복구 | 감사 필수; `:3250-3253`, `:3328-3337`, `:3581` |
| `request_manifest_invalid` | 진행 중단, 근거 shard/manifest 감사 | 감사 필수; `:3341-3349`, `:3954-3957` |
| `contract_invalid` | 표준 누적 범위로 새로고침/재생성 | 구/신 계약 호환 필요; `cashflow-sheet-lab.mjs:1749-1777` |
| `migration_required` | 자동 수정 금지, 관리자 데이터 정비 | 구문서 불변성 필요; `...Persistence.java:2969-2980` |
| `reconciliation_pending` | 같은 멱등 요청으로 재시도/결과 확인 | **BFF↔JVM 분할 mutation 화해 전용**; `jvm-weekly-api.mjs:2973-2982` |
| `request_store_unavailable` | 잠시 후 재시도/장애 문의 | **BFF 직접 Firestore 저장소 전용**; `:3353-3355`, `:3380-3384` |
| `source_unavailable` | 잠시 후 재시도 | BFF source 조합 I/O; `:2077-2080` |
| `backend_unavailable` | 잠시 후 재시도/저장소 운영 확인 | JVM 저장 backend 필요; `WeeklyExpensePersistence.java:469-502` |
| `permission_backend_unavailable` | 재시도/권한 backend 운영 확인 | JVM 구현 계층 fallback; `WeeklyExpensePersistence.java:399-404` |
| `route_timeout` | 같은 요청으로 재시도 | BFF→JVM HTTP 시간예산 전용; `java-weekly-client.mjs:253-265` |

제거 후보로 근거가 확정된 것은 `reconciliation_pending`, `request_store_unavailable`, `route_timeout`처럼 소유권/HTTP 경계 자체에 묶인 코드다. 다만 SPEC-15 후에도 BFF→JVM 프록시가 남으므로 `route_timeout`은 즉시 제거할 수 있다고 단정할 수 없고, 새 엔드포인트 호출의 시간예산/멱등 동작 확인 전에는 유지해야 한다. `evidence_*`/`manifest_invalid`는 경계 검증에서 JVM 내부 검증으로 위치만 바뀌며 사용자 행동(감사 중단)은 유지된다.

## 8. 구 문서 스키마와 신 경로 필수 읽기 필드

### 8-1. BFF request header

누적 header 생성 필드는 `contractVersion`, `requestId`, `tenantId`, `projectId`, `yearMonth`, 선택적 `throughMonth`, `fromMonth`, `status`, `revision`, `manifestHash`, `monthCount`, `weekCount`, `cellCount`, `source`, `totals`, `annualSummaries`, `expectedRevision`, `approverUid`, `requestedByUid`, `requestedAt`, `createIdempotencyKey`, `requestFingerprint`, `payloadFingerprint`이다(`jvm-weekly-api.mjs:3255-3279`). 검토 과정에서 `reviewedByUid`, `reviewedAt`, `decisionReason`, `reviewIdempotencyKey`, 임시 `preparedCloseBody`/`reconciliationEvidence`, 최종 상태가 추가된다(`:3999-4002`, `:4046-4053`, `:4176-4212`).

legacy header는 위 공통 당사자/멱등 필드에 `requestPayload`, `reviewWarnings`, `monthSnapshot`, `requestManagementChecks`, `requestDeadlineSummary`를 저장한다(`jvm-weekly-api.mjs:3723-3738`, `:3800-3858`).

신 JVM 경로가 최소한 읽어야 할 공통 필드는 scope/상태/승인 검증용 `contractVersion`, `requestId`, `projectId`, `yearMonth`, `status`, `revision`, `approverUid`, `reviewedByUid`, `reviewIdempotencyKey`다(`...Persistence.java:3053-3075`, `:3295-3306`). 누적은 추가로 `fromMonth`, 선택적 `throughMonth`, `monthCount`, `manifestHash`를 읽는다(`:3076-3092`, `:3146-3149`). legacy close source는 `monthSnapshot.source`, `reviewWarnings`, `monthSnapshot` 전체를 읽는다(`:3036-3045`).

### 8-2. 누적 month shard

필드는 `contractVersion`, `requestId`, `requestRevision`, `projectId`, `yearMonth`, `cells`(정확히 160, canonical order/state/amount), `source`, `shardHash`다. BFF 생성은 `jvm-weekly-api.mjs:238-278`, JVM 필수 읽기/검증은 `...Persistence.java:3094-3137`, cell 계약은 `:3175-3221`이다.

### 8-3. JVM monthly close/head

구 JVM close 문서의 신 경로 보존 필드는 `contractVersion`, scope, `status`, `revision`, `reopenCount`, `snapshot`, `previousSnapshot`, `snapshotHash`, `previousSnapshotHash`, `latestVersionId`, 저장 `late`, close actor/time, amendment counters/last evidence, reopen request/decision이다(`...Persistence.java:1255-1285`). 누적 head는 `fromMonth`, `closedThrough`, `settlementMonth`, `rootHash`, `revision`, request/approval/operation 연결 필드를 가진다(`:1307-1324`). 데이터 마이그레이션 없이 이 필드를 그대로 읽어야 한다.

## 9. 되돌릴 수 없는 변경 후보

**있음 — 구현 중단 조건이다.**

1. 기존 CLOSED 문서/누적 head/shard의 데이터 마이그레이션 또는 저장 `late`, `closeDeadline` 의미 재계산: 과거 감사 결과를 소급 변경한다. 코드 근거는 CLOSED 응답이 저장 `late`를 사용하는 `...Persistence.java:3771-3775`, hash chain `:1251-1306`이다.
2. BFF 구 경로 삭제 전에 JVM이 legacy와 cumulative header/shard를 모두 읽는 동등성 증거가 없는 상태: 삭제 후 rollback 시 BFF 상태전이/화해 정보가 복구되지 않는다(임시 상태 필드 `jvm-weekly-api.mjs:4176-4253`).
3. 재오픈 승인 시 cumulative head horizon을 후퇴시키고 5개 주차 LOCK을 OPEN으로 바꾸는 동작은 다문서 의미 변경이다(`...Persistence.java:1922-2000`). 현재 persistence 메서드만 보면 이 전체가 단일 트랜잭션이라는 보장은 상위 wrapper에 의존하므로 endpoint 이관 시 wrapper 누락은 부분 상태를 만들 수 있다.

## 10. Freeze Unit 제안

한 PR에 엔드포인트 하나만 둔다. PR-A 단위는 아직 BFF가 호출하지 않아 배포 동작을 바꾸지 않고, 계약 테스트로 고정한다.

| Unit | 엔드포인트/관심사 | F-1~F-5 근거 |
|---|---|---|
| 15-A1 | 요청 생성 | F-1 미호출 신규 endpoint; F-2 endpoint/test만 revert; F-3 BFF header+shard 스키마 계약 §8; F-4 공개 DTO 고정; F-5 create 한 전이 |
| 15-A2 | 조직장 지정 | F-1 미호출; F-2 독립 revert; F-3 project version/lock/self-approval 계약 `jvm-weekly-api.mjs:3409-3490`; F-4 request create가 API만 의존; F-5 approver 지정만 |
| 15-A3 | 승인 | F-1 미호출; F-2 독립 revert; F-3 PENDING→APPROVING/APPROVED, hash/idempotency 계약; F-4 close 도메인 API만 호출; F-5 approve만 |
| 15-A4 | 반려 | F-1 미호출; F-2 독립 revert; F-3 PENDING→REJECTED와 사유 계약; F-4 승인과 상태 계약만 공유; F-5 reject만 |
| 15-A5 | UNCERTAIN 재개/화해 | F-1 기존 close 멱등 조회로 단독 검증; F-2 revert 시 기존 BFF 화해 유지; F-3 APPROVING/UNCERTAIN replay 계약; F-4 A3가 공개 결과만 소비; F-5 recovery만. PR #408 선행 조율 필수 |
| 15-A6 | 재오픈 요청 | F-1 기존 JVM 동작을 endpoint 계약으로 고정; F-2 독립 revert; F-3 CLOSED→REOPEN_REQUESTED; F-4 decision은 상태 계약만 의존; F-5 request만 |
| 15-A7 | 재오픈 결정 | F-1 기존 동작 고정; F-2 독립 revert; F-3 요청자≠결정자 결정 후 진행; F-4 reopen request 내부 수정 불필요; F-5 decision만. 단, §12 이의 해결 전 동결 불가 |
| 15-B1~B7 | BFF endpoint별 게이트 proxy 전환 | 각 A unit 이후 한 endpoint씩 on/off, 동일 Firestore 최종상태 계약으로 F-1/F-2 확보; 관심사별 분리 |
| 15-C1~C7 | BFF endpoint별 구 write 삭제 | 각 B unit 동등성 통과 후 한 endpoint씩 삭제; 호출 0 전수검색을 F-3/F-4 증거로 남김 |

## 11. PR #406/#408 충돌 범위

`gh pr view`와 `gh pr diff --patch`로 확인했다.

### PR #406 — MERGED (`fix/month-close-revision-diff`)

SPEC-15과 직접 겹치는 파일/함수:

- `server/bff/routes/jvm-weekly-api.mjs`: `buildCashflowMonthCloseRevisionChanges`, 누적 범위/manifest 조립, `prepareCashflowMonthClose`, 요청 조회/검토 라우트. diff hunks는 PR patch의 현행 기준 대략 `:132`, `:1340-1411`, `:2762-3122`, `:3347-3450`, `:4006-4138`에 걸친다.
- `server/jvm-weekly-api/.../FirestoreInheritedWeeklyExpensePersistence.java`: `closeCashflowMonth`, `requestCashflowMonthReopen`, `decideCashflowMonthReopen`, `requireCumulativeCloseApproval`, `ValidatedCumulativeClose`.
- 계약/UI 파급: `src/app/lib/platform-bff-client.ts`의 close/request/revision diff 타입과 fetch 함수, `CumulativeSettlementMonthDetails.tsx`, `MonthlySettlementApprovalSection.tsx`, `CashflowProjectSheet.tsx`.

#406은 이미 현재 베이스에 포함되어 있으므로 “먼저 merge” 문제는 해소됐지만, 위 함수가 SPEC-15 계약 baseline이다. 이관 중 제거/필드 축소 대상이 아니다.

### PR #408 — OPEN (`fix/month-close-uncertain-recovery`)

- `server/bff/routes/jvm-weekly-api.mjs`의 월결산 review handler, 특히 `UNCERTAIN` 요청을 `APPROVING`으로 되돌린 뒤 재화해하는 트랜잭션을 추가한다(PR patch hunk 원본 `:3884`).
- `server/bff/routes/jvm-weekly-api.test.mjs`의 UNCERTAIN 승인 재개 테스트(PR patch hunk 원본 `:4133`).

SPEC-15의 승인/UNCERTAIN 소유권 이전(15-A3/A5, 15-B3/B5, 15-C3/C5)과 동일 함수·상태 기계를 수정하므로 #408을 먼저 반영하거나 그 동작을 JVM 계약에 흡수한 뒤 BFF 삭제 순서를 정해야 한다.

## 12. 스펙 이의 (SPEC-02 §3)

### 12-1. transaction 수

```text
[스펙 이의] SPEC-15 §1-1, §2, §5-1
  스펙 주장: jvm-weekly-api.mjs의 월결산 Firestore transaction.set/트랜잭션은 11개다.
  실제 관찰: 현재 베이스에는 transaction.set 정적 호출 23곳, 월결산 runTransaction 블록 10곳이다.
  근거: server/bff/routes/jvm-weekly-api.mjs:3145-4323 및 §1 전수 목록.
  왜 위험한가: 11개만 삭제 완료 기준으로 삼으면 요청 shard/audit/settlement/read-model write가 남거나 필요한 write를 잘못 삭제한다.
  대안: endpoint×컬렉션 write matrix(§1)를 baseline으로 하고 최종 server/bff의 대상 컬렉션 write 0건을 검사한다.
```

### 12-2. 재오픈 요청자 자기승인

```text
[스펙 이의] SPEC-04 §4-2(1), §4-3 O-2
  스펙 주장: 재오픈은 요청→결정 2단계이며 요청자≠승인자가 현재/이관 후 유지되는 불변식이다.
  실제 관찰: JVM은 requestedByUid와 decidedByUid를 각각 저장하지만 서로 비교하지 않는다.
  근거: FirestoreInheritedWeeklyExpensePersistence.java:1827-1865, :1888-1973; controller는 actor를 그대로 전달한다(WeeklyExpenseController.java:681-714).
  왜 위험한가: admin/finance 사용자가 자기 재오픈 요청을 스스로 승인할 수 있어 감사용 two-person rule이 성립하지 않는다.
  대안: SPEC-15 착수 전에 도메인 게이트와 실제 호출 테스트를 별도 Freeze Unit으로 추가하고, 구/신 경로 동등성 기대값을 그 보호 규칙으로 확정한다.
```

### 12-3. apply lease 시간 규칙

```text
[스펙 이의] SPEC-04 §2-1
  스펙 주장: cashflow-apply-lease.mjs가 applyStartedAt+10분 임대를 판정한다.
  실제 관찰: 현재 베이스에 해당 파일이 없고 JVM guard는 APPLYING 상태를 시간 제한 없이 거부한다.
  근거: FirestoreInheritedWeeklyExpensePersistence.java:3792-3804; 저장소 전수 검색 결과 cashflow-apply-lease.mjs 없음.
  왜 위험한가: 존재하지 않는 임대를 보존했다고 가정하면 영구 APPLYING 문서가 결산을 계속 막을 수 있다.
  대안: #470/#469 이후 실제 publication 복구 계약을 별도 확인한 뒤 SPEC-04 표를 현재 코드에 맞게 갱신한다(본 조사에서는 미확인).
```

## 13. 조사 한계와 다음 검증

- 조직 승인 및 SPEC-13 완료 여부는 코드만으로 확인하지 못했다.
- PR #408은 OPEN 상태라 최종 merge 결과가 달라질 수 있다.
- 구현 시에는 실제 Firestore emulator에서 구 문서 fixture를 JVM 신 endpoint가 수정 없이 읽고, CLOSED 저장 필드 byte-equivalence, 자기 재오픈 승인 거부, shard 1바이트 변조 탐지를 검증해야 한다.
- 이 문서는 docs-only 조사이므로 브라우저 QA는 필요하지 않았다. 정적 전수검색, 현재 소스 line evidence, GitHub PR metadata/diff로 검증했다.
