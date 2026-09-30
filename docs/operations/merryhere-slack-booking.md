# Merryhere 회의실 도구

기존 Slack ingress → `createSlackWorker` → `runSettlementAgent`의 `merryhere_rooms` 도구를 사용한다. 별도 에이전트, 브라우저 MCP 서버, 큐 또는 Slack 앱은 만들지 않는다. 진행 표시·서명 검증·활성 회원 검증·모델 API·답변 전달·스레드 이력은 기존 경로를 재사용한다. Gemini가 자연어 날짜·시각·기간 및 후속 정정을 정규화한 `query`로 전달한다. 서버는 날짜 유효성·한국시간·4주 범위·30분 단위·기간 정합성·실제 슬롯·권한·멱등성을 검증한다. 가용 여부와 최종 답변은 실제 provider 근거로 출력한다.

추가 질문도 `bookingContext`에 확인된 query와 missing을 저장한다. 다음 모델 호출에는 기존 대화와 이 상태를 함께 전달한다. `inherit=true`이면 생략 필드는 유지하고 명시적 null은 해제한다. 시작을 바꾸면 유지된 기간으로 종료를 계산하고, 새로운 날짜는 이전 시간 조건을 자동 상속하지 않는다. 특정 한국어 문장·조사·오전/오후 응답에 대한 별도 파서나 직행 경로는 두지 않는다. 회의실 도구는 결과를 얻은 첫 호출에서 종료하므로 탐색 요청당 모델 호출 1회를 유지한다.

## 사용자 흐름

- `가능한 회의실 어디야?`: 한국시간 오늘, 현재 이후 가능한 연속 구간을 먼저 표시한다.
- `다음 주 수요일 가능한 장소는?`: 월요일 시작 주 기준 다음 주 수요일을 실제 날짜로 표시한다.
- `그중 4명 가능한 곳`, `오후만`: 같은 사용자의 같은 스레드에 저장된 조회 조건을 이어받아 새로 조회한다.
- 방·시작/종료·회의명이 채워지면 실제 포인트를 포함한 예약 준비 결과를 표시한다.
- `회의실 예약 확정 <확인번호>`: 같은 사용자·계정·스레드에 한정해 10분 이내 확정한다. 확정 직전 날짜·시간·모든 슬롯·인원·포인트를 다시 확인한다.

현재 예약 취소·변경은 Merryhere의 내 예약현황에서 처리한다. 외부 신청인 스튜디오와 유료 홀 시간은 내부 예약 API로 우회하지 않는다.

## 식별자 계약 및 확인 수준

2026-09-29 로그인된 실제 예약 화면의 form/checkbox/클릭 핸들러에서 확인했다. Merryhere 소스 저장소와 DB DDL은 제공되지 않아 **실제 DB PK/FK 제약은 아직 확인하지 못했다**. 다음은 관측된 HTTP 식별자 역할이다.

| 내부 변수 | 관측된 외부 필드 | 의미·근거 |
| --- | --- | --- |
| `actor.actorId` | MYSCube `orgs/mysc/members/{id}` | 기존 Slack 이메일 조회로 확인된 활성 회원 문서 ID. 정산용 auditor를 사용하지 않는다. |
| `slot.roomId`, `intent.roomId` | `POST /reserve`의 `reservation_id` | checkbox `value`의 첫 번째 값. 실제 JS가 동일 방 여부를 검증한 뒤 이 필드에 넣는다. 생성된 예약 번호가 아니다. |
| `slot.ordinal`, `intent.ordinals` | `reserve_slot` | checkbox `value` 두 번째 값. 실제 JS가 연속 번호를 검증하고 쉼표로 연결한다. |
| `slot.reservationId`, `intent.reservationId` | `data-list-id`, `POST /reserveinfo`의 `reservation_list_id` | 기존 예약 상세 조회에 쓰이는 예약 레코드 식별자. 방 ID와 교환할 수 없다. |
| `intent.id` | 외부 대응 PK 없음 | Slack job + 실제 회원 ID의 해시. 내부 멱등성 확인번호이며 외부 예약 PK로 취급하지 않는다. |

로그인: `GET /auth/login` → 해당 세션의 `_token`과 `email/password`를 `POST /auth/login`. 날짜별 예약표: `GET /reservation?date=YYYY-MM-DD`. 예약 제출: `_token/reserve_date/reservation_id/reserve_slot/title`을 `POST /reserve`. 상세 조회: `_token/reservation_list_id`를 `POST /reserveinfo`.

예약표는 선택 날짜와 예약 버튼의 날짜가 일치해야 한다. `disabled` 또는 `readonly`인 빈 셀도 blocked로 처리한다. `data-list-id` 및 예약 클래스는 기예약, `paid-slot`/`studio-outlink-slot`은 외부 신청으로 처리한다. 알 수 없는 클래스·누락·중복·잘못된 시각은 가용 상태로 보정하지 않는다.

## 계정 연결 (웹에서 한 번)

운영 기본 경로는 서버 연결이다. 사용자는 명령어 없이 다음과 같이 연결한다.

