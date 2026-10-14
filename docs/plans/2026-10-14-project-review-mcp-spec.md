# 프로젝트 제출 서류 정합성 검토 MCP 스펙

- 작성일: 2026-10-14
- 상태: 스펙 확정 전 초안. 단계별 구현과 QA로 보강한다.
- 범위: MYSCube MCP(`mcp.myscguard.app`)에 읽기 전용 도구를 추가한다. BFF에는 **읽기 전용 "첨부 텍스트" 엔드포인트 하나만** 더한다(5.7절). Firestore·운영 원장·기존 저장/승인 경로는 바꾸지 않는다.
- 서류 읽기 경로(결정 2026-10-14): 기본은 BFF가 PDF를 텍스트로 바꿔 주는 경로(B). 텍스트가 거의 없는 스캔본만 사용자가 파일을 대화에 첨부해 AI가 직접 읽는 경로(C). 첨부할 수 없을 만큼 큰 파일은 1차 범위에서 제외한다.
- 실행 환경: Claude, ChatGPT 대화. Google Drive·Sheets는 사용자의 AI 앱 커넥터로 읽는다(EMA Station MCP 회의록과 같은 방식).

## 1. 목표

프로젝트 등록·수정 제출 내용이 첨부 서류(계약서, 고객 사업자등록증, 견적서, 제안서)와 드라이브 자료(참여율 시트, 사업관리 폴더)와 맞는지, 서로 모순이 없는지를 대화 안에서 검토한다. 결과는 근거가 붙은 경고 목록이며 제출·승인을 막지 않는다. 승인은 지금처럼 조직장이 화면에서 한다.

## 2. 하지 않는 일

- 5.7절의 텍스트 엔드포인트 외의 새 BFF API, Firestore 쓰기, 프로젝트·요청·초안 수정, 제출·승인.
- 서버 측 AI 판독. 서류는 대화 안의 AI가 읽는다(BFF는 PDF의 글자 레이어만 꺼낸다. OCR 없음).
- 1차에서 크기 한도(5.7절)를 넘는 파일.
- 법률 자문. 독소조항 검토(6절)는 "검토가 필요한 조항 목록"이다.
- 사업관리 폴더 전체 자동 순회(4단계 전까지).

## 3. 설계 원칙 (레퍼런스)

| 원칙 | 출처 |
|---|---|
| AI가 읽고, 판정은 MCP의 결정적 규칙이 한다. 같은 입력이면 같은 결과. | contract-ops-mcp: deterministic lint, evidence per finding |
| 추출값마다 근거 문장과 신뢰도를 붙인다. 근거 없는 값은 판정하지 않는다. | contract-ops-mcp `extract_contract`(confidence + source) |
| 근거 문장이 실제 서류에 있는지 MCP가 확인한다(출처 검증). 확인할 수 없으면 "미검증"으로 구분한다. | REA Evidence/limitations |
| 서류 본문은 지시가 아니라 데이터다. 결과에 `untrusted_content` 표시를 붙인다. | REA `_meta.provenance.untrusted_content` |
| 문서는 텍스트로 넘긴다. 긴 문서는 쪽 범위로 나눈다. | MCP gdrive 참조 서버(문서→텍스트), REA 페이지 방식 |
| 검토 전에 플레이북(기준)을 먼저 읽게 한다. 기준이 비어 있으면 "임시 기준"으로 표시한다. | claude-for-legal(Apache-2.0) review skills |
| 쓰기는 노출하지 않는다. | contract-ops-mcp: signing human-gated |

## 4. 검토 대상(subject)

| 종류 | 식별자 | 제출값 출처(기존 BFF, 사용자 권한) | 첨부 출처 | 볼 수 있는 사람(BFF가 판단) |
|---|---|---|---|---|
| 제출 요청 | `projectId` + `requestId` | `GET /projects/:projectId/review-document?requestId=` | `GET /project-requests/:requestId/attachments/:kind` | 문서: 담당 구성원·지정 결재자 / 첨부: admin·finance·지정 결재자 |
| 작성 중 등록 초안 | `draftId` | `GET /project-registration-drafts/:draftId` | `GET /project-registration-drafts/:draftId/attachments/:kind` | 초안 작성자 본인 |
| 작성 중 수정 초안 | `projectId`(수정 초안) | `GET /project-info-drafts/:projectId` | `GET /project-info-drafts/:projectId/attachments/:kind` | 초안 작성자 본인 |
| 승인된 프로젝트 | `projectId` | `GET /projects/:projectId/review-document` | `GET /projects/:projectId/attachments/:kind` | admin·finance·담당 구성원·지정 결재자 |

