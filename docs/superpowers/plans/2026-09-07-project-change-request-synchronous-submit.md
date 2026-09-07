# Project Change Request Synchronous Submit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make a submitted project change immediately reviewable with the exact submitted attachments, then apply it atomically only when the organization head approves it.

**Architecture:** Firestore remains the only business source. Upload change-request files directly to the existing permanent private Storage prefix, freeze a request without mutating the project, and reuse the current review transaction with a corrected version CAS. The existing outbox and Drive client create a non-blocking archive afterward.

**Tech Stack:** Node.js ESM BFF, Firestore transactions, Firebase Storage, Google Drive client, React/TypeScript, Vitest.

---

## Scope and stage gates

Run `/sprint` before product edits and record these pass criteria:

1. Upload writes the permanent Storage object.
2. Submit writes request/draft/lease/audit/idempotency/outbox, but not project.
3. Admin GET immediately reads that request and its attachments.
4. Approve writes project and request in one transaction; reject and withdraw never write project.
5. Drive is never read by submit, review, or approve.

Use only the focused tests below. Do not add emulator, browser, or full-regression runs; Boram owns those checks. Do not edit cashflow, weekly-settlement, or monthly-settlement files. Preserve the unrelated dirty worktree and stage exact paths only.

## File map

| Area | Files |
| --- | --- |
| Permanent files | `server/bff/project-request-contract-storage.mjs`, its existing test |
| Submit/withdraw/outbox | `server/bff/routes/project-info-drafts.mjs`, its existing test |
| Inbox/approve/reject | `server/bff/routes/projects.mjs`, its existing test |
| Admin documents | `ProjectMigrationAuditPage.tsx`, `MigrationAuditDocumentDialog.tsx`, existing shell test |
| Request-first UI state | `project-migration-console.ts`, `PortalProjectEdit.tsx`, existing tests |
| One-shot repair | `scripts/normalize-project-change-requests.mjs`, one focused test |
| Drive backup | `server/bff/google-drive.mjs`, `server/bff/app.mjs`, existing tests |

## Task 1: Upload change attachments to the permanent private path

**Files:**
- Modify: `server/bff/project-request-contract-storage.mjs`
- Modify: `server/bff/project-request-contract-storage.test.ts`
- Modify: `server/bff/routes/project-info-drafts.mjs`
- Modify: `server/bff/routes/project-info-drafts.test.mjs`

- [ ] Change the existing attachment test to expect `uploadProjectRegistrationAttachment`, with `projectId`, `draftId`, and `attachmentId`, returning a path below `orgs/mysc/project-registration-documents/project-a/`.
- [ ] Extend the existing storage test for two concrete operations: `inspectProjectRegistrationAttachment` and owner-safe `deleteProjectRegistrationAttachment`. A different `draftId` must not delete the object.
- [ ] Run the RED check:

```bash
npm test -- --run server/bff/project-request-contract-storage.test.ts server/bff/routes/project-info-drafts.test.mjs
```

Expected: only the new path/method assertions fail.

- [ ] Reuse `uploadProjectRegistrationAttachment`; add optional `draftId` to object metadata without changing its canonical path.
- [ ] Add `inspectProjectRegistrationAttachment` beside the existing permanent download method. It validates the project prefix and returns path, size, content type, and stored attachment ID from Storage metadata.
- [ ] Add `deleteProjectRegistrationAttachment`. It validates the same prefix, reads metadata, and deletes only when stored `draftId === input.draftId`; use `ignoreNotFound: true`.
- [ ] In `addAttachment`, use those permanent upload/delete methods for upload failure, replacement, and removal cleanup. Inherited files from an earlier submitted request survive because their stored draft ID differs.
- [ ] Rerun the two focused tests, then commit exact files:

```bash
git add server/bff/project-request-contract-storage.mjs server/bff/project-request-contract-storage.test.ts server/bff/routes/project-info-drafts.mjs server/bff/routes/project-info-drafts.test.mjs
git commit -m "fix(projects): store change attachments permanently"
```

## Task 2: Submit the request without changing the project

**Files:**
- Modify: `server/bff/routes/project-info-drafts.mjs`
- Modify: `server/bff/routes/project-info-drafts.test.mjs`
- Modify: `server/bff/routes/projects.mjs`
- Modify: `server/bff/routes/projects.test.ts`

- [ ] Replace the nearest atomic-submit assertion. Starting with project version `6`, require project data to remain byte-for-byte unchanged and request to contain:

```js
expect(requestAfter.data()).toMatchObject({
  requestKind: 'CHANGE',
  status: 'PENDING',
  baseProjectVersion: 6,
  targetProjectVersion: 7,
  beforeSnapshot: expectedBefore,
  proposedSnapshot: expectedProposed,
});
expect(result.body.projectVersion).toBe(6);
```

