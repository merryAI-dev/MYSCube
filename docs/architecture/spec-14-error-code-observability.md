# SPEC-14 — 설명 가능한 오류 가이드 (코드 노출 포함)

**작성:** 2026-08-07 (08-07 개정: SPEC-01 §4 3층 구조 반영) · **대상:** codex 독립 세션 · **선행 의존:** `spec-01-layering.md` §4 필독
**베이스 브랜치:** `origin/main` (기준 커밋 `6b4e160f`)
**작업 브랜치:** `fix/cashflow-error-code-visibility`
**배포 단위:** BFF + 프론트엔드 (JVM 무관)

---

## 1. 문제 (측정된 사실)

`server/bff/bff-utils.mjs:27-36`:

```js
export function resolveErrorResponse(error) {
  const statusCode = Number.isInteger(error?.statusCode) ? error.statusCode : 500;
  const exposeMessage = statusCode < 500 || error?.expose === true;
  return {
    statusCode,
    code: error?.code || (statusCode >= 500 ? 'internal_error' : 'request_error'),
    message: exposeMessage ? (error?.message || 'Request failed') : 'Internal server error',
    exposed: exposeMessage,
  };
}
```

`code`는 **이미 응답에 실려 나간다.** 문제는 프론트엔드가 그것을 사용자에게 보여주지 않는 것이다.

`src/app/platform/api-client.ts:430-437`:

```ts
throw new PlatformApiError(
  '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  response.status,
  requestId,
  responseBody,
);
```

`responseCode`/`responseMessage`는 `console.error`로만 나가고(`:424-429`), 던지는 오류에는 고정 문구만 들어간다. `responseBody`는 전달되므로 **정보는 살아 있으나 표면에 도달하지 않는다.**

결과: 아래가 화면에서 전부 동일하게 보인다.

| 실제 원인 | 성질 | 사용자가 보는 것 |
|---|---|---|
| 환경변수 미설정 | 영구 | 요청을 처리하지 못했습니다 |
| 토큰 발급 실패 | 일시/영구 | 요청을 처리하지 못했습니다 |
| 네트워크 타임아웃 | 일시 | 요청을 처리하지 못했습니다 |
| 라우트 데드라인 초과 | 일시 | 요청을 처리하지 못했습니다 |

**영구 장애와 일시 장애를 구분할 수 없다.** `docs/architecture/2026-07-27-jvm-bff-channel-audit.md`가 이 항목을 "레버리지가 가장 크다"고 지목한 이유다. 현재는 모든 진단이 서버 로그 고고학을 요구하며, 이는 사용자도 지원 담당자도 수행할 수 없다.

## 2. 목표 — SPEC-01 §4의 3층 구조

**표시의 1순위는 가이드다. 코드가 아니다.** 화면은 아래 3층을 이 순서로 보인다:

| 층 | 내용 | 예 (`cashflow_sheet_apply_in_progress`) |
|---|---|---|
| **1. 가이드** | 무엇이 일어났고 **다음에 무엇을 하면 되는지** | "시트 값을 반영하는 중이에요. 잠시 뒤 자동으로 풀립니다. 그때 다시 확인해 주세요." |
| **2. 상태** | 재시도로 풀림 / 기다림 / 담당자 필요 | 기다림 |
| **3. 식별자** | `code` + `requestId` (보조 텍스트) | `cashflow_sheet_apply_in_progress · req-abc123` |

사용자가 **스크린샷 한 장으로** 담당자에게 상황을 전달할 수 있고, 그 전에 **스스로 다음 행동을 알 수 있어야** 한다.

`ApiErrorPresentation`을 확장한다:

```ts
export interface ApiErrorPresentation {
  guide: string;                                    // 1층: 다음 행동을 포함한 안내
  resolution: 'retry' | 'wait' | 'contact';         // 2층: 해소 경로
}
```

(기존 `message`/`retryable` 대신 위 형태를 쓴다. `retryable`은 `resolution === 'retry'`로 파생된다. 4-2 표의 `retryable` 열은 `resolution` 판정 근거로 읽는다: true → `retry` 또는 `wait`, false → `contact` 또는 사용자 행동 안내.)

**계층 배치 (SPEC-01 §4-3):** 이 매핑 모듈은 애플리케이션 서비스 계층의 **번역기**다. 서버 `code`(도메인이 만든 구조화된 사유)를 사용자 언어로 번역만 한다. 여기서 원인을 추론하거나 판정하지 않는다.

## 2-B. 정량 목표 (SPEC-00 E절 규격)

이 스펙의 지표는 응답시간이 아니라 **진단 비용**이다.

| 축 | 현재 | 목표 | 회귀 예산 |
|---|---|---|---|
| **진단 가능성** — 화면만 보고 영구/일시 장애 구분 | 불가 (0%) | **가능** (매핑된 코드 100%) | 미매핑 코드도 statusCode 폴백으로 구분 |
| **지원 왕복** — 원인 특정까지 필요한 문의 왕복 | 서버 로그 조회 필요 (≥1 왕복) | **0 왕복** (스크린샷 1장) | — |
| **헛된 재시도** — `retryable:false` 상황에서 재시도 버튼 노출 | 항상 노출 | **0건** | 0 |
| **응답시간** | — | **회귀 없음** | p95 +2% 이내 |
| **트래픽** | — | **증가 없음** | 응답 크기 동일 (서버 변경 없음) |
| **참조 횟수** | — | **변경 없음** | 동일 |

