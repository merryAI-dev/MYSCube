# 정산 에이전트 클라우드 운영 계약

2026-09-28 코드 계약: 기본 실행기와 Hermes 모두 최종 답변을 서버 renderer로만 생성한다. 모델의 자유 서술과 검토 모델의 승인으로 최종 답변을 대체할 수 없다. 이전 배포 이력은 [연구 초안의 구현·배포 원장](../architecture/2026-09-14-evidence-grounded-agent-paper.md)을 참고한다.

Slack → Vercel BFF 서명 검증 → Firestore job·공개 접수 안내 → Google Cloud Scheduler(매분) → Vercel BFF worker → Gemini 도구 선택 → 코드 입력 검증 → 기존 BFF `readWeeklyOverview` → JVM → 코드 renderer → 원래 질문의 공개 스레드 응답.

기존 Vercel·Firestore를 재사용한다. 별도 Cloud Run·노트북 프로세스·로컬 OAuth는 필요 없다. worker는 HTTP 응답 전에 실행을 마친다. 기존 주정산 공지는 변경하지 않는다.

## 연결

- Events: `https://myscube.myscguard.app/api/slack/events`, `app_mention`, `message.channels` 구독 (`channels:history` 필요)
- Interactivity: `https://myscube.myscguard.app/api/slack/interactions`
- Scheduler: `/api/internal/workers/settlement-agent/run`, 전용 `SETTLEMENT_AGENT_WORKER_SECRET` bearer 인증. 일반 `CRON_SECRET`은 이 경로에서 사용하지 않는다.
- Workspace `T099F304GAY`, channel `C0BQ6980HR6`
- Google Gemini Developer API, `gemini-3.6-flash`
- GitHub Production secrets: `SETTLEMENT_AGENT_GEMINI_API_KEY`, `SETTLEMENT_AGENT_WORKER_SECRET`, `SLACK_SIGNING_SECRET`, 기존 `SLACK_ALERT_BOT_TOKEN`. 서버에만 주입한다. 명함 인식의 기존 `GEMINI_API_KEY`는 변경하지 않는다.
- Slack 권한 `app_mentions:read`, `users:read.email`, `chat:write` 등이 필요하다. 변경 후 앱 재설치와 URL 등록은 별도 Slack 관리자 작업이다.

멘션으로 대화를 시작한 뒤 같은 사용자는 원래 스레드에 댓글로 질문을 이어간다. 최근 6회 대화를 문맥으로 전달하되 정산값은 매번 새로 조회한다. 여러 사업·기간도 조회 가능하며 조회 한도에 도달하면 확인된 일부 결과와 미완료 안내를 함께 보낸다. 다른 사용자는 직접 멘션해 별도 문맥으로 시작한다. 일반 채널 메시지, 봇 메시지, 수정 이벤트는 처리하지 않는다. 최초 멘션이 아직 서버에 도착하지 않은 스레드의 댓글은 무시되므로 최초 응답 전 누락된 질문은 멘션으로 다시 보낸다.

스레드당 최대 10건을 접수 순서로 처리하며 질문과 답변은 사용자별로 분리한다. `settlement_agent_jobs`의 `status, createdAt` 복합 인덱스를 배포 전에 준비한다. 신규 정렬 조회는 `createdAt` 없는 기존 작업을 포함하지 않으므로 운영 작업 재고를 먼저 확인한다.

## 데이터·권한

`project_search`는 이름 필드만 최대 1,000문서에서 검색해 최대 20개 결과와 잘림 여부를 반환한다. 전체 사업 집계가 아니다. Slack의 `cashflow_status`는 최대 100사업, 운영 주기월과 월결산 대상월을 분리한다. 모델의 최종 자연어 수치 대신 검증한 BFF/JVM 값을 코드로 출력한다.

Slack에서 확인한 MYSC 이메일이 유일한 ACTIVE 구성원과 일치해야 한다. 기존 BFF readCore 역할 검사를 매 조회·최종 정상 응답 직전에 수행한다. 모델에 역할·tenant·토큰·DB 경로를 입력시키지 않는다. 채널 관리자 승인에 따라 지정 채널의 정상 조회 결과는 `chat.postMessage`로 공개하며 채널 구성원 모두가 볼 수 있다. 계정·권한 등 실패 안내는 `chat.postEphemeral`로 질문자에게만 보낸다. 기존 비공개 답변을 소급 공개하지 않는다. 승인·시트·금액·Drive 변경 도구는 없다.

