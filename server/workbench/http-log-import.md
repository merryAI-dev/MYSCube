# 운영자가 내보낸 HTTP 기록 가져오기

이 기능은 운영자가 확보한 Vercel 기록에서 MYSCube BFF의 HTTP 응답 관측만 독립 저장소로 가져옵니다. 원본 서비스나 Vercel에 접속하지 않으며, 완전한 로그 수집 또는 전체 서비스 오류율을 보장하지 않습니다. 가져온 모든 자료에는 `operator_export_unverified` 출처가 붙고, 관측 범위는 `partial`, `sampled`, `unknown` 중 하나로 유지됩니다. HTTP 2xx도 실제 업무 완료를 증명하지 않습니다.

[Vercel 공식 로그 형식](https://vercel.com/docs/drains/reference/logs)의 고유 `id`를 로그 기록 중복 식별에 사용합니다. 앱의 같은 `requestId`가 여러 로그에 있어도 서로 다른 응답 완료 기록으로 보존합니다. 타임스탬프는 Vercel envelope의 Unix 밀리초 값만 사용하며, 앱 문자열에서 시간을 추측하지 않습니다. `lambda`의 JSON `bff.request`만 대상입니다. 선택 항목인 `type`은 없거나 `stdout`이어야 하며, 명시적인 `stderr` 등은 제외합니다.

## 입력

원래 JSON 배열 또는 NDJSON를 운영자가 확인하여 아래 v1 JSON 객체의 `entries` 배열에 넣습니다. CLI가 원본 형식을 자동 추측하지 않습니다. 파일은 최대 1,000,000바이트, 최대 200개 envelope입니다.

```json
{
  "schemaVersion": 1,
  "sourceSystem": "vercel",
  "sourceProjectId": "prj_approved",
  "tenantId": "approved-tenant",
  "exportedAt": "2026-09-23T10:00:00Z",
  "period": { "from": "2026-09-23T09:00:00Z", "to": "2026-09-23T10:00:00Z" },
  "coverage": "partial",
  "entries": []
}
```

`from < to <= exportedAt <= 현재 시각`이어야 합니다. 모든 envelope의 프로젝트가 일치하고 timestamp가 `[from,to)` 안에 있어야 합니다. 원본 필수 envelope 항목(id, deploymentId, source, host, timestamp, projectId, level)을 검증합니다. 대상 메시지는 service=`mysc-bff`, 승인 tenant, HTTP method, statusCode 100–599, 음수가 아닌 latencyMs를 요구합니다. native statusCode가 있으면 유효한 HTTP 상태이며 payload 상태와 같아야 합니다. 충돌이나 0·-1은 보정하지 않고 전체 파일을 거부합니다. native environment의 production은 live, preview는 preview, 누락은 unknown으로 유지합니다. 앱의 environment/deployEnvironment가 알려진 값이면 native와 일치해야 합니다. operation/operationKey가 있다면 실제 method/path 분류 결과와 일치해야 합니다. 잘못된 대상 메시지가 하나라도 있으면 전체 파일을 등록하지 않습니다. 비대상 로그는 ignoredCount에만 집계합니다. tenant가 없는 health·인증 전 BFF 요청이나 다른 tenant의 BFF 요청이 섞이면 전체 등록을 거부합니다. 승인 tenant로 확인된 관측 샘플을 가져오는 기능이며 전체 요청을 자동 수집하는 기능이 아닙니다.

## 실행과 접근 범위

기본 비활성입니다. 기존 독립 Workbench runtime의 네 가지 프로젝트 환경값에 더해 아래 명시적 설정을 사용합니다.

- `WORKBENCH_HTTP_LOG_IMPORT_ENABLED=true`
- `WORKBENCH_HTTP_LOG_SOURCE_PROJECT_ID=prj_approved`
- `WORKBENCH_TENANT_ID=approved-tenant`

```bash
node server/workbench/http-log-import-cli.mjs --file ./operator-export-v1.json
```

독립 작업자의 기존 자격증명만 사용하며 대상 Workbench Firestore에만 접근하도록 IAM을 구성해야 합니다. 이 코드가 권한이나 자격증명을 생성하지는 않습니다. 원본 Firebase·Vercel·주정산·월결산·JVM 접근은 없습니다. HTTP 업로드 경로나 사용자 API도 추가하지 않습니다. 실행 출력은 안전한 importId·기간·건수만 포함합니다.

## 저장 및 중복

`orgs/{tenant}/workbench_http_requests/{recordId}`에는 검증한 시각·서울 기준 일자·환경·HTTP method·업무 분류·응답 상태·지연·허용 오류 코드·전체 commit SHA 또는 null만 저장합니다. request/actor 식별자는 tenant와 종류를 분리한 SHA256 가명으로만 저장합니다. 가명은 익명 데이터가 아니므로 동일한 접근 통제가 필요합니다. 경로, 쿼리 문자열, 원본 메시지, 파일명, host, 사용자 입력은 저장하지 않습니다.

`recordId`는 원본 project와 native log id의 해시이고, `sourceRecordHash`는 recordId를 포함한 저장 내용의 canonical SHA256입니다. receipt는 `workbench_http_imports`에 기간·범위·recordIds·건수·importedAt만 남깁니다. 키 순서와 entries 순서가 다른 동일 JSON은 같은 importId입니다. 메시지 문자열 자체는 불투명 문자열이므로 그 문자열 변경은 별도 receipt가 될 수 있으나 같은 정제 기록은 중복 저장하지 않습니다.

모든 검증 후 기록과 receipt를 단일 Firestore transaction에 저장합니다. 겹친 기간은 native id로 중복 제거합니다. 같은 id의 정제 내용이 다르면 전체 등록을 거부합니다. 반복 실행은 기존 자료와 importedAt을 갱신하지 않으며 insertedCount=0입니다. 같은 앱 requestId의 다른 native log id는 별도 응답 완료 기록으로 남습니다. 현재 BFF가 응답 완료마다 한 줄을 남기는 동작을 전제로 하며, 완료되지 않아 로그가 없는 요청은 집계할 수 없습니다.

현재 검증은 합성 Vercel envelope와 실제 Firestore emulator를 사용합니다. 실제 운영 내보내기 자료, 운영 IAM, 완전한 Vercel 수집 여부는 검증하지 않았습니다.
