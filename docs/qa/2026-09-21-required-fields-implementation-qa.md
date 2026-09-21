# 필수값 개선 독립 QA — 진행 검증

2026-09-21. 실무자 등록·수정 제출과 임시저장을 대상으로 검증했다. 운영 API/Firestore에 쓰지 않았으며 주정산·월결산은 수정하지 않았다. 이 문서는 전체 배포 승인 판정이 아니라 아래 범위의 실제 증거를 기록한다.

## 통과한 실제 경로

### 브라우저

실제 `ProjectEditorWizard`와 `ProjectSubmissionResponses`를 브라우저에서 렌더하고 사용자처럼 클릭·저장했다. 인증/저장소는 격리 provider와 저장 콜백으로 대체했으므로 운영 로그인·네트워크 저장 전체 E2E로 보지 않는다.

- 제안서 원본, 제안서 링크, 발표자료 링크, RFP의 4개 `해당 없음` 체크 → 임시저장 콜백에 4개 사유 모두 `해당 없음`으로 전달.
- 사업관리 폴더·기타 메모·실제 투입인력 5개 항목에서 총 7개 명시적 `NOT_APPLICABLE` 응답 선택 → 저장 콜백 보존.
- 보험·퇴직금·고객사 정산 기준 3개 확인 항목을 아니오/해당 없음으로 선택 → boolean false 보존.
- 금액을 입력하지 않은 상태의 필수 오류는 유지되지만 임시저장 가능.
- 제안서 링크에서 해당 없음 선택→링크 입력→해당 없음 해제→임시저장: 입력 링크가 삭제되지 않고 그대로 저장됨. `link-preservation.json` 참조.
- 페이지 JavaScript 오류 0. 실제 스크린샷을 육안 확인했다.

근거: `/tmp/myscube-required-qa-browser/result.json`, `responses.png`. 재현 스크립트 `/tmp/myscube-visual-audit/required-qa-browser.mjs`. 최초 실행은 인증 context를 노출하는 격리 harness 설정 누락으로 실패했고, 실제 제품 코드 변경 없이 harness export를 복구한 뒤 재실행했다. 업로드 capability가 없는 harness에서는 선택 서류 UI가 렌더되지 않아 capability를 추가하고 4개 체크를 다시 확인했다.

### 실제 BFF 서비스 및 트랜잭션 fixture

`server/bff/routes/project-info-drafts.test.mjs` 56개, `project-registration-drafts.test.mjs` 77개: **133/133 PASS**. 로그 `/tmp/required-draft-tests.log`.

- 미입력 이자 정책의 초안 저장·재조회는 성공, 최종 제출은 필드 오류, 원래 초안은 보존.
- 과거 금액 양수만 보고 입력 플래그를 추론하던 테스트를 새 정책에 맞춰 변경: 명시 입력 플래그가 없는 실제 제출은 거절하며 프로젝트/승인 요청을 만들지 않고 초안 그대로 유지.
- 해당 없음 4개 첨부 응답, 인력/폴더 응답, 확인 사항 false가 실제 저장→재조회→최종 제출 스냅샷까지 일치.
- 새 이력 API: 등록 revision 0→1, 수정 0→1→2 저장 이력에 raw 공백 보존. 다른 소유자는 조회 차단, history 읽기 전후 DB 불변.
- 이전 첨부 참조 위조·제거 및 오래된 revision 거절 테스트 유지.

정상 fixture는 누락된 원가·플래그·명시 응답을 실제 값으로 보강하고 연간 합계/입금계획을 일치시켰다. 의도적인 null/음수/누락 override는 자동 보정하지 않는다. 이전 정상 fixture의 계약금액 구성합 자체가 맞지 않았던 경우를 수정했으며 실제 제품 입력에서 금액을 역산하는 코드로 적용하지 않았다.

## 아직 별도로 완료할 검증

- 전체 BFF 통합 suite 결과는 담당 구현자가 별도 확인한다. 본 QA의 등록·수정 초안 Firestore emulator 통합 14개는 아래 추가 결과와 같이 통과했다.
- 필수 공통 계약과 UI의 실제 최종 제출 전 구간/관리자 승인 화면 통합 회귀.
- 직접 projects upsert 경로에서 업무 필드 수정 우회와 운영 필드만 수정하는 정상 호출을 구별하는 회귀. 전체 객체를 보내는 기존 호출을 키 존재만으로 차단하면 안 된다.
- 버전 이력의 첨부 보존/복원은 별도 경계다. 새 숫자/본문 이력 저장을 과거 파일 전체 복원 완료라고 표현하면 안 된다.