임원진 채널에 승인된 전사 조회는 내부 `myscube-settlement-agent` principal의 기존 `auditor` 프로젝트 범위를 고정 `readOverview` 함수에만 사용한다. 질문자의 개인 역할은 변경하지 않으며 실제 요청자를 trace와 요청 context에 별도 기록한다. 서비스 principal은 이메일을 전달하지 않아 JVM의 `workspace_user` 전환을 받지 않는다. 기존 auditor 역할 자체가 모든 API에서 읽기 전용이라는 뜻은 아니다. 안전 경계는 이 워커가 승인·쓰기 API를 노출하지 않는 고정 capability다. 다른 채널·미연결/비활성/중복 계정에는 적용하지 않는다.

신규 질문을 저장한 뒤 일반 접수 안내를 공개 스레드에 한 번 시도한다. Slack 호출은 최대 800ms이고 ingress 처리 2.4초까지 남은 시간 내에서만 시도한다. 중복 이벤트는 재발송하지 않으며 안내 실패도 저장된 조회를 취소하지 않는다. 실제 조회는 여전히 매분 Scheduler가 실행하므로 안내 추가가 조회 대기시간 자체를 줄이지는 않는다.

예/아니오는 원래 질문자만 저장할 수 있다. 저장 후 Slack `response_url`로 원래 답변을 유지하면서 버튼을 저장 확인으로 교체한다. 아니요는 원래 질문의 스레드에서 사업·기간 설명을 추가하도록 안내하며, 댓글은 기존 대화 경로로 저장·재조회된다. 화면 교체 실패 시 버튼을 유지하고 실패를 반환하므로 다시 클릭할 수 있다. Slack 반환 URL은 저장·로그하지 않으며 hooks.slack.com HTTPS 경로만 허용한다.

Firestore 컬렉션:

- `settlement_agent_jobs/{eventHash}`: 질문, 답변, 조회 범위, 실행·사용량 감사 정보
- `settlement_agent_jobs/{eventHash}/feedback/{slackUserId}`: 해당 답변의 최신 투표
- `settlement_agent_feedback/{scopeHash}`: workspace·사용자·질문·도구·입력별 최근 100개 답변 투표
- `settlement_agent_budgets/{YYYY-MM}`: 원자적 비용 예약

피드백은 조회 사업·기간이 질문 의도와 맞는지를 평가한다. 최신 투표로 대체하며 오래된 재전달은 무시한다. 불변 투표 변경 이력은 아니다. 원래 사용자·메시지·작업 소유권을 검증한다. scalar logistic BCE+L2 점수는 범위 재확인에만 사용하며 모델 weight·temperature·정산 사실을 바꾸지 않는다. 보정된 정확도 지표가 아니다.

## 실행·비용 한계

### 대화 피드백·감사 harness (관찰 단계)

후속 질문의 정정·누락 우려·활용 의사를 이전 답변 job에 연결한다. 어휘 검출과 모델 해석은 모두 후보이며, 모델 근거 인용은 현재 사용자 발화의 실제 부분 문자열이어야 한다. 첫 질문·침묵·공손함·짜증은 정답/오답 라벨이 아니다. 후보는 `trainingEligible=false`로 trace에만 저장한다. 기존 버튼 투표와 혼합하지 않으며 정산값·권한·모델 파라미터를 변경하지 않는다. PLC-DPO의 실제 학습은 아직 활성화하지 않았다. 검증된 비교 쌍과 정책/기준 정책의 margin 없이 clean/flip/tie 확률을 만들어내지 않는다.

`trace/{leaseId}-{sequence}`는 실행 중 순서대로 create하며 hash와 건수를 같은 transaction에서 `trace_runs/{leaseId}`와 job의 최신 `traceAnchor`에 기록한다. lease가 만료된 워커는 기록할 수 없다. JSON 키 순서를 정규화하여 Firestore 재조회 후에도 재검증한다. anchor와 대조하면 변경·순서 교체·중간/마지막 삭제를 검출할 수 있지만, DB 관리자에 의한 기록과 anchor의 동시 재작성은 막지 못한다. WORM 저장소나 외부 서명 서비스가 아니다.

