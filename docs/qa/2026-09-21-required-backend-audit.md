# BFF 필수값 독립 감사 — 2026-09-21

## 범위와 증거

프로젝트 신규 등록·수정 최종제출·승인 BFF를 조사했다. 운영 데이터는 변경하지 않았다. 주정산/월결산 계산·동기화·확정 경로는 변경하지 않았다. 현재 워크트리의 이자 반납 필수 WIP가 포함된 상태다. 아래 표의 “누락 허용”은 업무상 선택 항목이라는 뜻이 아니라 **현재 서버가 누락을 거부하지 않는다**는 뜻이다.

실제 `buildProjectRegistrationCanonicalDocuments` 함수를 실행했다. 기존 projects.test.ts의 정상 v2 fixture를 단년도로 바꾼 뒤 필드 삭제/undefined/null/0을 주입했다. 임시 실행 파일 `/tmp/myscube-sprint-validation/backend-required-audit.mjs`, 원본 출력 `/tmp/backend-required-audit-results.jsonl`. 실제 브라우저/운영 DB 전수조사 결과를 대신하지 않는다. 아래 재현은 최종제출에서 호출하는 실제 canonical builder의 저장 문서 생성 결과다.

## 핵심 재현

|입력|결과|
|---|---|
|원가 undefined + 입력 flag false|제출 문서 생성 성공, 원가0/flag false|
|원가 null + 입력 flag false|성공, 원가0/flag false|
|원가 undefined + 입력 flag true|성공, 원가0/flag true|
|원가 명시0 + 입력 flag true|성공, 원가0/flag true|
|VAT·수익·원가·지원금 모두 누락|성공, 계약금액300,000/구성합0|
|보험·퇴직금·고객정산 확인 누락, 전자계약 true|성공|
|계약유형·계좌유형·인건비기준·통화·실제투입인력 누락|성공|
|원가 -1|422 검증 오류|
|입금계획 객체 누락|성공|

**원인:** 금액 validator는 계약금액만 required로 지정하고, 나머지는 undefined/null이면 반환한다. 입력 flag 검사도 계약금액만 true를 요구한다. 이어 `registrationAmount`가 빈값을0으로 정규화한다. 연도별 숫자 필수 검사는 다년도 분기에만 있으며, 계약금액과 VAT+수익+원가+지원금 합의 일치 검사는 없다. 따라서 '원가가 비어 있음'이 '원가0'으로 제출될 수 있다.

## 전체 제출 필드 매트릭스

공유 `PROJECT_SUBMISSION_FIELDS` 전 항목 기준이다. 서버 메타데이터·파생값·예전 호환용 필드를 사용자 필수입력으로 강제하면 안 된다. 사용자 표시 항목은 frontend 감사와 교차 대조해야 한다.

