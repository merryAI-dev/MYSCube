# 프로젝트 변경 요청 동기 제출 설계

## 배경

기존 일부 프로젝트 변경 요청은 프로젝트 버전, 제출 첨부파일, 관리자 검토 문서가 서로 다른 시점에 저장됐다. 그 결과 오래된 승인대기 요청에는 `targetProjectVersion`이 없고, 실무자가 보았던 첨부파일과 관리자에게 보이는 첨부파일이 달라질 수 있다.

신규 변경 요청은 승인에 필요한 모든 업무 상태를 제출 응답 전에 Firestore에 확정한다. Google Drive는 업무 원장이 아니라 제출 후 생성되는 읽기 전용 백업으로만 사용한다.

## 목표

- 실무자의 제출 성공 응답 전에 요청 snapshot, 첨부 참조, 기준 버전과 목표 버전을 확정한다.
- 관리자는 제출 당시 snapshot과 첨부파일을 즉시 조회한다.
- 승인 시 프로젝트와 요청 상태가 하나의 Firestore transaction으로 함께 변경된다.
- 제출·승인 재시도가 중복 버전 증가나 중복 처리를 만들지 않는다.
- 기존 불완전 요청을 한 번 정상화하고 신규 요청에 legacy 예외를 남기지 않는다.
- Drive에는 제출 후 사람이 읽을 수 있는 사본을 만들되 업무 처리 성공 여부에는 영향을 주지 않는다.

## 비목표

- Drive를 프로젝트 또는 요청 상태의 원장으로 사용하지 않는다.
- Drive 사본을 읽어 Firestore 상태를 복구하거나 판단하지 않는다.
- 신규 queue, 동기화 상태 머신 또는 별도 승인 단계를 만들지 않는다.
- 현금흐름, 주정산, 월결산 로직은 변경하지 않는다.
- 신규 외부 서비스나 저장소를 도입하지 않는다.

## 핵심 결정

### 단일 원장

Firestore만 업무 상태의 단일 원장이다. Drive 사본의 생성 여부와 관계없이 제출·조회·승인은 Firestore request를 기준으로 한다.

### 하나의 업무 단계

첨부파일 전송은 사용자가 파일을 선택할 때 완료하지만, 업무상 제출은 하나다. 제출 API는 다음 조건을 모두 만족한 뒤에만 성공한다.

1. 첨부 참조가 실제 저장된 파일과 일치한다.
2. 제출 snapshot이 확정됐다.
3. `baseProjectVersion`과 `targetProjectVersion`이 확정됐다.
4. 관리자가 같은 request를 즉시 조회할 수 있다.

### Request-first 승인

제출 시 프로젝트의 업무 데이터와 버전은 바꾸지 않는다. 변경안은 request에만 저장하고, 관리자 승인 transaction에서 프로젝트 원장에 반영한다.

## 데이터 계약

변경 요청은 기존 필드를 사용하며 다음 불변식을 갖는다.

- `requestKind = CHANGE`
- `status = PENDING`
- `baseProjectVersion = 제출 시 프로젝트.version`
- `targetProjectVersion = baseProjectVersion + 1`
- `beforeSnapshot = baseProjectVersion의 프로젝트 내용`
- `proposedSnapshot = 실무자가 제출한 최종 내용과 첨부 참조`
- 모든 제출 첨부는 `proposedSnapshot`의 해당 document 필드에 포함된다.
- 관리자 화면과 승인 transaction은 `proposedSnapshot`만 사용한다.

request가 존재할 때 현재 프로젝트의 첨부파일로 fallback하지 않는다. 이는 사용자가 제출하지 않은 파일이 검토 문서에 섞이는 것을 막는다.

## 첨부파일 흐름

### 업로드

기존 BFF 저장 서비스를 재사용해 파일을 처음부터 프로젝트의 영구 비공개 경로에 저장한다.

```text
orgs/{tenantId}/project-registration-documents/{projectId}/{attachmentId}-{fileName}
```

업로드 응답은 기존 첨부 참조 필드인 `attachmentId`, `path`, `name`, `size`, `contentType`, `uploadedAt`을 반환한다. 초안은 파일을 복제하지 않고 이 참조만 가진다.

