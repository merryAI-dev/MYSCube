# S27 — 실시간 연결 리뷰 수정과 전사 집계

## 승인된 순서

1. 이번 AXR PR: 완료된 HTTP 실패의 실행 자리 반환, 명시적 활성화, 인증 보관 포화 격리, 권한 회수 브라우저 fixture 수정(리뷰 1–4).
2. 사용자 선택: BFF에 읽기 전용 전사 집계 API 추가(리뷰 5의 A). 기존 주정산·월결산 쓰기·동기화 경로는 변경하지 않는다. main 기반 별도 PR로 작업하며 오래된 AXR 브랜치의 BFF를 main에 합치지 않는다.
3. 집계 계약에 맞춰 부분 합계의 호스트 표시 강제와 사업 간 주차 달력 검증(6–7). 전체 대상 및 각 필드가 확인되기 전에는 완전한 전사 합계라고 표시하지 않는다.

## 이번 버그 수정의 실제 경로

- `myscube-live-api`: 취소·응답 없는 실패·502/503/504만 원본 25초 예산을 유지한다. 오류 안내와 실행 자리 반환은 같은 조건을 사용한다. 완료된 401/403 등은 실제 전송 종료 뒤 바로 반환한다. 속도 제한과 동시 한도는 유지한다.
- `app`: `WORKBENCH_MYSCUBE_LIVE_ENABLED=true`에서만 연결하며 env를 강제로 바꾸지 않는다. 미설정은 비활성이다.
- 공통 인증 미들웨어: 보관 포화 `myscube_live_busy`만 무시한다. 실제 인증 실패·권한 회수는 계속 차단한다. 101번째 사용자의 일반 대화·저장은 정상 작동하고 보관되지 않은 인증의 실시간 조회는 401이다.
- `remote-dom-worker.e2e`: 회수 후 늦은 GET/DELETE에 403을 반환하여 실제 broker 호출 전에 멈춘다. 제품 권한 구현을 바꾼 것으로 표현하지 않는다.

검증: HTTP 상태별 실행 자리 회귀는 수정 전 6개 실패, 수정 후 통과. 실제 기본 보관 100개를 HTTP로 채운 뒤 101번째의 대화 생성·React 저장·재조회·권한 회수를 검사했다. 관련 서버 46/46 통과. 실제 compiled worker 브라우저 및 독립 재실행 각각 1/1 통과.

## 더미 화면 신고의 운영 근거

2026-09-28 AXR의 승인 계정에 대해 실제 페이지 서비스를 통한 읽기 전용 확인을 수행했다. 저장 화면 3개 중 React 1개(v2)는 canonical 실행 예제와 byte-exact 동일하며 API 연결이 없었다. HTML 2개(v1)도 canonical 미연결 레이아웃과 동일하며 dataBinding/조회 근거가 없었다. 가짜 재무 수치를 조회한 증거가 아니라 예제 화면이 저장된 상태다. 별도 등록 API 목록에는 실시간 2개 포함 6개가 존재한다.

따라서 API 등록과 기존 저장 화면의 실제 자료 연결은 구분해야 한다. 기존 저장본을 임의 덮어쓰지 않는다. 현재 사용자가 어느 탭/대화를 보는지는 이 DB 확인만으로 단정하지 않는다. 로그인 인증을 전달한 실제 MYSCube 조회는 아직 미검증이고, 기존 AXR 서버의 인증 없는 상류 요청은 Cloudflare 403이었다.

## 다음 커밋 설계의 제약

원본 main에는 `/insight-cashflow-report`가 있지만 최대 50개 사업이다. 새 전사 집계는 대상 목록 완전성, 권한, 기간, 사업별 조회 성공/실패/미조회, 금액별 포함/제외와 관측 시점을 함께 제공해야 한다. 요청 시간·크기·동시 실행은 제한하고, 제한에 걸리면 부분 결과임을 명시한다. 합계의 완전성을 프롬프트에만 맡기지 않는다.

주차 달력은 현재 cashflow 공통 함수에서 생성된다. JVM의 별도 비용 시트 주차와 혼동하지 않는다. 실제 반환된 사업 간 `[weekNo, start, end]`를 비교하고, 불일치한 주차의 교차 사업 합계는 제공하지 않는다. 실제 JVM 읽기 결과와의 대조가 끝나기 전 운영 달력 상태는 확인 필요다.

