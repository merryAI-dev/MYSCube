# 프로젝트 저장 오류: 필드·정책 정합 및 영향 분석

상태: 개발 승인 후 구현·로컬 검증·독립 QA 통과. 운영 초안·첨부·canonical 데이터 변경 없음. 운영 배포 전.

## 확인한 장애와 근거

- JLIN IBS 수정 초안: 연도별 입금 예정월은 입력되어 있으나 상위 `paymentExpectedMonths`는 공란. 현재 BFF 검증에 실제 초안을 전달하면 `project_registration_invalid: paymentExpectedMonths.contract is required` 재현.
- 2026 D-TIPS 수정 초안: 계약 시작 2026-05-14, 참여인력 투입 시작 2026-04. 현재 BFF 검증에서 `teamMembersDetailed.0.monthlyRates is outside the project contract period` 재현.
- 두 사례의 신규 첨부는 Storage 조회 성공 및 크기·종류·attachmentId 일치. 첨부 재업로드로 해결할 문제가 아님.
- 수정 화면 저장 응답의 `setRecord`가 저장 callback을 교체하고 위저드의 1초 자동저장 타이머를 다시 예약하는 경로 확인. D-TIPS 초안 revision이 49초 동안 615→629 증가한 운영 관측은 이 경로와 부합하지만 개별 임시저장 오류와의 인과까지 입증하지는 않음.
- 앞선 조사에서 관련 4개 파일 152개 테스트 통과. 실제 브라우저 저장 성공이나 JVM 교차서비스 통과를 의미하지 않음.

## 필드와 정책의 기준

| 업무 의미 | 입력·저장 필드 | 적용할 정책 |
| --- | --- | --- |
| 단년도 입금 계획 | `paymentPlan`, `paymentExpectedMonths`, `advanceInterimBelow70Reason` | 화면에서 사용하는 상위 필드를 검증 |
| 다년도 입금 계획 | `financialYears[].paymentPlan`, `.paymentExpectedMonths`, `.advanceInterimBelow70Reason` | 연도별 필드를 검증. 사용하지 않는 상위 예정월·사유를 추가 요구하거나 가짜 값으로 채우지 않음 |
| 계약 기간 | `contractStart`, `contractEnd`, `contractEndUndecided` | 계약의 사실을 유지. 참여율 시트에 맞추려고 계약 날짜를 변경하지 않음 |
| 인력 참여 기간 | `teamMembersDetailed[].laborAllocationStartMonth`, `.laborAllocationEndMonth`, `.monthlyRates` | 계약기간 불일치는 경고. 실제 투입기간 밖 값, 기간 역전, 잘못된 참여율, 같은 사람·월의 중복 값은 계속 거부 |
| 참여율 상태 | 월 키 없음·`null`, `0`, 양수 | 미입력과 확인된 미참여를 구분. 월을 이동·자동 삭제·0으로 보정하지 않음 |
| People 연결 | `personId` 및 연결 대기 상태 | People 미등록 자체는 경고/연결 대기. 업무 담당자·최종 결재자의 계정 요건과 분리 |
| 임시저장 | 초안 payload, 단계, draft revision | 작성 중 상태 보존. 최종 제출 필수값 검사와 직렬화·소유권·세션 검사를 구분 |

기간 정책의 근거는 [참여율 시트 양식 계약](../architecture/contracts/2026-08-21-participation-sheet-format-contract.md)의 2026-08-25 개정이다. 기간 불일치를 새로 차단하겠다는 초기 계획은 폐기한다. 다년도 입금 필드는 현행 위저드의 입력·검증 분기를 기준으로 서버 계약을 명문화한다.

## 전체 데이터 경로와 변경 범위

