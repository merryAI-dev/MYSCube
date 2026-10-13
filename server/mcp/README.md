# MYSCube MCP

> 운영용 원격 MCP 는 별도 서비스인 [`mcp-worker/`](../../mcp-worker/README.md)(`https://mcp.myscguard.app/mcp`)입니다. 아래 BFF 안의 `/mcp` 는 옮기는 동안 유지되며, 같은 도구 정의(`api-catalog.mjs`)를 씁니다.

읽기 전용 MCP입니다. 정산 데이터는 브라우저·Playwright·화면 크롤링이 아니라 BFF→JVM의 기존 정산 조회 경로에서만 읽습니다.

원격 MCP(`/mcp`)는 표준 MCP(Streamable HTTP + OAuth 2.1)라 Claude, ChatGPT 등 MCP를 지원하는 클라이언트에 같은 주소로 붙습니다. 모든 도구는 OAuth로 확인된 본인 권한으로 실행되며, Slack 봇의 감사 계정은 쓰지 않습니다.

| 도구 | 하는 일 |
|---|---|
| `project_search` | 사업명·약칭으로 권한 있는 사업을 찾아 projectId를 돌려줍니다. |
| `project_get` | 사업 기본 정보. 첨부·링크·연락처·검토 의견은 제외합니다. |
| `cashflow_status` | 여러 사업의 월·주 정산 상태와 P/A 차액. |
| `accounting_read` | 한 사업의 월/주차 계획·실적 입출금과 누적잔액(원장 반영값). |
| `sheet_check` | 사업비 시트를 지금 읽어 표준 양식과 다른 칸(칸 주소·고칠 내용)과 마지막 불러오기 오류를 돌려줍니다. 저장하지 않습니다. |
| `api_catalog` | 위 도구로 답할 수 없을 때 쓸 수 있는 검증된 조회 API 목록(id, 해시태그, params JSON Schema, 목록 버전 해시). |
| `api_read` | `api_catalog`의 id 하나를 실행합니다. 목록에 없는 id는 실행되지 않고, 결과의 링크·이메일·파일 위치 필드는 제거됩니다. |

조회 API를 늘릴 때는 라우트마다 도구를 만들지 않고 `remote-tools.mjs`의 `API_CATALOG`에 GET 항목 하나를 추가합니다. 각 API는 같은 프로세스 안에서 MCP 사용자의 context로 호출되어(`server/bff/internal-dispatch.mjs`), 앱 화면과 같은 역할·프로젝트 권한 검사를 받습니다.

로그인: 처음 연결할 때 MYSCube 화면이 열리고, 회사 Google 계정으로 이미 로그인돼 있으면 바로 넘어갑니다. 액세스 토큰은 1시간이며 갱신 토큰(30일, 쓸 때마다 새로 발급)으로 자동 갱신되므로 30일 안에 한 번이라도 쓰면 다시 로그인하지 않습니다. 갱신할 때마다 구성원 상태를 다시 확인합니다.

로컬 stdio 서버(`server.mjs`)는 아직 `cashflow_status`만 제공합니다.

## 연결

Claude의 MCP 설정에서 다음처럼 `node server/mcp/server.mjs`를 실행합니다. 처음 도구를 호출하면 launcher가 브라우저를 열고, MYSCube Firebase 로그인 뒤 PKCE OAuth를 완료합니다. 토큰은 프로세스 메모리에만 보관합니다.

```json
{
  "mcpServers": {
    "myscube": {
      "command": "node",
      "args": ["/absolute/path/to/MYSCube/server/mcp/server.mjs"]
    }
  }
}
```

실행 환경에는 다음만 설정합니다.

- `MYSCUBE_BFF_BASE_URL`: `https://myscube.myscguard.app`

`MYSCUBE_ID_TOKEN`, `MYSCUBE_TENANT_ID`는 더 이상 설정하지 않습니다. Firestore service-account JSON, Slack token, GitHub token, JVM service token은 설정하거나 전달하지 않습니다. `.env`는 저장소에 커밋하지 않습니다.

## Remote MCP (Claude)

배포된 BFF의 `https://myscube.myscguard.app/mcp`를 Remote MCP 주소로 등록합니다. 서버는 OAuth discovery와 Dynamic Client Registration, Authorization Code + PKCE(S256)를 제공합니다. Claude가 로그인하면 `/mcp/authorize`에서 기존 Firebase 로그인 세션으로 확인하고, BFF가 10분짜리 opaque access token을 발급합니다.

운영 환경에는 두 public URL을 동일한 정식 도메인으로 설정합니다.

```dotenv
MYSCUBE_MCP_OAUTH_ISSUER=https://myscube.myscguard.app
MYSCUBE_MCP_PUBLIC_ORIGIN=https://myscube.myscguard.app
```

## 권한과 감사

Firebase ID token은 같은 출처의 로그인 완료 요청에만 사용되고 redirect·Claude 설정·환경변수에 남지 않습니다. OAuth code와 access token은 Firestore에 SHA-256 해시만 저장합니다. MCP는 `x-actor-*` 헤더를 만들지 않으며, opaque token은 BFF가 활성 구성원 컨텍스트로 해석한 뒤에만 JVM trusted header로 변환합니다. JVM은 프로젝트 배정과 권한을 다시 검사합니다. stderr 감사 로그에는 token·금액·프로젝트명을 남기지 않습니다.

## 다음 단계

GitHub, Firestore 직접 접근, Slack 발송은 포함하지 않습니다. Slack 리마인드는 별도 승인·권한 모델로 추가해야 합니다.