## 후속 정리 — 이번 1–4 커밋에서 변경하지 않음

- 8: 실시간 연결 불가와 화면 연결 조건 불일치 오류 코드 분리.
- 9: 이름 접두어 라우팅을 명시적 `source` 기반으로 바꾸되 기존 등록 불변 버전의 호환 방식을 먼저 정한다.
- 10: 근거 쓰기 전 응답 크기 검사. 실시간 근거의 보존 기간·만료 정책 결정 필요. 임의 기간으로 기존 증거를 삭제하지 않는다.
- 11: 실시간 원문 전체를 모델에 전달하지 않도록 행 수·상태·합계 범위 중심으로 축소하고 기존 사본 경로의 모델 전달 정책과 대조.
- 12: 인증 보관과 실제 사용의 토큰 형식·길이 검증을 하나로 통일.
- 13: 죽은 분기, 중복 검사, DNS 첫 주소 실패 처리, 반복 정의 접근 정리. 전송 계층의 실제 바이트 한도와 테스트 대역을 함께 검토한다.

범위 밖 기록: `server/bff/routes/projects.mjs`의 `{ id: doc.id, ...doc.data() }`는 저장된 id가 문서 ID를 덮어써 다음 페이지 위치가 틀릴 수 있다. 기존 목록 API는 이번 변경에서 수정하지 않는다. 신규 집계는 Firestore 문서 ID를 기준으로 대상 목록을 읽어야 한다.

유지: 형식 불일치 거부, 요청 순서 기반 인증 갱신, API 정의·endpoint 해시·입력 조건과 실제 조회 근거 대조.

## 부분 합계와 주차 표시의 호스트 검증

기존 등록 API v1의 응답 스키마·정의 해시는 바꾸지 않는다. 페이지 응답은 그대로 보존하고 조회 metadata에 `catalogComplete`, `accessibleInPage`, `weekCalendarUniform`을 추가한다. AVAILABLE 사업들의 `[weekNo,start,end]`를 정렬해 비교하며 확인 대상이 없으면 null이다. 불일치해도 월 원문을 버리지 않으며 주차 합산 불가 안내를 표시한다. 이 날짜는 BFF 고정 재무 달력에서 생성되며 원본 시트의 날짜 셀을 실측한 결과라는 뜻이 아니다.

BoundEvidence는 저장된 실제 조회 근거에서 페이지 범위를 읽고 **이번 페이지 N개 사업 합계 / 전사 합계 확인 필요**를 직접 표시한다. 모델이 생성한 문구에 의존하지 않으며 원격 React 실행도 같은 호스트 컴포넌트를 사용한다. 생성된 소스 전체의 제목이나 임의 금액을 자동 교정한다고 주장하지 않는다. 실시간 근거가 없는 화면은 확인된 재무 화면으로 취급하지 않는다.

검증: 사업 간 달력 일치·불일치·자료 없음 포함 어댑터 32/32, 실제 근거 저장/조회와 월 변경·권한 회수·범위 표시 브라우저 2/2. 앞선 1–4 전체 서버 검증은 1,296 통과/7 건너뜀.

## 새 전사 API 연결과 배포 순서

원본 BFF는 Draft PR #828에서 분리해 검증한다. AXR은 신규 `myscube-company-cashflow-summary` v1 정의를 추가하며 `WORKBENCH_MYSCUBE_LIVE_ENABLED=true`와 별도 `WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED=true`를 모두 요구한다. 기존 2개 v1 정의의 해시와 저장 연결은 유지한다. 기본 화면의 자동 선택도 활성·유일한 등록 API가 있을 때만 추가하며 저장된 화면의 선택은 바꾸지 않는다.

