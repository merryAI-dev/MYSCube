# Hermes 읽기 전용 운영

승인 범위: 기존 Gemini 키로 실제 모델을 호출하는 Hermes 중간 harness, 기존 BFF/JVM 읽기, 공개 Slack 스레드 응답. 사업/결재/금액/시트 변경·삭제는 금지한다. 질문·피드백·감사 기록은 기존 host가 저장한다.

## 배포 계약

- upstream SHA: `939e45c91d751fadd94dcd1b873ac3cb44846213`, Hermes 0.21.2.
- runtime: Cloud Run `myscube-hermes-readonly`, `us-central1`, min 0/max 1, 1 CPU/1Gi, concurrency 2, 요청 120초. 내부 프로세스는 100초, 8회 모델 반복/12회 도구 호출 제한이다.
- model: `gemini-3.6-flash`, Secret Manager `settlement-hermes-gemini`의 고정 버전. 원본 키는 기존 GitHub Production secret에서 CI가 전달한다.
- runtime 계정: `myscube-hermes-runtime@inner-platform-live-20260316.iam.gserviceaccount.com`. 프로젝트 업무 권한 없음. 해당 Gemini secret 한 개만 읽는다.
- 기존 `myscube-live-bff-invoker`와 배포 검증용 `github-jvm-deployer`만 서비스 invoker로 부여한다. 공개 IAM 바인딩 금지.
- `Hermes Production Deploy`는 main CI 성공 후 자동 실행한다. 최초 서비스 생성 뒤 위 두 invoker의 서비스 단위 IAM 바인딩을 확인한다. 로컬 production 배포는 금지한다.
- Vercel 연결 주소는 GitHub Production variable `SETTLEMENT_HERMES_URL`로 설정한다. 같은 SHA의 수동 재시도는 `already_deployed`로 생략될 수 있으므로 workflow 성공이 아니라 실제 배포 단계와 요청 trace를 확인한다.
- A/B 파일럿: 일반 질문과 `[Baseline]`은 A(기존 실행기), `[Hermes]`는 B(Hermes)다. 후속 질문은 저장된 선택을 이어받고 현재 태그로 변경할 수 있다. URL 누락 시 B를 A로 대체하지 않는다. 호스트가 답변 하단과 trace에 경로를 기록하며 피드백 scope도 분리한다. 사용자 질문을 자동으로 두 번 실행하지 않는다.
- 기존 배포 복구 기준: 마지막 성공 workflow `34811945344`, source `1b18f1b05b070ae3f6254fc857635c78bfdbabcd`. 신규 서비스가 없던 상태이므로 비활성화가 초기 롤백이다. 이후 배포는 이전 revision/traffic을 Actions artifact에 남긴다.

## 데이터와 실행 경계

`Slack → 서명·사용자 검증 / durable queue → IAM WebSocket → 격리 Hermes + Gemini → 도구 요청 → host allowlist + schema + 사용자 재검증 → 기존 BFF/JVM → 근거 검토 → Slack`

Hermes는 DB·Drive·Slack 키, 임의 callback URL, 서비스 계정 JSON을 받지 않는다. 기본 도구를 비활성화하고 native executor 대신 host 요청 전용 executor를 사용한다. 요청마다 새 subprocess/home을 만들며 연결 종료/시간 초과 시 종료한다. 대화와 피드백은 기존 host 저장소를 재사용한다.

실제 provider input/output/thinking 토큰을 감사 기록에 보존한다. 기존 월 30,000원 예약 정책(회당 500원)도 유지한다. 예약액은 실제 청구액이 아니며 Cloud Run·네트워크 비용을 합친 월 50,000원의 청구 hard cap을 보장하지 않는다.

## 검증 기록

- 구현 시점: Python 5개(실제 Hermes + mock HTTP), host 보안 13개, 독립 Firestore emulator worker 1개 통과. 프로덕션 빌드 통과.
- 실제 Gemini API와 비공개 Hermes Cloud Run capability 왕복은 확인했다. 19:50 Slack 승인 시각 QA는 기존 `settlement-read-v2` 경로였다. Hermes Slack E2E는 별도 확인해야 하며 [논문 §14](../architecture/2026-09-14-evidence-grounded-agent-paper.md)에 원시 사용량과 귀속 정정을 기록했다.
- 조감도는 `agent_capabilities`에서 제공한다. 연결 시트 직접 읽기와 정산 의무/종료 제외 정책은 아직 지원하지 않는다고 명시한다.

## 실제 E2E 통과 기준

1. 인증 없는 `/run` 호출 403, 공개 IAM 없음, runtime 업무 DB 역할 없음. `/healthz`는 Google 앞단에서 404로 처리되어 이 검증에 사용하지 않는다.
2. 지정 채널의 실제 사용자 멘션 → queued job → `harness=hermes-readonly-v1` trace.
3. 실제 Gemini usage와 도구 결과, 독립 답변 검토 기록 → 공개 Slack thread 답변.
4. 후속 형식 변경이 반영되고 사업/결재 데이터는 바뀌지 않음.
5. 실패·partial은 성공으로 집계하지 않으며, 모델 답변을 사람이 대신 만들어 게시하지 않음.