MCP는 권한 판단 코드를 갖지 않는다. BFF 응답(403 등)을 그대로 사용자 문구로 바꿔 돌려준다.

## 5. 도구

모든 도구는 읽기 전용(`readOnlyHint: true`)이다. 서류 내용을 돌려주는 도구는 `_meta.provenance = { untrusted_content: true, source: "project_document" }`를 붙인다.

### 5.1 `project_review_playbook`
- 입력: 없음
- 출력: 검토 순서, 서류별 대조 항목과 판정 기준(7절), 결과 형식, 커넥터로 읽을 것, 하지 말 것, 플레이북 버전.

### 5.2 `project_review_queue`
- 입력: 없음
- 출력: 내가 지정 결재자인 대기 요청(`GET /project-requests/assigned-to-me`), admin·finance는 검토함, 내 작성 중 초안. 각 항목에 subject 식별자, 프로젝트명, 요청 종류, 상태, 제출일.

### 5.3 `project_submission_get`
- 입력: subject(`{ projectId, requestId? }` 또는 `{ draftId }`)
- 출력:
  - `submission`: 대조 대상 필드만(8절). 개인정보 필드는 가린다.
  - `attachments`: 서류 종류별 `{ kind, name, present }`
  - `links`: `participationSheetLink`, `businessManagementGoogleFolderLink`(사용자 커넥터로 읽을 것)
  - `serverReadiness`: 결재 대기 요청이면 BFF `readiness.issues`(서버가 이미 아는 문제)
  - `reviewToken`(요청 버전 식별. 검토 결과에 같이 남긴다)

### 5.4 `project_attachment_text`
- 입력: subject, `kind`, `pages?`(예: `"1-10"`)
- 처리(경로 B): 5.7절 BFF 텍스트 엔드포인트를 사용자 권한으로 부른다. 응답의 `sha256`을 `textRef`로 삼고, 쪽별 텍스트를 KV `pdftext:<sha256>`에 1시간 둔다. 같은 `textRef`의 다음 쪽 범위 요청은 KV에서 준다(BFF 재호출 없음, 단 grant 확인. 10.3절). 쪽마다 `[p.N]` 표시.
- 출력: `{ kind, name, pageCount, pages: "1-10", text, textRef, textQuality: "ok"|"sparse", nextPages? }`
- `sparse`일 때(경로 C, 스캔본 추정):
  - 텍스트 대신 "이 서류는 글자 레이어가 거의 없어 직접 읽을 수 없습니다. MYSCube에서 파일을 내려받아 이 대화에 첨부해 주세요"라고 안내하고, MYSCube 화면의 해당 서류 위치를 알려 준다.
  - MCP가 별도 내려받기 링크를 만들지는 않는다(파일 원본을 Worker에 두지 않기 위해).
  - AI가 첨부 파일에서 읽은 값은 `project_review_check`에 `source: "chat_attachment"`로 넘기고, 출처 검증은 "미검증"이 된다.
- 한도: 응답 텍스트는 쪽 범위로 나눈다. 한 번에 돌려주는 글자 수 상한은 MCP 응답 크기 때문에 둔다(기본 40,000자, QA에서 조정).

### 5.5 `project_review_check`
- 입력: subject, `extractions`: 서류별 `{ kind, textRef?, fields: { <field>: { value, quote, page? } } , lists? }`, 출처 종류 `source`: `"attachment_text"`(5.4 경로 B, 기본), `"chat_attachment"`(대화에 첨부한 스캔본, 경로 C), `"connector"`(드라이브·시트 커넥터).
- 처리:
  1. 출처 검증: `source`가 `attachment_text`이면 `textRef`의 텍스트에서 각 `quote`를 정규화(공백·줄바꿈) 후 찾는다. 없으면 그 값은 판정하지 않고 `not_found`로 돌려준다. `chat_attachment`·`connector`는 MCP가 원문을 볼 수 없으므로 `unverified`로 표시하고, 그 값으로 나온 `mismatch`는 `check`로 낮춘다.
  2. 제출값은 MCP가 BFF에서 다시 읽는다(AI가 넘긴 제출값은 믿지 않는다).
  3. 7절 규칙으로 판정한다.
- 출력(결과 계약, REA Evidence·coverage·unknowns 방식 적용):

