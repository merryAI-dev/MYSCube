# S23 — 브라우저 작업 공간·미리보기 실제 소스 조사

조사일: 2026-09-24. 범위는 읽기 전용 소스 조사와 설계 제안이다. 세 저장소를 `/tmp`에 shallow clone해 관련 실행 경로를 읽었으며, 의존성 설치·외부 코드 실행·서비스 설정 변경은 하지 않았다. 아래 내용은 전체 저장소 보안 감사 또는 실제 MYSCube 도입 성능 검증을 의미하지 않는다.

## 판단

MYSCube에는 Bolt 전체나 Sandpack 기본 실행기를 그대로 붙이기보다 **서버의 불변 소스 버전·API 권한 경계를 유지하면서 파일 편집 모델, 패키지 사전 준비, 미리보기 교체 프로토콜을 분리해 적용**하는 편이 맞다. 브라우저 DOM 실행은 자연스러운 입력·텍스트 선택·접근성을 회복하지만, 현재 원격 컨테이너의 CPU·메모리 제한과 동등하지 않다. 따라서 PNG 경로를 없애는 조건은 단순히 React가 한 번 렌더링되는 것이 아니다.

## 확인한 버전과 라이선스

GitHub API에서 조회한 시점의 별 수이며 채택 근거를 대신하지 않는다. 로컬 clone HEAD도 아래 SHA와 일치했다.

