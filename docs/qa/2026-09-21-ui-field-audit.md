# 등록·수정 입력과 승인 화면 필드 대조

조사 기준: 2026-09-21, 작업 트리 HEAD `32fb2699`와 현재 소스. PR 801 이후 추가 반영된 상태를 포함한다. 소스 기반 독립 감사이며 실제 브라우저 육안 검증·운영 레코드 대조는 별도다. 아래 표는 발견 목록이지 모두 수정되었다는 선언이 아니다.

## 판정 기준

- **표시**: 의미 있는 업무 라벨로 전용 렌더링됨.
- **일부**: 요약·조건부 표시라 원 입력의 전체 의미를 보존하지 못함.
- **원문만**: DetailPanel의 `dossier.submittedFields`가 payload 키를 재귀 출력. nested 영어 키·enum·boolean까지 출력될 수 있어 비개발자용 설명과 동등하지 않다.
- **미표시**: DocumentDialog의 결재 문서에 전용 표시가 없음.
- **내부/레거시**: Draft 타입에 존재하지만 현재 Wizard의 직접 입력 제어는 확인되지 않음. 삭제·불필요로 단정하지 않는다.

`MigrationAuditDetailPanel`은 제출원문 영역에서 payload의 모든 키를 출력한다(`groupwareName` 제외). 따라서 그 화면은 아래 누락의 상당수가 **원문만** 존재한다. 반면 실제 문서 열기 `MigrationAuditDocumentDialog`에는 이 전체 원문 영역이 없어 전용 표시 여부가 중요하다. 요청이 존재하면 제출 snapshot을 사용하고 이후 개인 임시저장은 포함하지 않는 경계를 유지해야 한다.

## 전체 Draft 최상위 필드

