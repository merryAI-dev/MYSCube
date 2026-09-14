# Hermes 읽기 전용 대안 검토

작성: 2026-09-14. 범위: 공식 소스 확보와 정적 검토만. 설치·실행·모델 호출·Slack 발송·권한 변경은 수행하지 않았다.

## 1. 식별 및 재현 가능한 소스

- 공식 프로젝트: [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent).
- 확인한 최신 정식 릴리스: [Hermes Agent v0.21.2 / v2026.9.11](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11). `pyproject.toml:5`도 0.21.2다. 확인한 공식 자료에서 별도 제품/버전인 “Hermes Agent2”는 확인되지 않았다. Hermes 모델명과 Agent 런타임 버전을 혼동하지 않는다.
- 소스: `/tmp/myscube-hermes-readonly.TA5fin/source`.
- 고정 커밋: `939e45c91d751fadd94dcd1b873ac3cb44846213` (태그의 detached HEAD). `git status --porcelain` 출력 없음.
- 수행: 공식 HTTPS 저장소 shallow clone → 해당 태그 fetch → 태그 checkout. 저장소 프로그램, 설치 스크립트, dependency 설치, Docker build는 실행하지 않았다. 임시 경로는 영구 보관소가 아니므로 재현 기준은 위 SHA다.

## 2. 코드에서 확인한 기능과 한계

