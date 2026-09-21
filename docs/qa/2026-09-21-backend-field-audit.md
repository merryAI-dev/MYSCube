# 프로젝트 등록·수정·승인 BFF 필드 전수 감사 — 2026-09-21

## 판정과 범위

**#801이 모든 위험을 해결했다고 판정할 수 없다.** 이번 문서는 `ProjectEditorDraft` 76개, `ProjectRequestPayload` 73개, 합집합 **77개 top-level 필드**와 그 하위 정의를 전수 목록화한 **정적 경로 감사 + 캡처 정본 비교**다. 브라우저 육안 확인, 실제 live BFF 응답, 모든 사업의 제출·승인 재실행을 증명하지 않는다. 라이브 쓰기는 수행하지 않았다.

기준 코드: `32fb2699` checkout, 감사 시점의 작업트리 포함. 별도 보존한 50MB 작업은 이번 감사/패치 범위에 포함하지 않는다.

읽기 증거: `/tmp/myscube-review-audit-20260921/evidence.json`, 2026-09-21 10:14:35–10:14:43 KST. projects 79, project_requests 125, projectRequests 0, privateEditDrafts 66, projectRequestDrafts 167건; 수집 메타데이터의 각 complete=true, changedDuringRead=0. 이것은 캡처된 테넌트·컬렉션 범위이며 화면 목록의 가시성과 같다고 가정하지 않았다. 원본 개인정보·링크·토큰을 이 문서에 복사하지 않았다.

승인 완료 + approvedProjectVersion = 현재 project.version인 비교 가능 쌍은 **26개**다. 두 스냅샷에 모두 있는 요청 필드의 값 차이는 contractDocument 7개이며, 하위 차이는 **downloadURL만 7개**였다. 이는 비공개 원문 URL 정리와 양립하며 파일 누락으로 단정할 수 없다. 요청에는 있으나 정본에 없는 비어 있지 않은 항목은 `teamMembers` 요약문 26개다. 후속 변경이 있는 다른 요청과 초안은 같은 버전 비교가 아니므로 오류 건수로 세지 않았다.

## 주요 잔여 위험과 의도된 변환