|필드|현재 신규/수정 제출 BFF 판정|세부 조건|
|---|---|---|
|`name`|필수|빈 문자열/잘못된 유형 거부.|
|`officialContractName`|필수|빈 문자열/잘못된 유형 거부.|
|`type`|필수|빈 문자열/잘못된 유형 거부.|
|`status`|누락 허용/정규화|누락/알 수 없는 값은 정규화. 최종제출 필수 검증 없음.|
|`phase`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`description`|필수|빈 문자열/잘못된 유형 거부.|
|`clientOrg`|필수|빈 문자열/잘못된 유형 거부.|
|`businessManagementGoogleFolderLink`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`participationSheetLink`|조건부 필수|신규 v2 필수; 수정 v2는 링크/기간/인력 변경 또는 v2 전환 시 필수. URL 유효성까지 강제하지 않음.|
|`department`|필수|빈 문자열/잘못된 유형 거부.|
|`groupwareName`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`currency`|누락 허용/정규화|누락/알 수 없는 값은 정규화 기본 통화 적용.|
|`contractAmount`|조건부 필수|I1 제외 숫자 필수. 다른 유형은 입력 flag=true 요구. 0 허용.|
|`salesVatAmount`|값이 있으면 수치 검증·누락 허용|undefined/null 허용 후 registrationAmount에서0으로 저장. 명시0과 누락 혼동 가능.|
|`totalRevenueAmount`|값이 있으면 수치 검증·누락 허용|undefined/null 허용 후 registrationAmount에서0으로 저장. 명시0과 누락 혼동 가능.|
|`totalActualCost`|값이 있으면 수치 검증·누락 허용|undefined/null 허용 후 registrationAmount에서0으로 저장. 명시0과 누락 혼동 가능.|
|`supportAmount`|값이 있으면 수치 검증·누락 허용|undefined/null 허용 후 registrationAmount에서0으로 저장. 명시0과 누락 혼동 가능.|
|`financialInputFlags`|조건부 필수|contractAmount만 true 요구. 나머지 boolean 타입만 검사; false/누락 허용.|
|`registrationRequirementsVersion`|필수|빈 문자열/잘못된 유형 거부.|
|`financialYears`|조건부 필수|다년도에만 모든 연도/5개 금액/profitRate 필수. 단년도 배열 자체 없어도 통과. confirmed 필수 아님.|
|`registrationConfirmations`|컨테이너/일부만 검증|modusignContractUsed boolean 선택 필수. false면 originalContractSubmitted=true. 보험/퇴직금/고객정산 확인은 필수 아님.|
|`registrationOptionalDocumentNotes`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`checkout`|조건부 필수|수정 결과 상태 COMPLETED/COMPLETED_PENDING_PAYMENT일 때 7개 boolean 타입 필수. 모두 true일 필요 없음. 주정산/월결산 변경 없음.|
|`contractStart`|필수|빈 문자열/잘못된 유형 거부.|
|`contractEnd`|조건부 필수|contractEndUndecided=true일 때 공란 허용; 함께 날짜가 있으면 거부.|
|`contractEndUndecided`|조건부 필수|체크 안 한 false/필드 누락 허용; true면 종료일 비어 있어야 함.|
|`contractType`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`settlementType`|필수|빈 문자열/잘못된 유형 거부.|
|`basis`|필수|빈 문자열/잘못된 유형 거부.|
|`accountType`|컨테이너/일부만 검증|정산 대상이고 값이 있을 때 enum 검사. 빈 값 허용.|
|`settlementSystem`|컨테이너/일부만 검증|값 있으면 enum 검사, 누락 허용.|
|`settlementSystemOther`|조건부 필수|settlementSystem=OTHER일 때 필수, 100자 제한.|
|`laborSettlementBasis`|컨테이너/일부만 검증|정산 대상이고 값 있을 때 enum 검사, 누락 허용.|
|`laborTransferPlan`|컨테이너/일부만 검증|객체가 있으면 mode/3개 금액 검사. 저장 정규화는 MONTHLY_WEEK_3/금액0으로 고정. 이번 조사에서 변경 안 함.|
|`fundInputMode`|누락 허용/정규화|누락/알 수 없는 값은 정규화 기본값 적용. UI에 없던 통장내역 업로드 표시와 연결.|
|`settlementSheetPolicy`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`paymentPlan`|컨테이너/일부만 검증|있을 때 contract/interim/final 숫자 필수. 객체 자체 누락은 허용; 합=계약금액 검사 없음.|
|`paymentExpectedMonths`|조건부 필수|각 입금액>0인 항목만 YYYY-MM 필수.|
|`finalPaymentExpectedWeek`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`interestRefundPolicy`|조건부 필수|현재 WIP: 정산 기준 NONE 제외 필수. 비어 있지 않으면 enum 검사.|
|`quoteSubmissionDeferred`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`advanceInterimBelow70Reason`|조건부 필수|입금합>0이고 선금+중도금/계약금액<70%면 필수.|
|`paymentPlanDesc`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`settlementGuide`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`finalPaymentNote`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`projectPurpose`|필수|빈 문자열/잘못된 유형 거부.|
|`registeredById`|별칭/작성자 대체|registeredBy/manager 상호 대체; ID/email은 actor 대체 가능, 표시 이름은 둘 중 하나 필요.|
|`registeredByName`|별칭/작성자 대체|registeredBy/manager 상호 대체; ID/email은 actor 대체 가능, 표시 이름은 둘 중 하나 필요.|
|`registeredByEmail`|별칭/작성자 대체|registeredBy/manager 상호 대체; ID/email은 actor 대체 가능, 표시 이름은 둘 중 하나 필요.|
|`executiveApproverId`|필수|빈 문자열/잘못된 유형 거부.|
|`executiveApproverName`|필수|빈 문자열/잘못된 유형 거부.|
|`executiveApproverEmail`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`managerId`|별칭/작성자 대체|registeredBy/manager 상호 대체; ID/email은 actor 대체 가능, 표시 이름은 둘 중 하나 필요.|
|`managerName`|별칭/작성자 대체|registeredBy/manager 상호 대체; ID/email은 actor 대체 가능, 표시 이름은 둘 중 하나 필요.|
|`teamName`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`teamMembers`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`teamMembersDetailed`|컨테이너/일부만 검증|배열 필수이나 시트 연결+빈 배열이면 every()가 true여서 최소1명 요구 우회 가능. 일반행 운영매니저 요구. 월별행 식별자/참여율/중복 검사.|
|`staffing`|누락 허용/정규화|필수 역할 선정 검사 없음. 역할명 공란인 기타 인력은 최종 정규화에서 제거.|
|`participantCondition`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`note`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`contractDocument`|조건부 필수|신규: attachmentRefs의 계약서 필수. 수정은 v2 required attachments 검사 false로 생략; 신뢰된 참조/스토리지 검증은 별도.|
|`customerBusinessRegistrationDocument`|조건부 필수|신규 attachmentRefs 필수. 수정 required attachments 검사 생략.|
|`quoteDocument`|조건부 필수|신규 attachmentRefs 필수, quoteSubmissionDeferred 예외. 수정 required attachments 검사 생략.|
|`proposalDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`proposalWordOriginalDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`proposalPptOriginalDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`presentationPptOriginalDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`rfpRequestEvidenceDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`performanceCertificateDocument`|조건부 필수|종료 수정에서 checkout.performanceCertificateDocumentApplicable=true일 때 필수.|
|`taxInvoiceDocument`|조건부 필수|종료 수정에서 checkout.taxInvoiceEvidenceConfirmed=true일 때 필수.|
|`finalSettlementReportDocument`|조건부 필수|정산 대상 종료 수정이고 checkout.finalSettlementReportConfirmed=true일 때 필수.|
|`finalReportDocument`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|
|`contractAnalysis`|누락 허용/정규화|존재 여부를 독립적으로 요구하지 않음.|

## 경로별 차이와 추가 위험

- 신규 최종제출: `assertRegistrationPayload` → version2 강제 → 이자 필수(WIP) → `assertRegistrationV2Requirements` → 저장 정규화. 신규 필수 첨부는 attachmentRefs에서 검사한다.
- 수정 최종제출: 같은 기본/금액 검사를 쓰지만 `assertRegistrationV2Requirements(..., false)`이므로 필수 첨부 존재 검사를 생략한다. 신뢰된 첨부 참조 검사와 실제 저장소 존재 검사와는 다른 문제다.
- 승인: 읽은 제출 버전/권한/스토리지/변경 버전 검사 후 projection 적용. 제출 당시 누락한 필수값 전체를 독립적으로 재검증하는 공통 도메인 validator가 없다.
- 직접 `/api/v1/projects` upsert: zod는 id/name/expectedVersion 외 passthrough. 일부 입금/인력 검사만 호출하며 전체 등록 요건 validator를 호출하지 않는다. 허용 권한 경로가 최종제출 정책을 우회할 수 있는지 별도 E2E가 필요하다.
- 임시저장은 미완성을 허용해야 한다. 최종제출 필수 강화와 임시저장 저장 가능 여부를 분리해야 한다.
- 기존 필수flag가 이미 true이고 값0으로 저장된 과거 데이터는 사후에 실제0인지 누락정규화0인지 자동 판단할 근거가 없다. 일괄 원가 계산/데이터 보정 금지; 사전 확인 안내 필요.

## 수정 방향

1. 화면별 required를 따로 작성하지 말고 사용자 표시 필드·조건·선택 여부·0 허용·빈값 의미·액션을 공유 도메인 계약으로 정의한다.
2. 신규/수정 제출은 정규화 **이전** 원본값으로 공통 완성도 검사한다. 금액 undefined/null/빈 문자열과 명시0을 구분한다. flag만 믿지 않고 실제 값 존재를 함께 검사한다.
3. 단년/다년을 같은 금융 행 검사로 통일하고 계약금액과 구성합/입금합의 정책을 명확히 검증한다. 자동 합성·역산으로 누락값을 채우지 않는다.
4. 승인 페이지 GET readiness와 승인 쓰기 트랜잭션에서 같은 요건/버전 검사로 제출 당시와 현재 정책 차이를 상세 안내한다. legacy를 무조건 자동 업그레이드하지 않는다.
5. 전체 필수항목 삭제, null, 명시0, 해당없음, 선택 제외, 단년/다년, 임시저장 왕복, 제출/승인 모두 교차 테스트한다.

## 코드 근거

- server/bff/routes/projects.mjs: `assertRegistrationAmount`, `assertRegistrationFinancials`, `assertRegistrationPayload`, `assertRegistrationV2Requirements`, `registrationAmount`, `registrationFinancialInputFlags`, `buildProjectRegistrationCanonicalDocuments`, `buildProjectInfoChangeSubmission`, direct projects POST.
- src/app/platform/project-input-policy.mjs: `projectPaymentIssues`는 양수 입금 월/70% 사유를 검사하나 입금합=계약금액은 검사하지 않는다.
- server/bff/schemas.mjs: projectUpsertSchema의 passthrough.
