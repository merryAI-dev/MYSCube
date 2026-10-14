# Internal QA MCP intake deployment

The private QA intake service now mounts `/api/v1/mcp` onto the existing Firebase authentication, case ownership, case service and idempotency service. Five MCP tools support report, read, activity, result and list. This is an internal bearer-authenticated endpoint; GPT/Claude public OAuth integration remains incomplete.

## Reproduce the deployed source

Download the immutable source archive from Cloud Build `641944c4-d500-43fc-b218-ac73c75f9371` in project `inner-platform-qa-20260310`, region `asia-northeast3`:

- bucket: `inner-platform-qa-20260310_cloudbuild`
- object: `source/1791948422.125912-96b16e458f7940aeac52d428b31686c3.tgz`
- generation: `1791948423763699`
- archive SHA-256: `e9fd3bb69f9e8479b42bc104e72b7aed74f5136e1527d5a2167b6b7bae41990a`

Run `python3 infra/qa/prepare-mcp-intake.py SOURCE_ARCHIVE NEW_CONTEXT_DIRECTORY` from this committed source. The builder rejects a changed archive or nonempty destination and permits only two changed runtime files: the intake entrypoint and `qa-mcp.mjs`. It emits all runtime file hashes. The deployed MCP file hash is `6bd9e9ffdd10032a4170933ce86db76f5fc846a1071be6e2d495b3330bc740b4`, from commit `19f9363c3d53f60149bd8b6ca352d1ac4f557bff`.

The verified baseline already contains SDK 1.26.0 and its lockfile. Later lifecycle and authority-client changes on the PR stack are excluded. This deployment does not represent deployment of the whole PR stack.

## Observed QA deployment, 2026-10-14

- Build `6e819517-0ed8-4ef3-b7a0-2c80de8ccd14`: SUCCESS. Docker build installs locked dependencies; a second build step imports the MCP module inside the resulting image with networking disabled.
- Image digest: `sha256:41c227f6578fd0df4bfbb22dfd6d440511139c743ef51c103fd96f7c6a057dcb`.
- Service `mysc-qa-intake`, generation 17, revision `mysc-qa-intake-00017-f6v`: Ready, 100% traffic.
- Only container image and `QA_BUILD_ID=mcp-19f9363` changed. Full expected template and existing ingress, traffic configuration and scaling hashes matched after rollout. No IAM-policy write was made.
- Independent review covered the baseline overlay and deployment helper.

## Verification and remaining gaps

Five SDK/HTTP tests passed, including actual StreamableHTTPClientTransport initialization and tool routing to the case service. Tests use injected user context and a memory transaction implementation: they do not prove real Firebase authentication or Firestore concurrency.

An attempted live probe could read Cloud Run configuration but received HTTP 403 when generating a dashboard service identity token. It therefore did not reach the MCP endpoint. Valid user MCP reads, actual cloud idempotent writes, and GPT/Claude public OAuth remain unverified. No emulator was run. The real cashflow investigation is still incomplete and has no reviewed GitHub issue.
