# Spec 09-B — 시트 검증 실패 클래스 분류 체계

> 조사일: 2026-08-07  
> 범위: 현재 소스의 읽기 전용 조사. 운영 데이터·Google Sheets API 응답은 조회하지 않았다.  
> 표기: **확인**은 코드 또는 아래 Node 재현으로 증명, **추정**은 외부 응답/실제 값에 따라 달라지는 결론이다.

## 결론

현재 파서는 **행·열 위치는 고정 좌표, 라벨과 헤더만 fail-closed**인 혼합 계약이다. 따라서 라벨/헤더가 움직이면 refresh가 실패하지만, 라벨을 그대로 둔 채 한 행의 셀만 삭제해 값이 좌측으로 밀리거나 행이 짧아지면 구조 검증을 통과한다. 이때 snapshot은 `sheetFacts.issues`가 있어도 `FRESH`, refresh run은 `COMPLETED`가 된다. 이 클래스가 최악의 **무음 통과**다.

리더십살롱 건만 특이했던 이유는 행 라벨과 고정 행 번호는 유지되어 template gate를 통과했고, ACTUAL 잔액 행의 값 배열만 한 칸 짧아 고정 BS 좌표가 빈칸이 되었기 때문이다. 이 패턴은 잔액 행에 한정되지 않는다. 모든 line/derived 행, 주차·연간·Total 구간에서 같은 위치 기반 오독이 가능하다.

## 1. 파이프라인 전체 지도

| 단계 | 실제 경로와 검증 | 저장되는 것 | 노출되는 곳 |
|---|---|---|---|
| FE refresh | `CashflowSheetLabPage.tsx:655-712`, `CashflowProjectSheet.tsx:1391-1460`에서 refresh BFF 호출. `FRESH`면 성공 문구를 표시한다(`CashflowSheetLabPage.tsx:693-701`). | 없음(FE state만 갱신) | template 실패의 `lastRefreshError.diagnostics`만 Lab 화면에 표시(`CashflowSheetLabPage.tsx:1129-1145`). `sheetFacts.issues` 표시 코드는 찾지 못함. |
| refresh reserve | `cashflow-sheet-lab.mjs:1257-1317`에서 generation/idempotency 검증 후 refresh run을 `IN_PROGRESS`, mirror에 pending generation 저장. | `cashflow_sheet_refresh_runs`, `cashflow_sheet_mirrors` | 직접 UI 노출 없음. |
| fetch/template | Google matrix를 읽고 `analyzeCashflowSheetTemplate` 실행(`cashflow-sheet-lab.mjs:4293-4307`). 고정 주차/연간 헤더, 라인/derived 라벨, Projection/Actual 일치 검증(`cashflow-sheet-template.mjs:124-171,173-213,293-326`). `template.supported=false`면 diagnostics와 함께 중단(`cashflow-sheet-lab.mjs:4308-4317`). | 실패 시 이전 mirror를 `STALE`, 없으면 `ERROR`로 만든다(`cashflow-sheet-lab.mjs:4372-4402`). | Lab의 연동 오류/diagnostics. |
| snapshot | 고정 mapping으로 weekly/annual/derived/Total 셀을 분류하고 facts 생성(`cashflow-sheet-snapshot.mjs:569-633`). 숫자 분류는 `classifyCashflowSheetCell`(`:28-52`); control/date issue는 `extractCashflowSheetFacts`(`:465-565`). | `cells`, `annualCells`, `annualDerivedCells`, `totalCells`, `sheetFacts.issues`, summary를 mirror 응답에 포함. | GET mirror가 문서를 그대로 반환(`cashflow-sheet-lab.mjs:4149-4156`). FE는 mirror를 읽음(`CashflowProjectSheet.tsx:668-677`). 단, issues 자체의 UI 노출은 없음. |
| publish | 최신 generation이면 mirror와 snapshot read models를 설치(`cashflow-sheet-lab.mjs:1319-1368`). read models는 mirror가 `FRESH`일 때만 기록(`:1371-1424`). | mirror, snapshot root/month/year; refresh run은 성공/실패 응답 모두 `COMPLETED`(`:1361-1366`). | refresh HTTP는 실패도 mirror 객체로 200 반환(`:4403-4421,4425-4428`). |
| stage | mirror 존재/revision/FRESH/config/target revision 확인(`cashflow-sheet-lab.mjs:3768-3824`). INVALID weekly cell과 월 구조 불완전은 blocked(`:1804-1813`), 월 고정본은 완전성 재검증(`:3864-3889`). | `cashflow_sheet_stage_runs`, stage month/year, change candidates(`:3933-3960,4008-4010`). | 결과 `BLOCKED/NO_CHANGES/READY`(`:3895-3925`); FE가 BLOCKED를 메시지로 노출(`CashflowSheetLabPage.tsx:803-812`). |
| apply | READY stage만 허용하고 mirror revision 재검증(`cashflow-sheet-lab.mjs:2289-2304`). 저장 직전 staged month 구조와 calculation evidence를 재검증(`:3017-3049`). endpoint는 `:4799-4831`. | JVM/Firestore canonical 값, stage/apply publication 상태. | formula mismatch만 별도 issues dialog로 노출(`CashflowSheetLabPage.tsx:928-933`, `CashflowProjectSheet.tsx:1607-1609`). 이는 `sheetFacts.issues`와 다른 타입이다. |
| 월마감 검증(인접 소비자) | `sheetFacts.issues`가 하나라도 있으면 blocker(`jvm-weekly-api.mjs:1558-1566`), control mismatch 및 weekly 계산도 검사(`:1566-1640`); 월마감 흐름에 합쳐짐(`:1927-1928,2132-2133`). | 월마감 결과/진단 | `CashflowProjectSheet`의 서버 검증 UI. 이 경로 때문에 `control_total_missing`이 “반영 차단”처럼 관찰될 수 있으나, sheet-lab stage 자체가 issues를 직접 gate하지는 않는다. |

