# Operational Hardening Runbook

## 1) Firestore Composite Indexes

```bash
npm run firebase:deploy:indexes
```

Includes `transactions(projectId, ledgerId)` and outbox processing indexes.

## 2) Audit Hash Chain Verification

```bash
curl -H 'x-tenant-id: mysc' -H 'x-actor-id: u001' http://127.0.0.1:8787/api/v1/audit-logs/verify
```

- `200`: chain valid
- `409`: chain mismatch/tampering detected

## 3) Outbox Processing

```bash
# one-shot processing
npm run bff:outbox:worker

# continuous worker
BFF_OUTBOX_LOOP=true npm run bff:outbox:worker
```

## 4) Projection Work Queue Processing

The generic write pipeline enqueues projection sync jobs into `work_queue/*`.

```bash
# one-shot processing
npm run bff:work-queue:worker

# continuous worker
BFF_WORK_QUEUE_LOOP=true BFF_WORK_QUEUE_INTERVAL_MS=2000 npm run bff:work-queue:worker
```

### Recommended Production Strategy (Vercel-first)

Use HTTP-triggered one-shot workers from Vercel Cron.

1. Protected endpoints are implemented:
   - `GET|POST /api/internal/workers/outbox/run`
   - `GET|POST /api/internal/workers/work-queue/run`
2. Configure shared secret:
   - set `CRON_SECRET` (recommended on Vercel) or `BFF_WORKER_SECRET`
