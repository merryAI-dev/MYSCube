# Release 805 재무 독립 QA — 배포 후 신규 전수조사

## 범위와 증거

- 배포 SHA `8401b966db843804956144893584527b919c8622`와 동일한 소스 `04f8530efdf3e1d812cd4427e20297299467ecc7`.
- 이번 조사에서 새로 읽은 운영 증거 `/tmp/myscube-805-audit/evidence.json`을 사용했다. 이전 804 결과를 재사용하지 않았다.
- 실제 `ProjectEditorWizard`, `editorDraftFromPrivate`, `MigrationAuditDocumentDialog`를 Chromium에서 렌더링했다. 인증/Firebase context 및 비공개 hydrator export만 감사 harness에서 노출했다. 비즈니스 함수는 수정하지 않았다.
- 79개 원장 화면 + 79개 최근 제출 화면(요청 없으면 원장 fallback) + 38개 활성 개인 수정초안 = **196뷰**. 런타임 오류 **0**, 쓰기 요청 **0**. 로컬 외부 네트워크 차단.
- 운영 브라우저의 로그인 화면을 직접 조작한 검증이 아니다. 운영 데이터 읽기 + 배포 소스의 실제 UI 재현이다. 저장/승인/복원은 실행하지 않았다.
- 전체 DOM: `/tmp/myscube-release805-finance/evidence/all-dom.json`; 독립 기대값 비교: `analysis.json`; 스크립트 `audit-all.mjs`, `analyze.py`.

## 결과

| 검사 | 결과 |
|---|---|
| 연도별 금액 및 입금계획의 실제 저장값 대조 포함 1,675회 검사 | 금액 투영 불일치 0 |
| 미확인 연도의 계약금액·수익을 포함한 잘못된 합계 수익률 | 0 |
| 연도별 누락안내 304건 | 256건 표시, 48건 누락 |
| 종료 상태와 체크아웃 본문 대조 | 기존 legacy S_GH 1건 불일치 유지 |
| 원장/최근 제출 사이 주요 필드 값 차이 | 37프로젝트. 서로 다른 원본/버전의 차이이며 이 숫자를 BFF 유실로 판정하지 않음 |

실제 이번 재무 표본에는 `0`이면서 명시적 입력 플래그가 `true`인 연도별 금액이 없었다. 직접 입력 0원 인정은 이 운영 표본만으로 증명할 수 없으며 별도 테스트 근거와 구분해야 한다.

## 새로 확인한 잔존 결함: 구버전 폼의 연도별 누락안내 부재

**34개 프로젝트(활성 26, 휴지통 8), 48개 연도(활성 39, 휴지통 9)**에서 실무자 원장 초기 조회 화면(개인 초안 record가 없는 읽기 전용 경로)에 연도별 필수 금액 안내가 보이지 않았다. 모두 원장의 `financialYears=[]`인 legacy 폼이다. 총수익률은 계산 불가라고 표시되지만 어느 연도에 어떤 금액을 입력해야 하는지 안내가 없다.

