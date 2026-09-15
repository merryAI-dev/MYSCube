# 참여율 시트 반영 파이프라인 설계 (BFF-only)

- 날짜: 2026-08-21 · 설계: MERRY(octopus) · 결정 근거: 보람
- 전제 계약: `docs/architecture/contracts/2026-08-21-participation-sheet-format-contract.md`
- 결정: **JVM 은 쓰지 않는다.** 참여율의 원천(source of record)은 시트이고, 반영된 이후의
  조회 진실은 플랫폼(Firestore `partEntries`)이다. 재계산·마감 같은 판정 로직이 없으므로
  BFF 검증만으로 충분하다.

## 0. 겹침 분석 (fusilier/codex 경계)

건드리지 않는 것: `cashflow-sheet-lab.mjs`, `jvm-weekly-api.mjs`, `edit-lease.mjs`,
월결산·주정산 어떤 표면도. 새로 만드는 것은 전부 참여(participation) 이름공간이다.
공유 모듈은 **읽기만** 한다: `google-sheets.mjs`(시트 값 읽기, URL 파서),
`bff-utils.mjs`(RBAC·idempotency), 감사 체인.

## 1. SaaS 영감 → 우리 장치 대응표

| 어디서 | 패턴 | 우리 장치 |
|---|---|---|
| Salesforce Bulk API | **upsert by External ID** — 재실행해도 안전한 행 정체성 | entryId = `pts-{projectId}-{사람키}-{투입시작월}` (stint 키). 같은 시트를 두 번 반영해도 결과 동일 |
| Salesforce Duplicate Rules | 차단(block)이 아니라 **경고(alert) 모드** | People 미연결 이름은 막지 않고 `PENDING_LINK` 로 보고. People 등록이 따라오면 다음 반영에서 연결 |
| Salesforce Bulk API 결과 파일 | **행 단위 성공/실패 리포트** | preview 응답이 행마다 `CREATED/UPDATED/UNCHANGED/REMOVED/PENDING_LINK/PLACEHOLDER/ERROR` 를 돌려줌 |
| Flatfile / OneSchema | **staged import**: 파싱 → 검증 → 사람 확인 → 커밋 | preview(stage) → apply 2단계. apply 는 preview 가 만든 run 증거를 그대로 재검증 |
| Stripe | idempotency key | 기존 `createMutatingRoute(idempotencyService, …)` 재사용 |
| Airbyte sync run | 실행마다 불변 run 레코드 + 원본 해시 | `participation_sheet_runs/{runId}` 불변 문서. sourceHash 가 다르면 apply 거부 |

cashflow Sheet Lab 의 mirror→stage→apply 3단은 이 축소판(2단)으로 충분하다 - 참여율에는
수식 검증도 마감 상태도 없다.

## 2. 데이터 모델

### 2.1 `projects/{projectId}.participationSheet` (사업 바인딩, 등록/수정 폼이 저장)
```js
participationSheet: {
  sheetUrl: string,        // 사람이 붙여넣은 원본 URL
  spreadsheetId: string,   // extractSpreadsheetId() 결과
  savedAt: string, savedBy: string,
  appliedRunId: string | null,   // 마지막으로 반영된 run. null 이면 아직 시트 반영 전
}
```

### 2.2 `orgs/{org}/participation_sheet_runs/{runId}` (불변 증거)
```js
{
  runId: `ptr-${projectId}-${ulid}`, projectId, tenantId,
  formatId: 'MYSC-PARTICIPATION-V1',
  period: { start: 'YYYY-MM', end: 'YYYY-MM' },   // 시트 B1/D1
  sourceHash: string,          // 파싱된 행들의 stableHash - apply 시 재조회 값과 대조
  rows: ParsedRow[],           // 파싱 결과 그대로 (감사용)
  report: RowResult[],         // 행 단위 판정
  issues: Issue[],             // 시트 수준 이슈 (미입력 목록 포함)
  status: 'STAGED' | 'APPLIED' | 'SUPERSEDED',
  stagedAt, stagedBy, appliedAt?, appliedBy?,
}
```

### 2.3 `partEntries` 확장 (기존 컬렉션, 새 source)
```js
{
  id: `pts-${projectId}-${personKey}-${stintStart}`,  // stint 키 = upsert external id
  source: 'PARTICIPATION_SHEET',       // 기존 PROJECT_TEAM_SYNC 와 구분
  projectId, personId?: string,        // 미연결이면 없음 → 대시보드 "연결 대기"
  identity: { nickname, name },        // 미연결 행의 원본 신원 (재연결 재료)
  role: string,
  stintStart: 'YYYY-MM', stintEnd: 'YYYY-MM' | null,
  monthlyRates: { 'YYYY-MM': number }, // 확인된 칸만. 빈칸은 키 자체가 없다 (미입력≠0)
  sheetRunId: string, updatedAt,
}
```

### 2.4 이중 집계 차단 (중요)