### issues의 계보

1. template `reasons`: refresh catch에서 `lastRefreshError.diagnostics`로 저장되고 Lab에 노출된다 (`cashflow-sheet-lab.mjs:4308-4316,4372-4402`; `CashflowSheetLabPage.tsx:1129-1145`).
2. snapshot `sheetFacts.issues`: mirror/snapshot에 저장되지만 refresh 상태를 바꾸지 않는다 (`cashflow-sheet-snapshot.mjs:465-565,608-633`; `cashflow-sheet-lab.mjs:1357-1359`). 월마감 blocker에서는 소비되지만 Lab UI 직접 노출은 확인되지 않았다.
3. formula mismatch issues: apply 권위 서버 오류에서 추출해 dialog에 노출한다. snapshot issues와 별개다 (`CashflowSheetLabPage.tsx:928-933`; `CashflowProjectSheet.tsx:1607-1609`).

## 2. `COMPLETED`인데 화면이 “Total 미입력”인 경로

**확인:** refresh run의 `COMPLETED`는 검증 성공 의미가 아니라 “refresh 요청 처리 및 응답 저장 완료” 의미다. catch 경로의 `ERROR/STALE` 응답도 `completeCashflowSheetRefreshRun`을 호출하고 run을 `COMPLETED`로 쓴다 (`cashflow-sheet-lab.mjs:1319-1366,4372-4421`). 더 중요하게, template를 통과한 뒤 생성된 snapshot은 `sheetFacts.issues.length`와 무관하게 항상 `status:'FRESH'`다 (`cashflow-sheet-snapshot.mjs:598-615`).

mirror 갱신 조건은 다음과 같다.

- refresh generation이 현재 mirror보다 뒤처지지 않았을 때만 새 응답을 mirror에 설치한다 (`cashflow-sheet-lab.mjs:1345-1360`). 뒤처진 요청은 run만 `COMPLETED/superseded=true`이고 현재 mirror를 유지한다.
- 새 snapshot read model은 설치 응답이 `FRESH`이고 snapshot id가 유효할 때만 쓴다 (`cashflow-sheet-lab.mjs:1371-1375`).
- refresh 실패 시 이전 revision이 있으면 기존 셀을 보존한 `STALE` mirror가 된다 (`cashflow-sheet-lab.mjs:4385-4393`). FE도 STALE 응답에 현재 셀을 보존한다 (`CashflowSheetLabPage.tsx:683-692`; `CashflowProjectSheet.tsx:1403-1413`).

