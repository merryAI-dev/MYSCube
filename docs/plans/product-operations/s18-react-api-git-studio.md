# S18 — React 실행·사용자 API 등록·자동 Git PR

2026-09-23. 세 기능의 개발과 독립 환경 통합 검증을 진행했다. 운영 활성화 및 실제 모델 평가 완료를 뜻하지 않는다. 주정산·월결산·JVM과 실제 업무 데이터는 변경하지 않는다.

## 사용 흐름

기존 제작 공간의 **React 제작 공간**으로 이동한다(`/?mode=react`). **API 등록·관리**에서 접근 가능한 독립 분석 사본을 고르고 조회 정의와 입력 항목을 등록한다. 저장한 버전으로 실제 조회를 시험할 수 있다. 이름만 등록하는 목록이 아니라 Firestore에 불변 버전이 저장되고 조회 시 실제 권한·입력·계산 기준을 검증한다.

**화면 만들기**에서 API 버전을 선택하고 화면을 요청하거나 App.tsx를 직접 편집한다. 생성 요청에는 현재 코드와 선택한 API 입력 계약을 제공한다. 제안은 원문을 덮지 않고 먼저 검토하게 한다. React 상태·이벤트·필터가 동작하며, 업무 자료는 `window.workbench.callApi(apiId, input)`로만 호스트에 요청한다. 서버는 실행 권한 ID에 고정한 API 버전과 현재 자료 권한을 확인한다.

**React 저장·PR 생성**은 먼저 화면을 불변 버전으로 저장한 다음 그 버전의 원문으로 커밋과 Draft PR을 만든다. GitHub 전달만 실패하면 화면 저장은 유지한다. 같은 버전 재전달은 기존 커밋·PR을 재사용하며, 다른 내용은 새 버전으로 저장해야 한다. 과거 버전 복원도 새 버전으로 기록한다.

## 실제 데이터 경로와 소유권

| 영역 | 구현 | 보장과 제한 |
|---|---|---|
| React 컴파일 | `react-compiler*.mjs` | 단일 App.tsx, 고정 React/ReactDOM/JSX runtime import, V8 old-space 96MB 설정의 별도 Node 프로세스(전체 RSS hard limit는 아님), 3초 제한, 사용자 소스는 서버에서 실행하지 않음 |
| 패키지 | `react-compiler-packages.mjs` | 고정 lockfile·public entry·버전·런타임 해시, React 중복 인스턴스 방지, 서버 시작 시 패키지 사전 준비 및 immutable 캐시 |
| 실행 | `ReactPreview.tsx`, 별도 runtime server | opaque iframe, 허용 스크립트만, MessageChannel 세대 식별, 준비된 동일 DOM 승격, 이전 정상 화면 유지 |
| API 등록 | `registered-apis.mjs` | 관리자·조직별 소유, API 불변 버전, 최신 사용 중지 상태 확인, 입력 schema와 semantic query 검증, raw SQL·URL·인증값 미수용 |
| 실제 조회 | `analytics.queryPlan` | 분석 사본에서만 조회, 실제 DuckDB 결과와 영구 근거 생성, 호출 전후 권한 확인, 요청 횟수·결과 크기 제한 |
| 저장 | `react-pages.mjs` | 원문/실행본 해시 확인, expectedVersion 충돌 차단, 복원을 새 버전으로 저장 |
| Git | `git-delivery.mjs` | 지정 repo/base, 고정 generated 경로, 소스·manifest·README만 전송, API ID/버전 기록, 단계별 재시도·lease·원격 SHA 일치 확인 |

HTTP 전송 형태는 JSON이지만 제작 결과물은 실제 App.tsx와 컴파일된 JavaScript/CSS다. TOI 글처럼 브라우저에서 esbuild-wasm으로 빌드하는 방식은 아니다. 이 구현은 독립 서버 프로세스에서 컴파일하고 별도 브라우저 실행 공간에 전달한다. 사용자가 임의 패키지를 설치하는 기능은 제공하지 않는다.

