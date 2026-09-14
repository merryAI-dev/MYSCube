# 회계 읽기·오류 진단 확장 검증 기록

## 범위와 경계

Slack → 검증된 MYSC 활성 구성원 → 호스트의 고정 read port → JVM 원장 조회 → 형식 검증 → Gemini/Hermes 답변 → 근거 검토 → Slack.

에이전트는 JVM 명령, 시트 동기화, 금액/승인 수정, 삭제, 셸, 임의 파일/URL 조회 권한을 받지 않는다. 기존 호스트의 큐·trace·피드백 저장만 유지한다. A/B는 같은 읽기 도구를 사용한다.

`accounting_read`는 JVM 반영 원장 금액을 제공한다. 현재 Google Sheets 원문과 같다고 주장하지 않는다. 원본 셀 EMPTY/ZERO 상태와 반영 시각은 JVM DTO에 없으므로 추정하지 않는다. 통화도 원장 DTO가 보장하지 않으면 불명으로 명시한다. 연간 열을 주차 합계로 재구성하지 않는다.

`agent_diagnostics`는 지정 채널의 최근 작업에서 질문·답변·사용자정보·도구 입력/결과 원문을 제외한 실행 메타데이터만 제공한다. 해시 체인 검증 실패 시 상세 trace를 사용하지 않는다. 최근 50개 후보 안의 제한된 조회이며 전체 Cloud Logging 검색이 아니다.

`platform_recent` 범위는 해당 MYSC 테넌트에 이미 수집된 화면 오류에서 시각·오류 분류·허용 코드·HTTP 상태만 읽는다. 클라이언트가 신고한 관측이며 서버 원인 확정이 아니다. 메시지·스택·이메일·헤더·URL 원문은 전달하지 않는다.

`system_knowledge`는 검토된 코드 동작·소스 참조를 제공한다. 사건 발생 증거와 분리하며, 실제 오류 원인은 저장된 진단 기록 또는 사용자가 제공한 오류 상세로 확인한다. 원본 저장소/비밀 파일을 모델에 공개하지 않는다.

## 레퍼런스에서 적용한 것

- [Hermes 보안 모델](https://github.com/NousResearch/hermes-agent/blob/main/SECURITY.md): 프롬프트나 프로세스 내 필터만 보안 경계로 보지 않는다. 기존 별도 Cloud Run 프로세스 격리와 업무 자격증명 미제공을 유지한다.
- [Google ADK 평가](https://github.com/google/adk-docs/blob/main/docs/evaluate/index.md): 최종 답변과 도구 궤적을 별도로 검증한다. 고정 답변 문구/정확한 호출 순서를 강제하지 않고 필수 근거와 금지 동작을 검사한다. ADK 의존성이나 유료 평가 서비스는 추가하지 않는다.
- [OpenTelemetry agent spans](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md): 대화·실행·도구 호출을 연결해 관찰한다. 기존 trace에 연결하며 별도 관측 플랫폼은 도입하지 않는다.

## 직접 만든 검증 harness

- `server/mcp/support-read.test.mjs`: 민감값 canary, 채널·스레드 격리, 권한 재검증, 변조 trace 거부, 코드 지식/사건 증거 구분.
- `server/mcp/accounting-read.test.mjs`: 원장 금액 DTO와 금액·기간·좌표 계약 검증.
- `scripts/verify-agent-slack-readonly.mjs <job hash...>`: 운영 Firestore 읽기만으로 Slack 전달 완료, trace 해시, 실제 실행기·읽기 도구·모델 토큰과 검토 결과를 확인한다. 다른 사용자의 동시 업무 변경까지 없었다고 증명하는 도구는 아니다.

## 배포 후 Slack 5개 검증 계획

1. 에코스타트업 이번 주 Projection/Actual 규모와 출처.
2. 같은 사업·주차의 Actual 항목 상세.
3. 같은 스레드에서 월 전체로 범위를 변경한 비교.
4. 최근 에이전트 오류·QA 기록과 월결산 검산 오류의 원인/조치 구분.
5. 금액 변경·시트 동기화 요청 거부 후 읽기 가능한 대안 안내.

실제 결과는 배포와 Slack 실행 후 추가한다. 성공 여부를 미리 기록하지 않는다.

## 조사 중 확인한 기존 운영 상태

- 이전 Hermes QA 작업 `d080109040862c985cc16649707c63f0373672172e26b03c234983c55e39e161`: 실제 `hermes-readonly-v1`, `project_search`/`cashflow_status`, answered, trace 검증 통과. 입력 11,774 / 출력 161 / thinking 1,789 토큰. 이번 회계 확장 배포의 증거는 아니다.
- 2026-09-14 10:57 UTC Hermes Cloud Logging에 WebSocket handshake/EOF 오류가 있었다. 회계 조회 실패와의 인과관계는 확인하지 않았다.
- 기존 JVM 배포 run 34836718733은 split-release 검증 단계에서 실패했다. 이번 변경은 JVM 소스/업무 데이터 이관을 변경하지 않으며 해당 가드를 우회하지 않는다.
