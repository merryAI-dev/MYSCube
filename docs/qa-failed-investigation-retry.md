# 실패한 조사 다시 요청

QA-RETRY-01: 실패한 사건을 취소하지 않고 새 조사로 재접수한다. 기존 run과 근거를 보존하고 같은 case에 새 aggregate/event/outbox를 원자적으로 만든다. 현재 실패 run의 사건·event·actor·aggregate 연결과 현재 사업 접근 권한을 확인한다. 최종 transaction에서 run도 다시 읽는다.

대시보드의 처리 상태와 변경 이력에서 실패한 조사 다시 요청을 제공한다. 명시적 제출 후 새 event를 서버에서 다시 읽고 이전 결과 응답을 무효화한다. 자동 재시도나 조사 횟수 제한을 추가하지 않는다.

검증: 최초 커밋에서 추출한 관련 57개 통과(주입 DB·서명된 테스트 토큰·UI harness), 독립 검토 57개 통과. 이후 실제 배포 파일의 버튼 경로 검사 1개를 추가했다. 수정 배포 이미지에서는 intake retry 4개, dashboard retry 3개를 네트워크 없이 실행했고 모두 통과했다. 실제 Firestore 동시 요청, 실사용자 재접수와 AI→GitHub 이슈 종단은 미검증이다. 실제 현금흐름 사건은 API credit exhaustion으로 실패했으며 이번 개발 중 재실행하지 않았다.

배포 준비: intake gen17 build 6e819517-0ed8-4ef3-b7a0-2c80de8ccd14, dashboard gen22 build 2224d9a5-418b-4306-933e-536ad274ece1의 generation 고정 소스를 기준으로 overlay한다. 스크립트는 검증된 소스 디렉터리를 입력받으며 외부 다운로드·검증을 대체하지 않는다. 이번 PR 전체 배포가 아니라 runtime 3개 파일만 변경한다. 운영 Vercel 배포 없음.

## QA 서버 배포

- 코드 커밋 `285b4b66b349109ecbfe8fd4a01aaa93449d9022`, overlay 보완 `397155f07da6126becd35b4dcfc9c5cb63bc4ea4`, PR #910.
- intake build `8998e975-fc17-4b73-bab5-e4756a067021` SUCCESS, gen18 Ready 및 traffic100%. digest `35b83fa4dfe3b57df0e16d409556dbea46130c6ff81fed14df46cd4992be1804`.
- dashboard 최초 gen23에서는 기존 배포 파일에 화면 세션 guard가 빠져 실제 화면에서 ReferenceError를 발견했다. 해당 파일에 실제 버튼 테스트를 적용하면 실패함을 확인했고, guard 포함 후 3개 테스트가 통과했다. 수정 build `1f7ab588-e91b-4a67-a655-4e1fe89dc47d` SUCCESS, digest `0690edb2ac288d5bc2a5a4aacf3ab4ed32bd172dbedb74f29553645f30c9e8a0`.
- 고정 원본 archive SHA256: intake `15389ee4107a0452a4c5749b8cbef29f1eb74a4787213bccbb8f41222a1f8e22`, dashboard `7541596ef08c70c06ef57e63c6aac05a1c069159ee5ed98db885dfbcb9400f41`. 기존 MCP 유지 및 미배포 assignmentQueue 제외를 독립 검토했다.

- 수정 dashboard gen24 Ready/traffic100%, 기존 설정 보존 확인. 실제 회사 계정에서 현금흐름 사건의 lifecycle를 읽어 변경 버전10과 실패 조사 재시도 폼을 표시했다. 2026-10-14 06:57:05–06Z dashboard24→intake18 GET 각각 HTTP200. 서비스 간 trace ID는 달라 요청 시간·사건 경로·revision을 대조했으며 공통 trace로 주장하지 않는다.
- 화면 증거 `outputs/QA_실제사건_재시도.png`, 요청 기록 `work/qa-retry-browser-log-proof.json`. 실제 재시도 제출은 하지 않았으므로 Kafka 새 event 전달, 실제 Firestore 동시 재접수 및 AI 실행 성공은 미검증이다. 기존 마지막 run은 API credit exhaustion으로 실패한 채 보존됐다.
