# S11 사전 번들·성공 확인 후 미리보기 교체

## 토스 원문과 공개 소스 검토
[Toss TOI 원문](https://toss.tech/article/52885)의 정책/화면 분리, 미리 준비한 패키지 조합, 전체 문서 교체를 적용한다. TOI 자체 저장소를 확보했다고 주장하지 않는다. 공개된 글의 코드 예시와 아래 OSS 원문을 직접 읽었다.

- [ToolJet controller](https://github.com/ToolJet/ToolJet/blob/39ddfe5572cdda66e00497365a20d948e138af07/server/src/modules/data-queries/controller.ts): 쿼리 실행 전에 사용자·앱·자료 소스 권한 가드를 적용한다.
- [ToolJet service](https://github.com/ToolJet/ToolJet/blob/develop/server/src/modules/data-queries/service.ts): 편집 실행과 보기 실행을 구분하고 보기 모드에서 설정을 덮어쓰지 않는다.
- [Appsmith NewActionServiceCEImpl](https://github.com/appsmithorg/appsmith/blob/release/app/server/appsmith-server/src/main/java/com/appsmith/server/newactions/base/NewActionServiceCEImpl.java): action 검증·저장과 읽기/편집/실행 권한을 분리한다. Java Reactor 기반 서버 구현이다.

라이선스 소스를 복사하지 않고 데이터 경로·권한 분리 패턴을 참고했다. ToolJet 서버는 NestJS/TypeScript, Appsmith 서버는 Java이며 MYSCube 기존 Express BFF를 교체할 필요는 없다.

## 구현 경계
MYSCube는 등록 위젯 구성으로 앱 진입 코드를 생성한다. 임의 React 소스 편집·임의 npm 설치 도구는 아니다. 따라서 브라우저에서 매번 JSX 전체를 컴파일하거나 의존성 그래프를 설치할 필요가 없다.

1. Vite 빌드 시 esbuild로 React·ReactDOM·미리보기 렌더러를 단일 IIFE 패키지로 준비한다. 같은 React 인스턴스를 사용한다.
2. lockfile와 최종 번들의 SHA-256으로 패키지 조합을 식별한다. 해시 파일명 Vite 청크를 지연 로딩하고 모듈 캐시를 재사용한다.
3. 검증된 화면 구성과 현재 권한으로 읽은 자료로 앱 진입 코드와 HTML을 만든다. 데이터는 JSON을 script-safe escaping한 값이며 코드를 실행하는 입력으로 해석하지 않는다.
4. `sandbox="allow-scripts"`인 별도 opaque-origin iframe에서 실행한다. CSP는 네트워크·폼·이미지·외부 스크립트를 차단한다. 인증 토큰은 프레임으로 보내지 않는다.
5. React layout commit 후 준비 완료를 보낸다. 화면 밖 iframe의 rAF가 지연되는 문제를 피하기 위해 부모에서 두 번의 animation frame 후 교체한다. 부모가 origin=null, 실제 contentWindow, nonce를 모두 검증한다.
6. 최신 pending 후보만 commit한다. 실패 후보가 뒤늦게 ready를 보내도 반영하지 않는다. 마지막 정상 프레임을 최대 두 개 유지하고 실행 오류가 난 프레임은 복원 후보에서도 제외한다.
7. 새 프레임에서는 React 상태·DOM·전역 상태가 새로 시작한다. 실무 업무 초안은 이 런타임 밖에 있다.

## 성능과 한계
화면 표시의 수치는 package fetch/parse + iframe 생성 + React commit + visible update 구간이다. 자료 조회는 따로 표시한다. 페이지 탐색·사용자 편집 시간을 포함한 값과 혼동하지 않는다.

운영과 같은 Vite production build를 격리 인증 하네스로 실행하고 cold/warm, 데스크톱, 390px·CPU4배 지연·120ms/1Mbps 조건을 측정한다. 실제 운영 네트워크·로그인·50개 사업 조회 지연을 이 수치로 대표하지 않는다. 토스의 1.3초를 성과로 차용하지 않는다. 표본/분위수/실패는 구현 상태 문서에 기록한다.

무한 루프를 포함한 임의 코드를 받지 않는다. 브라우저/기기 상황에 따른 프레임 실패는 8초 후 오류 안내로 전환한다. 렌더 완료 이후의 미래 오류가 없음을 보장하지 않으며 후속 오류도 오버레이로 표시한다.