- 대표 `p1773906226325`: 2023~2026년 각 계약금액·매출 부가세·수익·실비(원가)·지원금이 미확인. 관리자에는 네 줄 안내가 보이며 실무자에는 없다.
- 동일 제출 snapshot을 canonical builder로 실무자에게 전달한 추가 검증에서도 **실무자 안내 0개 / 관리자 안내 1개** 재현. 따라서 단순 원장/요청 버전 차이가 아니다.
- 다만 동일 snapshot을 실제 `editorDraftFromPrivate({payload, attachmentRefs: []})`로 재오픈하면 **실무자 1개 / 관리자 1개**로 정상이다. 해당 hydrator는 `registrationRequirementsVersion: 2`를 명시한다. 따라서 결함 범위는 개인 초안이 없는 원장 초기 읽기 전용 경로이며, 저장된 개인 초안 재오픈 전체가 실패한다는 의미가 아니다. 추가 캡처 `private-hydrator-empty-years-editor.png`, `private-hydrator-empty-years-approval.png`.
- 육안 대조: `/tmp/myscube-release805-finance/evidence/empty-years-editor.png`, `empty-years-approval.png`.
- 동일 snapshot 캡처: `same-snapshot-empty-years-editor.png`, `same-snapshot-empty-years-approval.png`.
- 원인: Wizard의 `usesRegistrationV2`는 `registrationRequirementsVersion === 2`이고 `annualTotalsOwnAmounts`도 같은 값이다. `ProjectAnnualFinancialNotice`는 `renderAnnualFinanceTable()` 내부에만 있다. legacy 총계 입력 분기는 해당 함수를 호출하지 않는다. v2라도 연도 배열이 빈 경우 역시 표 대신 날짜 입력 안내만 렌더링한다.
- 최소 조치안: 안내를 계약정보의 공통 영역으로 이동하고 연도표 내부 중복 호출을 제거한다. 저장 금액/버전 자동 변환 없이 모든 버전·빈 연도에 동일 안내를 제공한다.
- 영향범위: Wizard portal-edit/portal-register/admin 계약정보 표시. BFF, Firestore, JVM, 주정산·월결산 수정 불필요. legacy/v2 각각 연도 없음·일부 연도 없음·직접 0원·잘못된 날짜·다년도·종료기간 없음으로 회귀 확인 필요.
- 주의: legacy 폼에서 연도별 값을 실제로 입력할 경로까지 없는 경우 안내만 옮기면 완전 해결이 아니다. 안전한 명시적 형식 전환 또는 연도별 편집 경로를 별도로 검증해야 한다. 이번 조사는 변경하지 않았다.

## 주요 사례 재확인

| 사례 | 이번 운영 저장본 및 실제 화면 재현 |
|---|---|
| 현대모비스 `p1775209262483` | 원장/최근 제출 계약금액 349,194,359원 일치. 2025년 실비·지원금 및 2026년 5개 금액 안내가 양쪽에 표시. 합계 수익률은 계산 불가로 표시 |
| JLIN `p1776054335896` | 2025~2029년 각각 계약 700,000,000원/선금 490,000,000원=70%. 양쪽 동일. 부가세 0원은 명시적 입력 확인이 없어 매년 안내. 총수익률 25.61%는 각 연도 계약/수익이 확인되어 계산 가능 |
| 농산업 `p1774869407448` | 양쪽 계약 120,000,000원, 항목 합계 48,000,000원 유지. 72,000,000원 불일치는 과거 저장 데이터이며 자동 보정하지 않음. 안내/검증 필요 |
| KDB `p1780662870530` | 양쪽 저장 상태 COMPLETED, 계약 447,760,000원. 완료 상태에 따라 체크아웃이 보이는 것이 현재 저장 데이터와 일치. 이번 배포로 진행 중 상태로 바뀐 것은 아님 |

캡처는 `evidence/mobis-*`, `jlin-*`, `agriculture-*`, `kdb-*`에 있다. 이번 조사에서 과거 데이터의 금액·상태는 수정하지 않았다.

## 기존 legacy 체크아웃 결함

`p1784168705457` S_GH는 원장 COMPLETED/v1이며 결재 요청이 없다. 관리자 원장 fallback에 체크아웃 본문이 있지만 실무자 v1 계약/재무 화면에는 상단 `Project Check out` 버튼만 있고 본문은 없다. `showCheckoutEntry`는 상단 버튼 표시만 담당한다. 본문은 `renderPaymentFields`에 속하고 해당 legacy 경로가 이를 렌더링하지 않는 문제다. 신규 요청의 승인 누락 사례로 표현하면 안 된다.

## 판정

금액 투영 및 합계 수익률은 이번 196뷰 전수 재현에서 통과했다. **전체 해결 판정은 불가**: 활성 26개 legacy 프로젝트 원장 초기 조회 경로의 누락 항목 안내와 기존 S_GH 체크아웃 본문 불일치가 남아 있다. 운영 UI 인증 세션의 실제 read-only 조작은 환경 제약으로 미완료이며, 이 검증은 운영 데이터 기반 로컬 실제 컴포넌트 대조임을 유지한다.