```jsonc
{
  "review": {
    "reviewId": "rv_<sha256 앞 24자>",          // 아래 identity 를 정규화한 JSON 의 해시. 같은 입력이면 같은 id
    "identity": {
      "subject": { "type": "request", "projectId": "...", "requestId": "..." },
      "reviewToken": "...",                        // BFF 가 준 요청 버전 식별
      "documents": [{ "kind": "contract", "sha256": "...", "source": "attachment_text" }],
      "rulesVersion": "project-review-rules@1",
      "extractor": "bff-pdfjs@5.4.624"            // 경로 B. 경로 C·커넥터는 "chat"·"connector"
    },
    "createdAt": "ISO-8601"
  },
  "summary": { "mismatch": 0, "check": 0, "match": 0, "unknown": 0 },
  "coverage": [                                    // "문제 없음"과 "확인 못 함"을 섞지 않는다
    { "kind": "contract", "status": "complete" | "partial" | "unknown",
      "checkedFields": ["contractAmount", "..."], "missingFields": [{ "field": "...", "reason": "..." }] }
  ],
  "findings": [{
    "findingId": "f_<hash>", "status": "mismatch" | "check" | "match",
    "documentKind": "contract", "field": "contractAmount", "label": "계약금액",
    "submitted": "110,000,000원", "document": "120,000,000원",
    "quote": "총 계약금액: 120,000,000원", "page": 1,
    "evidence": "verified" | "unverified" | "not_found",
    "rule": "amount.exact", "message": "..."
  }],
  "unknowns": [                                    // 해결될 때까지 남는 확인 사항
    { "unknownId": "u_<hash>", "kind": "contract", "question": "스캔본이라 금액 근거를 확인하지 못함", "resolveBy": "대화에 파일 첨부" }
  ],
  "limitations": ["BFF 변환은 글자 레이어만 읽는다(OCR 없음)", "..."]
}
```

- 규칙:
  - `coverage.status`: 서류의 대조 항목을 모두 판정했으면 `complete`, 일부만이면 `partial`, 서류를 못 읽었으면 `unknown`. **`findings`에 `mismatch`가 없어도 `coverage`가 `complete`가 아니면 "문제 없음"이라고 말하지 않는다**(플레이북에 명시).
  - `reviewId`·`findingId`·`unknownId`는 내용 해시로 만든다. 같은 서류·규칙·제출 버전이면 같은 id가 나와 재현과 비교(S2 재제출 비교)에 쓴다.
  - 오류는 공통 형식 `{ error: { code, message, retryable, remediation, partial? } }`로 돌려준다(REA error contract 방식).

### 5.6 서류와 입력 텍스트 간 조회·분석

숫자·날짜·기관명처럼 규칙으로 맞출 수 있는 항목(7절)과 별도로, 사람이 쓴 텍스트 항목이 서류 내용과 맞는지 본다.

- 대상 입력 텍스트: `projectPurpose`(프로젝트 목적), `description`(주요 내용), `officialContractName`, `paymentPlanDesc`(기타 메모), 인력의 `role`(역할) 등.
- **조회** `project_attachment_search`
  - 입력: subject, `query`(입력 텍스트 또는 핵심어), `kinds?`
  - 처리: 5.4에서 만든 쪽별 텍스트(KV)에서 찾는다. 정확 일치와 정규화(공백·법인 표기) 일치, 핵심어 겹침 순으로 쪽 번호와 앞뒤 문맥을 돌려준다.
  - 출력: `{ query, hits: [{ kind, page, snippet, match: "exact"|"normalized"|"keywords" }], searchedKinds, notSearched: [{ kind, reason }] }`
  - 용도: "제출한 목적 문장이 제안서 어디에 근거하는가", "계약서에 이 과업이 있는가" 같은 질문에 서류 위치로 답한다.
- **분석**
  - AI가 입력 텍스트와 조회 결과를 비교해 판단하고, 판단마다 서류 인용을 붙여 `project_review_check`의 `textFindings`로 넘긴다.
  - `textFindings` 항목: `{ field, judgement: "supported"|"partially"|"not_found"|"conflicts", quote, page, kind, note }`
  - MCP는 인용의 출처를 검증하고, 텍스트 판단은 **자동으로 `mismatch`로 만들지 않는다.** `conflicts`·`not_found`도 `check`(사람 확인)로 표시한다. 의미 판단은 AI의 해석이라 규칙 판정보다 약한 근거이기 때문이다.

### 5.7 BFF 첨부 텍스트 엔드포인트 (유일한 BFF 변경)