**서버 응답은 바뀌지 않는다.** `code`는 이미 나가고 있고, 이 작업은 프론트가 그것을 쓰게 만드는 것뿐이다. 따라서 성능 축은 전부 "회귀 없음"이 조건이다.

검증: `retryable:false` 12개 코드 각각에 대해 재시도 버튼 부재를 단언 (5-1의 1번과 짝).

## 2-C. 구조 요구사항 (SPEC-00 C·D절)

- 오류 → 문구 매핑은 **`api-error-messages.ts` 한 곳**이 SSOT다. 화면 컴포넌트가 각자 `if (code === ...)`를 쓰지 않는다
- 매핑 모듈은 **순수 함수**다. React·네트워크·`import.meta.env`에 의존하지 않는다
- 매핑 테이블은 `Object.create(null)` 또는 `Map`으로 만든다 (5-3의 17번)
- 신규 파일 400줄 이내
- **소스 스캔 테스트**: 캐시플로 화면 컴포넌트에 오류 코드 문자열 리터럴이 등장하지 않는다 (매핑 모듈 외)

## 3. 범위

### 포함
- `src/app/platform/api-client.ts` — `PlatformApiError`에 `code`/`responseMessage` 보존
- 신규 `src/app/platform/api-error-messages.ts` — `code` → 한국어 문구 + 재시도 가능 여부 매핑
- 캐시플로 화면의 오류 표시 지점 (아래 4-3에 열거)

### 제외 (건드리지 말 것)
- `server/bff/bff-utils.mjs`의 5xx 메시지 가림 정책 — **의도된 보안 동작이다.** 내부 예외 문구를 노출하지 않는 현재 규칙을 유지한다. 노출할 것은 `code`이지 `message`가 아니다
- 새 오류 코드 신설 — 기존 코드만 매핑한다
- 서버 로깅 변경
- JVM 코드

## 4. 요구사항

### 4-1. `PlatformApiError`가 코드를 잃지 않는다

`api-client.ts`에서 던질 때 서버 `code`와 서버 `message`를 인스턴스 필드로 보존한다. 기존 생성자 시그니처와 `body` 전달은 유지한다(호출부 회귀 금지).

필요한 접근자:
- `error.code` — 서버가 준 `code` (없으면 `''`)
- `error.serverMessage` — 서버가 준 `message` (없으면 `''`)
- 기존 `error.message`는 **기본 문구를 유지**한다. 이미 이 문구를 표시하는 화면이 있으므로 바꾸면 회귀다

### 4-2. 코드 → 문구 매핑

신규 `src/app/platform/api-error-messages.ts`:

```ts
export interface ApiErrorPresentation {
  message: string;      // 운영 언어 한국어 문구
  retryable: boolean;   // 사용자가 다시 시도해서 풀릴 수 있는가
}
export function resolveApiErrorPresentation(code: string, statusCode: number): ApiErrorPresentation;
```

최소한 아래 코드를 매핑한다 (전부 코드베이스에 실재하는 코드다):

| code | 문구 방향 | retryable |
|---|---|---|
| `cashflow_sheet_apply_in_progress` | 시트 반영이 진행 중임을 알림 | true |
| `cashflow_sheet_operation_uncertain` | 반영 결과 확인 중이며 같은 요청으로 재시도 가능 | true |
| `cashflow_month_close_request_conflict` | 이미 요청이 존재함 | false |
| `cashflow_month_close_approver_required` | 조직장 지정 필요 | false |
| `cashflow_month_close_self_approval_forbidden` | 본인 승인 불가 | false |
| `cashflow_sheet_mirror_revision_conflict` | 시트 고정본 변경됨, 재검토 필요 | false |
| `jvm_weekly_api_identity_token_unavailable` | 서버 인증 설정 문제, 담당자 문의 | **false** |
| `jvm_weekly_api_token_unconfigured` | 서버 연결 설정 문제, 담당자 문의 | **false** |
| `jvm_weekly_api_internal_error` | 서버 일시 오류 | true |
| `cashflow_month_close_route_timeout` | 처리 시간 초과 | true |
| `internal_error` | 알 수 없는 오류 | true |
| `forbidden` | 권한 없음 | false |

**핵심 구분:** `*_unconfigured` / `*_token_unavailable` 계열은 재시도해도 절대 풀리지 않는다. 사용자가 새로고침을 반복하지 않도록 `retryable: false`로 명확히 나눈다.

미등록 코드는 statusCode로 폴백한다: `>=500` → 일시(재시도 가능), `4xx` → 영구(재시도 불가), 문구는 일반 안내.

문구 작성 규칙 (`CLAUDE.md` UI 원칙):
- 운영 언어로 쓴다. 내부 필드명·약어·`X`·`N/A` 금지
- `code` 문자열 자체를 문구에 넣지 않는다. 코드는 별도 필드로 표시한다

