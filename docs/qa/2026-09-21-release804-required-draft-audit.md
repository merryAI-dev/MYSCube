# Release 804 필수값·임시저장 독립 QA

## 판정과 범위

배포 SHA `24e450885766f2f2201ae14286f38029d234609c`를 별도 디렉터리 `/tmp/myscube-804-required`에 추출하여 검증했다. **검증한 필수 응답·조건부 이자·기존 사업비 입력 방식·임시저장 버전 비교 회귀는 PASS**다. 운영 데이터 전체가 최신 필수값 정책을 충족한다거나 모든 화면을 운영 브라우저에서 직접 확인했다는 뜻은 아니다.

운영 쓰기, 제출, 승인, 데이터 보정은 하지 않았다. 제품 코드 변경도 하지 않았다. 테스트 harness의 context export와 로컬 callback만 격리 디렉터리에 추가했다. 운영 CUA 브라우저는 부모 에이전트가 apps/browsers 공란 및 native pipe 실패를 확인하여 접속하지 못한 상태다. 아래 브라우저 증거는 배포 소스의 실제 컴포넌트를 로컬 Chromium에서 실행한 결과다.

## 최신 운영 읽기 자료의 임시저장 전수 집계

`/tmp/myscube-804-audit/evidence.json`은 2026-09-21 16:23:49~16:23:57 KST 읽기 자료다. 프로젝트79건, 요청125건, 임시저장 두 컬렉션235건을 포함한다. 이 문서의 전수 집계는 235개 최상위 문서의 형태와 상태다. 각 과거 버전 subcollection 및 첨부 실체를 전수 조회한 자료는 아니다.

| 대상 | 문서 수 | 확인 내용 |
|---|---:|---|
| 프로젝트 수정 초안 `project-info` | 66 | revision·ownerUid 모두 존재. ACTIVE37건은 payload 존재. SUBMITTED29건은 payload 없음 |
| 신규 등록 초안 `project-registration` | 61 | revision·ownerUid 모두 존재. ACTIVE28·DISCARDED23건은 payload 존재. SUBMITTED10건은 payload 없음 |
| 구형 등록 문서, resourceType 미기록 | 107 | 새 draftRevision·ownerUid·payload 구조가 아님. 최신 초안과 합쳐 유실로 판정하지 않음 |
| cashflow 초안 | 1 | 집계상 존재만 확인. 이번 변경/검증 대상 제외 |

프로젝트용 최신 구조127개 모두 `historyGeneration`이 최상위 문서에 없었다. 기존 세대는 생성시각을 쓰는 호환 경로가 있으므로 이 사실만으로 버전 관리 실패라고 할 수 없다. 반대로 이번 snapshot에는 history subcollection이 포함되지 않아 실제 사용자마다 과거 내용이 얼마나 보존되었는지 보장할 수도 없다. 운영에서 저장하지 않고 이력을 검증하려면 소유자 권한으로 history GET의 응답을 추가 확인해야 한다. 최신 번호가 더 올바른 내용이라는 추론은 하지 않았다.

집계 증거: `/tmp/myscube-804-required-evidence/fresh-draft-summary.json`.

## 실제 컴포넌트 브라우저 회귀

- 이자 반납: 정산 적용 시 공란은 필수 오류를 표시한다. 공란 상태에서도 임시저장 callback이 성공하고 공란을 보존한다. 확인 필요를 직접 선택하면 필드 오류가 해소된다. 정산 없음 조건에서는 해당 필드와 필수 오류가 없다.
- 사업비 입력 방식: 기존 BANK_UPLOAD는 계약/재무와 제출 전 확인 화면에 `통장내역 업로드`로 동일하게 표시한다. DIRECT_ENTRY는 `직접 입력`으로 표시하고 readonly다.
- 선택 서류4종: 해당 없음 선택을 임시저장 payload의 명시적 사유로 보존한다. 해당 없음 선택 후 링크 입력·체크 해제 시 입력한 링크가 저장 payload에서 삭제되지 않는다.
- 필수 응답7종: 해당 없음 응답을 저장하고, 보험·퇴직금·고객사 정산 확인의 아니오3종을 false로 보존한다.
- 버전 관리5항목: 선택한 이전 내용과 마지막 저장 내용을 비교한다. null/0 및 미기록/false를 구별한다. 비교가 현재 작성값을 덮어쓰지 않는다. 이력 재조회 실패 후에도 현재 작성값과 직전 비교 결과를 보존하며 오류를 표시한다.
- 위 브라우저 스크립트 전부 PASS, JavaScript pageerror 0건. `bank-required.png`, `responses.png`, `version-panel.png`는 직접 육안 확인했다. 전체 프로젝트79건의 모든 페이지를 여기서 육안 검토한 것은 아니다.

증거 디렉터리: `/tmp/myscube-804-required-evidence/interest`, `/tmp/myscube-804-required-evidence/required`. 브라우저 데이터는 합성 fixture이며 저장 callback은 로컬이다.

## 서비스와 정책 검증

배포 소스에서 BFF 수정/등록 초안 route/service 테스트135개, draft persistence/request 테스트7개, shared submission fields 테스트5개가 통과했다(총147개). 실제 서비스 테스트에는 원본과 제출본 분리, 명시적 없음 보존, 필수값 거절 시 초안 보존, 이력 소유권, 원본 공백 보존, 재기안 세대, 상태 정정→제출→조직장 승인 흐름이 포함된다. 테스트 저장소는 fake DB이며 운영 Firestore transaction을 실행한 증거는 아니다.

