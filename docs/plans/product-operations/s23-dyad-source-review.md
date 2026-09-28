# S23 — Dyad 실제 소스와 TOI 설계 비교

작성: 2026-09-24. 범위: 공개 소스 읽기와 MYSCube 적용 설계. Dyad 코드 실행·의존성 설치·코드 복사·운영 호출은 하지 않았다. 이 문서는 기능 구현 완료나 외부 제품의 테스트 통과를 증명하지 않는다.

## 결론

Dyad에서 참고할 것은 **대화 요청, 변경 파일, 진단 결과, Git 버전, 미리보기 실행을 서로 식별자로 연결하는 흐름**이다. Electron 앱 전체나 Agent 구현을 가져오는 방식은 현재 독립 웹 서비스에 맞지 않는다. MYSCube는 기존 권한 검사·불변 저장 버전·등록 API·격리 실행을 유지하면서, 단일 `App.tsx` 계약을 검증 가능한 여러 파일 계약으로 확장하는 편이 적합하다.

또한 세 가지를 구분해야 한다. **소스 버전 저장**, **실행 가능한 화면으로 교체**, **GitHub 검토 요청**은 각각 다른 성공 조건이다. Dyad의 Git checkpoint도 타입·빌드 성공을 뜻하지 않으며, Toss 글의 “트랜잭션 커밋”은 Git 커밋이 아니라 성공한 미리보기 문서의 교체를 설명한다.

## 조사 기준과 재현 정보

