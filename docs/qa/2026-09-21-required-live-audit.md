# 필수 입력 전수조사: 운영 저장본 재조회

조회: 2026-09-21T05:35:47.860415+00:00 ~ 2026-09-21T05:35:54.664308+00:00 (UTC). Firestore 5개 collection 전체 페이지를 읽었으며 운영 쓰기는 하지 않았다.

프로젝트 79개, 요청 125개, 수정 초안 67개, 등록 초안 168개. 프로젝트별 최신 요청 74개를 요청시각·버전·갱신시각 순으로 선정했다. 휴지통 포함이며 현재 승인 대기만의 통계가 아니다.

최신 제출본 원가 키 상태: {'present': 46, 'missing': 28}
원가 입력 플래그: {'False': 11, 'True': 35, 'None': 28}
원가가 0인 제출본: 19개. 0이라는 사실만으로 미입력이라고 판정하지 않는다.
계약금액과 VAT+수익+원가+지원금이 다른 제출본(모두 수치인 경우): 19개. 업무 오류 확정이나 자동 보정 대상이라는 의미는 아니다.

## 전체 제출 필드 존재 집계

| 필드 | 키 없음 | null | 빈 값 | 값 있음 |
|---|---:|---:|---:|---:|
| name | 0 | 0 | 0 | 74 |
| officialContractName | 0 | 0 | 0 | 74 |
| type | 0 | 0 | 0 | 74 |
| status | 11 | 0 | 0 | 63 |
| phase | 11 | 0 | 0 | 63 |
| description | 0 | 0 | 1 | 73 |
| clientOrg | 0 | 0 | 2 | 72 |
| businessManagementGoogleFolderLink | 28 | 0 | 15 | 31 |
| participationSheetLink | 30 | 0 | 0 | 44 |
| department | 0 | 0 | 0 | 74 |
| groupwareName | 18 | 0 | 14 | 42 |
| currency | 12 | 0 | 0 | 62 |
| contractAmount | 0 | 0 | 0 | 74 |
| salesVatAmount | 0 | 0 | 0 | 74 |
| totalRevenueAmount | 0 | 0 | 0 | 74 |
| totalActualCost | 28 | 0 | 0 | 46 |
| supportAmount | 0 | 0 | 0 | 74 |
| financialInputFlags | 2 | 0 | 0 | 72 |
| registrationRequirementsVersion | 28 | 0 | 0 | 46 |
| financialYears | 28 | 0 | 1 | 45 |
| registrationConfirmations | 28 | 0 | 0 | 46 |
| registrationOptionalDocumentNotes | 28 | 0 | 0 | 46 |
| checkout | 28 | 0 | 0 | 46 |
| contractStart | 0 | 0 | 1 | 73 |
| contractEnd | 0 | 0 | 3 | 71 |
| contractEndUndecided | 72 | 0 | 0 | 2 |
| contractType | 11 | 0 | 0 | 63 |
| settlementType | 0 | 0 | 0 | 74 |
| basis | 0 | 0 | 0 | 74 |
| accountType | 0 | 0 | 0 | 74 |
| settlementSystem | 28 | 0 | 0 | 46 |
| settlementSystemOther | 72 | 0 | 0 | 2 |
| laborSettlementBasis | 28 | 0 | 0 | 46 |
| laborTransferPlan | 28 | 0 | 0 | 46 |
| fundInputMode | 7 | 0 | 0 | 67 |
| settlementSheetPolicy | 8 | 0 | 0 | 66 |
| paymentPlan | 11 | 0 | 0 | 63 |
| paymentExpectedMonths | 28 | 0 | 0 | 46 |
| finalPaymentExpectedWeek | 30 | 0 | 44 | 0 |
| interestRefundPolicy | 51 | 0 | 0 | 23 |
| quoteSubmissionDeferred | 28 | 0 | 0 | 46 |
| advanceInterimBelow70Reason | 28 | 0 | 30 | 16 |
| paymentPlanDesc | 0 | 0 | 10 | 64 |
| settlementGuide | 0 | 0 | 18 | 56 |
| finalPaymentNote | 11 | 0 | 53 | 10 |
| projectPurpose | 0 | 0 | 0 | 74 |
| registeredById | 12 | 0 | 0 | 62 |
| registeredByName | 12 | 0 | 0 | 62 |
| registeredByEmail | 12 | 0 | 0 | 62 |
| executiveApproverId | 28 | 0 | 0 | 46 |
| executiveApproverName | 28 | 0 | 0 | 46 |
| executiveApproverEmail | 28 | 0 | 0 | 46 |
| managerId | 11 | 0 | 0 | 63 |
| managerName | 0 | 0 | 0 | 74 |
| teamName | 0 | 0 | 63 | 11 |
| teamMembers | 0 | 0 | 3 | 71 |
| teamMembersDetailed | 0 | 0 | 6 | 68 |
| staffing | 30 | 0 | 0 | 44 |
| participantCondition | 0 | 0 | 55 | 19 |
| note | 0 | 0 | 63 | 11 |
| contractDocument | 0 | 9 | 0 | 65 |
| customerBusinessRegistrationDocument | 28 | 0 | 0 | 46 |
| quoteDocument | 19 | 11 | 0 | 44 |
| proposalDocument | 19 | 52 | 0 | 3 |
| proposalWordOriginalDocument | 28 | 42 | 0 | 4 |
| proposalPptOriginalDocument | 28 | 46 | 0 | 0 |
| presentationPptOriginalDocument | 28 | 46 | 0 | 0 |
| rfpRequestEvidenceDocument | 28 | 35 | 0 | 11 |
| performanceCertificateDocument | 28 | 46 | 0 | 0 |
| taxInvoiceDocument | 28 | 46 | 0 | 0 |
| finalSettlementReportDocument | 28 | 46 | 0 | 0 |
| finalReportDocument | 74 | 0 | 0 | 0 |
| contractAnalysis | 0 | 23 | 0 | 51 |

키 누락 통계는 현재 필수 정책 위반 건수와 같지 않다. 과거 형식·선택·조건부·내부 메타데이터가 포함된다. 운영 자료에서 과거에 공란을 0으로 변환했다면 현재 값만으로 당시 입력 여부를 복원할 수 없다. 원문은 임시 권한 제한 파일에 보관하며 이 문서에는 개인정보·첨부 URL을 포함하지 않는다.
