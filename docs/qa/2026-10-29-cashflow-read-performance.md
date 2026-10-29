# Cashflow overview read performance — 2026-10-29

Pre-release verification record. Base: `aa1b2a058af3a2344c775e2cbc8ab6eceb78f338` (fetched origin/main). Branch: `perf/cashflow-read-20261029`. At verification time, no push, PR, merge, deployment, or production data mutation had occurred. Publication and the existing CI-driven web/JVM release were subsequently authorized; deployment results must be verified separately.

## Evidence and scope

The October 28 IBS AP work was located in the local incident checkout and its commit `7dc824f90` (main merge `aa1b2a058`): reading only the declared `weeklyYear` rather than interpreting a full sheet mirror, plus bounded JVM heap settings. This change applies the same avoid-unused-input principle to the overview; it does not claim to redo the earlier incident fix. No runtime memory_summary.md path was supplied; no historical memory claim substitutes for current code.

`/cashflow` → CashflowPage → CashflowWeeklyPage → BFF POST `/api/v1/cashflow/weekly-overview` → authorized JVM read. JVM reads canonical cycle/status records and also loads ledger sources from 2023-01 through max(selected,current month), materializing historical documents and line entities. BFF then replaces every JVM `projectionActualSummary` with the stored sheet formula summary via its existing masked mirror batch read.

- Waste: `WeeklyExpenseCommandService.java:775–921`, `FirestoreInheritedWeeklyExpensePersistence.java:5740` (batched historical documents + entity materialization), `server/bff/routes/jvm-weekly-api.mjs:4837` (replacement).
- Browser waste: `cashflow-weeks-store.tsx:178–195` reads up to 5,000 week documents across two years and up to 5,000 selected-month completion documents. CashflowWeeklyPage uses only month navigation/loading from this provider; its displayed statuses come from BFF.
- Live read-only observation: authenticated production overview displayed its load-error banner. No production timing, heap sample, or request trace was captured, so this is not proof that the waste caused that particular failure. No financial values or production records are included in fixtures.

## Change and invariant

BFF keeps the original JSON body and sends the optional query `?omitProjectionActualSummary=true`. The new controller binds this boolean (default false) and passes it to a service overload. JVM skips only the unused ledger read and summary calculation in both legacy and canonical modes. The request DTO is byte-identical to the base; the original service overload defaults false, preserving other callers. Auth checks still precede reads, and status/cycle errors remain fail-closed. BFF output version 5, mirror summary, EMPTY/ZERO semantics, fixed coordinates, filters, deadlines, approval capabilities and persisted writes are unchanged.

Only `/cashflow`, `/cashflow/weekly`, `/cashflow/projects` disable provider week loading. Month navigation stays in the same provider. Detail, analytics, payroll, dashboard and portal retain default reads. Switching back to a data-consuming route reads again; effect cleanup discards late responses.

No cache or invalidation change. No speculative field masks on cycle provenance: snapshot hashing is a required integrity check and is retained. No new concurrency or resource-budget settings.

## Complexity and measurement

Let P be projects, W historical week documents, L materialized line entities. Eliminated server work includes O(W+L) read/materialization and downstream summary aggregation; its temporary allocation is no longer proportional to historical ledger size. Remaining cycle/provenance/mirror work is not O(1) and is not removed. Browser avoids two queries, O(W log W) week sorting and retained O(W+C) document arrays on overview only.

Reproduce isolated benchmark:

`JAVA_HOME=<JDK21> mvn -o -q -f server/jvm-weekly-api/pom.xml -Dtest=CashflowOverviewReadBenchmarkTest -Dcashflow.benchmark=true test`

Synthetic legacy service branch, 60 week positions/project, three projection lines/week, mock persistence (no DB/HTTP), real summary calculator. Ten warmups and fifteen measured runs, median wall time and median total JVM allocated bytes via ThreadMXBean. Both paths use identical status fixtures. Allocation is cumulative across JVM threads, **not peak or retained heap**. These are not production page latency measurements.

| Projects | Week positions | Default ms | Omit ms | Default allocated bytes | Omit allocated bytes |
|---:|---:|---:|---:|---:|---:|
| 10 | 600 | 5.248 | 0.144 | 8,808,120 | 10,760 |
| 50 | 3,000 | 12.905 | 0.245 | 43,478,816 | 25,848 |
| 100 | 6,000 | 21.680 | 0.248 | 86,935,840 | 43,768 |

## Validation