1. **공통 편집 UI:** `ProjectEditorWizard.tsx`는 포털 등록·수정과 관리자 `ProjectWizard.tsx`가 공유한다. 필드 검증·자동저장·최종 제출·로컬 복원 변경은 세 화면에서 확인한다. 관리자 래퍼의 제출 Promise 전달도 점검하여 성공/실패 완료 시점이 실제 저장과 일치하도록 한다.
2. **포털 draft 클라이언트:** `PortalProjectRegister.tsx`, `PortalProjectEdit.tsx` → draft client → platform API. revision·lease fence·직렬 mutation queue를 유지하며 입력 없는 재저장만 제거한다. 첨부와 단계 변경도 저장 상태 비교에 포함한다.
3. **BFF 임시저장:** `project-registration-drafts.mjs`, `project-info-drafts.mjs`. payload 저장과 최종 제출 검증을 구분한다. 등록 임시저장의 필수첨부 차단은 프런트와 서버 양쪽에 있으므로 함께 검토·분리한다. 첨부 형식·경로·실제 저장 검증은 유지한다.
4. **BFF 업무 검증:** `projects.mjs`의 등록 canonical 생성, 수정 제출, 관리자 `/projects` 저장, 승인 patch, `syncProjectParticipationEntries`까지 동일 정책 적용이 필요하다. 최종 제출 한 곳만 수정하면 승인 또는 워커에서 다시 실패한다. `normalizeProjectTeamMemberMonthlyRates`는 계약 종료월을 유효 참여 종료월에 섞기도 하므로 단순 오류 분기 삭제만으로는 충분하지 않다.
5. **시트 미리보기:** `participation-sheet-ingest.mjs`, `routes/participation-dashboard.mjs`, `project-team-members.ts`. 현재 미리보기는 계약기간 불일치를 이미 경고로 허용한다. 해당 정책과 사람별 투입기간 검증을 제출 경로와 맞추고 기존 초안에도 경고를 복원한다.
6. **등록 제출:** 트랜잭션에서 프로젝트·등록 요청·제출된 초안·리스·outbox와 등록자 member의 프로젝트 배정을 기록. 후속 outbox가 첨부 이관, Drive 준비, `partEntries` 동기화 및 알림을 처리한다. 제출 성공 후 워커 실패/재시도에서도 중복·누락이 없어야 한다. 관리자 저장의 담당자 member 배정 경로도 함께 확인한다.
7. **수정 제출:** `project_requests/change-{projectId}`를 동기적으로 생성하며 canonical 프로젝트는 승인 때 반영한다. 제출 직후 검토함에 보이고 승인 전 프로젝트·참여율 원장이 변하지 않아야 한다. 수정 outbox는 Drive 보관 경로이며 canonical 반영 주체가 아니다.
8. **승인 및 참여율 원장:** 승인 트랜잭션은 canonical 프로젝트와 요청을 갱신하고 `partEntries`를 동기화한다. 동기화는 기존 `PROJECT_TEAM_SYNC` 행을 교체·삭제하므로 사람+투입시작월 기반 키 및 월별 값 보존을 확인한다. 기간 자동 절단은 키 변경과 과거 행 삭제까지 유발할 수 있다.
9. **화면 소비:** 프로젝트 상세, 검토함/변경 비교, 관리자·포털 store, 참여율 대시보드가 저장 필드를 읽는다. 시트 반영 성공부터 승인 후 월별 참여율까지 같은 사실을 보여야 한다. 캐시플로 시트 비교는 `financialYears`의 연도·금액을 소비하므로 필드 구조와 합계 계약을 유지한다.
10. **오류 관측:** BFF는 `error`, `message`, `requestId`, 선택적 `details`를 반환한다. API 오류 객체는 상세를 갖지만 최종 저장 UI와 수집 로그에는 원인이 빠진다. 검증 issue에 필드/연도/행/월을 식별할 정보를 두고 한국어 표시와 최소 진단 코드로 연결한다. 원문 payload·첨부 URL 전체를 로그에 넣지 않는다.

## JVM 경계

`FirestoreInheritedWeeklyExpensePersistence.java` 조사 결과:

