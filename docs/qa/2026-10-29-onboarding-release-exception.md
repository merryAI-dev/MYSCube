# One-release weekly status stability exception

The onboarding release was blocked by concurrent weekly submission/approval writes. A one-time business-validation exception was explicitly authorized for this release.

Scope: only a Production Deploy workflow_run/workflow_dispatch on refs/heads/main whose checked-out commit parent is d0a2721945892f604ba39ab4c3adc7f79f519cd5, before 2026-10-29T10:00:00Z, in read-only verification. Existing exact main HEAD, successful CI, author, authentication, authorization, JVM compatibility, candidate and alias checks remain unchanged.

Waived invariant: whole settlement-document dataHash/updateTime equality when the only data changes are periods.WEEK_1 through WEEK_5 and top-level updatedAt. Non-weekly document hashes, document identities, all other inventory fields and canonical state remain equal. Both snapshots must pass semantic cutover readiness. Missing comparison evidence fails closed. No data writes or apply-mode exception.

Restoration: strict comparison resumes automatically for every subsequent commit (parent pin no longer matches), non-production invocation, or expiry. The original strict helper remains the default. Remove the dormant exception helper/call site in subsequent maintenance; do not renew the pin or expiry without a separate decision.

Validation: 36 targeted tests cover default rejection, eligible weekly-only drift, expiry/context rejection, month/head/request changes, malformed periods, unknown fields, missing hashes, removed records and future protected fields. Production success and rollback target must be recorded separately from test results.