- Java parity: full canonical/legacy response comparison excluding the intentionally omitted upstream summary; default callers keep summary; opt-out never calls ledger persistence; denied access performs no persistence reads; status errors remain. Strict unknown-JSON rejection remains enabled.
- BFF parity: non-null sentinel JVM summary plus SUMMARY_UNAVAILABLE vs omitted summary/no summary error, then restored summary after JVM rollback, produce identical final v5 output. Covered historical and canonical months; one upstream call per read, unchanged JSON keys. Existing mirror malformed/empty/range tests retained.
- React lifecycle: false→default enables exactly two reads; month navigation makes zero reads while disabled; late detail read cannot repopulate overview.
- Independent QA source review passed; `git diff --check` passed.
- Typecheck passed with 187 pre-existing baseline errors (30 files), no new errors. No lint script exists.
- Final production build passed in 7.83s (existing >500kB chunk warning).
- Final full Java suite after compatibility repair: 573 passed, 1 opt-in benchmark skipped, zero failures/errors in a single socket-enabled run. Separate final benchmark passed. Earlier draft had one localhost socket denial, resolved by allowing local sockets.
- Emulator integration rerun after final compatibility repair: first attempt 300 passed / 1 ECONNRESET failure / 3 skipped in an unchanged transaction RBAC test. One unchanged-code retry completed: Firestore 301 passed / 3 skipped (57.76s), then Auth/Firestore/Storage rules 3 passed (2.06s); both scripts exit 0. Disposable `demo-cashflow-read-perf`, local emulators only.
- Browser: local dev harness showed 20 sample projects, next/previous month updated week headings; approved-only filter rendered empty state. This is UI navigation/empty-state evidence, not live backend correctness. Full authenticated local BFF/JVM + Firestore end-to-end was not run.
- JS final result: 5,111 passed / 311 skipped across 491 passed / 18 skipped files (69.72s); npm reminder prechecks also passed. Initial run had missing worker `fflate`, six unrelated load-related timeouts and a generated source-hash drift caused by the BFF edit. Installed worker lock dependencies and regenerated code evidence; rerun with two workers. Early targeted BFF socket/404 flakiness did not recur in full run (288/288 passed).

## Remaining limits

Production recovery and full concurrent-load/peak-heap effects require an approved deployment and runtime observation. Existing global stores, cycle snapshot hashing and non-cancelled in-flight BFF fetches can still cost time; they were not changed without separate evidence. Rollout order no longer affects request correctness: the original JVM ignores the optional query and returns its usual summary, which BFF already replaces. Optimization becomes effective once both new BFF and new JVM are present. A rollback of either side restores extra work, not a request-schema error. No deployment had been attempted when these measurements were recorded. Subsequent release authorization does not establish production recovery.


## Rolling HTTP compatibility repair

The first local draft put the flag in JSON; this was unsafe against the old JVM's `spring.jackson.deserialization.fail-on-unknown-properties:true`. That draft was never published. Final code uses an optional query parameter, retains strict JSON validation, adds no retry/fallback requests, and does not swallow errors. Unknown/absent query parameters are tolerated by the old controller without changing its body contract. The new controller rejects malformed boolean input with HTTP 400.

`CashflowOverviewRollingCompatibilityTest` uses Spring MockMvc HTTP request/response serialization, a strict Jackson converter and Bean Validation, the actual controller and actual command service, and mocked persistence/authorization. The identical fixture was copied into an archive of base `aa1b2a058` and run with `-Dcashflow.oldJvm=true`; independent QA byte-compared all 182 baseline main-source files with that commit. It is not a real network socket or production authentication test.

Both revisions passed 5 tests each: no query, true query, explicit false, request rollback; canonical and legacy response parity; old unknown JSON rejection with and without query; invalid original body; malformed query handling; denied service authorization before persistence. New server omits ledger reads only for true query. Old server performs its original ledger read even with that query. BFF tests verify identical v5 output from both resulting shapes and rollback.

Reproduction (from this repo; base archive in a disposable sibling folder):

```sh
git archive aa1b2a058 server/jvm-weekly-api | tar -x -C ../cashflow-baseline
cp server/jvm-weekly-api/src/test/java/dev/merryai/innerplatform/weekly/api/CashflowOverviewRollingCompatibilityTest.java ../cashflow-baseline/server/jvm-weekly-api/src/test/java/dev/merryai/innerplatform/weekly/api/
mvn -o -q -f ../cashflow-baseline/server/jvm-weekly-api/pom.xml -Dtest=CashflowOverviewRollingCompatibilityTest -Dcashflow.oldJvm=true test
mvn -o -q -f server/jvm-weekly-api/pom.xml -Dtest=CashflowOverviewRollingCompatibilityTest,CashflowWeeklyOverviewServiceTest test
```

Operational log follow-up was attempted read-only for the observed window, without new application requests: Cloud Logging, project `inner-platform-live-20260316`, service `innerplatform-jvm-weekly-api-live`, 2026-10-29 02:30–02:33 UTC, path `/cashflow/weekly-overview`, limit 20, only timestamp/method/status/latency/revision/trace fields. `gcloud logging read` failed before retrieval because the existing credential requires interactive reauthentication. No credentials/settings were changed and no retry was attempted. HTTP status and incident cause remain unknown; this is an authentication blocker, not an auto-review denial.

The verified pre-release diff was staged on `perf/cashflow-read-20261029`. Final controller option: `WeeklyExpenseController.java:336`; service default overload: `WeeklyExpenseCommandService.java:775`; query forwarding: `server/bff/routes/jvm-weekly-api.mjs:4797`. Final regression commands: `npm test -- --maxWorkers=2`, `mvn -o -q -f server/jvm-weekly-api/pom.xml test`, `npm run typecheck`, `npm run build`. No release or live application retry performed.

Final disclosure review: all 15 staged files reviewed; newly added fixtures are synthetic, with only `viewer@example.com` as an email literal. No financial records, raw operational logs, private keys, access tokens, JWTs, or credential assignments found in added lines. Dependency hashes and source hashes are not credentials. The report retains non-secret infrastructure identifiers already present in the repository workflow. Read-only GitHub metadata confirmed repository visibility `public`, main `aa1b2a058`; no publication was performed.