| ID | 판정 | 원인·영향 | 증거 / 다음 검증 |
|---|---|---|---|
| G1 | 코드상 경로 누락, 사용 흐름 확인 필요 | 관리자 직접 저장 builder는 `finalPaymentNote`를 쓰지 않는다. PM builder·BFF·review diff에는 있다. 관리자 화면에서 이 값을 수정할 수 있는 실제 입력이 존재하는지 확인해야 실제 유실 여부를 확정할 수 있다. | project-editor.ts의 buildProjectEditorProjectPatch / buildProjectRequestPayloadFromDraft. 캡처 정본 14건에 비어 있지 않은 값. |
| G2 | 높은 영향의 정책 불일치 후보 | 관리자 `budgetCurrentYear`는 별도 입력이나 PM 변경 승인 patch는 항상 `contractAmount`로 다시 설정한다. 관계없는 수정 승인도 별도 예산을 덮어쓸 수 있다. | projects.mjs buildProjectPatchFromChangeRequestPayloadInternal. 정본 75건 비영(非零), 계약금액과 다른 값 2건. 다른 값의 정당성·작성 출처 및 재현 확인 필요. |
| G3 | 격리 실행으로 확인한 삭제/해제 버그 (live 사고 미확정) | 사업관리 폴더링크 공백, 비OTHER 정산시스템 설명, `contractEndUndecided=false`가 undefined로 제거된다. Firestore merge가 기존 필드를 유지하므로 '삭제/해제했는데 남는' 경우 가능. | projects.mjs의 stripUndefinedDeep + mergeProjectAndRequestDocs tx.set merge:true. 폴더링크 비어 있지 않은 정본 28건. 아래 격리 실행에서 실제 exported patch + 승인 merge 재현 완료. live 브라우저 확인은 별도. |
| G4 | 검증 공백/정책 확인 | 모든 금액은 타입·양수·입금계획 검증을 받으나 계약금액과 VAT+수익+원가+지원금 구성 합계가 다를 때의 저장 정책은 이번 필드 연결 패치만으로 해결되지 않는다. | assertRegistrationFinancials, assertRegistrationV2PaymentPlan, 연도별 합계 UI를 별도 대조. 라이브 값 변경 없이 사업별 원본 확인 필요. |
| G5 | 범위 밖 지속 위험 | 상태값 계약 전/진행/종료, 등록 당시 값과 현재 정본의 우선순위, 종료사업 체크아웃→주정산→월결산은 필드 연결과 별개 프로세스다. | 본 감사는 필드 전달만 확인. 상태 전환·결산 잠금과 실제 사용자 화면 QA를 별도 gate로 유지. |
| P1 | 구현상 의도된 고정 정책, 업무 승인 여부 별도 | laborTransferPlan은 양쪽 모두 매월 3주차/단계금액 0으로 고정한다. 예전 milestone 값은 그대로 보존하지 않는다. | frontend normalizeLaborTransferPlan / BFF 동일 함수. 캡처 mode 41건 MONTHLY_WEEK_3, 38건 필드 없음. |
| P2 | 의도된 호환 정책 | financialYears[].finalPaymentExpectedWeek는 신규 쓰기에서 제거하고 BFF가 같은 연도의 기존 값만 복원한다. top-level finalPaymentExpectedWeek와 다르다. | projectFinancialYearsForWrite, BFF historicalFinancialWeeks, 기존 회귀 테스트. 캡처 연간 week 비어 있지 않은 값 0건. |
| P3 | 조건부 정책 변환 | 정산 비적용 checkout의 정산보고·USB·삭제 확인은 false로 정규화한다. 저장 상태 판단이 잘못되면 이 조건부 변환도 영향을 받는다. | normalizeProjectCheckout, settlementDetailsEnabled. 순수 누락으로 분류하지 않음. |
| P4 | 의도된 비공개 문서 계약 | FileAttachment.downloadURL은 private refs에서 저장하지 않고 path로 권한 있는 BFF 원문 조회. 문서 메타데이터는 서버가 확인한 attachmentRefs/기존 정본/기존 요청만 신뢰한다. | registrationPrivateDocuments, assertTrustedProjectInfoDocumentReferences. 원문 권한과 실제 파일 존재는 별도 확인. |

## 데이터 경로

PM 수정: ProjectEditorDraft → buildProjectRequestPayloadFromDraft → 소유자 private draft payload/attachmentRefs → BFF 제출 검증 → project_requests.proposedSnapshot/payload → 조직장 승인 version/첨부 검증 → buildProjectPatchFromChangeRequestPayload → projects merge + approvedSnapshot + 참여율 sync. 제출 전에는 정본을 덮어쓰지 않는다.

신규 등록: 동일 client payload → registration draft → buildProjectRegistrationCanonicalDocuments → 등록 요청 payload와 PENDING 정본. 변경 요청과 정본 생성 시점이 다르므로 화면 비교 시 requestKind 구분이 필요하다.

관리자 직접 저장: ProjectWizard → buildProjectEditorProjectPatch → updateProject/addProject. PM 요청 whitelist 경로를 그대로 거친다고 가정하면 안 된다.

## Top-level 77개 필드 매트릭스

`연결`은 해당 소스 매핑에 존재한다는 뜻이며 값 동일성이나 live 성공을 보증하지 않는다. `정본/요청` 숫자는 캡처 객체에 키가 존재하는 건수(정본 79, 요청 125)이고 null도 포함한다. 요청은 proposedSnapshot 우선, 없으면 payload를 읽었다. 임시저장은 일반 payload 저장 및 소유권·revision 검증이고, 필드별 최종 정책은 제출 시점에 적용된다.

