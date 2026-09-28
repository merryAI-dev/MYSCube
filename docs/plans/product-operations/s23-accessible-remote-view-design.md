# S23: 실제 React 실행 DOM을 옮기는 접근 가능한 원격 화면

조사·구현 검증일: 2026-09-24. 현재 독립 작업 브랜치에 구현했으며 운영에는 배포하지 않았다. 외부 의존성이나 생성 코드의 실행 권한을 추가하지 않았다. E4 점수는 아직 올리지 않는다.

## 판단

일반적인 표·필터·입력 폼은 **Docker에서 실행한 실제 React DOM을 스크립트 없는 iframe으로 복제**하여 제공할 수 있다. 생성 React/Tailwind 소스와 컴파일 산출물은 그대로 실행하고, 결과 DOM의 태그·텍스트·순서·레이블 관계·허용된 레이아웃을 전송한다. 요청을 미리 정한 카드/차트 JSON으로 다시 해석하는 방식이 아니다.

다만 rrweb를 설치하면 이 기능이 완성되는 것은 아니다. 상태를 가진 원격 React와 로컬 입력창의 양방향 동기화, 안전한 CSS 부분집합, 세션/노드/입력 순서 검증이 새로 필요하다. 임의 웹 앱을 완벽하게 복제한다거나 DOM 렌더링이 사용자 브라우저 자원을 전혀 쓰지 않는다고 말할 수 없다. 캔버스·WebGL·contenteditable·사용자 정의 요소·shadow DOM·복잡한 드래그/가상화 위젯은 최초 지원 범위에서 제외하고, 감지하면 지원하지 않는 요소를 명시한다. 이를 누락한 채 정상 화면으로 보고하지 않는다.

## 실제 소스에서 확인한 근거

rrweb 공식 저장소는 조사 시 20,205 stars, 비보관 상태, MIT 라이선스였다. 고정 조사 커밋은 `5b08843faf9cb21c836613489ffd93d455f38181`이다. 이 수치는 채택의 안전성 증거가 아니다.

