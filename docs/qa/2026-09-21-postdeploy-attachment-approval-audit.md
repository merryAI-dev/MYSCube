# 배포 후 첨부·승인 독립 점검

2026-09-21. 대상은 `f571d33aeefce006392543547f5f8b8922ba5feb`의 격리 체크아웃이다. 작업 트리 HEAD는 조사 시 `425e10d5`였으며 첨부 검증·용량 스키마 관련 파일은 대상 SHA와 차이가 없음을 확인했다. 운영 데이터·운영 승인·운영 첨부에는 쓰지 않았다. 제품 코드는 수정하지 않았다.

## 판정

**첨부 요구 전체 완료로 판정할 수 없다. 50MB 및 HWP/HWPX·PPT·Excel 허용은 미반영이다.** 제출된 파일명·Drive 링크가 승인 문서에서 보존되는 경로와 구형 문서 사전 안내는 실제 실행으로 확인했다. 다만 승인 문서의 일부 문구가 여전히 `기록 없음`, `링크 제출`, `해당 없음`을 정확히 구분하지 못한다.

## 실행 근거

- 격리 체크아웃: `/tmp/myscube-attachment-audit.udx1hV`. 운영 환경변수·자격증명을 복사하지 않았다.
- 실제 BFF schema/문서 검증 함수 실행: 크기 경계 **20건**, 문서 슬롯 7종 × 확장자 9종 **63건**, 잘못된 확장자·MIME·헤더 **5건**.
  - 실행 코드: `/tmp/myscube-attachment-audit.udx1hV/attachment-audit.mjs`
  - 원시 결과: `/tmp/myscube-attachment-audit-results.json`
  - 실행 요약: `/tmp/myscube-attachment-audit-execution.log`
- 실제 route·서비스·스냅샷 mapper·업로드 helper: **202개 테스트 통과**.
  - `/tmp/myscube-attachment-approval-tests.log`
  - 실행 대상: `project-document-validation`, `project-review-readiness`, `projects.legacy-attachment`, `project-submission-completeness`, `project-registration-drafts`, `project-info-drafts`, `project-migration-review-dossier`, `project-contract-upload`.
- 실제 React 승인 화면 Playwright: **5개 시나리오 통과**, 13.3초.
  - `/tmp/myscube-attachment-approval-browser.log`
  - 기존 4건: 문서 버전 변경 409·의견 보존·명시적 재조회, 구형 문서 warning, 실제 blocking, 지연 응답 중 문서 닫기.
  - 추가 1건: 한글 파일명·제안서 파일+Drive 링크 동시 표시·발표자료 링크·제출 당시 상태·구형 문서 안내.
  - 추가 시나리오는 승인 쓰기 0회·예상 밖 API 쓰기 0회·브라우저 pageerror 0건을 확인했다. 기존 승인 시나리오의 POST는 격리된 가짜 API에만 전송됐다.

브라우저는 실제 컴포넌트를 실행하되 API 응답은 fixture로 격리했다. 실제 BFF route/저장 경로는 별도 서비스 테스트로 검증했다. 따라서 운영 인증·실제 Cloud Storage 50MB 업로드 성공 또는 현재 모든 운영 프로젝트 전수 재검증을 의미하지 않는다.

## 크기와 확장자: 요청 미충족

실제 schema 결과는 다음과 같다. MB 표시의 실제 기준은 `1024 × 1024`바이트다.

| 경로 | 10MiB | 10MiB+1 | 50MiB-1 | 50MiB | 50MiB+1 |
|---|---|---|---|---|---|
| 신규 등록 첨부 확정 | 허용 | 거부 | 거부 | 거부 | 거부 |
| 프로젝트 수정 첨부 확정 | 허용 | 거부 | 거부 | 거부 | 거부 |
| 신규 등록 업로드 URL 발급 | 허용 | 거부 | 거부 | 거부 | 거부 |
| 프로젝트 수정 업로드 URL 발급 | 허용 | 거부 | 거부 | 거부 | 거부 |

`project-registration-draft-client.ts`, `project-info-draft-client.ts`, `project-contract-upload.ts`의 private draft 제한과 `server/bff/schemas.mjs` 모두 10MiB다. 다른 경로에 1GB 상수가 존재하지만 등록/수정의 private draft 허용 용량을 뜻하지 않는다. 서명 URL을 이용해도 발급·첨부 확정 schema의 10MiB 제한이 유지된다.

