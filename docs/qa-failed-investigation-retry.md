# 실패한 조사 다시 요청

QA-RETRY-01: 실패한 사건을 취소하지 않고 새 조사로 재접수한다. 기존 run과 근거를 보존하고 같은 case에 새 aggregate/event/outbox를 원자적으로 만든다. 현재 실패 run의 사건·event·actor·aggregate 연결과 현재 사업 접근 권한을 확인한다. 최종 transaction에서 run도 다시 읽는다.

대시보드의 처리 상태와 변경 이력에서 실패한 조사 다시 요청을 제공한다. 명시적 제출 후 새 event를 서버에서 다시 읽고 이전 결과 응답을 무효화한다. 자동 재시도나 조사 횟수 제한을 추가하지 않는다.

검증: 로컬 관련 58개 통과(주입 DB·서명된 테스트 토큰·UI harness). 독립 검토 57개 통과. 실제 Firestore 동시 요청, 실사용자 재접수와 AI→GitHub 이슈 종단은 미검증이다. 실제 현금흐름 사건은 API credit exhaustion으로 실패했으며 이번 개발 중 재실행하지 않았다.

배포 준비: intake gen17 build 6e819517-0ed8-4ef3-b7a0-2c80de8ccd14, dashboard gen22 build 2224d9a5-418b-4306-933e-536ad274ece1의 generation 고정 소스를 기준으로 overlay한다. 스크립트는 검증된 소스 디렉터리를 입력받으며 외부 다운로드·검증을 대체하지 않는다. 이번 PR 전체 배포가 아니라 runtime 3개 파일만 변경한다. 운영 Vercel 배포 없음.
