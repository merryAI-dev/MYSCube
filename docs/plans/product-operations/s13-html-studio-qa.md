# S13 HTML 제작 공간 독립 QA

검토일: 2026-09-22. 소스 검토 시점의 중간 판정이며 운영 출시 승인 문서가 아니다.

## 의도와 완료 경계

실제 HTML/CSS 원문을 생성 제안·편집·저장하고, 선택한 불변 버전을 복원하며 해당 원문과 해시를 리뷰용으로 내보내는 경로를 검증한다. JSON 위젯 구성만 바꾸는 것과 구분한다.

TOI와 공유하는 원칙은 실행 정책과 사용자 소스의 분리, 사용자별 실행 문서 격리, 성공한 문서로 미리보기 교체다. 현재 방식은 스크립트 없는 정적 HTML/CSS다. 임의 JavaScript 실행, React 패키지 조합 빌드, 실시간 업무 API 바인딩, 자동 Git 커밋·PR 생성까지 구현한 것으로 표현하면 안 된다.

`자료 미연결` 예제는 운영 수치나 실제 QA 진단이 아니다. HTML 스튜디오의 생성·표시 기능과 별도 격리 코어의 로그 질의 기능을 한 번에 연결된 제품으로 오인시키지 않는다. 실제 전용 모델 호출과 운영 인프라 연결도 별도 판정한다.

## 실제 데이터 경로

편집기 → 독립 `/api/v1/html-work-pages` → 독립 Firestore 소유자별 페이지 및 versions → 새로고침 재조회 → 저장 원문 hash/revision → preview 실행 복사본 또는 export manifest.

저장 원문은 보존하고 preview만 공통 parser로 해석하여 실행 정책을 삽입한다. 모델 제안은 적용·저장 전에는 버전을 만들지 않는다. 복원은 기존 버전을 덮어쓰지 않고 새 버전을 만든다.

## 단계별 통과 조건

1. 의도: 실제 원문·버전·정책·참고 자료 정보가 저장되고 화면에서 어느 자료를 검토하는지 확인 가능해야 한다.
2. 구현: 서버 계산 hash, 소유자/조직 격리, optimistic concurrency, 스크립트·네트워크·외부 이동 차단, 모델 실패 시 기존 소스 보존이 필요하다.
3. 검증: 실제 API와 emulator DB로 편집→저장→새로고침→수정→복원→export를 수행한다. fixture 모델은 fixture임을 밝히고 실제 모델 성공으로 계산하지 않는다.
4. 회귀: 미연결·오류·타임아웃·오래된 응답·로그아웃/계정전환·권한 변경·동시 저장·금지 HTML·모바일 화면을 확인한다.

## 독립 검토에서 발견한 항목

| 항목 | 관찰 | 판정 및 필요한 증거 |
| --- | --- | --- |
| 목록 재조회 | 서버 목록은 metadata만 반환하지만 최초 UI는 `item.source.title`을 참조했다. | 구현자가 수정 중. metadata 타입과 title 표시 수정 확인. 기능 browser run에서 새로고침·복원·export 단계 통과, 모바일 overflow는 별도 보완 중. |
| preview 스타일 | 컴포넌트가 Tailwind utility에 의존하지만 독립 빌드는 studio.css만 사용하며 공통 iframe 규칙이 candidate에도 적용된다. | 컴포넌트 CSS 적용 후 독립 browser test에서 금지 문서 적용 시 candidate 없음·정상 hash 유지 통과. |
| 계정 전환 응답 | 비동기 run 응답이 actor/session 변경을 확인하지 않고 개인 소스·제안을 상태에 쓴다. | actor UID별 Studio key remount 적용 확인. 실제 인증 계정 전환 브라우저 검증은 미실시. |
| 과도한 HTML 중첩 | 약 110k자인 div 10,000중첩을 validator에 전달하면 `RangeError: Maximum call stack size exceeded` 발생을 재현했다. | 5,000개 노드·128 깊이 제한 적용 후 실제 10,000중첩 browser 입력이 오류 안내로 끝나며 pageerror 없이 정상 화면 유지 통과. |
| 소스 리뷰 | 원문·manifest 내보내기 경로가 있다. | 이는 리뷰 자료 준비이며 자동 코드 리뷰 통과나 보안 보증이 아니다. |
| 자원 격리 | 정적 HTML이라 JS 무한루프를 허용하지 않는다. | 대규모 DOM/CSS·이미지의 렌더 자원 영향까지 완전 격리한다고 표현하지 않는다. |

## 필수 브라우저 증거