공유 fields의 `.mjs` 테스트는 기본 Vitest include에 잡히지 않아 격리 전용 config로 명시 실행했다. 직접 node 실행은 Vitest 런타임이 없어 실패했으며 올바른 runner로 재실행한5개 통과 결과를 판정에 사용했다.

로그: `tests.log`, `platform-tests.log`, `fields-tests.log` (위 증거 디렉터리).

주정산·월결산·JVM 파이프라인은 이 QA에서 변경하지 않았다. 금액 및 첨부 링크 전체 대조와 최신 운영 필드 매트릭스는 별도 담당 결과와 합쳐 최종 판정해야 한다.

## 후속 보완: 운영 현재 작성 회차의 history 직접 조회

16:28:19~16:28:28 KST에 배포 코드 `projectDraftHistoryCollectionPath`를 직접 호출해 최신 구조127개 초안의 현재 작성 회차 경로를 산출하고, Firestore REST **GET만** 사용하여 `/history/{generation}/revisions`를 조회했다. 동시 요청은4개로 제한했고, nextPageToken이 사라질 때까지 조회하도록 했다. 인증 토큰은 subprocess 메모리로만 받아 출력하지 않았다. 경로와 응답 원문은 권한0600으로 `/tmp/myscube-804-required-evidence/history-paths.json`, `history-raw.json`, `history-summary.json`에 보관했다.

- 127/127 경로 조회 성공, 오류0, 실제 revision 문서 **0개**.
- 수정66개, 등록61개 모두 현재 작성 회차의 history가 비어 있었다.
- 따라서 배포 코드 `readProjectDraftHistory`에 따르면 현재 초안 내용을 한 항목으로 반환하는 fallback이 적용된다. 현재 revision 범위는 수정0~695, 등록0~84였다. 큰 revision 번호만으로 과거 내용을 비교·복원할 수 있다고 안내하면 안 된다.
- 활성 초안65개의 현재 payload 보존 사실과 과거 버전 보존 여부는 별개다. 현재 조회 결과로는 이65개에서 과거 버전 내용을 직접 비교할 수 있다는 주장을 뒷받침하지 못한다.
- 생성 세대의 history 경로만 조회했다. 과거 다른 generation의 모든 경로가 없다고 단정하지 않는다. 16:23 snapshot을 기준으로 산출했으므로 그 후 사용자가 새 작성 회차를 만들었다면 이번 조회 대상과 다를 수 있다. 이전부터 존재한 이력을 DB 수정 없이 복원할 수 있다고 주장하지 않는다.

판정 보완: **새 저장 이후의 이력 보존 코드·테스트와 비교 UI는 통과하지만, 현재 운영 초안의 과거 버전 비교 가능성은 미충족**이다. 이력 없음/보관 시작 이후만 비교 가능하다는 안내가 필요하며, 현재 초안을 삭제하거나 다시 저장하도록 강요해서는 안 된다. 이 QA는 저장을 하지 않았으므로 새 운영 history를 생성하지 않았다.

## 후속 BFF projection 누락 후보 분류

부모가 실제 배포 BFF builder로 요청125건을 실행한 `bff-projection.json`을 독립 대조했다.

- `groupwareName` 미포함15건은 제출값이 모두 빈 문자열이었다. 원장도12건 빈 문자열,3건 미기록이다. 실제 입력된 이름이 이번 projection에서 없어졌다는 증거는 없다. 다만 이 분류는 유의미한 새 값 삭제 요청의 동작을 검증한 것은 아니다.
- `teamMembers` 요약122건 미포함은 Project의 정규화 대상 `teamMembersDetailed`와 구별해야 한다. 요약은 제출 snapshot에 남지만 canonical Project에 같은 필드로 투영하지 않는다. 상세배열이 비어 있는데 요약 문자열이 truthy인8건은 모두 `-` placeholder여서 인력 이름 누락으로 판정하면 과잉 탐지다.
- 위8건 중 PENDING3건을 배포804 actual document DOM으로 재현했다. `pr-1780637497720`, `pr-1784700960534`, `pr-1785412752753` 모두 저장된 참여율 기록 없음/시트 링크 미등록을 표시했다. 요약의 실명 정보를 UI가 숨겼다는 증거는 없었다. `/tmp/myscube-804-required-evidence/team-summary`에 응답·캡처를 보관했다.
- 상세키가 없는 구형3건은 실제 요약 문자열이 있으며, actual DOM에서 인원 수1/1/7명이 표시되어 dossier의 구형 요약 fallback이 적용됨을 확인했다. 다만 문서의 해당 행은 인원 수만 표시하며 요약 전체 문자열의 표시를 보장하지 않는다. 이를 최신 상세인력·ID·월별 참여율로 자동 변환하거나 유효한 상세 인력이라고 인증하지 않는다. 증거는 `team-legacy-summary` 디렉터리다.
- PENDING `change-p1773817948751`은 요청base26/target27, 현재 원장version57이다. GET readiness의 버전 검사 순서에 따라 현재 예고할 차단 사유는 `canonical_version_conflict`다. 그 다음 builder를 별도 실행하면 `participation_sheet_link_missing`이 발생한다. 원장 버전을 맞추는 과정 이후 링크 누락 문제가 추가로 드러날 수 있으므로, builder 단독 오류를 현재 실제 GET의 표시 사유와 동일시하면 안 된다. 배포 함수 실행 증거: `readiness-version-before-link.json`. 인증된 운영 GET 자체를 실행한 것은 아니다.
