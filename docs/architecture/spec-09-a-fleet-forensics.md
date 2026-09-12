# 시트 동기화 전 프로젝트 상태 포렌식

> 조사 스냅샷 시각: 2026-08-07T18:33:37+09:00 (2026-08-07T09:33:37Z, 라이브 데이터는 이후 변할 수 있음)  
> 범위: `inner-platform-live-20260316/(default)/orgs/mysc`  
> 안전 조건: Firestore 문서 `GET` 및 REST `:runQuery`만 사용했다. 쓰기·삭제·업데이트는 하지 않았다.

## 결론 요약

1. **[확인] 검증 이슈의 현재 저장 위치는 mirror의 `sheetFacts.issues`이며, refresh run에는 `response.sheetFacts.issues`로 실행 당시 사본이 남는다.** snapshot 루트는 의도적으로 메타데이터만 담고 month/year 문서는 별도 top-level 컬렉션에 둔다. 이슈는 snapshot 계열에 저장되지 않는다.
2. **[확인] 현재 mirror 43건 중 revision이 같은 것은 3건, source가 있으나 미반영 revision이 없거나 다른 것은 38건, source 자체가 없는 ERROR는 2건이다.** 다만 revision 불일치는 “최신 refresh 결과가 아직 apply되지 않음”만 증명한다. stage run 171건에는 `BLOCKED`가 한 건도 없어 38건 모두를 “시스템이 반영을 차단했다”고 단정할 수 없다.
3. **[확인] 현재 mirror 기준 `control_total_missing`은 26건, 영향 프로젝트는 `E_ESG_워킹그룹(p1781855648530)` 1곳뿐이다.** `2026 리더십살롱(p1784182417645)`의 현재 이슈는 `sheet_date_invalid` 2건이며 `control_total_missing`이 아니다.
4. **[확인] 백업 281건 중 `updatedAt=2026-07-31T06:01:59.300Z`는 4건·1프로젝트뿐이다.** 같은 시각 전후 refresh/stage run 및 `weekly_api_audit_events`/`audit_logs`는 0건이다. **[추정]** 네 문서는 동일 사용자 UID의 한 요청에서 함께 저장됐을 가능성이 높다. **[미확인]** 연결 가능한 run/audit ID가 없어 작업 종류와 실행 경로는 확정할 수 없다.

## 공통 재현 설정

아래 명령은 모두 읽기 전용이다. `POST`는 Firestore Structured Query의 `:runQuery`에만 사용한다.

```bash
TOK=$(gcloud auth print-access-token)
BASE='https://firestore.googleapis.com/v1/projects/inner-platform-live-20260316/databases/(default)/documents/orgs/mysc'
RUN="${BASE}:runQuery"
```

Firestore REST 값을 일반 JSON으로 바꾸는 jq 함수:

```jq
def v:
  if has("stringValue") then .stringValue
  elif has("integerValue") then (.integerValue|tonumber)
  elif has("timestampValue") then .timestampValue
  elif has("booleanValue") then .booleanValue
  elif has("nullValue") then null
  elif has("arrayValue") then [(.arrayValue.values // [])[] | v]
  elif has("mapValue") then ((.mapValue.fields // {}) | with_entries(.value |= v))
  else . end;
```

## 1. 검증 이슈 저장 위치

### 실제 위치

현재 이슈 원본의 예시 전체 경로:

```text
projects/inner-platform-live-20260316/databases/(default)/documents/orgs/mysc/
  cashflow_sheet_mirrors/p1781855648530
    .sheetFacts.issues[0] =
      { code: "control_total_missing", field: "depositControl", sourceCell: "BS9" }
```

동일 refresh 당시 사본:

```text
.../orgs/mysc/cashflow_sheet_refresh_runs/cfrefresh_0d488695bb65fd8bca854a298c9a3a81
  .response.sheetFacts.issues
```

해당 run은 `2026-08-07T00:55:25.656Z`에 생성되고 `00:55:28.040Z`에 `COMPLETED`됐다. `COMPLETED`는 시트 fetch/parse 결과가 mirror에 설치됐다는 뜻이지, cashflow 원장에 apply됐다는 뜻이 아니다.