- [ ] In the same fixture, assert every non-null document path is canonical and Storage metadata was inspected before transaction writes.
- [ ] Extend the current inbox test so the request is visible without running its outbox event.
- [ ] Run the RED check:

```bash
npm test -- --run server/bff/routes/project-info-drafts.test.mjs server/bff/routes/projects.test.ts
```

- [ ] Simplify `buildProjectInfoChangeSubmission`: retain existing validation and snapshot builders, calculate `base=currentVersion` and `target=currentVersion+1`, return `projectRequest`, and remove its project review-state patch. Resubmission is based on the prior CHANGE request, not a project state created by submit.
- [ ] Before `db.runTransaction`, inspect each attachment and compare exact path, attachment ID, size, and content type. Missing/mismatched objects return the approved attachment-verification error with zero Firestore writes.
- [ ] In the transaction, remove `tx.set(projectRef, nextProject)`. Keep request, submitted draft, released lease, audit, idempotency, and outbox writes. Make the outbox payload identity-only: project ID, request ID, request version, target version.
- [ ] Remove the synchronous `publishSubmittedAttachments` call after commit. Canonical CHANGE paths already pass the existing inbox publication predicate; registration relocation remains untouched.
- [ ] Rerun the two tests and commit:

```bash
git add server/bff/routes/project-info-drafts.mjs server/bff/routes/project-info-drafts.test.mjs server/bff/routes/projects.mjs server/bff/routes/projects.test.ts
git commit -m "fix(projects): submit changes before applying them"
```

## Task 3: Apply on approval and nowhere else

**Files:**
- Modify: `server/bff/routes/projects.mjs`
- Modify: `server/bff/routes/projects.test.ts`
- Modify: `server/bff/routes/project-info-drafts.mjs`
- Modify: `server/bff/routes/project-info-drafts.test.mjs`

- [ ] Rework the nearest existing tests, without a new matrix:
  - approval changes project `6 -> 7` and request `PENDING -> APPROVED` together;
  - forced transaction failure leaves both documents unchanged;
  - a `6 -> 7` request against project `7` returns `409 canonical_version_conflict`, writes zero;
  - reject changes request only;
  - withdraw changes request/draft only.
- [ ] Run the RED check:

```bash
npm test -- --run server/bff/routes/projects.test.ts server/bff/routes/project-info-drafts.test.mjs
```

- [ ] Correct `mergeProjectAndRequestDocs` rather than adding a workflow layer. Add one option, `writeProject = true`. Approved CHANGE validation becomes `baseProjectVersion === currentVersion` and `targetProjectVersion === currentVersion + 1`.
- [ ] A pending CHANGE request is reviewable from request state even while the unchanged project remains `APPROVED`. Approval applies `proposedSnapshot`, sets the project directly to target version, patches request APPROVED, and keeps participation sync in that Firestore transaction.
- [ ] For rejected CHANGE requests pass `writeProject: false`; keep validation but do not bump/write project.
- [ ] Delete the management-planning branch that reapplies a pending CHANGE snapshot. Organization-head approval is its only application point.
- [ ] In `withdraw`, delete project restoration/version mutation and `tx.set(projectRef, ...)`; retain owner validation, WITHDRAWN request, reopened draft, lease, audit, and idempotency.
- [ ] Rerun the focused tests and commit:

```bash
git add server/bff/routes/projects.mjs server/bff/routes/projects.test.ts server/bff/routes/project-info-drafts.mjs server/bff/routes/project-info-drafts.test.mjs
git commit -m "fix(projects): apply change requests on approval"
```

## Task 4: Make the request the sole admin document source

**Files:**
- Modify: `server/bff/routes/projects.mjs`
- Modify: `server/bff/routes/projects.test.ts`
- Modify: `src/app/components/projects/ProjectMigrationAuditPage.tsx`
- Modify: `src/app/components/projects/migration-audit/MigrationAuditDocumentDialog.tsx`
- Modify: `src/app/components/projects/ProjectMigrationAuditPage.shell.test.ts`

- [ ] In the existing admin shell case, use a request with explicit `contractDocument: null` and a project with an old contract. Expect `미제출` and no project attachment URL.
- [ ] In the existing approval test, make one request attachment absent from the injected Storage service. Expect the attachment error and zero project/request writes.
- [ ] Run the RED check:

```bash
npm test -- --run server/bff/routes/projects.test.ts src/app/components/projects/ProjectMigrationAuditPage.shell.test.ts
```

- [ ] In both admin components, choose the source once at request level, never field by field:

```ts
const reviewPayload = record.request
  ? resolveProjectRequestPayload(record.request)
  : record.project;
const document = reviewPayload?.[definition.field] ?? null;
```

