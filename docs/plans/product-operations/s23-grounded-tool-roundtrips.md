# S23 — 모델 도구 계약과 등록 API 조회 경로 보완

이 변경은 실제 `aacc94da` 고정20사례의 14통과·6실패를 출발점으로 한다. 이전 실패 보고서는 보존한다. 구현 테스트 통과는 실제 모델의 재평가나 실제 사용자 로그인을 대신하지 않는다.

## 관측과 원인 범위

- C05/C09/C14: 실제 SQL 근거는 만들어졌으나 후속 모델 응답을 실행 가능한 도구로 받지 못했다. 기존 `html_model_action_invalid`는 무호출·다중 호출·미등록 함수를 구분하지 않아 정확한 하위 원인을 확정할 수 없다. 후속 진단에는 허용 enum과 호출 수/텍스트 존재 여부만 기록한다. 원문·함수 인수·서명은 진단에 남기지 않는다.
- C16: 선택 API는 있었지만 모델이 별도 `query.plan.select`를 다시 작성하면서 열이 달라졌다. 기존 동일 조건 검증이 이를 정상적으로 거부했다. 검증을 완화하지 않고 `query_api`가 선택된 API의 고정 버전과 입력만 받아 서버 정의에서 계획을 만든다.
- C18: 실제 모델 결과의 파일 키가 `App.tsx` 대신 `minified_App_tsx`, 재시도에서는 `App`으로 바뀌었다. SDK가 바꿨다는 근거는 없다. 모델 도구의 전달 형식만 명시적인 `{path,content}` 목록으로 바꾼다. 정확한 경로를 검증한 후 기존 canonical workspace의 파일 맵으로 변환하며, 경로 추측·자동 보충·자동 삭제를 하지 않는다.
- C17: 기한 내 최종 응답을 받지 못했다. 원인을 확인하지 않은 채 기한을 늘리지 않는다.

## 도구 결과의 대화 연결

기존 루프는 모델의 함수 호출을 JSON 텍스트로, 조회 결과를 새 사용자 텍스트로 전달했다. 현재 turn의 원래 모델 content와 함수 호출 ID·서명을 유지하고 `functionResponse`로 결과를 전달하도록 바꾼다. 서버 내부 WeakMap에만 원본 content를 보유하며 HTTP 응답, 저장 대화, 로그에 서명을 추가하지 않는다. 저장된 과거 대화와 fixture에는 기존 텍스트 표현을 유지한다. 이 구조 교정이 C05를 해결한다는 판정은 실제 재평가 이후에만 한다.

[Google Generate Content의 공식 서명 계약](https://ai.google.dev/gemini-api/docs/generate-content/thought-signatures)은 현재 turn의 함수 호출 parts와 서명을 받은 그대로 다음 단계에 전달하도록 설명한다. [함수 선언 SDK 계약](https://googleapis.github.io/js-genai/release_docs/interfaces/types.FunctionDeclaration.html)의 JSON Schema 지원과 실제 모델의 정확한 파일 경로 생성 능력은 별개다.

## 등록 API를 단일 조회 정의로 사용

`query_api(apiId, apiVersion, input)` → 선택 버전 확인 → 현재 권한/활성 상태 확인 → 등록 입력 검증 → 서버의 immutable plan 해석 → 기존 semantic query/사본 버전 고정 → 근거 저장 → 기존 exact binding 확인 → React 제안/실행.

모델이 plan·SQL·columns를 덧붙이면 스키마 검증에서 거부한다. 미선택 ID/버전, 외부 API, 잘못된 입력은 재시도로 추측하지 않는다. 일반 업무 질문은 기존 semantic query를 계속 사용한다. 자연어 의도와 선택 API의 업무적 일치는 여전히 검증 대상이며, 이 동작이 있다는 이유로 C16에 점수를 주지 않는다.

## 실패 상태 복구

테스트 작성 중 숫자형 의존 서비스 오류 코드가 대화 실패 저장 스키마를 통과하지 못해 원래 오류를 덮는 결함도 확인했다. 업무 오류 코드는 문자열인 경우만 유지한다. 숫자형 코드는 기존 일반 실패 코드로 저장하여 실패 turn과 잠금을 정리하고 같은 대화의 다음 요청을 허용한다. 의존 서비스의 원문 메시지는 사용자 대화에 저장하지 않는다.

## 격리 범위

모든 변경은 독립 Workbench의 모델 어댑터·조회·생성·검증·대화 실패 처리다. 원본 업무 DB 쓰기, 주정산/월결산 계산 및 동기화, JVM, 운영 서비스의 실행 경로를 추가하지 않는다. 평가 소스·이미지·oracle hash를 고정한 뒤 동일20사례를 다시 실행한다.

## 현재 검증

- 독립10파일95/95 PASS: 실제 SDK 요청 직렬화, strict 파일 목록 계약/실제 컴파일, 실제 Firestore API 조회·권한 철회·실패 저장·잠금 해제·재시도. `/tmp/myscube-query-provider-independent.log`.
- Workbench TypeScript 검사와 프로덕션 빌드 PASS. 초기 chunk 546.22KB 경고는 남아 있으며 경고를 숨기거나 성능 통과로 계산하지 않았다.
- 같은 세션 viewport 변경은 별도 `fd51a30e`에서 backend61/61, browser18/18 독립 PASS. 실제 OS IME/스크린리더 및 운영 속도 수용은 별도다.
- 모델 실제20사례 재평가 전이므로 점수80/100 유지.

- 독립 실제 브라우저4파일11/11 PASS(41.3초): API·생성·명시 적용·저장/재열기/복원·실제 조회 근거와 권한 회수. `/tmp/myscube-model-wire-browser-independent.log`.
