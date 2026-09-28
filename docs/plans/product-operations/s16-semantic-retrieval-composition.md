# S16 — 업무 정의를 조합하는 분석 라우터

2026-09-23 정정. 사용자의 벡터 언급은 재사용 가능한 개념을 조합한다는 예시이며, 벡터 검색 도입 요청이 아니다. SQL과 벡터 검색을 함께 구축하는 방향을 전제로 하지 않는다. 기존 업무 서비스와 정산 파이프라인은 변경하지 않는다. Jev는 사용하지 않는다.

## 질문별 파이프라인을 만드는 대신

`질문 + 대화 맥락 → 권한 내 업무 정의 선택 → 필요한 정의와 관계 연결 → 조회 계획 검증 → 사본 계산 → 근거 → 답변·HTML`

업무 용어, 지표, 상태, 기간, 관계를 구조화해 등록하고 질문에 맞게 조합한다. 정의의 ID·버전·타입·적용 조건으로 실행 가능 여부를 확인한다. SQL은 검증된 계획으로 사본을 계산하는 수단이다. 별도 벡터 DB나 임베딩 호출은 이 구조에 필요하지 않다.

예를 들어 “9월 캐시플로우 주정산 안 한 곳은?”에서 다음 요소를 조합한다.

| 요소 | 찾거나 확인할 내용 | 임의로 채우면 안 되는 내용 |
| --- | --- | --- |
| 업무 | 주정산 상태 정의와 분석용 사본 | 금액이 비어 있다는 이유로 미제출 추정 |
| 기간 | 이전 대화의 확정 연도 + 9월, 전체 주차 또는 특정 주차 | 대화에 없는 연도나 임의 주차 |
| 상태 | 업데이트 대기, 승인 대기, 완료, 확인 안 됨의 차이 | 업데이트 대기를 모두 최초 미제출로 취급 |
| 대상 | 권한 내 사업과 등록된 조직 관계 | 사본에 없는 사업을 완료/0건 처리 |
| 집계 | 사업 수인지 사업×주차 수인지 | 주차 행 수를 고유 사업 수로 표시 |

현재 코드에는 승인 후 수정 재개로 `WAITING_FOR_UPDATE`가 되는 경로도 있다. 따라서 이 상태의 검색 별칭에 “미제출”을 무조건 등치시키지 않는다. 마감 이후 미이행을 묻는다면 마감·의무 대상·사본 완전성 정의가 추가로 필요하다. 해당 정의가 없으면 정확히 무엇을 확인할 수 있는지 안내한다.

## 실제 소스에서 확인한 분리

### LlamaIndex: 정의를 문서로 만들고 질문에 관련된 객체를 다시 찾는다

고정 SHA: `f12d46acab73f5b2243ef49c2f00101617b38ce4`.

