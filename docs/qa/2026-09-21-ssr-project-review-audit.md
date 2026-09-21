# 실저장 자료 기반 컴포넌트 SSR 전수 감사

## 판정

**렌더 실행 gate PASS, 모든 필드 정합성 gate 미완료.** 실제 운영 스냅샷을 실제 React 업무 컴포넌트에 전달하여 HTML 출력을 비교했다. 정적 코드 검색이나 예시 데이터만으로 판정한 결과가 아니다. 다만 브라우저 DOM·픽셀·클릭·접근성·client effect 검증은 아니다.

운영 데이터/파일/API 쓰기는 없었다. 원본 자료·렌더 HTML·개인정보를 저장소에 기록하지 않았다. 루트 node_modules의 기존 broken link는 바꾸지 않았다.

## 실행 방법

격리 사본 `/tmp/myscube-visual-audit`의 패치된 실제 `ProjectEditorWizard`, `MigrationAuditDocumentDialog`, `createProjectEditorDraft`를 Vitest node 환경에서 `react-dom/server.renderToStaticMarkup`으로 실행했다.

- Wizard는 `initialStepIndex=0..3`, `mode=portal-edit`, `readOnly=true`로 네 단계를 각각 렌더했다.
- 실제 포털의 첨부 입력 분기를 재현하도록 `onProjectDocumentFileUpload`에 호출 시 실패하는 noop 대체 함수를 제공했다. 이 prop을 빼면 계약서만 표시되는 분기로 바뀌므로 초기 실행은 보완 후 재실행했다.
- auth/Firebase context는 조회 전용 상수, router의 navigation blocker는 unblocked로 대체했다. Dialog는 SSR portal이 HTML을 내지 않는 문제를 피하기 위해 presentation wrapper만 div로 대체했다. 업무 필드 선택·파생 계산·문서 slot·Wizard 코드는 실제 코드다.
- fetch를 호출하면 실패하도록 설정했으며 실제 호출 0이었다. SSR은 effect를 실행하지 않으므로 이 결과를 실제 브라우저의 네트워크 동작 증명으로 해석하지 않는다.
- 인력 roster와 로그인 사용자 옵션은 제공하지 않았다. 선택지·닉네임·역할 요약과 관련된 raw token 차이는 제품 결함으로 분류하지 않았다.
- Wizard는 저장 snapshot을 `createProjectEditorDraft`로 읽는 재현이다. 사용자가 과거 입력하던 원본 화면 캡처가 아니며 정규화/default의 영향이 포함된다.

## 정확한 실행 범위

| 구분 | 자료 수 | Wizard 렌더 | 승인 문서 렌더 |
|---|---:|---:|---:|
| 프로젝트별 최신 요청(없으면 원장) | 79 | 316 | 79 |
| 모든 요청 이력 | 125 | 500 | 125 |
| 원문 payload가 남은 draft | 89 | 356 | 0 — 초안을 결재에 주입하지 않음 |
| metadata만 남은 draft | 144 | 0 | 0 |

총 1,376회 렌더 호출(프로젝트 최신 요청은 요청 전수에 중복 포함), 예외 0. metadata-only 144개는 제출 draft 59개와 구형 DRAFT 85개다. 이들은 과거 입력을 복원하지 않았다. 모든 draft 233개를 분류했지만 233개 모두 원문 렌더했다고 말하면 안 된다.

최신 요청은 프로젝트 ID에 연결된 requestedAt 기준으로 고른다. request 이력 직접 재현은 운영 review-inbox의 권한·게시 완료 필터를 통과한 현재 목록과 같다는 보장이 없다.

## 렌더 HTML 대조 결과

79개 최신 제출본/원장 재현에서:

- 제출 상태 기반 checkout 노출 79/79 일치.
- 값이 존재하는 프로젝트명·공식 계약명·계약 대상·부서의 원문 token 대조에서 누락 0. 없는 필드를 임의로 채우지 않았다.
- 제출 첨부 이름 172/172, 제안서/발표자료 Drive href 46/46 출력.
- 계산 가능한 선금·중도금·잔금 요약 189/189 일치. 다년도는 연도합을 별도로 계산하여 비교했다.
- 모든 요청 이력 125개는 승인 문서 렌더와 checkout 조건을 추가 확인했다. 모든 과거 요청의 모든 필드 값을 의미적으로 검증한 것은 아니다.

값 token은 같은 문자열이 다른 위치에 있을 수 있다. 따라서 존재 여부는 UI 필드와의 정확한 1:1 연결, 숨김 여부, 클릭 가능성까지 증명하지 않는다. 첨부 파일 본문/다운로드 권한은 별도 BFF 검증 범위다.

## 패치 이후 남은 구체적 확인 사항

### 사업관리 폴더 링크

