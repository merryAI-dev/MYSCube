# 프로젝트 종료 승인과 정산 대상

## 단일 기준

지정 조직장의 종료 승인·합의가 확정되는 즉시 현재 주정산·월결산 업무 대상에서 제외한다.
계약 종료일, 보관 기산일, 마지막 결산월, 기존 `Project.status`는 제외 기준이 아니다.
종료 요청 대기·보완 상태에서는 정산 대상에 남는다. 미완료 정산은 종료 승인을 차단하지 않는다.

## BFF → JVM 계약

- BFF는 기존 `project_requests`의 `CLOSURE` 요청을 생성한다. 승인 시 요청 결정, 감사 기록,
  `Project.status=COMPLETED`, 아래 `Project.closure`를 하나의 Firestore 트랜잭션으로 저장한다.
- `closure = { contractVersion: "project-closure-v1", requestId, approvedAt, approvedBy }`.
  `approvedAt`은 서버 ISO 시각이며, 일반 프로젝트 저장으로 승인 사실을 쓰거나 지울 수 없다.
- JVM은 같은 Project 문서에서 승인 사실을 읽는다. 별도 종료 상태 복제나 날짜 계산은 없다.
  overview 응답의 `settlementEligibility`로 `ACTIVE / CLOSED / UNAVAILABLE`과
  `weekly / monthly / writable`을 전달한다. BFF는 누락·잘못된 응답을 `UNAVAILABLE`로 전달한다.
- JVM의 정산 쓰기는 원장 쓰기 트랜잭션에서 Project를 다시 읽는다. 종료 승인 이후의
  일반 쓰기·재개는 409로 거부한다. BFF의 정산 초안·새 시트 반영도 종료 사실을 확인한다.
- 진행 중이던 요청과 종료 승인이 겹치면 원장 트랜잭션 순서로 결정한다.
  이미 시작된 외부 시트 호출을 취소하거나 Drive 파일을 자동 변경·삭제하지 않는다.

## 화면과 보관

기존 검토함에 ‘사업 종료’ 유형을 추가하고 별도 종료 패널은 만들지 않는다.
제출 당시 체크리스트·첨부 참조와 보관 기산일·기간·인계 기록·수동 Drive 정리일·메모를 보존한다.
조직장이 바뀌거나 원본 버전이 달라진 요청은 승인할 수 없고, 현재 조직장이 보완 요청할 수 있다.
같은 요청의 중복 승인은 상태·버전·검토자·의견을 확인하여 추가 기록을 만들지 않는다.

현재 정산 목록은 `CLOSED`를 제외한다. ‘종료 사업 이력 포함’은 읽기 전용 과거 조회이며
원본 정산 금액·문서를 삭제하거나 0원으로 바꾸지 않는다. `UNAVAILABLE`은 숨기지 않고 확인 필요로 표시한다.
Drive 조회는 현재 Firebase 사용자에게 연결된 Google 계정으로, 저장된 프로젝트 연결 폴더의 바로 아래 메타데이터만 조회한다.
전용 재인증은 `drive.metadata.readonly`만 추가 요청한다. 토큰은 화면 메모리에만 보관하고
BFF는 Google tokeninfo에서 확인한 subject, OAuth client ID, 만료 및 scope를 검증한다.
Firebase 검증 claims의 연결된 Google subject와 다르면 거부한다. 서비스 계정 fallback은 없다.
401은 명시적 재연결, 403/404는 폴더 열기 및 사람의 뷰어 접근 요청으로 안내한다.
기존 시트 수정용 Google 인증과 권한은 변경하지 않는다.
조회 오류는 빈 폴더나 삭제 완료를 뜻하지 않는다. 삭제와 보관 인계는 사람이 수행한다.

## 검증 경계

로컬 Firestore 통합 테스트, JVM 테스트, HTTP 대역을 쓰는 브라우저 테스트는 각각 별도 증거다.
기존 프로젝트의 일괄 종료는 범위 밖이다. 운영 배포와 실제 Google 동의/Drive 조회 결과는
로컬 테스트와 별도로 확인·기록한다. 배포에는 `BFF_GOOGLE_OAUTH_CLIENT_ID`를 설정하고,
CI의 `BFF_GOOGLE_OAUTH_CLIENT_ID_LIVE` 변수는 해당 Firebase Google provider의 client ID와 일치해야 한다.

## 보안 규칙 배포와 복구

`project_closure_reviews`는 클라이언트 직접 쓰기를 금지한다. 웹/복합 배포의 기존 공통 CI 잠금 안에서
실제 운영 BFF SHA의 규칙과 현재 Rules 원문이 일치하는지 확인하고, 기존 ruleset 및 원문을
`firestore-rules-backup-*` artifact로 업로드한 뒤 규칙을 게시한다. 게시한 release와 원문 재조회가
일치해야 앱 배포를 진행한다. 목표 원문과 이미 같으면 변경하지 않는다.

CI 계정의 `ciFirestoreRulesPublisher` 역할은 `firebaserules.rulesets.create/get`과
`firebaserules.releases.get/update`만 갖는다. 데이터 쓰기·규칙 삭제 권한은 추가하지 않는다.
Rules release API에는 CAS가 없어 게시 직전 재조회로 외부 변경을 검사하지만, 동시 수동 게시를
완전히 방지하지는 못한다. CI 배포 중 Firebase Console에서 규칙을 수정하지 않는다.

복구가 필요하면 해당 실행의 artifact에서 `oldName`과 `source`를 확인한다. 현재 release가
문제 배포에서 게시한 ruleset인지 먼저 확인하고, 담당자가 승인한 예외 CI 복구에서
`cloud.firestore` release를 `oldName`으로 되돌린 후 원문을 재조회한다. 자동 롤백이나
로컬 운영 게시를 하지 않는다. 이번 추가 규칙은 신규 종료 검토 컬렉션만 보호하므로
앱 배포 실패 시에도 기존 앱의 컬렉션 권한은 유지된다.
