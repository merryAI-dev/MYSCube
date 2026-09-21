# 개인 초안 보존 S1/S2 — 경로와 QA gate

## G1 현행 경로

신규 등록은 `PortalProjectRegister.persistDraft`, 기존 수정은 `PortalProjectEdit.persistDraft`가 위저드의 초안을 받아 `buildProjectRequestPayloadFromDraft`를 거쳐 draft client save를 호출한다. 최종 제출용 serializer를 개인 초안 저장에도 사용한다. serializer는 문자열 trim, enum/날짜/숫자/정산 필드 정규화 및 필드 선별을 수행한다.

두 draft route의 update는 JSON payload를 검증한 뒤 그대로 저장한다. owner 확인, lease/fence, expectedDraftRevision, idempotency, audit를 transaction 안에서 처리한다. 초안 저장으로 원장 또는 요청을 만들지 않는다. 첨부는 독립 attachmentRefs가 정본이며 upload/remove도 revision을 증가시킨다. 프론트 mutationQueue는 save/upload/remove/submit 순서를 직렬화한다.

위저드는 유효하지 않은 숫자를 별도 amountInputs에 유지하고 원격저장을 차단한다. 기존 로컬 복구 경로도 amountInputs를 저장한다. 이번 작업은 이를 숫자0으로 치환하거나 새 서버 입력 형식을 추가하지 않는다. 늦은 save 응답은 draft 자체를 set하지 않는다. 서버 확인 후 fingerprint를 갱신하며 로컬 입력 fingerprint가 같을 때만 saved를 표시한다. 서버 save 이전 성공 표시는 하지 않는다.

최종 제출 전 최신 개인초안을 저장하고 그 revision으로 제출한다. 제출 실패에서는 위저드가 로컬 초안을 지우지 않는다. 서버는 validation/transaction 실패 시 초안·원장·요청·lease를 그대로 유지한다. 성공 후에만 submitted metadata 및 요청/outbox가 commit된다. 동일 idempotency key 재시도는 동일 결과를 재생한다.

## 독립 pass 기준

- 초안 serializer는 현재 editor state의 업무값과 선택 해제를 정확히 복제하고 최종 제출 정책 검증과 분리한다.
- ACK 지연 중 추가 입력을 저장된 것으로 표시하거나 이전 값으로 되돌리지 않는다.
- upload/remove 이후 refs 및 새 revision을 다음 save/submit에서 사용하며 이전 제출본 blob을 지우지 않는다.
- 실패한 최종 제출은 입력·첨부·개인초안을 보존한다.
- 충돌/다른 actor/다른 fence는 기존대로 거절하며, 실패가 초안 삭제로 이어지지 않는다.
- invalid 숫자 원격저장 차단을 유지한다. 테스트가 invalid를0으로 저장하는 구현을 통과시키지 않아야 한다.

## 수정 전 독립 실행

2026-09-21 임시 mirror `/tmp/myscube-draft-preservation.xeUpUC`에서 실제 source 및 route tests를 실행했다. repository의 tracked node_modules symlink는 변경하지 않았다.

```text
node node_modules/vitest/vitest.mjs run \
 server/bff/routes/project-info-drafts.test.mjs \
 server/bff/routes/project-registration-drafts.test.mjs \
 src/app/platform/project-input-preservation.test.ts \
 src/app/components/projects/project-editor-reset.test.ts

4 files passed; 143 tests passed
registration 75, info 52, financial input preservation 13, reset 3
```

이 결과는 실제 handler를 호출한 격리 저장소 테스트다. 운영 저장 또는 Firestore emulator/browser flow 통과로 확대 해석하지 않는다. 지연 ACK의 사용자 브라우저 검증은 별도 gate다.

## G1 판정 및 구현 범위

독립 QA가 전용 개인초안 serializer 방향을 승인했다. `serializeProjectEditorPrivateDraft`는 기존 editor 기본형의 업무키만 골라 JSON 복제하며 최종제출용 trim을 하지 않는다. 등록 create/save와 수정 save를 연결했다. 숫자 NaN/Infinity는 JSON null 변환 전에 거절한다. UI raw amountInputs, 인증/lease 등 추가 키는 서버초안으로 보내지 않는다.

최종제출 serializer는 유지한다. 현재 editor state를 만들기 전의 기존 정산 모드 정규화·연도 생성 정책까지 원시 저장본으로 복구하는 작업은 하지 않았다. 이 경계 때문에 모든 역사적 필드의 무변환 저장을 보장한다고 해석하면 안 된다.