아래 경로/행은 모두 고정 커밋 기준이다. [고정 소스 트리](https://github.com/NousResearch/hermes-agent/tree/939e45c91d751fadd94dcd1b873ac3cb44846213).

| 항목 | 근거 | MYSCube 판단 |
|---|---|---|
| 도구 실행과 대화 루프 | `run_agent.py:1273`, `agent/conversation_loop.py:1573` | 자체 trajectory 실행기 후보다. MYSCube 데이터 의미/권한을 자동으로 아는 것은 아니다. |
| Gemini native adapter | `agent/gemini_native_adapter.py:614`, `:646`, `:653` | native REST를 SDK 호환 인터페이스로 감싼다. 모델 인자를 지정할 수 있으나 기본값은 3.7 Flash다. 우리 3.6 Flash를 명시하고 실제 호출 호환성을 별도 검증해야 한다. 이번 조사에서 호출하지 않았다. |
| Slack mention 및 댓글 | `plugins/platforms/slack/adapter.py:1`, `:931`, `:1475`, `:6149` | Socket Mode, message/app_mention, thread 응답 코드가 있다. 기존 MYSCube Slack ingress를 재사용하면 중복 봇 리스너를 켤 이유가 없다. |
| 대화 저장 | `hermes_state.py:2`, `:160` | SQLite WAL 기반 state.db. 서버의 대화 기록 저장도 쓰기이므로 “업무 데이터 읽기 전용”과 구분해야 한다. |
| 컨테이너 | `Dockerfile:386`, `:430`, `:464` | HERMES_HOME=/opt/data 및 volume/entrypoint가 있다. 클라우드 실행 가능성의 근거지만 우리 Cloud Run 검증 완료를 뜻하지 않는다. |
| 기본 실행 한도 | `run_agent.py:238` | max_iterations 기본값이 sys.maxsize다. 월 비용 상한이 있는 운영에는 명시적 시간·호출·토큰 한도가 필수다. |

최근 릴리스는 state.db 동시 접근, 프로필 분리, gateway/provider 관련 수정들을 포함한다. 이는 재사용 가치와 동시에 저장소/프로필 격리 회귀 테스트의 필요성을 보여준다. 릴리스 자체가 MYSCube 환경에서의 안전성 보증은 아니다. [공식 릴리스](https://github.com/NousResearch/hermes-agent/releases/tag/v2026.9.11)

## 3. 읽기 전용은 기본 설정이 아니다

`toolsets.py:11`의 공통 도구에는 terminal, write_file, patch, browser 조작, execute_code, delegate_task, cronjob_manage 등이 포함된다. `toolsets.py:209`의 hermes-slack은 이 공통 bundle을 사용한다. 따라서 기본 Slack Agent에 운영 credentials를 넣는 방식은 이번 승인 범위에 맞지 않는다.

실제 코드 장치와 그 한계를 구분한다.

- **등록 필터:** `tools/mcp_tool_registration.py:179`의 `tools.include`는 이름 기반 whitelist다. 명시적 빈 배열은 아무 도구도 등록하지 않고, include/exclude가 없으면 모두 등록한다. 이름이 read라고 해서 실행 내용까지 읽기 전용으로 보장하지는 않는다.
- **실행 직전 승인:** `tools/mcp_tool_handlers.py:40`, `:467`은 untrusted MCP의 write-capable 호출을 RPC 전에 승인 검사한다. 승인 시스템 오류는 fail-closed다.
- **승인은 금지가 아니다:** 같은 코드에서 사용자가 accept하면 실행한다. `readOnlyHint=true`면 승인을 생략한다. `tools/mcp_tool_registration.py:34`는 trust 미설정 시 full을 기본값으로 둔다. 즉 annotation, prompt, 확인 버튼만으로 “어떠한 업무 쓰기도 불가능”을 주장할 수 없다.
- **네트워크 별도 통제:** upstream도 Docker 기본 host network의 광범위한 outbound 접근을 지적한다. `docs/security/network-egress-isolation.md:3` 및 `:14`. 모델에 shell만 숨기는 것이 egress 격리를 대체하지 않는다.

이번에는 우회 불가능성을 동적 검증하지 않았다. 위 장치의 존재를 확인한 것이며 전체 보안 감사 PASS가 아니다.

## 4. 최소 통합안: 기존 워커 뒤의 격리된 읽기 엔진

`기존 Slack ingress/인증/queue → 격리 Hermes 실행 → MYSCube read gateway → JVM / 연결된 Sheets 읽기 → 근거 기반 Gemini 답변 → 기존 Slack 발송`

1. 동일 질문에 대한 기존 엔진과의 shadow 비교부터 시작한다. Hermes가 직접 Slack 토큰을 받아 다른 채널에 발송하지 않게 한다.
2. 새 엔진에 노출할 도구는 host가 소유한 업무 catalog, 프로젝트 식별, 조건/필드 기반 조회, 연결 시트 읽기로 제한한다. 도구명은 설계 제안이며 현재 배포된 인터페이스라는 뜻이 아니다.
3. 기본 toolset, terminal/code/browser/file write, delegate, cron, plugin 설치, 임의 MCP 등록/연결 관리 기능은 제공하지 않는다. 허용 목록은 모델이 바꿀 수 없는 host 설정으로 소유한다. 시작 시 실제 노출 도구 목록을 검사하며 실행 dispatcher도 같은 목록으로 거부해야 한다.
4. Hermes에 Firestore admin, Google editor OAuth, production 서비스 계정 키를 전달하지 않는다. 요청자·tenant·채널·조회 범위가 결합된 host read gateway만 접근시킨다. Gemini credentials도 모델 context나 도구 결과로 노출하지 않는다.
5. Sheets는 사용자가 접근 가능한 프로젝트에 저장된 연결만 해석한다. URL 임의 탐색이나 전사 Drive 검색 권한으로 확대하지 않는다. 기존 Sheets 서비스가 `batchUpdateValues`를 갖고 있으므로 서비스 객체 전체를 넘기지 않고 host가 읽기 메서드만 호출한다. 캐시플로 고정 좌표/EMPTY·ZERO 계약과 JVM의 결산 상태 권위를 유지한다.
6. 클라우드는 기존 워커의 durable thread/audit 저장을 우선 재사용한다. Hermes native gateway를 별도 상시 운영한다면 영속 디스크가 있는 단일 writer 배치부터 검증한다. SQLite volume을 ephemeral Cloud Run 파일시스템이나 여러 인스턴스의 공유 볼륨에 그대로 둔 수평 확장 설계는 승인하지 않는다.
7. OS/컨테이너 권한과 egress를 제한해 도구 필터 결함이 곧 DB write/외부 유출로 이어지지 않게 한다. 읽기 경로가 POST 기반 조회 API일 수 있으므로 HTTP 동사만으로 분류하지 않고 서버의 실제 handler capability로 허용한다.

## 5. 실행 전 통과 조건과 남은 일

- 허용되지 않은 도구 이름, write API, 임의 URL/다른 프로젝트 시트, 만료·다른 사용자 capability를 직접 요청했을 때 host가 거부한다.
- 문서/시트 셀에 “터미널 실행·권한 변경·다른 채널 발송” 지시가 있어도 업무 조회 범위가 변하지 않는다.
- 월/주 혼합 후속 질문, 승인 시각, CIC 재구성, 형식만 수정하는 질문에서 필요한 도구를 조합하고 기존 무관한 조회를 덧붙이지 않는다.
- 답변의 인원·건수·상태·시각이 실제 조회 결과에 연결되고, 부분 조회/미확인/오래된 snapshot이 표시된다.
- 도구별 latency, 모델 input/output/thinking usage, 반복 호출, source revision을 기록하고 동일 실제 질문으로 기존 엔진과 비교한다.
- 컨테이너 재시작 후 대화 연속성, 동시 요청 격리, 중복 Slack event, 취소/timeout 및 budget 중단을 검증한다.

현재 완료는 소스 확보·정적 검토까지다. 모델 호출 QA, 런타임 allowlist 우회 테스트, cloud build/deploy, Slack 연결은 미실행이다. 추천은 **격리된 read-only prototype 후보로 채택**, 기본 Hermes 설치로 운영 봇을 즉시 교체하지 않는 것이다.

## 6. 후속 구현과 공식 사용 패턴 적용

위 §1–5는 소스 조사 시점 기록이다. 이후 사용자가 실제 Gemini API와 Slack E2E까지 배포를 승인하여 `server/hermes`와 `server/mcp/hermes-harness.mjs`를 구현했다. Cloud Run 배포·실제 Slack 검증 결과는 별도 운영 기록으로 남긴다. 로컬 mock 성공을 실제 API 성공으로 취급하지 않는다.

- [Tool Search](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/website/docs/user-guide/features/tool-search.md): 도구 목록을 먼저 파악하고 필요한 schema를 선택하는 패턴. 현재 도구 6개에는 별도 검색 엔진을 붙이지 않는다. `agent_capabilities`가 데이터 원천·필드·기간 의미·관련 도구·미지원 범위를 제공한다. 필요한 경우에만 호출하고 매 질문의 필수 단계로 만들지 않는다.
- [MCP whitelist](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/website/docs/user-guide/features/mcp.md): 업무별 제한된 도구를 제공하는 패턴을 채택한다. MCP annotation만 믿지 않고 Hermes 실행기와 BFF 양쪽의 고정 allowlist, BFF strict schema와 사용자 검증으로 강제한다.
- [Slack working status / streaming](https://github.com/NousResearch/hermes-agent/blob/939e45c91d751fadd94dcd1b873ac3cb44846213/website/docs/user-guide/messaging/slack.md): 진행 중임을 먼저 보여주고 같은 스레드에서 최종 답변하는 패턴을 적용한다. 기존 공개 접수 안내와 단일 최종 발송을 재사용한다. 내부 명령·식별자는 표시하지 않는다. 토큰 스트리밍·native Hermes Slack gateway는 이번 구현에 추가하지 않는다.

이는 공식 기능 문서에서 가져온 설계 패턴이지, MYSC와 동일한 기업의 검증된 성공 사례나 성능 수치가 아니다.