파일 업로드 후 초안 참조 저장이 실패하면 방금 올린 파일을 즉시 삭제한다. 제출이 실패하면 파일과 초안은 유지해 재업로드 없이 다시 제출할 수 있다.

### 제출

제출 API는 저장된 첨부 참조를 검증하고 하나의 Firestore transaction에서 다음 문서를 변경한다.

- 변경 request 생성 또는 갱신
- 편집 초안을 `SUBMITTED`로 전환
- 편집 lease 해제
- idempotency 결과 기록
- 감사 로그 기록

프로젝트 원장과 프로젝트 버전은 이 transaction에서 변경하지 않는다.

기존 `project-registration-drafts`에서 영구 경로로 파일을 옮기는 outbox 후처리는 제거한다. Slack 알림과 방치된 미제출 파일 정리만 비동기로 남긴다.

## 관리자 조회

관리자 inbox는 request의 `proposedSnapshot`을 반환한다. 첨부 원문은 기존 request attachment BFF endpoint로 내려받는다.

- request에 있는 파일만 표시한다.
- 파일 참조가 없으면 명확히 `미제출`로 표시한다.
- 저장소에 없는 파일 참조는 `첨부 파일을 불러오지 못했습니다`로 표시하고 승인 전 검증에서 거부한다.
- Drive 백업 생성 여부는 화면의 승인 가능 여부에 영향을 주지 않는다.

## 승인과 반려

### 승인

하나의 Firestore transaction에서 다음을 수행한다.

1. request가 `PENDING`인지 확인한다.
2. 지정 조직장과 요청의 첨부·버전 계약을 확인한다.
3. 현재 프로젝트 버전이 `baseProjectVersion`과 같은지 확인한다.
4. `proposedSnapshot`을 프로젝트에 반영한다.
5. 프로젝트 버전을 `targetProjectVersion`으로 변경한다.
6. request를 `APPROVED`로 변경한다.

어느 한 조건이라도 실패하면 프로젝트와 request 모두 쓰지 않는다.

### 반려

request만 `REJECTED`로 변경한다. 프로젝트 원장과 버전은 변경하지 않는다. 실무자가 수정해 재제출하면 현재 프로젝트 버전을 다시 기준으로 새 snapshot을 만든다.

## 재시도와 충돌

- 동일 idempotency key의 제출과 승인은 저장된 동일 응답을 반환한다.
- 중복 클릭은 request 또는 프로젝트 버전을 추가로 증가시키지 않는다.
- 편집 중 프로젝트가 변경되면 제출을 409로 거부하고 최신 내용으로 다시 시작하게 한다.
- 제출 후 승인 전에 프로젝트가 변경되면 승인 transaction을 409로 거부하며 쓰기는 0건이다.
- Drive 백업 실패는 outbox 재시도 대상이며 제출 또는 승인 상태를 되돌리지 않는다.

## Drive 사후 백업

기존 프로젝트 관리 Drive 폴더와 outbox worker를 재사용한다. 제출 성공 후 요청별 고정 폴더를 만들고 다음 파일을 저장한다.

```text
프로젝트 관리/
└─ 변경 요청/
   └─ {submittedDate}_{requestId}_v{requestVersion}/
      ├─ 요청내용.json
      ├─ 요청요약.txt
      └─ 제출 첨부 원본들
```

- `요청내용.json`은 request snapshot의 정확한 백업이다.
- `요청요약.txt`는 요청자, 제출시각, 변경 항목, 버전과 첨부 목록을 사람이 읽을 수 있게 기록한다.
- outbox 재시도는 같은 결정적 폴더와 파일 이름을 사용해 중복 사본을 만들지 않는다.
- 완료 후 request에 `driveArchiveFolderId`, `driveArchiveFolderLink`, `driveArchivedAt`만 추가한다.
- 이 세 필드는 승인, 반려, 버전 검증에 사용하지 않는다.

## 기존 요청 정상화

운영 데이터를 변경하기 전에 대상 request 원문과 Firestore `updateTime`을 별도 사본으로 저장한다.

현재 확인된 `targetProjectVersion` 누락 변경 요청 11건은 다음과 같이 처리한다.