- [ ] Keep the existing request attachment endpoint. Add one async helper beside `assertProjectRequestAttachmentsPublished` that inspects each non-null request document and compares canonical prefix, attachment ID, size, and content type. Call it before the approval transaction.
- [ ] Do not add a Storage/Firestore lock: after submit, owner-safe cleanup cannot delete the frozen file.
- [ ] Rerun and commit:

```bash
git add server/bff/routes/projects.mjs server/bff/routes/projects.test.ts src/app/components/projects/ProjectMigrationAuditPage.tsx src/app/components/projects/migration-audit/MigrationAuditDocumentDialog.tsx src/app/components/projects/ProjectMigrationAuditPage.shell.test.ts
git commit -m "fix(projects): review only submitted documents"
```

## Task 5: Show request-first state in admin and portal

**Files:**
- Modify: `src/app/platform/project-migration-console.ts`
- Modify: `src/app/platform/project-migration-console.test.ts`
- Modify: `src/app/components/portal/PortalProjectEdit.tsx`
- Modify: `src/app/components/portal/PortalProjectEdit.persist-shell.test.ts`

- [ ] Use a project that remains `executiveReviewStatus: APPROVED`. Existing cases must expect: PENDING CHANGE -> admin pending and withdraw; REJECTED CHANGE -> revision rejected and resubmit; APPROVED CHANGE -> normal approved project.
- [ ] Run the RED check:

```bash
npm test -- --run src/app/platform/project-migration-console.test.ts src/app/components/portal/PortalProjectEdit.persist-shell.test.ts
```

- [ ] In `deriveMigrationAuditStatus`, handle PENDING/REJECTED CHANGE request state before the project APPROVED short-circuit. Leave registration ordering unchanged.
- [ ] In `PortalProjectEdit`, derive one `changeRequestStatus` from `requestDoc` and use it for pending banner, withdraw, rejection feedback, and executive resubmit. Keep the current pending `proposedSnapshot` overlay for editor contents.
- [ ] Rerun and commit:

```bash
git add src/app/platform/project-migration-console.ts src/app/platform/project-migration-console.test.ts src/app/components/portal/PortalProjectEdit.tsx src/app/components/portal/PortalProjectEdit.persist-shell.test.ts
git commit -m "fix(projects): show request-first review state"
```

## Task 6: Normalize only provably safe legacy requests

**Files:**
- Create: `scripts/normalize-project-change-requests.mjs`
- Create: `server/bff/project-change-request-normalization.test.mjs`
- Modify: `server/bff/routes/projects.mjs`

- [ ] Export the existing project-to-request snapshot builder needed by the script; do not copy its field list.
- [ ] Write one table test: safe missing-target request; stale project/snapshot; missing or mismatched attachment. Sabotage the frozen plan digest or update time once and assert apply writes zero.
- [ ] Run RED:

```bash
npm test -- --run server/bff/project-change-request-normalization.test.mjs
```

- [ ] Implement one dry-run-first script with the installed Firebase Admin SDK. Dry-run CLI:

```bash
node scripts/normalize-project-change-requests.mjs --firebase-project inner-platform-live-20260316 --tenant mysc --output /absolute/private/path/project-change-normalization.json
```

- [ ] Write the mode-`0600` report with exact request/project paths, complete original data, update times, stable hashes, attachment metadata checks, SAFE/STALE classification, and one plan digest.
- [ ] Classify SAFE only when: PENDING CHANGE has no target; project current version equals old base plus one; proposed business values and attachment refs equal current project; every canonical attachment exists. Everything else stays STALE.
- [ ] Apply CLI requires the frozen report and reason:

```bash
node scripts/normalize-project-change-requests.mjs --firebase-project inner-platform-live-20260316 --tenant mysc --apply --plan /absolute/private/path/project-change-normalization.json --reason "2026-09-07 approved project change request normalization"
```

- [ ] For each SAFE row, one transaction rereads project/request, checks path/hash/updateTime, and patches request only: `base=current`, `target=current+1`, `beforeSnapshot=currentProjectSnapshot`, `updatedAt=now`. Preserve proposed snapshot, request version, requester/time, state, and attachments. Never hardcode “7” as write permission; the signed-off plan is the allowlist.
- [ ] Rerun, syntax-check, and commit. Do not run live apply:

```bash
npm test -- --run server/bff/project-change-request-normalization.test.mjs
node --check scripts/normalize-project-change-requests.mjs
git add scripts/normalize-project-change-requests.mjs server/bff/project-change-request-normalization.test.mjs server/bff/routes/projects.mjs
git commit -m "fix(projects): normalize safe legacy change requests"
```

## Task 7: Archive the latest submitted request to Drive afterward