- 프로젝트 등록·수정 draft 제출을 처리하지 않는다. 계약·인력 기간 validator를 JVM에 새로 복제할 이유가 없다.
- canonical `projects`와 `members`로 캐시플로 접근 및 결재자를 확인한다. 월마감 준비 데이터의 `expectedProjectVersion`·결재자가 현재 프로젝트와 일치하는지도 검사한다(약 1132–1141행). 프로젝트 승인과 월마감이 겹치는 충돌/재준비를 회귀 검증한다.
- `editLeases`를 공유하지만 JVM은 cashflow 리소스를 검사한다. 프로젝트 자동저장 수정을 공통 리스 수명·fence 변경으로 확대하지 않는다.
- JVM 감사는 `weekly_api_audit_events`, BFF 프로젝트 감사는 조직의 `audit_chain/head`를 사용한다. 불필요한 저장은 BFF 공통 감사 경합을 키울 수 있으나 JVM 감사가 같은 head를 쓰는 것은 아니다.
- 월마감 `snapshot.project`는 상위 `paymentExpectedMonths`만 복사하며 `financialYears`는 포함하지 않는다(약 7189–7201행). 이는 기존 감사 스냅샷의 표현 범위 한계다. 이번 저장 검증 수정에 JVM 변경이 필수는 아니지만, 연도별 계획까지 월마감 근거로 보존하려면 별도 스냅샷 계약·버전·hash 호환성 검토가 필요하다. 과거 스냅샷은 재작성하지 않는다.

## 구현 순서와 QA 게이트

1. **계약 고정:** 위 필드별 소유권과 경고/차단 구분을 회귀 fixture로 작성한다. 실제 운영 데이터는 비식별화하고 쓰지 않는다. 계약기간 불일치를 거부하도록 작성된 기존 tests도 정책과 대조해 갱신한다.
2. **BFF 정합:** 다년도 예정월 및 70% 사유를 연도별로 검증. 참여율 미리보기·등록·수정·승인·관리자 저장·원장 동기화에 같은 의미 적용. 실제 누락과 투입기간 자체의 오류는 계속 실패해야 한다.
3. **UI 저장 수명주기:** stable callback, 마지막 성공 snapshot과 변경 비교, 직렬 저장, 제출 시작 시 예약된 자동저장 처리, 응답 유실 후 재조회/충돌 복구를 검증한다. 늦은 응답은 새 입력을 덮어쓰지 않아야 한다. 동일 입력 재시도와 같은 요청의 네트워크 재전송을 구분한다.
4. **사용자 검증:** 임시저장 → 새로고침 → 최종 제출 → 검토함 → 승인 → canonical/참여율 재조회. 직전 저장 완료와 대기열 소진 후 입력 없이 30초 대기 시 PATCH·revision·감사 로그 추가 0건. 관리자·포털 모두 확인한다.
5. **교차서비스 회귀:** 다년도 승인 후 캐시플로 조회·저장·월마감, 프로젝트 버전/결재자 변경 중 월마감 충돌과 재준비, cashflow 리스 분리, 월별 값/미입력 보존, outbox 재시도 검증.
6. **배포:** 단위 테스트·BFF emulator 통합·빌드와 관련 JVM 회귀를 통과시킨다. 예상 스키마 변경·Firestore 인덱스·Rules·권한 추가는 없다. 최종 diff로 배포 분류를 확인하고 main CI 성공 후 자동 배포를 추적한다. JVM 소스 변경이 없으면 임의 강제 롤아웃하지 않는다.

## 완료 판정 및 남은 확인

