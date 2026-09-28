# Company cashflow summary: bounded read contract

This is a separate, main-based BFF change. It is not an AXR branch merge or a deployment. The route is `GET /api/v1/company-cashflow-summary?yearMonth=2026-09&weekNo=2`. An active persisted `admin` membership is required; it does not expand the existing tenant-wide role policy. `weekNo` is optional (1–5). Unknown query fields are rejected. The new AXR adapter must remain explicitly disabled until this route is deployed and its separately reviewed Cloudflare rule allows it. Existing project and page-evidence routes/rules are unchanged. Authenticated production/Cloudflare acceptance of this new route is unverified.

## Amount and coverage contract

The first projected catalog query reads at most 201 documents in document-ID order, admitting at most 200. It excludes trashed documents and uses the actual Firestore document ID, not any stored `id` field. A second bounded query checks the same projected catalog identity. `catalogComplete` requires no overflow, unchanged catalog and a real initial Firestore read timestamp. This detects observed changes; it is not a financial transaction snapshot. `atomicSnapshot:false` remains unconditional.

The response has `schemaVersion:1`, `period:{yearMonth,weekNo:null|number}`, `amountCurrency:'KRW'`, `scope:'accessible_registered_projects'`, `catalog`, `catalogComplete`, `readWindow`, `counts`, `totals`, `weeks`, `weekCalendarUniform`, and compact `rows`. Each metric under `totals[projection|actual|difference][inflow|outflow|cumulativeBalance]` is:

```json
{"value":null,"partialValue":0,"included":1,"excluded":2,"complete":false}
```

`value` is non-null only when the complete stable catalog and every enumerated eligible project provide that metric. `partialValue` sums only known values; no known values gives null, explicit zero remains zero. Unknown projects beyond the cap are not invented as zero exclusions. `included`/`excluded` refer only to enumerated eligible projects. Empty catalogs are not reported as zero totals. `totalsScope` is `COMPLETE_REGISTERED_PROJECTS` or `PARTIAL_REGISTERED_PROJECTS`; completeness covers the recorded native metric across this project catalog, not a fully settled month, all source cells, bank balance or instantaneous company financial position. The totals use exact integer arithmetic and reject unsafe integer overflow.

Monthly amounts come only from `accountingEvidence.monthlyTotals`, derived from native JVM `monthTotals`; they never sum weekly balances or fabricate annual values. Each project's single `weeklyYear` must pass `weekOrdinal`; unsupported years are excluded. `NOT_RECORDED`, `FAILED`, `OUT_OF_SCOPE`, `NOT_ATTEMPTED` and known zero remain distinct. Source EMPTY/ZERO cell states are not exposed by the read port, so `fieldStateAvailability:'NOT_EXPOSED'` explicitly avoids reconstructing them.

`rows` contain only `projectId`, status, weeklyYear, sourceRevision, retrievedAt, `periodTotals` (three modes × three nullable amounts), and projection/actual `missingWeeks`. They do not repeat 15 weekly detail rows per project, names, emails or original sheet cells. Full per-project detail remains on the existing read endpoint. Aggregate `weeks` contains at most five entries. Serialized response bytes are capped at 256,000 bytes before delivery; oversized output fails with `company_summary_response_too_large`. No report/artifact is persisted.

## Calendar authority

`server/bff/cashflow-coordinates.mjs` and the 2026-07-28 formula-validation contract remain authoritative. Each observed project's projection and actual evidence `(yearMonth,weekNo,start,end)` must match the common finance calendar and coordinate-supported weekly year. Mismatches set `weekCalendarUniform:false` and the affected aggregate week's `totals:null`. Missing observations give null, not true. Native monthly values remain independent of a weekly calendar mismatch.

The JVM week representation exposes week numbers and amounts, not independently captured date cells. `accountingEvidence` obtains start/end from `getMonthFinanceWeeks(yearMonth)`, which has no project-specific argument. Therefore `calendarAuthority:'BFF_FIXED_FINANCE_CALENDAR'` is explicit: dates are reviewed fixed-calendar semantics, not a new live sheet-date observation. No labels, year sets or guessed source dates are used. `liveSheetVerified:false` is unconditional.

## Admission and lifetime

Only this endpoint uses `_bff_operational/company_cashflow_summary`: a transactional Firestore control document, globally two concurrent leases, one per tenant/actor identity, at most two starts per actor/minute and 12 starts globally/minute. It does not consume the existing Workbench/ordinary business quotas. Only operational lease metadata is written; project, financial, settlement, mirror and source documents are read-only.

There is one sequential read worker per request. At 20 seconds it stops starting new projects and awaits the current read. If that read and final catalog/authorization checks finish within 50 seconds, a partial result may be returned. At the 50-second whole-request deadline, it aborts the request and returns 504, exposing no unchecked partial results. Disconnects also abort. No subsequent project read starts after abort. A signal check immediately before the existing JVM GET prevents a delayed Firestore project/mirror lookup from starting a new upstream request after cancellation.

HTTP timeout/disconnect does not prove upstream work ended. The lease remains until the actual task settles, when normal/failed requests immediately release it. A failed release or terminated invocation has a **finite 360-second fallback**, using Firestore transaction read time and a persisted clock floor. This assumes the deployment contract `vercel.json → functions['api/bff.js'].maxDuration:300`; a regression test pins it. Vercel documents termination at the configured maximum ([official duration documentation](https://vercel.com/docs/functions/configuring-functions/duration)). The 60-second margin is a conservative admission policy, not proof that remote JVM CPU work or raw sockets were cancelled. Local long-lived deployments and changes to the deployed maximum need this policy reviewed. Actual deployment configuration still needs release verification. There is no permanent operator-only deadlock and no automatic retry or background report job.

A second request cannot replace a still-running admitted worker merely because the client timed out. No queue or ordinary service quota change is introduced. Permission is checked initially, before every project, and immediately before returning results. Revocation discards all totals and evidence.

## Limits and verification

The 200-project cap and 20-second start window cannot guarantee a complete company report. This implementation has no production catalog-size or latency measurement; test catalog sizes are synthetic and are not an operational estimate. Larger/slower catalogs remain partial. An async durable report workflow would be a separate design, not a hidden fallback.

Targeted tests exercise the real main Express mount, Firebase emulator catalog/membership/admission, and an injected synthetic JVM HTTP response. They verify original document bytes/update times unchanged, NULL versus zero, unsupported years, 201-document overflow, revocation, shared admission across instances, deadline retention, and delayed Firestore completion causing zero late JVM calls. These are integration fixtures, not actual SSO, production JVM, Google Sheets, or new Cloudflare acceptance. Browser QA is not needed for this server-only change; AXR host evidence labeling and adapter/browser acceptance belong to the separate integration.