- 경로: 기존 첨부 다운로드 경로마다 `/text`를 붙인다(2026-10-14 구현 중 수정 초안 경로가 빠져 있던 것을 발견해 4곳으로 늘림).
  - `GET /api/v1/project-requests/:requestId/attachments/:kind/text`
  - `GET /api/v1/project-registration-drafts/:draftId/attachments/:kind/text`
  - `GET /api/v1/project-info-drafts/:projectId/attachments/:kind/text`
  - `GET /api/v1/projects/:projectId/attachments/:kind/text`
- 권한: 같은 경로의 기존 다운로드와 **같은 함수**로 판단한다. 다운로드를 할 수 없는 사람은 텍스트도 받을 수 없다. 기존 다운로드 라우트의 동작은 바꾸지 않는다.
- 처리: 파일을 읽어 SHA-256을 계산하고, PDF이면 기존 `server/bff/pdf-text.mjs`와 같은 pdfjs로 쪽별 텍스트를 만든다. AI 호출과 OCR은 없다.
- 응답: `{ kind, name, contentType, size, sha256, pageCount, pages: string[], quality: "ok"|"sparse", reason? }`, `cache-control: private, no-store`.
- 한도(1차): 파일 30MB, 300쪽. 넘으면 텍스트를 만들지 않고 `reason: "too_large"`로 답한다. PDF가 아니면 `reason: "not_pdf"`.
- 쓰기 없음. 감사 로그가 필요한지는 S1 리뷰에서 결정한다(2026-10-14 확인: 기존 첨부 다운로드 라우트 세 곳 모두 감사 로그를 남기지 않는다).

## 6. 독소조항 검토 (5단계)

- 플레이북에 MYSC 판매 측(용역 수행) 기준을 둔다: 치명 조항(deal-breaker), 표준 입장, 허용 대안, 불가 조항, 법무 검토로 넘기는 기준.
- 결과는 조항 원문 인용, 쪽, 심각도, 사업 영향, 수정 문안. 인용은 5.5와 같은 출처 검증을 거친다.
- 기준 값(예: 지체상금 상한)은 사업팀·법무가 정한다. 정하기 전에는 모든 결과에 "임시 기준" 표시.

## 7. 대조 규칙

판정: `mismatch`(서류 값과 제출값이 다름, 근거 검증됨), `check`(읽지 못함·근거 미검증·비슷하지만 다름), `match`.

| 서류 | 항목 | 제출 필드 | 규칙 |
|---|---|---|---|
| 계약서 | 공식 계약명 | `officialContractName` | 기관명 정규화 후 포함 관계면 일치, 2-gram 유사도 ≥0.85 일치, ≥0.5 확인 필요, 미만 다름 |
| 계약서 | 계약 상대방 | `clientOrg` | 법인 표기(주식회사, (주), ㈜, 재단법인, (재) 등)·공백 제거 후 포함 관계 |
| 계약서 | 시작일·종료일 | `contractStart`, `contractEnd`, `contractEndUndecided` | 날짜 일치. "종료 기간 없음"인데 서류에 종료일이 있으면 다름 |
| 계약서 | 계약금액 | `contractAmount` | 원 단위 일치. 서류에 총액이 없으면 공급가액+부가세. 통화가 KRW가 아니면 확인 필요 |
| 계약서 | 부가세 | `salesVatAmount` | 원 단위 일치 |
| 계약서 | 대금 지급 | `paymentPlan` | 합계가 다르면 다름, 합계는 같은데 회차 구성이 다르면 확인 필요 |
| 사업자등록증 | 상호 | `clientOrg` | 기관명 규칙 |
| 사업자등록증 ↔ 계약서 | 상호 ↔ 상대방 | (서류 간) | 다르면 다름(다른 기관 서류 첨부 의심) |
| 견적서 | 수신처 | `clientOrg` | 기관명 규칙 |
| 견적서 | 총액 | `contractAmount` | 원 단위 일치(총액 없으면 공급가액+부가세) |
| 제안서 | 사업 목적·내용 | `projectPurpose`, `description` | 자동 판정하지 않음. AI 요약을 참고로 붙이고 확인 필요 |
| 제안서 | 투입 인력·참여율 | `teamMembersDetailed[].memberName`, `participationRate` | 이름 정규화 일치, 참여율 일치(%p 차이 표시). 제안서에만 있거나 제출에만 있는 인력 표시 |
| 참여율 시트(커넥터) | 인력·월별 참여율 | `teamMembersDetailed[].monthlyRates` | 월별 값 일치. 시트의 빈칸(null)과 0%를 구별 |
| 제출값 내부 | 금액 구성 | `contractAmount` = `salesVatAmount`+`totalRevenueAmount`+`totalActualCost`+`supportAmount` | BFF 필수값 검증과 같은 식 |