| 저장소 | 고정 SHA | 별 | 라이선스 | 읽은 범위 |
| --- | --- | ---: | --- | --- |
| [stackblitz-labs/bolt.diy](https://github.com/stackblitz-labs/bolt.diy/tree/2e254ac19a696394030601bc602f54945b12bfc4) | `2e254ac19a696394030601bc602f54945b12bfc4` | 19,903 | MIT | WebContainer 부팅, 파일 상태/수정, diff, action runner, preview store/iframe |
| [codesandbox/sandpack](https://github.com/codesandbox/sandpack/tree/7d60a4334980eef304d53b1c3df371ed6dbcf491) | `7d60a4334980eef304d53b1c3df371ed6dbcf491` | 6,244 | Apache-2.0 | React 파일 상태, client lifecycle, compile 메시지, iframe/file resolver 프로토콜, 공식 bundler 문서 |
| [codesandbox/sandpack-bundler](https://github.com/codesandbox/sandpack-bundler/tree/a323f46fd38442bb2dbc76fecd262e1435aca5bd) | `a323f46fd38442bb2dbc76fecd262e1435aca5bd` | 93 | Apache-2.0 | 별도 실험적 bundler의 compile/evaluate, dependency manifest, 메모리 캐시, CDN/추가 파일 경로 |

세 저장소 모두 조회 시 archived=false였다. Sandpack의 별도 bundler는 toolkit의 기본 런타임과 동일하다고 가정하지 않았다. README도 기존 bundler를 대체하려는 별도 구현으로 설명한다. [별도 bundler README](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/README.md)

## 1. Bolt: 작업 공간을 실제 파일로 바꾸는 경로

`WebContainer.boot`를 한 번 실행해 파일 시스템·프로세스 환경을 만들고, dev server의 `server-ready`/`port` 이벤트를 iframe URL로 연결한다. 부팅 옵션은 `coep: credentialless`, preview 오류 전달을 활성화한다. 이 경로는 브라우저 안의 개발 서버이지, 생성한 HTML 문서를 성공 시에만 교체하는 TOI의 트랜잭션과 같지 않다. [부팅](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/webcontainer/index.ts#L17-L59), [서버/포트 이벤트](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/stores/previews.ts#L169-L208)

파일 편집의 흐름은 `FileMap → fs.writeFile → FileMap 즉시 갱신`이다. 최초 수정 전 내용을 `modifiedFiles`에 보관하고, 모델에 보낼 변경분은 unified diff와 파일 전체 중 짧은 것을 고른다. 여기서 가져올 원칙은 **원본 파일이 기준이고 diff는 전달 최적화**라는 점이다. MYSCube에서는 서버에 저장한 전체 소스·버전을 기준으로 삼고, 모델의 diff를 그대로 최신 원본으로 취급하지 않아야 한다. [파일 저장](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/stores/files.ts#L550-L588), [diff 선택](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/utils/diff.ts#L17-L75)

Action runner는 파일·shell 등의 실행을 직렬 promise에 연결한다. 따라서 부분 생성 중 파일 반영 순서를 다루는 참고가 되지만, shell 실행 능력까지 실무 데이터 조회 화면에 도입할 이유는 없다. 검토한 파일 action의 write 실패는 catch/log되는 경로도 있어, 이 코드를 그대로 승인·저장 성공 판정에 재사용하면 안 된다. [action 실행](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/action-runner.ts#L120-L165), [파일 action](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/runtime/action-runner.ts#L311-L369)

기본 Preview는 `allow-same-origin`, forms/popups/modals/storage 등의 넓은 sandbox 허용을 쓰며, preview store에는 localStorage 동기화도 있다. 이는 범용 앱 제작기의 선택이다. Firebase 인증이 있는 MYSCube shell에 그대로 복사할 정책이 아니다. [iframe 설정](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/components/workbench/Preview.tsx#L981-L1007), [storage 동기화](https://github.com/stackblitz-labs/bolt.diy/blob/2e254ac19a696394030601bc602f54945b12bfc4/app/lib/stores/previews.ts#L37-L72)

## 2. Sandpack: 편집 상태와 실행 프로토콜의 분리

React `useFiles`는 현재 파일·선택 탭을 관리하고 원래 props의 스냅샷으로 reset한다. 서버 저장 버전·작성자·충돌 검사는 이 훅의 책임이 아니다. `updateSandbox`는 파일을 모듈 맵으로 변환하고 `compile` 메시지에 의존성·entry·옵션을 함께 보낸다. 우리도 편집기 탭, 서버 revision, 실행 artifact를 서로 다른 상태로 유지해야 한다. [파일 상태](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-react/src/contexts/utils/useFiles.ts#L53-L121), [compile 메시지](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-client/src/clients/runtime/index.ts#L316-L396)

iframe protocol은 frame window, channel ID, `codesandbox` 표시로 메시지를 구분하고, file resolver는 메시지 ID별 요청/응답을 연결한다. 하지만 읽은 수신 함수는 `event.source`를 확인하며 명시적 `event.origin` 비교는 없고, channel ID 자체는 권한 검증이 아니다. 따라서 이 형태를 API 인증으로 오해하지 않는다. 우리 중계는 서버 권한 검사와 고정 API 버전, 메시지 스키마·크기·빈도 제한을 추가해야 한다. [iframe protocol](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-client/src/clients/runtime/iframe-protocol.ts#L19-L73), [수신 필터](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-client/src/clients/runtime/iframe-protocol.ts#L111-L132), [파일 resolver](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-client/src/clients/runtime/file-resolver-protocol.ts)

Client는 `start`, `done`, `show-error`로 상태를 갱신한다. 기본 sandbox도 same-origin/forms/popups/downloads 등을 허용한다. 이 오류 UI와 통신 라이프사이클은 참고할 수 있지만, 업무 데이터 안전성이나 마지막 정상 문서 보존을 자동 보장하지는 않는다. [runtime 상태와 기본 권한](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-client/src/clients/runtime/index.ts#L81-L154), [React 오류 상태](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/sandpack-react/src/contexts/utils/useClient.ts#L381-L416)

별도 experimental bundler를 보면 차이가 더 분명하다. compile 성공을 알린 뒤 HTML을 교체하고 evaluate한다. compile 실패 후에도 `replaceHTML` 호출 경로가 있고, HMR이 없으면 `location.reload()`를 한다. 따라서 **이 소스는 TOI식 last-good commit 구현의 근거가 아니다.** [compile/replace/evaluate 순서](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/src/index.ts#L158-L220), [HMR/reload](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/src/bundler/bundler.ts#L273-L323)

## 3. 패키지 캐시: 실제로 준비하는 대상과 무효화 기준

별도 bundler는 정렬된 dependency manifest를 요청하고 패키지를 병렬 preload하며, name/version별 진행 중 다운로드를 합친다. 패키지 내용은 module map에 남긴다. 추가 파일은 unpkg 요청과 별도 메모리 캐시를 사용한다. **읽은 소스의 이 캐시를 브라우저 영구 캐시나 완전한 lockfile 무결성 보장이라고 부르지 않는다.** 특히 module map은 이름 기준이고 같은 이름 여러 버전을 허용하지 않는다는 주석이 있다. [manifest/preload/cache](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/src/bundler/module-registry/index.ts#L24-L66), [CDN 프로토콜](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/src/bundler/module-registry/module-cdn.ts#L7-L57), [추가 파일 캐시](https://github.com/codesandbox/sandpack-bundler/blob/a323f46fd38442bb2dbc76fecd262e1435aca5bd/src/FileSystem/layers/NodeModuleFSLayer.ts#L11-L51)

Sandpack의 공식 문서는 자체 bundler 호스팅과 private registry proxy를 설명한다. 그러나 브라우저 런타임·CDN·토큰 처리까지 새 운영 책임이 생긴다. 이 조사에서는 public CDN으로 실무 소스나 패키지 요청을 보내지 않았다. [호스팅 문서](https://github.com/codesandbox/sandpack/blob/7d60a4334980eef304d53b1c3df371ed6dbcf491/website/docs/src/pages/guides/hosting-the-bundler.mdx)

MYSCube의 현재 `react-compiler-packages.mjs`는 고정 React/ReactDOM public entries와 lockfile/runtime 버전으로 `packageSetHash`를 만들고, 한 번 만든 패키지 bundle promise를 공유한다. 유지할 기반이다. 확장 시에는 패키지를 임의 요청마다 설치하지 않고 **검토된 조합별 빌드 → 해시 경로의 불변 파일 → 클라이언트 HTTP 캐시**로 제공한다. 동일 조합의 React는 한 인스턴스여야 한다. 실패한 빌드·버전 불일치를 다른 조합으로 조용히 대체하지 않는다. [현재 패키지 구현](../../../server/workbench/react-compiler-packages.mjs)

esbuild의 공식 browser API는 wasm 초기화 후 비동기 build를 지원하고, plugin의 `onResolve`/`onLoad`로 가상 파일 시스템을 연결할 수 있다. 브라우저 compiler worker 종료는 빌드 작업을 제어하는 수단이며, 생성 React의 DOM 실행을 같은 방식으로 제한한다는 뜻은 아니다. [browser API](https://esbuild.github.io/api/#browser), [plugin API](https://esbuild.github.io/plugins/)

## 4. WebContainers 전면 도입 전에 확인할 비용과 제약

Bolt의 MIT와 WebContainer API의 사용 조건은 별개다. 공식 안내는 영리 기업의 고객·직원 대상 프로덕션 사용에 상업 라이선스가 필요하며, POC 예외를 둔다. 현재 비용 승인 없이 채택하면 안 된다. [공식 상업 사용 조건](https://webcontainers.io/enterprise)

WebContainers는 SharedArrayBuffer를 위해 COOP/COEP 구성이 필요하다. `credentialless` 대안도 별도 부팅 옵션과 헤더가 맞아야 한다. 인증 shell에 전역 헤더를 바꾸는 작업은 로그인·외부 리소스 회귀 범위이므로, 단순 컴포넌트 교체가 아니다. [공식 헤더 계약](https://webcontainers.io/guides/configuring-headers)

공식 browser-support 페이지 자체는 마지막 갱신을 2023년 2월로 표시한다. 그 페이지의 Safari/Firefox alpha/beta 설명을 2026년 현재 제품 호환성 수치로 확정하지 않았다. 채택 검토 시 실제 사용 브라우저·서드파티 쿠키 설정·모바일에서 다시 시험해야 한다. [공식 지원 문서와 갱신일](https://webcontainers.io/guides/browser-support)

## 5. PNG를 대체하는 선택지와 보장 차이

| 선택지 | 사용자 이점 | 유지 가능한 경계 | 남는 한계 / 판단 |
| --- | --- | --- | --- |
| 현재 원격 React + PNG 유지 | 실제 React를 서버 격리 공간에서 실행 | network none, 512MiB/1 CPU, TTL, 고정 API 중계 | 입력마다 왕복·이미지 처리; 텍스트 선택/스크린리더 제약. 현재 안전 기준선 |
| 검토된 bundle을 별도 브라우저 iframe에서 DOM 실행 | 기본 입력·선택·키보드·접근성, 매 조작의 이미지 왕복 제거 | 독립 backend와 사본 DB, 토큰 없는 frame, 서버 API 권한 검사는 유지 가능 | 임의 JS의 사용자 장치 CPU·메모리 상한은 Docker와 동일하게 보장 못 함. PNG와 동등한 격리라고 출시하면 안 됨 |
| 원격 격리 유지 + 제한된 DOM/접근성 전달 | 생성 JS를 사용자 브라우저에서 실행하지 않으면서 일부 자연스러운 조작 개선 가능 | 생성 코드의 컨테이너 경계 유지 가능 | DOM/CSS/URL/이벤트 정규화·증분 동기화라는 새 프로토콜 필요. 이 조사에서 동작·보안·성능 검증하지 않음 |
| Bolt/WebContainers 또는 Sandpack 전체 채택 | 범용 프로젝트/편집기 기능 | 별도 서비스 구성 가능 | 넓은 기본 권한, 패키지 공급망, 운영·라이선스/브라우저 제약. 당장 필요한 범위보다 큼 |

현재 경계 근거: `server/workbench/remote-runtime/contract.mjs`, `broker.mjs`, `workbench/RemoteReactPreview.tsx`. source/API 버전을 고정한 후보 실행 후 정상 PNG가 decode될 때 바꾸며, 권한 변경 시 기존 이미지도 숨긴다. DOM 경로에서도 이 계약을 유지해야 한다.

브라우저 Site Isolation은 사이트별 데이터·프로세스 경계를 개선하지만, 추가 프로세스의 메모리 비용과 프로세스 재사용 규칙도 있다. **별도 iframe = 요청별 cgroup quota**는 성립하지 않는다는 것이 이 설계의 판단이다. 별도 origin과 별도 site도 다르므로 `preview.myscguard.app`만 추가하고 업무 페이지와 완전히 독립된 renderer process라고 주장하지 않는다. [Chromium 설계](https://www.chromium.org/developers/design-documents/site-isolation/), [프로세스 모델](https://chromium.googlesource.com/chromium/src/+/5e87dfef0c85687ea/docs/process_model_and_site_isolation.md)

## 6. 적용할 최소 구조 — 설계안이며 구현 완료 아님

1. **파일 원본:** `{pageId, baseVersion, files, sourceHash, packageSetHash, apiBindings}`를 서버에서 검증·저장한다. 상대 import를 열려면 정규화된 가상 경로와 파일 수/총량 제한을 먼저 만든다. 현재 단일 `App.tsx` 계약을 확인 없이 다중 파일로 바꾸지 않는다. diff는 제안이며 baseVersion 충돌을 강제로 덮지 않는다.
2. **컴파일:** 검토된 패키지만 resolve하고 해시가 고정된 artifact를 만든다. 브라우저 worker와 서버 compiler 중 하나를 선택해도 저장/실행 식별값과 API 권한의 진실은 서버다. 사용자 제공 bundle을 신뢰해 실행하는 우회 경로는 만들지 않는다.
3. **DOM 후보 실행:** 별도 신뢰 수준의 실행 origin과 최소 iframe sandbox를 사용한다. 인증 shell의 storage나 Firebase token을 전달하지 않는다. 현재 원격 경로의 network none과 같은 보장을 브라우저 CSP만으로 선언하지 않는다. connect/image/font/form/navigation/download/websocket 등 유출 경로를 별도로 시험한다.
4. **API 중계:** 부모의 제한된 MessageChannel을 통해 등록된 API ID·version·입력만 전달한다. 서버는 각 호출의 현 권한·tenant·범위·timeout/size를 검사한다. opaque-origin frame이면 origin은 `null`이므로 그것만으로 인증하지 않고, 확인된 frame window와 새 채널의 possession·generation·sourceHash를 결합한다. 채널은 인증을 대신하지 않는다.
5. **화면 교체:** 현재 화면과 숨겨진 후보를 최대 하나씩 둔다. 신뢰하는 bootstrap의 준비 신호·artifact ID·첫 렌더 확인 후 교체한다. 늦게 온 이전 후보 메시지를 무시한다. 컴파일/첫 실행 실패는 기존 정상 화면과 오류 안내를 유지한다. 미래의 모든 이벤트 성공까지 증명하는 것은 아니다.
6. **저장·Git·실행 표시 분리:** 작성 중, 서버 저장 완료, 미리보기 실행 성공, Git PR 생성 완료를 각각 표시한다. `done` 메시지 하나로 전체 성공을 표시하지 않는다. Git에는 source/manifest만 전달하고 API 결과·사용자 데이터는 넣지 않는다.

현재 업무 시스템의 멈춤 방지를 동일 수준으로 유지해야 한다면, 임의 React를 브라우저로 옮기는 변경은 보류하고 원격 경계 안에서 패키지 준비·렌더 초기화·이벤트 왕복 시간을 줄인다. 브라우저 DOM 경로를 선택하려면 사용자 장치 격리 보장이 달라지는 점을 명시적으로 결정한 뒤, 독립 실행 사이트와 공격 회귀 검증을 갖춰야 한다.

## 7. 실제 채택 판정에 사용할 측정·QA

아래는 연구 후보의 목표/시험 설계이며 이번 조사에서 측정한 결과가 아니다. 최종 품질 채점은 `s23-quality-scorecard.md`의 고정 기준이 우선이며, 이 표를 근거로 그 기준을 낮추지 않는다. 토스의 1.3초나 Sandpack 문서의 오래된 벤치마크를 MYSCube 성능으로 인용하지 않는다.

| 항목 | 방법 | 잠정 합격 기준 |
| --- | --- | --- |
| 첫 화면 | cold/warm cache 각각 최소 30회, 동일 코드·브라우저·네트워크, artifact 요청부터 사용자 표시까지 | p50/p95와 캐시 다운로드 bytes를 함께 보고. warm p95 1.3초 이내를 우선 목표로 삼되 실제 baseline 비교 후 확정 |
| 입력 반응 | 입력/드롭다운/표 필터/스크롤 각각 30회, API 없는 조작과 API 포함 조작 분리 | DOM 자체 입력 p95 100ms 이내 목표, API 시간은 별도 표시 |
| 정상 화면 유지 | 문법 오류/초기 throw/비동기 throw/늦은 응답/후보 취소 | 초기 실패 때 이전 화면 유지; 오류 상태에서 새 저장·PR 성공으로 오인하지 않음 |
| 데이터·권한 | API ID 변조/버전 변경/다른 tenant/권한 회수/출력 overflow | 서버 거부, 이전 민감 화면 제거, 임의 URL 중계 없음 |
| 장치·업무 격리 | 무한 루프/메모리 폭주/메시지 flood/외부 전송/상위창 이동, 별도 업무 canary 병행 | 경계별 실패를 구분. 브라우저 경로에서 hard quota 미보장은 해결됐다고 표시하지 않음 |
| 버전 일관성 | 두 탭 동시 저장/오래된 baseVersion/저장 응답 유실/PR 재시도 | 같은 revision의 파일·패키지·API 버전 일치, 충돌 안내·중복 생성 없음 |
| 접근성·호환성 | 실제 Chrome/Safari/Firefox 및 모바일, 키보드·스크린리더·선택/복사 | 지원 범위를 실측하고 PNG fallback 이유를 사용자에게 설명 |

문서 QA는 고정 SHA와 해당 소스 경로의 존재, 직접 읽은 사실과 설계 추론의 구분, 라이선스·성능·격리 보장의 과장 여부를 점검한다. 이번 작업은 코드/배포 변경이 없어 실제 사용자 브라우저 회귀 실행은 하지 않았다. 실행 방식 변경 시 위 검증을 별도 구현 gate로 수행한다.