### 4-3. 화면 표시

캐시플로 오류 표시 지점에 **문구 + code + requestId**를 함께 낸다. 최소 대상:

- `src/app/components/cashflow/CashflowProjectSheet.tsx` — 기존 `현금흐름 데이터를 불러오지 못했습니다.` 지점
- `src/app/data/cashflow-weeks-store.tsx` — `setLoadError` 지점

표시 형태는 기존 오류 UI 컴포넌트를 재사용한다. **새 디자인을 만들지 않는다.** `code`와 `requestId`는 본문보다 작은 보조 텍스트로 둔다.

`retryable: false`인 경우 재시도 버튼을 노출하지 않는다 (헛된 재시도 유도 금지).

## 5. 성공 조건 (전부 자동 검증 가능해야 함)

### 5-1. 매핑 단위 테스트 — `src/app/platform/api-error-messages.test.ts`

1. 표 4-2의 각 코드가 지정된 `retryable` 값을 돌려준다 (12건 전부 개별 단언)
2. 미등록 코드 + 503 → `retryable: true`
3. 미등록 코드 + 422 → `retryable: false`
4. 빈 코드 + 500 → `retryable: true`, 문구는 비어 있지 않다
5. **모든 매핑 문구가 비어 있지 않고, `code` 문자열을 포함하지 않는다** (표 전체 순회)
6. **모든 매핑 문구에 영어 소문자 식별자 패턴(`/[a-z_]{8,}/`)이 없다** — 내부 코드 유출 방지
6-b. **모든 가이드 문구가 행동 지시를 포함한다** — SPEC-01 §4: "무엇이 잘못됐다"만 있고 "무엇을 하라"가 없는 문구는 실패. 각 매핑에 대해 `resolution`과 문구의 정합을 사람이 검수 가능한 스냅샷 테스트로 고정
6-c. **`resolution: 'contact'`인 코드에 재시도 안내 문구가 없다** — 설정 오류(`*_unconfigured` 등)에 "다시 시도해 주세요"가 들어가면 실패

### 5-2. `PlatformApiError` 보존 테스트

7. 서버가 `{code, message}`를 준 4xx 응답 → `error.code`, `error.serverMessage`가 채워진다
8. 서버가 빈 본문을 준 502 → `error.code === ''`, 기존 기본 `error.message`는 유지된다
9. **기존 `error.message` 기본 문구가 바뀌지 않는다** (회귀 방지 — 이 문구를 쓰는 화면이 있다)
10. `error.body` 전달이 유지된다 (기존 호출부 회귀 방지)

### 5-3. 스트레스 / 적대적 입력 (필수)

이 절은 **반드시** 구현한다. 오류 경로는 비정상 입력이 들어오는 곳이다.

11. `code`가 10만 자 문자열 → 화면 문구가 오염되지 않고, 표시용 코드는 길이 제한(예: 64자)으로 잘린다
12. `code`에 `<script>alert(1)</script>` → 문자열로만 취급되고 매핑은 폴백으로 간다
13. `code`가 `null` / `undefined` / 숫자 `500` / 객체 `{}` / 배열 → 던지지 않고 폴백을 돌려준다 (5케이스 개별 단언)
14. `statusCode`가 `NaN` / `-1` / `999` / `undefined` → 던지지 않고 폴백을 돌려준다
15. 응답 본문이 JSON이 아닌 HTML(게이트웨이 오류 페이지) → 파싱 실패로 죽지 않고 폴백 문구가 나온다
16. 응답 본문이 `{"message": {...중첩 객체...}}` → 문자열이 아닌 message를 화면에 그대로 렌더하지 않는다
17. **매핑 테이블이 프로토타입 오염에 안전하다** — `code`가 `__proto__` / `constructor` / `toString`일 때 폴백으로 간다 (3케이스). 매핑 조회에 `Object.create(null)` 또는 `Map` 또는 `Object.hasOwn` 가드를 쓴다
18. 같은 오류를 1,000회 연속 매핑해도 매핑 테이블이 변형되지 않는다 (반환값 변경이 원본에 새지 않는지 — 반환 객체를 호출부가 수정한 뒤 재조회해 동일 값 확인)

### 5-4. 게이트

- `npm test` 통과 (기존 테스트 회귀 0)
- `npm run build` 통과
- `git diff --check` clean

## 6. 완료 정의

- [ ] 위 18개 단언이 전부 통과
- [ ] 기존 테스트 회귀 0
- [ ] `bff-utils.mjs`의 5xx 메시지 가림 정책 **미변경** (diff에 등장하면 실패)
- [ ] 새 오류 코드 신설 없음
- [ ] 커밋: `fix(cashflow): surface server error codes in the UI`

## 7. 하지 말 것

- 5xx `message`를 사용자에게 노출 (보안 정책 위반)
- 오류 표시용 새 디자인 시스템 도입
- `console.error` 로깅 제거 (운영자가 쓰고 있다)
- 이 스펙에 없는 화면까지 오류 UI 확장