- JLIN IBS는 상위 예정월을 채우지 않고 연도별 필드로 제출·승인된다.
- D-TIPS는 계약기간 불일치를 경고하면서 4월 데이터를 보존하고 제출·승인·참여율 반영까지 완료된다.
- 필수입력 누락, 투입기간 밖 값, 중복 월, 세션/권한/버전 충돌은 구체적인 원인과 함께 처리된다.
- 임시저장 반복 제거는 요청 횟수와 persisted revision으로 증명한다. 현재 운영 revision 증가 관측만으로 사용자 무입력 상태나 모든 저장 실패의 원인을 확정하지 않는다.
- 운영 데이터의 제출·승인을 대신 실행하지 않는다. 아래 검증은 로컬 브라우저 mock API, Firestore emulator 및 JVM 단위 회귀에 한정된다. 운영 배포 후 실제 사용자 저장 성공 여부는 별도 확인한다.


## 구현 결과와 보존 장치

- UI/BFF가 `project-input-policy.mjs`의 같은 단년도·다년도 입금 정책을 사용한다. 미입력 오류는 연도와 필드를 포함한다.
- 계약기간 밖 참여율은 경고로 유지하며 등록·수정 제출·승인·참여율 원장 정규화에서 월을 절단하지 않는다. 실제 투입기간 밖 값과 중복 검사는 유지한다.
- 최종 필수 첨부가 없어도 등록 초안을 저장할 수 있다. 최종 제출의 필수 첨부와 소유권·Storage 검증은 유지한다.
- 저장 ACK가 초기 draft를 교체하지 않게 하고 마지막 성공 입력·단계와 비교한다. 저장 요청은 직렬화하며 늦은 A 응답이 최신 B 입력이나 복구용 백업을 저장 완료로 표시하지 않는다.
- 입력은 원격 저장 전에 기존 키의 로컬 백업으로 보관한다. 저장 확인 표시는 같은 fingerprint에만 기록한다. 미확인 백업은 명시적 복원·삭제 전 자동저장으로 덮지 않는다. 복원 시 첨부 참조는 서버의 현재 참조를 유지한다.
- 최종 제출 전 최신 임시저장을 기다린다. 제출 중 입력과 나가기/리스 해제를 막으며 실패 시 백업을 남긴다. 제출 성공 후에만 해당 백업을 제거한다.
- 기존 draft 스키마/키, Firestore rules/indexes, 권한, JVM 소스는 변경하지 않는다. 운영 데이터 마이그레이션·삭제·초기화는 없다.

## 검증 근거와 한계

- 전체 단위: 413개 파일 / 4,135개 테스트 통과. 추가 오류 메시지 테스트 3개와 마지막 정책·위저드 변경은 targeted 70개 통과.
- 프로덕션 빌드 통과. 타입 검사는 새 오류 없음(기존 baseline 187개 유지).
- BFF Firestore emulator: 263개 통과. 별도 Auth/Firestore/Storage 규칙 테스트 3개 통과.
- JVM `FirestoreCashflowLeaseGuardTest`: 195개 통과. 실제 Cloud Run/월마감 운영 쓰기 검증은 수행하지 않았다.
- 통합 fixture는 운영 사례의 구조를 비식별화했다. 최종 제출 실패 전후 저장 문서 동일성, 승인 전 canonical 불변, 승인 후 연도별 예정월·계약기간 밖 월·null·0의 보존을 검사한다.
- 독립 브라우저 QA: 7개 사례 통과(전체 6개 + 추가 응답 유실 1개, 각 exit 0). 실제 포털 등록·수정 위저드를 사용하되 API를 mock했다. 입력→저장→새로고침, 30초 무입력 요청 수, A→B→A, 지연 응답, 실패 복원, 제출 충돌 후 재시도와 서버 저장 후 응답 유실→버전 충돌→새로고침→최신 입력 복원을 확인했다. 실사용자 계정으로 운영 프로젝트를 제출하지 않았다.
- QA는 별도 에이전트가 기준·Playwright·diff 검토를 수행했다. 지정된 외부 QA/Understand skill 경로가 로컬에 없어 저장소 QA 단계와 직접 코드/정책 분석으로 진행했다.
