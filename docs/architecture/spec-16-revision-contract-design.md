# SPEC-16 — Cashflow revision 계약 재설계

**작성:** 2026-08-07 · **상태:** 설계안 · **범위:** 코드 변경 없음

## 0. 결론

`targetRevision`은 현재 `projectId`에 속한 `cashflow_weeks` 전체의 재무 상태를 직렬화한 SHA-256 값이다. 월 반영 API가 한 달만 수정하더라도 비교 전·후 모두 프로젝트 전체 집합을 사용한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2231-2257`, `:2387-2405`). 따라서 읽기 범위만 월로 줄이는 것은 최적화가 아니라 revision의 의미 변경이다. SPEC-12 개정 A가 이 경로를 전체 스캔 예외로 남긴 이유도 같다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-12-amendment-a.md:9-38`).

권장안은 **범위 명시형 revision(envelope) + 월별 revision**이다. 새 값은 `{contractVersion, scope, digest}`로 해석하고, `scope=PROJECT`인 v1과 `scope=MONTH:<yyyy-mm>`인 v2를 값만 보고 구분한다. Merkle tree와 프로젝트 상위 집계는 당장 필요한 월 단위 낙관적 동시성 제어에 필요하지 않으므로 도입하지 않는다.

> 줄 번호 주의: 과제에 적힌 `:1460/:2048/:2192/:2405`는 현재 워크트리와 어긋난다. 현재 직접 호출부는 `:1634`, `:2255`, `:2399`, `:2605`이며 정의는 `:2609`다. 아래는 현재 워크트리의 줄 번호를 기준으로 전수 조사했다.

## 1. 현재 계약 전수

### 1-1. 해시의 입력과 의미