| 필드 | Draft→PM payload | 관리자 직접 patch | BFF 제출 snapshot | BFF 승인 정본 | 캡처 정본/요청 키 존재 | 판정·변환 |
|---|---|---|---|---|---|---|
| `name` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `officialContractName` | 연결 | 연결 | 연결 | 연결 | 79/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `type` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `description` | 연결 | 연결 | 연결 | 연결 | 77/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `clientOrg` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `businessManagementGoogleFolderLink` | 연결 | 연결 | 연결 | 연결 | 28/79 · 49/125 | 빈 문자열 → undefined 제거. merge 저장이면 기존 링크 삭제 불가(G3). |
| `participationSheetLink` | 연결 | 연결 | 연결 | 연결 | 40/79 · 45/125 | 공백 제거, 변경/인원별 월율 존재 시 링크 필수 검증. 빈 값 제거와 삭제 정책 확인. |
| `department` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `projectPurpose` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `status` | 연결 | 연결 | 연결 | 연결 | 79/79 · 88/125 | 허용 상태 정규화. 기존 저장 상태와 날짜 기반 계산의 일치 문제는 별도 조사. |
| `phase` | 연결 | 연결 | 연결 | 연결 | 79/79 · 88/125 | 허용 구분 정규화. 상태와 다른 개념. |
| `contractType` | 연결 | 연결 | 연결 | 연결 | 79/79 · 88/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `contractStart` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `contractEnd` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `contractEndUndecided` | 연결 | 연결 | 연결 | 연결 | 2/79 · 2/125 | 명시 true를 보존; 날짜와 동시 입력 거부. false→undefined와 merge의 기존 true 해제 경로 확인(G3). |
| `currency` | 연결 | 연결 | 연결 | 연결 | 65/79 · 85/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `contractAmount` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `salesVatAmount` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `totalRevenueAmount` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `totalActualCost` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `supportAmount` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `financialInputFlags` | 연결 | 연결 | 연결 | 연결 | 75/79 · 110/125 | 금액>0이면 true 보정; 명시적 0 여부는 boolean 보존. |
| `registrationRequirementsVersion` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `financialYears` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 세부 표 참조. 과거 finalPaymentExpectedWeek 신규 쓰기 제외, 승인 때 기존 연도값 재결합(P2). |
| `registrationConfirmations` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `registrationOptionalDocumentNotes` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `checkout` | 연결 | 연결 | 연결 | 연결 | 44/79 · 49/125 | 정산 비적용인 finalSettlementReportConfirmed/usbEvidenceSubmitted/evidenceDeletedAfterUsb는 false로 정규화(P3). |
| `settlementType` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `basis` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `accountType` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `interestRefundPolicy` | 연결 | 연결 | 연결 | 연결 | 19/79 · 24/125 | 빈 값이면 기존 값 fallback: 삭제 요청으로 해석하지 않음. |
| `settlementSystem` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `settlementSystemOther` | 연결 | 연결 | 연결 | 연결 | 2/79 · 2/125 | OTHER·정산 적용에만 유지, 그 외 undefined 제거. 기존 값의 물리적 삭제는 별도 문제(G3). |
| `laborSettlementBasis` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `fundInputMode` | 연결 | 연결 | 연결 | 연결 | 75/79 · 100/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `settlementSheetPolicy` | 연결 | 연결 | 연결 | 연결 | 74/79 · 99/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `profitRate` | 제외 | 연결 | 제외 | 파생 | 79/79 · 0/125 | 의도된 파생: totalRevenueAmount / contractAmount. 연간 row는 최대 1 제한, top-level은 제한 없음. |
| `profitAmount` | 제외 | 연결 | 제외 | 파생 | 79/79 · 0/125 | 의도된 파생: totalRevenueAmount와 정렬. |
| `registeredById` | 연결 | 연결 | 연결 | 연결 | 63/79 · 83/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `registeredByName` | 연결 | 연결 | 연결 | 연결 | 63/79 · 83/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `registeredByEmail` | 연결 | 연결 | 연결 | 연결 | 63/79 · 83/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `executiveApproverId` | 연결 | 연결 | 연결 | 연결 | 64/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `executiveApproverName` | 연결 | 연결 | 연결 | 연결 | 64/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `executiveApproverEmail` | 연결 | 연결 | 연결 | 연결 | 64/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `managerId` | 연결 | 연결 | 연결 | 연결 | 79/79 · 88/125 | registeredById에서 파생. 독립 담당자 입력으로 보존하지 않음. |
| `managerName` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | registeredByName에서 파생. 독립 담당자 입력으로 보존하지 않음. |
| `teamName` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `teamMembersDetailed` | 연결 | 연결 | 연결 | 연결 | 79/79 · 122/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `staffing` | 연결 | 연결 | 연결 | 연결 | 40/79 · 45/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `participantCondition` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `note` | 연결 | 연결 | 연결 | 연결 | 56/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `paymentPlanDesc` | 연결 | 연결 | 연결 | 연결 | 79/79 · 125/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `settlementGuide` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `groupwareName` | 연결 | 연결 | 연결 | 연결 | 69/79 · 78/125 | 빈 값이면 기존 값 fallback: 삭제 요청으로 해석하지 않음. |
| `paymentPlan` | 연결 | 연결 | 연결 | 연결 | 79/79 · 88/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `paymentExpectedMonths` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `finalPaymentExpectedWeek` | 연결 | 연결 | 연결 | 연결 | 40/79 · 46/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `laborTransferPlan` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | UI/BFF 모두 MONTHLY_WEEK_3 및 milestone 0으로 고정(P1). |
| `advanceInterimBelow70Reason` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `finalPaymentNote` | 연결 | 제외 | 연결 | 연결 | 79/79 · 88/125 | PM 요청/BFF에는 연결됨. 관리자 직접 patch에서 누락(G1). |
| `budgetCurrentYear` | 제외 | 연결 | 제외 | 연결 | 79/79 · 0/125 | 관리자 전용 입력. PM 요청에는 없음. BFF 승인 시 contractAmount로 다시 설정: 독립 예산 보존 정책 확인 필요(G2). |
| `taxInvoiceAmount` | 제외 | 연결 | 제외 | 기존 유지/별도 | 79/79 · 0/125 | 관리자 전용 입력. PM 요청에서 제외, 신규 등록 0; 변경 승인 merge에서 기존 값 유지. |
| `contractDocument` | 연결 | 연결 | 연결 | 연결 | 77/79 · 123/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `quoteDocument` | 연결 | 연결 | 연결 | 연결 | 51/79 · 64/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `quoteSubmissionDeferred` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 정규화 후 전달. 하위 구조가 있으면 다음 표 참조. |
| `proposalDocument` | 연결 | 연결 | 연결 | 연결 | 51/79 · 64/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `proposalWordOriginalDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `proposalPptOriginalDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `presentationPptOriginalDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `rfpRequestEvidenceDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `customerBusinessRegistrationDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `performanceCertificateDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `taxInvoiceDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `finalSettlementReportDocument` | 연결 | 연결 | 연결 | 연결 | 41/79 · 49/125 | 비공개 첨부 매핑; 아래 하위 필드 참조. |
| `finalReportDocument` | 연결 | 연결 | 연결 | 연결 | 1/79 · 0/125 | #801에서 끊긴 매핑 복구. 누락된 과거 요청은 정본 보존; 명시 null은 삭제. |
| `contractAnalysis` | 연결 | 연결 | 연결 | 연결 | 64/79 · 123/125 | 객체 그대로 전달, 계약서 교체 시 null 처리. 분석된 값이 정본을 자동 대체하지 않음. |
| `teamMembers` | 연결 | 제외 | 연결 | 기존 유지/별도 | 0/79 · 125/125 | 인원 목록 요약문. BFF canonical은 teamMembersDetailed를 보존하고 요약문은 저장하지 않음. |

## 하위 필드 전수 목록

하위 leaf는 같은 형식이 반복되는 곳을 경로 집합으로 표시한다. `{contract,interim,final}`은 세 필드 각각을 의미한다. 정의 밖 임의 필드의 보존까지 보증하지 않는다.

| 경로 | 전달/변환 | 판정 근거 |
|---|---|---|
| `financialInputFlags.contractAmount` | 금액 > 0이면 true 보정; 0의 explicit flag 보존 | registrationFinancialInputFlags / client normalizeProjectFinancialInputFlagsForAmounts |
| `financialInputFlags.salesVatAmount` | 금액 > 0이면 true 보정; 0의 explicit flag 보존 | registrationFinancialInputFlags / client normalizeProjectFinancialInputFlagsForAmounts |
| `financialInputFlags.totalRevenueAmount` | 금액 > 0이면 true 보정; 0의 explicit flag 보존 | registrationFinancialInputFlags / client normalizeProjectFinancialInputFlagsForAmounts |
| `financialInputFlags.totalActualCost` | 금액 > 0이면 true 보정; 0의 explicit flag 보존 | registrationFinancialInputFlags / client normalizeProjectFinancialInputFlagsForAmounts |
| `financialInputFlags.supportAmount` | 금액 > 0이면 true 보정; 0의 explicit flag 보존 | registrationFinancialInputFlags / client normalizeProjectFinancialInputFlagsForAmounts |
| `financialYears[].year` | 2000–2099 유효 정수만 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].contractAmount` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].salesVatAmount` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].totalRevenueAmount` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].totalActualCost` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].supportAmount` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].profitRate` | 수익/계약금액에서 재계산, 최대 1 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].confirmed` | true 여부 정규화 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].paymentPlan.contract` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].paymentPlan.interim` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].paymentPlan.final` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].paymentExpectedMonths.contract` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].paymentExpectedMonths.interim` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].paymentExpectedMonths.final` | 연도별 금액 또는 YYYY-MM 정규화 후 보존 | normalizeRegistrationFinancialYears |
| `financialYears[].finalPaymentExpectedWeek` | 신규 전달 제외, 기존 같은 연도값만 BFF에서 복원(P2) | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].advanceInterimBelow70Reason` | 정규화 후 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `financialYears[].isSettled` | boolean이면 보존 | normalizeRegistrationFinancialYears / projectFinancialYearsForWrite |
| `registrationConfirmations.laborIncludesFourInsurance` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.laborIncludesRetirementPay` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.customerSettlementBasisConfirmed` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.modusignContractUsed` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.originalContractSubmitted` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.proposalPptOriginal` | Drive/Docs URL 검증 후 문자열 보존; 파일 첨부와 별도 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationConfirmations.presentationPptOriginal` | Drive/Docs URL 검증 후 문자열 보존; 파일 첨부와 별도 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationOptionalDocumentNotes.proposalWordOriginal` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationOptionalDocumentNotes.proposalPptOriginal` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `registrationOptionalDocumentNotes.presentationPptOriginal` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.finalPaymentReceived` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.bankBalanceZero` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.performanceCertificateReceived` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.performanceCertificateDocumentApplicable` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.taxInvoiceEvidenceConfirmed` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.finalSettlementReportConfirmed` | 정산 적용일 때만 true, 아니면 false(P3) | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.usbEvidenceSubmitted` | 정산 적용일 때만 true, 아니면 false(P3) | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `checkout.evidenceDeletedAfterUsb` | 정산 적용일 때만 true, 아니면 false(P3) | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `paymentExpectedMonths.contract` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `paymentExpectedMonths.interim` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `paymentExpectedMonths.final` | 정규화 후 보존 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.preset` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.allowAdjustmentRows` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.allowRowDelete` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.autoComputeBalance` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.autoComputeExpenseFromBank` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.autoComputeBankFromExpense` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.requireCounterparty` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.requireNoteForAdjustment` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.requireEvidenceBeforeSubmit` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.preserveExplicitZero` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `settlementSheetPolicy.readOnlyDerivedFields` | 신규 등록은 preset/default/boolean/허용 파생필드 정규화; 변경 승인 patch는 payload 객체 사용 | projects.mjs normalizeRegistration* / normalizeProjectCheckout / registrationSettlementSheetPolicy |
| `paymentPlan.contract` | 비음수 원 금액. 퍼센트가 아니라 분자 금액 보존; 분모 선택은 UI 정책 | registrationAmount / approval paymentPlan |
| `paymentPlan.interim` | 비음수 원 금액. 퍼센트가 아니라 분자 금액 보존; 분모 선택은 UI 정책 | registrationAmount / approval paymentPlan |
| `paymentPlan.final` | 비음수 원 금액. 퍼센트가 아니라 분자 금액 보존; 분모 선택은 UI 정책 | registrationAmount / approval paymentPlan |
| `laborTransferPlan.mode` | MONTHLY_WEEK_3으로 고정(P1) | 양쪽 normalizeLaborTransferPlan |
| `laborTransferPlan.milestoneAmounts.contract` | 0으로 고정(P1) | 양쪽 normalizeLaborTransferPlan |
| `laborTransferPlan.milestoneAmounts.interim` | 0으로 고정(P1) | 양쪽 normalizeLaborTransferPlan |
| `laborTransferPlan.milestoneAmounts.final` | 0으로 고정(P1) | 양쪽 normalizeLaborTransferPlan |
| `staffing.lead.personId` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.lead.name` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.lead.nickname` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.pm.personId` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.pm.name` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.pm.nickname` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.operators[].personId` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.operators[].name` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.operators[].nickname` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.others[].slot.personId` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.others[].slot.name` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.others[].slot.nickname` | personId 없는 slot은 null/제외; 유효 slot 문자열 보존 | normalizeProjectStaffingForWrite / normalizeProjectStaffing |
| `staffing.others[].role` | 공백 정리, 최대 20자; 역할명 없는 행 제외, 최대 10행 | PROJECT_STAFFING_ROLE_MAX_LENGTH / OTHERS_MAX |
| `staffing.settlementSupport` | 문자열 공백 정리 후 보존 | normalizeProjectStaffingForWrite |
| `teamMembersDetailed[].personId` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].inputMode` | 입력 UI 보조값: 일반 쓰기 normalizeProjectTeamMembers 및 BFF에서 제외 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].identityInput` | 입력 UI 보조값: 일반 쓰기 normalizeProjectTeamMembers 및 BFF에서 제외 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].memberName` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].memberNickname` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].role` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].participationRate` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].isDocumentOnly` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].laborAllocationStartMonth` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].laborAllocationEndMonth` | 문자열/비율/월 범위 정규화 후 보존 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `teamMembersDetailed[].monthlyRates` | YYYY-MM별 number 또는 null 보존; 0과 null 구분, 계약 기간별 정규화 | project-team-members.ts / normalizeProjectTeamMembersDetailed |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.path` | 검증한 서버 참조/정본/요청의 값만 유지 | registrationPrivateDocuments / trusted document references |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.name` | 검증한 서버 참조/정본/요청의 값만 유지 | registrationPrivateDocuments / trusted document references |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.downloadURL` | 비공개 refs에서 제외(P4) | registrationPrivateDocuments / trusted document references |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.size` | 검증한 서버 참조/정본/요청의 값만 유지 | registrationPrivateDocuments / trusted document references |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.contentType` | 검증한 서버 참조/정본/요청의 값만 유지 | registrationPrivateDocuments / trusted document references |
| `{contractDocument,quoteDocument,proposalDocument,proposalWordOriginalDocument,proposalPptOriginalDocument,presentationPptOriginalDocument,rfpRequestEvidenceDocument,customerBusinessRegistrationDocument,performanceCertificateDocument,taxInvoiceDocument,finalSettlementReportDocument,finalReportDocument}.uploadedAt` | 검증한 서버 참조/정본/요청의 값만 유지 | registrationPrivateDocuments / trusted document references |
| `contractAnalysis.provider` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.model` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.summary` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.warnings` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.nextActions` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.extractedAt` | 객체 passthrough; 계약 교체 시 분석 전체 null 가능 | request payload + projectInfoPayloadWithDocuments |
| `contractAnalysis.fields.officialContractName.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.officialContractName.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.officialContractName.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.suggestedProjectName.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.suggestedProjectName.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.suggestedProjectName.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.clientOrg.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.clientOrg.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.clientOrg.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.projectPurpose.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.projectPurpose.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.projectPurpose.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.description.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.description.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.description.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractStart.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractStart.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractStart.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractEnd.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractEnd.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractEnd.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractAmount.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractAmount.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.contractAmount.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.salesVatAmount.value` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.salesVatAmount.confidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |
| `contractAnalysis.fields.salesVatAmount.evidence` | 객체 passthrough (정본 필드에 자동 승격 아님) | ProjectRequestContract*Suggestion / request payload |

