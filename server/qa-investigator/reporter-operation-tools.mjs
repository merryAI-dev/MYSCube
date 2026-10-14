import { randomUUID } from "node:crypto";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
import { decodeFields } from "./pipeline-context.mjs";

const PROJECT = "inner-platform-live-20260316";
const OPERATIONS = [
  "registration.draft.save",
  "registration.submit",
  "project-change.draft.save",
  "project-change.submit",
  "project.executive-review",
];
const OUTCOMES = [
  "pending",
  "unknown",
  "validation_blocked",
  "rejected",
  "system_failed",
  "saved",
];
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const OPERATION_ID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const time = (value) =>
  typeof value === "string" &&
  ISO.test(value) &&
  Number.isFinite(Date.parse(value));
const fail = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};
const digest = (body) => candidateHash(body);
const envelope = (body) => {
  const content_hash = digest(body);
  return { ...body, content_hash, evidence_id: `ev_${content_hash}` };
};

export function createReporterOperationTools({
  auth,
  policy,
  authorize,
  runBinding,
  now = () => Date.now(),
}) {
  const p = structuredClone(policy),
    start = Date.parse(p?.allowedStartAt),
    end = Date.parse(p?.allowedEndAt);
  if (
    p?.cloudProject !== PROJECT ||
    p.tenant !== "mysc" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(p.trustedActorId || "") ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end - start > 86400000 ||
    typeof authorize !== "function" ||
    !runBinding?.run_id
  )
    throw Error("invalid_reporter_operation_policy");
  const base = `projects/${PROJECT}/databases/(default)/documents/orgs/mysc`;
  const prefix = base + "/reliability_operations/";
  const binding = digest({ policy: p, runBinding });
  const cursors = new Map();
  const snapshots = new Map();
  const validSnapshot = (r) => r && r.binding === binding && time(r.read_time)
    && r.start_at === p.allowedStartAt && r.end_at === p.allowedEndAt;
  const validReceipt = (r) =>
    r &&
    r.binding === binding &&
    UUID.test(r.token || "") &&
    time(r.read_time) &&
    time(r.after_at) &&
    /^[a-f0-9]{64}$/.test(r.after_id || "") &&
    r.start_at === p.allowedStartAt &&
    r.end_at === p.allowedEndAt &&
    Date.parse(r.after_at) >= start &&
    Date.parse(r.after_at) < end;
  function observeEvidence(e) {
    if (e?.source !== "query_reporter_operations" || e.status !== "available")
      return;
    const { content_hash, evidence_id, ...body } = e;
    if (
      evidence_id !== `ev_${content_hash}` ||
      digest(body) !== content_hash
    ) return;
    if (validReceipt(e.pagination_receipt)) {
      cursors.set(e.pagination_receipt.token, structuredClone(e.pagination_receipt));
    }
    if (validSnapshot(e.snapshot_receipt) && e.coverage?.continued === false
      && e.read_time === e.snapshot_receipt.read_time
      && e.start_at === p.allowedStartAt && e.end_at === p.allowedEndAt) {
      snapshots.set(evidence_id, structuredClone(e.snapshot_receipt));
    }
  }
  const registry = {
    query_reporter_operations: {
      description:
        "Read the verified reporter’s measured registration/change operation aggregates in the permitted window. Current state at a fixed read time, not immutable request history. Optional operation headers and collector gaps mean an empty page does not prove no attempt. Server-observed state and client-only reports are distinguished. To independently re-query a previously observed first-page snapshot, pass its server-registered snapshot_evidence_id; this makes a new authorized provider request at the same read time, not a cached response. Never combine it with continuation. Expired snapshots fail without substituting current data. Continue with next_continuation; no total page cap. Never treats stored request/release metadata as proof of the failed code.",
      parameters: {
        type: "object",
        properties: {
          continuation: { type: "string", pattern: "^[a-f0-9-]{36}$" },
          snapshot_evidence_id: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
        },
        additionalProperties: false,
        required: [],
      },
      async execute(args, { signal } = {}) {
        const observed_at = new Date(now()).toISOString();
        try {
          if (
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).some((k) => !["continuation", "snapshot_evidence_id"].includes(k)) ||
            (args.snapshot_evidence_id !== undefined && !/^ev_[a-f0-9]{64}$/.test(args.snapshot_evidence_id)) ||
            (args.continuation !== undefined && args.snapshot_evidence_id !== undefined) ||
            (args.continuation !== undefined && !UUID.test(args.continuation))
          )
            fail("invalid_scope");
          const cursor = args.continuation
            ? cursors.get(args.continuation)
            : null;
          if (args.continuation && !cursor) fail("invalid_continuation");
          const snapshot = args.snapshot_evidence_id ? snapshots.get(args.snapshot_evidence_id) : null;
          if (args.snapshot_evidence_id && !snapshot) fail("invalid_snapshot_reference");
          const readTime =
            cursor?.read_time || snapshot?.read_time ||
            new Date(Math.floor(now() / 1000) * 1000 - 1000).toISOString();
          if (
            Date.parse(readTime) > now() ||
            now() - Date.parse(readTime) > 55 * 60000
          )
            fail("source_snapshot_expired");
          signal?.throwIfAborted();
          try {
            await authorize();
          } catch {
            fail("actor_scope_changed");
          }
          const client = await auth.getClient();
          const keys = [
            "actorId",
            "operationId",
            "operationKey",
            "environment",
            "outcome",
            "serverObserved",
            "clientStarted",
            "createdAt",
            "updatedAt",
            "requestId",
            "releaseSha",
            "errorCode",
            "followup",
          ];
          const filters = [
            ["actorId", "EQUAL", { stringValue: p.trustedActorId }],
            ["environment", "EQUAL", { stringValue: "live" }],
            [
              "operationKey",
              "IN",
              {
                arrayValue: {
                  values: OPERATIONS.map((v) => ({ stringValue: v })),
                },
              },
            ],
            [
              "updatedAt",
              "GREATER_THAN_OR_EQUAL",
              { stringValue: p.allowedStartAt },
            ],
            ["updatedAt", "LESS_THAN", { stringValue: p.allowedEndAt }],
          ];
          const query = {
            from: [{ collectionId: "reliability_operations" }],
            select: { fields: keys.map((fieldPath) => ({ fieldPath })) },
            where: {
              compositeFilter: {
                op: "AND",
                filters: filters.map(([fieldPath, op, value]) => ({
                  fieldFilter: { field: { fieldPath }, op, value },
                })),
              },
            },
            orderBy: [
              { field: { fieldPath: "updatedAt" }, direction: "ASCENDING" },
              { field: { fieldPath: "__name__" }, direction: "ASCENDING" },
            ],
            limit: 101,
            ...(cursor
              ? {
                  startAt: {
                    before: false,
                    values: [
                      { stringValue: cursor.after_at },
                      { referenceValue: prefix + cursor.after_id },
                    ],
                  },
                }
              : {}),
          };
          const { data } = await client.request({
            url: `https://firestore.googleapis.com/v1/${base}:runQuery`,
            method: "POST",
            data: { structuredQuery: query, readTime },
            timeout: 20000,
            retry: false,
            ...(signal ? { signal } : {}),
          });
          signal?.throwIfAborted();
          try {
            await authorize();
          } catch {
            fail("actor_scope_changed");
          }
          if (!Array.isArray(data)) fail("source_invalid_response");
          const docs = data
            .filter((r) => r.document)
            .map((r) => ({
              name: r.document.name,
              value: decodeFields(r.document.fields),
            }));
          if (docs.length > 101) fail("source_invalid_response");
          // Invalid rows cannot be used as page boundaries or silently count as completed coverage.
          for (let i = 0; i < docs.length; i++) {
            const { name, value: v } = docs[i];
            if (
              typeof name !== "string" ||
              !name.startsWith(prefix) ||
              !/^[a-f0-9]{64}$/.test(name.slice(prefix.length)) ||
              v.actorId !== p.trustedActorId ||
              v.environment !== "live" ||
              !OPERATIONS.includes(v.operationKey) ||
              !OPERATION_ID.test(v.operationId || "") ||
              !OUTCOMES.includes(v.outcome) ||
              typeof v.serverObserved !== "boolean" ||
              typeof v.clientStarted !== "boolean" ||
              (!v.serverObserved &&
                !["pending", "unknown", "validation_blocked"].includes(
                  v.outcome,
                )) ||
              !time(v.updatedAt) ||
              Date.parse(v.updatedAt) < start ||
              Date.parse(v.updatedAt) >= end ||
              !time(v.createdAt) ||
              Date.parse(v.createdAt) > Date.parse(v.updatedAt)
            )
              fail("source_invalid_response");
            const prev = i
              ? { at: docs[i - 1].value.updatedAt, name: docs[i - 1].name }
              : cursor
                ? { at: cursor.after_at, name: prefix + cursor.after_id }
                : null;
            if (
              prev &&
              (v.updatedAt < prev.at ||
                (v.updatedAt === prev.at && name <= prev.name))
            )
              fail("source_invalid_response");
          }
          const selected = docs.slice(0, 100);
          const rows = selected.map(({ name, value: v }) => ({
            operation_ref: name.slice(prefix.length),
            operation_id: v.operationId,
            operation: v.operationKey,
            outcome: v.outcome,
            authority: v.serverObserved
              ? "server_observed_aggregate"
              : "client_report_only",
            client_started: v.clientStarted,
            created_at: v.createdAt,
            updated_at: v.updatedAt,
            request_id:
              v.serverObserved &&
              /^(?:req_[A-Za-z0-9_-]{1,120}|[a-f0-9-]{36})$/.test(
                v.requestId || "",
              )
                ? v.requestId
                : null,
            metadata_release_sha:
              v.serverObserved && /^[a-f0-9]{40}$/.test(v.releaseSha || "")
                ? v.releaseSha
                : null,
            error_code:
              v.serverObserved &&
              /^[a-z][a-z0-9_]{0,99}$/.test(v.errorCode || "")
                ? v.errorCode
                : null,
            followup:
              v.serverObserved &&
              ["not_applicable", "unconfirmed", "confirmed"].includes(
                v.followup,
              )
                ? v.followup
                : null,
          }));
          const last = selected.at(-1);
          const receipt =
            docs.length > 100
              ? {
                  token: randomUUID(),
                  binding,
                  read_time: readTime,
                  start_at: p.allowedStartAt,
                  end_at: p.allowedEndAt,
                  after_at: last.value.updatedAt,
                  after_id: last.name.slice(prefix.length),
                }
              : null;
          if (receipt) cursors.set(receipt.token, receipt);
          const result = envelope({
            source: "query_reporter_operations",
            status: "available",
            observed_at,
            rows,
            next_continuation: receipt?.token || null,
            pagination_receipt: receipt,
            snapshot_receipt: { binding, read_time: readTime, start_at: p.allowedStartAt, end_at: p.allowedEndAt },
            read_time: readTime,
            start_at: p.allowedStartAt,
            end_at: p.allowedEndAt,
            coverage: {
              complete: false,
              page_exhausted: !receipt,
              continued: Boolean(cursor),
              snapshot_replayed: Boolean(snapshot),
              limit: 100,
              returned: rows.length,
              scope: "reporter_measured_operation_aggregates",
              time_field: "updatedAt",
              historical_request_proven: false,
              code_revision_verified: false,
              collection_gaps_possible: true,
              latest_mutation_can_move_record_outside_window: true,
              note: "Fixed read-time aggregate state. Optional operation headers and collection failures omit attempts. Later client observations can update timestamps; saved results suppress later failed retries. Request IDs may be caller supplied. Empty results do not establish no attempt.",
            },
            cause_status: "not_established",
          });
          observeEvidence(result);
          return result;
        } catch (error) {
          signal?.throwIfAborted();
          const status = error?.response?.status;
          const providerMessage = error?.response?.data?.error?.message || "";
          const missingIndex =
            error?.response?.data?.error?.status === "FAILED_PRECONDITION" &&
            /requires an index/i.test(providerMessage);
          const safe = new Set([
            "invalid_scope",
            "invalid_continuation",
            "invalid_snapshot_reference",
            "source_snapshot_expired",
            "actor_scope_changed",
            "source_invalid_response",
          ]);
          const code = safe.has(error.safeCode)
            ? error.safeCode
            : status === 403
              ? "source_access_denied"
              : missingIndex
                ? "source_index_required"
                : error?.response?.data?.error?.status === "FAILED_PRECONDITION"
                  ? "source_precondition_failed"
                  : ["ETIMEDOUT", "ECONNABORTED"].includes(error.code)
                    ? "source_timeout"
                    : "source_unavailable";
          return envelope({
            source: "query_reporter_operations",
            status: "unavailable",
            observed_at,
            error_code: code,
            rows: [],
            coverage: { complete: false, snapshot_fallback: false },
            cause_status: "not_established",
          });
        }
      },
    },
  };
  Object.defineProperty(registry, "observeEvidence", {
    value: observeEvidence,
  });
  return registry;
}
