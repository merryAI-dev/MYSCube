# S18 운영 준비 점검 — 2026-09-23

판정: **로컬 기능 검증 통과, 운영 전 구현·연결·검증 작업이 남음**. 단순히 키를 설정하고 배포할 단계가 아니다. 이번 점검은 코드, GitHub 실제 API/배포 기록, 독립 QA 재실행을 근거로 했다. 제품 코드·운영 데이터·시크릿·배포 설정을 변경하지 않았다.

## 1. 운영을 막는 항목

| 우선순위 | 현재 확인한 상태 | 필요한 작업 | 완료 증거 |
|---|---|---|---|
| P0 실행 격리 | iframe의 외부 script/fetch 등은 차단되지만 자체 navigation은 첫 요청을 보낸 뒤 채널을 닫음. CPU·전체 메모리 강제 제한 없음 | 생성 코드를 실행할 환경에서 외부 송신 차단, CPU/RSS 제한, 강제 종료·복구 구현. 별도 도메인과 설정 플래그만으로 완료 처리 금지 | 외부 수신점에 요청이 도달하지 않음, 무한 루프·메모리 폭주 종료, 기존 업무와 다른 사용자 요청 정상 유지 |
| P0 Git 공개 범위 | 실제 대상 `merryAI-dev/MYSCube`는 **public**. 전달기는 조회 응답을 별도로 첨부하지 않지만 소스 안의 실제 이름·금액까지 완전히 탐지하지 못함 | 테스트는 합성 자료로 유지. 운영 코드는 승인된 비공개 저장소 또는 명시적인 공개 가능 소스 정책으로 제한. 공개 대상 자동 전달 차단 필요 | 실데이터가 포함된 소스가 공개 저장소로 전송되지 않는 테스트 및 원격 저장소 설정 확인 |
| P0 운영 배포 기반 | Workbench 서버/런너 전용 Dockerfile·배포 workflow가 현재 저장소에 없음. 기존 Vercel 배포는 관련 디렉터리를 제외함 | 독립 서비스·DB·모델·런너의 배포 산출물, 서비스 계정, 네트워크/자원 설정, 상태 점검·되돌리기 경로 구성 | 실제 배포 SHA, 별도 자원·IAM, 인증·건강 상태, 장애 주입 중 기존 서비스 정상 증거 |
| P1 권한·자료 공급 | 운영 권한 갱신 producer가 없음. 권한 사본은 5분 후 거부; demo 모드만 자동 갱신. 분석 자료는 로컬 JSON importer가 있으나 운영 사본/로그 공급 연결은 미확인 | 기존 결재·정산 처리와 분리된 권한 및 읽기 전용 자료 공급 작업. 갱신 주기·철회 지연·누락·재처리·관측 연결 | 실제 사본의 원본 버전/수집 시각, 권한 철회·갱신 중단 시 거부, 복구 후 정상 조회. Sheet 사본도 고정 좌표 계약 유지 |
| P1 인증·키·할당량 | 전용 키 존재만 코드에서 검사. 실제 키의 소속 프로젝트·할당량 분리는 검증 안 됨. Git은 개발자 gh 인증으로만 실증 | 전용 최소권한 credential 연결·회전 및 실제 Firebase 로그인 검증. 인증 철회 정책 확정 | 서버 계정이 운영 DB/JVM에 접근 불가, 모델 quota 분리, 로그인/계정 전환/철회·만료 검증 |
| P1 CI 누락 | 통합 테스트 job은 루트 `npm ci`만 실행. Workbench 전용 의존성은 별도 lockfile에만 있음. Workbench 타입/빌드·브라우저 검증도 CI 명령에 없음 | 통합 job의 전용 의존성 설치 또는 독립 job 분리. 실제 Chromium·Workbench 타입 검사·빌드 게이트 추가 | 깨끗한 runner에서 Workbench 의존성 설치 및 필수 검사 통과. 기존 업무 배포와 의존성 분리 |

근거:

- 실행: `server/workbench/react-compiler-runtime.mjs:10`, `workbench/ReactPreview.tsx:73`, `:82`, `server/workbench/react-runtime-config.mjs:13`. VERIFIED 플래그는 검증 결과를 선언할 뿐 격리를 구현하지 않는다.
- Git 공개 여부: GitHub `GET /repos/merryAI-dev/MYSCube`에서 `visibility=public` 직접 확인. `server/workbench/git-delivery.mjs:20`의 검사는 알려진 credential 패턴 검사다. 이번 PR #816/#817에는 업무 데이터 없는 테스트 소스를 사용했다.
- 권한: `server/workbench/core.mjs:19`, `server/workbench/server.mjs:22`. 기존 snapshot read 경로는 자료가 없거나 24시간 이상 오래되면 거부한다(`snapshot-reader.mjs:11`). `analytics-import.mjs:25`는 로컬 사본만 읽고 Sheets를 직접 호출하지 않음을 명시한다.
- 인증: `server/workbench/server.mjs:38`은 `verifyIdToken(token)`을 호출한다. 토큰 철회 확인 옵션은 없으므로 Firebase 계정 비활성화/토큰 철회 즉시 차단이 필요하면 검증 옵션 또는 즉시 권한 철회 연결을 보완해야 한다.
- 모델: `runtime-config.mjs:9`의 프로젝트 이름 비교는 API 키의 실제 소속 프로젝트를 검증하지 않는다. SDK 호출은 `html-completion.mjs:6`에서 키를 사용한다.
- CI: `.github/workflows/ci.yml:68`과 `vitest.bff-integration.config.ts:7`은 모든 server 통합 테스트를 실행한다. 루트 lockfile에는 `@duckdb/node-api`, `tldts`가 없으며 전용 lockfile에만 있다. 현재 worktree 상태가 CI에 올라간 경우의 누락이고, 이미 관측한 원격 실패 원인이라고 주장하지 않는다. 루트 tsconfig는 workbench를 포함하지 않는다.

## 2. 기능·복구·품질에서 남은 작업

| 항목 | 구분 | 조치와 검증 기준 |
|---|---|---|
| 지정 외부 HTTP API | **구현 필요** | 현재 kind는 `analytics-copy`뿐이다. 주소·인증 방식 수령 후 목적지 허용 목록, 서버 전용 인증 참조, 요청·응답 스키마, redirect/DNS 검증, 시간·용량 제한, 권한 재검증·호출 기록을 갖는 어댑터가 필요하다. 단순 설정만 남은 기능이 아니다. |
| 멈춘 요청과 저장 재시도 | **구현 필요** | `workbench/client.ts:18` fetch에 기한이 없고 호출마다 새 요청 키를 만든다. 연결이 멈추면 `ReactStudio.tsx:49`의 busy가 지속될 수 있다. 유한 기한·작성 내용 유지·저장 결과 조회·동일 작업 키 재사용을 함께 구현한다. 응답 유실 뒤 새 POST로 중복 페이지를 만들지 않는 브라우저 검증이 필요하다. |
| Git 느린 응답·복구 | **구현/실환경 검증** | 요청별 12초 제한은 있으나 전체 전달 기한은 없다. 실제 배포 프록시 제한과 느린 GitHub/응답 유실을 검증한다. 같은 버전 재시도는 구현됐지만 자동 재시도 worker는 없다. 완료 영수증은 과거 성공 기록이며 이후 PR 닫힘·병합 상태를 실시간 갱신하지 않는다. |
| React의 모호한 요청·대화 연결 | **구현 보완 필요** | 기존 분석 대화에는 재질문 경로가 있지만 React 생성은 현재 소스를 전달하고 `render_react_source` 코드 제안만 처리한다. React의 명시적인 재질문 결과·답변 대기·후속 답변 상태를 연결해야 한다. 분석 질문과 React 화면 수정을 오가는 하나의 대화 흐름까지 완료했다고 볼 수 없다. |
| 실제 AI 생성 품질 | **실환경 검증 필요** | 현재 생성 경로는 fixture 응답으로 검증했다. 실제 모델로 첫 생성, 현재 소스를 기반으로 한 연속 수정, 기존 분석 대화의 모호한 질문→재질문, 등록 API 호출, 오류 복구·코드 검토를 평가해야 한다. 숫자와 근거 일치·미확인 값 보존을 합격 기준으로 삼는다. React 재질문은 위 구현 이후 평가한다. |
| 렌더링 속도 | **계측/검증 필요** | 현재 durationMs는 후보 준비 구간이며 모델·컴파일·최초 페인트 전체 시간이 아니다. 차가운/따뜻한 캐시와 모바일에서 생성·컴파일·패키지 준비·실제 최초 표시를 분리 측정하고 p50/p95를 기록한다. 1.3초 달성은 아직 주장할 수 없다. |
| 사용량·성과 추적 | **계측 보완 필요** | HTML 생성은 토큰 사용량을 기록하지만 React/대화 route는 onUsage를 전달하지 않는다. 실제 비용, 모델별 생성 성공률·수정 횟수·전체 지연을 동일 기준으로 기록해야 한다. |
| Git 리뷰·재현 | **운영 정책/후속 보완** | main에 필수 PR 리뷰는 설정되어 있지 않다(조회 시점). 생성물 manifest에는 API ID/버전·패키지 해시가 있으나 API 정의와 lockfile 전체가 없어 Git만으로 독립 재현하는 패키지는 아니다. 코드 리뷰 의무화와 재현 범위를 운영 전에 결정한다. |