| 항목 | 확인값 |
| --- | --- |
| 공식 저장소 | [dyad-sh/dyad](https://github.com/dyad-sh/dyad) |
| GitHub 조회 시각 | 2026-09-24 07:15:56 UTC / 16:15:56 KST |
| 별 / fork | 21,603 / 2,642 — 해당 시각의 수치이며 품질·안전성 증거는 아님 |
| 상태 | 공개, archived=false, 기본 브랜치 main |
| 고정 커밋 | [`39fbae87b38573616a1a3b152cdb292787bb1109`](https://github.com/dyad-sh/dyad/commit/39fbae87b38573616a1a3b152cdb292787bb1109) |
| 커밋 시각 / 제목 | 2026-09-24 00:00:31 UTC / Authenticate OAuth deep-link callbacks (#4433) |
| 조사 방법 | 공식 GitHub REST 메타데이터, depth=1/filter=blob:none clone, 필요한 소스만 sparse checkout, 실제 구현과 테스트 파일 읽기 |
| 로컬 조사 위치 | `/tmp/myscube-reference-dyad` — MYSCube에 vendoring하지 않음 |

아래 Dyad 링크는 모두 이 커밋에 고정했다. `main`의 추후 변경을 이 문서의 관찰 결과에 소급하지 않는다.

## 실제 백엔드와 상태 저장

Dyad의 중심은 일반적인 다중 사용자 HTTP BFF가 아니라 **Electron main process의 TypeScript 서비스와 typed IPC**다. React renderer가 IPC를 호출하고, main process가 AI SDK 모델 스트림·파일 시스템·Git·앱 프로세스를 제어한다. 대화와 앱 메타데이터는 `better-sqlite3` + Drizzle로 사용자 데이터 디렉터리에 저장한다. Git은 `dugite`를 사용한다. 로컬 앱 외 cloud runtime 경로도 있지만, 이를 MYSCube의 서버 권한·테넌트 분리와 같다고 볼 수 없다.

- [패키지와 빌드 정의](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/package.json)
- [SQLite 초기화와 저장 위치](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/db/index.ts#L20-L69)
- [IPC 대화 처리 진입점](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/handlers/chat_stream_handlers.ts)
- [Git 실행 어댑터](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/utils/git_utils.ts#L1-L32)

## 요청에서 변경·검토·실행까지

| 단계 | 실제 소스에서 확인한 행동 | MYSCube에 적용할 패턴 |
| --- | --- | --- |
| 요청 접수 | turn intent/request ID로 중복을 확인하고, 사용자 메시지 삽입과 모드·모델 선택을 SQLite transaction 안에서 확정한다. | 기존 서버 대화 turn/CAS를 유지하고, 생성 제안이 어느 요청·기준 버전에서 나왔는지 저장한다. 브라우저가 보낸 history를 원본으로 삼지 않는다. |
| 여러 파일 변경 | legacy 응답은 write/search-replace/rename/delete 태그를 모아 제안한다. 적용기는 삭제→이름 변경→쓰기 순서를 따른다. Agent `write_file`은 경로 검증과 파일별 lock 후 실제 파일을 쓴다. | 파일 목록을 선언한 변경 제안과 기준 source tree hash를 먼저 만든다. 모든 경로·import·중복·크기를 전체 검사한 뒤 새 소스 트리를 만든다. 모델 XML을 실행 명령으로 사용하지 않는다. |
| 승인 | legacy `approve-proposal`은 특정 assistant 메시지를 조회해 변경을 적용한다. Ask 모드는 거절한다. Agent 메시지는 이미 실행된 도구 기록이므로 legacy 승인 목록에서 제외된다. | `제안 생성 → 차이 확인 → 적용 → 저장`을 분리한다. 모델의 “승인됨” 문자열로 실제 승인 상태를 만들지 않는다. |
| 이력 | 실제 변경을 Git에 모아 commit하고 해당 SHA를 메시지에 연결한다. 변경이 없으면 commit을 만들지 않는다. | Firestore 불변 버전이 저장의 기준이고, Git 전달은 선택한 정확한 버전의 source tree hash를 참조한다. Git 실패를 저장 성공으로, 저장 성공을 Git 전달 성공으로 표시하지 않는다. |
| 진단과 재시도 | 타입 검사, production build, 일시적인 모델 스트림 재시도는 별도 경로다. 검사 불가를 성공과 구분하고 반복 예산을 둔다. | parse/type/bundle/runtime를 별도 결과로 남기고, 진단을 받은 제한된 수정 루프만 허용한다. 변경 없는 반복·시간 초과·취소는 중단한다. |
| 미리보기 | 앱별 runtime/proxy 상태와 iframe 상태를 관리한다. 오래된 실행 callback을 invocation ID로 거절하고, Git 과거 버전 조회/복원도 별도 상태기계로 조정한다. | 기존 원격 후보 session과 현재 session을 분리한다. 새 후보 실패는 마지막 정상 화면을 유지하고, API 권한 철회는 민감 결과를 숨긴다. 이전 callback이 새 실행을 덮지 못하게 한다. |

근거: [요청 transaction](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/handlers/chat_turn_acceptance.ts#L83-L221), [파일 적용 순서](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/processors/response_processor.ts#L381-L580), [Agent 파일 쓰기](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/tools/write_file.ts#L31-L109), [승인·거절 처리](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/handlers/proposal_handlers.ts#L364-L472).

### 승인은 하나의 공통 동작이 아니다

legacy Build의 자동 적용은 설정 `autoApproveChanges`와 모드에 따라 달라진다. 자동 적용이 켜져도 파괴적 SQL은 같은 자동 경로로 처리하지 않는다. Agent의 구조화된 transcript는 이미 실행된 도구 기록이므로 legacy 승인 제안으로 다시 실행하지 않는다. Agent 턴 종료에는 별도로 `approvalState: approved`가 저장된다. 따라서 “Dyad는 언제나 사용자가 제안을 승인한 뒤 모든 파일을 변경한다”는 설명은 틀리다.

- [legacy 자동 적용 조건](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/handlers/chat_stream_handlers.ts#L3173-L3189)
- [Agent transcript 재적용 방지](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/handlers/proposal_handlers.ts#L137-L166)
- [Agent 턴 끝 버전화·승인 상태](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts#L2319-L2364)

계획 승인은 더 명확한 참고점이다. `exit_plan`은 모델이 `confirmation:true`를 냈다는 사실만으로 승인하지 않는다. 저장된 정확한 계획 버전을 읽어 실제 사용자 결정 요청을 만든다. MYSCube도 제안 hash/기준 버전/연결 API 버전이 바뀌면 이전 적용 의사를 새 제안에 재사용하지 않아야 한다. [실제 계획 승인 코드](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/tools/exit_plan.ts#L63-L100)

### Git checkpoint는 검증이나 배포와 다르다

legacy 적용기는 staged diff가 있을 때 commit하고 메시지에 SHA를 기록한다. Agent는 턴 끝의 변경을 모아 checkpoint를 만든다. 저수준 commit은 외부 repository hook이 암묵적으로 실행되지 않게 임시 빈 hooks 디렉터리를 사용한다. Agent 쪽 주석도 검증은 `run_pre_commit`이 담당하며 실패한 hook 때문에 버전화가 막히지 않게 한다고 명시한다.

이는 검토 가능한 이력 패턴이다. **커밋이 있으니 검사 통과**, **커밋했으니 GitHub PR 생성**, **PR 생성했으니 배포 완료**로 묶으면 안 된다. MYSCube는 저장한 소스/실행본/진단/검토 PR의 식별자를 각각 연결해야 한다. 또 Dyad의 `gitAddAll` 또는 남은 변경까지 amend하는 동작은 한 사용자 로컬 작업 트리라는 가정이 강하다. 여러 사용자 서비스에서 그대로 사용하면 다른 변경이 섞일 수 있다.

- [legacy commit과 SHA 저장](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/processors/response_processor.ts#L702-L803)
- [Agent commit coordinator](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/processors/file_operations.ts#L236-L300)
- [hook 없는 저수준 commit](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/utils/git_utils.ts#L913-L950)

### 진단은 실패 종류와 실행 여부를 보존한다

`run_type_checks`는 전체 프로젝트를 검사한 결과 중 요청 경로를 표시할 수 있고, 그 밖의 오류도 존재 여부를 알린다. `tsconfig` 오류로 검사가 완주하지 못하면 `incomplete`다. 검사기는 로컬 TypeScript CLI를 `--noEmit`으로 실행하고 5분·출력 4MiB 제한을 두며, 강제 종료 후 실제 close 전까지 실행 슬롯을 반환하지 않는다.

`run_build`는 별도 검증이다. 활성 미리보기를 방해할 수 있으면 임시 worktree와 별도 의존성을 준비한다. 동일 앱 동시 build와 관련 변경 없는 반복을 제한하고, 준비·설치·build를 포함한 총 10분 기한을 사용한다. **이 worktree는 보안 sandbox가 아니며 사용자 권한으로 프로젝트 코드가 실행된다**는 안내가 소스에 있다. MYSCube는 이 실행 방식 대신 현재의 제한된 compiler와 독립 renderer 경계를 유지해야 한다.

- [타입 검사 도구의 범위·incomplete](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/tools/run_type_checks.ts#L30-L149)
- [실제 CLI와 종료·출력 경계](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/processors/tsc.ts#L421-L580)
- [build 정책과 사용자 권한 실행 안내](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/tools/run_build.ts#L377-L420)
- [변경 없는 재실행 거절·실제 build 결과](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/tools/run_build.ts#L465-L625)

모델 스트림 재시도는 코드 오류 수정과도 다르다. Agent는 tool step 상한과 abort signal을 사용하며, 일시 종료에 대한 재시도에서는 완료된 tool-call/result 쌍을 transcript로 재구성한다. 이것만으로 외부 side effect의 exactly-once가 보장되지는 않는다. MYSCube의 저장 receipt·operation key·권한 범위 검사는 유지해야 한다. [도구 반복 기한](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/local_agent_handler.ts#L1393-L1440), [완료된 도구 쌍 재생](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/main/ipc/handlers/local_agent/retry_replay_utils.ts#L126-L160)

### 미리보기의 상태와 코드 복원을 분리한다

Dyad의 iframe 상태에는 URL history, iframe epoch, selector readiness, 오류 출처가 있다. runtime/proxy는 실행 invocation을 대조해 오래된 callback을 거절한다. 과거 Git 버전 보기·원래 branch 복귀·복원은 `version_preview_service`와 별도 actor 상태를 사용하며, 중단된 복원은 recovery-required로 남긴다.

이것은 참고할 상태 관리 구조다. 그러나 읽은 Dyad 경로를 **TOI처럼 후보 bundle이 성공한 경우에만 문서를 교체하는 동일 구현**으로 설명할 근거는 없다. 로컬 실행 경로는 실제 앱 command를 shell child process로 띄운다. MYSCube는 기존 원격 renderer의 `sessionId`, source hash, frame sequence, 후보/현재 구분으로 이 요구를 구현해야 한다.

- [iframe 상태와 오류 종류](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/preview_iframe/state.ts#L26-L117)
- [오래된 runtime callback 거절](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/services/app_runtime_service.ts#L389-L414)
- [로컬 Node 앱 실행](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/services/app_runtime_service.ts#L512-L551)
- [버전별 checkout/return/restore](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/services/version_preview_service.ts#L56-L127)
- [중단된 복원 상태의 재조정](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/ipc/services/version_preview_definition.ts#L115-L240)

## Toss 공식 자료와 공개 소스 확인 범위

[공식 TOI 아티클](https://toss.tech/article/52885)은 등록 API의 요청·응답 스키마를 모델에 제공하고 정책은 서버 proxy가 맡는 구조를 설명한다. 실행은 layered 가상 파일 저장소, esbuild-wasm, 패키지 조합의 lockfile/public entry 해시, 사전 build한 패키지와 import map, 성공한 새 HTML 문서의 교체로 나눈다. 에러 때 마지막 정상 화면을 유지한다. 글의 47초→1.3초는 Toss가 보고한 측정값이며 MYSCube의 성능 결과가 아니다.

2026-09-24 확인한 해당 글의 링크, [공식 toss 조직](https://github.com/toss)의 paginated 공개 저장소 목록의 이름·설명, 공식 조직 대상 검색에서는 TOI/Preview Runtime의 완전한 공식 구현 저장소를 확인하지 못했다. 글의 예제는 설계 참고 자료다. 공개된 구현이 전혀 없다고 단정하지 않으며, 제3자의 이름이 비슷한 저장소를 Toss 소스로 소개하지 않는다. **매번 Git에 커밋한다는 사실도 이 글로는 확인되지 않는다.**

## MYSCube의 정확한 적용 대상 — 제안이며 이 문서에서 구현하지 않음

조사 시점 MYSCube는 `react-pages.mjs`의 `ReactSourceSchema={title,code}`와 단일 `App.tsx` generation/compile 계약이다. 아래는 이를 확장할 대상이며 이미 구현됐다는 뜻이 아니다.

| 대상 파일 | 적용할 변경 | 완료 판정 |
| --- | --- | --- |
| `server/workbench/react-pages.mjs` | schema version이 있는 `{entry, files:[{path,content}], packageSetHash}`와 정규화된 전체 tree hash. 기존 단일 파일 저장 형식은 명시적으로 읽기 호환. 제안에는 기준 버전/hash와 변경 파일·진단을 포함. | 파일 A가 B를 import하는 실제 3파일 fixture의 생성→저장→재조회→복원 결과와 전체 hash 일치. 경로 탈출·중복·덮어쓴 기준 버전은 거절. |
| `server/workbench/react-compiler.mjs`, `react-compiler-worker.mjs` | 여러 파일 VFS와 허용된 상대 import를 같은 resolver로 처리. 패키지는 등록된 조합만 허용. type check와 bundle 결과를 분리해 각 source hash에 연결. | 유효한 그래프 통과, 없는 import/순환의 실제 compiler 결과/타입 오류/시간 초과 검증. 검사 미실행은 통과로 표시하지 않음. |
| `server/workbench/react-conversation.mjs` | 요청→제안→진단→수정의 서버 turn 관계를 보존. 실제 진단을 다음 제한된 수정 시도에 제공하고 권한·API 버전을 매 단계 재확인. | clarification에서는 편집 내용을 바꾸지 않음. 실패한 수정 루프가 마지막 적용 버전을 덮지 않음. 취소·늦은 응답·같은 요청 재시도에서 중복 적용 없음. |
| `workbench/ReactStudio.tsx` | 파일별 차이·진단·적용 대상 버전 표시. 현재 편집, 아직 적용하지 않은 제안, 실행 중 버전, 저장 버전을 구분. | 제안 적용은 명시적 사용자 동작. 제안 대기 중 직접 편집/새 세션/새로고침 후에도 오래된 제안이 조용히 덮지 않음. |
| `workbench/RemoteReactPreview.tsx`, `server/workbench/remote-runtime/` | 기존 격리 실행을 유지하며 새 source tree hash와 실행 후보 ID 연결. 성공한 후보만 현재 화면으로 승격하고 이전 세션 정리. | 성공 A→실패 B는 A 유지, 느린 B→새 C는 B 승격 금지, 권한 철회는 값 숨김. 준비시간과 실제 표시시간을 따로 기록. |
| `server/workbench/git-delivery.mjs` | 선택한 불변 버전의 전체 파일 트리와 manifest를 단일 Git tree/commit에 전달. 예상 base/head와 API pin을 검증하고 draft PR로 연결. | PR의 각 파일 hash가 저장 버전과 일치. 다른 사용자 파일·조회 응답·secret 미포함. 저장/미리보기/PR/merge 상태 독립 표시. |

공통 진단 결과는 `stage(parse/type/bundle/runtime)`, `status(passed/failed/not_run/incomplete)`, `sourceTreeHash`, 파일·행·열, 시작/완료 시각, 제한 내 출력, 수정 시도 번호를 보존하는 구조를 권한다. 이는 이 문서의 설계 제안이다. 속도는 cold/warm, 생성 시간, type/bundle 시간, runtime 준비 시간, 화면 표시 시간으로 나누고 p50/p95를 실제 측정해야 한다. Toss 수치를 목표 근거 없이 복사하지 않는다.

## 가져오지 않을 가정과 라이선스

- Electron trusted IPC, 로컬 SQLite, 사용자 파일 시스템·shell·패키지 설치 권한은 웹 서버의 테넌트 권한과 다르다. MYSCube의 source-copy/read-only API/격리 renderer를 로컬 앱 권한으로 대체하지 않는다.
- Dyad의 도구에는 의존성 설치, SQL·외부 함수 배포 같은 side effect도 존재한다. 여러 파일 화면 생성에 필요하지 않으므로 같은 권한을 추가하지 않는다.
- 상태기계의 구조는 참고하되 repository checkout과 사용자 작업 트리 공유를 서버 세션의 격리 수단으로 사용하지 않는다.
- [최상위 LICENSE](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/LICENSE)는 `src/pro/`를 별도 라이선스로 두고 나머지는 Apache-2.0으로 명시한다. [src/pro/LICENSE](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/src/pro/LICENSE)는 **FSL-1.1-ALv2**, 경쟁적 제공 제한과 해당 버전 공개 후 2년 뒤 Apache-2.0 전환을 명시한다. 이번에 읽은 Agent 도구·반복·build 도구 상당수가 이 경로에 있다. `package.json`의 MIT 표기만으로 전체 저장소를 MIT라고 판단하면 안 된다. 이번 작업은 원문을 제품에 복사하지 않고 동작 패턴을 독립 설계하는 범위다.

## 검증과 남은 확인

공식 source의 요청 transaction, 파일 쓰기, 승인 경로, commit, 진단, preview 상태를 직접 읽었다. 참고 테스트도 읽었지만 실행하지 않았다: [파일 반영→preview E2E](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/e2e-tests/approve.spec.ts), [실제 타입 오류→Problems UI E2E](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/e2e-tests/local_agent_run_type_checks.spec.ts), [버전 preview lifecycle E2E](https://github.com/dyad-sh/dyad/blob/39fbae87b38573616a1a3b152cdb292787bb1109/e2e-tests/version_preview_lifecycle.spec.ts).

문서만 추가했으므로 브라우저/운영 데이터 QA는 이 조사에서 요구하지 않는다. 실제 MYSCube 기능 완료 판정에는 위 표의 저장·재조회·권한·브라우저·PR 대조 시험이 별도로 필요하다. 임시 clone의 프로그램 실행이나 외부 제품의 품질을 확인한 것처럼 보고하지 않는다.
