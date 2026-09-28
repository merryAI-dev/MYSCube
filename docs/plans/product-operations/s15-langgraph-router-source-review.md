# S15 — LangGraph JS 라우터·실행·복원 소스 검토

검토일: 2026-09-22. 독립 QA 검토. Jev 제외. 제품 코드·운영 설정·데이터는 변경하지 않았다.

## 결론과 검토 범위

질문마다 파이프라인을 추가하는 대신 **대화 실행 상태를 관리하는 공통 graph + 권한이 적용된 데이터 catalog/SQL engine + evidence 저장 + HTML binding**으로 역할을 나누는 방향이 적합하다. LangGraph는 첫 번째 부분의 성숙한 대안이다. SQL 의미, 사본 완전성, 조직 권한, 수치의 근거까지 해결하는 데이터 계층은 아니다. 도입한다면 기존 구현 전체를 버리거나 질문별 노드를 만드는 것이 아니라 실행 제어만 단계적으로 교체한다.

공식 저장소 `langchain-ai/langgraphjs`를 shallow clone하여 SHA **f5b63cdabcb4d803a0304a8a9d2b6e3def243684**의 아래 구현과 관련 테스트를 읽었다. 외부 저장소의 설치·스크립트·테스트는 실행하지 않았다. 전체 저장소 전 파일이나 실제 배포 동작을 검증한 결과가 아니다. GitHub API는 rate limit으로 실패하여 git transport로 SHA를 확인했다. 별 개수는 재확인하지 못했으므로 기재하지 않는다.

이 SHA에서 `libs/langgraph/src/pregel/index.ts`는 re-export이고, 실제 런타임은 `libs/langgraph-core/src`에 있다. 과거 디렉터리나 README만 읽으면 실행 코드를 놓친다.

## 실제 호출 경로

```text
StateGraph.addNode / addConditionalEdges
  → StateGraph.compile: graph 검증, state channel과 node policy 구성
  → CompiledStateGraph.attachNode / attachBranch: runnable, trigger, write 연결
  → Pregel stream 실행: PregelLoop.initialize + PregelRunner
  → _runLoop: loop.tick → runner.tick (반복, recursion limit)
  → _runWithRetry → runAttemptWithTimeout → node.proc.invoke
  → runner._commit: 성공 writes / interrupt / error 기록
  → loop.putWrites + _putCheckpoint → BaseCheckpointSaver
```