## 8. 개인정보

- 사업자등록번호는 앞 3자리·중간 2자리만 보여 준다. 대표자 성명은 대조에만 쓰고 결과에 넣지 않는다.
- 인력 이름은 대조 결과에 필요한 범위에서만 보여 준다.
- 첨부 원본은 저장하지 않는다. 파생 텍스트는 내용 해시 키로 1시간 보관하고, 사용은 그 파일을 직접 받은 사용자(grant)로 제한한다(10.2·10.3절). 사용량 기록에는 도구 이름·결과만 남는다(기존 규칙).

## 9. 단계와 통과 조건

| 단계 | 내용 | 통과 조건 |
|---|---|---|
| S0 (완료, 경로 변경) | `unpdf`가 Cloudflare Worker에서 동작 | 실제 PDF 3종(텍스트 PDF, 다단 표 PDF, 스캔 PDF)에서 텍스트·쪽수·sparse 판정 확인. Worker 번들 크기가 한도 안. 실측 결과를 이 문서에 기록 |
| S1a | 5.7 BFF 텍스트 엔드포인트 | 기존 다운로드와 같은 권한(허용·거부 사례 테스트와 권한 검사를 끈 사보타주 검증), 기존 첨부 라우트 테스트 무변경 통과, BFF 전체 테스트 통과. 배포 전 사용자 확인 |
| S1 | 5.1~5.5, 계약서·사업자등록증·견적서 | 단위 테스트(규칙, 출처 검증, 권한 오류 전달), 실제 요청 1건 이상을 Claude·ChatGPT 양쪽에서 QA |
| S1.5 | 5.6 조회(`project_attachment_search`)와 텍스트 분석(`textFindings`) | 목적·주요 내용 문장의 근거 위치를 찾는지, 근거 없는 판단이 `check`로만 나오는지 QA |
| S2 | 제안서 인력·참여율, 참여율 시트(커넥터) | 다년도·월별 참여율·null/0 구별 사례 QA |
| S3 | 사업관리 폴더(커넥터) | 폴더 규칙 정의 후 진행 |
| S4 | 독소조항 플레이북 | MYSC 샘플 계약 2~3건으로 기준 확정 후 진행 |

각 단계는 QA 결과(실측, 실패 사례, 한계)를 이 문서 끝 "QA 기록"에 남긴다. 실패 gate는 건너뛰지 않는다.

## 10. 상태·네트워크 설계

### 10.1 확인한 사실 (2026-10-14, 코드 기준)
- BFF 첨부 응답 헤더는 `content-type`, `content-length`, `cache-control: private, no-store`, `content-disposition`뿐이다. **ETag·Last-Modified가 없어** HTTP 조건부 요청(304)으로 변경 여부를 알 수 없다.
- 첨부 객체 경로는 업로드 때 `randomUUID()`가 붙어 새로 생기고, 초안→프로젝트 이관은 같은 객체 이름으로 복사한다. 경로가 사실상 업로드마다 고유하지만, 같은 경로의 내용 불변을 보장하는 코드는 없다.
- BFF는 Vercel `iad1`(미국 동부)에서 돈다. MCP Worker는 기본적으로 사용자와 가까운 곳(한국)에서 돈다. BFF 호출 한 번마다 태평양 왕복이 생긴다.
- MCP 전송은 상태 없는(stateless) Streamable HTTP다. 요청마다 서버 객체를 새로 만든다.

### 10.2 캐시: 내용 주소(content-addressed) 방식
- PDF 파싱은 BFF가 한다(5.7절). Worker는 파싱하지 않으므로 Worker CPU 한도 문제는 없다(S0 측정 참고).
- **키는 경로가 아니라 내용 해시다.** BFF가 돌려준 `sha256`을 `textRef`로 쓰고, 쪽별 텍스트를 KV `pdftext:<sha256>`에 1시간 둔다.
- 첫 요청은 항상 BFF를 거친다. 그 단계에서 BFF가 권한을 판단하므로 캐시가 권한을 우회하지 않는다. 이후 같은 `textRef`의 쪽 범위·검색 요청만 KV에서 처리하고, 이때는 grant(10.3절)로 같은 사용자인지 확인한다.
- 내용이 바뀌면 해시가 바뀌므로 ETag가 없어도 낡은 캐시가 생기지 않는다.
- `no-store`의 뜻은 지킨다. 원본 PDF는 Worker에 두지 않고, 파생 텍스트만 1시간 둔다. 이 예외는 이 절에 명시한다.

