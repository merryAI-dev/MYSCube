# MYSCube MCP (Cloudflare Worker)

`https://mcp.myscguard.app/mcp` 에서 동작하는 읽기 전용 원격 MCP 서버입니다. Claude, ChatGPT 등 MCP를 지원하는 클라이언트에 이 주소 하나를 등록하면 됩니다.

## 구조

```
MCP 클라이언트 ──OAuth 2.1──▶ mcp.myscguard.app (이 Worker) ──회원 본인 Firebase 토큰──▶ myscube.myscguard.app (BFF) ──▶ JVM / Firestore
```

- **리소스 서버 + 권한 서버**: `@cloudflare/workers-oauth-provider` 가 MCP 표준 OAuth(보호 리소스 메타데이터, 401 challenge, 동적 클라이언트 등록, CIMD, PKCE, 갱신 토큰)를 맡습니다. 토큰과 코드는 KV에 해시로만 저장되고, 사용자 정보(props)는 토큰을 가진 쪽만 풀 수 있게 암호화됩니다.
- **로그인**: 동의 화면 → 회사 Google 계정(`hd=mysc.co.kr`) → Firebase 세션 → BFF로 활성 구성원 확인. 구성원이 아니면 토큰을 발급하지 않습니다.
- **권한**: Worker 는 권한을 판단하지 않습니다. 모든 조회는 로그인한 구성원의 Firebase ID 토큰으로 BFF 를 부르므로, 앱 화면과 같은 역할·프로젝트 범위 검사를 받습니다.
- **세션 유지**: MCP 액세스 토큰 55분, 갱신 토큰은 쓸 때마다 30일 연장됩니다. 갱신할 때 Firebase 토큰도 갱신하며, 계정이 비활성화되면 그 시점에 연결이 끊깁니다.
- **도구**: `project_search`, `project_get`, `cashflow_status`, `accounting_read`, `sheet_check`, 그리고 검증된 조회 API 목록을 고르는 `api_catalog` / `api_read`. 목록은 `server/mcp/api-catalog.mjs` 에서 BFF 원격 MCP와 같이 씁니다. 조회를 늘릴 때는 그 목록에 GET 항목을 추가합니다.

## 배포

`main` 의 CI 가 초록이면 **MCP Worker Deploy** 워크플로가 `scripts/deploy-mcp-worker.mjs` 로 배포합니다. 앱(Vercel)·JVM 배포와 독립입니다. 스크립트는 KV(`myscube-mcp-oauth`)를 찾거나 만들고, 비밀값을 넣고, 공개 주소에서 보호 리소스 메타데이터와 401 challenge 를 확인합니다.

### 처음 한 번 필요한 설정

1. **Google OAuth 클라이언트** (Firebase 와 같은 GCP 프로젝트 `inner-platform-live-20260316`)
   - 유형: 웹 애플리케이션
   - 승인된 리디렉션 URI: `https://mcp.myscguard.app/callback`
   - OAuth 동의 화면: 내부(Workspace) 사용자
2. **GitHub `Production` 환경 비밀값**
   - `MCP_GOOGLE_CLIENT_ID`, `MCP_GOOGLE_CLIENT_SECRET`: 위 클라이언트
   - `MCP_FIREBASE_WEB_API_KEY`: MYSCube 웹 앱의 Firebase Web API 키(`VITE_FIREBASE_API_KEY` 와 같은 값)
   - `MCP_CONSENT_SECRET`: 32자 이상 임의 문자열(동의 기억 쿠키 서명용). 예: `openssl rand -base64 48`
3. **Cloudflare 엣지 예외**: `Cloudflare MCP Edge` 워크플로를 `apply` 로 실행해 `mcp.myscguard.app` 을 자동화 클라이언트 차단에서 뺍니다.

## 로컬 확인

```bash
cd mcp-worker && npm ci
printf 'GOOGLE_CLIENT_ID=x\nGOOGLE_CLIENT_SECRET=x\nFIREBASE_WEB_API_KEY=x\nCONSENT_SECRET=%s\n' "$(openssl rand -hex 24)" > .dev.vars
npx wrangler dev --local --local-protocol https --host mcp.myscguard.app
```

테스트는 저장소 루트에서 `npx vitest run mcp-worker/test` 로 실행합니다.

## EMA Station MCP (`https://ema-mcp.myscguard.app/mcp`)

같은 코드베이스의 두 번째 Worker(`wrangler.ema.jsonc`, 진입점 `src/ema/index.mjs`)입니다. EMA Station의 스타트업 등록(FRN) 데이터를 다룹니다. MYSCube와 KV·토큰·도메인이 완전히 분리돼 있어서 한쪽이 뚫려도 다른 쪽 세션은 노출되지 않습니다.

```
MCP 클라이언트 ──OAuth 2.1──▶ ema-mcp.myscguard.app ──구성원 본인 Firebase 토큰──▶ EMA Station 콜러블 함수
```

- **로그인**: EMA 계정은 이메일·비밀번호(가상 계정)라 Google 로그인을 쓰지 않습니다. 동의 화면 → EMA 사이트 `/mcp/authorize`(비밀번호는 거기서만 입력) → 사이트가 로그인 증명(ID 토큰·갱신 토큰)만 `POST /ema/session` 으로 보냅니다(허용 출처·같은 사이트 쿠키로 연결 요청에 묶음). 서버는 `getRegistryAccess` 로 권한을 확인한 뒤에만 토큰을 발급합니다.
- **권한**: Worker 에 권한 코드는 없습니다. 모든 호출은 구성원 본인 토큰으로 EMA 함수를 부르고, 함수가 `admin·consultant·staff`(읽기)와 `admin`(내보내기·일괄 등록)을 판단합니다. 관리자 도구는 관리자에게만 목록에 보입니다.
- **세션**: 액세스 토큰 55분, 갱신 토큰은 7일 미사용 시 만료, 최대 30일.
- **도구**: `ema_registry_status`(기본 진입점), `ema_registry_search`, `ema_registry_get`, `ema_registry_export`, `ema_registry_import_upload_link`, `ema_registry_import_preview`, `ema_registry_import_commit`.
- **엑셀**: 작은 표는 AI가 읽어 `rows`로 넘기고, 큰 파일은 1회용 업로드 링크(15분)로 올립니다. 내려받기는 1회용 링크(15분)로 파일을 전달하며 내용은 대화에 싣지 않습니다. 연락처·사업자번호 전체는 AI 대화에 나오지 않고(사업자번호는 가려서 표시) 파일에만 들어갑니다.
- **일괄 등록**: 미리보기(검증·중복 판정, 쓰기 없음) → 사용자 확인 → 등록. 삭제된 기업·이관 기업과 같은 행은 건너뛰고, 기존 기업의 값은 빈 칸만 채우며, 크레딧은 기본으로 부여하지 않습니다. 같은 배치를 다시 실행해도 중복 등록되지 않습니다.
- **배포**: `MCP Worker Deploy`의 `ema` 대상. GitHub `Production` 환경 비밀값 `EMA_MCP_FIREBASE_WEB_API_KEY`(EMA 웹 앱의 Firebase Web API 키), `EMA_MCP_CONSENT_SECRET`(32자 이상)이 필요합니다. 서버 쪽 함수와 연결 화면은 EMA_Station 저장소(`feat(registry)`)에 있습니다.