| 실제 슬롯 | 실행상 허용된 형식 | 요청 형식 중 차단된 예 |
|---|---|---|
| 계약서·사업자등록증·견적서 | PDF | DOCX, HWP, HWPX, PPT, PPTX, XLS, XLSX |
| 제안서 Word 원본 | DOCX | PDF, HWP, HWPX, PPT, PPTX, XLS, XLSX |
| 제안서/발표자료 PPT 원본 | PPTX | PDF, DOCX, HWP, HWPX, PPT, XLS, XLSX |
| RFP 증빙 | 이번 매트릭스에서 PDF·DOCX | HWP, HWPX, PPT, PPTX, XLS, XLSX |

RFP는 별도로 EML·MSG 허용 코드가 있으며 위 9종 매트릭스에는 포함하지 않았다. 파일 내용의 앞부분만 가진 합성 buffer로 실제 타입 검증기를 호출한 결과이며, 이 결과를 완전한 Office/HWP 문서 파싱 검증으로 확대 해석하지 않는다.

**권고:** 이후 작업에서 등록·수정 프론트의 accept/MIME/크기, 클라이언트, 서명 URL 발급, 첨부 확정, 저장소 검사, 미리보기·다운로드 문구를 하나의 정책으로 묶어 50MiB까지 일치시킨다. 계약서 AI 분석은 PDF 분석 가능 여부와 원본 파일 업로드 가능 여부를 분리한다. 이번 감사에서 제한은 변경하지 않았다.

## 잘못된 파일 검사: 헤더 수준이라는 한계

실제 함수 실행에서 실행파일을 PDF로 이름만 바꾼 경우, PDF 내용과 `.docx` 확장자가 다른 경우, PDF의 MIME이 다른 경우는 거부됐다.

반면 `%PDF-` **5바이트만** 있는 파일과 `PK\\x03\\x04` **4바이트만** 있는 DOCX는 통과했다. 현재 검사는 확장자·MIME·magic header 조합을 확인하며 문서 전체 구조의 정상 여부까지 증명하지 않는다. 손상된 문서가 첨부된 뒤 원문 열기에서 실패할 가능성이 남는다. 전체 구조 검사 도입은 파일 형식 확대와 함께 검토하되, 이 감사에서는 자동 승인·새 서비스 도입·파일 변환을 추가하지 않았다.

## BFF → 승인 문서: 보존 확인과 문구 불일치

실제 서비스 테스트에서 사설 첨부 저장→임시저장→최종 제출→조직장 승인→문서 읽기까지 참조가 보존되고, 임의 다른 경로/테넌트/문서 종류로 바뀐 참조는 차단됨을 확인했다. 기존 첨부의 등록 이전 저장 경로 두 종류도 별도 테스트했다.

실제 브라우저에 다음 두 원본을 의도적으로 다르게 넣었다.

- 현재 원장 상태: `COMPLETED`.
- 제출 스냅샷 상태: `IN_PROGRESS`.
- 제출 파일명: `검증 계약서 원본.pdf`, `제출 제안서 원본.pptx`.
- 제안서 파일과 제안서 Drive 링크를 같은 슬롯에 동시 저장; 발표자료는 Drive 링크만 저장.

승인 문서에서 **`진행 중`**, 두 파일명, 두 링크의 정확한 href를 모두 확인했다. 원장 상태나 다른 문서로 덮이지 않았다. 첨부 표 스크린샷을 직접 열어 육안 대조했다.

증거: `/tmp/myscube-attachment-approval-browser/project-review-version-att-59b03-approval-document-rendering/attachments-links-status.png`

동시에 다음 문구 문제를 발견했다.

1. **발표자료 링크를 정상 제출했는데 `원문` 열은 `해당 없음`으로 표시된다.** 링크 자체는 왼쪽에 정상 표시되어 데이터 누락은 아니지만, 오른쪽만 보면 제출되지 않은 것으로 오해할 수 있다. `링크 열기` 등 실제 제출 상태와 맞추는 것이 적절하다.
2. **구형 제출에서 필드 자체가 없는 사업자등록증·견적서가 본문 표에는 `미제출`로 단정된다.** 상단 readiness는 미기록과 미제출을 구별하도록 안내하지만 본문 표가 그 구분을 따르지 않는다. 필드 부재는 `기록 없음`, 명시적 null은 `파일 연결 없음`, 명시적 해당 없음은 해당 응답으로 구분해야 한다.
3. 선택 첨부의 빈값 표시는 `선택 · 미제출`이다. 새 제출의 `파일/링크 또는 명시적 해당 없음` 정책과 구형 자료 표시는 문서 정책 버전별로 구분하는 것이 바람직하다.