### 10.3 세션과 상태
- MCP 클라이언트(ChatGPT·Claude)의 세션 유지나 쿠키에 기대지 않는다. 클라이언트마다 재연결·세션 처리가 다르고, 현재 전송은 상태가 없다.
- 대화 사이의 상태는 **명시적 핸들**로 넘긴다. AI가 받은 `textRef`를 다음 도구(`project_attachment_search`, `project_review_check`)에 그대로 넘긴다.
- 핸들 남용 방지: 첨부를 받을 때 `grant:<uid>:<sha256>`(1시간)를 함께 남긴다. 검색·출처 검증은 이 grant가 있는 사용자만 그 텍스트를 쓸 수 있다. 해시를 다른 사람에게 전달해도 그 사람은 쓸 수 없다.
- 쿠키는 MCP 경로에서 쓰지 않는다. BFF 인증은 Bearer(Firebase ID 토큰)이고, Worker가 토큰을 갱신한다(기존 구조).

### 10.4 응답 수신과 파싱
- **크기 상한을 먼저 본다.** BFF 텍스트 응답(JSON)도 300쪽이면 수 MB가 될 수 있다. `content-length`가 상한(8MB)을 넘으면 받지 않고, 헤더를 믿지 않고 본문을 스트림으로 읽으며 누적 바이트가 상한을 넘는 순간 중단한다(Worker 메모리 128MB 보호). 상한은 S1에서 실측 후 조정한다.
- **형식 확인**: 응답이 `application/json`이고 스키마(`sha256` 64자 16진수, `pages`는 문자열 배열, `pageCount`와 길이 일치)가 맞을 때만 쓴다. PDF 판별(시그니처 `%PDF-`)은 BFF가 한다.
- **오류 응답**: BFF는 오류를 JSON(`{ error, code }`)으로 준다. 상태 코드별로 사용자 문구를 정한다. 403(권한), 404(없음), 409(첨부 미준비), 그 밖은 "잠시 후 다시".
- **재시도**: GET만, 429·502·503·504일 때만, 최대 2회, `Retry-After`를 따르고 없으면 지수 백오프와 지터. 4xx는 재시도하지 않는다.
- **시간 예산**: 도구 하나에 전체 시간 한도를 두고, BFF 호출마다 남은 예산 안에서 `AbortSignal.timeout`을 건다.
- **MCP 응답 예산**: 텍스트는 쪽 범위로 나눠 한 번에 40,000자 안에서 돌려주고 `nextPages`를 준다. 서류 본문이 들어간 결과에는 `untrusted_content` 표시를 붙인다.

### 10.5 지연(latency)
- 도구 하나가 BFF를 여러 번 부르면 태평양 왕복이 쌓인다. 예를 들어 제출값 1회와 첨부 3개를 부르면 4회다. 첨부는 병렬로 받는다.
- Cloudflare **Smart Placement**(Worker를 BFF 가까이 배치)를 후보로 둔다. 사용자↔Worker 구간은 조금 늘고 Worker↔BFF 구간은 줄어든다. S1에서 실측한 뒤 결정한다. 이 설정은 기존 MYSCube 도구 전체에 영향을 준다.

## 11. 알려진 위험

- BFF 변환은 글자 레이어만 꺼낸다(OCR 없음). 스캔본은 대화 첨부(경로 C)로만 읽을 수 있고, 그 경로는 출처 검증이 안 된다.
- AI가 값을 잘못 읽을 수 있다. 출처 검증은 "인용이 서류에 있는가"만 확인하며, 인용에서 값을 바르게 읽었는지는 판정 규칙과 사람 확인에 맡긴다.
- BFF 첨부 권한(요청 첨부는 admin·finance·지정 결재자)이 검토 문서 권한(담당 구성원 포함)보다 좁다. 담당 구성원은 제출값은 보이지만 첨부는 못 읽을 수 있다. 그대로 따르고 결과에 표시한다.

## 12. 개발 티켓 (S1, 순서대로 진행)

모두 MYSCube MCP Worker(`mcp-worker/src/`) 안의 작업이다. BFF는 S1a로 끝났고 더 바꾸지 않는다. 티켓마다 단위 테스트와 사보타주 검증을 하고, 결과를 아래 QA 기록에 남긴다. 배포는 T7 끝에서 한 번, 사용자 확인 후에 한다.

