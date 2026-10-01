# Settlement submission reminders (disabled by default)

## Data path and safety

The new authenticated worker is `GET /api/internal/workers/settlement-reminders/run`.
It is mounted only with the existing settlement-agent service. It uses the existing
worker bearer-secret verifier and maintenance/worker-disable gates. No new public
credential or authentication endpoint is introduced.

1. Enumerate every non-trashed Firebase project under `orgs/mysc/projects`, with
   complete document-ID pagination. Registration does **not** establish obligation.
2. Join the reviewed explicit obligation registry below. Missing projects, unknown
   obligations, expiry, contradictory CIC/department or unnamed projects stop work.
3. At the deadline, read Slack history in `C0BQ6980HR6`. Slack indexes parent roots
   by their creation time, so roots before the finance period are also enumerated;
   replies are then read only for the period through the fixed cutoff. Old roots
   are not retained across runs. Pagination caps, failures and changed content fail
   closed. This can require many calls on a large channel: scope/rate-limit failures
   block sending rather than treating an incomplete scan as absence of submission.
4. Call the exact `jvmReadPort.readWeeklyOverview` handler behind
   `POST /api/v1/cashflow/weekly-overview`, with the existing fixed auditor read-only
   principal. `assertOverview` validates version 5, exact project coverage and state.
5. Only healthy `WAITING_FOR_UPDATE` is a candidate. `PENDING_APPROVAL` and
   `COMPLETED` are excluded. UNKNOWN and inconsistent/failed data block the batch.
   Slack `주정산 완료` is submission evidence, never approval. Contradictory or
   ambiguous evidence (tests, duplicate names, missing identity/period, edits) blocks
   affected waiting projects and therefore delivery of the full batch.
6. Reread inventory/policy to detect changes, group all candidates by normalized
   organization, and reserve one durable delivery key before sending one message.
   Snapshots older than 60 seconds from the **first canonical read** cannot send.

No financial record, approval, settlement status or core ERP deadline is written.
The only runtime writes are `settlement_reminder_deliveries/{sha256}` receipts.
All dry runs and previews are read-only. Slack text is a current-state prompt, not
an assertion of historical delinquency.

## Obligation registry

Prepare/review this technical configuration in
`settlement_reminder_obligations/mysc` using existing authorized admin
access. Do not infer that every registered or active project owes settlement.
Every non-trashed project must have exactly one explicit entry; adding/removing a
project invalidates coverage until reviewed. Exempt entries require a reason too.
Dates cover whole finance periods. Effective-dated registry avoids weekly editing;
review again when obligations change or the coverage expires.

```json
{
  "version": 1,
  "policy": "weekly-submission-thursday-kst-v1",
  "effectiveFrom": "2026-10-01",
  "effectiveThrough": "2026-12-31",
  "reviewedBy": "verified-operator-id",
  "reviewedAt": "2026-10-01T05:00:00Z",
  "projects": [
    {"projectId": "actual-firebase-id", "obligation": "required", "reason": "Confirmed weekly cashflow obligation"},
    {"projectId": "another-actual-id", "obligation": "exempt", "reason": "Approved exemption, scope and expiry covered by this registry"}
  ]
}
```

A strictly one-period registry can instead use `yearMonth` and `weekNo`. This is
supported for rollout, but expires immediately after that period. No sample IDs
above are intended for production. Existing sheet rosters are reconciliation input,
not authoritative eligibility. Review both `cic` and `department`; no silent conflict
resolution or automatic rewriting of financial project fields is done.

## Schedule and configuration

Nothing in this change creates a scheduler or turns on sending.

- `SETTLEMENT_REMINDERS_ENABLED` defaults off; `true` enables reads/planning
- `SETTLEMENT_REMINDERS_SEND` defaults off; leave unset for dry runs
- `SETTLEMENT_REMINDERS_POLICY_APPROVED=weekly-submission-thursday-kst-v1` is an
  explicit activation gate after review; it does not replace operator authorization
- `SETTLEMENT_REMINDERS_DESTINATION=C0BQ6980HR6` is the only allowed destination
- Reuse existing `SLACK_ALERT_BOT_TOKEN` for posting
- Optional `SETTLEMENT_REMINDERS_SLACK_READ_TOKEN` separates channel history/thread
  reads from posting; otherwise the bot token is tried and any scope failure blocks
- Reuse `SETTLEMENT_AGENT_WORKER_SECRET` and existing server Firebase/JVM identity

Public-channel `conversations.replies` support must be verified with the actual
installed Slack token. Do not assume a bot token that posts can read channel threads.
If an existing authorized user-token read connection is required, have the owner
configure it securely. Creating credentials or expanding scopes needs approval;
never copy credentials into chat, source or logs.

Primary schedule: Friday 00:00 Asia/Seoul = Thursday 15:00 UTC, immediately after
Thursday EOD. The worker anchors retries to that same deadline and only considers
a six-hour post-deadline window. A delayed run outside that window is skipped and
requires operator investigation, not silently re-dated. The scheduler must be
configured/verified separately, using the existing authenticated worker mechanism.
It should not treat `blocked_incomplete`, request errors, or `delivery_unknown` as
business non-compliance or automatically resend.