31개 프로젝트의 선택된 snapshot에서 `businessManagementGoogleFolderLink` 원문이 Wizard HTML에는 있지만 승인 Dialog HTML에는 없다. 해당 Dialog에 이 필드의 표시 경로가 없는 점과 일치한다. 문서 전달 범위에 사업관리 폴더가 포함되어야 한다면 별도 표시 보완이 필요하다. 저장 손실의 증거는 아니다.

### 정산 안내

`settlementGuide` 1개도 Wizard에 존재하고 승인 Dialog에는 원문 token이 없다. 안내 자체의 표시 필요 여부를 확인해야 한다. 정산 로직 변경을 뜻하지 않는다.

### 연도별 행이 없는 과거 다년도 입금 계획

5개 선택 snapshot은 다년도 계약이며 financialYears가 비어 있지만 top-level paymentPlan이 있다. 새 `projectEffectivePaymentPlan`은 연도별 행이 없으면 undefined를 반환해 승인 요약이 `-`가 된다.

대상 ID: `p1773906226325`, `p1775038613330`, `p1784168705457`, `p1784168729314`, `p1784169189118`.

이를 annual 합계 0원이라고 기대했던 초기 감사 assertion은 잘못되어 수정했다. 최종 감사에서는 189개 계산 가능 요약과 이 5개 미계산 사례를 분리했다. 저장된 사업 단위 계획을 연도별 합계로 추정하면 안 되지만, 사업 단위 제출값이 있음을 별도로 표시하고 '연도별 계획 미제출'과 구분하는 방안은 검토할 수 있다. 운영 저장값을 고칠 필요는 없다.

### raw token 비교가 곧 결함이 아닌 항목

내부 ID, 등록·수정 사용자 ID, 인력 원명/닉네임/역할, 구형 teamMembers 문자열 등이 Wizard에는 있으나 Dialog에 raw string 그대로 없을 수 있다. 정규화·요약·개인정보 표시 정책이 있으므로 전부 누락 버그로 계산하지 않았다. 인력 roster 미제공의 영향도 분리해야 한다.

## 재현 산출물과 한계

- `/tmp/myscube-visual-audit/src/ssr-audit.test.tsx`
- `/tmp/myscube-visual-audit/vitest.ssr-audit.config.mjs`
- `/tmp/myscube-review-audit-20260921/ssr-run.log`: 2개 감사 테스트 통과
- `/tmp/myscube-review-audit-20260921/ssr-field-render-audit.json`: 프로젝트별 필드·첨부·링크·입금 대조 boolean, 값 없음
- `/tmp/myscube-review-audit-20260921/ssr-history-draft-audit.json`: 요청/초안별 렌더 가능 여부, metadata-only 분리

두 JSON은 권한 600이다. CUA 연결 실패로 실제 화면 전수 육안 검증은 완료하지 못했다. SSR 출력 확인을 브라우저 시각 PASS라고 표현하지 않는다. 과거 제출 원문이 없는 초안의 유실 여부, 파일 내용, 사용자가 입력했던 당시 화면은 확인 불가다.

## 11:32 KST 재조회 변경분 추가 검증

기존 전수 분모는 최초 evidence 스냅샷 기준으로 유지했다. 11:32:31~34 KST의 별도 `evidence-refresh.json`에서는 원장 79개가 모두 동일하고, `change-p1780048681754` 요청 하나와 연결된 private draft 하나가 변경되었다. 요청 상태는 APPROVED→PENDING, draft는 ACTIVE→SUBMITTED로 바뀌며 payload가 정리되었다. 신규/삭제는 없었다.

해당 새 제출본으로 Wizard 4단계와 승인 문서를 다시 SSR 렌더했다. 프로젝트 선택 경로와 요청 직접 경로 각각 통과(2개 감사 테스트, fetch 0). 새 제출본의 기본값·checkout 조건·첨부 3종·링크·입금 요약 검사는 기존과 동일하게 통과했다. documentChecks 배열 순서만 달라졌으며 첨부 필드와 성공 여부 집합은 같다. 연결 draft는 metadata-only가 되었으므로 원본 재렌더는 수행하지 않았다.

최신 시점 전체 자료의 수치로 환산하면 원문 payload draft는 89→88개, metadata-only는 144→145개, 그중 SUBMITTED는 59→60개다. 최초 전수 렌더 숫자를 새 시점의 원문 렌더 수로 바꾸거나, 새 metadata-only 초안을 입력 원문까지 검증했다고 보고하지 않는다.

추가 산출물: `/tmp/myscube-review-audit-20260921/ssr-refresh-field-render-audit.json`, `ssr-refresh-history-draft-audit.json`, `ssr-refresh-run.log`. 원본 전수 결과는 덮어쓰지 않았다. 포털 첨부 분기용 noop upload prop을 포함한 실행이다.
