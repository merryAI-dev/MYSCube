# S14 지속 대화 업무 에이전트 — 독립 QA 계약

> 최신 검증: 2026-09-23 S16 보완 결과는 문서 끝의 기록을 따른다. 아래 초기 조사/미완료 기록은 당시 시점의 결과다.

2026-09-22 작성. 운영 배포 승인이나 구현 완료 판정이 아니다.

## 목표 재설정

사용자는 일회성 HTML 생성기가 아니라, 지속 대화로 오류 원인을 확인하고 사용법을 묻고 특정 기간의 업무 상태를 조회한 다음 화면을 바꿔 저장하는 도구를 요청했다. HTML Studio만 완성해 이 목표를 완료했다고 보고하면 실패다.

필수 사용자 흐름은 다음과 같다.

1. “왜 제출이 실패했어?” → 권한 범위의 실제 기록·해당 버전 코드로 근거와 미확인을 구분한다.
2. “그럼 어떻게 해야 해?” → 앞선 오류와 현재 검토된 정책에 맞는 사용법을 설명한다.
3. “9월 캐시플로우 주정산 안 한 곳은?” → 연도·대상 주차·마감 기준을 확정하고 실제 제출 상태를 조회한다.
4. “CIC별로 보이게 바꿔줘.” → 동일 조회 맥락과 근거를 유지한 화면 제안을 만든다.
5. “저장해.” → 사용자가 검토한 특정 제안·원문·근거 버전만 저장하고 이력을 남긴다.
6. 새로고침·재접속 후 대화를 이어가되 최신 권한과 근거를 다시 확인한다.

## 금지되는 의미 변환

- snapshot 없음, 금액 0원, 데이터 조회 실패, 늦은 복제, 제출 안 함은 서로 다른 상태다.
- `accounting-read`의 금액 availability는 제출 상태의 근거가 아니다.
- 주정산 미제출 판정에는 실제 제출 상태를 나타내는 승인된 데이터 계약이 필요하다. 대상 사업 목록의 완전성, 주차/마감 시각, 상태 기준 시각, 원본 revision 및 복제 시각이 없으면 “확인 불가”로 남긴다.
- 9월만 지정된 경우 임의 연도를 고정하지 않는다. 기존 명시된 연도를 쓰거나 사용자에게 필요한 맥락을 묻는다.
- CIC 집계에서 권한 밖 사업, 누락 사업, 조회 실패 사업을 0 또는 완료로 처리하지 않는다. 표본·페이지·권한 범위와 제외 건수를 표시한다.
- 로그와 코드의 일치 후보를 확정 원인이라고 쓰지 않는다. 추천 행동과 실제 수행 결과도 분리한다.

## 실제 데이터 경로

대화 UI → 독립 인증 API → 독립 DB의 소유자별 conversation/turn → 매 turn 권한 재검증 → 허용된 읽기 도구 → 독립 복제 데이터와 provenance → 도구 결과·근거 참조 → 답변/화면 제안 → 사용자의 특정 제안 저장 → HTML 불변 revision.

운영 BFF/JVM/DB에 동기 조회하거나 쓰는 fallback은 허용하지 않는다. 필요한 제출 상태가 독립 데이터셋에 없으면 자료 연결 필요로 응답한다. 기존 주정산·월결산 파이프라인은 바꾸지 않는다.

## 단계별 통과 조건

### 1. 의도·계약

- 대화 turn, 프로젝트/기간/CIC 맥락, 도구 호출, 근거 조회 시각, 제안과 저장 revision의 관계를 정의한다.
- 어떤 요청은 읽기이고 어떤 요청은 개인 화면 저장인지 UI와 API에서 구분한다.
- 실제 제출 상태 데이터의 경로와 의미를 독립 확인하기 전 “미제출 목록” 기능을 완료로 표시하지 않는다.

### 2. 구현