## 임시저장 버전 패널 추가 독립 검증

실제 `ProjectDraftVersionPanel` 브라우저 렌더에서 5개 확인: 이전 버전 선택 시 필드 차이, null과 0 구분, 누락과 false 구분, 선택 시 작성 중 입력 불변, 조회 실패 시 기존 비교 내용과 입력 불변. JavaScript 오류 0. `/tmp/myscube-required-qa-browser/version-result.json`, `version-panel.png`를 확인했다.

Portal 등록·수정 저장 ACK는 `serverRecord`만 갱신한다. 편집기의 `initialDraft`를 매 저장 응답으로 교체하지 않으므로 이전 요청의 ACK가 뒤늦게 도착해 작성 중 값을 되돌리는 경로를 추가하지 않았다. 저장은 기존 편집 임대 확인과 직렬화 큐를 유지한다. 이력 조회는 서버의 본인 초안 소유권 검사를 거치고, 패널의 선택·오류 처리에는 입력 변경 콜백이 없다.

잔여 표현 점검: `contractEndUndecided`처럼 기존 라벨 맵에 없는 키가 직접 표시되는 사례를 발견하여 담당자에게 한국어 라벨 보완 요청했다. 조회는 최근 20개이므로 모든 과거 버전을 열람할 수 있다고 안내하지 않아야 한다. 첨부 이력 목록 비교와 첨부 원본 복원은 구별한다.


## Firestore emulator 추가 검증 완료

`project-registration-drafts.integration.test.ts` 8개 + `project-info-drafts.integration.test.ts` 6개: **14/14 PASS**. `/tmp/required-draft-integration.log`, demo-required-qa / localhost:8188의 격리 Firestore에서 실제 API 요청·영속 문서·승인 적용을 검증했다.

검증 중 임시저장 이력의 회차 구분이 작성자+시각으로만 결정되어 동일 시각 재열기에서 이전 revision과 충돌하는 실제 회귀를 발견했다. fixture 시각을 임의로 늦춰 숨기지 않고, 담당 구현자가 새 회차에 독립 historyGeneration을 부여하도록 수정한 뒤 같은 테스트가 통과했다. 초안 하위 이력 컬렉션 추가에 맞춰 emulator 테스트 초기화도 재귀 삭제로 변경했다. 운영 삭제 작업이 아니다.

정상 계약·입금 합계/명시 플래그 fixture와 선택 파일 해당 없음 응답을 보강했다. 기존 날짜·수치·필수 첨부 오류는 기존 검증 경로의 `project_registration_invalid`를 유지하고 새 완전성 오류만 `project_submission_incomplete`로 검증한다.

## 루트 최종 회귀 결과

- 전체 단위 테스트: 4,334 PASS, 282 SKIP (`/tmp/myscube-required-full-final3.log`). 통합 전용 테스트는 별도로 실행했다. 이후 추가된 이력 회차 회귀는 담당자 139개 집중 테스트로 확인했다.
- 전체 BFF Firestore/Auth 통합: 266 PASS, 3 SKIP. 별도 Storage rules 3 PASS. 공식 `npm run bff:test:integration` 종료 코드 0 (`/tmp/myscube-required-integration-final.log`).
- `npm run typecheck`: 기존 기준선 187개 대비 신규 오류 없음. 기준선을 늘리지 않았다.
- `npm run build`: 성공 (`/tmp/myscube-required-build-final4.log`). 기존 대형 청크 경고는 남아 있다.
- `git diff --check`: 통과. 주정산·월결산·JVM 소스, 운영 데이터 및 배포 설정 변경 없음.

운영 로그인과 실제 사용자 초안의 쓰기/승인은 수행하지 않았다. 제품 컴포넌트 브라우저 검증은 격리된 저장 콜백/API fixture이며, 실제 지속성은 BFF 서비스와 Firestore 에뮬레이터에서 별도로 검증했다. 이번 변경은 작업 트리에 구현됐고 아직 배포하지 않았다.