비교 화면의 `Total`은 Google Sheet BS 값을 직접 표시하는 단일 필드가 아니다. 주차 canonical read cells와 연간 totals를 합쳐 FE에서 다시 계산하고, 값 존재 상태가 없으면 `difference:null` → `Total 미입력`으로 렌더링한다 (`CashflowProjectSheet.tsx:1804-1853,2534-2535`). 따라서 (a) 새 FRESH mirror가 시프트된 값을 EMPTY/잘못된 연간 값으로 설치했거나, (b) refresh가 실패해 STALE 이전 mirror가 유지됐거나, (c) canonical annual/week read model에 값 상태가 없으면 run이 `COMPLETED`여도 화면은 “Total 미입력”일 수 있다.

## 3. 실패 클래스 분류

| 클래스 | 현재 동작 | 판정 | 근거 |
|---|---|---|---|
| 단일 행 좌측 시프트(셀 삭제) | 라벨이 A열에 남아 있으면 template **통과**. 이후 모든 고정 columnIndex를 그대로 읽어 weekly/annual/Total 값이 한 칸씩 오독된다. Total 원래 값은 코드가 읽지 않는 다음 열로 밀리고 BS는 이전 열 또는 EMPTY가 된다. | **최악: 무음 통과/오판**. line 행이면 잘못된 금액이 stage 후보가 될 수 있다. derived 행이면 canonical line 적용값은 직접 바뀌지 않지만 control/formula evidence가 왜곡된다. | 고정 좌표 `cashflow-sheet-template.mjs:7-9,215-272`; 배열 길이/정렬 검증 없음 `:293-333`; 재현 `row_left_shift supported:true`, shifted snapshot `FRESH`. |
| 행 길이 부족 | max width는 stats로만 계산되고 gate에 쓰지 않는다. 부족한 고정 좌표는 `undefined→EMPTY`; line cell EMPTY는 합법 상태라 stage 완전성도 통과할 수 있다. control Total만 `control_total_missing`. | **최악: 무음 통과/데이터 삭제 오판**. | optional access `cashflow-sheet-snapshot.mjs:84-85,132-145`; EMPTY 허용 `:28-31`; 월 validator가 EMPTY 허용 `cashflow-sheet-lab.mjs:1490-1533`; 재현 `short_row supported:true`. |
| 라인 라벨 변형·오타 | 공백 차이는 허용하고 policy label/alias와 정확 매칭. 미등록 오타는 `cashflow_line_invalid`, refresh ERROR/STALE. | 정상 거부. 단, 정책 alias로 등록된 표현은 의도된 통과. | lookup/ambiguity `cashflow-sheet-template.mjs:35-73`; 검증 `:173-195`; 재현 typo `supported:false`. |
| derived 라벨 변형·오타 | 공백 제거 후 공식 라벨과 정확 비교. 오타는 `cashflow_derived_row_invalid`. | 정상 거부. | `cashflow-sheet-template.mjs:197-213`; 재현 `잔액!` 거부. |
| 수식 오류 문자열 `#REF!`, `#N/A` | classifier가 INVALID. weekly line이면 summary invalid 및 stage blocked month. annual/derived INVALID는 formula preflight의 허용 상태 집합에서 제외되어 apply 차단. control/date 영역은 `sheet_value_invalid` issue가 된다. refresh 자체는 여전히 FRESH. | 지연 거부. **refresh 성공으로는 오해 가능**, stage/apply 또는 월마감에서 거부. | classifier `cashflow-sheet-snapshot.mjs:28-52`; stage INVALID block `cashflow-sheet-lab.mjs:1804-1813`; annual evidence `:1617-1675`; 재현 두 문자열 모두 INVALID, line snapshot은 `FRESH/invalid:1`. |
| 병합 셀 | parser 입력은 값 matrix뿐이고 merge metadata를 받거나 검사하는 코드가 없다. 병합의 좌상단 외 셀이 빈 문자열로 오면 EMPTY로 처리한다. 라벨/헤더 merge가 고정 좌표 값을 비우면 거부하지만, 금액 영역 merge는 EMPTY로 통과 가능하다. | **최악: 조건부 무음 통과**. 실제 Google API의 merged-value 반환 형태는 이번 코드 전용 조사로 미확인. | matrix-only 입력 `cashflow-sheet-template.mjs:293-296`; EMPTY 분류 `cashflow-sheet-snapshot.mjs:28-31`; merge metadata 참조 없음(확인). |
| 통화·서식 변형 | NFKC 후 comma/공백/NBSP/`원₩￦` 제거. `₩196,000,000`, `￦ 1,000 원`, 괄호/후행 minus는 정상 숫자. 대시는 EMPTY. 소수도 classifier VALUE지만 whole-won gate에서 INVALID issue 또는 stage 불완전으로 거부된다. 색/number format 같은 표시 metadata는 검사하지 않는다. | 지원된 문자열은 정상 통과; 지원 밖 텍스트는 INVALID. 표시 서식 자체는 무시. | `cashflow-sheet-snapshot.mjs:18-52,309-331`; 재현 결과 참조. |
| 공급가액↔공급대가 **라벨** 변경 | `직접사업비(공급가액)` 대신 미등록 `직접사업비(공급대가)`면 line label gate에서 거부. | 정상 거부. | policy 기반 lookup `cashflow-sheet-template.mjs:43-76,173-185`; 재현 `supply_label_changed supported:false`. |
| 공급가액/공급대가 **금액 정산 차이** | line별 금액은 독립적으로 읽고, 두 필드의 세무적 관계를 검증하는 코드가 없다. 합계/잔액 산술만 검사한다. 합계가 함께 맞춰져 있으면 의미상 불일치도 통과한다. | **최악: 무음 통과(semantic validation 부재)**. | weekly 계산은 IN/OUT 합계와 잔액만 계산 `cashflow-sheet-snapshot.mjs:341-404`; 재현 서로 다른 공급 관련 line 값에서도 `FRESH`, 해당 차이 issue 없음. |
| 헤더 주차 라벨 변형 | 형식은 정확히 `YY-M-W`, 월 1~12, 주 1~5. `2026-1-1`, `26.1.1`, 잘못된 주는 invalid. 60개 Projection/Actual raw 배열도 동일해야 한다. | 정상 거부. 다만 중복된 유효 라벨이 양쪽에 똑같이 있으면 별도 uniqueness 검사가 없어 통과할 수 있음. | `cashflow-sheet-template.mjs:3,97-111,124-142,299-305`; 재현 `2026-1-1` 거부. 중복 검사는 코드 부재에 따른 **확인**. |
| Total 열 위치 변동 | header와 값 모두 BS(index 70)만 인정. 다른 열로 이동하면 `cashflow_annual_header_invalid`; Projection/Actual 연도 배열도 달라지면 mismatch. | 정상 거부(이동 감지), 자동 복구 없음. | `cashflow-sheet-template.mjs:9,148-171,252-272`; 재현 BS→BT 이동 거부. |
| 빈 행 삽입 | 이후 모든 고정 rowIndex가 밀린다. 첫 고정 라벨부터 `cashflow_line_invalid`/`cashflow_derived_row_invalid`가 누적되어 refresh 실패. | 정상 거부, 원인은 “삽입 행”이 아니라 여러 공식 좌표 불일치로 보고되어 설명성은 낮음. | 고정 layouts `cashflow-sheet-template.mjs:10-33`; label gate `:173-213`; 재현 row 38 삽입 거부. |
| 같은 폭의 값 우측/좌측 교환 | 라벨/헤더를 건드리지 않으면 구조 검증은 통과. 모든 값이 정수면 상태·개수 검증도 통과하며, 합계 수식도 함께 이동/수정되면 arithmetic check까지 통과 가능. | **최악: 무음 통과/오판**. | mapping이 좌표만 신뢰 `cashflow-sheet-template.mjs:215-272`; stage validator는 key/state/count만 검사 `cashflow-sheet-lab.mjs:1490-1533`. |