보고서는 문서 ID 순 100개씩 페이지 조회하며 기존 프로젝트 권한 정책과 BFF/JVM 정산 상태를 사용한다. 각 페이지의 입력·승인 상태/기한·revision·포함 판정을 trace에 남겨 판정 함수를 재실행할 수 있다. 조직장은 People의 uid로 연결하며 중복·미연결은 확인 필요로 표시한다. 등록 사업 목록과 정산 의무/체크아웃 제외 목록을 혼동하지 않는다. 현재 후자 정책은 연결되지 않았으며 이를 답변에 명시한다. 주간 cutoff는 마감시각의 상한이고 과거 상태 복원이 아니다. 현재 미승인만 또는 기한후 승인 포함을 구분한다.

모델에는 요약 결과만 주고 목록은 검증된 코드 renderer로 출력한다. 확인 질문은 고정 문구만 사용하여 모델 문장으로 정산 사실을 우회 출력하지 못하게 한다. 관찰 도구 결과는 사용자 답변에 직접 출력하지 않는다. 모델의 후속 응답 실패 시 이미 검증된 결과는 일부 결과라고 명시해 보존한다.

검증 명령:
`npx vitest run server/mcp server/bff/settlement-agent-query.test.mjs`
및 Firestore emulator의 `settlement-agent.integration.test.ts`, `settlement-agent-query.integration.test.ts`.
103개 실제 emulator 문서의 다중 페이지 조회·권한 제한·중복 조직장·후속 페이지 실패·저장된 trace 재검증을 검사한다. 이 결과는 실제 Gemini의 모호한 한국어 이해 성능이나 운영 Slack 상호작용 검증을 대체하지 않는다.

`queued → running → sending → succeeded`. transaction lease와 fencing token으로 중복 실행·만료 worker의 덮어쓰기를 막는다. 발송 결과 불명확은 `delivery_unknown`으로 멈추고 무조건 재발송하지 않는다. succeeded는 전달 상태이며 실제 조회 실패는 답변·audit에 남는다. 실행 재시도 최대 3번, worker당 최대 1작업. 장기 대화 기억·취소·자동 결과 재개·정산 의무 대상별 준수율 집계는 없다.

2026년 9~12월 한 시도당 500원, 월 30,000원까지 예약하고 반환하지 않는다(최대 60시도). 나머지 20,000원은 인프라 여유분이며 전체 클라우드 청구액의 강제 상한은 아니다. 호출당 입력 16,000·출력 2,048토큰, 시도당 최대 3회 호출, SDK 자동 재시도 없음. 가격·환율 변경 시 재검토하며 정책 기간 이후 유료 호출을 차단한다. 토큰 계산은 system·tools를 포함한다.