스크린샷의 PDF 미리보기 하단 JSON은 격리 API의 빈 응답 fixture이며 실제 파일 렌더링 성공 증거로 사용하지 않았다. 원본 다운로드 성공 근거는 별도의 BFF 저장소 fixture 테스트다.

## 구형 문서 및 실패 안내

실제 route 22건과 readiness 16건에서 확인한 내용:

- 유효한 구형 문서는 경고만 표시하고 기존 승인 가능성을 유지한다.
- 특정 첨부 접근 실패를 단순 미제출로 단정하지 않고 해당 파일과 조치 방법을 안내한다.
- v2 등록 첨부 이관 미완료, 기준 버전 변경은 승인 전에 차단 사유를 보여준다.
- 이미 승인된 과거 문서를 읽을 때 현재 저장소 검사로 과거 상태를 재판정하지 않는다.
- 검토한 제출본이 바뀌면 승인 쓰기를 409로 막으며 검토 의견을 보존한 채 명시적으로 재조회한다.

브라우저에서 warning/차단의 상세 이유·조치 방법, warning 상태 승인 가능/차단 상태 승인 불가를 확인했다. 스크린샷도 직접 확인했다.

증거: `/tmp/myscube-attachment-approval-browser/project-review-version-rea-c6dc5-y-blockers-disable-approval/readiness-warning.png`

## 최종 범위

- 운영 읽기 전수조사나 실계정 저장·승인 재시도는 하지 않았다.
- 이전 79개 프로젝트 대조 자료는 참고만 했고 이번 SHA에서의 운영 전수검증 완료 근거로 재사용하지 않았다.
- 제품·운영 데이터·주정산/월결산 파이프라인 변경 없음.
- 남은 우선 과제는 **50MiB/파일 형식 정책 일치**, **본문의 미기록·링크·해당 없음 라벨 일치**, **손상 문서 검증 범위 명확화**다.

## 후속 수정 검증 — 첨부 표의 상태 구분

위 감사 후 별도 구현 요청에 따라 승인 문서의 **서류 표 영역만** 수정했다. 최초 감사 판정은 배포 SHA에 대한 기록으로 유지한다. 아래 수정은 작업 트리 기준이며 배포 완료를 의미하지 않는다.

- 원문 파일 또는 링크가 있으면 `제출됨`, 원문 열에 파일 버튼과 `링크 열기`를 각각 제공한다. 파일과 링크가 함께 제출되면 둘 다 유지한다.
- 명시적 `해당 없음`, `이후 제출 예정`, 과거 미첨부 사유, 명시적 빈 항목의 `미입력`, 필드 자체가 없는 `기록 없음`을 구분한다.
- `선택 · 미제출` 문구를 제거했다. 과거의 미첨부 사유는 원문 그대로 표시하고 구형 자료를 현재 정책으로 재판정하지 않는다.
- 원문과 해당 없음 응답이 함께 저장된 과거 자료는 원문을 숨기지 않고 불일치 안내를 표시한다.

검증: mapper 테스트 6개 통과, 실제 React 브라우저 5개 시나리오 통과(10.4초). 테스트 화면에서 파일명·원문 버튼·링크 열기·미입력·기록 없음·명시적 해당 없음·과거 사유가 각각 정확히 표시되는지 직접 스크린샷을 열어 대조했다. 브라우저 API는 fixture이며 운영 쓰기는 없었다.

- 재현 가능한 추가 브라우저 테스트: `tests/e2e/project-review-document-evidence.spec.ts`
- 로그: `/tmp/myscube-attachment-display-fixed-browser.log`
- 육안 확인: `/tmp/myscube-attachment-display-fixed-browser/project-review-version-att-59b03-approval-document-rendering/attachments-links-status.png`

첫 재실행에서는 격리 mirror에 동료가 추가한 재무 표시 helper export가 빠져 화면 로딩이 실패했다. 해당 의존 파일을 동기화한 뒤 재실행해 위 5건이 통과했다. 이를 제품 결함 수정 또는 통과 기록에서 제외한 실패로 혼동하지 않는다. 50MB/확장자·원본 파일 복구·주정산/월결산은 이 수정의 범위가 아니다.