## 4. 무음 통과 우선순위

1. **P0 — 한 행의 셀 삭제/삽입으로 인한 수평 시프트:** template와 refresh가 모두 성공하고 잘못된 line 금액이 canonical 후보가 될 수 있다.
2. **P0 — 짧은 line 행:** 누락 셀이 EMPTY라는 합법 상태가 되어 “값 삭제”로 반영될 수 있다.
3. **P0 — 값 교환/같은 폭 이동:** 구조·상태·개수 검증으로는 검출 불가하다.
4. **P1 — 병합된 금액 셀:** 좌상단 외 빈칸이 EMPTY로 합법화될 수 있다. 실제 API 반환 fixture가 필요하다.
5. **P1 — 공급가액/공급대가 의미 불일치:** 위치와 산술 총합만 맞으면 업무 의미 오류를 검출하지 못한다.
6. **P1 — 중복 주차 헤더:** 양 블록에 같은 중복이 있으면 60개/동일 배열 조건을 만족한다. stage에서 동일 key 중복으로 결국 막힐 가능성이 높지만 refresh는 FRESH가 될 수 있다.

## 5. 실행 검증

별도 파일을 만들지 않고 `node --input-type=module`로 production ESM의 순수 함수를 직접 호출했다. 공식 60×72 matrix는 기존 test fixture 구조를 그대로 구성했다.