## 외부 API 범위

현재 등록 가능한 대상은 **독립 분석 사본의 읽기 전용 API**다. 사용자가 지정할 외부 API는 주소·인증 방식이 아직 전달되지 않았으므로 활성화하지 않았다. 임의 URL을 받아 운영 서버를 프록시하거나 주변 자격 증명을 재사용하지 않는다. 외부 API를 연결할 때는 대상 allowlist, credential reference, GET 계약, DNS/redirect/응답 검증과 접근 범위를 먼저 추가해야 한다. 현재 UI도 이 상태를 안내한다.

## 실행 격리 — 운영 활성화 차단 조건

JavaScript를 실행하는 iframe은 HTML 전용 sandbox와 위험 범위가 다르다. nonce CSP만으로는 같은 문서의 사용자 코드가 nonce를 재사용할 수 있으므로, nonce 정책과 동일 출처 스크립트 정책을 동시에 적용한다. 실제 브라우저로 외부 script/fetch/image/CSS/WebSocket/beacon 차단을 확인했다.

그러나 **iframe 자신의 navigation 요청은 요청을 보내기 전에 차단하지 못한다.** 이동을 발견하면 API 채널을 닫지만 이미 보낸 요청을 취소했다고 주장하지 않는다. 무한 루프·native 메모리 사용의 OS 수준 강제 격리도 브라우저 iframe만으로 보장하지 않는다. 이 테스트는 한계를 숨기지 않고 실제 navigation을 관측하도록 작성했다.

따라서 운영은 별도 HTTPS site 및 `WORKBENCH_REACT_RUNTIME_VERIFIED=true` 검증 게이트가 필요하며 **이번에는 해당 플래그를 설정하지 않았다**. 사이트 이름이나 이 플래그 자체가 격리를 증명하지 않는다. 운영 전에는 외부 egress가 통제되는 실행 환경과 CPU/RSS 제한·중단/복구를 실제 검증해야 한다. 신규 기능 때문에 기존 업무가 멈추지 않는 조건을 충족하기 전 React 운영 실행을 활성화하면 안 된다.

## 연결 설정

기존 독립 Workbench 환경과 별도로 다음 설정을 사용한다. 비밀값은 소스나 브라우저에 넣지 않는다.

| 설정 | 의미 |
|---|---|
| `WORKBENCH_APP_ORIGIN` | 제작기 정확한 origin |
| `WORKBENCH_REACT_RUNTIME_URL` | 별도 site의 `/runtime` URL. 미설정이면 실행만 비활성 |
| `WORKBENCH_REACT_RUNTIME_VERIFIED` | 운영 실행 환경 검증 완료 후에만 활성화 |
| `WORKBENCH_RUNTIME_PORT` | 런너 포트, 기본 8792 |
| `WORKBENCH_GIT_REPOSITORY` | 승인한 owner/repo. 이번 테스트는 merryAI-dev/MYSCube |
| `WORKBENCH_GIT_BASE_BRANCH` | 기준 브랜치, 기본 main. 직접 main에 push하지 않음 |
| `WORKBENCH_GITHUB_TOKEN` | 서버 전용 Git 권한. 이번 검증에서는 기존 gh 인증을 메모리에서만 사용 |

로컬 실행은 demo 프로젝트·emulator 모드·서로 다른 loopback origin에서만 예외적으로 허용한다. 실행 명령은 `npm run workbench:runtime`; 패키지 준비 스크립트는 `scripts/build-workbench-react-packages.mjs`다. 전용 Workbench 의존성 설치는 `npm run workbench:install`이며 `tldts@7.0.25`를 고정해 공개 접미사를 고려한 동일 site 판별에 사용한다.

## 검증 근거