추가 테스트는 개인초안 텍스트/명시해제 보존, 최종제출 trim 유지, 복제 후 참조분리, 비업무키 제외, NaN/Infinity 거절 및 실제 신규/수정 handler save→owner get→editor 재열기를 검증한다. 첨부refs와 원장이 저장 중 바뀌지 않는지도 비교한다. 최종 결과는 독립 G2/G3 검증과 합산한다.

격리 검증 결과: 기준 HEAD의 projects.mjs와 이번 초안 변경을 조합한 mirror에서 6개 파일159/159 통과했다(개인초안5, 등록route76, 수정route53, 등록shell9, 숫자보존13, reset3). 공유 작업중 projects.mjs의 일시적 ReferenceError는 별도 발견하여 담당자에게 전달했으며 통합판정에 포함하지 않았다.

사보타주: 임시 mirror에서만 전용 serializer를 이전 최종제출 serializer로 되돌리니 신규 serializer 테스트5개 중4개가 실패했다(텍스트변환 및 비유한수치 처리). 임시 변경은 복구했고 저장소 제품코드는 건드리지 않았다. 전체 UI/browser 통과는 아직 별도다.

## 최신 통합 재실행 및 실제 브라우저

공유 `projects.mjs` 수정 반영 후 2026-09-21 13:12 로컬 격리 mirror에서 위 6파일159/159를 다시 통과했다. info 최종보고서 승인 fixture도 실제 review-document GET에서 토큰을 받은 뒤 POST하도록 최신 계약에 맞췄다.

브라우저 검증은 Chromium에서 현재 `ProjectEditorWizard`를 실행하고, 현재 Portal의 `editorDraftFromPrivate`와 `draftForEditor`를 그대로 호출했다. 테스트용 export는 임시 복사본에만 추가했다. 저장 요청은 격리 HTTP 어댑터가 실제 `createProjectInfoDraftService`를 호출하여 lease/revision/idempotency를 통과한 뒤 메모리 저장소에 기록한다. 외부 네트워크는 차단했다.

재현 순서:
1. 프로젝트명을 공백 포함 A로 입력하고 실제 ‘임시저장’ 버튼 클릭.
2. 서버 commit 후 첫 ACK만 보류한 채 프로젝트명을 B로 수정.
3. A의 ACK를 해제해도 입력이 B임을 확인.
4. 후속 자동저장 후 서버 초안에서 공백 포함 B 확인.
5. localStorage를 비우고 페이지를 새로 열어 서버에서 불러온 B를 실제 입력칸과 두 Portal 변환 결과에서 비교.

명령 및 증거:
```text
cd /tmp/myscube-draft-preservation.xeUpUC
node node_modules/vitest/vitest.mjs run server/bff/routes/draft-browser.qa.test.mjs
1 file / 1 test passed
/tmp/myscube-draft-browser-evidence/result.json
/tmp/myscube-draft-browser-evidence/reopened.png
```

재열기 스크린샷을 직접 열어 입력칸과 하단 저장 UI를 확인했다. 페이지 JavaScript 오류는0건이다. 실제 Portal 전체 화면의 인증·client fetch·lease heartbeat까지 수행한 E2E는 아니다. 저장 callback 어댑터의 직렬 큐와 실제 service를 이용했으므로 그 경계는 남는다. 브라우저에서 최종제출 실패/실제 파일 선택 업로드 ACK 경합까지 통과했다고 주장하지 않는다. 해당 인접 회귀는 실제 service route 테스트 근거와 구분한다.

추가 실행(13:17): 실제 info service `addAttachment`로 계약서refs를 새로 만든 뒤 위 저장/재열기를 수행했다. 저장2회 이후 draftRevision3, 두 Portal 재열기 함수의 계약서path가 독립 attachmentRefs와 동일함을 확인했다. 저장소 blob upload/delete는 격리 stub이며 파일 선택 UI의 경합 테스트는 아니다. 확장된 동일 브라우저 테스트1/1 통과, result.json에 attachmentRefsPreserved=true 기록.

독립 QA는 현 editorstate 왕복 및 지연 ACK/서버 재열기라는 범위에서 G2/G3 PASS를 권고했다. 전체 Portal 인증·업로드 ACK 경합·제출 실패 브라우저를 포함하는 포괄 PASS는 아님을 명시했다.
