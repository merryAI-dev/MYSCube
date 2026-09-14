# 정산 에이전트 클라우드 운영 계약

Slack → Vercel BFF 서명 검증 → Firestore job → Vercel cron(매분) → Gemini 도구 선택 → 코드 입력 검증 → 기존 BFF `readWeeklyOverview` → JVM → 코드 renderer → 질문자 개인 응답.

기존 Vercel·Firestore를 재사용한다. 별도 Cloud Run·노트북 프로세스·로컬 OAuth는 필요 없다. worker는 HTTP 응답 전에 실행을 마친다. 기존 주정산 공지는 변경하지 않는다.

## 연결

- Events: `https://myscube.myscguard.app/api/slack/events`, `app_mention` 구독
- Interactivity: `https://myscube.myscguard.app/api/slack/interactions`
- Cron: `/api/internal/workers/settlement-agent/run`, 기존 `CRON_SECRET` 인증
- Workspace `T099F304GAY`, channel `C0BQ6980HR6`
- Google Gemini Developer API, `gemini-3.6-flash`
- GitHub Production secrets: `GEMINI_API_KEY`, `SLACK_SIGNING_SECRET`, 기존 `SLACK_ALERT_BOT_TOKEN`. 서버에만 주입한다.
- Slack 권한 `app_mentions:read`, `users:read.email`, `chat:write` 등이 필요하다. 변경 후 앱 재설치와 URL 등록은 별도 Slack 관리자 작업이다.

## 데이터·권한

`project_search`는 이름 필드만 최대 1,000문서에서 검색해 최대 20개 결과와 잘림 여부를 반환한다. 전체 사업 집계가 아니다. `cashflow_status`는 최대 20사업, 운영 주기월과 월결산 대상월을 분리한다. 모델의 최종 자연어 수치 대신 검증한 BFF/JVM 값을 코드로 출력한다.

Slack에서 확인한 MYSC 이메일이 유일한 ACTIVE 구성원과 일치해야 한다. 기존 BFF readCore 역할 검사를 매 조회·최종 정상 응답 직전에 수행한다. 모델에 역할·tenant·토큰·DB 경로를 입력시키지 않는다. `chat.postEphemeral`로 질문자만 답변을 본다. 승인·시트·금액·Drive 변경 도구는 없다.

Firestore 컬렉션:

- `settlement_agent_jobs/{eventHash}`: 질문, 답변, 조회 범위, 실행·사용량 감사 정보
- `settlement_agent_jobs/{eventHash}/feedback/{slackUserId}`: 해당 답변의 최신 투표
- `settlement_agent_feedback/{scopeHash}`: workspace·사용자·질문·도구·입력별 최근 100개 답변 투표
- `settlement_agent_budgets/{YYYY-MM}`: 원자적 비용 예약

피드백은 조회 사업·기간이 질문 의도와 맞는지를 평가한다. 최신 투표로 대체하며 오래된 재전달은 무시한다. 불변 투표 변경 이력은 아니다. 원래 사용자·메시지·작업 소유권을 검증한다. scalar logistic BCE+L2 점수는 범위 재확인에만 사용하며 모델 weight·temperature·정산 사실을 바꾸지 않는다. 보정된 정확도 지표가 아니다.

## 실행·비용 한계

`queued → running → sending → succeeded`. transaction lease와 fencing token으로 중복 실행·만료 worker의 덮어쓰기를 막는다. 발송 결과 불명확은 `delivery_unknown`으로 멈추고 무조건 재발송하지 않는다. succeeded는 전달 상태이며 실제 조회 실패는 답변·audit에 남는다. 실행 재시도 최대 3번, worker당 최대 2작업. 대화 기억·취소·자동 결과 재개·전체 조직 집계는 없다.

2026년 9~12월 한 시도당 500원, 월 30,000원까지 예약하고 반환하지 않는다(최대 60시도). 나머지 20,000원은 인프라 여유분이며 전체 클라우드 청구액의 강제 상한은 아니다. 호출당 입력 16,000·출력 2,048토큰, 시도당 최대 3회 호출, SDK 자동 재시도 없음. 가격·환율 변경 시 재검토하며 정책 기간 이후 유료 호출을 차단한다. 토큰 계산은 system·tools를 포함한다.

참고: [Google 토큰 계산](https://ai.google.dev/api/tokens), [모델 가격](https://ai.google.dev/gemini-api/docs/pricing).

## 배포·검증

main CI 성공 후 Production Deploy 자동 배포. alias 전에 `check-settlement-runtime.mjs`가 signed JSON·form과 변조 거부·worker 인증을 확인한다. 이 검사는 데이터를 쓰지 않으므로 실제 피드백 저장 증거를 대신하지 않는다. `Settlement Agent Slack Check`에서 모델·live runtime 검사를 실행한다.

실제 SDK 회귀 테스트와 Firestore 에뮬레이터의 전체 worker 저장 테스트를 유지한다. 통합 테스트의 모델·Slack은 대역이므로 사용자 Slack QA가 별도 필수다. 운영 검증은 멘션 → cron 로그 → 개인 응답 → 버튼 클릭 → 저장된 투표 재조회 순이다. 노트북 종료 상태에서도 확인한다.

긴급 중단은 `SETTLEMENT_AGENT_ENABLED=false`를 명시해 CI 배포한다. 기존 정산 데이터를 삭제하거나 변경하지 않는다. 기본 비활성 배포에서도 false를 명시한다.