`syncProjectParticipationEntries`(사업 저장 시 팀원→참여행 동기화)와 시트 반영이 같은
사람을 만들면 대시보드가 **이중 합산**한다. 규칙:

- `participationSheet.appliedRunId` 가 있는 사업은 **시트가 이긴다**. apply 트랜잭션이 그
  사업의 `PROJECT_TEAM_SYNC` 참여행을 삭제하고, `syncProjectParticipationEntries` 는
  `appliedRunId` 가 있으면 그 사업을 건너뛴다.
- 시트 반영 전 사업은 지금처럼 팀원 동기화가 채운다 (하위 호환).

## 3. 함수 정의

### 3.1 `server/bff/participation-sheet-ingest.mjs` (새 파일 - 전부 순수 함수 + 코로케이트 테스트)

```js
/** 시트 원값 → 구조화. 실패는 던지지 않고 issues 로 돌려준다(행 단위 보고 원칙).
 *  ranges: { formatCell: '참조!F1', settings: '참여율!B1:D1', headers: '참여율!G2:DV2', data: '참여율!A3:DV62' } */
export function parseParticipationSheet({ formatCellValue, settingValues, headerValues, dataValues })
  : { formatId, period: {start,end}, rows: ParsedRow[], issues: Issue[] }
// ParsedRow = { rowIndex, nickname, name, role, stintStart, stintEnd, cells: { 'YYYY-MM': number } }
// 셀 3상태: 빈칸 → cells 에 키 없음. 0 → 0. 그 외 숫자 0~100. 범위 밖 → issue(row).

/** 양식 검증. 하나라도 걸리면 전체 거부("양식이 다릅니다" 원칙). */
export function validateParticipationFormat({ formatId, period, headerValues })
  : Issue[]  // participation_format_mismatch | participation_period_invalid | participation_header_gap
// 검사: formatId === 'MYSC-PARTICIPATION-V1', 헤더가 연속 YYYY-MM, 헤더 첫/끝 === B1/D1.

/** 플랫폼 계약 기간 대조. 시트 기간 ≠ 계약 기간이면 거부 - 기간 변경의 순서를 강제한다. */
export function validatePeriodAgainstProject({ period, project })
  : Issue | null  // participation_period_mismatch (메시지에 양쪽 기간 명시)

/** 신원 해석. Salesforce matching rule 방식의 단계식, 항상 비차단.
 *  ① 닉네임 정확 일치(People 에서 유일) ② 이름·닉네임 합의 ③ 한쪽만 적혔으면 그 한쪽
 *  ④ `채용예정-N` → PLACEHOLDER ⑤ 못 찾음 → PENDING_LINK (오류 아님) */
export function resolvePeopleIdentity({ rows, people })
  : Array<ParsedRow & { personId?: string, linkState: 'LINKED'|'PENDING_LINK'|'PLACEHOLDER' }>

/** 행 규칙 검증. 급여 무결성의 핵심.
 *  - stintStart 없는데 값 있음 → ERROR participation_stint_start_required
 *  - stintStart > stintEnd → ERROR participation_stint_order
 *  - stint 창 밖의 값 → ERROR participation_value_outside_stint
 *  - 같은 사람(personKey)의 두 행이 같은 달에 모두 값 → ERROR participation_duplicate_month
 *  - stint 창 안의 빈칸 → WARNING(미입력 목록) - 차단하지 않되 반드시 보고 */
export function validateStintRows({ rows, period }) : Issue[]

/** 반영할 엔트리 생성. personKey = 닉네임(없으면 이름) 정규화 - 백필과 같은 세그먼트 규칙. */
export function buildStintEntries({ tenantId, projectId, project, rows })
  : PartEntryDoc[]

/** 현재 상태와의 diff. 사람이 확인할 것을 만든다(Flatfile preview 원칙).
 *  removals: 시트에서 사라진 기존 stint - 급여 이력 삭제이므로 acceptRemovals 없이는 반영 거부. */
export function diffParticipationEntries({ currentEntries, desiredEntries })
  : { creates, updates: Array<{entryId, monthChanges: {ym, before, after}[]}>, removals, unchanged,
      report: RowResult[] }
```

### 3.2 `server/bff/routes/participation-sheet.mjs` (새 파일)

```js
export function mountParticipationSheetRoutes(app, { db, googleSheetsService, idempotencyService, now })
```

