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

- Alert on `status=dead` count increase in `work_queue/*` and `outbox/*`.
- Use replay endpoint for projections: `POST /api/v1/queue/replay/:eventId`.
- Keep max attempts explicit (`BFF_WORK_QUEUE_MAX_ATTEMPTS`, `BFF_OUTBOX_MAX_ATTEMPTS`).
- Include dead-letter triage in daily ops routine.

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
