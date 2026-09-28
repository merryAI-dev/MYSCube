# S17 — 오프라인 입금 조회 구현과 검증

2026-09-23. 운영 배포·Google Sheets API 호출·실제 모델 평가는 하지 않았다. 기존 운영 데이터와 주정산/월결산/JVM 코드는 변경하지 않았다. 이번 구현은 **복사된 시트 행렬 → 독립 분석 사본 → 실제 집계 → 저장 가능한 HTML**까지다.

## 실제 연결한 경로

`로컬 A1:BT60 표시 값 → 권한이 확인된 offline importer → 고정 양식·셀 parser → cashflow_inflow@1 사본 → typed plan → SQL compiler → 별도 프로세스의 DuckDB → Firestore evidence → HTML binding → 저장·재열기`

- `cashflow-inflow-copy.mjs`: 기존 고정 좌표 template/snapshot parser를 재사용한다. 대상 사업×요청 정산주×실적/예정×입금 범위로 사본을 만든다. 읽지 못한 사업도 행으로 남긴다. 원본 셀·원문·상태·수집시각·버전을 보존한다.
- `cashflow-inflow-definition.mjs`: 전체 입금, 매출 입금, 매출·매출부가세 입금을 구분한다. 원화만 지원하며 달력주·고객별 수금·전사 외부 순유입으로 확장 해석하지 않는다. 중복 원본/사업, 좌표 연도, 잘못된 셀 상태·금액·기간, 동일 셀의 범위별 불일치를 검사한다.
- `semantic-query.mjs`: mode·receipt_scope·currency 각각의 단일 조건을 요구한다. 전체 합계는 누락이 하나라도 있으면 null이다. 부분합과 별개이며 금액 조회에 대상 사업·주차·셀 수와 미확인 수를 자동 동반한다. 누락된 행을 숨기는 금액/상태 필터는 허용하지 않는다.
- `timeCoverage`: 복사된 월·주차를 기록한다. 한 주만 복사한 자료로 다른 주 또는 월 전체 금액을 계산하려 하면 실행 전에 거부한다.
- `analytics-service.mjs`: 사본 import/read 시 의미·원본 셀 정합성을 재검사한다. evidence에 정의 버전·사본 버전·SQL·실제 결과·날짜 범위·입금 기준·자료 한계를 저장한다.
- `conversation-agent.mjs`: 기존 대화 기준을 이어 사용하는 정책에 입금 범위와 정산주를 추가했다. 서울 날짜 기준 이번/이전 정산주를 서버가 제공한다. 설명한 기간/기준이 실제 계획과 다르면 실행하지 않는다. 조건이 부족하면 구체적인 확인 질문으로 돌아간다.
- `html-bindings.mjs`: 입금 evidence는 누락/범위를 볼 수 있는 표가 함께 있어야 한다. 부분합 숫자만 단독 카드로 연결하려는 제안은 거부한다. 이전 저장 HTML의 기본 스타일/직렬화 방식은 변경하지 않았다.
- `BoundEvidence.tsx`와 `html-routes.mjs`: 생성 HTML은 CSS로 표를 숨길 수 있으므로, **iframe 밖 앱 고정 영역**에서도 현재 권한으로 서버 evidence를 다시 읽는다. 집계/개별 금액 조회 모두 확인 범위 항목을 동반한다. 합계 미확인과 부분합·누락을 독립적으로 표시하며, 재조회 실패 시 이 고정 영역의 이전 금액을 제거한다. 직접 편집으로 연결이 해제된 HTML은 미검증 안내를 표시한다. 이미 열린 iframe의 과거 정보까지 소급 삭제하는 기능을 뜻하지 않는다.

원 단위 개별 셀은 기존 숫자 parser가 안전하게 읽은 정수만 인정한다. 안전 정수 범위를 넘거나 소수 원이 있는 셀은 INVALID이며, 확인된 셀의 합계는 BigInt/DECIMAL로 계산해 합계가 2^53을 넘어도 보존한다. 각 셀 자체의 임의 정밀도 숫자까지 새 parser로 확대하는 것은 이번 범위가 아니다.

## 오프라인 importer

기존 importer에 `--format sheets-inflow`를 추가했다. 기본 `dataset` 경로는 유지한다. 입력은 `buildCashflowInflowDataset`의 인자와 같은 JSON이다.

```text
node server/workbench/analytics-import.mjs \
  --file <승인된-로컬-시트-사본.json> \
  --tenant <tenant> --actor <admin> --format sheets-inflow
```

