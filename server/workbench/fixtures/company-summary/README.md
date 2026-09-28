# Synthetic BFF contract fixtures

Generated from `createCompanyCashflowSummary` in MYSCube PR #828 (commit
`2fd9682117714c29c7b2e3353c4650a75ec8f955`) using an isolated Firestore emulator
and synthetic JVM read snapshots. These files contain no production records.

- `month.json`: native monthly totals; weekly amounts are not used to rebuild them.
- `week.json`: one selected finance week.
- `partial.json`: a failed project alongside recorded values; full totals stay null.

`myscube-company-summary.test.mjs` verifies the AXR consumer against these actual
producer outputs. The BFF PR separately tests the producer through HTTP and
Firestore. When the endpoint contract changes, regenerate fixtures from that
producer and change the registered endpoint version rather than editing expected
financial values to make consumer tests pass.
