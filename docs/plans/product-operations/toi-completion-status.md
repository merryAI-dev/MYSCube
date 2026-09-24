# TOI 제작 공간 — 현재 완료 상태

2026-09-24 기준. 핵심 제작 기능과 독립 환경 검증에 이어, 승인된 운영 프로젝트·VM·모델·DNS·권한/로그 복사 작업을 실제 구성했다. **앱 설치·활성화, 외부 HTTPS health 200·TLS 검증·미인증 API 401·로그인 화면 표시를 확인했다. 실제 SSO 로그인과 업무 사용자 흐름은 아직 남아 있어 전체 운영 완료 상태는 아니다.** 상세 운영 증거는 [S22](s22-independent-operations-setup.md), 기존 구현 경로는 [S19](s19-completion-loop.md)를 따른다. S12~S21의 기록은 각 검증 당시 상태다.

| 사용자 흐름 | 구현·실제로 확인한 범위 | 남은 확인·연결 |
|---|---|---|
| 지속 대화·자료 질의 | 문맥 저장, 재질문, 근거 조회, React 제안 적용, 늦은 응답의 덮어쓰기 방지. 실제 전용 Gemini 3.6 Flash의 구조화 응답 확인 | 실제 로그인 사용자의 연속 대화, 업무 답변 정확도·생성 품질 |
| HTML·Tailwind 제작 | 생성·편집·마지막 정상 미리보기 유지, 불변 버전 저장·복원, 응답 유실 복구 | 실제 운영 모델이 생성한 화면의 사용자 검증 |
| React 실행 | 전용 운영 VM에서 Chromium 격리·React 클릭·네트워크 차단·공격 중 정상 세션·정리/재시작 검사 통과 | 인증된 앱 경로에서의 생성→실행, 실제 사용 부하·지연 분포 |
| 사용자 API 등록 | 사본 조회와 승인된 외부 엔드포인트의 버전 등록·입력 검증·권한 회수·읽기 호출 | 실제 외부 API 주소·인증·응답 스키마 |
| 권한·로그 사본 | 별도 계정의 실제 Cloud Run Job 2회 성공. 관리자 29명 ACTIVE 반영, client error 페이지 복사, reliability 원본 0건. 2분 Scheduler 생성·활성 및 첫 예약 실행 성공 | 지속 신선도·실패 감시. 과거 client error는 `hasMore=true`로 전량 수집 미완료 |
| 운영 기록 | 과거 사본 집계, 내보낸 HTTP 기록의 원자적 가져오기·별도 집계, 실패 당시 SHA 후보 대조 | 실제 로그인 화면에서 사본 대조, HTTP 자동 공급·전체 요청 오류율·감소 추이 |
| Sheets 입금 질의 | 승인 대상의 고정 범위 GET→좌표 계약→독립 사본→집계. 빈칸·0원·실패 구분 | 실제 승인 시트와 읽기 권한·공급 스케줄. 현재 복사 Job은 시트나 `workbench_snapshots`를 공급하지 않음 |
| Git 커밋·PR | 불변 React source-only 커밋·Draft PR, 영수증·중복 방지. 실제 공개 합성 테스트 PR817 확인 | 운영용 비공개 저장소·전용 GitHub App |
| 저장 복구 | HTML·React·API 응답 유실 복구, 현재 허용된 원래 버전의 명시적 불러오기, 권한 재확인·늦은 응답 차단 | 실제 로그인 사용자 흐름 검증. 현재 권한으로 읽을 수 없거나 저장을 증명할 수 없는 요청은 운영 지원 필요 |
| 배포·로그인 | 운영 후보 이미지 쌍 게시·비공개 버킷 보관/읽기, Node/Docker/nginx 설치, DNS·TLS 인증서 발급, Firebase 허용 도메인·조회 권한 설정 | Google popup 로그인·UID 권한 일치·로그아웃·회수 확인 |

## 현재 운영 후보와 실행 증거