## 증거 수준과 다음 검증

- #801 범위에서 기존 관련 라우트 259개 테스트와 최종 결과보고서 업로드→임시저장→제출→요청 원문 조회→조직장 승인→정본 조회 테스트가 통과했다. 이는 fixture 동작 근거이며 77개 필드 모든 live 사례 검증을 뜻하지 않는다.
- 본 감사의 AST 키 집계는 spread/조건부 할당을 수동 보정했다. 예: documents spread, status/phase의 admin 조건부 할당, 파생 profitRate/profitAmount. 단순 문자열 검색 누락을 제품 버그로 단정하지 않았다.
- G1–G3은 아직 수정하지 않았다. 아래 격리 실행으로 실제 코드의 변환을 확인했다. 읽기 캡처는 영향을 받을 수 있는 값이 있다는 근거이지 해당 live 레코드에 이미 피해가 발생했다는 증거가 아니다.
- 매트릭스는 '저장/제출/승인 경로' 감사다. 검토 문서·화면에 보이는 표시 필드의 누락은 `2026-09-21-ui-field-audit.md` 및 부모의 실제 화면 대조 결과를 함께 봐야 한다.
- 권한·버전이 다른 프로젝트나 진행 중 초안과 승인된 정본은 값이 달라도 정상이다. 모든 차이를 시스템 유실로 분류하지 않는다.