`WORKBENCH_IMPORT_ENABLED=true`, 독립 Workbench 프로젝트 설정, 현재 관리자 권한이 모두 필요하다. 원본을 읽은 시각과 사본 취합 시각을 구분해 입력한다. 이 명령은 Sheets API 수집 명령이 아니다. 실제 환경에서 실행하거나 importer를 활성화하지 않았다.

## 검증 결과

- 어댑터 단위 검증 **12/12 PASS**: 실제 fixed parser, 양식/연도/중복/통화/시각, 0원·누락·음수·분수·안전 정수, raw 변경에 따른 버전 변경.
- 독립 QA **11/11 PASS**: 고정 셀→compiler→실제 DuckDB. 실패 사업 분모, 실적/예정 및 입금 범위 분리, 부분합, 2^53 초과 합계, raw/금액 변조, 동일 원본 셀 불일치, 복사되지 않은 기간 거부.
- Firestore 통합 **6/6 PASS**: 권한 있는 offline importer, 영구 evidence, 새 사본 후 이전 버전 조회, 대화 경로, 기간 불일치 차단, 표 없는 단독 금액 연결 거부, 앱 근거 조회의 권한 회수/타인 접근 차단.
- 전체 Workbench **22개 파일 244/244 PASS**. 위 29개 신규 검증을 포함한다. 기록: `/tmp/myscube-s17-complete-tests.log`.
- 전체 브라우저 회귀 **9/9 PASS**, 신규 흐름 **2개** 포함: 실제 HTTP→Firestore→DuckDB→미리보기→저장→새로고침. 합성 자료의 전체 합계 미확인/부분합110/대상2/금액 미확인 사업1 유지. 모바일 표 가로스크롤·문서 overflow 0·pageerror 0 확인. HTML이 표를 숨겨도 앱의 근거 영역이 보이며 권한 회수 후 근거 재조회가 거부되고 고정 영역의 이전 금액이 제거됨을 검증했다. 모델 응답은 fixture다.
- standalone TypeScript 검사·production build PASS. JS 532.97kB(압축 142.45kB), 500kB chunk 경고는 남아 있다. 렌더링 성능 목표 달성을 의미하지 않는다. 기록: `/tmp/myscube-s17-complete-build.log`.

독립 QA가 최초 실행에서 발견한 `timeCoverage` 연결 누락은 어댑터 manifest에 실제 필드를 추가해 수정했다. 금액 조회의 기간 범위가 맞는지 검증하며 테스트만 우회하지 않았다. 브라우저에서 발견한 모바일 표 줄바꿈은 생성 예시의 min-width/nowrap/가로스크롤로 보완하고 다시 캡처했다. 같은 원칙을 모델 프롬프트에도 넣었지만 실제 모델의 생성 품질을 검증한 것은 아니다.

추가 QA에서 표의 존재만 검사하면 `class="hidden"`으로 근거를 가릴 수 있는 문제가 재현됐다. CSS 금지 목록을 늘리는 대신 앱 소유의 고정 근거 영역으로 보완했고, 숨긴 표와 별도로 고정 영역이 유지되는 것을 검증했다.

캡처: `/tmp/myscube-s17-inflow-desktop.png`, `/tmp/myscube-s17-inflow-mobile.png`, `/tmp/myscube-s17-host-evidence.png`. 직접 육안 확인했다. 자료 설명은 길게 표시되며 향후 실제 모델 평가에서 가독성도 함께 확인해야 한다.

## 남은 게이트

1. 승인된 대상 목록·읽기 전용 자격증명·quota·수집 빈도 및 별도 인프라 검증 후 실제 Sheets 연결. 현재 importer의 hash 검증은 로컬 사본 정합성이지 Google 원본 진위 또는 전사 대상 누락 없음의 증명이 아니다.
2. 실제 원본 셀과 사본/API/관리자 화면을 대조하고 부분 수집 실패·권한 회수·429·동시 변경을 시험한다.
3. 실제 모델로 명확화, 후속 질문, 지표/기간/대상 정확도, 불필요한 질문, 응답 시간·비용을 측정한다. fixture planner 테스트를 모델 정확도로 보고하지 않는다.
4. 조직별 분석에는 검증된 조직 관계가 필요하다. 달력주 수금에는 거래 날짜가 있는 자료가 필요하다. 현재 기능이 해당 자료를 추론해서 만들지는 않는다.
5. 기존 서비스와 공유하는 실행/권한/quota가 없는지 운영 환경에서 확인 후 활성화한다. 이번에는 배포하지 않았다.