- conversation과 turn은 owner·tenant 범위에 묶는다. 세션 ID를 알거나 모델이 만든 프로젝트 ID만으로 권한을 얻지 못한다.
- 모델/도구 호출 전마다 현재 권한을 재검증하고, 도구 결과 반환 전 변경 여부도 확인한다. 오래된 권한 복제는 새 기능만 차단한다.
- 대화 맥락은 편의용이다. 예전 권한·상태를 증거로 재사용하지 않는다. 각 turn은 현재 evidence version과 scope를 명시한다.
- 질문 재전송·동시 turn·타임아웃·재접속에서 메시지나 모델 비용이 중복되지 않도록 요청 키와 상태 전이를 저장한다. 순서 충돌은 명확히 안내한다.
- 답변 스트리밍 중 실패하면 부분 답변을 완료로 표시하지 않는다. 실패/취소/확인 불가 상태를 보존한다.
- 생성된 원문과 도구 출력·사용자 요청은 신뢰하지 않는다. 모델이 도구 allowlist, URL, 소유자, 권한, 비용 제한을 바꿀 수 없다.
- 화면 제안은 제안 ID와 소스 hash로 고정한다. 대화 중 새 제안이 생겨도 “저장”이 다른 제안을 묵시적으로 저장하지 않는다.
- 저장한 대화에서 원문 로그·개인정보를 불필요하게 복제하지 않는다. 토큰·키·Authorization·원본 자격증명은 영구 저장/모델 전달 금지다. 필요한 개인정보와 보존·삭제 정책은 승인된 범위로 명시한다.

### 3. 실제 동작 검증

- 독립 API+서로 다른 projectId의 Firestore 클라이언트로 위 6단계 흐름을 수행한다. 같은 singleton 클라이언트를 다른 DB로 착각하지 않는다.
- 실제 모델 미연결 시 fixture completion임을 명시한다. fixture 성공은 실제 자연어 모델·전용 quota 연결 검증으로 계산하지 않는다.
- “9월”→“CIC별”→“이건 표로”에서 명시한 기간/범위가 유지되는지, 새 turn마다 근거가 재조회되는지 확인한다.
- 질문 사이에 제출 상태가 바뀌면 새 기준 시각과 바뀐 근거를 반영한다.
- 실패 프로젝트나 snapshot 부재를 포함한 fixture에서 미제출 오판이 없어야 한다. 실제 미제출 상태 fixture는 별도로 둔다.
- 생성 제안 적용·저장 후 새로고침으로 원문/manifest/revision 연결을 확인한다. 이전 버전 복원은 과거 업무 상태를 현재 사실로 바꾸지 않는다.
- 운영 업무 DB 원본이 불변이고 외부 운영 BFF/JVM 호출이 0인지 확인한다.

### 4. 회귀·정보 경계

- 다른 사용자/조직의 대화 목록·내용·첨부 근거·제안·복원 요청 거부.
- 대화 중 admin→pm 변경, 프로젝트 권한 회수, 권한 복제 만료 시 다음 도구 및 응답 차단.
- A→B 계정 변경 중 늦은 응답이 B 화면에 나타나지 않음.
- 모델 장애, 공급자 timeout, 토큰 한도, 복제 지연, DB 실패를 기존 업무 상태와 구별함.
- 기존 화면·API·주정산·월결산 경로에 신규 수집/컴파일/모델 의존성이 없음.
- 모바일에서 긴 대화·근거 펼침·소스 변경·저장 대상 확인을 사용할 수 있음.

## 개인정보와 보존 QA

대화는 질문만으로도 조직·프로젝트·개인 이름을 포함할 수 있다. 따라서 “메타데이터만 저장”이라는 설명은 부정확하다. 저장 필드 목록, 모델 전달 필드, 운영 로그 필드를 각각 문서화한다. 본문 보존기간·삭제 방식이 아직 결정되지 않았다면 무기한 보존으로 조용히 출시하지 않는다. 현재 구현 승인 범위를 넘는 외부 모델 전송/새 비밀값/유료 자원은 별도 승인 대상이다.

## 현재 판정

초기에는 의도 계약만 정의했다. 이후 대화 저장 기반과 선택적 판단/실행 경계의 에뮬레이터 검증까지 진행했다. 범용 질의·실제 주정산 제출 상태 데이터셋·대화에서 조회와 화면 저장까지 이어지는 전체 흐름은 미완료다. 독립 인프라·전용 모델 키/쿼터·운영 데이터 갱신도 연결되지 않았다. 기존 HTML Studio와 정적 preview 테스트 통과를 S14 전체 통과로 재사용하지 않는다. 최신 범위는 [공통 조회 연구와 코드 반영 기록](s14-generic-query-research.md)을 따른다.

## 공식 OSS 대조와 실행기 선택 (2026-09-22 독립 연구)