**Files:**
- Modify: `server/bff/google-drive.mjs`
- Modify: `server/bff/google-drive.test.ts`
- Modify: `server/bff/routes/project-info-drafts.mjs`
- Modify: `server/bff/routes/project-info-drafts.test.mjs`
- Modify: `server/bff/app.mjs`

- [ ] Replace existing project-info relocation outbox expectations: disabled Drive succeeds; enabled Drive creates/reuses one folder; retry uploads only missing files; stale request-version event does nothing; Drive failure leaves outbox retryable and business state unchanged.
- [ ] Run RED:

```bash
npm test -- --run server/bff/google-drive.test.ts server/bff/routes/project-info-drafts.test.mjs
```

- [ ] Add one concrete `ensureProjectChangeRequestFolder` method. Reuse `ensureProjectRootFolder`, `findFolder`, and `createFolder` for `변경 요청/{YYYY-MM-DD}_{requestId}_v{requestVersion}`. Use existing Drive `appProperties`; do not add a generic repository.
- [ ] Repurpose `createProjectInfoSubmittedOutboxHandler`: verify current request/version, return success when Drive disabled, list folder once, upload only missing `요청내용.json`, `요청요약.txt`, and submitted originals, then recheck and patch only `driveArchiveFolderId`, `driveArchiveFolderLink`, `driveArchivedAt`, `updatedAt`.
- [ ] Download source bytes through `downloadProjectRegistrationAttachment`. Use deterministic name/appProperties for retry idempotency. Throw on Drive failure so the existing outbox retries; never roll back submit or approval.
- [ ] Inject existing `driveService` from `app.mjs`, rerun, and commit:

```bash
npm test -- --run server/bff/google-drive.test.ts server/bff/routes/project-info-drafts.test.mjs
git add server/bff/google-drive.mjs server/bff/google-drive.test.ts server/bff/routes/project-info-drafts.mjs server/bff/routes/project-info-drafts.test.mjs server/bff/app.mjs
git commit -m "feat(projects): archive submitted changes to Drive"
```

## Task 8: Scoped verification, automatic deploy, then normalization

- [ ] Run only approved focused checks:

```bash
npm test -- --run server/bff/project-request-contract-storage.test.ts server/bff/routes/project-info-drafts.test.mjs server/bff/routes/projects.test.ts server/bff/project-change-request-normalization.test.mjs server/bff/google-drive.test.ts src/app/platform/project-migration-console.test.ts src/app/components/projects/ProjectMigrationAuditPage.shell.test.ts src/app/components/portal/PortalProjectEdit.persist-shell.test.ts
npm run build
git diff --check
```

- [ ] Inspect only changes after this plan commit:

```bash
PROJECT_CHANGE_BASE="$(git log -1 --format=%H -- docs/superpowers/plans/2026-09-07-project-change-request-synchronous-submit.md)"
git diff --name-only "$PROJECT_CHANGE_BASE"..HEAD
```

It must contain only implementation files named in the file map; no cashflow or settlement path. Verify every new helper and script entry point has a real caller.
- [ ] Push/merge through the normal PR. Main CI must trigger Production Deploy automatically. Never run `vercel --prod`, `deploy-prod-align.mjs`, or routine manual dispatch.
- [ ] Before any live normalization, display the required warning:

> 잠깐, 이 작업은 되돌리기 어려울 수 있어요! 실행 전에 **사본을 먼저 만들어두는 걸 추천해요**. 준비됐으면 같이 시작해봐요 :)

- [ ] After deployment, create a private temp directory outside the repo and run dry-run only:

```bash
NORMALIZE_DIR="$(mktemp -d)"
node scripts/normalize-project-change-requests.mjs --firebase-project inner-platform-live-20260316 --tenant mysc --output "$NORMALIZE_DIR/project-change-normalization.json"
```

Expected: zero writes and the expected safe/stale split. If IDs or hashes differ, stop.

- [ ] After Boram reviews that report, apply that exact plan, then reread:

```bash
node scripts/normalize-project-change-requests.mjs --firebase-project inner-platform-live-20260316 --tenant mysc --apply --plan "$NORMALIZE_DIR/project-change-normalization.json" --reason "2026-09-07 approved project change request normalization"
```

Expected: safe requests have canonical base/target; stale requests and all projects are unchanged by normalization; admin GET immediately returns request documents. Drive fields may remain absent until outbox success without affecting review.

## Self-review checklist

- Submit/reject/withdraw tests assert stored project data, not only HTTP status.
- Approval sabotage asserts request and project are both unchanged.
- Explicit request `null` never falls back to a project document.
- Project CHANGE relocation has zero callers; registration relocation still has callers.
- Drive archive fields are absent from all business decisions.
- Legacy handling exists only in the one-shot script, not runtime approval.
- No new public type is added unless a real UI caller consumes it.
- No cashflow, weekly, or monthly settlement file is staged.
