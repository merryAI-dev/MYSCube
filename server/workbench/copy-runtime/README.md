# 분리된 권한·운영기록 사본 작업

이 구성은 기존 `server/workbench/copy-worker.mjs`를 **별도 Cloud Run Job**에서 실행한다. 앱과 Docker renderer가 설치된 VM에는 원본 읽기 권한이나 복사 계정의 키를 넣지 않는다. 생성기가 출력하는 명령은 실행되지 않는다. 원본 읽기 권한 승인, 이미지 게시, IAM 설정, 최초 실행 확인은 운영자가 별도로 수행해야 한다.

## 실제 경로와 한계

`copy-runtime/run.mjs → 사본 DB 실행 잠금 → Node 자식 프로세스 copy-worker.mjs → 원본 Firestore 읽기 → 사본 Firestore 트랜잭션` 순서다. 자식 프로세스는 기존 worker 한 번만 실행하며 API 서버·모델·Git·Docker를 실행하지 않는다. 원본에는 쓰지 않는다.

- 권한: `orgs/{tenant}/members` 중 `role=admin`을 읽고 `role/status`만 선택한다. 201번째 계정이 발견되면 전체 권한 갱신을 거부한다. 최대 200명 전체 목록을 매 실행 읽어야 삭제·비활성 계정도 회수할 수 있다. 계정별 `analyticsDatasetIds`는 별도 승인한 명시적 설정에서만 온다.
- 운영기록: `client_error_events`, `reliability_operations` 각각 증분 최대 100개와 기존 자료 순환점검 최대 100개를 읽는다. 기존 cursor·generation CAS를 유지한다. 전체 로그를 한 번에 스캔하거나 다음 페이지를 반복해서 읽지 않는다.
- 한 주기에서 원본 문서 후보의 상한은 정상 범위에서 600개다. 2분마다 720회/일이면 최대 432,000개 후보/일이며 실제 청구량은 원본 크기, 중복, 빈 쿼리 최소 과금, SDK 재시도, 사본 읽기·쓰기에 따라 다르다. **기존 시스템의 읽기 비용·할당량 영향이 0인 구성은 아니다.** 최초 활성화 전에 이 별도 읽기 예산도 확인한다.
- 주정산·월결산·사업비 시트의 쓰기 또는 계산 경로는 바꾸지 않는다. 이 작업은 시트 현금흐름 자료, `workbench_snapshots`, 실시간 HTTP 로그를 공급하지 않는다. 별도 공급기가 없는 자료는 계속 미확인 상태다.
- 복사한 관리자 ID가 인증 UID와 같아야 한다. 별도 인증 프로젝트의 사용자 ID가 달라지면 자동으로 맞추지 않으며 접근은 거부된다.

## 이미지·실행 설정

새 wrapper가 포함된 검토 완료 Workbench 앱 이미지를 Artifact Registry에 게시하고 **digest**로 지정한다. 기존 앱 Dockerfile이 `server/workbench`, BFF의 순수 보조 모듈, `shared`, `policies`, 잠금파일에 따른 의존성을 포함하므로 별도 의존성 설치나 패키지 변경 없이 command를 바꿀 수 있다. 현재 root 잠금파일의 직접 관련 버전은 `@google-cloud/firestore 7.11.6`, `zod 4.3.6`이다. 이미지 전체의 승인된 release SHA·빌드 분류·digest를 대조하는 절차는 [release verifier](../deployment/release-bundle.mjs)를 따른다. **OCI registry digest와 docker image ID는 다른 식별자이므로 서로 대신 쓰지 않는다.**

Cloud Run container command는 `node`, args는 `server/workbench/copy-runtime/run.mjs`다. `/app` 작업 디렉터리와 Node 24는 기존 이미지에 들어 있다. 외부에서 호출할 HTTP 포트는 없다. 서비스가 아니라 Job이다.

| 항목 | 값 |
|---|---|
| Job | `axr-copy-worker` |
| 작업 계정 | `axr-copy-worker@독립프로젝트.iam.gserviceaccount.com` |
| Scheduler 계정 | `axr-copy-scheduler@독립프로젝트.iam.gserviceaccount.com` |
| task count / parallelism | 1 / 1 |
| CPU / memory | 1 / 512MiB; 실 배치 지연·메모리는 별도 수용 시험 |
| Cloud Run task timeout / retry | 100초 / 0회 |
| wrapper child deadline | 75초, TERM 후 2초에 KILL, close 확인 여유 3초 |
| Scheduler | `*/2 * * * *`, UTC, HTTP POST Google Run API, OAuth |
| Scheduler request deadline / retry | 30초 / 0회 |

Google Run API는 Job 완료 전에 실행 요청을 접수할 수 있다. Scheduler 성공을 복사 성공으로 해석하지 않는다. 동일 Job의 `parallelism=1`도 서로 다른 execution의 중복 실행을 막아 주지는 않는다.

## IAM 승인 경계