| 티켓 | 내용 | 완료 조건 | 의존 |
|---|---|---|---|
| T1 | BFF 클라이언트 보강(10.4절): 응답 바이트 상한(스트림 누적), GET 한정 재시도(429·502·503·504, `Retry-After`, 지수 백오프·지터, 최대 2회), 공통 오류 형식 | 상한 초과 중단, 재시도 대상·비대상, 기존 MYSCube 도구 테스트 무변경 통과 | — |
| T2 | 결과 계약 모듈: `reviewId`·`findingId`·`unknownId` 해시, `coverage` 계산, 요약, 공통 오류 형식, `rulesVersion` | 같은 입력 → 같은 id, 순서만 다른 입력 → 같은 id, coverage 세 상태 | — |
| T3 | 출처 검증: 인용(quote)을 쪽별 텍스트에서 정규화(공백·줄바꿈·전각/반각·하이픈) 후 찾기, 쪽 번호 반환 | 일치·불일치·쪽 경계 걸침·너무 짧은 인용(오탐 방지 최소 길이) | — |
| T4 | 대조 규칙(7절): 보류 브랜치(`b0c72821`)의 BFF 대조 로직을 Worker로 옮기고 결과 계약(T2)·출처 검증(T3)에 맞춤. 근거 미검증 값의 `mismatch` → `check` 강등 | 기존 11개 테스트 의미 유지 + 강등·coverage 테스트 | T2, T3 |
| T5 | 텍스트 캐시와 grant(10.2·10.3절): KV `pdftext:<sha256>`, `grant:<uid>:<sha256>`, 1시간 | 다른 사용자 grant 거부, 만료, 해시 형식 검사 | T1 |
| T6 | 제출값 읽기: `review-document`·초안 조회 응답에서 대조 필드만 뽑기(8절 개인정보 가림), `serverReadiness`, 첨부 목록 | 요청·등록 초안·수정 초안·프로젝트 네 종류, 403·404 전달 | T1 |
| T7 | 도구 5종 등록: `project_review_playbook`, `project_review_queue`, `project_submission_get`, `project_attachment_text`(이어받기 요청 포함), `project_review_check`. `_meta.provenance.untrusted_content`, 사용량 기록 detail 키 | 도구 목록·설명·스키마 테스트, 읽기 전용 표시, 서류 본문 결과에 untrusted 표시 | T1~T6 |
| T8 | 운영 QA: 실제 요청 1건 이상을 Claude·ChatGPT에서 끝까지(검토함 → 제출값 → 텍스트 → 판정). 지연·응답 크기·오탐 기록 | QA 기록 작성, 발견 사항 티켓화 | T7 배포 |
| T9 | (S1.5) `project_attachment_search`와 `textFindings` | 5.6절 | T8 |

S2 이후 티켓(재제출 비교, 제안서·참여율, 사업관리 폴더, 독소조항)은 T8 결과를 보고 정리한다.

## QA 기록

### S0 — PDF 텍스트 변환(unpdf 1.8.1) 검증, 2026-10-14

검증용 PDF는 가짜 내용으로 만들었다(실제 계약서 미사용): 한글 계약서 2쪽, 표가 있는 제안서 1쪽, 이미지만 있는 스캔본 1쪽, 표·문단 반복 80쪽(2.5MB).

| 확인 | 결과 |
|---|---|
| Node 24 | 한글·쪽 구분·표 행 유지. 스캔본은 빈 텍스트, `sparse` 판정 |
| workerd(`wrangler dev --local`, nodejs_compat) | Node와 같은 결과 |
| 번들 크기(변환 모듈만) | 2,410 KiB / gzip 571 KiB. 기존 MYSCube Worker에 더한 크기는 S1에서 실측 |
| 처리 시간(로컬 측정, 벽시계) | 계약서 2쪽 18~69ms, 80쪽 1.36~1.43초 |
| 쪽 범위만 읽기 | 80쪽 중 10쪽만 읽어도 1.08~1.15초. 비용 대부분이 문서 열기에서 나옴 |
| `disableFontFace` 등 옵션 | 차이 없음 |

판단과 결정:
- (후속 결정 2026-10-14) Worker 파싱 대신 BFF 텍스트 엔드포인트(B) + 스캔본은 대화 첨부(C)로 간다. 아래 Worker 측정은 그 결정의 근거로 남긴다. MCP 브랜치의 `unpdf` 의존성은 되돌렸다.
- 운영 Worker의 CPU 한도에 걸릴 수 있다. 2쪽 계약서도 10ms를 넘으므로 **무료 플랜이면 사용할 수 없다.** Workers 유료 플랜(CPU 기본 30초) 여부를 확인해야 한다. (미확인)
- 문서를 한 번 전체 변환해 쪽별 텍스트를 KV에 보관하고(내용 해시 키, 1시간. 10.2절), 이후 쪽 범위·검색 요청은 KV에서 처리한다. 같은 문서를 반복해서 여는 비용을 없앤다.
- 로컬 측정은 운영 CPU 시간과 다를 수 있다. S1 배포 후 실제 PDF로 다시 잰다.
- 로컬 테스트용 임시 Worker(`.s0-probe/`)는 저장소에 넣지 않는다.