| 필드 | 편집기 의미/노출 | DocumentDialog | DetailPanel 전용 표시 및 잔여 |
| --- | --- | --- | --- |
| name | 프로젝트명 | 표시 | 표시 |
| officialContractName | 공식 계약명 | 표시 | 표시 |
| type | 프로젝트 유형 | 표시 | 표시 |
| description | 상세 설명 | 표시 | 표시 |
| clientOrg | 계약 대상 | 표시 | 표시 |
| businessManagementGoogleFolderLink | 사업관리 폴더 입력·검토 | **미표시** | 원문만 |
| participationSheetLink | 참여율 시트 | 링크 표시 | 링크 표시 |
| department | 담당 조직/부서 | 표시 | 조직 요약·원문 |
| projectPurpose | 목적 | 표시 | 표시 |
| status | 기간에서 판정한 상태 | **상태값 전용 표시 없음**, 체크아웃 노출 조건에만 사용 | 원문 enum |
| phase | 관리자 프로젝트 구분 | **미표시** | 원문 enum |
| contractType | 계약서 유형 | 표시 | 표시 |
| contractStart, contractEnd | 계약기간 | 표시 | 표시 |
| contractEndUndecided | 종료 기간 없음 | 기간 문자열로 표시 | 기간 문자열 및 원문 |
| currency | 통화 | 표시 | 전용 그리드에는 없음, 원문만 |
| contractAmount | 계약금액 | 표시 | 표시 |
| salesVatAmount | 총매출부가세 | 표시 | 표시 |
| totalRevenueAmount | 총수익 | 표시 | 표시 |
| totalActualCost | 총실비 | 표시 | 표시 |
| supportAmount | 총지원금 | 표시 | 표시 |
| financialInputFlags | 입력 공란/명시적 0 구분 | **전용 의미 표시 없음** | 원문 boolean만 |
| registrationRequirementsVersion | 내부 등록양식 버전 | 미표시(내부) | 원문만 |
| financialYears | 연도별 금액·입금 계획 | 일부, 아래 세부 표 | 동일 FinancialYearsTable 및 원문 |
| registrationConfirmations | 계약/보험/퇴직/링크 확인 | 일부, 아래 세부 표 | 링크 전용 외 원문 |
| registrationOptionalDocumentNotes | 선택 서류 미첨부 사유 | 서류가 없을 때 표시 | 원문만 |
| checkout | 종료 확인 사항 | 종료 상태에만 일부 표시 | 원문만 |
| settlementType | 정산 유형 | 표시 | 표시 |
| basis | 정산 기준 | 표시 | 표시 |
| accountType | 통장 유형 | 표시 | 표시 |
| interestRefundPolicy | 이자 반납 | 표시 | 표시 |
| settlementSystem | 정산 시스템 | 표시 | 표시 |
| settlementSystemOther | 기타 시스템 이름 | 시스템 라벨에 합성 | 시스템 라벨·원문 |
| laborSettlementBasis | 인건비 정산 기준 | 표시 | 표시 |
| fundInputMode | 사업비 입력 방식(타입 유지) | 표시 | 표시 |
| settlementSheetPolicy | 시트 정책(현재 직접 입력 미확인) | 미표시 | 원문 enum |
| profitRate | 총수익률, 계산 표시 | **미표시** | 원문에 있을 때만 |
| profitAmount | 내부/레거시 계산값 | 미표시 | payload에 있을 때 원문 |
| registeredById, registeredByName, registeredByEmail | 등록자 선택/표시 | 기안자 이름은 요청자 이름 사용, 등록자 identity와 구분 필요 | 원문, 요청자 별도 |
| executiveApproverId, executiveApproverName, executiveApproverEmail | 지정 조직장 | 이름 표시, ID/email 숨김 | 원문, 실제 승인자 별도 |
| managerId, managerName | PM/최종 보고자 | 이름 표시 | 이름 표시, ID 원문 |
| teamName | 팀 이름(타입 유지) | 값 있을 때 표시 | 표시 |
| teamMembersDetailed | 서류상 인력·월별 참여율 | 인원수+시트 링크만, 상세 미표시 | 동일 요약 및 원문 |
| staffing | 실제 투입인력 | 역할별 이름 요약 | 동일 요약 |
| participantCondition | 참여 조건(타입 유지) | 표시 | 표시 |
| note | 등록 메모(타입 유지) | 표시 | 표시 |
| paymentPlanDesc | 입금 계획 메모 | 표시 | 표시 |
| settlementGuide | 내부/레거시 정산 가이드 | 미표시 | 원문만 |
| groupwareName | 제거된 레거시 필드 | 미표시 | 명시적으로 원문에서도 제외(기존 의도) |
| paymentPlan | 선금/중도금/잔금 | 금액·비율 표시 | 표시 |
| paymentExpectedMonths | 입금 예정월 | financialYears 합성 표를 통해 표시, 아래 참고 | 동일 표 및 원문 |
| finalPaymentExpectedWeek | 과거 잔금 예정 주차 | 값 있으면 표시 | 원문만 |
| laborTransferPlan | 인건비 이관 계획, 현재 직접 UI 없음 | **미표시** | 원문만 |
| advanceInterimBelow70Reason | 70% 미만 사유 | 값 있으면 표시 | 최상위는 원문만, 연도별은 표 표시 |
| finalPaymentNote | 잔금 메모(타입 유지) | 값 있으면 표시 | 원문만 |
| budgetCurrentYear | 관리자 당해연도 예산 | **미표시** | payload에 있으면 영어 키 원문 |
| taxInvoiceAmount | 관리자 세금계산서 발행액 | **미표시** | payload에 있으면 영어 키 원문 |
| contractDocument | 계약서 | 서류 1+원문 열기 | 전용 preview |
| quoteDocument, quoteSubmissionDeferred | 견적서/이후 제출 예정 | 서류 3+이름/유예 | 이름/유예, 파일은 원문 메타데이터 |
| proposalDocument | 제안서 PDF | 제출됐으면 추가 서류 | 원문 메타데이터만 |
| proposalWordOriginalDocument | 제안서 Word | 서류 4 | 원문 메타데이터만 |
| proposalPptOriginalDocument | 제안서 원본 | 서류 5, 링크 공존 | 원문 메타데이터+링크 |
| presentationPptOriginalDocument | 발표자료 원본 | 서류 6, 링크 공존 | 원문 메타데이터+링크 |
| rfpRequestEvidenceDocument | RFP/요청 근거 | 서류 7 | 원문 메타데이터만 |
| customerBusinessRegistrationDocument | 사업자등록증 | 서류 2 | 원문 메타데이터만 |
| performanceCertificateDocument | 수행확인서 | 제출됐으면 추가 서류 | 원문 메타데이터만 |
| taxInvoiceDocument | 세금계산서 증빙 | 제출됐으면 추가 서류 | 원문 메타데이터만 |
| finalSettlementReportDocument | 최종 정산보고서 | 제출됐으면 추가 서류 | 원문 메타데이터만 |
| finalReportDocument | 최종 결과보고서 | 제출됐으면 추가 서류 | 원문 메타데이터만 |
| contractAnalysis | 계약 분석 보조 결과 | 미표시 | 요약/주의/다음 행동 전용 표시 |