| 주체 | 필요한 범위 | 주면 안 되는 범위 |
|---|---|---|
| 복사 Job 계정 | 승인된 원본 Firestore 읽기, 독립 사본 Firestore 읽기·쓰기(트랜잭션·잠금 포함) | 원본 쓰기, 모델/Git/비밀값 접근, VM 접속·Docker |
| Scheduler 계정 | 이 Job 하나에 `roles/run.invoker` | Firestore 읽기·쓰기, Job 설정 변경·환경변수 override, 모델/Git |
| 앱 VM 계정 | 기존 독립 앱 권한 | 원본 Firestore 읽기, 복사 Job 계정 impersonation·키 |
| 배포 담당자 | 검토된 Job 생성·설정 및 해당 서비스 계정 사용 | 승인되지 않은 원본 IAM 확대 |

예를 들어 원본은 `roles/datastore.viewer`, 사본은 `roles/datastore.user`가 해당 기능을 포함하지만 이 역할은 문서 3개 collection만으로 자동 제한되지 않는다. 서버 SDK는 Firestore Rules가 아니라 IAM을 사용한다. DB 범위의 조건부 IAM 또는 승인된 custom role의 실제 지원 범위를 따로 검토하고, 원본에서 `get/list`는 허용되며 write는 거부되는 것을 실제 계정으로 확인해야 한다. 넓은 역할을 임의로 추가하는 명령은 이 recipe에 넣지 않았다. Scheduler용 서비스 에이전트 권한과 배포자의 `iam.serviceAccounts.actAs`도 Google 공식 절차대로 별도 확인한다.

Cloud Run에 연결한 서비스 계정의 ADC를 사용한다. JSON 키 파일, `GOOGLE_APPLICATION_CREDENTIALS`, emulator override, `NODE_OPTIONS`, 모델 키, Git private key는 wrapper가 거부한다. 원본 계정 키를 앱 VM에 복사하지 않는다. 이미지 빌드나 이 문서에도 비밀값을 넣지 않는다.

## 출력 전용 계획 만들기

검토 대상 로컬 파일 `approved-copy-plan.json`을 준비한다. 계정 ID별 grants는 운영 설정이므로 저장소에 커밋하지 않는다. `{}`는 모든 관리자의 분석 dataset 접근을 허용하지 않는 명시적 빈 목록이다. 네 project ID는 기존 runtime validator가 요구하며, 모델 프로젝트 ID가 있어도 이 작업은 `WORKBENCH_AI_ENABLED=false`로 모델을 호출하지 않는다.

```json
{
  "projectId": "approved-isolated-project",
  "productionProjectId": "approved-source-project",
  "modelProjectId": "approved-isolated-model",
  "productionModelProjectId": "approved-existing-model",
  "region": "asia-northeast3",
  "tenantId": "approved-tenant",
  "image": "asia-northeast3-docker.pkg.dev/approved-isolated-project/releases/workbench@sha256:REPLACE_WITH_64_LOWERCASE_HEX",
  "grants": {},
  "sourceReadApproved": false
}
```

```bash
node server/workbench/copy-runtime/plan.mjs approved-copy-plan.json > reviewed-copy-plan.json
```

결과의 `environmentFile.content`를 지정된 `copy-disabled.env.json`에 저장한다(셸 source/eval 하지 않음). `prepare`는 Job **create** 명령 하나를 출력하며 실행하지 않는다. 이미 있는 Job을 덮어쓰지 않는다. 이 단계의 환경은 `WORKBENCH_COPY_ENABLED=false`, `WORKBENCH_COPY_SOURCE_READ_APPROVED=false`다. Job은 생성만 하고 실행하지 않는다.

원본 권한 승인이 없는 입력에서는 activation 명령이 출력되지 않는다. `sourceReadApproved=true`는 배포 담당자가 승인받았음을 입력하는 확인값이며, IAM이 실제로 설정되어 있다는 증명은 아니다. 승인 후 다시 출력된 `activation`을 단계별로 검토한다.

1. 현재 이미지에 wrapper가 존재하며 source SHA·digest가 검토한 값인지 확인한다.
2. 전용 Job/Scheduler 계정과 IAM을 확인한다. 앱 VM 계정으로 원본 접근이 불가능한지 별도 확인한다.
3. 활성화 환경변수를 설정한 뒤 Job을 **한 번** 실행하고 종료까지 기다린다.
4. execution 성공, `workbench.copy`의 `status=complete`, permissions marker와 사본 계정의 수집 시각, 비활성/삭제 계정 회수, 원본 쓰기 0을 확인한다. Job 실행 요청 API의 200 응답만으로 통과시키지 않는다.
5. 그 뒤에만 2분 Scheduler 생성 명령을 수행한다. 첫 실행이 실패한 상태에서 스케줄을 만들지 않는다.

wrapper는 활성화 전에 project/tenant/source 핀, 명시적 grants, task1·첫 시도 조건을 검사한다. enabled=false이면 Firestore client도 만들지 않고 `disabled`로 종료한다. Run API overrides 권한은 Scheduler에 부여하지 않는다.

## 중복·실패·권한 만료

