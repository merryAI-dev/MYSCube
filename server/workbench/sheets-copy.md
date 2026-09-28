# 읽기 전용 사업비 시트 사본 수집

`Sheets values.get → 고정 좌표 검증 → 독립 분석 저장소 → 기존 입금 질의` 경로입니다. 기존 주정산·월결산·JVM에는 연결하거나 쓰지 않습니다. 운영 기본값은 비활성입니다. **실제 Google Sheets 권한 연결과 운영 데이터는 아직 검증하지 않았습니다.**

서버 운영자가 승인한 로컬 manifest만 CLI에 전달합니다. 사용자가 URL·범위·인증 헤더를 입력하는 프록시가 아닙니다. manifest는 해당 tenant에 승인한 사업만 담아 배포하고, 각 사업의 weeklyYear는 단일 상수입니다.

```json
{"targets":[{"projectId":"approved-project","spreadsheetId":"approved-sheet-id","sheetName":"사업비","weeklyYear":2026,"currency":"KRW"}]}
```

활성화에는 격리된 `WORKBENCH_PROJECT_ID`, 관리자 조회 권한, `WORKBENCH_IMPORT_ENABLED=true`, `WORKBENCH_SHEETS_COPY_ENABLED=true`가 필요합니다. 기존 `resolveWorkbenchRuntime`이 운영 저장소와의 중복 연결을 차단합니다. 대상은 최대 100개이며 같은 사업·시트 중복은 거부합니다.

```sh
node server/workbench/sheets-copy-cli.mjs --manifest approved-sheets.json --tenant tenant-id --actor admin-id --month 2026-09 --weeks 1,2
```

CLI는 서버의 GoogleAuth로 `https://www.googleapis.com/auth/spreadsheets.readonly` scope만 요청합니다. 서비스는 `getToken({scope,signal})` 콜백으로 인증을 주입할 수 있습니다. 전용 읽기 자격증명과 승인 시트 공유는 운영자가 별도로 준비해야 합니다. 이 구현은 시트 공유·IAM·시크릿을 생성하거나 변경하지 않습니다. scope 요청 자체가 기존 자격증명의 다른 권한을 제거한다는 뜻은 아닙니다.

Google 공식 [values.get](https://developers.google.com/workspace/sheets/api/reference/rest/v4/spreadsheets.values/get)에서 고정 `'탭명'!A1:BT60`만 GET하며 작은따옴표는 A1 규칙에 맞춰 이스케이프합니다. [FORMATTED_VALUE](https://developers.google.com/workspace/sheets/api/reference/rest/v4/ValueRenderOption)와 ROWS를 사용하여 실제 표시 값과 직접 입력한 0원/빈칸을 구별합니다. 리다이렉트는 따르지 않습니다.

동시 조회 2개, 요청 및 개별 권한 확인 최대 10초, 원본 수집 전체 120초, 응답 1MB·전체 16MB 제한입니다. 원본 수집 기한 또는 호출 취소로 전체 작업이 중단되면 새 사본을 게시하지 않습니다. 독립 저장소의 사본 커밋은 기존 importer의 원자적 게시 정책을 따르며, 이미 시작한 Firestore 커밋을 네트워크 타이머로 취소했다고 주장하지 않습니다.

개별 시트 조회·인증·크기 오류는 그 사업을 `UNAVAILABLE`, 금액은 null로 보존합니다. 확인하지 못한 사업을 대상에서 빼거나 0원으로 채우지 않습니다. 받아 온 시트의 양식·주별 연도·좌표가 다르면 전체 등록을 거부하여 직전 정상 사본을 유지합니다. 수집 전/후 및 등록 전/후 관리자 권한을 다시 확인합니다. 원본 write 요청은 없습니다.

검증은 synthetic HTTP 서버, Firestore emulator, 실제 기존 입금 질의 엔진으로 수행했습니다. 합계·부분합·누락·명시적 0원, 중복/잘못된 기간의 사전 거부, 양식 오류의 기존 버전 보존, timeout/redirect/용량/취소/권한 철회를 확인합니다. 실제 연결 검증은 승인된 manifest와 읽기 자격증명이 준비된 뒤 별도 수행해야 합니다.