GitHub API 조회 당시 DuckDB 41,632 stars/C++, Google MCP Toolbox 16,476 stars/Go, firebase/extensions 전체 저장소 979 stars/TypeScript였다. stars는 채택 신호일 뿐 안전성 보증이 아니며 Firebase 수치는 개별 export extension의 수치가 아니다.

### DuckDB: 집계 엔진을 새로 만들 필요가 없다

SQL 계산·그룹·조인·정렬은 성숙한 DuckDB에 맡기고, 우리 코드는 승인된 dataset/metric/scope/evidence 계약에 집중하는 편이 적절하다. Node에서는 공식 `@duckdb/node-api`를 사용할 수 있다. 다만 SQL은 파일·네트워크·확장 기능에 접근할 수 있는 실행 코드이므로 읽기 전용 DB만으로 격리가 완성되지 않는다. 별도 최소권한 프로세스/컨테이너, 외부 통신 차단, timeout, extension/external access 제한이 필요하다. DuckDB `memory_limit`도 전체 프로세스의 절대 메모리 상한이 아니므로 OS 자원 제한을 대체하지 않는다.

- [보안 모델](https://duckdb.org/docs/current/operations_manual/securing_duckdb/overview)
- [Node API](https://duckdb.org/docs/lts/clients/node_neo/overview)
- [자원 제한](https://duckdb.org/docs/current/operations_manual/limits)
- [확인한 설정 구현](https://github.com/duckdb/duckdb/blob/6889e6a57017bddb7633b8b5c5a85e683ba972d6/src/main/settings/custom_settings.cpp)

### Firestore→BigQuery: 질문별이 아니라 데이터셋별 적재

공식 extension은 collection의 변경 이력과 최신 상태 view를 제공한다. subcollection은 자동으로 따라오지 않고, 기존 문서는 별도 import가 필요하다. 따라서 설치 자체가 전수 복제 완료를 의미하지 않는다. 소스는 Cloud Functions/Eventarc/Cloud Tasks와 IAM 권한을 추가하므로 운영에 아무 영향 없는 설치도 아니다.

더욱이 Firebase Extensions 관리 서비스는 2027-03-31 종료 예정이다. 기존 함수는 계속 실행되지만 관리 기능 종료가 공지되어 있어, 새 장기 설계를 extension 설치에 고정하지 않는다. 공식 코드는 복제 패턴/마이그레이션 참고로 사용한다.

- [extension 작동·초기 import·subcollection 설명](https://extensions.dev/extensions/firebase/firestore-bigquery-export)
- [실제 자원·권한 정의](https://github.com/firebase/extensions/blob/3c54a5a84f8731350da225bf172b58b56c252456/firestore-bigquery-export/extension.yaml)
- [이벤트 처리 구현](https://github.com/firebase/extensions/blob/3c54a5a84f8731350da225bf172b58b56c252456/firestore-bigquery-export/functions/src/index.ts)
- [공식 종료 안내](https://firebase.google.com/docs/extensions/faq-and-troubleshooting)

### MCP Toolbox: 연결·인증·쿼리 실행 재사용

Go로 구현된 Toolbox는 공통 DB 도구와 커스텀 도구를 모두 제공한다. BigQuery `execute_sql` 구현은 dry run, 쓰기 차단 모드, 허용 dataset 검사, billed-bytes 제한 전달을 포함한다. 인증 파라미터를 token claim에서 얻는 패턴도 제공한다. 이것은 자체 MCP 연결·SQL 실행 계층을 재작성할 필요를 줄이지만, MYSCube의 사업 권한·metric 의미·복제 완전성·evidence와 화면 연결을 자동으로 해결하지는 않는다. 질문마다 고정 SQL 도구를 하나씩 만들면 현재 확장 문제는 남는다.

- [공식 README와 새 저장소명](https://github.com/googleapis/mcp-toolbox/blob/5700630c132d5e2fc2d38cf3e9ce1f9898bd757d/README.md)
- [generic SQL 구현](https://github.com/googleapis/mcp-toolbox/blob/5700630c132d5e2fc2d38cf3e9ce1f9898bd757d/internal/tools/bigquery/bigqueryexecutesql/bigqueryexecutesql.go)
- [parameterized SQL 구현](https://github.com/googleapis/mcp-toolbox/blob/5700630c132d5e2fc2d38cf3e9ce1f9898bd757d/internal/tools/bigquery/bigquerysql/bigquerysql.go)
- [인증 파라미터 공식 예제](https://github.com/googleapis/mcp-toolbox/blob/5700630c132d5e2fc2d38cf3e9ce1f9898bd757d/docs/en/documentation/configuration/authentication/generic.md)

### 최소 단계 권고 — 연구를 바탕으로 한 판단

1. 이미 승인된 사본을 일관된 version/manifest로 고정하고 JSON/Parquet 또는 독립 DB snapshot으로 준비한다. 같은 시각처럼 보이는 여러 문서를 읽었다는 이유로 일관성을 단정하지 않는다.
2. 작은 규모에서는 전용 worker의 DuckDB와 검토된 semantic SQL views로 시작한다. 자체 필터/조인/집계 언어 실행기를 만들지 않는다. typed 입력은 권한·지원 metric·결과 형식의 얇은 경계로 한정한다.
3. 규모·갱신 빈도·동시성상 BigQuery가 필요할 때 독립 dataset/query project와 Toolbox를 검토한다. DuckDB와 BigQuery를 첫 단계부터 둘 다 도입할 필요는 없다.
4. 임의 SQL은 독립 sandbox와 승인된 views에서만 검토한다. SELECT 제한이나 parameterization만으로 모든 보안·의미 문제가 해결된다고 보지 않는다.
5. 어떤 엔진이든 query 결과를 evidence ID로 고정하고 대화 답변과 HTML data binding에 같은 결과를 사용한다. LLM이 금액을 HTML에 재기입하게 하지 않는다.

관리형 Firestore export도 문서별 read 비용이 발생한다. 기존 export 재사용은 연결 영향을 줄일 수 있지만 새로운 정기 export는 별도 비용·수집 권한 승인 대상이다. “완전 격리”는 분석 질의와 장애가 운영 요청으로 전파되지 않는다는 뜻으로 검증해야 하며, 원천에서 사본을 만드는 비용까지 0이라고 약속하면 안 된다. [공식 export 안내](https://docs.cloud.google.com/firestore/native/docs/manage-data/export-import)

이 연구에서 새 인프라 설치·배포·원천 데이터 export·모델 호출은 하지 않았다.

## 최신 실행 범위: Jev 제외, 복제 데이터 범용 분석과 모호한 질문 처리

최신 사용자 지시에 따라 Jev는 이 실행 경로에서 제외한다. 앞선 선택적 판단 prototype의 통과 여부는 아래 제품 게이트와 무관하다. QA skill의 지정 경로는 현재 환경에서 존재하지 않음을 재확인했으며 저장소의 네 단계 QA 계약을 적용한다.

### 구현 전에 확정하는 PASS 경로

실제 UI → 소유자별 conversation CAS/turn 저장 → 현재 권한으로 제한한 복제 dataset의 SQL → 버전·범위·완전성 근거 → 같은 evidence의 답변/HTML binding → 화면 저장·재접속을 이어 검증한다. SQL 실행·답변·HTML이 각각 따로 성공해도 같은 근거를 공유하지 않으면 통과하지 않는다.

모델 미연결 제품은 모델이 실제 동작한 것으로 표시하지 않는다. clarification/generation용 injected fixture 시험은 실제 API·DB 경로 증거일 수 있지만 실제 공급자 품질 증거가 아니다. 운영 BFF/JVM fallback과 주정산·월결산 쓰기는 금지한다.

### 모호함과 후속 질문의 판정 사례

| 입력과 맥락 | 기대 동작 |
| --- | --- |
| `2026년 9월 CIC4` 다음 `CIC2는?` | 명시 기간을 유지하고 CIC만 변경하여 새 근거 조회 |
| 맥락 없는 `9월`, 자료에 여러 연도 존재 | 연도를 구체적으로 질문; SQL 업무조회 0; 이전 preview 유지 |
| `이번 달`, 한국 시간 월 경계 | 서버가 제공하는 Asia/Seoul 기준으로 기간 확정하고 기준 표시 |
| `주정산 미제출` | 실제 제출 상태 계약 사용; 승인 대기는 미제출로 합치지 않음 |
| snapshot 없음·지연·자료 모집단 불완전 | 미제출/0원 대신 확인 불가·부분 조회 |
| 두 근거/화면이 있는 상태에서 `그거 바꿔줘` | 어느 대상을 뜻하는지 질문; 임의 저장/교체 0 |
| clarification 답변 후 후속 요청 | 원질문과 확인 답변 연결, 새로운 명시 지시 우선 |
| 실패·취소·clarification | 기존 typed context와 preview를 유지하고 해당 turn 상태 명시 |

불확실성은 결과를 바꾸는 미확정 필드와 의미를 기준으로 판단한다. 근거 없는 모델 confidence 숫자나 임의 임계값을 추가하지 않는다. 모든 질문을 되묻는 것도 실패이며 충분한 typed context가 있는 후속 지시는 재사용해야 한다.

### 분석 실행과 정보 경계

- tenant·프로젝트 범위·dataset 버전은 서버가 강제한다. 모델의 입력은 권한 부여가 아니다.
- 승인된 테이블·열·metric/집계·join만 사용하고 값은 parameterize한다. 파일/URL 조회, 확장 설치, ATTACH/COPY, DDL, 다중 문장, 무제한 조인은 허용하지 않는다.
- 별도 SQL 프로세스에서 native memory·CPU·전체 deadline·행수·결과 bytes 제한을 검사한다. worker thread의 JS heap 제한만으로 native engine 메모리 격리를 증명하지 않는다.
- evidence는 datasetVersion·semanticVersion·queryHash·scopeFingerprint·sourceAsOf·coverage를 포함한다. 권한 변경 후 기존 evidence와 HTML을 재사용하여 정보를 우회 노출하지 않는다.
- 답변과 HTML의 수치는 같은 evidence binding에서 공급한다. LLM이 생성한 임의 숫자를 확인된 집계값처럼 표시하지 않는다.
- 중복 turn 요청은 SQL·모델·저장 중복을 만들지 않는다. CAS 충돌, 처리 중, 만료, 부분 실패를 각각 검증한다.

### 독립 검증 산출물

권한/미제출 의미/기간/사본 누락/SQL 탈출/과도한 질의/중복 turn 통합 테스트와, 대화→clarification→후속조회→HTML→저장→새로고침 브라우저 증거를 남긴다. 실제 모델 없는 시험임을 결과에 표시하고 운영 DB 원본 불변과 운영 엔드포인트 요청 0을 별도로 확인한다.

현재 상태: gate 정의 완료, 새 generic analytics/대화 연결 구현과 실제 동작 증거는 대기 중이다.

### 독립 agent 계약 시험 1차

`server/workbench/conversation-agent.qa.test.mjs` 14개 중 13개 통과, 1개 실패. 로그 `/tmp/myscube-conversation-agent-qa.log`.

- 통과: query/investigate/answer/render 모두 ambiguity가 있으면 clarification으로 종료, 업무 도구 실행 0, 이전 context 유지. 기간·CIC 후속 맥락과 한국 날짜 경계, 잘못된 날짜, 허용 밖 dataset/evidence, 모델 호출 중 권한 회수, 임의 confidence 필드 거부.
- 실패: provider가 AbortSignal을 무시하면 caller abort 이후에도 turn이 끝나지 않는다. operation 전체를 감싸는 abort race가 필요하다.
- 시험은 synthetic completion이며 실제 모델의 모호함 탐지 정확도를 증명하지 않는다. context에 적힌 기간/CIC와 SQL에 적용된 필터의 일치도 별도 검증이 필요하다.
- investigate에서 생성한 QA evidence가 다음 turn의 공통 evidence 조회에서 읽히도록 영속 저장·lineage 연결을 확인해야 한다.

### 독립 agent·HTML binding 재검증

취소 신호를 무시하는 provider를 감싼 deadline 수정 후 agent 14/14와 신규 `html-data.qa.test.mjs` 8/8, 합계 22/22 통과했다. 로그 `/tmp/myscube-conversation-binding-qa.log`. HTML 시험은 이전 권한 fingerprint, evidence owner 거부, 조회 도중 권한 회수, 원문 제목·금액 변조, 변경된 근거 반환, 확인되지 않은 evidence ID를 거부하고 0원·부분 자료 표시를 유지한다.

별도 차단 리뷰: scope A→B 변경 후 첫 B turn의 history를 비우더라도, 그 다음 B turn에서 최신 workContext만 비교하면 오래된 A turn 답변이 history에 다시 포함될 수 있다. history는 turn별 scopeFingerprint로 걸러야 한다. fingerprint가 없는 옛 결과도 검증 불가능하므로 그대로 공개하지 않는 정책이 필요하다. 단위 22개 통과는 이 라우트 경계까지 통과했다는 뜻이 아니다.

### 독립 재검증: 권한 범위 A → B → B (2026-09-22)

`conversation-scope.qa.integration.test.ts`를 실제 Firestore emulator에서 단독 실행하여 1/1 통과했다. A 범위의 비공개 질문/답변을 보존한 상태에서 B 결과를 완료하고, session.workContext도 B로 저장된 다음 세 번째 B 요청을 시작했다. 새 서비스 인스턴스의 history에는 B turn만 포함되며 A 질문/답변은 재등장하지 않는다. 이는 서버가 전달한 scopeFingerprint별 history 필터의 영속 읽기 검증이며, 운영 IAM/복제 권한의 즉시 갱신이나 실제 모델 품질 검증은 아니다.

### 남은 배포 격리 경계: root native dependency

독립 runtime import 경계와 dependency 설치 경계는 다르다. 현재 root package.json의 production dependencies에 `@duckdb/node-api`가 있으며 운영 `production-deploy.yml:161`은 root `npm ci --ignore-scripts`를 실행한다. 따라서 업무 BFF에서 import하지 않더라도 배포 설치 의존성·lockfile 영향은 공유한다. 로컬 Darwin arm64 바인딩 설치본은 113MB였지만 Linux 크기 및 Vercel 최종 함수 포함 여부는 미검증이므로 이 값을 운영 함수 크기 증가로 해석하지 않는다. 전용 package/lock/install/build 분리와 실제 함수 trace에서 native dependency 부재를 확인하기 전에는 완전 배포 격리 PASS로 보고하지 않는다.

### SQL 의미 계층 도입 전 독립 gate

모델이 작성한 SQL 옆에 description을 붙이는 것은 의미 검증이 아니다. 서버가 등록한 definitionId/version에 따라 typed plan의 dataset·dimension·metric·filter·기간을 검증하고 SQL 및 evidence의 설명을 같은 정의에서 만들어야 한다. 모델 경로의 raw SQL은 거부하고, 정의되지 않은 join·metric·field·version 및 연산자는 실행 전에 거부해야 한다. 값은 안전한 파라미터 또는 검증된 인코딩으로 처리하며 SQL 문자열 조각을 모델에게 받지 않는다.

PASS의 관찰 대상은 실제 plan → 정의 검증 → DuckDB 실행 결과 → evidence(정의 버전·계산 범위·사본 revision·SQL 식별값) → 답변/HTML이다. 권한은 모델이 선택한 definition이나 prompt로 확장하지 않고 서버 catalog 범위와 교차 검증한다. 집계 단위, NULL/EMPTY/직접 입력한 0, 기간 및 분모 의미가 정의되어야 한다. 잘못된 정의 버전에서는 기존 버전으로 조용히 계산하지 않는다.

기존 `server/bff/settlement-agent-query.mjs`의 `selectSettlementIssue`는 cycle health 문제/INCONSISTENT/해당 주차 상태 또는 마감시각 누락을 UNKNOWN으로 처리한다. 마감 전 항목은 제외하고, 미완료 상태는 원래 상태로 보존한다. 보고서도 등록 사업 모집단이며 정산 의무 대상·종료 제외 정책이 적용된 미준수 명단이 아님을 명시한다. 따라서 `WAITING_FOR_UPDATE`를 자동으로 미준수라고 부르거나 `PENDING_APPROVAL`을 미제출로 집계하면 FAIL이다. 현 단계에서 안전한 정의는 업데이트 대기/승인 대기/완료 상태별 집계이며, 미제출·미준수는 의무대상과 마감 정책이 정의되기 전에는 별도 metric으로 등록하지 않는다.

예정 독립 회귀는 unknown metric, definition mismatch, filter injection, group-by grain, 승인 대기/업데이트 대기 분리, 0/누락 구분이다. 이는 아직 구현 테스트 완료 기록이 아니다.

## 2026-09-23 — S16 정의·계획·실제 결과 연결 검증

사용자의 벡터 언급은 개념 조합의 예시였으며 SQL+벡터 도입 승인이 아니었다. 설계 문서를 정정했고 임베딩 호출·vector DB·Jev를 추가하지 않았다. 앞선 독립 QA가 정한 의미/기간/권한/중복 gate를 기준으로 담당자가 마지막 구현과 검증을 진행했다. 마지막 코드에 별도 서브에이전트 재승인이 있었다고 보고하지 않는다.

### 실제로 연결한 경로

대화의 typed plan → 서버 registry 정의 ID/버전·열 타입·필터/지표·기간 검사 → SQL 생성 → 고정 사본의 native DuckDB 계산 → 불변 evidence 저장 → 서버 HTML binding → 명시적 소스 저장 → 재접속 후 화면·대화 다시 열기.

첫 정의는 `weekly_submission@1`이다. 사업×정산 월×주차의 현재 상태만 받는다. 동일 grain의 복수 revision은 최신값을 추정하지 않고 거부한다. 상태가 조회 정상으로 확인된 경우와 원문의 상태를 구분한다. 업데이트 대기는 승인 후 재개도 포함할 수 있으므로 미제출·미준수라는 지표를 등록하지 않았다. 고유 사업 수와 사업·주차 관측 건수의 집계는 별개다. 현재 JOIN은 허용하지 않는다.

### 증거

- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx vitest run server/workbench`: **19개 파일, 215개 테스트 PASS**. `/tmp/myscube-s16-verified-tests.log`.
- 실제 native 계산 QA 16개: 정의 버전·열·지표·상태 값·원시 SQL·임의 JOIN·기간 중복 거부, filter escaping, 여러 주차의 사업 중복 계산 방지, UNKNOWN/명시된 0 구분.
- 대화 QA 18개: 기존 맥락/권한 변경/기간/근거/중단 회귀, 모델 raw SQL 거부, plan과 설명의 dataset·월 불일치 거부, compiler 필수 조건 누락을 확인 질문으로 변환.
- `FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npx playwright test --config workbench/playwright.config.mjs`: **7개 PASS**. `/tmp/myscube-s16-verified-browser.log`.
- 그중 `conversation-data.e2e.spec.ts`는 대화 planner만 fixture이며 HTTP·Firestore·DuckDB·HTML binding·저장/재열기는 실제 로컬 코드 경로다. UI-only mock 검증과 구별한다. 운영 데이터·실 모델 응답 검증으로 보고하지 않는다.
- 스크린샷 `/tmp/myscube-real-conversation-desktop.png`, `/tmp/myscube-real-conversation-mobile.png`: 사본 기준시각·자료 한계·한국어 열 이름·0·자료 없음·저장 화면·대화 재열기를 확인했다. 모바일 페이지 가로 넘침 검사도 통과했다.
- 초기 브라우저 재실행에서 Vite 의존성 재최적화 중 서로 다른 React module URL이 로드되어 Invalid hook call이 발생했다. trace에서 확인하고 동기화 후 개발 서버를 다시 시작하여 전체 7개를 재검증했다. 운영 장애로 보고하지 않는다.
- 기본 예제를 불러오기만 했는데 미저장 변경으로 판단하던 문제를 수정했다. 실제 수정 시 이탈 확인은 유지한다.

### 배포·운영의 남은 gate

`@duckdb/node-api`는 root production dependency에서 제거하고 `server/workbench/package.json`/전용 lock/install로 이동했다. 운영 Vercel 업로드 제외도 설정했지만 실제 배포 함수 trace/IAM/모델 할당량/native RSS 격리를 검증한 것은 아니다. 과거 113MB 측정은 로컬 Darwin 바인딩 크기다.

운영 Firebase 자동 복제·권한 변경/삭제 반영·완전성 watermark, 다른 경영 지표/조직 관계, 실제 모델 한국어 질의 평가, 전용 실행 환경/비용 범위 확인이 남아 있다. 이번 테스트 통과를 이 항목들의 완료나 운영 배포 완료로 확대하지 않는다. 기존 업무 데이터와 주정산·월결산 파이프라인은 이번 의미 계층 구현에서 수정하지 않았다.

최종 회귀: 전체 `npm test` 451개 파일/4,709개 테스트 PASS(371개 skip, 별도 emulator 검증과 중복 합산하지 않음). 독립 Workbench TypeScript 검사와 production build PASS. 빌드 JS 525.40KB(gzip 140.17KB)이며 500KB chunk 경고가 남아 있다. 앞선 BFF integration 353+3개 PASS, 기존 업무 frontend production build PASS 결과는 이 문서 작성 직전 코드 범위의 별도 회귀 기록이며 실제 라이브 성능 측정은 아니다.
