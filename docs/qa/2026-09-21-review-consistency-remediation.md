# 제출본·승인 원장 정합성 최소 변경 설계 — 2026-09-21

## 제안의 상태

이 문서는 **조사와 구현 제안**이다. 제품 코드·운영 데이터·권한·배포는 변경하지 않았다. 근거는 [백엔드 전수 감사](./2026-09-21-backend-field-audit.md), [화면 필드 감사](./2026-09-21-ui-field-audit.md), 현재 BFF draft/submit/executive-review 경로다. 실제 exported 함수 격리 실행으로 확인한 삭제/해제 결함과, 업무 정책 확인이 필요한 예산 변환을 구분한다.

추천은 기존 Firestore/BFF/React 안에서 **제출 당시 확정된 값, 그 값을 조직장이 실제로 읽은 버전, 승인 시 반영 가능한 필드**를 하나의 계약으로 연결하는 것이다. 신규 서비스·DB 이관·기존 데이터 일괄 수정은 필요하지 않다. #801은 제출본 표시와 일부 누락 매핑을 해결했지만 아래 삭제 의미·승인 읽기 버전·관리자 전용 값 보존까지 해결하지는 않았다.

## 현재 경로에서 유지할 안전장치

| 구간 | 현재 동작 | 설계에서 유지할 조건 |
|---|---|---|
| 임시저장 | 소유자별 privateEditDrafts, draftRevision, leaseId/fence, baseCanonicalVersion | 임시저장을 결재 문서에 섞지 않는다. 계약 확장 때문에 기존 초안을 삭제·초기화하지 않는다. |
| 최종 제출 | revision/lease/base version·첨부 검증 후 transaction에서 project_requests, SUBMITTED draft metadata, lease 해제, outbox, audit, idempotency 저장 | 실패하면 transaction 전체 실패. payload/attachmentRefs를 먼저 정리하지 않는다. 현재 정본은 CHANGE 제출 시 그대로 둔다. |
| 신규 등록 | 등록 요청과 PENDING 프로젝트를 함께 생성 | CHANGE와 생성 시점이 다름을 유지한다. 등록 API를 변경 승인처럼 취급하지 않는다. |
| 승인 | 지정 조직장, PENDING, current/base/target version, 첨부 확인 후 project/request/참여율 sync transaction | 승인이 거절돼야 할 조건을 완화하지 않는다. 데이터가 오래됐다는 이유로 base version을 몰래 갱신하지 않는다. |
| 후속 작업 | outbox가 requestVersion/targetProjectVersion을 참조 | 구버전 이벤트가 최신 제출본을 덮어쓰지 않는다. 링크 보관·첨부 이동이 제출 업무값을 바꾸지 않도록 한다. |
| 회수·재제출 | 저장된 제출본으로 초안 복원, 새 요청 버전 생성 | 구버전 결재창이 새 제출본을 승인하지 못해야 한다. 새 초안/첨부와 과거 제출 첨부의 정리 권한을 분리한다. |

`project-info-drafts.mjs`의 최종 제출은 request 문서를 `tx.set(requestRef, submittedProjectRequest)`로 교체하고, 기존 `change-{projectId}` ID를 재사용하면서 requestVersion을 올린다. 따라서 현재 구조가 모든 과거 버전 본문을 영구 보존하는 것은 아니다. 이 설계의 최소 범위는 **동일 제출 버전 안에서 불변성 보장**이다. 전체 역사본 영구 조회가 필요하면 별도의 보존 범위를 결정해야 하며, 이번 작업에서 무제한 snapshot 배열이나 신규 이력 컬렉션을 몰래 추가하지 않는다.

## 사용자에게 보여주는 사실과 원장을 분리한다