| 경계 | 읽은 실제 소스 | 확인한 동작과 적용상 의미 |
|---|---|---|
| graph compile | [state.ts L1490](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/graph/state.ts#L1490), [node/branch 연결 L1564](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/graph/state.ts#L1564) | topology 검증 후 실행 graph를 만든다. 컴파일은 사용자의 질문을 SQL로 검증하는 단계가 아니다. |
| conditional routing | [graph.ts L186](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/graph/graph.ts#L186), [state.ts L1997](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/graph/state.ts#L1997) | branch runnable 결과를 destination으로 변환하고 null/unknown 목적지를 거부한다. 결과는 branch channel writes가 된다. 모델이 임의 도구명/노드명을 권한으로 만들어내게 해서는 안 된다. |
| runtime | [pregel/index.ts L2425](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/index.ts#L2425), [L2603](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/index.ts#L2603) | loop와 runner를 분리하고 각 step에 timeout/retry/concurrency/signal을 전달한다. recursion limit은 총 비용 한도가 아니다. |
| 결과 commit | [runner.ts L431](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/runner.ts#L431) | interrupt와 실패를 성공 writes와 구분한다. 이를 앱의 완료/실패/확인 대기 표시로 명시적으로 매핑해야 한다. |
| checkpoint | [loop.ts L1744](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/loop.ts#L1744), [checkpoint/base.ts L129](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/checkpoint/src/base.ts#L129) | checkpoint와 중간 writes를 별도 저장하며 순서를 보존한다. 저장 durability 정책이 있으므로 프레임워크 추가만으로 모든 실행 단계가 동기적으로 영속화된다고 말할 수 없다. |

## Command / interrupt / resume는 무엇을 보장하나

[Command 구현 L546](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/constants.ts#L546)은 state update, goto, resume를 표현한다. **업무 결재나 사용자의 승인권한을 의미하지 않는다.**

[interrupt 구현](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/interrupt.ts)은 실행 config의 checkpointer를 요구하고, interrupt 순서를 scratchpad로 추적한다. resume 값이 있으면 소비하고, 없으면 GraphInterrupt를 던진다. responseSchema가 있으면 resume 값도 검증한다. 재개는 임의 JS stack을 저장했다 복원하는 방식이 아니다. 노드가 다시 실행되며 이전 interrupt 값이 순서에 따라 소비되므로 interrupt 전에 있는 모델 호출·외부 쓰기 등을 정확히 한 번 실행한다고 가정하면 안 된다.

실제로 읽은 [동적 interrupt 테스트 L299](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/tests/python_port/interrupt.test.ts#L299)는 checkpointer 없음/ thread_id 없음 실패 및 동일 thread의 Command resume를 확인한다. 이 테스트 안에는 checkpoint metadata/state snapshot 검증 일부를 생략했다는 TODO도 있다. 따라서 이 한 테스트를 저장 복원의 모든 증거로 쓰면 안 된다. [resume schema 테스트](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/tests/interrupt.test.ts)는 잘못된 답변 후 수정된 답변을 다시 받는 경우까지 검사한다.

MYSCube에는 명확화 질문을 `pendingClarification`으로 저장하고 다음 turn에서 이어가는 방식이 이미 있다. 이 기능 하나를 위해 graph engine을 즉시 도입할 필요는 없다. 여러 실행 단계의 중간 재개·관측·복구가 실제로 필요해질 때 interrupt/checkpoint로 대체할 가치가 커진다. 어느 방식이든 다른 사용자의 thread 접근 금지와 재개 시 권한 재확인은 앱 책임이다.

## retry / timeout / 도구 호출의 실제 위험

- [retry.ts](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/retry.ts): task 정책이 우선이고, 정책이 없으면 재시도하지 않는다. 기본 분류는 400~409 중 명시된 코드 및 abort 등을 제외하지만 모든 비즈니스 오류를 이해하지 않는다. 오류의 code만 있고 status가 없으면 우리의 권한 오류를 올바르게 분류한다고 보장할 수 없다. 과금 모델 호출과 evidence 저장은 별도 재시도/idempotency 정책이 필요하다. 백오프 sleep 자체는 setTimeout이어서 즉시 취소하는 sleep은 아니다.
- [retry 테스트](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/tests/pregel/retry.test.ts)는 10→20ms 백오프와 jitter를 실제 assertion으로 검사한다. 우리 비용/권한 정책을 검증하는 테스트는 아니다.
- [timeout.ts L207](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/pregel/timeout.ts#L207): node 결과와 watchdog을 race하고 abort signal을 합성하며 늦은 reject를 처리한다. [timeout 테스트 L248](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/tests/timeout.test.ts#L248)는 늦은 reject, timed-out writes 폐기, CPU-bound 작업의 초과시간 판정까지 다룬다. 그러나 이벤트 루프를 점유하는 CPU 작업을 타이머가 선점 종료시키지는 못한다. SQL/컴파일의 worker/process kill 및 독립 리소스 경계는 유지해야 한다.
- [ToolNode L227](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/langgraph-core/src/prebuilt/tool_node.ts#L227): 등록 tools에서 이름을 찾아 config/context를 넘겨 invoke한다. tenant/owner 필터를 자동 생성하지 않는다. 기본 handleToolErrors=true는 대부분의 예외 메시지를 ToolMessage로 돌려 모델에 보낸다. 권한·scope 변경·기밀 오류는 이 일반 경로로 넘기지 말고 종료/정제해야 한다. L326은 복수 호출을 Promise.all로 실행하므로 도구 래퍼의 개별 admission과 예산이 필요하다.

## MYSCube 현재 경로와 차이

현재 파일을 직접 대조했다: `server/workbench/conversation-agent.mjs`, `conversation-routes.mjs`, `conversations.mjs`, `execution-deadline.mjs`. 다음은 추천 설계이며 LangGraph가 이미 설치·연결됐다는 뜻이 아니다.

| 현재 구현 | 유지할 것 | 바꿀 경계 / 우선순위 |
|---|---|---|
| agent 내부 최대 8 step, query 3회, investigate 2회 | bounded execution과 명시적 action schema | P1: 실행 단계와 종료 이유를 공통 event로 영속화. 질문별 endpoint/graph 추가 금지. |
| guarded pre/post authorize + deadline | **P0: 이 경계는 framework 교체 후에도 필수** | node/tool wrappers에 적용. checkpoint resume·결과 read·HTML export에서도 scope 재검사. |
| CAS turn, requestId, lease, complete/fail 저장 | owner 범위·중복 요청·늦은 완료 거부 | P1: app turn과 graph checkpoint 두 저장소를 경쟁하는 SSoT로 만들지 않기. turn이 UI 결과의 canonical record, checkpoint는 실행 복구 기록으로 연결. |
| pendingClarification과 prior context | 질문이 모호하면 query 0회, 이전 화면 유지 | P0: 해소되지 않은 기간/조직/미제출 의미를 실행 전에 확인. graph branch는 이 의미를 대신 판정하지 않는다. |
| scopeFingerprint별 history filter, legacy redaction | 권한 바뀐 뒤 과거 답변이 다시 모델에 들어가지 않도록 하는 정책 | P0: 모든 checkpoint/history/evidence 읽기에 같은 필터. 단순 thread_id 이름 분리만으로 충분하지 않음. |
| copied catalog→SQL engine→evidence→HTML binding | 데이터 근거와 표시 책임 분리 | P0: SQL 실제 범위와 모델 해석의 일치, 사본 누락/미제출 구분. graph 교체보다 먼저 증명할 데이터 계약. |
| 종료 후 turn 전체 결과만 저장 | 최종 사용자 가독성과 소스 버전 | P1: 실행 중 프로세스 종료 후 어느 단계까지 재사용할지 명시. 저장된 evidence ID로 재개하고 모델 호출을 무조건 재실행하지 않음. |

가장 작은 공통 graph는 `authorize → interpret → (clarify | query | investigate | answer | render)`이며 query/investigate가 evidence를 생성하면 다시 interpret로 돌아온다. render는 evidence binding과 preview 제안까지이고 **사용자의 명시적 저장은 별도 command**다. 이것은 질문별 파이프라인이 아니라 공통 실행 프로토콜이다. capabilities와 dataset catalog를 추가할 수 있어도 질문 문구마다 노드를 추가하지 않는다.

LangGraph adoption은 이 구조가 커질 때 실행 스케줄러/복원/관측 구현을 줄이는 선택이다. 지금 바로 전면 마이그레이션하면 checkpoint schema, 비용, thread migration까지 늘어난다. 먼저 현재 엔진을 동일 계약 뒤에 두고 아래 회귀 시나리오로 reference adapter를 비교하는 것이 안전하다. graph의 높은 표현력 자체를 제품 완성 근거로 삼지 않는다.

## 적용 전 PASS gate

1. 같은 대화에서 오류 조사→사용법→명시된 월의 실제 제출상태 조회→CIC별 변경→HTML 저장/새로고침을 수행한다. 질문별 새 endpoint를 만들지 않는다. 실제 복사 데이터·DB 기록·evidence ID·화면 수치를 함께 증명한다.
2. 모호한 연도/기간/상태는 구체적인 질문을 내고 SQL 실행 0회, 이전 preview 불변. 명확한 후속 질문은 context를 유지하되 실제 SQL predicate와 비교한다.
3. 중간 종료 후 동일 요청 재시도에서 turn 중복 완료·중복 유료 호출·늦은 결과 덮어쓰기 방지. interrupt 앞의 부작용 재실행도 시험한다.
4. admin→PM/범위 변경/권한 사본 만료/외부 thread ID/구버전 checkpoint에서 데이터나 과거 답변 노출이 없어야 한다. 재개/도구 전후 모두 확인한다.
5. 모델이 abort 무시, SQL worker CPU 과점유, checkpointer 실패, evidence 쓰기 실패, unknown branch, malformed resume, 동시 재시도 시 실패를 정확히 표시하고 기존 서비스는 영향이 없어야 한다.
6. 정산 파이프라인·운영 DB/JVM fallback 없음. 독립 서비스/스토어/IAM/모델 quota는 별도 배포 증거가 있어야 한다. 프레임워크 단위 테스트만으로 운영 격리를 PASS하지 않는다.
7. 로컬 fixture, 실제 모델 품질, 운영 배포 상태를 별도 표기한다. 이 문서는 **소스 검토 완료**이며 프레임워크 연결 완료나 전체 제품 PASS가 아니다.

## 추가 검토 — embedding/vector는 후보 검색 계층

동일 SHA의 [MemoryStore batch L73](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/checkpoint/src/store/memory.ts#L73), [filterItems/scoreResults L251](https://github.com/langchain-ai/langgraphjs/blob/f5b63cdabcb4d803a0304a8a9d2b6e3def243684/libs/checkpoint/src/store/memory.ts#L251)를 추가로 읽었다. filterItems로 후보를 모으고, embedding 설정이 있으면 embedQuery와 cosine 유사도 정렬을 수행한다. embedding이 없으면 필터 결과를 단순 pagination하므로 vector 모델을 설정하지 않은 상태를 의미 검색 연동 완료로 부르면 안 된다. namespacePrefix는 join한 문자열의 startsWith로 비교한다. 이 prefix API 자체를 tenant ID의 정확한 일치 권한 검사로 사용하지 않는다.

MYSCube의 안전한 조합은 아래와 같다.

```text
인증된 권한 + 유효한 scope revision
 → 서버가 허용한 definition ID 후보 집합
 → 해당 집합 안에서 lexical / optional vector ranking
 → ID + version으로 trusted semantic registry 재로딩
 → metric/field/filter/time plan 검증
 → 권한 재확인 → 서버 SQL 컴파일 → 복사 데이터 실행
 → 정의 버전과 snapshot revision을 가진 evidence → 답변/HTML
```

벡터 결과의 text나 metadata를 실행 가능한 정의로 직접 받아서는 안 된다. 점수가 높은 미허용 정의, 삭제된 정의, 오래된 version, 다른 tenant 후보는 재검증에서 탈락해야 한다. 검색 score는 관련도이며 권한·업무 의미·SQL 정확성의 confidence가 아니다. 권한이 바뀌면 검색 결과 cache도 scope fingerprint와 definition catalog revision에 따라 무효화한다. 검색 후보가 없어도 raw SQL이나 전체 권한 없는 catalog로 확장하지 않고 허용된 lexical 검색 또는 구체적인 확인 질문으로 돌아온다.

index 대상은 우선 검토된 정의·컬럼 의미·사용 예시로 한정하는 것이 적합하다. 원본 로그·개인정보·실제 금액을 embedding provider에 전송하는 것은 별도 개인정보/비용 범위 결정이 필요하다. 외부 embedding 모델·vector DB는 설치하거나 활성화하지 않았다. 후보 검색 품질과 실행의 안전성은 별도 gate이며, 현재는 source-reviewed 설계다.