3. Configure Firebase Admin credentials:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` (recommended) or `FIREBASE_SERVICE_ACCOUNT_BASE64`
4. Vercel Cron schedules are declared in `vercel.json` (default: Hobby-safe daily):
   - `15 2 * * *` for work queue
   - `30 2 * * *` for outbox
   - Vercel Cron invokes the `path` via HTTP `GET` and automatically attaches `Authorization: Bearer $CRON_SECRET`.
5. For minute-level schedules, upgrade to Pro or move workers to an external runtime.
6. Keep each invocation short and idempotent:
   - process up to N jobs per run
   - return processed count + remaining estimate

### Alternative Strategy (External Always-on Worker)

Run both workers as long-lived processes on a separate runtime (Cloud Run job/service, Fly.io, Railway, ECS, VM).

- Pros: low queue latency, stable throughput, easier back-pressure tuning.
- Cons: extra runtime/cost/ops.
- Recommended env:
  - `BFF_WORK_QUEUE_LOOP=true`
  - `BFF_OUTBOX_LOOP=true`
  - `BFF_WORK_QUEUE_INTERVAL_MS=2000`
  - `BFF_OUTBOX_INTERVAL_MS=2000`

### Failure Handling Checklist

- Alert on `status=DEAD` count increase in `work_queue/*` and `outbox/*`.
- Use replay endpoint for projections: `POST /api/v1/queue/replay/:eventId`.
- Keep max attempts explicit (`BFF_WORK_QUEUE_MAX_ATTEMPTS`, `BFF_OUTBOX_MAX_ATTEMPTS`).
- Include dead-letter triage in daily ops routine.

### Project submission SSOT and read-only triage

| Record | Authority | Never substitute |
| --- | --- | --- |
| Owner's active Draft | Private input and selected attachment references | Another user's draft or browser cache |
| Selected Request | Submitted content and files under review | Project/Drive values for missing fields |
| Project | Confirmed business content; registration shell remains unapproved until review | Unapproved CHANGE content |
| Outbox | Delivery progress only | A second source of current project content |

Use the existing Firestore console and server logs with read-only access. Do not replay a queue to diagnose missing files.

1. In `orgs/{tenantId}/client_error_events`, filter `source == platform_api` and the incident time window. Group/count by `extra.errorCode` and `extra.release`; inspect `extra.operation`, `projectId`/`draftId`, numeric expected/actual revision/version, and `conflictReason`. Older events may lack these fields: an old HTTP 409 alone does not prove a version conflict.
2. `clientRequestId` identifies the failed browser request; `extra.responseRequestId` matches the original `bff.request.requestId`. The event's top-level `requestId` is the **error ingestion** request, not the failed save. `tags.method`, `extra.status`, `extra.attempt` and `extra.maxRetries` preserve the failed HTTP method/status and retry counts. `extra.endpoint` is a coarse **API resource family**, such as `/api/v1/transactions/*`, not the exact route; all child identifiers/file names/query/hash are excluded. `client.error` logs expose these fields, safe correlations and the server-resolved actor role. Never copy payloads, file names, signed URLs, lease/session/fence values, idempotency keys, or credentials into diagnostics.
3. In `outbox`, filter the tenant and `status == PENDING` as well as `FAILED`/`DEAD`. For each registration event inspect `eventType`, `entityId`, `createdAt` age, `attempts`, `nextAttemptAt`, and `sideEffects.registrationAttachments`. Old PENDING with zero attempts warrants checking worker invocation/due-query and deployed SHA; it is not evidence that retrying will repair attachments.
4. To count suspected registration omissions, follow each submitted REGISTRATION's `approvedProjectId` and `sourceDraftId` to its Project and submitted source. Compare only kinds actually present in that registration source, using the field names from `policies/project-documents.json`. Count missing Request/Project references separately and verify Storage metadata. Exclude withdrawn/superseded registrations, intentionally removed/replaced files, and files only present in **unapproved CHANGE** requests. Do not treat a missing optional file as an incident.
5. A conflict keeps input private: `draft_version_conflict` requires draft comparison; `draft_source_conflict`/`canonical_version_conflict` requires a fresh submitted/confirmed comparison. 403 requires permission review, 410 renewed edit ownership, 423 waiting for the current editor, 413 size correction, and 422 input/file verification. For uncertain or idempotency-conflicting results, check the existing server state before creating another request.

For the approved exact registration repair targets, use `scripts/repair-project-registration-attachments.mjs` in its default **dry-run** mode with all seven explicit target flags (`--firebase-project-id`, `--bucket-name`, `--tenant-id`, `--project-id`, `--request-id`, `--outbox-id`, `--draft-id`) and an absolute `--output` backup path. It reads records/updateTimes and file metadata and creates a mode-0600 local snapshot; it does not write Firestore/Storage. Keep that snapshot outside the repository. Existing attachments, newer requests, progressed review, or any ACTIVE information draft stop the repair. Applying requires a separately reviewed fresh snapshot and explicit approval; never automatically add `--apply` or replay notification/Drive effects.

## 5) Backup/Recovery Drill

```bash
# schedule backups
npm run firestore:backup:schedule

# restore latest backup to rehearsal DB
npm run firestore:backup:rehearsal
```

## 6) SLO Alerts

```bash
export MONITORING_NOTIFICATION_CHANNELS='projects/<project>/notificationChannels/<channel-id>'
npm run monitoring:setup:alerts
```

Creates/updates:
- 5xx rate > 1%
- p95 latency > 2s
- version_conflict rate > 5%

## 7) PII Encryption + Rotation

- `PII_MODE=local|kms|auto|off`
- Local mode:
  - `PII_LOCAL_KEYRING=v1:<base64-32b>,v2:<base64-32b>`
  - `PII_LOCAL_CURRENT_KEY_ID=v2`
- KMS mode:
  - `PII_KMS_KEYS=projects/.../cryptoKeys/keyA,projects/.../cryptoKeys/keyB`
  - `PII_KMS_CURRENT_KEY=projects/.../cryptoKeys/keyB`

```bash
npm run pii:rotate
```

### Vercel Only (No GCP/KMS)

```bash
# one-time
vercel login
vercel link

# generate local keyring + local env file
npm run pii:setup:vercel

# push directly to Vercel env (prod/preview/dev)
npm run pii:setup:vercel -- --push
```

Optional custom args:
- `--key-id v2`
- `--environments production,preview`

## 8) Policy-as-Code

```bash
npm run policy:verify
```

Policy file: `policies/rbac-policy.json`  
Role change endpoint: `PATCH /api/v1/members/:memberId/role`
