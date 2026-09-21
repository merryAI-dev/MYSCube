# 제출 필드 소유권과 호환 계약

실행 기준: src/app/platform/project-submission-fields.mjs. 개인 초안의 원문 보존은 별도 serializer이며 이 목록으로 숫자 원문을 강제 정규화하지 않는다. 공통 계약에 없는 새 최종 제출 키는 조용히 버리지 않고 오류로 검출한다.

| 필드 | 소유권 | 명시 값 처리 | legacy 키 없음 |
|---|---|---|---|
| `name` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `officialContractName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `type` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `status` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `phase` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `description` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `clientOrg` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `businessManagementGoogleFolderLink` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `participationSheetLink` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `department` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `groupwareName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `currency` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `contractAmount` | 제출 업무값 | 0 보존, 유효 숫자 및 기존 정책 검증 | 해당 키 미제출이면 승인 patch 제외 |
| `salesVatAmount` | 제출 업무값 | 0 보존, 유효 숫자 및 기존 정책 검증 | 해당 키 미제출이면 승인 patch 제외 |
| `totalRevenueAmount` | 제출 업무값 | 0 보존, 유효 숫자 및 기존 정책 검증 | 해당 키 미제출이면 승인 patch 제외 |
| `totalActualCost` | 제출 업무값 | 0 보존, 유효 숫자 및 기존 정책 검증 | 해당 키 미제출이면 승인 patch 제외 |
| `supportAmount` | 제출 업무값 | 0 보존, 유효 숫자 및 기존 정책 검증 | 해당 키 미제출이면 승인 patch 제외 |
| `financialInputFlags` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registrationRequirementsVersion` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `financialYears` | 제출 업무값 | 빈 배열 보존. 제출 시 기존 업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registrationConfirmations` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registrationOptionalDocumentNotes` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `checkout` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `contractStart` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `contractEnd` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `contractEndUndecided` | 제출 업무값 | false 보존 | 해당 키 미제출이면 승인 patch 제외 |
| `contractType` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `settlementType` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `basis` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `accountType` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `settlementSystem` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `settlementSystemOther` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `laborSettlementBasis` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `laborTransferPlan` | 제출 업무값 | 빈 배열 보존. 제출 시 기존 업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `fundInputMode` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `settlementSheetPolicy` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `paymentPlan` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `paymentExpectedMonths` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `finalPaymentExpectedWeek` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `interestRefundPolicy` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `quoteSubmissionDeferred` | 제출 업무값 | false 보존 | 해당 키 미제출이면 승인 patch 제외 |
| `advanceInterimBelow70Reason` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `paymentPlanDesc` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `settlementGuide` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `finalPaymentNote` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `projectPurpose` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registeredById` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registeredByName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `registeredByEmail` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `executiveApproverId` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `executiveApproverName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `executiveApproverEmail` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `managerId` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `managerName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `teamName` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `teamMembers` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `teamMembersDetailed` | 제출 업무값 | 빈 배열 보존. 제출 시 기존 업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `staffing` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `participantCondition` | 제출 업무값 | 기존 필드별 normalizer·업무 검증 적용 | 해당 키 미제출이면 승인 patch 제외 |
| `note` | 제출 업무값 | 빈 문자열은 명시적 비우기 | 해당 키 미제출이면 승인 patch 제외 |
| `contractDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `customerBusinessRegistrationDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `quoteDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `proposalDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `proposalWordOriginalDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `proposalPptOriginalDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `presentationPptOriginalDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `rfpRequestEvidenceDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `performanceCertificateDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `taxInvoiceDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `finalSettlementReportDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `finalReportDocument` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |
| `contractAnalysis` | 제출 업무값 | null은 참조 제거. blob 삭제와 분리 | 해당 키 미제출이면 승인 patch 제외 |

department→cic, registeredById/Name↔managerId/Name은 기존 호환 별칭으로 함께 연결한다. budgetCurrentYear·실입금·taxInvoiceAmount·결산 잠금·version·권한은 제출 필드가 아니므로 일반 CHANGE 승인에서 그대로 보존한다. 필요한 예산 재계산은 별도 명시적 업무 경로로 다룬다.

새 snapshotSchemaVersion=1은 현재 제출 serializer/필드 소유권 계약 표시다. 모든 과거 본문의 영구 보존이나 모든 선택 항목의 존재를 보증하지 않는다. 필수 조건은 기존 registrationRequirementsVersion별 실제 서버 검증을 유지하며 임시저장에는 적용하지 않는다. 서버 검토 token은 프로젝트/요청의 결정 관련 값으로 생성한다. timestamp가 없는 과거 요청도 지원하며 토큰과 버전을 transaction에서 재검사한다.