```text
short_row             supported=true  reasons=[]
row_left_shift        supported=true  reasons=[]
label_typo            supported=false reasons=[cashflow_line_invalid]
derived_label_typo    supported=false reasons=[cashflow_derived_row_invalid]
week_label(2026-1-1)  supported=false reasons=[cashflow_week_header_invalid,cashflow_week_headers_mismatch]
total_moved(BS→BT)    supported=false reasons=[cashflow_annual_header_invalid,cashflow_annual_headers_mismatch]
blank_row_insert      supported=false reasons=[cashflow_line_invalid,cashflow_derived_row_invalid]
supply_label_changed  supported=false reasons=[cashflow_line_invalid]

#REF! -> INVALID     #N/A -> INVALID
₩196,000,000 -> VALUE(196000000)
￦ 1,000 원 -> VALUE(1000)
1.5 -> VALUE(1.5), 이후 whole-won 검증에서 거부
— -> EMPTY           (1,000) -> VALUE(-1000)    1,000- -> VALUE(-1000)

shifted_actual_balance:
  template supported=true
  snapshot status=FRESH
  sheetFacts.issues=[control_total_missing,...]
  actual balance control sourceCell=BS56, value=null, matches=null

ref_value(line cell):
  snapshot status=FRESH, summary.invalidCount=1,
  sheetFacts.issues includes sheet_value_invalid
```

`fixture-shifted-row.tsv`도 동일 형태를 보여준다. 매출/입금합계 행은 Total까지 71개 field가 있으나 잔액 행은 한 field가 적어 마지막 주차/Total 경계가 좌측으로 당겨진다. 현재 production 함수는 TSV 한 행만으로 section 전체를 만들 수 없으므로 공식 matrix의 ACTUAL 잔액 행에 같은 `splice(1,1)` 변형을 적용해 재현했다. 이는 **fixture 현상의 축소 재현**이지 실제 Google 응답 원본의 end-to-end 재생은 아니다.

## 확인과 남은 추측

- **확인:** 행 길이/수평 정렬 검증은 없다. snapshot issues는 refresh FRESH/COMPLETED를 막지 않는다. stage는 INVALID weekly cells와 구조 불완전은 막지만 EMPTY는 정상 값 상태로 허용한다.
- **확인:** `control_total_missing`은 sheet-lab stage의 직접 blocker가 아니다. 월마감/검증 BFF의 `sheetControlBlockers`에서는 blocker다.
- **추정:** 리더십살롱의 “반영 차단”이 sheet-lab apply였는지 월마감 preflight였는지는 운영 로그 없이 확정할 수 없다. 코드상 `control_total_missing`만으로 sheet-lab stage가 차단되지는 않는다.
- **미확인:** Google Sheets API가 병합 영역을 실제 matrix에 어떤 폭/빈칸 배열로 반환했는지, 셀 수식 원문과 표시값 중 무엇을 `loadSheetPreview`가 전달했는지는 실제 응답 fixture가 필요하다.

