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

## 1차 운영 배포 및 실제 Slack 결과

코드 `54d9b85ef4da666556b62cd22a4fb630a7796f5d` ([PR #788](https://github.com/merryAI-dev/MYSCube/pull/788)).
[main CI](https://github.com/merryAI-dev/MYSCube/actions/runs/34839211737), [BFF 운영 배포](https://github.com/merryAI-dev/MYSCube/actions/runs/34839634794), [Hermes 운영 배포](https://github.com/merryAI-dev/MYSCube/actions/runs/34839634861) 성공.
Hermes `myscube-hermes-readonly-00003-9nd`, 트래픽 100%, 비인증 접근 403 검증. JVM 소스는 변경하지 않았다. 별도 [JVM 배포](https://github.com/merryAI-dev/MYSCube/actions/runs/34839634868)는 기존 split-release 가드에서 실패했으며 우회하지 않았다.

실제 모델은 Gemini API를 사용했다. ChatGPT는 아래 시험 질문만 발송했고, 봇의 답변을 작성하거나 대신 전송하지 않았다. 테스트 메시지는 지정 Slack 채널에 남아 있다.

| 시험 | 실제 궤적 | 결과 | 응답 지연 |
|---|---|---|---|
| [1. 이번 주 금액](https://themysc.slack.com/archives/C0BQ6980HR6/p1789386480712669) | Hermes: project_search → accounting_read | 원장 숫자·기간 일치. Projection 미기록을 0으로 만들지 않음. 해시 노출·통화 설명 누락은 개선 필요 | 44.3초 |
| [2. 같은 주 Actual 상세](https://themysc.slack.com/archives/C0BQ6980HR6/p1789386553401569) | Hermes: project_search → accounting_read(detail=lines) | 항목별 값 조회 성공. **최신성 표현 QA 실패**: 캡처 일치를 최신 확인 가능이라고 과장 | 90.4초 |
| [3. 월 전체로 변경](https://themysc.slack.com/archives/C0BQ6980HR6/p1789386700190679) | Baseline: project_search → accounting_read | 월 합계·서버 차액·미기록 주차·통화/최신성 미확인 정확. 주정산/월결산 승인 상태를 불필요하게 덧붙이지 않음 | 45.3초 |
| [4. 오류·QA 설명](https://themysc.slack.com/archives/C0BQ6980HR6/p1789386700924799) | Hermes: agent_diagnostics ×2 → system_knowledge | 실제 기록 조회 성공. **조치 설명 QA 실패**: 서버 boolean과 시트 숫자 셀을 혼동. 알려지지 않은 코드도 조회 실패로 표현 | 113.3초 |
| [5. 쓰기 권한 질문](https://themysc.slack.com/archives/C0BQ6980HR6/p1789386745330059) | Hermes: project_search → accounting_read | **답변 실패**: 내부 ID가 포함된 초안을 검토자가 차단. 업무 쓰기는 없었지만 정상적인 권한 안내를 전달하지 못함 | 20:54 실패 안내 |

접수 메시지는 5건 모두 약 0.8~1.3초 내 표시됐다. 최종 응답 지연은 큐 대기를 포함한 Slack 메시지 시각 차이다. 모델 추론 시간만의 측정이 아니다.

### 숫자 대조

저장된 `accounting_read` 근거와 Slack 답변을 대조했다. 2026-09 3주차(9/14~9/20) Actual 입금/출금 0, 누적잔액 6,499,495. Projection 해당 주차는 NOT_RECORDED이며 null이다.
월 전체 Projection 입금 61,344,893 / 출금 60,010,298, Actual 입금 0 / 출금 -1,334,595, 서버의 Actual−Projection 차액은 입금/출금 모두 -61,344,893이다. 음수 출금을 임의 보정하지 않았다. 원장 통화는 미확인이다.
검증 범위는 **JVM 반환값과 답변의 일치**이며, 현재 Google Sheets 원본의 정확성이나 누락 없는 동기화를 증명하지 않는다.

### 실제 토큰 계측

| 시험 | 입력 | 출력 | thinking |
|---|---:|---:|---:|
| 1 | 15,465 | 470 | 1,693 |
| 2 | 19,377 | 615 | 2,353 |
| 3 | 17,981 | 484 | 1,525 |
| 4 | 13,152 | 585 | 1,667 |
| 5 | 13,327 | 476 | 1,254 |
| 합계 | 79,302 | 2,630 | 8,492 |

모델 응답 usage와 답변 검토 usage의 실제 누계다. 예약 예산이나 화면 글자 수로 추정하지 않았다. 공급자 청구 금액은 별도 청구 자료를 확인하지 않았으므로 원화 비용을 단정하지 않는다.

1~4는 trace 해시/실제 runner/필수 도구/최종 모델 검토를 통과했지만, 사람의 의미 검토에서 2·4는 실패했다. **모델 검토 통과를 정답 보장으로 취급하지 않는 이유**다. 5는 전달 상태 succeeded여도 run_result=answered가 없어 직접 만든 검증기가 실패시켰다.

### QA에서 발견해 보완한 내용

- 저장된 mirror의 FRESH 표시를 모델에 노출하지 않고 `liveSheetVerified=false`와 캡처 일치/최신성 차이를 명시. 일치한 리비전도 최신 확인으로 바뀌지 않는 테스트 추가.
- `matches`는 숫자 value/computed의 서버 비교 결과임을 원본 코드 참조와 함께 제공. 시트에 TRUE/FALSE를 입력하라는 뜻이 아님을 명시.
- 확인되지 않은 화면 오류 코드는 null로 유지. 불명 코드를 특정 조회 실패로 둔갑시키지 않음.
- Hermes 검토 실패 시 같은 근거로 실제 Gemini가 1회 답변 수정 후 재검토. 추가 도구 호출 0회, 기존 시간 제한 유지, 재검토 실패 시 차단 유지.

## 보완 배포 및 최종 판정

최종 코드 `86734e1127a890b07eb2d0e50c28e4ecbbac7a73` ([PR #789](https://github.com/merryAI-dev/MYSCube/pull/789)).
[main CI](https://github.com/merryAI-dev/MYSCube/actions/runs/34841161630), [BFF 운영 재배포](https://github.com/merryAI-dev/MYSCube/actions/runs/34841474447), [Hermes 배포 확인](https://github.com/merryAI-dev/MYSCube/actions/runs/34841474395) 성공.
보완은 BFF에 있는 도구 계약과 답변 검토 흐름의 변경이므로 Hermes 컨테이너는 앞서 배포한 리비전을 유지했다.

최종 CI: 단위 4,130 통과/271 제외, BFF Firestore 통합 262 통과/3 제외, Storage 3 통과, JVM 557 통과, 정산 대상 테스트 195 통과/7 제외, 정산 에뮬레이터 10 통과. 로컬 최신 보완 묶음은 35/35 통과했다. UI 파일 변경이 없어 브라우저 화면 QA 대신 실제 Slack 흐름과 API/trace를 검증했다.
재시험 구간(2026-09-14 12:08 UTC 이후) Hermes Cloud Run의 ERROR 이상 로그를 조회했으며 반환된 항목은 없었다. 로그 수집 지연 및 조회 범위 밖 오류까지 없다는 뜻은 아니다.

| 재시험 | 실제 궤적 | 최종 확인 | 지연 |
|---|---|---|---:|
| [2 재시험](https://themysc.slack.com/archives/C0BQ6980HR6/p1789387719510439) | Hermes: project_search → accounting_read | Actual 16개 항목 0을 원장 근거와 대조. 통화 미확인, 현재 시트 최신성 확인 불가, 내부 해시 비노출 | 56.4초 |
| [4 재시험](https://themysc.slack.com/archives/C0BQ6980HR6/p1789387720364719) | Hermes: agent_diagnostics ×2 → system_knowledge | 실제 기록/일반 설명 분리. 숫자 수식 결과 확인 및 사람이 재불러오기 안내. TRUE/FALSE로 셀을 바꾸는 것이 아니라고 명시 | 115.8초 |
| [5 재시험](https://themysc.slack.com/archives/C0BQ6980HR6/p1789387721180549) | Hermes: project_search → agent_capabilities → accounting_read | 수정·삭제·동기화 불가를 명확히 설명하고 확인한 금액만 안내 | 175.2초 |

세 재시험 모두 전달 완료, 실제 Hermes runner, 필수 도구 호출, trace 해시 체인, 최종 근거 검토, 도구 실패 0건을 확인했다. 별도로 사람이 답변의 숫자·기간·오류 조치를 대조했다. 최초 5개 시나리오와 보완 3회, 총 **8회 실제 Slack 질의응답**을 수행했다.
재시험은 초안 검토부터 통과했다. **1회 재작성 분기 자체의 증거는 로컬 성공/실패 테스트이며, 이 운영 재시험에서 재작성 분기가 실행됐다고 주장하지 않는다.**

| 재시험 | 입력 | 출력 | thinking |
|---|---:|---:|---:|
| 2 | 24,442 | 563 | 1,142 |
| 4 | 14,925 | 606 | 2,053 |
| 5 | 21,981 | 472 | 1,807 |
| 재시험 합계 | 61,348 | 1,641 | 5,002 |
| 전체 8회 합계 | 140,650 | 4,271 | 13,494 |

### 재현 명령

```bash
node scripts/verify-agent-slack-readonly.mjs --tool=accounting_read f4700690adce78b66ee8f3f6629ea473251583b942eb81bcf9b93a2cd9f8d942
node scripts/verify-agent-slack-readonly.mjs --tool=agent_diagnostics 44810097b9356ee4d863daaeb8fe7099d7cd7430be7c6f3c802a90c050606430
node scripts/verify-agent-slack-readonly.mjs --tool=agent_capabilities 16873e88c88efb835b80338a16d07b58618457e1cfc27441b15b3aa3f84a50b8
```

### 남아 있는 범위·사용성 한계

- 접수는 빠르지만 큐 대기 포함 최종 응답은 최대 175.2초였다. 대량 동시 요청 지연 개선을 완료했다고 주장하지 않는다.
- 진단 답변 일부에 UTC 시각·기술 필드가 남는다. 이번 검증의 핵심인 사실성·조회 연결과 별개로 문구를 더 다듬을 여지가 있다.
- 회계 도구는 한 사업의 월/주별 JVM 원장 범위다. 직접 Sheets 원문·수식·원본 셀 상태, 연간 열 조회, 전사 금액 합산 도구는 이번에 추가하지 않았다.
- 전체 서버 로그나 임의 저장소 검색은 제공하지 않는다. 검토된 코드 설명과 제한된 진단 메타데이터만 제공한다.
- JVM의 기존 split-release 배포 가드 실패는 별도 운영 이슈로 남아 있다. 현재 JVM 조회는 실제로 작동했으며 새 JVM 리비전을 배포했다고 주장하지 않는다.
- 모델의 모든 미래 응답이 정확하다는 보장은 아니다. 실제 시험에서 모델 검토를 통과한 오류를 사람이 발견했고, 그 결과를 계약·테스트에 반영했다.

## 조사 중 확인한 기존 운영 상태

- 이전 Hermes QA 작업 `d080109040862c985cc16649707c63f0373672172e26b03c234983c55e39e161`: 실제 `hermes-readonly-v1`, `project_search`/`cashflow_status`, answered, trace 검증 통과. 입력 11,774 / 출력 161 / thinking 1,789 토큰. 이번 회계 확장 배포의 증거는 아니다.
- 2026-09-14 10:57 UTC Hermes Cloud Logging에 WebSocket handshake/EOF 오류가 있었다. 회계 조회 실패와의 인과관계는 확인하지 않았다.
- 기존 JVM 배포 run 34836718733은 split-release 검증 단계에서 실패했다. 이번 변경은 JVM 소스/업무 데이터 이관을 변경하지 않으며 해당 가드를 우회하지 않는다.
