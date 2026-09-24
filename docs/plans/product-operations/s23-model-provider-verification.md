# S23: 실제 모델 요청 계약 검증

2026-09-24. 기존 업무 서비스·원본 업무 자료를 조회하거나 변경하지 않고, 승인된 독립 모델과 합성 자료를 사용했다. 20사례의 질문·정답 기준은 `acceptance-cases.mjs`의 최초 커밋 `e0ae9856` 그대로 유지한다.

## 최초 실패와 실제 원인 대조

고정한 소스·renderer·평가 자료로 최초 실행한 20사례는 모두 답변 생성 전 실패했다. 결과는 전용 호스트 `/var/tmp/myscube-c4-results-e0ae9856/report.json`에 보존했다. 정확도 통과로 계산하지 않는다.

SDK `retryOptions.attempts=1` 경로는 공급자의 HTTP 400 본문·상태를 일반 Error로 바꾸었다. 설치된 SDK 소스의 `apiCall`을 확인하고, 재시도 설정 없는 기본 단일 fetch 경로로 대조하니 `generateContent`, HTTP 400 `INVALID_ARGUMENT`로 확인됐다. token count 호출은 성공했다.

동일 모델·인증·대화 자료에서 요청 스키마만 바꾼 진단 결과:

| 진단 | 실제 결과 |
| --- | --- |
| 원래 도구 전체 + ANY | HTTP 400 |
| clarify/investigate/answer/build_screen 스키마 각각 | HTTP 200; 짧은 출력 한도의 일부는 MAX_TOKENS이므로 답변 품질 증거가 아님 |
| query 스키마 + scalar/array 중첩 조건 | HTTP 400 |
| query의 scalar만 남긴 진단 | HTTP 200; 지원 범위를 줄이므로 제품 수정에 사용하지 않음 |
| 객체 wrapper·분기별 도구·중첩 union 평탄화 | 전체 스키마 문제를 해결하지 못함 |
| 원래 도구·스키마·질문 유지, AUTO로만 변경 | HTTP 200, STOP, workbench_step의 연도 확인 질문 |

[Google의 function calling 설명](https://ai.google.dev/gemini-api/docs/function-calling)과 [공식 함수 선언 계약](https://ai.google.dev/api/generate-content#functiondeclaration)을 함께 확인했다. 현재 모델의 강제 도구 디코딩과 실제 스키마 조합에서 발생한 관측이며, 모든 Gemini 버전의 일반적 제한으로 단정하지 않는다.

## 제품 수정

스키마에서 값·형식·배열 조건을 삭제하지 않는다. AUTO로 도구 후보를 생성하되 허용된 함수 정확히 1개만 수용한다. 일반 텍스트, 다른 함수, 여러 호출은 실행·표시하지 않는다. 기존 conversation의 discriminated Zod action, semantic query의 필드·자료형·기간·권한·버전 검증, React 소스 검증과 실제 컴파일을 그대로 거친다. 공급자의 디코딩을 업무 권한이나 정확성 보장으로 간주하지 않는다.

공급자 요청 실패는 countTokens/generateContent 단계와 숫자 HTTP 상태만 구분한다. 사용자에게는 정해진 한국어 안내를 제공하며 원문 응답·비밀값·입력 자료는 오류로 노출하지 않는다. 자동 재시도는 추가하지 않는다. 응답을 받은 뒤 형식 검증에 실패하더라도 이미 사용한 토큰은 기록한다.

## 재검증 범위

SDK 실제 transport를 가짜 HTTP 응답에 연결해 단일 요청·상태 보존·본문 비노출을 검증하고, 기존 업무/권한 파서 회귀를 검사한다. 이것은 실제 모델 정확도 증거가 아니다. 수정된 소스와 renderer를 다시 고정해 같은 20사례 전체를 별도 run으로 실행한다. 첫 실패 결과를 덮어쓰거나 좋은 시도만 합치지 않는다.

평가 실행 한도는 최대 60요청, 누적 700,000토큰 이후 새 호출 금지다. 최초 350,000 한도는 다단계 조회와 생성에 필요한 전체 23턴을 수용하기에 부족해 조정했다. 마지막 요청은 해당 입력/출력 한도 안에서 이 기준을 넘을 수 있으며 실제 사용량을 별도 기록한다. 합성 자료와 기존 승인된 독립 모델만 사용하며 서비스/권한을 확장하지 않는다. 평가 완료 후 독립 QA가 실제 trace·조회 결과·제안 소스·화면을 판정해야 C4 점수를 인정한다.