| 대상 | 읽어야 하는 값 | 읽으면 안 되는 대체값 |
|---|---|---|
| 작성 중 화면 | 해당 소유자의 활성 draft와 그 화면에서 확정한 입력 | 다른 실무자의 draft |
| 최종 제출 후 확인 | 서버가 반환한 requestVersion의 제출 snapshot | 아직 반영되지 않은 새 draft, 최신 프로젝트를 섞은 값 |
| 조직장 검토 | CHANGE: proposedSnapshot, REGISTRATION: payload. 문서가 읽은 requestVersion을 함께 보관 | 필드가 비었다는 이유로 현재 project의 값으로 보충 |
| 승인 완료 내역 | 해당 결정과 연결된 approvedSnapshot이 있으면 그것; 없으면 해당 요청의 제출 snapshot | 현재 프로젝트를 과거 승인 내용으로 표시 |
| 현재 사업 운영 화면 | 승인 반영된 project, 운영 전용 금액·주정산·월결산 상태 | 과거 request snapshot으로 현재 운영값을 덮어쓰기 |
| 현재 상태와 제출 당시 상태 비교 | 서로 별도 영역에 출처와 시점을 명시 | 두 값을 한 라벨 아래에서 조건별로 섞기 |

실무자·조직장이 보아야 할 것은 같은 **제출 업무값**이다. 그렇다고 project 전체를 snapshot으로 대체하면 주정산·월결산·관리자 예산·상태 이력 등이 사라진다. 제출 snapshot은 승인 가능한 업무 영역의 기준이고, project는 그 결과와 별도 운영 상태를 함께 가진 원장이다.

## 가장 먼저 고칠 세 가지

### 1. 삭제·해제 값을 실제 승인 patch에 남긴다

격리 실행에서 `contractEndUndecided=false`와 빈 폴더 링크가 `undefined`로 사라진 뒤 merge가 이전 값을 유지하는 것을 확인했다. Firestore 필드 삭제 sentinel을 도입할 필요 없이 현재 타입에 맞는 명시적 값으로 고칠 수 있다.

| 값 종류 | 신규 제출 계약 | 승인 patch | 과거 sparse 요청에서 키 없음 |
|---|---|---|---|
| boolean | true/false 구분 | false도 그대로 기록 | 정본 보존 |
| 지울 수 있는 문자열 | `''`는 비우기 | 빈 문자열 기록 | 정본 보존 |
| 선택 첨부 | `null`은 참조 제거 | null 기록; 파일 물리 삭제와 분리 | 정본 보존 |
| 허용되는 빈 배열 | `[]`는 목록 비우기 | 필드 계약이 허용하면 빈 배열 기록 | 정본 보존 |
| 숫자 | 0은 명시적 0 | 0 기록 | 정본 보존; 자동 0 채우기 금지 |
| 월별 참여율 | null=미입력, 0=명시 0% | 두 상태 구분 | 제출되지 않은 월을 0으로 보정하지 않음 |
| undefined | 저장 값이 아니라 '해당 키를 제출하지 않음' | patch에 넣지 않음 | 정본 보존 |

구체적 대상은 `contractEndUndecided`, `businessManagementGoogleFolderLink`, 조건부 `settlementSystemOther`다. `participationSheetLink`는 단순 삭제와 달리 월별 참여율 출처 검증이 있으므로 해당 정책 검증 후 동일 삭제 규약을 적용해야 한다. 필요한 링크를 비우는 행위까지 무조건 허용하지 않는다.

`contractEndUndecided=false`와 유효한 종료일은 함께 저장되어야 한다. `true`와 종료일 동시 입력은 지금처럼 거부한다. 화면에서 '종료 기간 없음'을 해제했는데 정본에 true가 남는 상태를 허용하지 않는다.

### 2. 조직장이 읽은 requestVersion을 승인 API에 전달한다

현재 `projectExecutiveReviewSchema`는 requestId와 결재 상태를 받지만 **화면에서 읽은 requestVersion은 받지 않는다**. 서버 preflight에서 읽은 requestVersion과 transaction의 requestVersion을 비교하므로 서버 처리 중 경합은 막지만 다음 순서는 **실제 lifecycle·handler를 실행한 가상 데이터 재현에서 승인됐다**. 운영에서 이 순서의 사고가 발생했다는 증거는 아직 없다.

1. 조직장이 요청 v1을 연다.
2. 실무자가 회수/수정/재제출해 동일 requestId의 v2가 저장된다. 정본 base version은 변하지 않을 수 있다.
3. 조직장이 v1 화면에서 승인한다.
4. 서버가 v2를 처음 읽고 transaction에서도 v2를 읽으면 현재 가드만으로 '화면은 v1'임을 알 수 없다.