- [SQLTableNodeMapping](https://github.com/run-llama/llama_index/blob/f12d46acab73f5b2243ef49c2f00101617b38ce4/llama-index-core/llama_index/core/objects/table_node_mapping.py#L45)은 schema와 추가 context를 TextNode로 변환한다. 검색 결과를 table/context 객체로 복원한다.
- [ObjectRetriever](https://github.com/run-llama/llama_index/blob/f12d46acab73f5b2243ef49c2f00101617b38ce4/llama-index-core/llama_index/core/objects/base.py#L51)는 검색 → 후처리 → 원래 객체 변환 순서를 갖는다.
- [VectorIndexRetriever](https://github.com/run-llama/llama_index/blob/f12d46acab73f5b2243ef49c2f00101617b38ce4/llama-index-core/llama_index/core/indices/vector_store/retrievers/retriever.py#L104)는 질문 임베딩과 filter/node ID/top-k 등을 vector store query에 전달한다.
- [NLSQLRetriever](https://github.com/run-llama/llama_index/blob/f12d46acab73f5b2243ef49c2f00101617b38ce4/llama-index-core/llama_index/core/indices/struct_store/sql_retriever.py#L280)는 검색된 테이블 설명을 SQL 생성 맥락으로 구성한다. 이 부분은 후보 검색의 참고이며 MYSCube의 실행 권한/업무 검증을 대신하지 않는다. 우리 라우터는 모델 SQL을 직접 실행하는 경로를 채택하지 않는다.

네 파일의 관련 메서드를 읽었다. 전체 라이브러리·모든 vector store·실제 모델의 검색 성능을 검증했다는 뜻은 아니다. 외부 코드를 실행하거나 설치하지 않았다.

### MetricFlow: 정의의 조합을 계획으로 검증한 다음 SQL로 바꾼다

고정 SHA: `e2f17cbb6563f1ed90450639e51588057da0ba4e`.

- [MetricFlowEngine._create_execution_plan](https://github.com/dbt-labs/metricflow/blob/e2f17cbb6563f1ed90450639e51588057da0ba4e/metricflow/engine/metricflow_engine.py#L557)은 metric/group/time/filter 요청을 parse/validate하고 dataflow plan을 만든 후 SQL 실행 계획으로 변환한다.
- [DataflowPlanBuilder](https://github.com/dbt-labs/metricflow/blob/e2f17cbb6563f1ed90450639e51588057da0ba4e/metricflow/dataflow/builder/dataflow_plan_builder.py#L840)는 요청 항목을 연결할 수 없으면 `UnableToSatisfyQueryError`를 낸다. 가까운 이름의 테이블을 임의로 붙이는 방식이 아니다.

엔진의 실행 계획 경로와 builder의 연결 실패 경로, SQL 변환 진입점을 읽었다. 모든 metric 알고리즘이나 저장소 전체를 감사하지 않았다. dbt/MetricFlow를 현재 제품 의존성으로 추가하지 않는다.

LlamaIndex는 검토한 후보 검색 사례이며 도입 결정이 아니다. 이번에 적용하는 중심은 MetricFlow처럼 **업무 정의를 조합한 요청을 검증하고 실행 계획으로 변환하는 원칙**이다. 관련 소스는 S15의 WrenAI·LangGraph·Dify 검토와 함께 읽는다.

## 정의와 실행 계약

정의의 단일 기준은 검토된 서버 registry다. 모델은 이 registry에서 권한 내 정의를 선택하며 새로운 의미·수식·관계를 만들어 실행할 수 없다.

정의마다 ID·버전·내용 해시, 설명, 필드 타입, 상태별 의미, 지표의 계산 방법과 분모, 기간·시간대·집계 단위, 원본 근거, 허용 관계, 적용 한계를 보존한다. 사본에는 연결된 정의 ID/버전을 기록한다. 정의와 사본 형식이 다르면 추정하지 않고 안내한다.

1. 서버가 최신 권한으로 조회 가능한 dataset과 정의를 확인한다.
2. 모델은 대화 맥락을 유지하면서 필요한 필드·지표·기간·조건을 typed plan으로 선택한다.
3. 서버가 선택 항목과 적용 조건을 검증한다. 미등록 지표·관계·값·버전은 실행하지 않는다.
4. 필수 조건이 부족하면 구체적인 확인 질문을 저장하고 현재 결과를 유지한다.
5. 서버가 SQL을 생성해 권한 내 사본의 고정 버전에서 실행한다.
6. 사용한 정의·계획·사본·실제 계산 결과를 근거로 저장하고 답변·HTML에 연결한다.

질문마다 새 endpoint를 만들지 않는다. 지원 업무가 늘어날 때 검토된 정의와 사본 adapter를 추가한다. 업무 정의가 아직 없다는 사실을 SQL이나 임베딩으로 숨기지 않는다.

## 이번 구현 범위와 다음 검증

이번에는 버전 있는 주정산 상태 정의, typed query plan, 허용 필드·지표·기간 검사, 서버 SQL 생성, 실제 사본/근거 저장 경로를 먼저 연결한다. 월·주차·상태·선택 열·그룹·정렬·허용 집계를 같은 실행기로 조합한다. 미등록 지표와 관계는 실행하지 않는다.

**벡터 검색은 도입하지 않으며 이번 구현의 활성화 조건도 아니다.** 별도 provider·인덱스·벡터 DB를 추가하지 않는다. 모델/API와 사본 저장소의 운영 격리 검증은 기존 계획대로 필요하다.

관계가 필요한 질문에는 사업↔조직↔기간 등 검토된 entity/cardinality 정의를 추가해야 한다. 사업 수·금액 합계의 중복 증가와 서로 다른 사본 시점의 혼합을 시험하기 전 임의 JOIN을 열지 않는다. 이는 질문마다 파이프라인을 만드는 작업이 아니라 재사용되는 업무 관계를 한 번 정의하는 작업이다.

검증은 세 층으로 나눈다.

- 해석: 한국어 바꿔 말하기·오타·후속 질문에서 필요한 정의 선택, 확인 질문 필요 여부, 옛 버전/권한 밖 항목 배제, 응답 지연을 측정한다. 실제 모델 평가를 fixture 테스트와 구분한다.
- 조합: 필수 조건 누락, 정의 불일치, 미등록 metric/join, 승인 대기와 업데이트 대기, UNKNOWN과 명시된 0을 검증한다.
- 결과: 동일 사본/정의로 실제 계산한 값과 답변·HTML binding·저장 후 재열기를 대조한다. fixture planner 결과를 실제 모델의 의미 정확도로 보고하지 않는다.