- 독립 QA 최종 판정: **로컬 구현·통합 범위 PASS / 운영 활성화 BLOCKED**. QA가 테스트 로그와 중지 API 해제·재저장 회귀를 직접 확인했다. 운영 차단 조건은 위 실행 격리 항목을 따른다.
- 최종 Workbench 검증: Vitest 29개 파일 **305/305 통과**(실제 Chromium 7개 포함), Playwright **13/13 통과**, Workbench TypeScript 검사와 독립 프로덕션 빌드 통과. 전체 MYSCube 테스트를 이번 단계에서 새로 실행한 결과는 아니다.
- 중지된 API는 기존 화면에서 조회를 차단하고, 연결을 해제한 뒤 새 버전으로 저장할 수 있음을 브라우저로 확인했다. 이전 실행의 늦은 성공/실패 응답이 현재 화면의 계산 근거를 덮지 않는 회귀도 검증했다. 마지막 커밋 이벤트 순서 보완 후 해당 회귀와 TypeScript 검사를 다시 통과했다.
- React 상태 버튼·Tailwind·동일 DOM 승격·새 세대로 교체·해시/렌더/effect 오류 복구·지연 후보 차단·채널 grant 유지: 실제 Chromium 검증.
- 등록 API: HTTP → Firestore → 실제 DuckDB → 근거 저장. API 버전/중지/CAS 충돌/권한 회수/다른 관리자/잘못된 입력/저장 재전송을 독립 QA에서 검증.
- 제작기: API 등록 → fixture 모델의 React 제안 → 상태 버튼 → 실제 API 조회 → 저장/새로고침 → 기존 화면에서 API 사용 중지 확인. 데스크톱·390px 모바일 캡처를 직접 확인.
- 실제 Git 모듈 검증: [Draft PR #816](https://github.com/merryAI-dev/MYSCube/pull/816), commit `f18523c7f2017ded6ec437cc91a297e3628924ae`.
- 실제 HTTP 저장→자동 Git 검증: [Draft PR #817](https://github.com/merryAI-dev/MYSCube/pull/817), commit `9f0595db67de1486bc596755e9f2af3c7ad1819d`. 동일 저장 키 재전송·publish 재시도는 같은 PR. 원격 App.tsx를 다시 읽어 바이트와 SHA-256 일치를 확인했다. 3개 파일만 변경했고 운영 데이터/병합/배포는 없다.
- 테스트 소스의 PR이며, 플랫폼 구현 전체를 배포한 PR이 아니다. 실제 외부 모델 호출·운영 서비스 배포·외부 API 연결 완료로 해석하지 않는다.

재현:

```bash
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 WORKBENCH_REACT_BROWSER_QA=1 npx vitest run server/workbench src/app/components/product-operations/html-preview/SourcePreview.test.ts
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run workbench:test:e2e
npx tsc --noEmit -p workbench/tsconfig.json
npm run workbench:build
```

## 참고한 공식 계약

- [토스 TOI의 실행 환경](https://toss.tech/article/52885): 정책과 생성 UI 분리, 패키지 사전 준비, 성공한 문서의 교체.
- [esbuild API](https://esbuild.github.io/api/): 플러그인 import 해석과 번들 설정. 컴파일러 자체를 샌드박스로 취급하지 않는다.
- [HTML iframe sandbox](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe): 스크립트 실행과 origin 권한 구분.
- [GitHub Git trees](https://docs.github.com/en/rest/git/trees), [Git commits](https://docs.github.com/en/rest/git/commits), [Pull requests](https://docs.github.com/en/rest/pulls/pulls): 불변 객체·별도 ref·PR 생성.
- [tldts](https://github.com/remusao/tldts): private suffix를 포함하는 site 구분.
- [Gemini 모델 목록](https://ai.google.dev/gemini-api/docs/models): 기존 기본값 gemini-3.6-flash의 공식 모델 ID를 확인했으며 실제 모델 성공 검증과 구분한다.