## 중첩 필드 전수 대조

| 경로 | 편집기/데이터 의미 | DocumentDialog | DetailPanel |
| --- | --- | --- | --- |
| financialInputFlags.{contractAmount,salesVatAmount,totalRevenueAmount,totalActualCost,supportAmount} | 공란과 0 입력 구분에 사용 | 숫자 요약으로 구분 소실 가능 | 원문 boolean만 |
| financialYears[].year | 연도 | 표시 | 표시 |
| financialYears[].contractAmount | 연도 계약금액 | 표시 | 표시 |
| financialYears[].salesVatAmount | 연도 매출부가세 | **표 컬럼 누락** | 동일 누락, 원문 있음 |
| financialYears[].totalRevenueAmount,totalActualCost,supportAmount | 연도 수익·실비·지원금 | 표시 | 표시 |
| financialYears[].profitRate | 연도 수익률, 편집기 계산 표시 | **미표시** | 원문만 |
| financialYears[].confirmed | 연도 재무 확인, 편집기 최종 검토 표시 | **미표시** | 원문만 |
| financialYears[].isSettled | 연도 정산 확인 | 완료/미완료 표시 | 동일 |
| financialYears[].paymentPlan.{contract,interim,final} | 연도 입금액 | 표시 | 표시 |
| financialYears[].paymentExpectedMonths.{contract,interim,final} | 연도 예정월 | 해당 금액 아래 표시 | 동일 |
| financialYears[].finalPaymentExpectedWeek | 과거 주차 값 | 미표시(현재 직접 입력 미확인) | 원문만 |
| financialYears[].advanceInterimBelow70Reason | 연도 사유 | 값 있으면 표시 | 동일 |
| paymentPlan.{contract,interim,final} | 최상위 입금액 | 금액·비율 표시 | 동일 |
| paymentExpectedMonths.{contract,interim,final} | 최상위 예정월 | `projectFinancialYearsWithPaymentPlan` 합성 대상, 다년도에서 귀속 주의 | 동일+원문 |
| laborTransferPlan.mode | 이관 방식(현재 직접 UI 미확인) | 미표시 | 원문 enum |
| laborTransferPlan.milestoneAmounts.{contract,interim,final} | 시점별 이관액(현재 직접 UI 미확인) | 미표시 | 원문만 |
| registrationConfirmations.modusignContractUsed | 모두싸인/서면 | 표시 | 원문 boolean |
| registrationConfirmations.originalContractSubmitted | 서면 원본 제출 | 서면+true면 원본 제출, false와 null은 분리 안 됨 | 원문 boolean/null |
| registrationConfirmations.laborIncludesFourInsurance | 보험 포함(현재 Wizard 제어 미확인) | 미표시 | 원문만 |
| registrationConfirmations.laborIncludesRetirementPay | 퇴직금 포함(현재 Wizard 제어 미확인) | 미표시 | 원문만 |
| registrationConfirmations.customerSettlementBasisConfirmed | 고객 정산기준 확인(현재 제어 미확인) | 미표시 | 원문만 |
| registrationConfirmations.proposalPptOriginal | 제안서 Drive 링크 | 링크 표시, 파일과 함께 표시 | 텍스트 및 원문 |
| registrationConfirmations.presentationPptOriginal | 발표자료 Drive 링크 | 링크 표시, 파일과 함께 표시 | 텍스트 및 원문 |
| registrationOptionalDocumentNotes.{proposalWordOriginal,proposalPptOriginal,presentationPptOriginal} | 미첨부 사유 | 파일/링크 없을 때만 사유 표시 | 원문만 |
| checkout.finalPaymentReceived,bankBalanceZero,performanceCertificateReceived | 잔금·계좌·실적증명 확인 | 종료 상태에서 표시 | 원문만 |
| checkout.performanceCertificateDocumentApplicable | 수행확인서 해당 여부, 편집기 체크 | **미표시** | 원문만 |
| checkout.taxInvoiceEvidenceConfirmed | 세금계산서 해당 확인 | 종료 상태에서 표시 | 원문만 |
| checkout.finalSettlementReportConfirmed,usbEvidenceSubmitted,evidenceDeletedAfterUsb | 정산 해당 확인·인계·삭제 | 종료 상태에서 모두 표시, 정산 미적용 구분은 미흡 | 원문만 |
| staffing.lead,pm,operators[] | 총괄·실무·운영 | 역할별 이름 요약 | 동일 |
| staffing.others[].role,slot | 기타 역할명/인물 | formatter 요약에 포함 | 동일 |
| staffing.settlementSupport | 정산지원 | 요약 표시 | 동일 |
| staffing.*.{personId,name,nickname} | 선택인 identity/이름 | 이름/별칭 요약, ID 비노출은 의도 가능 | staffing은 원문도 요약 formatter 사용 |
| teamMembersDetailed[].memberName,memberNickname,role,participationRate | 서류상 참여인력 | 개별값 미표시, 인원수만 | 원문만 |
| teamMembersDetailed[].laborAllocationStartMonth,laborAllocationEndMonth | 인건비 배분기간 | 미표시 | 원문만 |
| teamMembersDetailed[].monthlyRates[YYYY-MM] | 월별 참여율, null≠0 | 미표시; 외부 시트는 제출 snapshot과 달라질 수 있음 | 원문에는 null→미입력, 0→0 |
| teamMembersDetailed[].isDocumentOnly | 서류상 인력 여부 | 미표시 | 원문만 |
| teamMembersDetailed[].personId,inputMode,identityInput | 인력연결/입력 메타데이터 | ID·입력방식 숨김은 가능하나 연결 실패는 별도 안내 필요 | 원문만 |
| attachments.*.name | 모든 증빙 파일명 | 표시 | 계약서 전용, 나머지 원문 |
| attachments.*.path,downloadURL | 접근 위치 | 원문 버튼으로 사용; 경로 문자열 숨김은 의도 가능 | 원문에 경로/URL도 노출 가능 |
| attachments.*.size,contentType | 크기/파일형식 | **표시 없음**, contentType은 preview 선택에 사용 | 계약서도 전용 크기 없음, 원문만 |
| attachments.*.uploadedAt | 업로드 시각 | **미표시** | 계약서 업로드 시각 전용, 나머지 원문 |