### S1a — BFF 첨부 텍스트 엔드포인트, 2026-10-14 (배포 전)

변경:
- `server/bff/pdf-text.mjs`: `extractPdfPages()` 추가(기존 `extractTextFromPdfBuffer`는 그대로). `isEvalSupported: false`.
- `server/bff/attachment-text.mjs`: 크기(30MB)·쪽 수(300)·PDF 시그니처·SHA-256·sparse 판정. 파서 오류 문구는 돌려주지 않음(`unreadable`).
- 라우트 4곳 `…/attachments/:documentKind/text`:
  - 등록 초안·수정 초안: 기존 다운로드와 같은 `service.readAttachment()` 호출. 기존 라우트 변경 없음.
  - 제출 요청·승인된 프로젝트: 기존 다운로드 라우트 본문을 `loadProjectRequestAttachment()`·`loadProjectAttachment()`로 그대로 옮기고, 다운로드와 텍스트가 같이 부른다. 바뀐 줄은 응답 전송 두 곳뿐.

검증:
| 확인 | 결과 |
|---|---|
| 한글 PDF(가짜 계약서 2쪽)·스캔본·쪽 수 상한 | BFF pdfjs 5.4.624로 텍스트 정상, 스캔본 빈 텍스트, 상한 초과 시 텍스트 미생성 |
| 새 단위·라우트 테스트 | attachment-text 8, 초안 라우트 4, 프로젝트·요청 라우트 6 |
| 사보타주: 크기·시그니처 검사 제거 | 3개 실패 → 복구 후 통과 |
| 사보타주: 초안 텍스트 라우트가 readAttachment 우회 | 2개 실패 → 복구 후 통과 |
| 사보타주: 옮긴 두 함수의 403 검사 제거 | 기존 3개 + 새 2개 실패 → 복구 후 통과 |
| 리팩터링 중 발견 | 체크아웃 라우트 소스 검사 테스트가 "체크아웃~다음 요청 라우트" 구간을 잘라 보므로, 옮긴 함수를 그 구간 밖(체크아웃 앞)에 두었다. 기존 테스트는 고치지 않음 |
| 전체 | `npm test` 4,925 통과, BFF 2,103 통과, `typecheck` 새 오류 없음, `policy:verify` 통과 |

미실행: `bff:test:integration`(에뮬레이터 필요, CI에서 실행), 운영 실측(배포 후).

### T1 — BFF 클라이언트 보강, 2026-10-14
- 호출 방식(`get(path, query)`, `post(path, body)`) 유지, 세 번째 인자로 `maxBytes`. 기본 상한 16MB(기존 도구의 큰 응답 보호), 첨부 텍스트는 호출 때 낮춘다.
- GET만 재시도(429·502·503·504·네트워크 오류, 최대 2회, `Retry-After` 최대 5초, 300·600ms 백오프+지터). 재시도 포함 전체 시간 25초 유지.
- 작성 중 발견해 고친 버그: 재시도 대상 응답의 본문을 먼저 버린 뒤 시간 부족으로 재시도를 포기하면 BFF 오류 메시지가 사라졌다. 재시도를 확정한 뒤에만 버리도록 수정.
- 테스트: 새 7개, MCP Worker 전체 82 통과. 사보타주(본문 먼저 버리기 / POST 재시도) 각각 해당 테스트 실패 확인 후 복구.

### T2 — 결과 계약 모듈, 2026-10-14
- `mcp-worker/src/review/contract.mjs`: 키 정렬 JSON(`stableJson`), `crypto.subtle` SHA-256 기반 `rv_`·`f_`·`u_` id, `coverageFor`, `buildReviewResult`, `reviewError`.
- 결정: `findingId`는 메시지 문구를 빼고(서류·필드·규칙·값·인용) 만든다. 문구를 고쳐도 같은 지적은 같은 id라 재제출 비교(S2)에 쓸 수 있다.
- 결정: 모든 필드를 봤어도 "빠진 항목" 보고가 하나라도 있으면 `complete`가 아니다.
- 테스트: 새 7개, MCP Worker 전체 89 통과. 사보타주(서류 순서 정렬 제거 / 빠진 항목 무시) 각각 실패 확인 후 복구.