서버 읽기→transaction 읽기 사이 경합과, 클라이언트가 본 화면→서버 최초 읽기 사이 경합은 다르다. Firestore transaction은 읽은 문서가 실행 중 변경되면 다시 수행하고 쓰기를 원자적으로 적용한다. 이것만으로 이전에 사용자가 본 문서 버전을 알 수 있다는 보장은 없다. 후자는 애플리케이션이 읽기 버전 조건을 전달해야 한다는 **설계 추론**이며, 아래 별도 격리 재현으로 이 코드에서 실제 차이를 확인했다. [Firestore transaction 공식 문서](https://firebase.google.com/docs/firestore/manage-data/transactions)

최소 API 확장: `expectedRequestVersion`과 `expectedProjectVersion`을 결재 요청 body에 추가한다. 이 값은 목록 요약이 아니라 **열린 결재 문서 응답**에서 얻는다. 승인 transaction 안에서 current requestVersion과 current project.version에 정확히 대조하고, CHANGE의 기존 base/target 검증도 유지한다. REGISTRATION에 없는 CHANGE base 필드를 억지로 요구하지 않는다. 불일치 시 409와 '검토 중 제출 내용이 변경되었습니다. 문서를 다시 열어 변경 내용을 확인해 주세요.'를 보여준다. 결재 의견과 사용자의 다른 입력은 유지한다. 재조회 후 자동 승인 재시도는 하지 않는다.

HTTP `If-Match`로 구현하는 대안도 있다. 이 경우 strong validator를 비교하고 불일치는 표준의 412로 응답해야 하며, body의 expected version 방식과 status 규약을 혼용하지 않는다. 새 네트워크 계층 도입 없이 '사용자가 전에 읽은 representation과 아직 같은 경우에만 수정'이라는 원리를 적용한다. [RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#name-if-match)

버전 없는 과거 요청에는 가짜 `1`을 만들어 일치시켜서는 안 된다. 해당 요청은 신뢰할 수 있는 업데이트 시점/검토 token을 읽기 응답에서 발급·반환해 transaction 값과 비교하는 별도 legacy 경로를 쓰거나, 기존 방식 지원 범위를 명시하고 먼저 재제출하도록 안내해야 한다. **추천 최소 경로**는 읽기 응답의 서버 revision token을 병행하는 것이다: 기존 requestVersion이 유효하면 그것을 사용하고, 없으면 Firestore document updateTime을 opaque token으로 반환해 approval에서 비교한다. 토큰은 인증을 대신하지 않으며 기존 권한/버전 검증에 추가된다. 라이브 요청 문서에 backfill은 하지 않는다.

새 UI는 항상 읽기 버전을 보낸다. 새 읽기 계약으로 제공된 문서에 버전 없이 들어오는 결재는 명확한 새로고침 안내로 거부한다. 구클라이언트 무기한 허용으로 보호를 무력화하지 않는다. rollout 전에 열려 있던 세션의 처리 방식은 QA 항목에 포함한다.

### 3. 요청 범위 밖 원장값은 승인 patch에서 제외한다

PM 수정 승인이 `budgetCurrentYear`를 계약금액으로 다시 쓰는 동작은 실제 helper+merge 실행으로 재현했다. 별도 당해 예산을 자동 재계산해야 한다는 업무 정책은 확인되지 않았다.

추천: 변경 승인 patch에서 `budgetCurrentYear`를 제거해 기존 값을 보존하고, **신규 등록 시에만 현재 초기값 정책을 적용**한다. 기존 별도 값과 계약금액이 다른 2건을 일괄 보정하지 않는다. 예산 재계산을 원한다면 일반 프로젝트 수정 승인과 분리된 명시적 업무 요구로 결정한다.

동일 보존 범위에 `taxInvoiceAmount`, 실입금/은행 내역, 전표·증빙 승인, 주정산 확정, 월결산 잠금, cashflow 원본 좌표 데이터, 생성/감사 이력, 관리자 프로젝트 코드 등을 포함한다. 이 값들은 PM snapshot에 없다고 null/0/default로 채워 쓰지 않는다.

관리자 builder의 `finalPaymentNote` 누락도 재현됐지만 현재 관리자 화면의 실제 편집 입력 여부를 먼저 육안 확인한다. 입력이 존재하면 동일 필드 계약의 명시적 값 전달을 추가하고, 화면에서 편집하지 않는 보존값이면 무조건 초기화하는 코드만 넣지 않는다.

## 공통 필드 계약의 최소 형태

대규모 폼 schema 교체 대신 현재 플랫폼의 순수 helper 위치에 작은 **업무 필드 목록과 쓰기 의미**를 둔다. JSON schema·서버 함수·UI 라벨을 한 번에 통째로 이관하지 않는다.

예정 위치: `src/app/platform/project-submission-fields.mjs`와 타입 선언 `.d.mts`. 기존 BFF가 `project-input-policy.mjs`를 공유하는 방식과 동일하게 순수 모듈을 읽는다. 처음에는 필드 식별자/소유 범위/clear 의미/첨부 kind 대응을 정의하고, 실제 DB/권한/I/O는 기존 BFF에 둔다.

필드 정의 최소 속성:

- `key`: 실제 저장 필드 경로. UI label을 키로 쓰지 않는다.
- `scope`: `SUBMISSION`, `DERIVED`, `OPERATIONS` 구분. 전역 generic form 엔진이 아니라 프로젝트 제출 전용이다.
- `empty`: string-empty / null / false / empty-list / not-clearable. 모든 필드에 공통 `value || default`를 적용하지 않는다.
- `documentKind`: 첨부 필드에 한해서만 명시한다. `final_report`처럼 여러 mapping 사이 누락을 계약 테스트로 잡는다.
- `derivedFrom`: 팀원 요약·수익률처럼 정본 입력이 아닌 표시 계산에만 사용한다. 별도 저장 값과 혼동하지 않는다.

기존 `registrationRequirementsVersion`는 업무 필수입력 정책 버전이므로 snapshot 모양의 버전으로 재사용하지 않는다. 신규로 만들어지는 요청에만 `snapshotSchemaVersion: 1`을 BFF가 기록할 것을 제안한다. 이 버전은 **필드 완결성·삭제 의미·승인 projection**을 지정한다. 기존 요청은 marker 없음=legacy sparse다. 버전은 클라이언트가 주장하는 값을 신뢰하지 않고 서버가 붙인다. 새 DB/마이그레이션 없이 기존 request 문서의 추가 속성으로 가능하다.

과도한 범용 registry 도입이 위험하면 1차는 BFF의 기존 문서 매핑 목록과 submission-owned 목록부터 한 곳으로 모으고, UI는 검증된 순수 read 계산만 공유한다. 모든 필드 normalizer를 한 PR에서 다시 쓰지 않는다.

## submitted snapshot 계약

신규 버전 요청은 BFF가 **제출 transaction에서 한 번** 검증·정규화한 업무 snapshot을 만든다. 승인 때 다른 default/새 정책으로 전체 snapshot을 다시 구성하지 않는다.

| 요소 | 최소 변경 |
|---|---|
| 식별 | 기존 requestId + requestVersion + baseProjectVersion + targetProjectVersion 유지 |
| schema | 신규 요청에만 snapshotSchemaVersion=1 추가 |
| 업무 내용 | CHANGE proposedSnapshot; REGISTRATION payload. 기존 payload alias는 호환용으로 유지하되 값은 동일 |
| 서류 | 서버가 검증한 path/name/size/contentType/attachmentId 등 참조만 포함. 브라우저 downloadURL은 업무 사실 아님 |
| 변경목록 | beforeSnapshot vs submittedSnapshot으로 만들고, 화면과 승인에 같은 필드 계약 사용 |
| 승인 | 본 requestVersion의 snapshot에서 submission-owned 필드만 projection. approvedSnapshot에 동일 업무 사실을 기록 |
| 후속 링크 보관 | 권한 있는 원문 locator 변경은 업무값과 구분. 파일·버전 식별을 유지하고 지연 outbox가 새 요청을 변경하지 못하게 함 |

새 snapshot에 필수 업무 필드가 빠졌으면 제출 자체를 원자적으로 거부하고 초안을 보존한다. 선택 필드는 '없음'을 명시 null/빈값으로 저장한다. 새 snapshot이 완전하다는 가정은 marker+검증이 있는 요청에만 한다.

**과거 sparse 요청 호환:** 키가 없으면 해당 필드는 승인 patch에서 제외하고 정본을 유지한다. 단, 조직장 문서에는 '해당 제출본에 기록 없음'으로 보인다. 현재 정본값을 제출 내용으로 보충하지 않는다. 누락을 false/null로 생성해서 과거 요청 승인 시 기존 값이 삭제되는 회귀를 막는다. 첨부 미제출/접근권한 부족/파일 저장 확인 불가는 서로 다른 상태로 표시한다.

보완 필수 항목을 가진 과거 요청을 무조건 승인 가능하게 만드는 호환은 하지 않는다. 기존 업무 검증과 충돌하면 구체적인 누락 항목을 안내하고 소유자 초안에 복원하는 기존 회수·재제출 흐름을 사용한다. 복원/재제출도 사용자가 요청한 경우에만 실행하며 자동 데이터 수정은 하지 않는다.

## 분야별 공통 읽기와 쓰기 계약

| 분야 | 제출 당시 사용자에게 보이는 사실 | 승인 원장에 쓰는 값 / 범위 |
|---|---|---|
| 인력 | 제출한 실제 역할 staffing과 서류상 teamMembersDetailed를 구분. 월별 참여율은 제출 snapshot의 YYYY-MM·0·null을 그대로 표시 | 검증된 identity/기간/monthlyRates만 같은 request version으로 반영. live 시트를 승인 중 다시 읽어 제출 내용을 바꾸지 않음. 참여율 sync는 승인 transaction에 유지 |
| 폴더/제안 링크 | 제출한 URL 문자열과 파일을 각각 표시. 현재 Drive 이름이나 파일 존재 확인은 별도 상태 | 제출 URL/명시적 빈값을 보존. 자동으로 정본 링크로 채우지 않음. 권한 없는 링크의 내용을 대신 열거나 공유권한 확대하지 않음 |
| 계약/연도별 금액 | 동일 snapshot에서 총액·구성금액·연도별 금액·불일치 상태 표시 | 인정된 입력값 그대로 쓰되 현재 검증 유지. 계약금액 불일치 신규 차단은 별도 업무 결정 후 적용. 감사만으로 과거 금액 보정 금지 |
| 입금 계획 | 단년도는 top-level, 다년도는 financialYears의 각 연도 금액과 해당 연도 계약금액. 전체 요약은 같은 연도 집합의 합계 | percent는 표시 파생값. 분모 0을 전체 계약금액으로 대체하지 않는다. 월/주 의미를 서로 바꾸지 않음 |
| 수익률 | 수익/계약금액 파생임을 두 화면에서 같은 계산으로 표시 | totalRevenueAmount를 기준으로 현 파생 정책 유지. 수익률 자체를 독립 입력으로 오인해 저장하지 않음 |
| 상태/체크아웃 | 제출 당시 상태와 체크아웃 값이 같은 snapshot에서 나온다. 현재 진행상태가 필요하면 별도 표시 | 상태를 날짜만으로 자동 수정하지 않음. 잘못 저장된 KDB 상태는 별도 사실 확인/권한 있는 수정 대상 |
| 주정산·월결산 | 해당 화면의 승인/잠금 상태는 현재 운영 원장 사실 | 프로젝트 결재 snapshot 승인으로 결산 잠금을 해제하거나 결산 숫자를 다시 쓰지 않음. 연결 workflow는 별도 설계 gate |
| 첨부 | 제출 snapshot에 있는 파일/링크 모두 표시. '해당 없음'과 '기록 없음' 구분 | 서버 검증 refs만 반영. null은 참조 제거이며 과거 제출본이 참조하는 blob 삭제 요청이 아님 |

다년도 호환 보완: 부모 QA의 실제 SSR 대조에서 **financialYears=[]이지만 top-level paymentPlan은 존재하는 5개 사례(요청 2·legacy 원장 3)**의 요약이 `-`로 사라지는 현상이 보고됐다. 본 하위 작업에서 그 화면을 독립 재실행한 것은 아니므로 부모의 fixture/SSR 증거를 함께 참조해야 한다. 해결 계약은 다음과 같다.

- 연도별 계획이 없다는 사실과 기존 사업 전체 계획이 있다는 사실을 둘 다 표시한다. 기존 top-level 값은 **'기존 사업 전체 입금 계획 · 연도별 배분 미등록'**처럼 별도 scope 라벨로 보여준다.
- top-level 금액을 임의의 연도에 복사하거나 균등 배분하지 않는다. 연도별 값 없음 때문에 top-level을 0/`-`로 소거하지 않는다.
- 연도별 계획이 일부만 있는 경우에도 '부분 연도 합계'와 기존 전체 계획을 구분하고, 두 집합을 더해 이중 계산하지 않는다. 완결성은 연도 범위와 명시적 입력 상태로 판단한다.
- 실제 명시적 0, 연도 미기록, 분모 0은 서로 다른 상태다. 표시 helper가 값과 함께 `scope` 및 `completeness`를 반환하도록 순수 read 계약에 포함한다. 저장 데이터는 그대로 둔다.

## 예상 수정 파일과 순서

| 순서 | 파일 | 최소 변경 | 범위 밖 |
|---|---|---|---|
| 1 | `server/bff/routes/projects.mjs` | boolean/string clear 보존; CHANGE의 관리자 전용 budget 덮어쓰기 제거(정책 확인 후); sparse own-key projection; 실제 읽은 요청 버전 transaction 검사 | 권한·상태 전이·base/target version 완화 금지 |
| 1 | `src/app/platform/project-editor.ts` | 사용자 명시적 false/빈값 전달 확인; 관리자 메모 실제 입력이 있다면 매핑 연결 | 입력 필드 대규모 재배치 제외 |
| 2 | `server/bff/schemas.mjs`, `src/app/lib/platform-bff-client.ts` | expectedRequestVersion/expectedProjectVersion/legacy revision token 결재 계약 | 타 API 인증/15분 세션 정책과 혼합하지 않음 |
| 2 | `src/app/components/projects/ProjectMigrationAuditPage.tsx`, `migration-audit/MigrationAuditDocumentDialog.tsx` | 열린 문서 버전 보관, 그 버전으로만 승인; 409 후 문서 재열기 안내 | 자동 승인 재시도 금지 |
| 3 | `src/app/platform/project-submission-fields.mjs` + `.d.mts` (신규 제안) | 제출 소유 필드/clear/문서 kind 계약; 타입과 런타임 키 불일치 테스트 | 범용 폼 엔진 제외 |
| 3 | `server/bff/routes/project-info-drafts.mjs`, `project-registration-drafts.mjs`, `projects.mjs` | 기존 submit transaction 내 snapshotSchemaVersion와 완결성 검사; existing drafts 그대로 수용해 제출 시만 신규 계약 생성 | 기존 초안 backfill·정리 금지 |
| 3 | `src/app/data/types.ts`, `src/app/platform/project-change-request.ts` | optional 새 marker 타입, 단일 snapshot resolver. 미사용 legacy builders는 호출 분석 후 위임/제거 | 쓰이지 않는 helper를 live 원인이라고 과장하지 않음 |
| 3 | `src/app/platform/project-migration-review-dossier.ts` 및 관련 표시 컴포넌트 | missing/null/empty 명시 구분, 공통 순수 읽기 결과 표시 | raw API 필드/내부 token 사용자 노출 금지 |
| 전 단계 | 기존 editor/BFF route/integration 테스트 | 필드 계약·삭제·경합·초안 보존 회귀 추가 | 테스트만 통과하고 모든 운영 사업 정상이라고 주장하지 않음 |

처음 두 단계와 snapshot 계약 도입을 별도 리뷰 단위로 나누는 것이 안전하다. 급한 삭제 버그를 고치기 위해 모든 정산 정책과 양식 계산을 한 번에 바꿀 필요는 없다. 기존 배포 규칙대로 main CI 성공에 따른 자동 배포만 사용한다.

## 독립 QA stage gate

| gate | 통과 기준 | 독립 증거 |
|---|---|---|
| 1. 의도/경로 | 77개 최상위·하위 필드의 submission/derived/operations 분류 확정. budget·기간 없음·상태 정책의 승인 여부 표시 | 감사 매트릭스 + 업무결정 기록. 미확정 정책을 '수정 완료'로 표시하지 않음 |
| 2. 최소 구현 | 실제 request snapshot과 승인 project write가 계약에 맞음. sparse 키 없음 보존, false/0/empty/null 명시 처리 | exported helper 실행뿐 아니라 draft submit→approval transaction→persisted read tests |
| 3. 사용자 흐름 | 실무자 제출 확인과 조직장 검토가 동일 requestVersion의 동일 사실 표시. 문서 종류·금액·월별 참여율 포함 | 브라우저 두 역할의 screenshot/DOM + 승인 요청 body의 expected version + 응답. 제출/승인은 fixture 또는 emulator만 |
| 4. 회귀 | 부분 초안, 권한 거절, 첨부 실패, timeout, 409, 반려·회수·재제출, 중복클릭, 구클라이언트, sparse 과거 요청, operations 필드 보존 | before/after persisted state, API 결과, audit/outbox/lease 상태와 버튼 회복 확인 |

필수 경합 사보타주 사례:

1. v1 문서 open → v2 재제출 → v1 승인 요청은 반드시 409. expectedRequestVersion 검사를 제거하면 이 테스트가 실패해야 한다.
2. false clear를 `value || undefined`로 되돌리면 '기간 없음 해제 + 종료일' persisted read 테스트가 실패해야 한다.
3. folder clear를 stripUndefined 처리하면 blank persisted read 테스트가 실패해야 한다.
4. request에서 누락된 legacy 첨부 필드를 null로 채우면 원장 첨부 보존 테스트가 실패해야 한다.
5. PM 요청에 admin budget이 없을 때 승인 코드가 계약금액으로 계산하면 별도 예산 보존 테스트가 실패해야 한다(보존 정책 채택 시).
6. monthlyRates의 null을 0으로 합치면 제출 문서/승인 원장/participation projection 대조 테스트가 실패해야 한다.
7. 새 draft를 승인 문서와 합치거나 live 시트를 승인 직전에 새로 읽으면 제출 버전 불변성 테스트가 실패해야 한다.
8. financialYears=[]와 비어 있지 않은 전체 paymentPlan에서 전체 계획을 `-`/0으로 가리면 호환 표시 테스트가 실패해야 한다. 부분 연도와 전체 계획을 합쳐 중복 계산해도 실패해야 한다.

## 부모 작업에 남기는 실제 브라우저 확인

이 하위 작업에서는 운영 브라우저를 조작하지 않았다. 다음은 부모의 실제 화면 대조가 필요하다.

- 이미 열린 결재창이 새 요청 버전으로 교체될 때 현재 UI가 무엇을 보여주는지, 승인 버튼이 어떤 request/version을 보내는지 확인. 운영 승인 버튼 클릭은 하지 않고 Network/fixture로 검증.
- 관리자 메모 입력 존재 여부와 정확한 화면 라벨, 기간 없음 해제·폴더 삭제 조작이 draft에 어떻게 기록되는지 확인.
- 실무자/관리자에서 같은 프로젝트명만으로 대조하지 말고 projectId/requestId/requestVersion을 기준으로 인력 월별 표·첨부·링크·단/다년도 입금 계획·체크아웃을 대조.
- 초안 소유자가 다른 경우에도 결재 문서에서 내용이 노출되지 않는지, 읽기 권한 거절과 데이터 미기록 문구가 구분되는지 확인.
- 정책 미확정인 금액 불일치·별도 예산·완료 상태는 운영값 자동 수정 없이 원문 및 담당자 확인으로 결론을 남긴다.

완료 판정은 '코드 매핑을 맞췄다'가 아니라 **같은 제출 버전을 양쪽이 보았고, 그 버전의 허용 필드만 승인됐으며, 다른 초안과 운영 원장은 보존됐다는 증거**까지 확보했을 때 가능하다.

## 오래된 결재 화면 경합의 실제 격리 실행 증거

소스 복사본과 기존 테스트의 in-memory Firestore 구현을 사용했다. 가상의 `description`만 v1/v2로 바꾸고 라이브 데이터/개인정보는 읽거나 쓰지 않았다. v2 요청을 직접 DB에 심은 테스트가 아니라 다음 실제 함수 순서로 만들었다.

1. `createProjectInfoDraftService.open/update/submit`: request v1, canonical v3.
2. `readProjectRequestById`: v1 응답을 클라이언트가 보았다고 보관.
3. `createEditLeaseService.acquire`: 제출 시 해제된 lease를 실제 서비스로 재획득.
4. `createProjectInfoDraftService.withdraw/update/submit`: WITHDRAWN을 거쳐 같은 requestId의 v2 생성; canonical은 여전히 v3.
5. v1에서 보관한 requestId와 APPROVED만 실제 Express `POST /api/v1/projects/project-a/executive-review`에 전송.
6. 실제 승인 handler·version guard·merge·참여율 sync를 실행한 결과 HTTP 200, 요청 v2 APPROVED, approvedSnapshot과 canonical v4의 description 모두 v2.

가상 저장소·권한 fixture·storage metadata 응답을 사용했지만 lifecycle와 승인 로직은 현재 product 함수다. 인증 토큰 검증/네트워크 Firestore의 동시성/실제 브라우저 화면 유지 여부까지 검증한 것은 아니다. **버그 조건은 가상 데이터에서 재현됐고 운영 발생 여부는 미확인**이다.

실행 명령(복사본 작업 디렉터리에서 실행, exit 0):

```sh
cd /private/var/folders/32/296zgqyn5nj6rl9m2lgd3qb00000gn/T/myscube-backend-repro-n75hdop7
./node_modules/.bin/vitest run -t 'isolated stale reviewer lifecycle' --reporter=dot
```

결과: 1 passed, 52 skipped(필터로 제외한 기존 테스트). 민감 정보 없는 stdout:

```json
{"fixtureOnly":true,"liveWrites":0,"actualLeaseAcquire":true,"actualWithdraw":true,"actualResubmit":true,"clientReadRequestVersion":1,"serverApprovalRequestVersion":2,"requestIdUnchanged":true,"baseVersionUnchanged":true,"actualApprovalHttpStatus":200,"canonicalContainsUnreviewedV2":true,"scope":"isolated actual handlers; production incident unconfirmed"}
```

## 외부 설계 원리 참고 범위

Frappe의 공식 REST 문서는 DocType마다 CRUD endpoint가 자동 생성된다고 설명한다. 여기서 참고할 것은 '문서 정의와 API 계약의 연결'이라는 원리다. 이 저장소를 Frappe/Python으로 옮기거나 자동 CRUD를 결재 권한 검증 대신 도입하자는 제안이 아니다. 현재 Express/TypeScript와 기존 결재 transaction 안에서 작은 공통 필드 계약으로 적용한다. [Frappe REST 공식 문서](https://docs.frappe.io/framework/user/en/api/rest)


## 79개 프로젝트 브라우저 전수 캡처에서 추가된 조치

| 관찰 | 원인 범위 | 최소 조치 | 통과 증거 |
|---|---|---|---|
| 입력 4단계의 연도 문장은 입금 0, 같은 화면 하단/승인은 실제 금액 | 입력 검토의 원시 연도 값과 정규화된 입금 모델의 차이 | 입력·최종 제출 확인·승인 문서가 같은 payment projection을 사용 | 동일 제출본에서 단년도·다년도·구형 전체 계획의 금액/분모/기간을 세 위치에서 대조 |
| 승인 완료 본문과 검토대기 도장, 철회를 대기로 표시 | 문서 상태와 결재 이력 부족을 같은 표시로 처리 | 승인 상태·결재자 이력 미기록·철회를 구별, 존재하지 않는 도장/일시 생성 금지 | APPROVED sparse, WITHDRAWN, PENDING 재제출 별도 화면 증거 |
| 긴 URL이 다음 카드 침범 | 표시 레이아웃 | 줄바꿈·최소 폭 제한과 읽을 수 있는 링크 라벨 | 긴 실제 URL 및 좁은 화면에서 인접 금액/첨부 가림 없음 |
| 미등록이 0과 혼재 | 입력 placeholder/기본값과 문서 formatter 차이 | absent와 explicit zero를 표시 모델에서 유지 | 원본 키 없음·null·빈문자열·0 각각 저장 왕복 및 화면 비교 |
| 저장 금액 불일치 경고가 입력에만 보임 | 화면별 검증 결과 미공유 | 제출/승인 양쪽에 같은 금액·항목·차이 및 조치 안내 | 농산업·KOICA네팔 등 읽기 전용 fixture 경고 일치, 데이터 자동 보정 없음 |

수정 순서는 승인 버전 비교 → 명시 삭제 보존 → 공통 제출 표시·검증 계약 → 구형/외화/가독성 순으로 권장한다. 임시저장은 편집 중 불완전한 값을 허용하며, 최종 제출과 승인에서만 해당 제출본의 검증 결과를 적용한다. 오래된 요청의 정책 위반을 새 정책으로 무조건 차단하기 전에 제출 당시 정책 버전과 현재 보완 요구를 구분한다. 이 감사는 설계 제안이며 위 조치는 아직 제품 코드에 추가하지 않았다.