## 소스 위치

- `src/app/platform/project-editor.ts`: ProjectEditorDraft(86), buildProjectRequestPayloadFromDraft(852), buildProjectEditorProjectPatch(979), projectFinancialYearsForWrite(373).
- `src/app/data/types.ts`: ProjectRequestPayload(942), nested business types(223,336,447,616,648,823,873,894,926).
- `server/bff/routes/projects.mjs`: registrationPrivateDocuments(1111), normalizeRegistrationFinancialYears(1150), confirmations(1184), checkout(1224), trusted fields(1417), registration builder(1594), seed builder(1789), approval builder(1923), request allowlist(2145), change submit(2278).
- `server/bff/routes/project-info-drafts.mjs`: draft storage/ownership/attachmentRefs, submit/rebase/withdraw; `server/bff/routes/project-registration-drafts.mjs`: registration draft and final submission.
- `server/bff/project-financials.mjs`: totalRevenueAmount/profitAmount/profitRate 파생.
- `src/app/components/projects/ProjectWizard.tsx`: 관리자 직접 저장; `src/app/components/portal/PortalProjectEdit.tsx`: PM payload 임시저장 후 서버 제출.

라인은 감사 checkout 기준이며 후속 편집으로 이동할 수 있다.


## 실제 exported 코드 격리 실행 보완