BFF 실제 합성 실행 결과(월/주/부분 결과)를 fixture로 보존해 AXR 계약과 대조한다. 기간·대상 수·사업별 상태·각 금액의 부분합/완전 합계·달력 모순은 표시 전에 거부한다. BFF20초 신규 조회 예산/50초 응답 마감에 맞춰 새 어댑터의 최대 대기는55초다. 원본 전사 API는 독립 분산 admission을 관리하므로 AXR은 전송 promise 종료 뒤 지역 슬롯을 반환한다. 기존 페이지 API의 불확실 실패25초 정책은 유지한다. 원격 화면의 해당 등록 API에만 서버가55초 예산을 부여하며 일반API10초와 화면 명령8초는 유지한다. 로컬 iframe 실행의12초 제한은 이번 원격 운영 경로 수정 대상이 아니다.

부분 전사 결과는 호스트에서 ‘전사 합계는 확인 필요 / 확인된 부분합’으로 표시한다. 페이지 조회와 달리 ‘이번 페이지 N개’라고 표시하지 않는다. 예제 안내 개선은 자료 연결 완료가 아니며 운영 인증을 거친 조회 성공을 별도로 검증해야 한다.

동시 작업 보호: #827의 Cloudflare 규칙과 User-Agent 배포(b369ec54)는 별도 진행이다. 그 배포 브랜치에 덮어쓰지 않고 별도 리뷰 브랜치를 사용한다. 현재 규칙의 허용 경로는 `/projects`, `/cashflow-evidence` 2개뿐이다. 새 `/company-cashflow-summary` 경로의 별도 규칙 검토·적용과 BFF 배포 확인 전에는 신규 연결을 활성화하지 않는다. 기존 환경에 명시 활성화 변수가 실제로 있는지도 배포 전 확인한다. 규칙·비밀값·운영 데이터는 이번 로컬 구현 과정에서 변경하지 않았다.

## 최종 로컬 회귀

- 복구한 별도 영구 작업 폴더에서 전체 AXR 서버 검증: 1,334 통과, 7 조건부 건너뜀(122 파일).
- AXR 프로덕션 빌드 통과. 기존 500KB 초과 번들 경고는 남아 있으며 새 기능의 실측 렌더링 성능 목표를 달성했다는 뜻이 아니다.
- 새 전사 어댑터·자동 선택·기존 페이지 어댑터 독립 검증 62/62, 저장 근거의 월/부분 전사 표시 브라우저 독립 2/2.
- 신규 전사 API의 불확실 실패에 표시되는 최대360초 재시도 안내는 BFF 분산 admission의 복구 상한이다. AXR 자체가 완료된 전송의 자리를360초 고정 점유하는 정책이 아니다.
- 월 응답 안의 주차별 세부 합계는 BFF 집계가 권위자다. AXR의 행별 재합산 검증은 선택한 조회 기간의 `periodTotals`와 최종 `totals`를 비교하며, 월 응답만으로 모든 주차 세부값을 독립 재계산했다고 주장하지 않는다.
- 리뷰 PR의 대상은 AXR 작업 브랜치다. CI 두 워크플로의 pull_request 허용 대상을 이 브랜치까지 추가했으며 push·운영 배포 트리거는 변경하지 않았다.


완전성 의미의 추가 검증: `complete=true`는 모든 대상 사업에서 저장된 집계 숫자를 받았다는 범위 표지다. JVM readModel은 셀 상태를 제공하지 않으며 일부 행만 기록되어도 다른 항목의 합산 결과가0일 수 있다(`accounting-read.mjs`의 `recorded` 판정, `WeeklyExpenseController.buildModeReadModel`, `CashflowWeekTotals.sumLines`). 모든 EMPTY가0으로 저장된다고 단정하는 것은 아니다. 그래서 완전/부분 결과 모두 호스트에 **저장된 집계값 기준 · 입력 상태 확인 필요** 안내를 강제하고, 모델이 보는 API 설명도 같은 의미로 제한한다. 기존 값이나 저장 로직을 변경하지 않는다.

### Host configuration compatibility

The bootstrap configuration schema accepts optional `WORKBENCH_MYSCUBE_LIVE_ENABLED` and `WORKBENCH_MYSCUBE_COMPANY_SUMMARY_ENABLED` switches as literal string `true` or `false`. Omission preserves existing environment output and leaves the connection inactive. Company summary activation requires live activation. This change does not alter deployed environment files, configuration hashes, release pins, credentials, or Cloudflare rules. Activation requires a coordinated configuration/pin update; the existing two-path edge rule does not authorize the new company-summary endpoint.
