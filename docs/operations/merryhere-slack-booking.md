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

## 서버 로그인 연결

서버 비밀값 `MERRYHERE_ACCOUNTS_JSON`은 다음 형태다. 키는 Slack user ID나 이메일이 아니라 **기존 회원 문서 ID**다.

```json
{"<member-document-id>": {"email": "<Merryhere-login>", "password": "<secret>"}}
```

실제 값은 Vercel/Secret Manager의 비밀값으로만 관리한다. 저장소·Slack·모델 입력·실행 trace에 넣지 않는다. 공용 계정은 승인된 회원별로 명시적으로 매핑해야 하며 묵시적 전사 fallback은 없다. HTTP 세션 쿠키와 CSRF는 단일 실행 메모리에만 유지한다. 새 외부 호스트로 인증정보를 전달하지 않는다.

## 중복 방지와 장애 처리

서버 전용 `merryhere_booking_intents/{id}`에는 실제 요청자와 범위, 날짜·시간·방·슬롯·포인트, `PREPARED/SUBMITTING/UNKNOWN/CONFIRMED`를 저장한다. Firestore 클라이언트 접근 권한은 추가하지 않는다.

확정 전 transaction에서 의도를 `SUBMITTING`으로 바꾸고 `merryhere_booking_locks/{date}_{roomId}_{ordinal}`을 생성한다. 그 이후 POST는 한 번만 시도한다. 만료된 Slack 워커 재실행이나 Slack 답변 실패는 예약 재제출로 이어지지 않는다. 이미 제출한 의도는 예약표 및 소유 예약 상세의 식별 표식을 재조회한다. HTTP 200/302는 성공 증거가 아니다.

불명 상태와 락은 자동 해제하지 않는다. 관리자는 provider 실제 내역을 먼저 확인한 뒤 처리해야 한다. 외부에서 수동 취소된 예약의 락도 현재 자동 해제하지 않는다. 이 보수적 제한은 중복 생성·포인트 차감을 방지한다.

## 검증과 출시 조건

`npx vitest run server/mcp/merryhere.test.mjs`와 기존 Slack/agent 테스트로 코드·HTTP 모형 계약을 검증한다. 이 테스트는 실제 예약 성공 증거를 대체하지 않는다.

실제 Gemini 자연어 해석 검사는 기존 `Settlement Agent Slack Check` workflow의 `check_rooms=true`로 수동 실행한다. 합성 대화 4회, 요청당 입력 4,000 token 상한이며 실제 Merryhere 조회·예약·Slack 메시지 발송은 없다. `scripts/check-merryhere-understanding.mjs`가 토큰 사용량과 정규화 결과를 출력한다. 운영 중 자동으로 반복 실행하지 않는다.

실제 서버 로그인 정보 연결 후 **Slack 탐색 요청 → provider 로그인/조회 → 후속 조건 → 예약 준비/확정 → 실제 예약 내역 일치 → Slack 답변**을 검증해야 출시 완료다. provider DB PK/FK 확인은 소스/DDL 접근 후 별도로 기록한다. 배포는 저장소 정책대로 main CI 성공 후 자동 Production Deploy 경로를 사용한다.