참고: [Google 토큰 계산](https://ai.google.dev/api/tokens), [모델 가격](https://ai.google.dev/gemini-api/docs/pricing).

## 배포·검증

main CI 성공 후 Production Deploy 자동 배포. alias 전에 `check-settlement-runtime.mjs`가 signed JSON·form과 변조 거부·worker 인증을 확인한다. 이 검사는 데이터를 쓰지 않으므로 실제 피드백 저장 증거를 대신하지 않는다. `Settlement Agent Slack Check`에서 모델·live runtime 검사를 실행한다.

GCP `inner-platform-live-20260316/us-central1/myscube-settlement-agent`는 `scripts/configure-settlement-scheduler.mjs`로 한 번 생성하고 일시정지한다. 운영 검증 후 `gcloud scheduler jobs resume myscube-settlement-agent --location=us-central1 --project=inner-platform-live-20260316`로 시작한다. 중단·롤백 전 같은 명령의 `resume`을 `pause`로 바꾼다. 생성 스크립트는 기존 작업을 덮어쓰지 않는다. 호출 제한은 300초, Scheduler 재시도는 0회이며 작업 재시도는 Firestore가 관리한다. Scheduler 설정 조회 권한은 bearer 비밀값 접근 권한으로 취급한다. 전체 job JSON을 로그에 출력하지 않는다. [HTTP 작업 계약](https://docs.cloud.google.com/scheduler/docs/reference/rest/v1/projects.locations.jobs)을 따른다.

실제 SDK 회귀 테스트와 Firestore 에뮬레이터의 전체 worker 저장 테스트를 유지한다. 통합 테스트의 모델·Slack은 대역이므로 사용자 Slack QA가 별도 필수다. 운영 검증은 멘션 → cron 로그 → 개인 응답 → 버튼 클릭 → 저장된 투표 재조회 순이다. 노트북 종료 상태에서도 확인한다.

긴급 중단은 `SETTLEMENT_AGENT_ENABLED=false`를 명시해 CI 배포한다. 기존 정산 데이터를 삭제하거나 변경하지 않는다. 기본 비활성 배포에서도 false를 명시한다.

## 회계 비교·관찰 확장 (2026-09-28)

기존 `accounting_read`의 단일 JVM 조회와 `accounting_report`의 기존 페이지 조회에서 다음 근거를 추가로 계산한다. 모델 호출 한도·월 예산·공개 채널·조회 권한은 변경하지 않는다.

- `accounting_read(detail=lines)`: 고정 행 순서에 따른 항목별 실적−계획 차액. 한쪽 금액이 없으면 미확인이고 정수 안전 범위를 벗어나면 거부한다.
- `accounting_read.observations`: 계획/실적 각각의 음수 누적잔액 주차와 미기록 주차. 음수만으로 지급 불능이나 원인을 추정하지 않는다.
- `accounting_report.analysis`: 누적 조회 범위의 입금·출금·누적잔액 차액 절댓값 상위 5개, 계획/실적 음수 잔액 5개, 비교 가능·미확인·해당 건수. `wholeCatalog=false`면 전사 순위가 아니다. 출금 부호는 원장 그대로 유지한다.
- 모델 답변 작성이나 검토가 실패해도 코드 출력에 기간·금액·미확인·자료 조회 시각을 포함한다. 셀 상태와 원본 시트 최신성은 여전히 확인 불가다.

배포 후 질문 예:

- “○○사업 9월 2주차 항목별 계획과 실적 차이를 알려줘.”
- “○○사업 9월 실적 누적잔액이 음수인 주차와 미기록 주차를 알려줘.”
- “9월 사업별 입금 계획 대비 실적 차이가 큰 5개를 보여줘. 일부 조회면 표시해줘.”

검증은 MCP/정산 조회 단위 테스트와 프로덕션 빌드, 차액 방향을 반대로 바꿨을 때 실패하는 사보타주 테스트로 수행한다. 외부 Slack 발송·실제 모델 해석·운영 배포 검증은 별도이며 이 변경의 로컬 검증으로 대신하지 않는다.

## CFO 기간 비교·추가 분석

`accounting_compare`는 명시적으로 선택한 최대 10개 사업을 두 기간에 걸쳐 비교한다. 월끼리 또는 주차끼리만 비교하며 동일 기간·역순 기간·중복 사업은 조회 전에 거부한다. `current - baseline` 변화, 각 기간의 P/A 차이 변화, 실적 변동 상위 사업, 미실행 조치안을 코드에서 계산한다. 기간별 실패와 미기록은 0이 아니며 항목별 두 기간 모두 알려진 사업만 짝지어 합산한다. 누적잔액 변화는 순현금흐름과 구분한다. 전사 전체 비교 또는 연간 비교 도구가 아니다.

`cfo_brief`는 같은 입력으로 다음 조회 업무를 수행한다.

1. 선택 사업의 두 기간 원장을 조회하고 비교한다.
2. 음수 누적잔액·실적 변동 사업에서 최대 3개를 골라 비교 기간의 항목별 P/A 차이를 추가 확인한다. 추가 JVM 호출 없이 같은 원장 스냅샷을 사용한다.
3. 사업별 최대 5개 항목 차이, 미기록·조회 실패, 후속 조치안을 함께 제공한다. 분석 단계는 기존 작업 감사 trace에 기록한다.

예: “A사업과 B사업의 2026년 8월과 9월을 비교해서 CFO 브리핑을 작성하고, 변동 항목과 확인할 일을 알려줘.” 사업 ID는 기존 사업명 검색으로 확인한다. 질문의 사업·기간이 모호하면 기존 확인 질문을 사용한다. 기존 Google GenAI SDK 및 Hermes의 읽기 도구 허용 목록에 연결하며 새 모델·외부 서비스·비밀값은 추가하지 않는다.

업무 실행 상태: 원장 조회·비교·추가 분석은 수행한다. 후속 조치안은 `PROPOSED_NOT_ASSIGNED`이고, 원장 수정·결산 승인·담당자 배정·정기 발송을 수행하거나 예약했다고 답하지 않는다. 실행계획·일정 저장과 자동 발송은 별도 승인 범위 확인 전 미구현 상태다.

다음 단계의 구체적인 승인 대상은 **요청자가 자신의 실행계획을 저장·조회·종료하고, 명시적으로 확인한 정기 보고를 기존 지정 채널에 보내는 기능**이다. 기존 실제 사용자 권한으로 소유권을 확인하고 조회 전용 auditor principal을 쓰기 권한으로 전용하지 않는다. 정산 승인·금액 수정·신규 채널·새 비용 한도는 포함하지 않는다. 정기 작업은 중복 enqueue 방지, 실행 전 활성 계정 확인, 기존 비용 예약, 취소·일시정지, 발송 결과 불명확 시 재전송 금지를 갖춰야 한다. 이 문단은 설계 범위이며 해당 기능이 배포되었다는 의미가 아니다.

로컬 검증: 비교 수치·권한 취소·부분 실패·금액 오버플로, 모델 후속 실패 시 근거 출력, 같은 월의 서로 다른 주차 스냅샷 재사용을 검사한다. 서명된 Slack 이벤트부터 실제 worker의 도구 등록·auditor 조회 context·예산 예약·감사 trace·Slack 발송 payload까지 메모리 DB와 외부 호출 대역으로 검증한다. Firestore 트랜잭션 동시성, 실제 모델 이해 성능, 운영 Slack 전달을 검증한 것은 아니다.

## 코드로 강제하는 답변 근거 경계

- `runSettlementAgent`와 `runHermesAgent`는 모델 최종 문장을 사용자 답변에 사용하지 않는다. 모델은 도구 선택·구조화 입력·보고서 형식 선택만 맡고, 실행한 도구의 검증된 결과를 `render` 함수로 출력한다. 근거가 없으면 확인 불가, renderer 오류나 일부 실패는 미확인/부분 결과로 처리한다.
- 모델이 999개 승인 완료·원인 단정·지급 실행 완료를 출력하거나 외부에서 항상 승인하는 reviewer를 전달해도 답변과 저장된 job 답변에 반영되지 않는다. 모델 리뷰·문장 수정 경로 자체를 제거했다.
- `system_knowledge`는 허용한 실제 소스의 발췌·파일 위치·전체 소스 SHA-256을 제공한다. `scripts/generate-agent-code-evidence.mjs`로 생성하며 CI의 소스 대조 테스트가 바이트 변경·오래된 발췌를 차단한다. 배포 리비전을 알 수 없으면 확인 불가로 표시한다. 임의 경로·전체 저장소·비밀값 읽기는 제공하지 않는다.
- `agent_diagnostics`는 실제 저장된 작업·오류·검증된 trace의 시각/상태/코드만 출력한다. 코드 설명은 현재 장애 발생 증거가 아니며 기록 없음은 정상의 증거가 아니다.
- 모델의 질문 해석과 조회 대상 선택까지 수학적으로 보증하는 것은 아니다. 출력에 선택한 사업·기간·누락 범위를 표시하고, 금액 산술·상태·행동 완료 여부를 모델이 추론할 경로를 차단한다.

운영 검증 도구 `verify-agent-slack-readonly.mjs`는 이제 모델 reviewer 통과 대신 `run_result.answerPolicy=server_evidence_only`와 실제 도구 실행·trace 무결성을 확인한다.