사본 DB `orgs/{tenant}/workbench_copy_runtime/scheduled`의 `active/owner` 트랜잭션을 획득한 프로세스만 자식 worker를 실행한다. active lock이 있으면 `blocked_active`로 실패 종료하며 원본을 읽지 않는다. 정상 child close를 확인한 뒤 같은 owner의 lock만 해제한다. 성공 후에는 다음 UTC 2분 구간의 시작까지 재실행을 막아 각 구간에서 최대 1회 읽는다. 따라서 Scheduler 지연이 수 밀리초 달라도 다음 정상 구간을 불필요하게 건너뛰지 않는다. 구간 경계를 사이에 둔 두 실행의 간격이 120초보다 짧을 수 있지만 동시 실행은 잠금으로 막고 일일 구간 수는 720개다. 실패 후 120 → 240 → 최대 480초 backoff를 저장하고 그동안 `backoff`로 source 읽기를 생략한다. 실제 권한 갱신 성공 여부는 별도 permissions marker로 확인한다.

**잠금 TTL 자동 해제는 없다.** 기존 worker에 fencing token이 없어서 시간만 지나고 lock을 탈취하면 아직 살아 있는 worker와 중복 실행할 수 있기 때문이다. 자식 kill 명령 성공만으로 해제하지 않고 `close`를 기다린다. wrapper SIGKILL, VM 중단, 종료 확인 실패, 잠금해제 트랜잭션 실패는 잠금을 남길 수 있다. 기존 worker 및 그 import 경로는 별도 자식 프로세스를 만들지 않는 고정 코드만 실행한다. 이 전제 변경은 다시 검토해야 한다.

이 방식은 **장애 시 자동 가용성 복구보다 원본 중복 읽기 방지를 우선**한다. 복사가 계속 실패하거나 잠금이 남으면 마지막 권한 사본에서 5분이 지난 후 Workbench 전체 접근이 차단될 수 있다. 기존 프로젝트·임시저장·주정산·월결산 서비스에는 이 권한 사본을 사용하지 않는다. 2분 스케줄이나 backoff는 권한 최신성 또는 무중단 보장이 아니다.

운영 경보는 최소 다음 세 가지가 필요하다: 마지막 permissions 수집 시각 240초 초과(300초 접근 차단 전), `blocked_active/termination_unconfirmed/lock_changed/failed`, Cloud Run 실행 실패·Scheduler 전달 실패. 이 recipe는 경보 정책이나 알림 채널을 생성하지 않는다. 활성화 전에 담당자와 수신 여부를 확인한다.

### 남은 잠금의 수동 복구

1. Scheduler를 pause하고 Job을 disabled로 설정한다. 이미 시작된 execution은 이 설정으로 취소되지 않는다.
2. 현재 lock의 `owner`, `executionId`, `jobName`, `startedAt`을 기록한다.
3. Google Run executions 조회에서 **해당 execution이 terminal이며 실행 중 task가 0**임을 확인한다. 실행 중이거나 조회가 실패하면 잠금을 그대로 둔다. 필요하면 해당 execution만 취소하고 terminal이 될 때까지 확인한다.
4. 승인된 운영자만 사본 DB에서 트랜잭션으로 현재 lock을 다시 읽는다. `active=true`, 기록한 owner와 executionId, source/target project가 모두 동일할 때만 `active=false`로 바꾼다. 기존 문서 삭제나 무조건 덮어쓰기를 하지 않는다. `manualRecovery`에 확인한 execution resource, completion time, 운영자 ID, 수행 시각, 사유를 남긴다. 값이 바뀌었으면 중단하고 다시 확인한다.
5. 다음 복사를 수동 실행해 권한 사본 갱신과 정상 lock 해제를 확인한 뒤 Scheduler를 재개한다. 과거 `permissionsCapturedAt`을 현재 시각으로 고치는 방식으로 접근을 복구하지 않는다.

수동 복구를 자동 실행하는 CLI는 제공하지 않는다. terminal 확인 및 운영자 승인 없이 lock을 풀어주는 경로도 없다.

## 검증 범위

로컬 테스트는 fake child의 TERM/KILL/close 순서, 종료 불명, 설정·비밀값 차단, 출력 전용 계획을 검증한다. Firestore emulator 테스트는 두 execution의 실제 CAS 경쟁, backoff, owner 변경, 영구 lock, 합성 원본→기존 복사 함수→사본→5분 후 접근 거부를 검증한다. Cloud Run/Scheduler 서비스, 실제 IAM, 실제 운영 자료·과금·스케줄 지연은 이 테스트가 증명하지 않는다. UI 변화가 없어 브라우저 QA 대신 실제 Firestore 경로를 사용한다.

공식 근거: [Cloud Run Job 예약 실행](https://docs.cloud.google.com/run/docs/execute/jobs-on-schedule), [task timeout](https://docs.cloud.google.com/run/docs/configuring/task-timeout), [Job 서비스 계정](https://docs.cloud.google.com/run/docs/configuring/jobs/service-identity), [Scheduler OAuth 인증](https://docs.cloud.google.com/scheduler/docs/http-target-auth), [Scheduler 재시도](https://docs.cloud.google.com/scheduler/docs/configuring/retry-jobs), [Firestore IAM](https://docs.cloud.google.com/iam/docs/roles-permissions/firestore).