mirror의 이슈만 재현:

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_sheet_mirrors"}],
  where:{fieldFilter:{field:{fieldPath:"projectId"},op:"EQUAL",
    value:{stringValue:"p1781855648530"}}},
  select:{fields:[{fieldPath:"projectId"},{fieldPath:"snapshotId"},
    {fieldPath:"sheetFacts.issues"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq '[.[] | select(.document) | {path:.document.name,
  issues:.document.fields.sheetFacts.mapValue.fields.issues}]'
```

refresh run 사본 재현:

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_sheet_refresh_runs"}],
  where:{fieldFilter:{field:{fieldPath:"projectId"},op:"EQUAL",
    value:{stringValue:"p1781855648530"}}},
  select:{fields:[{fieldPath:"projectId"},{fieldPath:"status"},
    {fieldPath:"createdAt"},{fieldPath:"completedAt"},
    {fieldPath:"response.sheetFacts.issues"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq '[.[] | select(.document) | select(
  [.document.fields.response.mapValue.fields.sheetFacts.mapValue.fields.issues.arrayValue.values[]?
   .mapValue.fields.code.stringValue] | index("control_total_missing")) |
  {path:.document.name, fields:.document.fields}]'
```

### snapshot 본문이 비어 보인 이유

**[확인]** 현재 코드의 `server/bff/routes/cashflow-sheet-lab.mjs:1371` `writeCashflowSheetReadModels`는 다음처럼 나눈다.

- `cashflow_sheet_snapshots/{snapshotId}`: 프로젝트, revision, summary, 연·월 목록 등 메타데이터
- `cashflow_sheet_snapshot_months/{snapshotId}_{yearMonth}`: 월별 cell
- `cashflow_sheet_snapshot_years/{snapshotId}_{year}`: 연간 합계와 annual cell
- `sheetFacts.issues`: 위 세 snapshot 컬렉션이 아니라 mirror 및 refresh run response

즉 `_months`와 `_years`는 snapshot의 Firestore subcollection이 아니라 `orgs/mysc` 바로 아래의 별도 top-level 컬렉션이다.

제보된 과거 ID `cfsnap_2819679f2605258bfd03e50de5778cf8`는 조사 시점에 “빈 fields 문서”가 아니라 **404 NOT_FOUND**였고, 세 snapshot 컬렉션에서 `snapshotId`로 조회해도 모두 0건이었다. 따라서 현재 상태만으로 과거에 빈 문서였는지, 이후 정리됐는지는 **미확인**이다. 현재 리더십살롱 snapshot `cfsnap_556bc027036bb215df08ff9fa769f08a`는 17개 메타 필드를 정상 보유한다.

```bash
curl -sS -H "Authorization: Bearer $TOK" \
  "$BASE/cashflow_sheet_snapshots/cfsnap_2819679f2605258bfd03e50de5778cf8" |
jq '{name, fields, error}'

# 현재 리더십살롱 snapshot: 메타 필드 17개, issues 필드 없음
curl -fsS -H "Authorization: Bearer $TOK" \
  "$BASE/cashflow_sheet_snapshots/cfsnap_556bc027036bb215df08ff9fa769f08a" |
jq '{path:.name, fieldCount:(.fields|length), fieldNames:(.fields|keys),
  hasIssues:(.fields|has("issues"))}'

for C in cashflow_sheet_snapshots cashflow_sheet_snapshot_months cashflow_sheet_snapshot_years; do
  jq -nc --arg c "$C" '{structuredQuery:{
    from:[{collectionId:$c}],
    where:{fieldFilter:{field:{fieldPath:"snapshotId"},op:"EQUAL",
      value:{stringValue:"cfsnap_2819679f2605258bfd03e50de5778cf8"}}}
  }}' |
  curl -fsS -X POST -H "Authorization: Bearer $TOK" \
    -H 'Content-Type: application/json' --data-binary @- "$RUN" |
  jq --arg c "$C" '{collection:$c,count:([.[]|select(.document)]|length)}'
done
```

## 2. 전 프로젝트 mirror 드리프트

판정식:

- `동기`: 두 revision이 모두 있고 동일
- `미반영`: `sourceRevision`은 있으나 `appliedSourceRevision` 없음
- `드리프트`: 두 revision이 모두 있으나 다름
- `소스 없음`: `sourceRevision` 없음

표에는 비교 가능성을 위해 hash 앞 12자리만 표시했다. 재현 명령은 전체 값을 출력한다.

| 프로젝트 | 상태 | sourceRevision | appliedSourceRevision | 시도 시각(UTC) | 주별연도 | 판정 |
|---|---|---|---|---|---|---|
| 2026 에코스타트업<br>`p1772676088818` | FRESH | `sha256:f16cd93efb53` | `sha256:7d51d1f9b223` | 2026-08-07T01:55:01.493Z | 2026 | 드리프트 |
| 2026 CMK<br>`p1772676112928` | FRESH | `sha256:7e9103059db6` | `sha256:77f4fc49bf39` | 2026-08-07T00:55:42.819Z | 2026 | 드리프트 |
| 2026 다자간협력<br>`p1773651024850` | FRESH | `sha256:ee1c4ac06a9b` | `sha256:6d5ccb1589ce` | 2026-08-07T08:33:51.401Z | 2026 | 드리프트 |
| AXR프로젝트경비경<br>`p1773817948751` | FRESH | `sha256:504bc2078d9f` | `sha256:0259f200da0d` | 2026-08-07T08:56:37.822Z | 2026 | 드리프트 |
| 바뀔 수 있고<br>`p1773994485543` | STALE | `sha256:899cf2bdf903` | `sha256:baadd232c741` | 2026-08-07T01:36:18.689Z | 2026 | 드리프트 |
| 2026농식품5기<br>`p1774438127328` | FRESH | `sha256:cd837bf930a3` | `sha256:f11d8722cb3e` | 2026-08-07T08:09:34.391Z | 2026 | 드리프트 |
| 2026 CTS3<br>`p1774837739372` | FRESH | `sha256:c6f26a7d5f7a` | `sha256:f589d366a5a1` | 2026-08-06T11:29:48.465Z | 2026 | 드리프트 |
| 26농산업AC 1기<br>`p1774869407448` | FRESH | `sha256:d900f62341f3` | `sha256:b59eb9a72937` | 2026-08-06T11:40:58.257Z | — | 드리프트 |
| 해외 수출바우처<br>`p1775029313910` | FRESH | `sha256:8593d9dbf1f7` | `sha256:8593d9dbf1f7` | 2026-08-05T06:48:40.405Z | 2026 | 동기 |
| IBS그린임팩트사업(YK IBS)<br>`p1775038613330` | STALE | `sha256:4494b2a6dc1d` | `sha256:8e975d8e3fc5` | 2026-08-06T09:50:26.429Z | — | 드리프트 |
| 26콘진원<br>`p1775040544761` | FRESH | `sha256:377a3ab659c4` | `sha256:5143af197ebb` | 2026-08-06T13:12:37.107Z | 2026 | 드리프트 |
| 해양수산AC<br>`p1775123221342` | FRESH | `sha256:bf8170c6938c` | `—` | 2026-08-06T10:19:18.015Z | — | 미반영 |
| 메트라이프 9.0<br>`p1775173797667` | FRESH | `sha256:960098b14207` | `sha256:1329274e211f` | 2026-08-07T00:54:25.056Z | 2026 | 드리프트 |
| 2026미실란<br>`p1775182201215` | FRESH | `sha256:20f74a2e1025` | `—` | 2026-08-06T09:51:15.308Z | — | 미반영 |
| IBS4 아모레 펀드<br>`p1775183713143` | FRESH | `sha256:e379cb79f018` | `sha256:24d06a02baa4` | 2026-08-07T00:54:29.493Z | 2026 | 드리프트 |
| 2026 핀테크AC<br>`p1775190567200` | FRESH | `sha256:d98d5ae904ec` | `sha256:702e46ef0248` | 2026-08-07T06:05:08.394Z | 2026 | 드리프트 |
| 2026인베스트경기<br>`p1775191778494` | FRESH | `sha256:34e130f7f74f` | `—` | 2026-08-06T14:23:38.938Z | — | 미반영 |
| 노루OI_1단계<br>`p1775198490730` | FRESH | `sha256:cf692453ced6` | `sha256:cf692453ced6` | 2026-08-05T06:56:47.821Z | 2026 | 동기 |
| 2026 벤처리움<br>`p1775202100607` | FRESH | `sha256:cd346f7e5b83` | `sha256:025cfc5c132c` | 2026-08-07T08:38:48.369Z | 2026 | 드리프트 |
| 25현대모비스CSV<br>`p1775209262483` | STALE | `sha256:d34f6430cdd8` | `—` | 2026-08-07T08:31:16.148Z | — | 미반영 |
| A_탐나는인재 창업<br>`p1775209310774` | FRESH | `sha256:ad825b172034` | `sha256:b17420234070` | 2026-08-07T00:18:46.428Z | 2026 | 드리프트 |
| 2026코이카DAK<br>`p1775710502280` | FRESH | `sha256:e925e1efc8c3` | `sha256:f98577027ee5` | 2026-08-06T10:17:02.705Z | 2026 | 드리프트 |
| 투자관리팀_경비<br>`p1775788246004` | FRESH | `sha256:c4241777cdbe` | `sha256:25e08252faa4` | 2026-08-07T02:21:50.789Z | — | 드리프트 |
| KOICA네팔<br>`p1776043128740` | FRESH | `sha256:c67c5a38f9e7` | `sha256:9aa3d3c7d71a` | 2026-08-07T04:04:08.228Z | 2026 | 드리프트 |
| JLIN IBS<br>`p1776054335896` | FRESH | `sha256:f979905c8c1e` | `sha256:bbee952dcc1b` | 2026-08-06T09:21:21.877Z | 2026 | 드리프트 |
| 26예비그린유니콘<br>`p1778036126702` | FRESH | `sha256:04db14dc17e7` | `sha256:c068c791fb65` | 2026-08-06T09:31:32.463Z | 2026 | 드리프트 |
| 26 경기사경<br>`p1778159686721` | FRESH | `sha256:53f840d86cc7` | `sha256:d82a607c9700` | 2026-08-06T14:16:12.351Z | — | 드리프트 |
| 2026상스캠10기<br>`p1778219766945` | FRESH | `sha256:cd54fc537412` | `sha256:a578e5fc3088` | 2026-08-06T13:05:07.335Z | 2026 | 드리프트 |
| 2026 D-TIPS<br>`p1779092105308` | FRESH | `sha256:601190017b5b` | `sha256:601190017b5b` | 2026-08-05T13:40:42.116Z | 2026 | 동기 |
| 김제청년로컬랩2기<br>`p1779259830723` | FRESH | `sha256:5476afbcb5c4` | `sha256:824eb806268a` | 2026-08-06T14:44:15.898Z | 2026 | 드리프트 |
| 아나볼라이프브랜딩<br>`p1779347688585` | FRESH | `sha256:407cca78e729` | `—` | 2026-08-06T11:44:26.005Z | — | 미반영 |
| 26대전청년내일가게<br>`p1780048681754` | FRESH | `sha256:80e07b3540ea` | `sha256:b2d1dcab3e42` | 2026-08-07T02:37:06.801Z | — | 드리프트 |
| 2026맘스미<br>`p1780636846974` | FRESH | `sha256:62f83b4a289e` | `—` | 2026-08-06T09:49:28.750Z | — | 미반영 |
| 2026홍시궁<br>`p1780637497720` | FRESH | `sha256:15bfa51fbfc9` | `—` | 2026-08-06T10:04:30.722Z | — | 미반영 |
| KDB넥스트원 광주<br>`p1780662870530` | FRESH | `sha256:57289fc620ac` | `—` | 2026-08-06T12:42:36.528Z | — | 미반영 |
| E_ESG_워킹그룹<br>`p1781855648530` | FRESH | `sha256:e1f3cbe05292` | `sha256:fb2573ed6d8c` | 2026-08-07T00:55:25.656Z | 2026 | 드리프트 |
| 2026 그래비티<br>`p1782305050380` | FRESH | `sha256:39a7e447394f` | `sha256:008ba94182dd` | 2026-08-07T08:40:26.040Z | 2026 | 드리프트 |
| 2026전남글로벌<br>`p1782702681869` | ERROR | `—` | `—` | 2026-08-06T10:55:22.978Z | — | 소스 없음 |
| 슈니테크리뉴얼BI<br>`p1783569311574` | FRESH | `sha256:1d7484133d64` | `—` | 2026-08-06T10:19:33.341Z | — | 미반영 |
| 아름다운재단 교육<br>`p1784081899245` | ERROR | `—` | `—` | 2026-08-05T06:50:31.129Z | — | 소스 없음 |
| 2026 리더십살롱<br>`p1784182417645` | FRESH | `sha256:371e820027ab` | `sha256:2dcf42ef61b3` | 2026-08-07T08:45:40.567Z | 2026 | 드리프트 |
| A_모두의창업<br>`p1784195014099` | FRESH | `sha256:044101077069` | `sha256:32580f824095` | 2026-08-06T13:14:28.087Z | 2026 | 드리프트 |
| 26현대모비스CSV<br>`p1784700960534` | FRESH | `sha256:6fa4ac34cef9` | `sha256:77eb10a612a9` | 2026-08-06T13:01:02.553Z | — | 드리프트 |

재현 명령(43행과 전체 hash 출력):

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_sheet_mirrors"}],
  select:{fields:[{fieldPath:"projectId"},{fieldPath:"status"},
    {fieldPath:"sourceRevision"},{fieldPath:"appliedSourceRevision"},
    {fieldPath:"lastRefreshAttemptAt"},{fieldPath:"appliedWeeklyYears"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq -r 'def v: if has("stringValue") then .stringValue
  elif has("integerValue") then (.integerValue|tonumber)
  elif has("timestampValue") then .timestampValue
  elif has("arrayValue") then [(.arrayValue.values // [])[]|v]
  else null end;
  [.[]|select(.document)|.document.fields|with_entries(.value|=v)] |
  map(. + {verdict:(
    if .sourceRevision == null then "소스 없음"
    elif .appliedSourceRevision == null then "미반영"
    elif .sourceRevision == .appliedSourceRevision then "동기"
    else "드리프트" end)}) as $rows |
  {count:($rows|length),
   counts:($rows|group_by(.verdict)|map({verdict:.[0].verdict,count:length})),
   rows:$rows}'
```

**반영 차단 여부:** `sheetFacts.issues`가 있으면 `server/bff/routes/jvm-weekly-api.mjs:1563`의 `sheetControlBlockers`가 blocker를 만든다는 것은 코드로 확인된다. 그러나 라이브 stage run 상태는 `APPLIED 81`, `APPLYING 16`, `READY 74`, `BLOCKED 0`이다. 따라서 revision 불일치 38개 목록은 “갱신됐지만 아직 반영되지 않은 프로젝트”로는 확인되지만, 개별 원인이 검증 이슈인지, 사용자가 apply하지 않은 것인지까지는 미확인이다.

stage 상태 집계 재현:

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_sheet_stage_runs"}],
  select:{fields:[{fieldPath:"status"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq '[.[]|select(.document)|
  (.document.fields.status.stringValue // "(missing)")] as $s |
  {total:($s|length), statuses:($s|sort|group_by(.)|
    map({status:.[0],count:length})),
   blocked:([$s[]|select(.=="BLOCKED")]|length)}'
```

## 3. 현재 이슈 코드 분포

모집단은 43개 mirror의 현재 `sheetFacts.issues`다. refresh run 누적 이력과 섞지 않았다.

| 코드 | 현재 이슈 건수 | 영향 프로젝트 수 |
|---|---:|---:|
| `control_total_missing` | 26 | 1 |
| `sheet_date_invalid` | 140 | 11 |
| `sheet_value_invalid` | 13 | 12 |
| 합계 | 179 | 중복 프로젝트 포함 |

`control_total_missing`의 유일한 영향 프로젝트는 `E_ESG_워킹그룹(p1781855648530)`이다. 해당 프로젝트 refresh 이력에는 같은 26개 이슈 묶음이 2회 저장돼 있으므로, 누적 refresh 문서 기준으로는 52건이지만 현재 영향 프로젝트는 1개다.

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_sheet_mirrors"}],
  select:{fields:[{fieldPath:"projectId"},{fieldPath:"sheetFacts.issues"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq 'def v: if has("stringValue") then .stringValue
  elif has("arrayValue") then [(.arrayValue.values // [])[]|v]
  elif has("mapValue") then ((.mapValue.fields // {})|with_entries(.value|=v))
  else null end;
  [.[]|select(.document)|{id:(.document.name|split("/")|last),
    d:(.document.fields|with_entries(.value|=v))}] as $x |
  [$x[] as $doc | $doc.d.sheetFacts.issues[]? |
    {code:(.code//"(missing)"),projectId:$doc.id}] |
  group_by(.code) | map({code:.[0].code,issues:length,
    projects:([.[].projectId]|unique|length)})'
```

## 4. `2026-07-31T06:01:59.300Z` touch의 정체

### 확인된 문서

| 프로젝트 | 문서 | 연월/주차 | updatedBy |
|---|---|---|---|
| 2026 다자간협력 (`p1773651024850`) | `p1773651024850-2025-04-w2` | 2025-04 / 2 | `fGcHo...` / `mwbyun1220@mysc.co.kr` |
| 동일 | `p1773651024850-2025-05-w1` | 2025-05 / 1 | 동일 |
| 동일 | `p1773651024850-2025-06-w1` | 2025-06 / 1 | 동일 |
| 동일 | `p1773651024850-2025-12-w4` | 2025-12 / 4 | 동일 |

백업 자체 재검산:

```bash
jq '{total:length,
  exact:([.[]|select(.document.fields.updatedAt.stringValue==
    "2026-07-31T06:01:59.300Z")]|length),
  projects:([.[]|select(.document.fields.updatedAt.stringValue==
    "2026-07-31T06:01:59.300Z")|
    .document.fields.projectId.stringValue]|unique)}' \
  docs/architecture/stray-weeks-backup-20260808.json
```

라이브 exact query:

```bash
jq -nc '{structuredQuery:{
  from:[{collectionId:"cashflow_weeks"}],
  where:{fieldFilter:{field:{fieldPath:"updatedAt"},op:"EQUAL",
    value:{stringValue:"2026-07-31T06:01:59.300Z"}}},
  select:{fields:[{fieldPath:"projectId"},{fieldPath:"yearMonth"},
    {fieldPath:"weekNo"},{fieldPath:"updatedAt"},
    {fieldPath:"updatedByUid"},{fieldPath:"updatedByName"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq '[.[]|select(.document)|{path:.document.name,fields:.document.fields}]'
```

### run/audit 대조

`05:55:00Z`~`06:10:00Z`로 넓힌 창에서의 결과:

| 컬렉션 | 전체 조회 문서 | 창 안 문서 |
|---|---:|---:|
| `cashflow_sheet_refresh_runs` | 528 | 0 |
| `cashflow_sheet_stage_runs` | 171 | 0 |
| `weekly_api_audit_events` | 425 | 0 |
| `audit_logs` | 1,775 | 0 |

다음 명령에서 `COLLECTION`과 `TIME_FIELD`를 각각 위 컬렉션/`createdAt`, `audit_logs`/`timestamp`로 바꿔 재현할 수 있다. 범위 필터는 선택 필드 전체를 읽은 뒤 로컬 jq에서 적용하므로 composite index나 query limit에 의한 누락이 없다.

```bash
COLLECTION=cashflow_sheet_stage_runs
TIME_FIELD=createdAt
jq -nc --arg c "$COLLECTION" --arg t "$TIME_FIELD" '{structuredQuery:{
  from:[{collectionId:$c}],
  select:{fields:[{fieldPath:$t},{fieldPath:"projectId"},
    {fieldPath:"status"},{fieldPath:"runId"},{fieldPath:"actorId"},
    {fieldPath:"userId"},{fieldPath:"commandName"}]}
}}' |
curl -fsS -X POST -H "Authorization: Bearer $TOK" \
  -H 'Content-Type: application/json' --data-binary @- "$RUN" |
jq --arg t "$TIME_FIELD" 'def v: if has("stringValue") then .stringValue
  elif has("timestampValue") then .timestampValue else null end;
  [.[]|select(.document)|{path:.document.name,
    d:(.document.fields|with_entries(.value|=v))}] |
  {total:length, window:[.[]|select(.d[$t] >= "2026-07-31T05:55:00Z"
    and .d[$t] <= "2026-07-31T06:10:00Z")]}'
```

### 판정

- **확인:** “281건 모두 동일 시각”이라는 전제는 틀렸다. 정확히 같은 시각은 4건뿐이다.
- **확인:** 네 문서의 `updatedAt`, `updatedByUid`, `updatedByName`이 완전히 같다.
- **추정:** 한 사용자 요청이 네 주차 문서를 함께 저장한 작업이다.
- **미확인:** refresh/stage/audit 연결 기록이 없으므로 시트 refresh, stage, 백필, 수동 UI 편집 중 어느 경로였는지 확정할 수 없다. 시간 일치만으로 “낙오 문서 281건 일괄 touch 배치”라고 부를 증거는 없다.

## QA 범위 확인

- 브라우저 QA는 수행하지 않았다. UI/소스 변경이 없는 읽기 전용 데이터 포렌식이기 때문이다.
- mirror 43행 = 표 43행을 확인했다.
- 현재 이슈 합계 `26 + 140 + 13 = 179`를 확인했다.
- Firestore 호출은 문서 `GET` 또는 `POST ...:runQuery`뿐이다.
- 이 조사에서 새로 수정한 파일은 이 문서뿐이다. 작업 시작 전부터 있던 다른 untracked 파일은 건드리지 않았다.
