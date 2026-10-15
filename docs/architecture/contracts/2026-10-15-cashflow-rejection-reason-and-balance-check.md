# 정산 거절 사유 보이기 · 잔액 검산 바로잡기

**날짜:** 2026-10-15
**상태:** 구현 완료 · 배포 전
**선행:** [월결산 승인 계약 — 조직장 승인은 버튼 한 번](./2026-10-14-cashflow-month-close-one-click-approval.md)

## 발단 — 2026-10-15 라이브 루프 테스트

AXR 프로젝트(`p1773817948751`)로 새 월결산 승인 루프를 돌렸다(13:51~13:52 KST).
주차 완료 → 재오픈 요청·승인 → 결산 제출 → 조직장 승인까지 모두 200, 승인 문서 4개가 한 번에 바뀌었다.
그 과정에서 두 가지가 드러났다.

| 관찰 | 원인 |
|---|---|
| 승인 화면에 "전체 주차 합계와 시트 BO control total이 다릅니다" 경고. BS33 -1,495,947 vs 계산 -57,650,126 | 계산값이 **주차별 잔액 46개를 더한 값**과 원 단위까지 같다. 잔액(시점 값)을 입금·출금(흐름 값)처럼 합산했다 |
| 주차 완료 첫 시도 409, 5초 뒤 200 | 응답 크기·완료 문서로 확인: Projection 48칸 미입력 확인 단계(`cashflow_projection_window_incomplete`) → "무시하고 진행". **버그 아님** |
| 같은 날 다른 프로젝트 409 6건 | JVM 이 409 사유를 로그에 남기지 않아 원인을 알 수 없다. 화면도 모든 `weekly_expense_conflict` 를 "최신 상태와 입력 내용을 확인해 주세요" 로 가린다 |

## 1. 잔액 검산

표준 시트 Total 열의 잔액은 `BS33 = BS22 - BS32` (입금 합계 Total − 출금 합계 Total) 이다(라이브 시트 수식으로 확인).
`controlRow` 는 모든 행을 주차 합산했으므로, 잔액이 0이 아닌 기간이 있는 프로젝트는 모두 거짓 경고가 났다.

- 변경: 잔액 행의 `computed` 를 같은 구간의 `입금 합계.computed − 출금 합계.computed` 로, `annualValues` 를 연도별 입금−출금으로 둔다 (`balanceControl`).
- 그대로: 입금·출금·라인 행 검산, 경고는 승인을 막지 않는 것.
- 영향: `sheetFacts` 는 `sourceRevision` 해시에 들어간다. 배포 뒤 처음 시트를 다시 불러오면 값이 같아도 `sourceRevision` 이 한 번 바뀐다(검산 결과가 바뀌었으므로). 이미 제출된 요청의 `reviewWarnings` 는 다시 계산하지 않는다.

## 2. 거절 사유 남기기·보이기

원칙 변경: "엔진 내부 메시지는 화면에 노출하지 않는다" → **안내 문장 자리에는 쓰지 않고, 접힌 "자세히" 로만 보인다** (2026-10-15 보안 담당 결정).

```
JVM 409 ──► 로그: cashflow_request_rejected status code method path requestId reason   (요청 ID 로 Cloud Logging 검색)
   │
   └─► BFF readJavaError: message = 기존 한국어 안내 (변경 없음)
                          engineReason = JVM message 원문 (4xx 만, 제어문자 제거, 300자)
          └─► 응답 { error, message, requestId, details?, engineReason? }
                 └─► 화면: 안내 문장 + "자세히: <engineReason> · 요청 ID <id>"
```

- JVM `WeeklyExpenseController`: 409 계열 핸들러 8곳(범용 충돌, 월결산 승인 차단, 편집 잠금, 정산 주차 변경 확인 2종, 원자 쓰기 한도, 저장 충돌, 재오픈 정책)이 한 줄 WARNING 을 남긴다. `details`(금액·셀 목록)는 남기지 않는다. 요청 ID 는 영숫자·`_.:-` 만 128자까지.
- BFF: 5xx 는 `engineReason` 을 싣지 않는다(내부 오류 문장일 수 있음).
- 화면: 결산 화면(상태 변경·월결산 승인 토스트), 프로젝트 현금흐름(주간 정산 완료·회수·확정, 시트 반영 오류 한 줄). 월결산 승인 요청 실패는 예전에 아무 알림 없이 상태만 다시 불러왔다 → 토스트 추가.
- `weekly_expense_conflict` 안내 문구가 "검토하는 동안 값이 변경됐어요" 로 원인을 하나로 단정했다 → 중립 문구로 바꾸고 사유·요청 ID 를 보라고 안내.

## 범위 밖

- 월결산 승인 BFF 검사 축소·차단 사유 한국어 문장: 별도 브랜치 `feat/month-close-approval-bff` 에서 진행 중. 이 변경과 겹치지 않게 했다(`readJavaError` 의 다른 줄).
- 같은 사람이 요청·재오픈·승인을 모두 하는 것: 의도된 동작(조직장 겸 책임자).
- 결재자 이름 URL 인코딩 저장, 근거 캡처 시각: 큰 문제 아님(2026-10-15 확인).

## 검증

- BFF·화면: `npm test` 전체 통과, 사보타주 4건(클라이언트 사유 싣기, 5xx 차단, 화면 사유 읽기, 5xx 무시)과 잔액 검산 되돌리기 모두 테스트가 잡음.
- JVM: 로컬에 JDK 가 없어 CI(`mvn test`)로 확인. 새 테스트 `conflictReasonIsLoggedWithTheRequestId` 는 수정 전 코드에 로그 문자열이 없으므로 실패한다.
- 라이브 확인(배포 뒤): AXR 시트를 다시 불러와 잔액 경고가 사라지는지, 409 가 나면 `cashflow_request_rejected` 로그가 요청 ID 와 함께 남는지.