## 우선 조치 후보와 검증

1. 승인 핵심 금액 누락: 연도별 매출부가세·수익률·확인 상태, 전체 수익률. 연도 표와 편집기 최종 검토를 같은 fixture로 대조한다.
2. 승인 판단에 필요한 링크·현재 구분: 사업관리 폴더, 제출 상태/단계, 해당되는 관리자 금액. 자동 정산 완료나 현행 정본 덮어쓰기로 연결하지 않는다.
3. 참여율은 제출 snapshot과 현재 외부 시트의 차이를 명시한다. 인원수+현재 시트 링크만으로 제출 당시 참여율 검토를 마쳤다고 표시하지 않는다.
4. null·0·미적용 구분: financialInputFlags, 원본 제출, checkout 해당 여부. 원문 boolean 노출만으로 친절한 업무 안내가 완료되었다고 판단하지 않는다.
5. 실제 제거된 입력과 여전히 의미가 있는 레거시 제출값을 구분한 뒤 보험·퇴직금·이관계획 표시 여부 결정. 현재 입력 UI에 없는 값을 새 필수 제출로 강제하지 않는다.
6. 증빙 메타데이터는 파일명·형식·크기·업로드 시각으로 대조 가능하게 한다. 내부 저장경로를 사용자 판단용 정보로 대체하지 않는다.

현 시점은 **필드 감사 완료, 전체 수정 완료 아님**이다. 동시 작업 중 소스가 바뀔 수 있으므로 최종 커밋에서 이 목록과 부모 에이전트의 실제 브라우저 결과를 합쳐 재판정해야 한다.

## 운영 UI 추가 확인: 통화와 금액 단위

후속 운영 조회에서 통화USD와 원 접미사 금액이 동시에 표시됨을 확인했다. 부모 담당 index11 AVPN, 후반 담당 index36 전남·45 AXR경비·63 GGGI코트디가 해당한다. 특히 GGGI코트디는 USD/계약3,000원 표시를 스크린샷으로 육안 확인했다. 이는 currency 필드가 존재하는 것과 금액이 올바른 통화로 표시되는 것이 다르다는 사례다. 환율/환산일/원금 여부 설명도 없어 자동 환산이나 운영 데이터 보정 없이 표시 계약부터 검토해야 한다. 자세한35건 열람 결과는 `2026-09-21-live-review-documents-36-70.md`를 참조한다.
