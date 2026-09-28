# S23 정적 프롬프트 크기 감사 — 5b15c717

2026-09-28. 실제 C4 평가에 사용한 `5b15c717c6b90f24c4ec1a0e142d28db093c0408`의 프롬프트를 공개 합성 입력으로 재구성했다. **제품 변경·모델 호출·DB 접근·컴파일·배포는 하지 않았다.** 현재 개발 중인 후속 소스와 구분한다.

[재현 스크립트](evidence/s23-static-prompt-audit.mjs), [전체 항목별 집계](evidence/s23-static-prompt-audit-5b15c717.json).

## 측정 방법과 한계

고정 소스의 실제 `runConversationTurn`을 실행하고, 주입한 `complete` 함수에서 messages/tools를 잡은 뒤 즉시 중단했다. 외부 전송 함수는 호출하지 않는다. 공개 업무 정의 2개(`weekly_submission`, `cashflow_inflow`)의 물리 스키마, 합성 5열 사업 표 1개, 합성 API 1개와 작은 카운터 소스만 사용했다. 행은 없으며, 실제 평가 질문·정답·운영 자료를 사용하지 않았다. 이전 대화는 비어 있다.

수치는 JavaScript UTF-16 문자 수다. UTF-8 바이트 수와 요청 JSON 길이도 집계에 따로 있다. “전체 내용”은 메시지 content 길이와 도구 배열 JSON 길이의 합이며, JSON 전송 인코딩 길이나 토큰 수가 아니다. 실제 SDK의 변환·토크나이저·추론/출력 토큰·누적 대화 크기를 재현한 측정이 아니다. 실제 평가의 입력 원문/분해된 토큰 사용량은 저장되지 않아 **실제 입력 토큰 또는 비용 절감량으로 환산할 수 없다.**

재현은 고정 커밋의 별도 소스 디렉터리와 기존 동일 lock 의존성을 사용한다. 스크립트는 직접 사용하는 프롬프트 모듈의 해시를 확인한다. 전체 의존성의 출처는 같은 커밋 archive로 고정해야 한다. 원래 평가 archive SHA-256은 `201dd7e4d69d8be7ed9f83e13180244fd974f3e6cb56fdc208d5a1b6b9c6a353`이다.

```sh
node docs/plans/product-operations/evidence/s23-static-prompt-audit.mjs \
  --source-root /path/to/extracted-5b15c717-source
```

Node 24.21.0에서 6개 planner 입력 조합과 신규/편집 React author 2개 조합의 capture 및 assertion을 통과했다. 브라우저 검증이 필요한 제품 변경이 아닌 정적 입력 구성 감사다.

## React planner 크기

| 합성 자료 | 시스템 | 도구 배열 | 편집 소스 메시지 | 사용자 메시지 | 전체 내용 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 없음 | 8,317 | 18,226 | 205 | 24 | 26,772 |
| 업무 정의 2개 | 27,109 | 18,226 | 205 | 24 | 45,564 |
| 업무 정의 2개 + 원문 표 1개 | 29,725 | 18,226 | 205 | 24 | 48,180 |

마지막 조합의 시스템 안에 catalog 18,237자, semantic query guide 4,293자, 별도 table guide 1,291자, action/required 필드 요약 594자가 있다. 선택 API JSON은 427자다. 이 값들은 시스템 내부 항목이므로 전체에 다시 더하면 안 된다.

실제 코드 경로:

- [analytics-service catalog](https://github.com/merryAI-dev/MYSCube/blob/5b15c717c6b90f24c4ec1a0e142d28db093c0408/server/workbench/analytics-service.mjs): `items`, `resolveSemanticCatalog(items)`, `buildTableQueryGuide(items)`를 함께 반환한다.
- [conversation-agent](https://github.com/merryAI-dev/MYSCube/blob/5b15c717c6b90f24c4ec1a0e142d28db093c0408/server/workbench/conversation-agent.mjs): 그 catalog 전체를 직렬화하고 같은 table guide를 다시 계산하여 별도 문장에 붙인다. 매 다음 동작마다 동일 시스템과 도구 스키마를 `complete`에 전달한다.
- [semantic-catalog](https://github.com/merryAI-dev/MYSCube/blob/5b15c717c6b90f24c4ec1a0e142d28db093c0408/server/workbench/semantic-catalog.mjs): `bindSemanticDefinition`의 `{...item, definition, definitionHash}` 때문에 `catalog.items`의 메타데이터가 semantic.items에 반복된다.

## 정확히 확인한 중복과 최소 제안

| 항목 | 현재 중복 | 작은 변경 후보 | 합성 마지막 조합 감소 |
| --- | --- | --- | ---: |
| 원문 표 guide | `catalog.tables`와 별도 guide가 바이트 단위로 동일 | `catalog.tables`를 그대로 남기고 별도 직렬화 문장 제거. 안내가 필요하면 짧게 기존 위치 참조 | 1,320자(줄 제목 포함; 새 참조문 추가 전) |
| semantic metadata | `catalog.items`의 원본 메타데이터가 semantic.items에도 반복 | **모델용 projection에만** semantic.items를 `{datasetId,definition,definitionHash}`로 전달하고 `catalog.items`를 ID로 참조. API 원본 응답과 검증 함수는 유지 | 2,196자(새 참조문 추가 전) |
| oneOf 공통 interpretation | 같은 1,611자 스키마가 7개 동작에 반복 | 후속 후보: 공통 interpretation을 한 번 표현하는 구조 검토 | 6개 추가 복사분 9,666자; 순절감 추정 아님 |

첫 두 가정의 감소 합계는 3,516자: 전체 내용 48,180자의 **7.30%**, 시스템 29,725자의 11.83%다. 구현 시 참조 안내를 추가하면 순감소는 이보다 작다. 데이터가 없는 fixture에서는 같은 두 가정으로 491자, 업무 정의 2개에서는 2,687자가 감소한다. 모든 semantic 항목을 `catalog.items`와 다시 합쳤을 때 원래 항목과 정확히 같다는 assertion으로 정보 보존을 확인했다.

**7.3% 문자 감소가 고정 20사례 예산 내 완주를 보장하지 않는다.** 최저 위험 후보 두 개만 우선 고려하고, 의미·권한·필수 조건을 제거하지 않는다. `semantic query guide`는 단순 복제가 아니다. 허용 연산자, 기간 필드 위치, 필수 필터/맥락 대조, selection 규칙을 생성하므로 통째로 삭제하면 안 된다. 그중 time parameter schema의 166자만 도구 정의와 중첩되지만 현재 작은 변경 범위로 삼을 필요가 없다. `actionContract`도 도구 전체 중복이 아닌 필수 필드 요약이며 형식 교정 경로가 사용하므로 유지한다.

oneOf 구조 변경은 이번 최소 후보에 포함하지 않는다. 공통 interpretation을 최상위로 이동하거나 참조로 묶는 변경에는 provider의 JSON Schema 지원과 함수 호출 형식, strict 검증 및 malformed 응답·명확화·질의·생성 전체의 별도 QA가 필요하다. 9,666자를 실제 절감 가능한 수치로 계산하지 않는다.

구현은 보류했다. 적용한다면 승인 자료/정의/버전/coverage/누락 정보가 모두 보존되는 projection 재구성 테스트, unknown dataset 거부, 형식 교정·query_api·원문 표·후속 대화 회귀 후 같은 고정 평가를 다시 판단해야 한다. 정책·권한·정답 기준과 예산을 낮추거나 늘리는 변경은 제안하지 않는다.

## HTML 예시와 React author는 별도 경로

`htmlReferencePrompt()` 8,418자는 legacy HTML 경로에만 있다. React planner에는 0자다. 같은 마지막 fixture의 legacy 시스템은 36,887자, 전체 내용은 52,164자다. 따라서 실제 React 평가 예산 문제를 “HTML 예시를 지우면 해결”로 설명할 수 없다. 공통 정책의 HTML 관련 안내 일부는 React에서도 남지만, 업무 숫자 바인딩/부분합/표 표시 의미까지 포함하므로 단순 삭제를 제안하지 않는다.

실제 `generateReactPage`의 첫 complete 경계도 같은 방법으로 확인했다:

| 공개 합성 author 입력 | 시스템 | 도구 배열 | 사용자 payload | 새 화면 예제 |
| --- | ---: | ---: | ---: | --- |
| 새 화면 | 7,142 | 2,404 | 125 | 포함 |
| 기존 화면 편집 | 6,411 | 2,404 | 302 | 미포함 |

author에는 전체 catalog/query guide가 없고 선택 API와 소스·요청·업무 맥락만 전달된다. 편집 시 새 화면 예제는 이미 빠진다. 따라서 첫 개선 대상은 author 예시나 파일 보존 계약보다 planner의 확인된 catalog 중복이다. 실제 대화의 여러 단계에서는 시스템/도구와 이전 결과를 다시 전달하므로 총 사용량이 증가할 수 있지만, 본 감사에는 실제 입력 trace가 없어 단계별 실토큰 기여도를 산정하지 않았다.
