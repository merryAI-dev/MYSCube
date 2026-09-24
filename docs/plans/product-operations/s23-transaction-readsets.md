# Isolated Workbench transaction readsets: scoped audit

Scope: `/tmp/myscube-toi-complete/server/workbench/**/*.mjs`. No business BFF/JVM/source data code was modified. Actual Firestore emulator at `127.0.0.1:8080`; two distinct demo projects, one suite-unique tenant. These results do not establish a production Firestore defect or an SDK transaction-ID race.

## Observed failure and fix

The existing copy concurrency fixture was repeated 20 times with a UUID tenant and a barrier after both workers had read the same initial marker/source page. Before the product change, 16 passed and 4 returned Firestore `3 INVALID_ARGUMENT: Transaction is invalid or closed` rather than the expected application `409 workbench_copy_concurrent`. Log: `/tmp/myscube-copy-cursor-race-red.log` (87.56 s).

`copyLogPage` now resolves all fixed target document references before its transaction and reads `[marker, ...targetRefs]` with one `tx.getAll`. Marker generation CAS still runs before writes. The result order and missing-document snapshots remain those of the input references; values remain reevaluated per transaction attempt. No application retry, sleep, timeout extension, skipped assertion, or source write was added.

Afterward all 20 same-fixture races passed: exactly one fulfilled worker, one exact domain 409, generation 1, exactly one copied target, preserved source revision, and unchanged original document data and updateTime. The product observation is reduced document-read RPCs plus passing emulator invariants, not a proven universal explanation for code 3.

## Nine fixed document readsets (seven product files)

| File / operation | Fixed read order | Preserved checks |
| --- | --- | --- |
| `copy-feed.mjs` / `copyLogPage` | marker, 0–200 predetermined copy targets | generation CAS; source chronology/schema; bounded page/sweep; one target set |
| `conversations.mjs` / `beginTurn` | session, request ID receipt | replay fingerprint; active lease; version CAS; dependent old/active turn reads remain separate |
| `conversations.mjs` / `completeTurn` | session, turn | owner/lease/sequence; immutable completed result |
| `conversations.mjs` / `failTurn` | session, turn | exact active turn; persisted failure; release semantics |
| `html-pages.mjs` / `restore` | current head, selected immutable version | receipt replay remains first/dependent; current CAS; artifact/hash/evidence validation |
| `react-conversation.mjs` / model admission | daily usage, active lock | quota before busy error; atomic usage+lease; release ownership |
| `conversation-routes.mjs` / model admission | daily usage, active lease | quota before busy error; atomic usage+lease; release ownership |
| `html-routes.mjs` / model admission | daily usage, active lease | quota before busy error; atomic usage+lease; release ownership |
| `http-log-import.mjs` / import | import receipt, predetermined native-log refs | collision checks before replay; exact snapshot/record indexes; immutable create/dedup |

All document reads formerly combined with `Promise.all` now use `getAll`. Dynamic/dependent receipt-to-version/turn reads were not broadened or reordered. Empty source pages still read the marker alone. Arrays holding transaction snapshots are local to the callback; retry attempts do not reuse result arrays.

## Deliberately unchanged reads

The installed SDK `transaction.js` synchronously sets `_transactionIdPromise` for the first read; following reads queue behind the same ID. Therefore the audit does not treat parallel reads alone as an ID/snapshot defect.

- `applyPermissionCopy`: existing marker document + bounded members query `Promise.all` remains unchanged.
- `http-log-evidence.mjs`: both bounded queries remain in the same `readOnly` transaction; final authorization remains.
- `copied-log-summary.mjs`: rows and copy markers remain in the same `readOnly` transaction; all caps/final authorization remain.
- Single-read transactions and sequential data-dependent reads remain unchanged, including durable receipts, source-version replay, copy lease, git lease, and authorization operation locator.
- Source-page queries outside the write transaction, ordinary evidence lookups, filesystem reads, and bounded workers are unrelated to this document grouping.
- `analytics-service.mjs` already uses the independently verified `getAll(revision, head)` change from the earlier task; it was not edited here.

## Verification

- Main targeted emulator run: **14 files / 102 tests passed**, including copy20, original copy permission/late-source behavior, conversation history/CAS/replay/timeout, HTML save/restore/recovery, concurrent HTTP imports and copied-log summaries. `/tmp/myscube-copy-readsets-green.log` (61.21 s).
- Additional route/scope/auto conversation regression: **3 files / 12 tests passed**. `/tmp/myscube-copy-readsets-route-regression.log` (3.05 s).
- No fake SDK needed adjustment; assertions exercise actual emulator transactions and persisted data.
- Canonical/mirror file SHA equality recorded in `/tmp/myscube-copy-readset-freeze.json` for seven product files plus one strengthened test.
- Independent QA: frozen eight-file SHA verified, source diff reviewed, and all 17 files / 114 tests passed with no skips (62.79 s), including 20/20 copy races. Log: `/tmp/myscube-copy-readsets-independent.log`. Scoped implementation/regression gate PASS. No browser behavior changed, so verification is at the actual persistence/HTTP boundary rather than a browser-only mock.