- 새로고침 뒤 목록과 원문이 유지되고 서버 hash가 실제 다운로드 UTF-8 원문과 같다.
- 버전 A→B→A복원이 새 버전 C이며 A/B 원문은 변경되지 않는다.
- 저장 후 편집하면 기존 리뷰가 최신인 것처럼 표시되지 않는다.
- 금지 요소·속성·CSS URL·외부 이동·폼·iframe 입력이 거부되고 외부 HTTP 요청이 발생하지 않는다.
- 유효 문서 뒤 실패 문서를 적용해도 마지막 정상 preview가 유지된다. 빠른 연속 적용에서 이전 candidate가 최신 화면을 덮지 않는다.
- 모바일에서 편집·저장·이력·preview를 사용할 수 있고 candidate 문서가 보이지 않는다.
- 생성 실패/미설정은 실제 원인과 기존 소스 보존을 알린다. 적용 전 저장되지 않았음을 명시한다.
- 로그아웃/사용자 교체 중 늦은 응답은 새 세션에 표시되지 않는다.

## 현재 판정

의도는 정적 HTML/CSS 제작 범위에서 부합한다. 독립 보안 browser 시나리오 2/2 통과. 모바일 화면과 실제 인증 계정 전환·권한 경계는 별도 증거가 필요하다. 운영 배포, 실제 전용 모델, 모델 프로젝트 쿼터 증명, 운영 IAM/데이터 갱신, 자동 PR, 임의 React/JavaScript 실행은 본 판정의 PASS 범위가 아니다.

브라우저 보안 시나리오는 `workbench/isolation.e2e.spec.ts`에 작성했다. 실제 실행 2/2 통과했으며, 실제 demo 서버는 모든 요청을 demo-admin으로 처리하므로 이 테스트를 소유자 권한 검증으로 계산하지 않는다.

## 독립 브라우저 실행 증거

- `/tmp/myscube-html-isolation-browser-retry.log`: 2/2 PASS, 실제 localhost 프론트+BFF+Firestore emulator, 실모델 미설정.
- `/tmp/myscube-isolation-browser-independent/isolation.e2e-static-HTML--65d66--requests-blocked-resources/html-network-isolation.png`: 금지 중첩 오류 표시와 마지막 정상 preview hash 유지 육안 확인.
- 금지 script·img/event·외부 링크·meta refresh·CSS import/URL·iframe/form·깊은 HTML 입력에서 probe HTTP 요청 0, pageerror 0, parent DOM 변경 없음. 모델 생성 503 후 목록 200 확인.
- 최초 실행의 Vite optimizer 504/공백화면은 도구 준비 오류로 분리했다. 그 다음 실행의 label locator timeout은 role textbox locator로 명확히 하여 재실행했으며 보안 단언은 완화하지 않았다.

## Tailwind 실제 컴파일 추가 범위 — 재검증 대기

후속 요구로 서버의 고정 Tailwind 4.1.12 컴파일, CSS·실행 HTML 저장이 추가됐다. 위 2/2 브라우저 결과는 이 변경 전 정적 CSS 경로의 증거이며 새 경로를 자동으로 통과시키지 않는다.

추가 통과 조건:

- 실제 utility `p-8/grid/gap-4/font-bold`의 computed style이 각각 32px/grid/16px/700이며 CDN 요청이 없다.
- 임의 클래스의 외부 URL은 서버 검증에서 거부하고 기존 preview를 유지한다.
- 원문·CSS·실행 HTML의 UTF-8 hash가 manifest와 일치하며 복원은 저장 artifact를 재사용한다.
- 과거 버전 export는 현재 compiler 상수로 덮지 않고 저장된 dependencies를 표시한다.
- 원문·artifact 전체 저장 크기를 byte 단위로 제한하고 실패 시 기존 버전을 보존한다.
- preview 실행본의 호스트 CSP가 사용자 원문 검증에 걸리지 않도록 신뢰 경계를 별도로 검증하되 사용자 원문의 임의 CSP 허용으로 우회하지 않는다.
- n20 API 컴파일 latency와 preview commit latency를 분리해 p50/p95/max 및 첫 실행을 기록한다. localhost emulator 측정을 운영 성능으로 설명하지 않는다.

독립 리뷰가 발견한 재컴파일 복원·현재 dependency 상수 표기·UTF-8 저장 크기 문제는 수정 코드를 확인했다. 실제 artifact round trip과 새 프론트 브라우저 결과는 추가 실행이 필요하다. 테스트는 `workbench/isolation.e2e.spec.ts` 3개로 확장했다.