소스 `server/bff`, `src/app/platform`, `src/app/data`, `policies`만 임시 디렉터리로 복사하고 기존 isolated npm dependencies를 연결했다. 원본 product 파일·node_modules 링크·라이브 데이터는 변경하지 않았다. 가상의 프로젝트/요청을 메모리 저장소에 넣어 실제 `buildProjectPatchFromChangeRequestPayload`와 실제 `mergeProjectAndRequestDocs`를 실행했다. 요청은 PENDING, base=3/target=4/current=3으로 **실제 버전 가드도 통과**시켰다. 관리자 builder는 실제 TypeScript를 tsx로 실행했다. 외부 HTTP/Firestore는 호출하지 않았다.

실행 명령(2026-09-21, exit 0):

```sh
/var/folders/32/296zgqyn5nj6rl9m2lgd3qb00000gn/T/myscube-qa-deps-d851e7yc/node_modules/.bin/tsx /var/folders/32/296zgqyn5nj6rl9m2lgd3qb00000gn/T/myscube-backend-repro-n75hdop7/reproduce.ts
```

| 격리 입력/검증 | 실행 결과 | 결론 |
|---|---|---|
| 종료일 없음=true → false + 새 종료일 | patch에 false 키 없음, 승인 merge 후 true가 남고 새 종료일은 저장됨 | **해제 버그 재현됨**. '종료 기간 없음'과 종료일이 동시에 남는 모순. 실제 고객 레코드 피해 여부는 미확정. |
| 사업관리 폴더 링크 있음 → 빈 문자열 | patch에서 링크 키 제거, 승인 merge 후 이전 링크 유지 | **삭제 버그 재현됨**. 요청한 삭제가 저장 정본에 반영되지 않음. |
| 별도 당해 예산 ≠ 계약금액, 설명만 수정 | 승인 merge 후 당해 예산이 계약금액으로 변경됨 | **값 변경 동작은 재현됨**. 별도 예산을 덮어쓰는 것이 허용 정책인지 업무 확인 필요. |
| finalPaymentNote를 새 값으로 준 동일 draft | PM builder는 새 값 포함, 관리자 builder는 키 누락, 관리자 merge는 이전 값 유지 | **builder 누락은 재현됨**. 실제 관리자 화면에 수정 가능한 입력이 있는지는 육안 QA 필요. |