| 라우트 | 역할 | 동작 |
|---|---|---|
| `PUT /api/v1/projects/:projectId/participation-sheet/config` | writeCore | `extractSpreadsheetId` 로 URL 검증 → `participationSheet` 저장(merge). 감사 이벤트 `participation.sheet.config_saved` |
| `POST …/participation-sheet/preview` | writeCore | ①config 읽기 ②`googleSheetsService` 로 4개 range 읽기 ③3.1 파이프 순서대로 실행 ④거부 이슈 없으면 run 문서 저장(STAGED) ⑤`{ runId, report, issues, diff }` 응답. 시트 fetch 실패(쿼터 등)는 `participation_sheet_unreachable` 로 정규화 |
| `POST …/participation-sheet/apply` | writeCore + idempotency | body `{ runId, acceptRemovals?: boolean }`. 트랜잭션: run 재조회(STAGED 확인) → 시트 재읽기 후 `sourceHash` 대조(어긋나면 `participation_source_changed` - 검토 후 시트가 바뀐 것) → removals 있는데 미승인 → `participation_removals_confirmation_required`(409, details 에 목록) → upsert + PROJECT_TEAM_SYNC 삭제 + run APPLIED + `appliedRunId` 갱신. 감사 이벤트 `participation.sheet.applied` |
| `GET …/participation-sheet/status` | readCore | config + 마지막 run 요약 (`연결 대기 n건` 포함) |

**조용한 실패 금지**: preview·apply 의 모든 거부는 코드와 함께 `details` 에 행 번호·달을
담는다. 프론트는 `resolveApiErrorPresentation` 에 코드별 안내를 등록한다(#638 의 교훈).

### 3.3 기존 파일의 최소 수정

| 파일 | 수정 | 이유 |
|---|---|---|
| `participation-dashboard.mjs` | `valueForMonth(entry, ym)` → `entry.monthlyRates` 가 있으면 `monthlyRates[ym] ?? 0`, 없으면 기존 기간×rate 로직 | 월별 상이 참여율. 기존 데이터 하위 호환 |
| `routes/projects.mjs` | `syncProjectParticipationEntries` 첫 줄에 `if (project?.participationSheet?.appliedRunId) return;` | 이중 집계 차단 (§2.4) |
| `api-error-messages.ts` | 위 오류 코드들의 한국어 안내 추가 | 조용한 실패 금지 |

### 3.4 프론트 (우리 소유 표면만)

```
ProjectEditorWizard (등록/수정): "참여율 시트 링크" 입력 1칸 - 저장 시 PUT config.
  검증은 BFF 가 한다. 폼은 URL 형태만 가볍게 본다.
platform-bff-client.ts:
  saveParticipationSheetConfigViaBff / previewParticipationSheetViaBff /
  applyParticipationSheetViaBff / getParticipationSheetStatusViaBff
반영 화면: 관리자 참여인력(ParticipationPage) 사업 상세에 "시트 반영" 버튼 + 리포트 표
  (행 단위 결과, 미입력 목록, 연결 대기, removals 확인 다이얼로그). cashflow Sheet Lab 의
  검토→확인→반영 UX 문법을 그대로 따른다 - 사용자가 이미 아는 흐름이다.
```

## 4. 오류 코드 표

| 코드 | 층 | 뜻 |
|---|---|---|
| `participation_format_mismatch` | 양식 | 참조!F1 식별자 불일치 - 다른/옛 양식 |
| `participation_header_gap` | 양식 | 월 헤더 불연속(열 추가·삭제 흔적) |
| `participation_period_invalid` | 양식 | B1/D1 비었거나 시작>종료 |
| `participation_period_mismatch` | 계약 | 시트 기간 ≠ 플랫폼 계약 기간 |
| `participation_stint_start_required` | 행 | 값은 있는데 투입시작월 없음 |
| `participation_stint_order` | 행 | 투입시작월 > 종료월 |
| `participation_value_outside_stint` | 행 | 투입기간 밖의 달에 값 |
| `participation_duplicate_month` | 행 | 같은 사람 두 행이 같은 달에 값 |
| `participation_removals_confirmation_required` | diff | 시트에서 사라진 stint - 명시 승인 필요 |
| `participation_source_changed` | apply | 검토 후 시트가 바뀜 - 다시 검토 |
| `participation_sheet_unreachable` | fetch | 시트 읽기 실패(쿼터·권한) - 재시도 안내 |

## 5. 구현 순서 (PR 분할)

1. **PR-A**: `participation-sheet-ingest.mjs` 순수 함수 + 테스트 (시트 없이 픽스처로 전부 검증)
2. **PR-B**: 라우트 + `valueForMonth` 확장 + sync 가드 + 오류 안내 (supertest 통합 테스트)
3. **PR-C**: 등록/수정 폼 링크 필드 + BFF 클라이언트
4. **PR-D**: 참여인력 화면 반영 UI (리포트 표 + removals 다이얼로그)

각 PR 은 독립적으로 배포 가능하고, D 전까지는 사용자 표면 변화가 없다.

## 6. 비목표

- JVM 관여 없음 (결정). 마감·잠금 개념 없음 - 급여 확정 후 잠금은 별도 논의(월 마감 패턴 재사용 후보).
- 시트 쓰기 없음 - 한 방향(sheet→platform). Sheet Lab 원칙과 동일.
- People 자동 생성 없음 - People 은 사람이 등록한다. 파이프라인은 연결만 한다.