1. 연결하지 않은 사용자가 회의실을 요청하거나 Slack에서 `회의실 계정 연결`을 보내면, 봇이 **요청자에게만 보이는**(`chat.postEphemeral`) 일회용 링크를 준다. 15분 유효, 1회 사용, 링크당 로그인 시도 5회.
2. 링크(`/api/v1/merryhere/connect#<토큰>`)는 BFF가 직접 내려주는 별도 페이지다. 포털·관리자 화면과 무관하다. 토큰은 URL 조각(`#`)에만 있어 서버 접근 로그와 Referer에 남지 않는다. 페이지는 CSP nonce·`no-store`·`no-referrer`·프레임 금지를 적용한다.
3. 아이디·비밀번호·동의를 제출하면 서버가 실제 Merryhere 로그인 후 예약표(로그아웃 링크 포함)를 열어 성공을 확인한다. 성공할 때만 저장한다.
4. 저장값은 `merryhere_connections/{sha256(tenant/member)}`의 AES-256-GCM 암호문이다. AAD에 회원을 묶어 다른 회원 문서로 옮기면 복호화되지 않는다. 키는 GitHub Production 비밀값 `MERRYHERE_CREDENTIAL_KEY`(32바이트 base64)를 배포 시 전달한다. 키가 없거나 형식이 틀리면 링크 발급·저장을 거부하며 평문으로 대체 저장하지 않는다.
5. 예약 처리 시점에만 서버 메모리에서 복호화한다. Slack 답변·작업 기록·추적 기록에는 링크 토큰·비밀번호·쿠키를 남기지 않는다(저장본은 `[일회용 연결 링크 · 요청자에게만 전송]`으로 대체).
6. 로그인이 거부되면 연결을 `LOGIN_FAILED`로 표시하고 재연결 링크를 준다. `회의실 계정 연결 해제`는 저장값을 삭제한다.

키를 바꾸면 기존 연결은 복호화되지 않으므로 `INVALID`로 보고 재연결을 안내한다.

`MERRYHERE_EXECUTION_MODE=local`을 명시한 환경에서만 이전 개인 컴퓨터 실행기(`npm run merryhere:local`, `/api/v1/merryhere/local/*`)가 동작한다. 운영 배포는 이 값을 설정하지 않는다.

## 중복 방지와 장애 처리

서버 전용 `merryhere_booking_intents/{id}`에는 실제 요청자와 범위, 날짜·시간·방·슬롯·포인트, `PREPARED/SUBMITTING/UNKNOWN/CONFIRMED`를 저장한다. Firestore 클라이언트 접근 권한은 추가하지 않는다.

확정 전 transaction에서 의도를 `SUBMITTING`으로 바꾸고 `merryhere_booking_locks/{date}_{roomId}_{ordinal}`을 생성한다. 그 이후 POST는 한 번만 시도한다. 만료된 Slack 워커 재실행이나 Slack 답변 실패는 예약 재제출로 이어지지 않는다. 이미 제출한 의도는 예약표 및 소유 예약 상세의 식별 표식을 재조회한다. HTTP 200/302는 성공 증거가 아니다.

예약 확인 성공 시 해당 intent가 소유한 락만 transaction에서 삭제한다. 기존 배포의 CONFIRMED 락이 남았더라도 새 예약의 실제 예약표 전체 구간이 비어 있고 transaction에서도 소유 intent의 완료·날짜·방이 확인되면 교체한다. 따라서 웹에서 취소한 완료 예약의 시간대를 다시 예약할 수 있다. UNKNOWN/SUBMITTING은 실패 확정이 아니므로 TTL로 자동 해제하지 않는다. 관리자는 provider 실제 내역을 먼저 확인해야 하며, 같은 확인번호 재조회로 생성이 확인되면 완료 처리와 락 정리가 이루어진다.

미해결 조건이 남은 회의실 후속 답변은 회의실 경로를 사용한다. 중간에 다른 업무 대화가 있어도 보존된 스레드 이력의 가장 최근 bookingContext를 사용한다. 명시적인 정산·금액 업무는 기존 정산 도구 선택을 유지한다. 날짜가 없어서 오늘을 채운 경우에는 추가 질문과 실제 조회 답변에 그 기준을 표시한다.

화면 계약 오류 `page_changed`는 기존 `SLACK_ALERT_CHANNEL_ID`에 운영 알림을 보낸다. 같은 오류는 15분 동안 중복 억제하고 전송 실패는 1분 후 다음 요청에서 다시 시도한다. `merryhere_provider_alerts/page_changed`에 전송 상태를 남기고, 알림 기록 장애는 서버 로그에 고정 문구를 남긴다. 알림 실패가 원래 조회 실패·예약 확인 필요 답변을 바꾸지는 않는다. 계정정보·provider HTML·쿠키는 알림에 포함하지 않는다.

## 검증과 출시 조건

`npx vitest run server/mcp/merryhere.test.mjs`와 기존 Slack/agent 테스트로 코드·HTTP 모형 계약을 검증한다. 이 테스트는 실제 예약 성공 증거를 대체하지 않는다.

실제 Gemini 자연어 해석 검사는 main의 `Settlement Agent Slack Check` workflow에서 `check_rooms=true`로 수동 실행한다. 합성 대화 4회, 요청당 입력 4,000 token 상한이며 실제 Merryhere 조회·예약·Slack 메시지 발송은 없다. `scripts/check-merryhere-understanding.mjs`가 토큰 사용량과 정규화 결과를 출력한다. 로컬 Secret Manager 조회 경로는 없으며 main GitHub Actions 밖에서는 실행을 거부한다. 운영 중 자동으로 반복 실행하지 않는다.

사용자 웹 연결 후 **Slack 탐색 요청 → 서버 로그인·조회 → 후속 조건 → 예약 준비/확정 → 실제 예약 내역 일치 → Slack 답변**을 검증해야 출시 완료다. provider DB PK/FK 확인은 소스/DDL 접근 후 별도로 기록한다. 배포는 저장소 정책대로 main CI 성공 후 자동 Production Deploy 경로를 사용한다.