- 프로젝트 내용이 제출 기준과 일치하는 7건: 기존 request 원문을 보존하고 현재 프로젝트를 기준으로 canonical `base/target`과 존재하는 첨부 참조를 다시 확정한다.
- 프로젝트가 이후 여러 차례 변경된 4건: 자동 보정하지 않고 현재 프로젝트 기준 재제출 대상으로 둔다.
- 저장소에 존재하지 않는 첨부는 추론하거나 만들어내지 않는다. 실무자가 다시 첨부한다.

정상화는 현재 문서 값과 `updateTime`이 사전 검사값과 같은 경우에만 실행한다. 한 건의 정상화는 그 request에 대해 전부 성공하거나 전부 실패한다.

## 오류 표시

- 첨부 업로드 실패: `첨부파일을 저장하지 못했습니다.`
- 첨부 검증 실패: `제출 파일을 확인할 수 없습니다. 다시 첨부해 주세요.`
- 제출 버전 충돌: `프로젝트가 변경되었습니다. 최신 내용을 다시 불러와 주세요.`
- 승인 버전 충돌: `제출 후 프로젝트가 변경되어 승인할 수 없습니다.`
- legacy stale 요청: `오래된 변경 요청입니다. 현재 프로젝트 기준으로 다시 제출해 주세요.`

일반적인 `요청을 처리하지 못했습니다`로 버전·첨부 계약 오류를 숨기지 않는다.

## 구현 경계

주요 변경 대상은 기존 모듈로 제한한다.

- `server/bff/routes/project-info-drafts.mjs`: 영구 첨부 업로드와 동기 제출
- `server/bff/routes/projects.mjs`: request 기준 조회·승인 및 attachment relocation 제거
- `server/bff/project-request-contract-storage.mjs`: 기존 영구 저장 기능 재사용
- `src/app/components/projects/ProjectMigrationAuditPage.tsx`: request 첨부 원천 고정
- `src/app/components/projects/migration-audit/MigrationAuditDocumentDialog.tsx`: request snapshot 표시
- 기존 테스트 파일과 일회성 정상화 스크립트

관련 없는 프로젝트 편집기, 현금흐름, 정산 모듈은 변경하지 않는다.

## 검증 기준

브라우저 전체 회귀나 에뮬레이터를 늘리지 않고 실제 경로를 잡는 최소 검증만 둔다.

1. 계약서와 견적서를 올린 뒤 제출 응답 직후 관리자 GET에서 두 파일이 보인다.
2. 제출 전에 제거한 파일은 request와 관리자 화면에 나타나지 않는다.
3. 제출 실패 후 같은 idempotency key로 재시도해도 파일 재업로드와 버전 중복 증가가 없다.
4. 승인 성공 시 프로젝트 `vN+1`과 request `APPROVED`가 함께 저장된다.
5. 승인 transaction을 고의로 실패시키면 두 문서 모두 원상태다.
6. 안전한 legacy 요청은 정상화되고 실제 stale 요청은 계속 차단된다.
7. Drive 백업 실패 상황에서도 제출·승인 상태는 유지되고 outbox만 재시도된다.
8. 현금흐름·주정산 관련 diff가 없다.

## 배포 순서

1. 기존 11건과 관련 첨부 참조를 읽기 전용으로 다시 확인하고 사본을 만든다.
2. 코드와 정상화 도구를 같은 PR에 포함한다.
3. CI 성공 후 자동 배포한다. 로컬 production 배포나 일반적인 수동 dispatch는 사용하지 않는다.
4. 안전한 7건만 정상화하고 결과를 재조회한다.
5. 관리자 inbox에서 request snapshot과 첨부 링크를 확인한다.
6. Drive 사후 백업은 이후 outbox가 생성하며 배포 성공 조건에 포함하지 않는다.

## 완료 조건

- 신규 변경 요청은 제출 성공 직후 관리자에게 동일한 값과 첨부로 보인다.
- 승인은 제출 snapshot 하나만 프로젝트에 반영한다.
- 버전과 첨부의 나중 동기화가 승인 정확성에 관여하지 않는다.
- 운영의 안전한 기존 요청은 승인 가능하고 stale 요청은 자동 승인되지 않는다.
- Drive는 조회 가능한 사본을 제공하지만 Firestore와 경쟁하는 두 번째 원장이 되지 않는다.