민감 정보 없는 stdout 요약:

```json
{
  "fixtureOnly": true,
  "liveWrites": 0,
  "results": [
    {"case":"contract_end_clear_flag","patchContainsFalse":false,"savedFlagRemainsTrue":true,"newEndDateSaved":true,"classification":"proven_clear_bug"},
    {"case":"folder_clear","patchContainsBlank":false,"oldFolderRetained":true,"classification":"proven_clear_bug"},
    {"case":"independent_budget","unrelatedEditResetsBudgetToContract":true,"classification":"proven_transform_business_policy_unconfirmed"},
    {"case":"admin_final_payment_note","pmBuilderEmitsNewValue":true,"adminBuilderOmits":true,"adminMergeKeepsOld":true,"classification":"proven_mapping_omission_ui_editability_unconfirmed"}
  ]
}
```

## 잔존 클라이언트 helper 경로

활성 PM BFF 경로와 별도로 `src/app/platform/project-change-request.ts`의 기존 helper도 조사했다.

| helper | 현 RequestPayload 대비 누락 | 호출 범위 판정 |
|---|---|---|
| buildProjectPayloadFromProject | participationSheetLink, contractEndUndecided, settlementSystemOther, laborTransferPlan, staffing, finalReportDocument | buildProjectChangeRequest 내부 호출. 현재 src의 non-test 호출 검색에서 buildProjectChangeRequest 외부 사용 없음. |
| buildProjectPatchFromRequestPayload | participationSheetLink, contractEndUndecided, staffing, finalReportDocument; teamMembers는 파생 요약 | 현재 src의 non-test 호출 검색에서 함수 정의 외 사용 없음. |

이는 **현재 실제 PM 승인 유실의 원인으로 단정할 수 없는 잔존 코드 위험**이다. #801이 모든 helper까지 정렬한 것은 아니며 향후 재사용 전 정리/위임 또는 제거가 필요하다. PortalProjectEdit는 이 모듈에서 resolveProjectRequestKind/resolveProjectRequestPayload만 가져오고 제출 payload는 project-editor의 builder를 사용한다.