October 2026 finance ranges: 1–4, 5–11, 12–18, 19–25, 26–31. The existing ERP helper
is authoritative for period IDs (five slots, with a sixth calendar row folded into
WEEK_5). A short month fragment containing no Thursday receives no Thursday run;
any alternative deadline for that fragment needs explicit policy confirmation.

Weekly approval (Sunday EOD), monthly submission (10th EOD for prior month), and
monthly approval (month-end EOD) are deliberately inactive and not scheduled here.
Existing Friday 13:00 approval reminders/core deadline rules remain untouched.
Before rollout, reconcile possible duplicate/conflicting existing notifications.

## Preview and receipts

`previewReminderWindow({ yearMonth, weekNo, asOf })` creates an explicit pre-deadline
read-only window for `buildReminderPlan`. Its Slack upper bound is the given as-of
instant; text says “마감 전 미리보기”. `deliverReminder` rejects preview plans even
if send flags are accidentally enabled. It cannot reconstruct historical Firebase
or API state: canonical state is always queried now and labelled by query time.
There is no new public preview endpoint or arbitrary-actor API.

Receipt status `sending`, `delivery_unknown`, `blocked_stale` or `succeeded` prevents
all automatic resends for that policy/tenant/destination/period/stage/cutoff key.
A crash after reservation can mean a message was sent. Check Slack and the receipt
before any human-authorized recovery. Never delete a receipt to blindly retry.
A failed receipt update after a successful Slack send leaves `sending` and suppresses
resends. No automatic credential generation or status-changing ERP endpoint exists.

## Verification and release

Run `npm run test:settlement:reminders` (dependency-free Node tests and independent
QA regression cases). `npm test` runs these before Vitest. Also run the repository
PR gates: `npm test`, `npm run bff:test:integration`, `npm run build` in a prepared
checkout. Browser testing is not relevant to this server-only workflow.

Local verification currently does not prove live Firebase inventory, obligation
coverage, Slack history/replies scopes, canonical endpoint access, deployed worker
routing, or delivery receipt transaction permissions. Before activation:

1. Install normal repo dependencies in an authorized environment and run full gates
2. Review authoritative project obligation/exemption registry and normalized orgs
3. Verify existing Firebase/JVM auth and actual Slack history/replies/post scopes
4. Run a live read-only preview and inspect complete coverage/conflicts and rendered text
5. Obtain production release/activation approval, configure the existing scheduler,
   then verify deployed commit and CI before claiming the reminder is operational

This patch has not been deployed, scheduled, or used to send Slack messages.

## Durable policy and provenance (no SQL migration)

The versioned workflow code, policy contract and tests live in Git. Firebase remains
the existing runtime store: the reviewed effective-dated registry is technical
configuration, and each delivery receipt preserves the exact policy snapshot used.
No separate SQL database or migration is introduced.

Receipts also contain the release commit, policy/inventory/Slack/canonical hashes,
canonical project status and revision snapshots, Slack evidence message timestamps,
and cutoff/query times. Production sending requires a 40-character release SHA from
`SLACK_SERVICE_RELEASE` (existing Slack deployment setting), `VERCEL_GIT_COMMIT_SHA` or `GITHUB_SHA`. This preserves policy decisions and canonical
observations independently of a conversation. Slack raw text is not persisted: its
hash and message IDs support later comparison, but do not reconstruct deleted or
edited Slack content. A 400,000-byte UTF-8 provenance size guard blocks delivery
before the Firestore receipt could become unexpectedly large.

Dependency recovery for this change used only the committed lockfile's official
`registry.npmjs.org` package URLs, with `npm ci --ignore-scripts --no-audit --no-fund`.
No installation lifecycle scripts, browser downloads, or browser tests were run.
The repository's tracked developer-machine `node_modules` symlink is not changed
by the patch; a disposable local replacement is used only for validation.

### Local gate results (2026-10-01)

- Focused reminder tests: 30 passed
- Full Vitest: 456 files passed, 19 skipped; 4,782 tests passed, 318 skipped
- Production build: passed (existing large-chunk warnings)
- Typecheck baseline: passed, no new errors (187 known errors across 30 files)
- Emulator integration: blocked before tests by download failure for the official
  `https://storage.googleapis.com/firebase-preview-drop/emulator/cloud-firestore-emulator-v1.21.0.jar`;
  use an approved environment with emulator access/cache to complete this gate

The production scheduler must invoke the authenticated worker through approved
existing service routing. External Cloudflare restrictions must be resolved through
normal management of the deployed service; do not route around them with alternate
origins. The internal worker's existing Firebase identity and canonical read port
avoid introducing external MCP token refresh or a new M2M service. No live access
was verified from this cloud checkout.

The obligation registry is deliberately top-level and is denied to client SDKs by
the existing default Firestore rules. Configure it through authorized server/admin
access only; placing it under orgs/mysc would inherit broader client write rights
and make review metadata forgeable. No rules relaxation is included.
