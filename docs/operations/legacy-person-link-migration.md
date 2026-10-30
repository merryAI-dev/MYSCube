# Verified legacy person link migration

An active canonical administrator can explicitly migrate a person's email-derived legacy UID to their verified Google login UID using the existing account-link UI. This operation changes only the People link; it does not approve a role, modify legacy member documents, or change Auth claims.

Eligibility requires an exact normalized email match, the legacy member record, a unique person/email and old/new UID, and no Auth user at the legacy UID. Disabled Auth users count as existing. Lookup failures fail closed. The command binds the selected person version, expected old UID, expected new UID and explicit confirmation.

The transaction rechecks actor authority and identity conflicts, reads Auth again, then commits the People change, before/after audit record and idempotency result together. A lost response must be reconciled by reading the current link; retries reuse the original body and key. Definite errors refresh state before another confirmation.

Firebase Auth cannot join a Firestore transaction. Rechecking during each attempt reduces but cannot eliminate an Auth change between the last Auth read and Firestore commit. Do not describe these two systems as atomically validated. If identities change or any lookup is uncertain, stop and investigate; never clear a UID directly to bypass these checks.

The deployment contains only code and synthetic test fixtures. Production identity migration remains a separate explicitly authorized operation with fresh target verification and persisted readback. Roles require their own approval.
