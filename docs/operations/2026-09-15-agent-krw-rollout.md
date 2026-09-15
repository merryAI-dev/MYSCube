# KRW 원장 및 전사 P/A 읽기 배포

## 승인과 범위

2026-09-15 AXR팀장 확인: MYSC 회계 원장 금액은 내규상 KRW다. 계약 통화와 분리하며 환율 변환하지 않는다. 이전 QA의 통화 미확인 제한은 이 정책 확인으로 해소한다.

- 정책 SSOT: `policies/cashflow-policy.json`의 `ledgerCurrency`.
- 실제 경로: Slack worker → accounting_report → 기존 JVM snapshot 읽기 → 고정 좌표 accountingEvidence → 코드 합계 → Hermes/Gemini 답변 검증.
- 사업 데이터 수정·동기화·삭제 권한은 추가하지 않는다.
- 100개씩 읽고 이전 페이지까지 코드로 누적 합산한다. 같은 요청의 continuation은 기간·사용자·역할에 묶이며 사용 후 폐기된다.
- 50초 읽기 예산을 넘긴 미시도 사업은 다음 호출에서 재개한다. 다른 Slack 요청이나 프로세스 재시작 이후 재개는 지원하지 않는다.
- NULL/미기록/조회 실패는 0원이 아니다. 제외 건수, 전체 목록 순회 여부, 실패 여부를 구분한다. 차액은 P/A 양쪽 기록이 있는 사업만 포함한다.
- 사업별 읽기는 동일 시점의 원자적 snapshot이 아니다. JVM 반영 자료이며 실시간 시트 확인으로 표시하지 않는다.
- 오류는 관측된 코드/HTTP 상태로 권한·한도·시간초과·연결·설정·기간·자료·충돌 등으로 분류한다. raw 로그나 비밀값은 모델에 넘기지 않는다.

## 배포 전 검증

- 관련 JS 테스트 51개 통과.
- 독립 QA 9개 통과: 103개 페이지 누적 합산, 시간초과 재개/중복 방지, cursor 범위, 읽기 전용 검토.
- 로컬 Python harness 3개 통과, pinned Hermes core E2E 1개는 로컬 미설치로 skip. 배포 Docker 이미지에서 재검증한다.
- 전체 에이전트/BFF 통합 테스트와 build, CI 및 실제 배포 결과는 PR/Actions에 남긴다.

## 롤백 기준

- 이전 BFF main: `86734e1127a890b07eb2d0e50c28e4ecbbac7a73`.
- 이전 Hermes revision: `myscube-hermes-readonly-00003-9nd`.
- main CI 성공 후 자동 배포만 사용한다. 업무 원장 복구 작업은 필요하지 않다.
