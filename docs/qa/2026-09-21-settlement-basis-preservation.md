# 구형 정산 기준 보존 — BFF 검증

## 변경과 범위

- 구형 `정산 유형 NONE + 기준 공급대가/공급가액/기타`의 모순을 공통 순수 정책 `projectSettlementConsistencyIssue`로 판별한다.
- 원장/요청을 초안 seed로 읽을 때 정산 기준과 관련 상세를 NONE으로 지우지 않는다. 읽기는 예외를 던지지 않아 원문 확인과 임시저장이 가능하다.
- 최종 제출 및 조직장 승인 쓰기에서는 모순을 상세 한국어 오류 `project_settlement_basis_conflict`로 거부한다. 정산 유형·기준 확인, 재제출, 조직장 재검토 순서를 안내한다.
- 관리자 readiness는 같은 규칙을 사용하고 원문은 변경하지 않는다. PENDING은 blocking, 완료 이력은 warning이다.
- 정상 유형 TYPE1~5, NONE/NONE, v2의 독립 정산 기준 정책과 버전 충돌 방어를 유지한다. 주정산/월결산/JVM 및 운영 데이터는 변경하지 않는다.

## 독립적으로 재현할 수 있는 증거

- 집중 8개 파일 260개 테스트 통과: `/tmp/myscube-settlement-targeted2.log`.
- 이후 직접 HTTP 승인 2개를 보강한 신규 정책 파일 23개 통과: `/tmp/myscube-settlement-http.log`.
- 직접 HTTP는 Express 실제 route에 supertest로 CHANGE/REGISTRATION 승인 요청을 보냈다. 승인 토큰과 버전은 유효하게 구성했고, 결과는 422·상세 한국어 안내·Firestore transaction set 호출 0이었다. 운영 API POST가 아니다.
- 배포805의 새 운영 snapshot 125개 요청으로 변경 mapper를 재실행했다. 정상 120, 기존 참여율 검증 거부 3, 이번 정산 모순 2만 새로 차단됐다. 2개 모두 읽기 seed의 기준은 공급대가로 유지됐다. snapshot 불변 검사 통과·운영 쓰기 0.
- 결과: `/tmp/myscube-805-audit/settlement-candidate-replay.json`.
- 사보타주: 임시 미러에서 기준 NONE 강제 변환을 다시 넣으니 23개 중 2개(읽기 seed 보존 및 v2 의미 보존)가 실패했다. candidate로 원복했다. `/tmp/myscube-settlement-sabotage.log`.

## 확인된 운영 사례

- `change-p1775198490730` 노루OI_1단계: 현재 버전 충돌이 먼저 차단하지만, 버전 문제만 해결해도 정산 모순은 별도로 승인 차단된다. 읽기/초안 열기는 가능하다.
- `pr-1779778767187`: 이미 승인된 구형 이력. 원문 조회를 막지 않고 경고하며, 기존 값을 수정하지 않는다.

## 한계

실제 운영 문서의 승인/반려/최종 제출은 하지 않았다. 브라우저 양쪽 표시 검증과 전체 배포 판정은 담당 워커의 독립 QA 결과를 함께 확인해야 한다. 이 문서는 배포 완료 선언이 아니다.