실제 로그 QA도 독립 DB의 로그 사본 공급이 있어야 작동한다. `server/bff/qa-evidence.mjs:35`/`:55`는 주입된 DB의 `client_error_events`와 `reliability_operations`를 읽는다. GitHub 코드 조회가 된다는 사실만으로 운영 오류 분석 전체 연결이 끝난 것은 아니다.

## 3. 이번에 다시 확인한 증거

- 독립 QA 재실행: runtime-config 10 + isolation-boundary 16 = **26/26**, 실제 Chromium **7/7** 통과. 늦은 응답의 근거 오염, 실패 후보의 이전 정상 화면 보존, API 채널 격리를 포함한다. 이전 단계의 전체 305/305와 Playwright 13/13을 이번에 모두 재실행한 것은 아니다.
- GitHub 실제 조회: [PR #817](https://github.com/merryAI-dev/MYSCube/pull/817)은 OPEN·Draft이고 테스트 소스 커밋은 `9f0595db67de1486bc596755e9f2af3c7ad1819d`. 해당 테스트 PR CI는 성공했다. 플랫폼 구현 전체는 아직 worktree의 미커밋 변경이므로 이 CI를 전체 구현의 통과 증거로 쓰지 않는다.
- 로컬 환경변수/`.env*`를 값 노출 없이 이름만 점검했으며 전용 운영 설정을 확인하지 못했다. 저장소 Secret metadata에서도 Workbench 관련 설정을 확인하지 못했다. **외부 Secret Manager에 없다는 뜻은 아니다.**
- `gcloud projects list`는 재인증 필요 오류로 실패했다. 운영 프로젝트·시크릿·Cloud Run 리소스 조회는 재인증 후 남은 점검이다. 비밀값을 조회하거나 새 비용·권한을 활성화하지 않았다.
- 지정된 QA/Understand-Anything skill 경로와 지식 그래프를 현재 환경에서 찾지 못했다. 독립 QA 및 파일·호출 경로/실행 증거 점검으로 대체했고, 해당 도구를 사용했다고 보고하지 않는다.

## 4. 기존 운영 배포 기록 — 별도 확인 필요

조회한 main SHA `714d7b16883fa7de5790c0c4497028ee0fc0a7dc`의 [Production Deploy](https://github.com/merryAI-dev/MYSCube/actions/runs/35717724990)는 `Verify Workbench isolation before alias`에서 **Workbench read failed: 400**, 이후 `Reconcile canonical alias or roll back` 단계도 실패했다. [JVM 배포](https://github.com/merryAI-dev/MYSCube/actions/runs/35717724936)는 `Verify cashflow settlement split-release boundary`에서 실패했다.

이는 2026-09-22의 기존 배포 기록으로, 이번 미배포 S18 코드의 결과가 아니다. 실제 현재 alias·배포 SHA·서비스 건강 상태까지 확인한 것이 아니므로 현재 서비스 중단이라고 단정하지 않는다. 다음 배포 전에 기존 실패와 canonical alias 상태를 별도로 확인해야 한다. 주정산·월결산·JVM 코드를 이 점검에서 수정하지 않았다.

## 5. 권장 진행 순서

1. 실행 격리 방식과 운영 Git 공개 범위를 먼저 확정한다. 공개 저장소에는 합성 테스트 코드만 유지한다.
2. 독립 배포 산출물·CI, 요청 기한·안전한 저장 재시도, 전체 Git 기한을 구현한다.
3. 전용 인증·모델·Git credential, 권한/자료/로그 공급을 연결한다. 실제 키와 IAM의 권한·프로젝트·할당량을 확인한다.
4. 합성 자료로 실제 모델 연속 대화·React·Git 흐름을 검증하고, 승인된 사본에 대해 값/권한/자료 최신성을 대조한다.
5. 자원 폭주·외부 송신·권한 철회·느린 API·응답 유실·공급 중단 장애 주입과 실제 표시 속도를 측정한다.
6. 독립 QA 통과 후 main CI에 연결된 별도 배포로 진행한다. 플래그만 켜서 운영 활성화를 우회하지 않는다.
