# IBS AP cashflow incident — 2026-10-22

## Scope and deployment

Reported symptoms: settlement timeline unavailable from initial load; repeated sheet overwrite failures. Screenshot request ID: `1792674963204_a29ebb2bca2742ab`, error `jvm_weekly_api_unreachable`, with a separate mirror-revision conflict toast.

- BFF deployment: `dpl_H4bHtAh6KykrpoAgfEx9XdrYUqaB`, source `a3d2724b025a8033ce1d46b96e6f21e7ec7b85e1` (Vercel metadata and Oct 19 production workflow).
- JVM request revision: `innerplatform-jvm-weekly-api-live-hotfix-6e655868`, source `6e6558682ece8eaeb59c6e3595d0e095692ee8ed` (Cloud Run request logs and revision deploy-sha label).
- Runtime: 512Mi container, concurrency 80; logged maximum Java heap about 123Mi. No explicit heap/OOM options on incident revision.
- All times below are UTC. Screenshot workstation timezone is unconfirmed.

## Confirmed failure mechanism

Project-scoped Cloud Run requests show a dashboard-source GET at 13:13:38 returning 500 after 23s, and sheet-lab batch apply POSTs at 13:13:59 and 13:16:04 returning 503. Application logs at 13:13:59 report `java.lang.OutOfMemoryError: Java heap space`; poller threads also exhaust heap. OOM instances match the failed requests and subsequent liveness termination. Some compliance reads still returned 200.

The deployed `declared_weekly_year` read loads the full sheet-mirror document, including cells, to retrieve a single `weeklyYear`. The generic document reader eagerly decodes the full document for caching even without an active cache. The failed dashboard read logged heapUsed 120Mi / heapMax 123Mi and a slow declared-year phase.

This establishes heap exhaustion and failed service requests. No heap dump/allocation profile proves that this one allocation alone initiated exhaustion. Exact association of the screenshot BFF request ID to a JVM request remains unverified: Vercel runtime log access returned 403; exact Firestore idempotency metadata searches returned no documents. Timestamp and stage-apply metadata align with the 13:16:04 POST, but that alignment is not an exact trace link.

## Fix and invariant

Single and batch declared-year reads now request only `weeklyYear` through a Firestore field mask. Transaction reads remain in the same transaction; partial snapshots must not enter the full-document cache. Missing/invalid year and single-read unavailable contracts are preserved.

Both JVM images set the maximum heap to approximately 50% of the existing container memory and enable `ExitOnOutOfMemoryError`, so heap exhaustion terminates the process rather than leaving failed request/poller threads alive. Container memory, CPU and concurrency are unchanged. This does not establish load safety at concurrency 80.

The mirror-revision guards remain intact. Historical stage/mirror values consumed by the separate conflict request are unavailable, so its precise comparison remains unresolved.

## October week 4

The authoritative current state has the September monthly close locked, weeks 2 and 3 completed on time, and week 4 `WAITING_FOR_UPDATE / MISSED`. Immutable completion versions contain weeks 2 and 3 only. No matching JVM week-4 completion call was found in the queried Oct 22–23 request window.

Sheet refresh/overwrite and weekly completion are separate business actions. An Oct 23 successful overwrite does not complete week 4. A failed settlement-status read can prevent the UI from enabling completion, but there is no historical client/BFF evidence proving that this prevented an actual week-4 completion attempt. The missing completion is confirmed; causality remains unverified. No financial state or completion timestamp was altered or backdated.

## Verification and release limits

- Full Maven suite: 57 suites, 567 tests, zero failures/errors/skips.
- New tests exercise exact field projection, no full decode, invalid/missing data, failure mapping, transaction/cache isolation, actual JDK heap calculation and process termination on OOM.
- Independent reviewer checked live state/logs and deployed source, then reviewed the fix; no blocking source defect found.
- Local Docker daemon unavailable: actual image/cgroup execution is not verified by the JDK subprocess tests.
- Before calling this resolved, observe normal CI-driven production deployment, check active image/options and heap, repeat the affected live reads, and verify any authorized overwrite through its persisted result. A health check or merged PR alone is insufficient.

Raw credentials, financial payloads and deployment secret references are excluded from this report.
