# Cloudflare Automation Client Block - 2026-06-22

## Scope

- Zone: `myscguard.app`
- Ruleset: `MYSC custom WAF controls (candidate)`
- Phase: `http_request_firewall_custom`
- Rule ref: `mysc_explicit_automation_client_block`
- Rule id: `a4602e5dfc844cca8bf77c6627d50332`
- Action: `block`

## Blocked Signals

The rule blocks explicit automation and CLI scraping clients by `User-Agent`:

- empty user agent
- Playwright
- Puppeteer
- HeadlessChrome
- Selenium / WebDriver
- PhantomJS / SlimerJS
- Cypress
- MCP client / Model Context Protocol client
- python-requests
- aiohttp
- httpx
- curl
- wget
- Go http client

The rule intentionally does not block every request containing `bot`, because that can break verified crawlers, link previews, identity-provider flows, and third-party callbacks.

## Verification

Smoke tests against `https://myscube.myscguard.app/`:

| Client | Result |
| --- | --- |
| Normal Chrome-like browser UA | `200` |
| Playwright / HeadlessChrome UA | `403` |
| MCP client UA | `403` |
| python-requests UA | `403` |

Cloudflare API readback confirmed the rule is enabled in the custom WAF ruleset.

## Scanner Probe Block Expansion

After reviewing Cloudflare HTTP request analytics, `TLM-Audit-Scanner/1.0` requests to `edge.myscguard.app` were found reaching the Vercel origin and receiving SPA fallback HTML for sensitive-looking paths. No secret/config file body was observed, but the WAF rule was expanded to block these probes at the edge.

Expanded blocked path classes:

- encoded and plain `.env` probes
- `.git`, `.gitlab-ci.yml`, `.docker`, `.terraform`, `terraform.tfstate`
- `Dockerfile`, `docker-compose`
- AWS, S3, Stripe, serverless, Amplify, and constants config probes
- `phpinfo`, backend `settings.py`, `credentials.go`, `parameters.yml`
- webhook probe paths
- encoded backslash traversal probes

Post-apply smoke tests against `https://edge.myscguard.app/`:

| Path | Result |
| --- | --- |
| `/app/.terraform/terraform.tfstate` | `403` |
| `/amplify/team-provider-info.json` | `403` |
| `/webhooks/incoming/stripe.json` | `403` |
| `/api/phpinfo.php` | `403` |
| `/backend/env.js` | `403` |
| `/Dockerfile` | `403` |
| `/.gitlab-ci.yml` | `403` |
| `/aws.json` | `403` |
| `/stripe.env` | `403` |
| `/.docker/config.json` | `403` |
| `/` with normal browser user agent | `200` |

## Operational Note

This is an edge reduction control, not a replacement for Firebase Auth, Firestore Rules, backend authorization, audit logging, or data-at-rest encryption. A browser that spoofs a normal user agent can still reach the app, so sensitive operations must remain protected behind application authorization and rate limits.

## MCP Protocol Path Exception (2026-10-13)

The remote MYSCube MCP is a standard MCP server (Streamable HTTP + OAuth 2.1). Its clients (Claude, ChatGPT, the Python and Node MCP SDKs) send `httpx`, `mcp-client` or similar `User-Agent` values, so this rule blocked them with `403` before they reached the OAuth discovery document.

The rule now excludes only these exact paths on `myscube.myscguard.app`; every other path keeps the block, and the browser login page `/api/v1/mcp/oauth/authorize` is not excluded:

- `/mcp`
- `/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/mcp`
- `/api/v1/mcp/oauth/register`, `/api/v1/mcp/oauth/token`

Requests on these paths still need a valid MCP access token for data (`/mcp`), and every tool runs with the signed-in member's own permissions.

- Source of truth: `infra/cloudflare/main.tf` and `scripts/configure-mcp-edge.mjs` (kept equal by `server/mcp/edge-exception.test.mjs`)
- Apply: `Cloudflare MCP Edge` workflow on `main` with `apply` checked; it saves the pre-change ruleset as an artifact, refuses if the rule drifted from review, and smoke-tests that SDK user agents reach discovery while a non-MCP path with `httpx` still returns `403`.
- Rollback: re-apply the expression from the `mcp-edge-before` artifact.
