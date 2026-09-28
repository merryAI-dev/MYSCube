# S22 — 독립 운영 환경 구성 및 적용 기록

2026-09-24. 사용자가 아래 독립 리소스 생성을 승인했고, 기존 결제 계정의 프로젝트 연결 한도 오류 후 Gemini가 사용하는 `Firebase 결제` 계정(끝자리 `EE6FA2`)을 직접 선택했다. 아래 기반 리소스는 실제 생성했다. 운영 후보 전달·호스트 패키지 설치·DNS/TLS·실제 권한/로그 복사를 확인했다. 앱 활성화·loopback health·미인증 API 401·로컬 TLS는 통과했다. 외부 HTTPS health 200·TLS 검증·미인증 API 401과 실제 로그인 화면 표시까지 확인했다. 실제 SSO 로그인과 업무 사용자 흐름은 아직 남아 있다.

## 현재 확인한 상태

- 신규 앱·모델 프로젝트 두 개의 결제가 선택한 계정에 연결되어 `billingEnabled=true`임을 독립 QA가 확인했다. 기존 MYSCube의 결제 연결은 변경하지 않았다.
- 기존 운영/QA 프로젝트와 JVM 서비스를 AXR 실행 호스트로 사용하지 않는다.
- 초기 PR819 `15ddc52a28f7d0ce436d447fca1a33c6b5adc756`의 합성 검증에 이어 운영 후보 `0dc6fe797713043a7bdb747b6a2eb9da14da082c`의 [Workbench CI](https://github.com/merryAI-dev/MYSCube/actions/runs/35955972729)와 [기존 CI](https://github.com/merryAI-dev/MYSCube/actions/runs/35955972726)가 성공했다. 운영 후보 전달·호스트 설치 증거는 아래에 구분했다.
- 독립 QA가 현재 코드의 VM 요구량, 계정 분리, 로그인 UID 호환성, 사본 공급 경로를 검토했다. 실제 설치와 첫 복사까지 진행했으며 사용자 인증·대화·지속 운영 수용 시험은 남아 있다.

### 생성된 리소스와 검증 범위

| 리소스 | 실제 상태 |
|---|---|
| 앱 프로젝트 | `myscube-axr-prod-20260924`, 프로젝트 번호 `523130357051` |
| 모델 프로젝트 | `myscube-axr-model-20260924`, 프로젝트 번호 `211465389697` |
| VM | `axr-workbench-01`, `asia-northeast3-a`, `e2-custom-6-8192`, Debian 12 amd64, 50 GB `pd-balanced`, 실행 중 |
| 네트워크 | `axr-vpc` / `axr-seoul`, `10.81.0.0/24`, private Google access 활성 |
| 외부 IP | `axr-workbench-ip`, `34.64.247.190`; SSH는 IAP 대역 TCP 22로 제한하고 AXR 외부 HTTPS 443을 개방. 앱 8791은 localhost만 사용 |
| 호스트 접근 | OS Login, 프로젝트 SSH 키 차단, Shielded VM 3종, 삭제 보호. 실제 IAP 접속에서 Debian 12·x86_64·49 GiB 파일시스템 확인 |
| Firestore | `(default)`, 서울, Native/Standard, 삭제 보호 활성; PITR 미설정 |
| 릴리스 버킷 | `myscube-axr-releases-20260924`, 서울, uniform IAM, public access prevention 활성 |
| 실행 계정 | `axr-runtime`, 신규 앱 프로젝트의 `datastore.user`와 전용 모델 시크릿 하나의 읽기 권한. 원본에는 승인한 `firebaseauth.users.get`만 부여, 원본 업무 DB 권한 없음 |
| 배포 계정 | `axr-deployer`, 위 릴리스 버킷의 objectAdmin과 신규 `axr-releases` Artifact Registry의 writer. 운영자는 이 계정만 단기 impersonation해 배포하며 원본 업무 권한을 VM에 전달하지 않음 |
| 기본 Compute 계정 | API 활성화가 자동 부여한 Editor 권한을 제거하고 미사용 계정 비활성화 |
| 전용 모델 키 | 신규 모델 프로젝트의 `axr-runtime-gemini-v2`, Gemini API와 VM IP로 제한. 값은 신규 앱 프로젝트의 Secret Manager에 보관 |
| 모델 연결 확인 | 실제 VM의 부착 계정 → 전용 시크릿 → 전용 Gemini API의 모델 목록 조회 성공. 실제 Gemini 3.6 Flash 구조화 응답 probe 2,030ms 확인. 업무 자료 없는 단일 호출이며 업무 답변 품질 검증은 별도 |
| 비용 알림 | 두 신규 프로젝트만 포함한 월 340,000 KRW. 실제 비용 50/80/100%, 예상 비용 100% 알림. 기본 billing IAM 수신자 사용; 수신 성공 미검증 |

최초 미사용 모델 키는 CLI가 비밀값을 출력하는 동작을 확인한 즉시 삭제했다. 재발급은 응답을 메모리에서 처리해 Secret Manager에 저장했으며 값을 로그나 저장소에 남기지 않았다. 신규 VPC 이외에 API가 자동 생성한 기본 네트워크의 규칙은 현재 VM에 적용되지 않는다. 설정 조회가 실제 OAuth·렌더러·장애 수용 시험을 대신하지 않는다.

### 승인한 원본 연결 범위

사용자가 추가 확인에 `네`로 승인한 뒤 다음 권한을 적용했다.

- 기존 인증 프로젝트에서 `axr-runtime`에 `axrAuthUserCheck` custom role의 `firebaseauth.users.get`만 부여했다. 계정 상태 외에 프로필 조회도 가능한 권한임을 승인에 명시했다.
- 별도 `axr-copy-worker`에는 `axrSourceRead` custom role의 `datastore.entities.get/list`만 부여했다. 코드가 관리자 권한·오류 기록으로 범위를 제한하더라도 IAM은 원본 DB 읽기 권한이라는 점을 승인에 명시했다. 원본 쓰기 권한은 없다.
- 복사 대상은 독립 앱 DB이며 `axrCopyTarget` custom role의 entities get/list/create/update와 databases get(트랜잭션)을 사용한다. 복사 계정에 모델 시크릿이나 VM 접속 권한을 주지 않는다.
- 기존 Firebase의 `authorizedDomains` 필드만 갱신해 원래 5개 도메인을 유지하고 `axr.myscguard.app`을 추가했다. 별도 검토한 [DNS plan](https://github.com/merryAI-dev/MYSCube/actions/runs/35956009713)과 [apply](https://github.com/merryAI-dev/MYSCube/actions/runs/35956231752)가 성공했다. 정확히 `axr.myscguard.app`의 A `34.64.247.190`만 DNS only·TTL 300으로 생성했다. 기존 레코드와 WAF는 변경하지 않았다.

초기 운영자 읽기 조사에서 `mysc` 관리자 29명이 모두 `ACTIVE`임을 집계로 확인했다. 이후 별도 `axr-copy-worker` 계정의 실제 Job execution 접미어 `dggtc`, `x5fsq`가 성공했고 독립 DB의 권한·로그 marker를 대조했다. client error는 페이지당 100건이며 과거 자료 `hasMore=true`, reliability는 0건이었다. 전체 과거 로그 수집 완료라는 의미는 아니다. 명시적 grants는 `{}`이므로 분석 dataset 접근은 추가하지 않았다.

`axr-copy-every-two-minutes` Scheduler를 `*/2 * * * *` UTC로 생성·활성화했고 scheduler 계정에는 해당 Job의 `roles/run.invoker`만 부여했다. 첫 예약 execution `axr-copy-worker-nfjlb`가 2026-09-24 07:04:13Z에 성공했고 `workbench.copy status=complete`를 확인했다. 예약 요청 접수와 Job 성공, 권한 marker 최신성은 각각 확인해야 한다.

실제 VM의 Node 24.21.0 공식 릴리스 서명과 archive SHA256을 검증했다. 최초 패키지 설치에서 `pipefail`/`grep -q`의 SIGPIPE(141), 다음 시도에서 GCE Debian mirror 목록 표기 미지원이 발견됐다. 각각 출처 검증을 유지하며 수정한 뒤 실제 호스트 설치를 완료했다. 설치 버전은 Node 24.21.0, Docker 29.8.1, nginx 1.22.1이다.

## 운영 후보 전달·설치 증거

- 소스 SHA: `0dc6fe797713043a7bdb747b6a2eb9da14da082c`.
- 앱 registry digest: `sha256:0d78218589b12515f4ead5abb0fd777fc970c4d714a6b606122998fa12e4b4f4`.
- renderer registry digest: `sha256:460a81a5eb0411fc4d914d358f58b3d1829916b28f65f6424f34d12b9f5d9712`.
- manifest SHA256: `d1cc53943ba8b5d92b2f590fbe19107a7c5d013d73257a7b45dd277b5d1a6411`. 앱·renderer archive와 manifest 3개 파일을 비공개 릴리스 버킷에 보관하고 읽기를 확인했다. 설치에서는 전달받은 전체 hash를 대조한다.
- 실제 운영 호스트 renderer QA는 `/tmp/myscube-actual-host-renderer-qa.json`에 PASS로 기록했다. React 클릭, 원시 TCP/DNS 및 브라우저 외부 통신 차단, 공격 중 정상 세션, 정리·orphan/restart guard를 확인했다. 첫 화면 2,893ms·다음 세션 1,468ms는 각 1회 측정이며 SLO가 아니다. 이 검사는 업무 DB·인증·모델을 사용하지 않았고 실제 kernel OOM은 관측하지 않았다.
- 호스트 installer의 nginx 실행 경로 두 곳을 `dd571d82a430ca664cb625540b477f1b50e9cc78`에서 수정했다. 자체 생성한 부분 설정이 정확히 일치할 때만 복구하는 재시도 검증과 독립 QA를 통과했다. 이후 source `0dc6` 후보의 활성화·loopback health·미인증 API 401·로컬 TLS가 실제 통과했다. app/nginx/reaper는 active이며 앱은 localhost:8791에서 동작한다.
- Let's Encrypt 인증서를 발급했다(2026-12-23 만료). 외부 443 개방 후 HTTPS health 200·TLS 검증 성공·미인증 API 401을 확인했다. 브라우저 로그인 화면은 HTTP 200으로 오류 없이 표시됐다(`/tmp/myscube-axr-live-login.png`). 실제 Google SSO 로그인은 사용자 확인을 기다린다.

앱 systemd 상한은 CPU 1개·메모리 2 GiB이고, 렌더러는 최대 4개 × CPU 1개·512 MiB다. 합계 CPU 5개·메모리 4 GiB에 OS·Docker·TLS 여유를 둔 시작 규격이다. 성능 보장이 아니며 동시 실행과 장애 시험이 필요하다. Docker 렌더러는 앱 systemd cgroup 밖에 있으므로 앱 제한에 포함시켜 계산하지 않는다.

## 비용 확인

2026-09-24 공식 페이지의 서울 리전, 약정 없는 USD 요금, 월 730시간을 기준으로 계산했다. 무료 사용량·약정 할인은 적용하지 않았다.

| 구성 | 산식 | 예상 월 비용 |
|---|---|---:|
| VM | `(6 × $0.02942774 + 8 × $0.003926066) × 730` | $151.82 |
| 50 GiB balanced disk | `50 × $0.13` | $6.50 |
| 사용 중 IPv4 | `$0.005 × 730` | $3.65 |
| 기본 인프라 소계 | 위 3항목 | **$161.97** |

근거: [VM 공식 요금](https://cloud.google.com/products/compute/pricing/general-purpose), [디스크 공식 요금](https://cloud.google.com/compute/disks-image-pricing), [IPv4 공식 요금](https://cloud.google.com/vpc/network-pricing). VM·디스크 페이지의 초기 표시 지역 대신 내장 가격표의 `Seoul (asia-northeast3)` 항목을 대조했다.

모델, Firestore, 릴리스 보관, 복사 작업, 로그, 전송량, 세금·환율은 위 소계에 포함되지 않는다. 승인한 **월 $250 관리 예산**에 맞춰 원화 결제 계정에는 **월 340,000 KRW 알림**을 설정했다. 이는 9월 24일 [USD/KRW 참고 시세](https://tradingeconomics.com/south-korea/currency)에 따른 약 $250 수준이며 Google의 실제 청구 환율을 고정하지 않는다. 실제 사용량·수집 범위에 따른 종량제 비용은 추가 산정한다. 이 값은 보장된 총액 또는 자동 결제 차단선이 아니다. [알림 전용 예산은 소비를 자동 차단하지 않는다](https://docs.cloud.google.com/billing/docs/how-to/budgets). 장기 약정이나 기존 결제 계정 전체를 중단하는 조치는 하지 않는다.

## 계정·데이터 연결은 별도 실행 경로로 구성

1. **앱·렌더러:** 전용 VM에는 원본 Firestore/Sheets 자격 증명을 두지 않는다. Docker 그룹의 앱 계정은 호스트 수준 권한이 있으므로 다른 Linux 사용자에 원본 키를 두는 것만으로 분리하지 않는다.
2. **권한·로그 사본:** 별도 Job과 서비스 계정에서 실행한다. 현재 worker는 원본·대상 Firestore에 같은 프로세스 ADC를 사용하므로 이 계정만 승인된 원본 읽기와 독립 DB 쓰기를 가진다. 실제 IAM 허용 단위가 DB 전체라면 컬렉션 한정 권한이라고 설명하지 않는다. 사용자가 승인한 원본 get/list custom role만 복사 계정에 적용했다.
3. **로그인:** 기존 Firebase 프로젝트를 유지하고 사용자 상태 조회 권한·허용 도메인을 설정했다. member ID와 Firebase UID 일치, 실제 Google popup 및 로그아웃·권한 회수는 사용자 수용 시험으로 확인해야 한다. gcloud 로그인이나 계정 조회 성공만으로 브라우저 로그인을 통과시킨 것으로 보지 않는다.
4. **모델:** 현재 구현은 전용 Gemini API key 방식이다. 모델 프로젝트 환경 변수만으로 키의 실제 소속이 증명되지 않으므로 생성 프로젝트·제한 API·모델·호출 예산을 함께 검증한다.
5. **Sheets·외부 API:** 승인 시트, 고정 범위, 외부 주소·인증 방식·응답 스키마를 확정한 뒤 읽기 연결한다. 기존 주정산·월결산 코드·시트 값을 변경하지 않는다.
6. **Git:** 현재 공개 저장소는 합성 테스트용이다. 실제 업무 페이지는 전용 비공개 저장소와 GitHub App을 연결한 뒤 전달한다.

권한 사본은 5분을 넘으면 접근이 차단된다. 별도 Cloud Run Job의 첫 두 실행은 성공했고 2분 Scheduler를 생성했지만 첫 예약 실행도 성공했다. 지속 신선도·실패 감시의 수용 확인은 남아 있다. 권한·로그를 함께 1회 복사하면 최대 관리자 200명과 로그 두 종류의 증분/순환 조회를 합쳐 약 600개 원본문서를 조회할 수 있다. 이는 대상 트랜잭션 조회, 빈 쿼리, 인덱스 조회, 재시도까지 포함한 과금 상한이 아니다. 원본 읽기 비용·쿼터는 별도로 계산하며 기존 서비스에 영향이 전혀 없다고 주장하지 않는다.

## 실제 적용 순서와 통과 조건

1. **대상·비용 확정 — 완료:** 위 두 신규 프로젝트와 VM 규격, 초기 관리 예산을 사용자가 승인했다. 결제는 추가 선택한 Gemini의 `Firebase 결제` 계정이다. 새 프로젝트 내 계정·저장소 권한만 1차 적용한다.
2. **기반 생성 — 완료:** 신규 프로젝트·결제·API·독립 DB·네트워크·VM·릴리스 저장소를 생성했다. 기존 인증 조회와 별도 복사 계정의 원본 읽기 IAM은 추가 승인 범위만 적용했다. 기존 업무 배포는 실행하지 않았다.
3. **릴리스 설치 — 기본 실행 확인:** 동일 SHA 운영 이미지 쌍을 전달하고 호스트 설치·renderer 검증을 마쳤다. installer 후속 수정 후 앱 활성화·loopback health·미인증 API 401·로컬 TLS를 확인했다. app/nginx/reaper active와 외부 HTTPS health 200·TLS 검증·미인증 API 401·로그인 화면 표시까지 확인했다. 실제 SSO와 업무 흐름은 별도다.
4. **연결 적용 — 일부 완료:** 인증 설정·별도 권한/로그 복사 Job·Scheduler·전용 모델·DNS/TLS를 구성했다. 실제 사용자 로그인, Sheets·외부 API·비공개 GitHub App은 남아 있다. 원본 복사 계정과 Job은 앱 VM 밖에서 실행한다.
5. **실제 수용 시험:** TLS, 미인증 401, 계정/테넌트 403, 로그아웃·권한 회수·5분 만료, 저장/복구, React/API 상호작용, 네트워크 차단, 동시 4개 실행, crash/reaper/재시작, 실제 조회 근거와 최신성을 확인한다.
6. **사용 시작:** 위 증거가 확보된 뒤 AXR 진입점과 실제 운영 노출을 연결한다. 기존 업무/정산 배포를 함께 실행하지 않는다.

TLS 자동 갱신 hook은 별도 코드 QA 10/10을 통과했으며 실제 설치 확인은 진행 중이다. 발급된 인증서와 갱신 hook 검증을 혼동하지 않는다. 기존 MYSCube 홈의 직접 curl 확인은 Cloudflare edge 403으로 업무 화면에 도달하지 못했다. 기존 서비스 배포는 실행하지 않았으며 이 확인을 업무 흐름 전체 PASS로 보고하지 않는다.

## 기반 설정과 구분해야 할 남은 구현

- `/cashflow-evidence`·`/insight-cashflow-report`가 읽는 `workbench_snapshots`의 실제 공급 경로는 아직 없다. Sheets 분석 dataset 공급으로 이 경로까지 채워졌다고 보지 않는다.
- 새 HTTP 로그의 자동 공급·전체 요청 분모·오류 감소 추이는 승인한 로그 원본·공급 방식에 맞춘 추가 연동이 필요하다.
- 비공개 코드 근거 조회 인증과 생성 페이지 Git 전달 인증은 별도다. 실제 저장소 범위를 확인해야 한다.

관련 실행 계약: [전용 호스트](../../../server/workbench/host-runtime/README.md), [배포 묶음](../../../server/workbench/deployment/README.md), [완료 상태](toi-completion-status.md). QA는 문서·코드·공식 가격표와 설치·renderer·첫 복사 증거를 구분해 검토한다. 실제 사용자 브라우저·업무 모델 품질·지속 부하 검증은 아직 남아 있다.

## TLS 갱신 설치 후 검증 (2026-09-24)

전용 호스트에 `renew-tls.mjs`(SHA256 `bb19b4e8bcad0ee5a9ef9d83151675810379e55cf661943ce17a2be894486b68`)와 해당 도메인 전용 Certbot deploy hook을 설치했다. 기존 갱신 타이머를 유지하고 `--reuse-key --cert-name axr.myscguard.app`으로 범위를 고정했다. 실제 `--check` 성공, 같은 인증서 `--apply`는 `unchanged`, Certbot staging 갱신 dry-run 성공을 확인했다. dry-run에서 deploy hook을 실행하거나 운영 인증서를 강제 재발급하지 않았다. 원래 키는 유지했다.

실제 미래 갱신 후의 서비스 인증서 교체와 실패 알림 수신은 아직 별도 수용 항목이다. 운영 VM 로그는 journald 512MB/휘발성 128MB/최대 30일로 제한했다. 별도 알림 수신 경로가 설치됐다고 주장하지 않는다.