- 운영 후보 소스는 `0dc6fe797713043a7bdb747b6a2eb9da14da082c`다. 해당 [Workbench CI](https://github.com/merryAI-dev/MYSCube/actions/runs/35955972729)와 [기존 서비스 CI](https://github.com/merryAI-dev/MYSCube/actions/runs/35955972726)가 모두 성공했다. 기존 CI 통과를 실제 사용자 수용 시험으로 대신하지 않는다.
- 앱 registry digest는 `sha256:0d78218589b12515f4ead5abb0fd777fc970c4d714a6b606122998fa12e4b4f4`, renderer는 `sha256:460a81a5eb0411fc4d914d358f58b3d1829916b28f65f6424f34d12b9f5d9712`다. manifest SHA256은 `d1cc53943ba8b5d92b2f590fbe19107a7c5d013d73257a7b45dd277b5d1a6411`이며, 두 archive와 manifest 총 3개 파일을 비공개 릴리스 버킷에 보관하고 읽기를 확인했다. registry digest와 Docker image ID를 혼용하지 않는다.
- 실제 운영 VM에 공식 서명·SHA256을 확인한 Node **24.21.0**, Docker **29.8.1**, nginx **1.22.1**을 설치했다. 설치기의 nginx 경로 두 곳 수정은 `dd571d82a430ca664cb625540b477f1b50e9cc78`에 별도로 기록했다. 자신이 만든 부분 설정과 정확히 일치하는 경우에만 재시도하도록 보완하고 독립 QA를 통과했다. 이 후속 수정의 앱 활성화, loopback health·미인증 API 401·로컬 TLS가 실제 통과했다. app/nginx/reaper는 active이며 앱은 localhost:8791에서 동작한다.
- 실제 호스트 renderer 검사 `/tmp/myscube-actual-host-renderer-qa.json`은 PASS다. 첫 화면 **2,893ms**, 다음 세션 첫 화면 **1,468ms**는 각각 한 번 측정한 값이며 SLO가 아니다. 이 검사는 합성 코드로 수행했고 업무 DB·인증·모델 연결을 검증하지 않았다. 실제 커널 OOM은 관측하지 않았다.
- 전용 Gemini 3.6 Flash의 구조화 응답 probe는 **2,030ms**였다. 업무 자료를 전달하지 않은 단일 호출이며 답변 정확도·실제 대화 성능을 보장하지 않는다.
- [DNS plan](https://github.com/merryAI-dev/MYSCube/actions/runs/35956009713), [DNS apply](https://github.com/merryAI-dev/MYSCube/actions/runs/35956231752)가 성공했다. `axr.myscguard.app`은 `34.64.247.190`을 가리키며 Let's Encrypt 인증서를 발급했다(2026-12-23 만료). 외부 HTTPS health 200·TLS 검증 성공·미인증 API 401을 확인했다. 실제 브라우저 로그인 페이지도 HTTP 200, 오류 없이 표시됐다(`/tmp/myscube-axr-live-login.png`). 이는 Google 계정 SSO 성공의 증거는 아니다.
- 별도 복사 계정으로 Job execution 접미어 `dggtc`, `x5fsq`가 성공했다. 대상 권한·로그 marker를 확인했고 Scheduler를 `*/2 * * * *` UTC로 활성화했다. 첫 예약 execution `axr-copy-worker-nfjlb`가 2026-09-24 07:04:13Z에 성공했고 구조화 로그 `status=complete`를 확인했다. `grants={}`이므로 분석 dataset 권한을 임의로 부여하지 않았다.

## 이전 검증과 현재 상태의 구분

- [S21](s21-release-pair-verification.md)의 합성 이미지 저장·복원, 실제 HTTP·Firestore·SQL·브라우저 검사는 당시 증거로 유지한다. 당시 fixture 모델 검증과 이번 실제 모델 probe는 서로 다른 증거다.
- [PR817](https://github.com/merryAI-dev/MYSCube/pull/817)은 합성 React 자동 Git 전달, [PR818](https://github.com/merryAI-dev/MYSCube/pull/818)은 Linux 격리·이미지 검증용이다. 전체 구현 [Draft PR819](https://github.com/merryAI-dev/MYSCube/pull/819)의 병합과 기존 서비스 배포를 이번 독립 자원 설치로 대신했다고 주장하지 않는다.

## 실행 방식과 남은 수용 기준

정책/API와 생성 소스를 분리하고, 패키지를 미리 준비하며 성공한 실행만 반영한다. 브라우저 esbuild-wasm 대신 독립 서버에서 컴파일하고 생성 React는 원격 Chromium에서 실행한다. 사용자는 PNG 화면과 조작 이벤트로 상호작용하므로 텍스트 선택·스크린리더 접근에는 제한이 있다. 로컬 iframe은 에뮬레이터 전용이며 임의 npm 설치는 지원하지 않는다.

사용자가 승인한 독립 프로젝트·VM·시크릿·IAM을 실제 구성했다. 앱 VM은 원본 업무 Firestore를 읽지 않고, 별도 복사 Job만 승인된 원본 읽기 권한을 가진다. 기존 Firebase 인증 프로젝트를 유지해 UID를 바꾸지 않는다. 사용자 상태 조회 권한과 인증 할당량, 별도 Job의 원본 읽기 비용은 기존 자원과 접점이 있으므로 영향이 완전히 0이라고 설명하지 않는다.

운영 완료 판정에는 실제 Google 로그인과 권한 회수·5분 만료, 사용자 대화/저장/복구, 근거와 화면의 일치, 지속적인 복사 신선도 확인이 남아 있다. Sheets 및 현금흐름 사본 공급과 비공개 GitHub App도 별도 연결해야 한다. [S20](s20-offline-http-evidence.md)의 운영자 내보내기는 실시간 HTTP 자동 수집·전체 요청 분모를 대신하지 않는다.

이번 독립 환경 작업은 주정산·월결산·JVM 및 실제 프로젝트·임시저장 데이터의 쓰기·계산 경로를 변경하지 않았고 기존 서비스 배포를 실행하지 않았다. 기존 MYSCube 홈의 직접 curl 확인은 Cloudflare edge 403으로 업무 화면에 도달하지 못했으므로 기존 서비스의 실제 사용자 흐름까지 PASS라고 보고하지 않는다.