JVM 구현은 각 문서에서 `yearMonth`, `weekNo`, `projection`, `actual`, `weeklyExpenseActualBySheet`, `adminClosed`만 정규화하고, 월·주차 순으로 정렬한 뒤 `{"weeks": [...]}`를 SHA-256으로 해시한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2609-2630`). BFF도 같은 필드를 뽑아 월·주차 순으로 정렬한다 (`server/bff/cashflow-sheet-snapshot.mjs:69-81`). 문서 ID, 메타데이터, 수정 시각은 계약에 포함되지 않는다.

### 1-2. JVM 호출부

| 현재 위치 | 넘기는 집합 | 검증/생성하는 것 |
|---|---|---|
| `FirestoreInheritedWeeklyExpensePersistence.java:1634` | 주간 완료 처리에서 이미 읽은 `projectWeeks.values()` 전체 | 주간 LOCKED 스냅샷에 당시 프로젝트 전체 target 상태를 고정한다. 같은 값이 스냅샷과 완료 문서의 `targetRevision`에 저장된다 (`:1623-1654`, `:1659-1672`). 이 호출 자체는 비교가 아니라 감사 스냅샷 생성이다. |
| `:2255` | `projectId` 전체 쿼리 결과에 대상 월 문서를 합친 `allProjectWeeks.values()` (`:2231-2255`) | 요청의 `targetRevision`과 현재 프로젝트 전체 revision을 비교하고 다르면 apply를 409 conflict로 거부한다 (`:2255-2257`). 핵심 낙관적 동시성 게이트다. |
| `:2399` | 전체 기존 집합에 이번 replacements를 덮은 `resultingWeeks.values()` (`:2387-2399`) | 성공 후 다음 작업이 이어받을 프로젝트 전체 revision을 만든다. mirror가 입력 revision을 추적 중이면 `targetRevisionAtFetch`도 새 값으로 전진시킨다 (`:2400-2405`). |
| `:2605` | `cashflowLedgerSource`가 전달받은 쿼리 snapshot의 모든 유효 문서 (`:2556-2569`, `:2601-2605`) | 조회 결과의 `targetRevision`을 생성한다. 무범위 overload는 프로젝트 전체를 쿼리한다 (`:2532-2535`); 범위 overload는 `fromMonth..throughMonth`만 쿼리한다 (`:2538-2553`). 즉 이 호출은 **호출자가 선택한 범위**의 revision이며, 범위 정보가 값에 인코딩되지 않는 잠재적 모호성이 있다. |

과제의 네 위치를 의미상 대응시키면 “주간 완료 스냅샷 생성 / apply 전 비교 / apply 후 체이닝 / ledger 조회 결과 생성”이다. `countCashflowActualReplacementWrites`의 전체 쿼리는 revision을 직접 계산하지 않지만, 전체 actual source 제거 대상 수를 계산한다 (`:2033-2053`).

## 2. 저장 위치 전수

여기서 `sourceRevision`은 Google Sheet 고정본의 내용 revision이고, target 계열은 canonical `cashflow_weeks` revision이다. 이름이 비슷하지만 충돌 영역이 다르다 (`cashflow-sheet-snapshot.mjs:599-616`).

| 문서/컬렉션 | 저장 필드 | 근거 |
|---|---|---|
| `orgs/{tenant}/cashflow_sheet_mirrors/{project}` | `sourceRevision`, `targetRevisionAtFetch`, 이후 `appliedSourceRevision`, `appliedTargetRevision` | mirror 경로 `cashflow-sheet-lab.mjs:390-391`; refresh 결과가 mirror 전체로 설치됨 `:1349-1359`; snapshot 생성값 `cashflow-sheet-snapshot.mjs:599-616`; apply 완료 patch `cashflow-sheet-lab.mjs:3669-3687`. |
| `cashflow_sheet_snapshots/{snapshotId}` | `sourceRevision`, `targetRevisionAtFetch` | `cashflow-sheet-lab.mjs:1371-1395`. |
| `cashflow_sheet_snapshot_months/{snapshotId_month}` | `sourceRevision` | `:1396-1408`. |
| `cashflow_sheet_snapshot_years/{snapshotId_year}` | `sourceRevision` | `:1410-1424`. |
| `cashflow_sheet_stage_runs/{runId}` | `sourceRevision`, `targetRevisionAtFetch`; apply 뒤 `applyResponse.targetRevisionAtStart/resultingTargetRevision`와 operation checkpoint의 `resultingTargetRevision` | run 경로 `:3766-3768`; stage 문서 입력 `:3903-3942`; apply response `:3610-3665`; checkpoint 체이닝 `:3228-3315`. |
| `cashflow_sheet_stage_months/{runId_month}` | `sourceRevision`, `targetRevisionAtFetch` | `:1693-1705`. |
| `cashflow_sheet_stage_years/{runId_year}` | `sourceRevision`, `targetRevisionAtFetch` | `:1708-1720`. |
| `cashflow_sheet_publications/{project}` | APPLYING 중 `sourceRevision`, `targetRevisionAtFetch`; APPLIED 후 `sourceRevision`, `appliedTargetRevision` | `:2312-2320`, `:3706-3714`. |
| 주간 완료 문서 및 그 `snapshot` | `sourceRevision`, `targetRevision` | `FirestoreInheritedWeeklyExpensePersistence.java:1634-1654`, `:1659-1672`. |
| `cashflow_month_close_versions/{versionId}` | `sourceRevision`, `targetRevision`, `contractVersion` | `:1287-1306`. |
| 월 결산 snapshot | `sourceFingerprint`(source revision), `targetRevision` | `:3665-3692`. |
| `cashflow_month_amendments/{id}` 및 monthly close의 `lastAmendmentEvidence` | `sourceRevision`, `targetRevision`, `resultingTargetRevision` | `:627-675`. |
| `cashflow_pending_approval_change_warnings/{id}` | `sourceRevision`, `targetRevision`, `resultingTargetRevision` | `:679-719`. |

또한 stage run의 `applyOperations`와 `applyResponse`, JVM 작업 상태/audit 문서에도 동일 값이 중첩 저장된다. BFF가 상태 응답의 `sourceRevision`, `expectedTargetRevision`, `resultingTargetRevision`을 읽어 재조정한다 (`cashflow-sheet-lab.mjs:2624-2653`); JVM 서비스가 결과 metadata에 source/target revision을 기록한다 (`WeeklyExpenseCommandService.java:370-394`, `:1818-1819`). 컬렉션 경로를 이 조사 범위에서 확정하지 못한 서비스 내부 metadata 저장소는 **미확인**으로 남긴다.

## 3. 비교·검증 지점 전수

### BFF

1. stage 요청의 `expectedMirrorRevision`과 mirror `sourceRevision` 비교 (`cashflow-sheet-lab.mjs:3768-3774`).
2. stage 시작 시 현재 전체 cashflow revision과 mirror `targetRevisionAtFetch` 비교 (`:3820-3824`).
3. READY→APPLYING 예약 시 mirror와 stage run의 config/source/target revision 일치 검사 (`:2292-2304`).
4. stage month/year와 stage run의 source/target revision 일치 검사 (`:3017-3025`, `:3053-3061`).
5. apply 직전 canonical snapshot과 stage run target revision 재검사 (`:3089-3115`).
6. 각 JVM 응답의 source/입력 target revision 및 결과 revision 형식 검증 (`:2748-2804`, 월 호출 `:3274-3288`, batch 검증 `:3380-3405`).
7. operation status를 통한 재조정에서 expected 값과 observed 값을 비교 (`:2624-2653`).
8. 연속 월/배치 apply마다 직전 `resultingTargetRevision`을 다음 입력으로 체이닝 (`:3200`, `:3228`, `:3315`, `:3323`, `:3439`).
9. 완료 transaction에서 run/publication 소유 상태를 검사하고, 완료 후 publication과 mirror에 applied revision을 기록 (`:3690-3714`).
10. NO_CHANGES 완료 transaction에서 mirror source/target 및 transaction 안에서 다시 계산한 전체 target revision을 모두 비교 (`:3972-4006`).
11. JVM readback snapshot의 `targetRevision`과 기대 결과 revision 비교 (`:1033-1039`).

### JVM

1. API DTO는 source/target revision을 SHA-256 형식으로 제한한다 (`CashflowSheetBatchApplyRequest.java:19-20`; 월 요청도 같은 패턴은 별도 DTO에서 확인 필요 — **미확인**).
2. apply transaction은 전체 현재 revision과 요청 `targetRevision`을 비교한다 (`FirestoreInheritedWeeklyExpensePersistence.java:2231-2257`).
3. mirror가 같은 입력 revision을 추적했을 때만 성공 결과로 `targetRevisionAtFetch`를 갱신한다 (`:2259-2265`, `:2399-2405`). 이는 오래된 mirror를 새 결과로 잘못 전진시키지 않는 compare-before-write다.
4. 결산/amendment는 revision을 감사 근거로 저장하며 CLOSED snapshot hash가 없으면 거부한다 (`:584-588`, `:627-675`, `:1287-1306`). revision 자체의 동일성보다 확정 스냅샷의 불변성을 검증하는 경로다.

## 4. 대안 설계

### A. 월별 revision + 프로젝트 상위 집계

- 계약: `monthRevision[yyyy-mm] = H(그 달 5주)`; 별도 `projectRevision = H(sorted(month, monthRevision))`.
- 장점: 월 apply는 5개 문서만 읽고 같은 월 쓰기만 충돌시킨다. 프로젝트 전체 상태가 필요한 조회·감사에는 상위 집계를 유지할 수 있다.
- 단점: 상위 집계를 transactional하게 갱신하는 별도 문서와 dual-write가 필요하다. 누락/불일치 복구 규칙이 새로 생긴다.
- 마이그레이션: 기존 문서 rewrite는 불필요하지만 새 집계 문서를 초기화해야 한다. CLOSED 월을 읽어 집계를 backfill하면 저장된 결산을 수정하지는 않더라도 소급 계산 결과를 새 authoritative 값으로 삼는 위험이 있다.
- CLOSED 호환성: 기존 CLOSED 문서의 v1 값을 그대로 보존하고 새 open apply에만 v2를 쓰면 가능. 과거 v1을 월 revision으로 변환할 수는 없다.

### B. 계층적/Merkle revision

- 계약: week leaf → month node → project root. 변경 월의 경로만 다시 계산한다.
- 장점: 범위 증명과 프로젝트 root를 동시에 제공하며 큰 프로젝트에서도 갱신 비용이 로그/상수 수준이다.
- 단점: 노드 저장, 원자 갱신, 누락 노드 복구, tree versioning이 필요하다. 현재 최대 540주라는 규모에 비해 운영 복잡도가 크다.
- 마이그레이션: tree bootstrap이 필요하다. 기존 v1 root와 새 Merkle root는 같은 SHA-256 문자열이어도 의미가 달라 직접 비교할 수 없다.
- CLOSED 호환성: contractVersion으로 구분하면 읽기 호환은 가능하지만, 과거 CLOSED 값을 Merkle root로 재해석하거나 교체하면 SPEC-04 위반이다 (`spec-04-temporal-immutability.md:101-118`, `:168-178`).

### C. 범위 명시형 revision + 월별 digest (권장)

- 계약: 저장/전송 시 `{contractVersion: 2, scope: "MONTH:2026-07", digest: "sha256:..."}`. 기존 bare `sha256:`는 암묵적으로 `{contractVersion:1, scope:"PROJECT"}`로만 해석한다.
- 장점: 서로 다른 범위의 digest를 우연히 비교하는 현재 모호성을 제거한다. 새 집계 문서나 tree 없이 대상 월 5개 문서만 읽으면 된다. BFF/JVM 공통 인터페이스의 입력·출력 필드가 의미를 드러낸다(SPEC-01의 계층 간 API 일치 요구 `spec-01-layering.md:179-205`).
- 단점: multi-month batch는 월별 revision map을 받아야 하며 요청/응답 스키마가 바뀐다. 프로젝트 전체 동시성(다른 월 변경도 현재 apply를 막는 성질)은 의도적으로 사라진다.
- 마이그레이션: 데이터 rewrite 없이 dual-read/new-write가 가능하다. v1 진행 작업은 끝까지 v1 전체 스캔 경로를 사용하고, v2로 stage한 새 작업만 월별 경로를 사용한다.
- CLOSED 호환성: 기존 v1 값은 바이트 그대로 둔다. CLOSED 결산/amendment는 생성 당시 contractVersion으로 검증하며 v2 digest를 소급 생성하지 않는다.

## 5. 불변성·전환·동시성

SPEC-04는 CLOSED 월의 저장 판정값과 snapshot을 소급 재계산하지 말고, 구 경로 문서를 수정 없이 읽으라고 요구한다 (`spec-04-temporal-immutability.md:101-118`, `:168-178`). 현재 close version에 이미 `contractVersion`이 있다 (`FirestoreInheritedWeeklyExpensePersistence.java:1287-1306`). 따라서 다음 gate가 가능하다.

- contractVersion 부재 또는 v1: bare digest는 PROJECT scope. 기존 전체 스캔·비교·체이닝을 유지한다.
- v2: revision envelope의 scope가 요청 월과 정확히 같아야 한다. 다른 scope끼리는 digest가 같아도 비교 금지다.
- CLOSED 문서: 저장 당시 version과 revision 문자열을 그대로 사용한다. reopen/amendment도 과거 값을 덮지 않고 새 evidence에 새 계약 값을 별도 기록한다.
- dual-write 금지: 같은 필드에 v1과 v2 중 어느 의미인지 불명확한 bare hash를 쓰지 않는다. `contractVersion`과 `scope`가 없는 v2 write는 거부한다.

전환 중 가장 위험한 경우는 v1 stage가 살아 있는 동안 일부 apply가 v2 월 revision만 갱신하는 것이다. v1 stage의 전체 revision은 당연히 달라져 conflict가 나며, 반대로 v2가 v1 결과를 월 digest로 비교하면 의미가 달라 잘못 통과/거부할 수 있다. 규칙은 **한 run은 시작 시 고정한 contractVersion으로 끝까지 수행**하고, v1 run이 존재하는 동안 v2 writer를 활성화하지 않는 것이다. 활성화 시점에는 새 stage만 v2로 만들고, 기존 READY/APPLYING run은 v1로 drain하거나 명시적으로 만료시킨다. 결산도 시작 요청의 contractVersion을 close version까지 전달해야 한다.

## 6. Freeze Unit 제안

SPEC-03의 F-1은 단독 배포, F-2는 단독 revert를 요구한다 (`/private/tmp/myscube-spec-docs/docs/architecture/spec-03-freeze-units.md:20-32`).

| Unit | 내용 | 단독 배포/되돌리기 |
|---|---|---|
| 16-A | revision envelope 순수 도메인 타입·직렬화·범위 일치 검사 추가. 읽기는 v1만 사용. | 가능. 경로 동작 변화 없음. revert 가능. |
| 16-B | BFF/JVM dual-read: v1 bare digest와 v2 envelope를 읽되 write는 계속 v1. contractVersion 교차 계약 테스트 추가. | 가능. revert해도 저장값이 모두 v1이라 안전. |
| 16-C | stage/operation/status 문서에 contractVersion+scope를 v1 값과 함께 명시. 새 stage의 v2 생성은 feature gate OFF. | 가능. 구 reader가 추가 필드를 무시하는 증거가 선행되어야 한다. revert 시 v2 문서가 아직 없어야 한다. |
| 16-D | 신규 stage만 v2 MONTH revision을 발행하고, v2 apply가 대상 월 5문서를 읽어 비교·갱신. 기존 v1 run은 전체 스캔 경로로 drain. | 조건부 가능. gate OFF로 단독 revert 가능하며, 활성화 전 v1/v2 동시성 통합 테스트가 필요하다. |
| 16-E | v1 stage 생성 중단 후 관측 기간을 거쳐 전체 스캔 예외 제거 검토. | 배포 가능하지만 즉시 revert하려면 v1 reader/write 경로를 유지해야 한다. 삭제는 별도 irreversible 후보로 취급한다. |

## 7. 되돌릴 수 없는 변경 후보

**있음 — 아래는 별도 승인 전 실행 금지다.**

1. 기존 CLOSED 문서의 revision을 v2로 덮어쓰기 또는 월 digest로 소급 채우기. 감사 근거를 바꾸므로 SPEC-04가 금지한다.
2. v2 문서가 생성된 뒤 v1 reader/validator를 삭제하는 것. 구 문서와 진행 run을 더는 처리할 수 없어 단순 revert가 불가능하다.
3. 프로젝트 상위 집계/Merkle root를 authoritative로 bootstrap한 뒤 기존 v1 hash를 폐기하는 것. bootstrap 시점의 누락·동시 변경을 되돌려 판별할 근거가 없다.

## 8. 권장안과 비권장 이유

**C를 권장한다.** 직접 문제는 “월 apply가 전체 프로젝트 revision을 요구한다”와 “hash에 범위가 드러나지 않는다” 두 가지다. 범위 명시형 월 digest는 새 저장 인프라 없이 둘 다 해결하며, 기존 v1을 PROJECT scope로 명확히 보존할 수 있다. contractVersion gate는 이미 close version에서 쓰는 메커니즘을 재사용한다 (`FirestoreInheritedWeeklyExpensePersistence.java:1287-1306`).

A는 프로젝트 전체 root가 실제 소비자 요구로 확인될 때만 추가한다. 지금 도입하면 집계 문서 dual-write와 복구 규칙이 늘어난다. B는 범위 증명·부분 동기화 요구가 생길 때 검토한다; 현재 5주짜리 월 단위에 Merkle 운영 모델은 과하다. 어떤 안도 기존 CLOSED revision을 변환하지 않으며, 확인되지 않은 “동일 digest 호환”을 가정하지 않는다.

## 9. 검증 기준

문서 설계 단계이므로 브라우저 QA는 필요하지 않다. 구현 시에는 다음 증거가 stage gate다.

1. v1 fixture가 기존 전체 revision과 바이트 단위 동일하며 기존 READY/APPLYING run을 끝까지 처리한다.
2. 서로 다른 월 변경은 v2 월 apply를 막지 않고, 같은 월 변경은 반드시 conflict를 만든다.
3. scope 또는 contractVersion이 다르면 digest 문자열이 우연히 같아도 비교가 거부된다.
4. CLOSED fixture의 모든 기존 필드가 전환 전후 동일하고, v2 값을 소급 write하지 않는다.
5. v1 run 진행 중 v2 활성화가 차단되고, drain 후에만 gate가 열린다.
6. 월 apply의 `cashflow_weeks` read가 5개 이하임을 Firestore emulator에서 숫자로 단언한다.