| 확인한 코드 | 의미와 채택 범위 |
| --- | --- |
| [snapshot.ts:618–647](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb-snapshot/src/snapshot.ts#L618) | 입력값·checked·selected는 HTML 속성이 아니라 현재 DOM 프로퍼티도 수집한다. React 상태가 반영된 실제 화면을 옮길 때 같은 구분이 필요하다. |
| [Mirror:192–254](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb-snapshot/src/utils.ts#L192) | 노드와 전송 ID를 양방향으로 관리한다. 생성 코드가 지정한 `id`를 원격 조작 권한으로 사용하지 않는 패턴을 참고한다. |
| [rebuild.ts:92–190](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb-snapshot/src/rebuild.ts#L92), [sandbox 생성](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb-snapshot/src/rebuild.ts#L759) | 기본 rebuild는 보호되지 않은 문서를 거부하고, 정확히 `sandbox="allow-same-origin"`인 iframe을 사용한다. `allow-scripts`를 주지 않는다. 원본 라이브러리를 부모 문서에 직접 사용하는 것은 대안이 아니다. |
| [rebuild.ts:381–431](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb-snapshot/src/rebuild.ts#L381) | 일부 이벤트 속성 변경 외에는 범용 속성 복원이 존재한다. 이 코드를 MYSCube의 엄격한 DOM 검증기로 간주하면 안 된다. |
| [enableInteract:584–591](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb/src/replay/index.ts#L584) | 스크롤과 pointer-events를 켤 뿐, 클릭을 원래 React 앱에 전달하거나 상태를 동기화하지 않는다. `UNSAFE_replayCanvas`는 스크립트 실행을 허용하므로 채택하지 않는다. |
| [입력 관측기](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/packages/rrweb/src/record/observer.ts#L380), [공식 sandbox 설명](https://github.com/rrweb-io/rrweb/blob/5b08843faf9cb21c836613489ffd93d455f38181/docs/sandbox.md) | 입력의 현재값/라디오 그룹/중복 관측을 처리하는 기록 패턴은 참고할 수 있다. 기록·재생과 실시간 양방향 앱 제어는 다르다. |

Chromium 공식 프로토콜도 소스로 확인했다. [DOMSnapshot의 노드·입력 상태](https://github.com/ChromeDevTools/devtools-protocol/blob/692abe8ea60a2203ae6d3e8435ba1c1d70c3ee36/pdl/domains/DOMSnapshot.pdl#L187)와 [captureSnapshot](https://github.com/ChromeDevTools/devtools-protocol/blob/692abe8ea60a2203ae6d3e8435ba1c1d70c3ee36/pdl/domains/DOMSnapshot.pdl#L299)은 backendNodeId, 현재 입력값, 체크/선택 상태, 지정한 computed style을 제공한다. [Input.insertText/imeSetComposition](https://github.com/ChromeDevTools/devtools-protocol/blob/692abe8ea60a2203ae6d3e8435ba1c1d70c3ee36/pdl/domains/Input.pdl#L143)은 IME 경로의 후보이다. 이 최신 프로토콜과 고정 Playwright 1.58.2 렌더러의 호환성은 실제 이미지에서 별도 검증해야 한다.

## 현재 경로와 변경 지점

- `remote-runtime/worker.mjs`는 생성 코드를 Chromium에서 실행하고 PNG만 돌려준다. 이벤트는 좌표 클릭·문자 삽입·키·스크롤이다. 원격 DOM을 읽거나 노드에 입력을 전달하는 계약은 없다.
- `remote-runtime/contract.mjs`의 network-none, 512 MiB, 1 CPU, PID 제한과 `broker.mjs`의 소유자·권한 범위·API 버전·응답 크기·TTL·후보/정상 세션 관리는 유지해야 한다.
- `RemoteReactPreview.tsx`는 1100×700 이미지를 표시하고 2초 간격으로 다시 읽는다. 표 텍스트 선택과 내부 접근성 트리가 없으며, 별도 문자 전송창을 사용한다. 이 상태로 E4를 통과하지 못한다.

## 우선 검토안: 스크립트 없는 iframe + 고정 부모 브리지

```text
생성된 React/Tailwind 소스 → 기존 컴파일/해시 → Docker Chromium에서 실행
  → CDP로 실제 DOM/입력 상태 수집 → worker의 한정된 전송 형식
  → broker의 독립 검증·현재 권한 확인 → 부모의 신뢰된 렌더러
  → sandbox=allow-same-origin, script-src none iframe의 네이티브 DOM
  ← 부모가 등록한 고정 이벤트 브리지 ← 노드/버전 검증 ← 원격 React 이벤트
```

부모 문서에 직접 React 노드를 만들면 스타일과 포커스가 업무 UI에 더 쉽게 영향을 준다. 스크립트 없는 별도 문서는 CSS와 이벤트의 적용 범위를 좁힌다. 부모 코드가 검증된 `createElement`/`textContent`/명시된 프로퍼티만 사용하고, 생성 스크립트·HTML 문자열·CSS 원문은 실행/주입하지 않는다. iframe에 `allow-scripts`, `allow-forms`, 팝업·다운로드·상위 탐색 권한을 추가하지 않는다. URL 속성·외부 리소스·SVG data URL도 전달하지 않는다. CSP는 `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'`처럼 고정한다.

이 구성의 한 가지 전제는 로컬 Chromium으로 실험했다. Chromium `145.0.7632.6`에서 부모 realm이 iframe 노드에 등록한 click/input/keydown listener는 동작했고, 사용자 inline onclick은 실행되지 않았다. 한글 입력 후 Tab/Enter 조작 결과는 `{inline:0, button:1, input:['한글 검색'], key:['Tab']}`였다. Playwright 접근성 스냅샷에는 제목, 레이블이 연결된 textbox, 버튼이 나타났다. 이 실험은 임시 빈 문서에서만 수행했으며 실제 원격 React·OS 한글 IME·모바일·스크린리더 제품 검증은 아니다.

### DOM과 디자인을 보존하는 계약

1. 앱 실행 전에 worker가 루트 노드의 CDP backend ID를 확보한다. 수집은 브라우저 프로토콜/신뢰된 isolated world를 사용한다. 사용자 코드가 main world의 DOM getter나 직렬화 함수를 덮어쓴 결과를 신뢰하지 않는다. 생성 DOM 자체는 여전히 불신 데이터다.
2. 전송값은 `schemaVersion, sessionId, sourceHash, documentEpoch, revision, ackEventId, viewport, root, unsupportedCapabilities`를 갖는 실제 DOM 트리이다. `root`는 허용 태그·텍스트·현재 입력 상태·한정된 스타일이다. broker와 프론트가 각각 검증한다. ID는 세션/문서 세대에 속한 opaque ID이며 backendNodeId 자체를 브라우저 조작 명령으로 공개하지 않는다.
3. heading, paragraph, list, table/thead/tbody/tr/th/td, label, native input/select/option/textarea/button, details/summary 등의 실제 순서와 내용은 보존한다. `id/for`, `aria-labelledby/describedby`, 표 `headers` 참조는 같은 복제 트리의 ID로 일관되게 치환한다. 누락된 참조나 허용하지 않는 태그는 명시적 진단으로 돌려준다. 미리 정한 업무 위젯으로 대체하지 않는다.
4. 실제 Tailwind 적용 결과에서 색·폰트·간격·flex/grid·정렬·테두리 같은 계산된 값만 허용 목록으로 추출한다. CSS 원문, selector, url(), 임의 변수, animation/transition/filter/backdrop-filter, 생성 콘텐츠, 무한 크기/반복 grid는 금지한다. 그림자·크기·grid track에도 값 범위를 둔다. 가상 요소의 중요한 텍스트나 지원하지 않는 표현은 조용히 삭제하지 않고 진단한다. 원본 클래스는 코드/리뷰에 남지만 클라이언트에서 CSS로 재실행하지 않는다.
5. 초기에는 전체 스냅샷을 검증한 후 안정적인 노드 키로 차이를 적용한다. 매 응답마다 iframe/입력 노드를 통째로 교체하지 않는다. 향후 증분 전송은 `baseRevision` 불일치 시 전체 재동기화하는 별도 계약으로만 추가한다. 모바일은 실제 보기 폭을 원격 viewport와 맞추고 다시 수집한다.
6. 지원 여부는 서버가 판단한다. 캔버스, 포털/루트 밖 출력, shadow DOM, contenteditable 등은 화면이 완전하다고 보고하지 않는다. PNG를 함께 제공할 수 있어도 접근 가능한 모드 통과를 대신하지 못한다. BoundEvidence는 계속 생성 화면 밖에 유지한다.

### 이벤트와 입력 순서

- 모든 입력은 `sessionId + sourceHash + documentEpoch + baseRevision + nodeId + eventId`에 묶는다. worker는 현재 살아 있는 같은 타입의 노드인지 확인한 뒤 정해진 동작만 실행한다. 원시 CDP, selector, evaluate, URL, 함수 이름은 클라이언트가 보낼 수 없다. 제거/교체/오래된 노드는 거부하고 재동기화하며 좌표로 추측해서 대신 클릭하지 않는다.
- 원격 이벤트는 세션당 순서대로 처리한다. 중복 eventId는 다시 실행하지 않는다. 응답의 revision과 ackEventId는 그 이벤트가 적용된 스냅샷을 가리킨다. 별도 비동기 API 완료에 따른 DOM 변경도 새 revision으로 전달한다.
- 로컬 입력은 즉시 보이되 아직 원격에 반영되지 않은 초안이다. `inputRevision`, selection, composition 상태를 따로 유지한다. 한글 조합 중이나 더 최신 로컬 입력이 있는 동안 이전 스냅샷이 값/커서를 덮어쓰지 않게 한다. 조합 종료→원격 반영→ACK 후 실제 React 정규화 결과로 합의한다. 네트워크 실패는 반영 완료로 표시하지 않는다.
- text input의 input/change, checkbox/radio/select의 변경, label의 focus, Enter/Space 버튼 활성화, submit/검증 이벤트를 실제 React 18 controlled component와 대조한다. 같은 클릭을 네이티브 동작과 브리지에서 두 번 실행하지 않는다. Tab/Shift+Tab은 로컬 접근 가능한 순서를 유지하고 원격 focus를 동기화한다.
- 새 후보가 실패하면 기존 정상 세션을 유지한다. 세션 교체·계정/권한 변경 시 이전 이벤트/ACK/DOM·입력 초안을 폐기한다. 일반 렌더 오류와 권한 철회는 구분하며, 401/403에는 이전 DOM/근거도 숨긴다.
- 현재 2초 폴링만으로 500ms 입력 반응 목표를 달성한다고 주장할 수 없다. 이벤트 직후 스냅샷과 제한된 변경 알림/대기 조회가 필요하며, 지연은 실제 경로에서 측정해야 한다.

### 브라우저 부하의 별도 경계

생성 JS의 무한 루프는 계속 Docker CPU/메모리 경계에 남는다. 그러나 복제 DOM/CSS는 사용자 브라우저가 처리한다. 스크립트 없는 iframe이나 Shadow DOM이 이 작업의 하드 CPU 격리를 제공하지는 않는다. 초기 제안 한도는 2,000노드·깊이40·텍스트120KiB·전체400KiB·노드당32개 스타일·초당 최대4회 화면 반영이며 실제 표/모바일 측정으로 확정해야 한다. 한도 초과는 페이지네이션/화면 단순화 안내를 반환한다. 클라이언트는 요청 취소와 제한된 일괄 적용을 지원하되 타이머가 이미 시작된 브라우저 layout을 강제로 중단한다고 설명하지 않는다.

## 대안 비교

| 구성 | 실제 생성 화면/입력 | 격리와 한계 |
| --- | --- | --- |
| 기존 PNG | 실제 화면이지만 글자 선택/내부 접근성 불가 | 생성 코드의 network/CPU 제한 유지. E4 미달. |
| 별도 site에서 생성 JS iframe 실행 | 네이티브 UX와 표현 충실도가 가장 좋음 | 클라이언트 생성 코드의 네트워크·CPU/cgroup 경계가 없어져 현재 F2 보장을 대체할 수 없음. |
| rrweb 안전 재생 그대로 | 실제 DOM과 글자 선택은 가능 | 양방향 React 입력 없음. raw rebuild를 엄격한 검증기로 재사용할 수 없음. |
| 제안한 제한된 DOM 복제 | 실제 React 결과의 표/폼/필터와 native 접근성 제공 가능 | 양방향 상태·허용 CSS 구현 필요. 모든 위젯/스타일을 완벽히 복제하지 않음. DOM 비용은 별도 한도/측정 필요. |

## 구현 전에 확정하고 실제로 통과해야 할 검사

1. **원본 일치:** 세 가지 서로 다른 생성 React workspace에서 원격 DOM과 복제 DOM의 텍스트·heading·표 헤더·레이블·현재값을 비교한다. 서버 데이터 변경/필터/정렬 뒤에도 같아야 한다. 고정 UI fixture만으로 생성 화면 지원을 주장하지 않는다.
2. **네이티브 입력:** 실제 원격 React controlled input, 한글 OS IME 조합/취소, paste, 커서 중간 편집, checkbox/radio/select, validation/submit, Enter/Space, focus/scroll, 모바일 터치. 느린 ACK·역순·중복·조합 중 재조회·노드 교체에서 값/커서/이벤트가 유실되지 않아야 한다.
3. **접근성:** 키보드만으로 표 필터→결과 탐색, 텍스트 선택/복사, 실제 VoiceOver/NVDA 중 지원 대상, 모바일 화면 폭과 확대, table headers/label 관계를 확인한다. ariaSnapshot이나 자동 검사만으로 모두 통과 처리하지 않는다.
4. **악성 결과:** script/on*/javascript URL, meta/base/form navigation, iframe/object/SVG/custom element, CSS URL/data SVG/overlay/초대형 grid/filter/animation, 깊은 트리·거대 문자열·빠른 mutation을 모두 거부/제한한다. 생성 JS가 DOM prototype/getter·node ID·직렬화 결과를 위조해도 host 권한/실행 코드로 바뀌지 않아야 한다.
5. **권한/수명:** 다른 tenant/session 노드, 오래된 sourceHash/epoch, 재전송, 교체 후 늦은 응답, API 조회 중 권한 철회, 후보 실패, TTL·unmount 종료, 재연결 후 전체 동기화를 검증한다. 브라우저/서버 로그에 DOM 본문이나 입력값을 남기지 않는다.
6. **자원/속도:** 실제 Docker 무한 루프·메모리/API 폭주 중 독립 정상 세션과 업무 UI가 생존하는 기존 F2 검사를 유지한다. 추가로 허용 한도 최대 DOM/CSS와 연속 갱신의 host long-task·메모리를 측정한다. cold/update/input p95는 각20회 이상 실제 경로로 측정한다.

독립 QA는 위 접근을 연구 단계에서 조건부로 인정했다. serialized HTML/CSS 직접 주입 금지, 입력 IME/ACK·실제 이벤트 순서·label/focus/scroll 증명, 미지원 요소의 명시가 조건이다. 당시에는 구현 전 설계 검토였으며, 아래 구현 증거와 구분한다.

## 구현 후 관측과 남은 검증

DOM 수집·서버 재검증·스크립트 없는 브라우저 표/폼·원격 입력 왕복을 구현했다. 서버/공유 계약/기존 PNG/공유 artifact 회귀 94개, 독립 서버 53개가 통과했다. 독립 검토에서 원격 필수 입력 검증의 포커스가 브라우저에 반영되지 않는 결함을 발견했고, 실제 worker 브라우저 RED→수정→독립 8개 GREEN으로 보완했다. 포커스는 ACK 순서, 더 최신 로컬 입력/포커스, 조합 여부를 확인해 반영한다. 원래 editor source는 권한 회수 때도 보존하되 실행 DOM은 제거한다.

미리보기의 패딩을 viewport에 포함하던 32px 폭 불일치도 수정했다. 세 가지 서로 다른 React workspace를 데스크톱/모바일 폭에서 **각각 새로 실행**해 원격/브라우저 폭을 확인했다. 실행 중 창 크기 변경·회전은 아직 원격 viewport에 자동 반영되지 않는다. 이 결과를 모든 모바일 상태의 검증으로 확대하지 않는다.

로컬 실제 compiler→새 worker/Chromium→CDP→브라우저 DOM 경로에서 cold/update/input을 각각 20회 측정했다. p95는 각각 1907.2/128.8/117.8ms였다. 신뢰 앱·패키지는 warm 상태이고, localhost 측정이므로 운영 Docker/TLS/사용자 네트워크의 G3 증거로 사용하지 않는다. 1500노드 합성 snapshot의 UI 초기 반영 57.4ms, update20 p95 26.5ms, parent long task 0을 관측하고 1501노드 거부를 확인했다. 이는 worker 생성 비용을 포함한 최대 크기 성능 증거가 아니다.

구현 상한은 노드1500·깊이40·텍스트120KB·스냅샷480KB·스타일90속성이다. 실제 3열 표는 10행103,956B, 20행190,726B, 50행451,039B였고 100행은 한도 초과로 정적 이미지 안내로 전환했다. 이미지 안내는 읽기 전용이며 네이티브 모드 완료로 간주하지 않는다.

현재 표/폼/필터와 정해진 요소 스크롤을 대상으로 한다. canvas/SVG/shadow DOM/포털, password/file 입력 및 지원하지 않는 스타일은 명시적 이미지 안내 대상이다. 임의 keydown·hover·window 스크롤 동작의 완전 복제는 보장하지 않는다. 실제 OS 한글 입력기, VoiceOver/NVDA, 새 이미지의 Docker 격리 및 운영 성능 검증이 남았다. 로컬 브라우저 증거만으로 E4/G3 점수를 올리지 않는다.

2026-09-24 통합 회귀: Workbench 92파일 925/925(skip 0), Playwright 69/69를 확인했다. 모델은 fixture인 통합 회귀이며 실제 사용자 OAuth 완료나 고정 모델 평가 통과를 뜻하지 않는다. 전체 회귀 중 발견한 사본 동시 가져오기 오류는 트랜잭션 문서 읽기를 `getAll`로 묶어 수정했다. 독립 단독 33/33(동시 등록 20회 포함)에서 단일 불변 버전·실제 SQL·원본 불변과 최신 버전 보존을 확인했다. 테스트 실행별 tenant도 분리해 병렬 실행 간 자료 삭제 간섭을 제거했다.
