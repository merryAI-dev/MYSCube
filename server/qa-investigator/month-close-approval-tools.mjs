import { createHash } from "node:crypto";
import { cashflowCloseHash } from "../bff/cashflow-close-hash.mjs";
const CONTRACT = "cashflow-cumulative-close-v2";
const SHA = /^sha256:[a-f0-9]{64}$/;
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const LINES = [
  "MYSC_PREPAY_IN",
  "MYSC_PREPAY_LABOR_IN",
  "MYSC_PREPAY_INPUT_VAT_IN",
  "SALES_IN",
  "SALES_VAT_IN",
  "TEAM_SUPPORT_IN",
  "BANK_INTEREST_IN",
  "MYSC_PREPAY_DIRECT_OUT",
  "MYSC_PREPAY_LABOR_OUT",
  "DIRECT_COST_OUT",
  "INPUT_VAT_OUT",
  "MYSC_LABOR_OUT",
  "MYSC_PROFIT_OUT",
  "SALES_VAT_OUT",
  "TEAM_SUPPORT_OUT",
  "BANK_INTEREST_OUT",
];
const SOURCES = {
  bff: "336fe9b2e87de39e8c07eafe843d18e05a7aca2e",
  jvm: "1c6d08176c3c5e9d05f2a9ef05d2cb01bea04d14",
};
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeHash = (value) =>
  typeof value === "string" && SHA.test(value) ? value : null;
const fail = (code) => {
  throw Object.assign(new Error(code), {
    safeCode: code,
  });
};
const monthIndex = (value) =>
  Number(value.slice(0, 4)) * 12 + Number(value.slice(5)) - 1;
const monthAt = (value) =>
  `${Math.floor(value / 12)}-${String((value % 12) + 1).padStart(2, "0")}`;

// Reject Firestore types that cannot be reproduced losslessly by the shared JSON hash.
function decode(v) {
  if ("nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("integerValue" in v) {
    const n = Number(v.integerValue);
    if (!Number.isSafeInteger(n)) fail("unsupported_canonical_value");
    return n;
  }
  if ("doubleValue" in v && Number.isFinite(v.doubleValue))
    return v.doubleValue;
  if ("mapValue" in v)
    return Object.fromEntries(
      Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]),
    );
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  fail("unsupported_canonical_value");
}
// JVM longValue accepts integer strings; unsafe or non-integral representations stay unknown.
function integer(value) {
  if (typeof value === "string" && !/^[+-]?\d+$/.test(value)) return null;
  if (!["string", "number"].includes(typeof value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
function safeNumericDomain(value) {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(safeNumericDomain);
  if (value && typeof value === "object")
    return Object.values(value).every(safeNumericDomain);
  return true;
}
function canonicalCells(raw) {
  if (!Array.isArray(raw) || raw.length !== 160)
    return {
      code: "cell_count",
    };
  const result = [];
  for (const mode of ["projection", "actual"])
    for (let weekNo = 1; weekNo <= 5; weekNo++)
      for (const cashflowLine of LINES) {
        const c = raw[result.length];
        if (c && integer(c.weekNo) === null) return {code: "cell_week_representation", unknown: true};
        if (
          !c ||
          c.mode !== mode ||
          integer(c.weekNo) !== weekNo ||
          c.cashflowLine !== cashflowLine ||
          !["EMPTY", "ZERO", "VALUE"].includes(c.cellState)
        )
          return {
            code: "cell_order",
          };
        if (
          (c.cellState === "EMPTY" && c.amount != null) ||
          (c.cellState !== "EMPTY" && c.amount == null) ||
          (c.cellState === "ZERO" && Number(c.amount) !== 0)
        )
          return {
            code: "cell_state",
          };
        // JVM permits decimal strings. Avoid claiming parity for strings or non-integers here.
        if (
          c.amount != null &&
          (typeof c.amount !== "number" || !Number.isSafeInteger(c.amount))
        )
          return {
            code: "cell_numeric_representation",
            unknown: true,
          };
        result.push({
          mode,
          weekNo,
          cashflowLine,
          cellState: c.cellState,
          amount: c.amount ?? null,
        });
      }
  return {
    cells: result,
  };
}

/** Exact server-owned project/cycle scope. No caller-supplied document paths or expected request values. */
export function createMonthCloseApprovalTools({ auth, policy, authorize }) {
  const p = structuredClone(policy);
  const projects =
    p?.allowedProjectIds ?? p?.allowedCases?.map((c) => c.projectId);
  if (
    p?.cloudProject !== "inner-platform-live-20260316" ||
    p.tenant !== "mysc" ||
    !Array.isArray(projects) ||
    !projects.length ||
    projects.some((id) => typeof id !== "string" || !/^p\d{10,20}$/.test(id)) ||
    (p.allowedCases !== undefined &&
      (!Array.isArray(p.allowedCases) ||
        !p.allowedCases.length ||
        p.allowedCases.some(
          (c) =>
            !projects.includes(c.projectId) ||
            typeof c.cycleYearMonth !== "string" ||
            !MONTH.test(c.cycleYearMonth) ||
            c.cycleYearMonth < "2023-02",
        ))) ||
    typeof authorize !== "function"
  )
    throw Error("invalid_month_close_inspection_policy");
  return {
    inspect_month_close_approval_evidence: {
      description:
        "Inspect current canonical month-close approval evidence in one read-only Firestore transaction. Distinguishes warnings from blocking predicates. Does not reproduce historical HTTP inputs or prove the incident cause. Returns hashes and condition outcomes, never amounts or raw source.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["project_id", "cycle_year_month"],
        properties: {
          project_id: {
            type: "string",
            enum: [...new Set(projects)],
          },
          cycle_year_month: {
            type: "string",
            pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$",
          },
        },
      },
      async execute(args, { signal } = {}) {
        let client, transaction;
        async function checkAuthority() {
          try {
            await authorize();
          } catch {
            fail("source_authorization_revoked");
          }
        }
        const root = `projects/${p.cloudProject}/databases/(default)/documents`;
        const rows = [],
          documents = [];
        const check = (condition, result, extra = {}) =>
          rows.push({
            condition,
            status: result === null ? "unknown" : result ? "pass" : "fail",
            ...extra,
          });
        async function request(path, method = "GET", data) {
          signal?.throwIfAborted();
          await checkAuthority();
          const response = await client.request({
            url: `https://firestore.googleapis.com/v1/${path}`,
            method,
            ...(data
              ? {
                  data,
                }
              : {}),
            signal,
            timeout: 20000,
            retry: false,
            maxRedirects: 0,
          });
          signal?.throwIfAborted();
          return response.data;
        }
        async function read(relative, selectedFields) {
          const query = new URLSearchParams({
            transaction,
          });
          for (const key of selectedFields)
            query.append("mask.fieldPaths", key);
          let doc;
          try {
            doc = await request(`${root}/orgs/mysc/${relative}?${query}`);
          } catch (e) {
            if (Number(e?.response?.status) === 404) {
              documents.push({
                document_id: relative,
                exists: false,
                update_time: null,
              });
              return null;
            }
            throw e;
          }
          if (!doc || doc.name !== `${root}/orgs/mysc/${relative}`)
            fail("source_invalid_response");
          documents.push({
            document_id: relative,
            exists: true,
            update_time:
              typeof doc.updateTime === "string" &&
              Number.isFinite(Date.parse(doc.updateTime))
                ? doc.updateTime
                : null,
          });
          return Object.fromEntries(
            Object.entries(doc.fields || {}).map(([k, v]) => [k, decode(v)]),
          );
        }
        function envelope(status, error_code) {
          const result = {
            status,
            ...(error_code
              ? {
                  error_code,
                }
              : {}),
            source: "inspect_month_close_approval_evidence",
            ...(status === "available"
              ? {
                  project_id: args.project_id,
                  cycle_year_month: args.cycle_year_month,
                }
              : {}),
            checks: rows,
            documents,
            source_revisions: SOURCES,
            source_rule_annotations: [
              {
                code: "SHEET_CONTROL_TOTAL_MISMATCH",
                classification: "warning_not_approval_blocker",
                observed_mismatch: "unknown",
              },
            ],
            coverage: {
              historical_state_verified: false,
              deployed_rule_verified: false,
              actual_request_inputs_verified: false,
              readonly_consistent_snapshot: status === "available",
              raw_amounts_included: false,
              raw_source_included: false,
              complete_approval_emulation: false,
            },
            cause_status: "not_established",
          };
          const content_hash = digest(result);
          return {
            ...result,
            content_hash,
            evidence_id: `ev_${content_hash}`,
            observed_at: new Date().toISOString(),
          };
        }
        try {
          if (
            !args ||
            Object.keys(args).some(
              (k) => !["project_id", "cycle_year_month"].includes(k),
            ) ||
            !projects.includes(args.project_id) ||
            typeof args.cycle_year_month !== "string" ||
            !MONTH.test(args.cycle_year_month) ||
            args.cycle_year_month < "2023-02" ||
            (p.allowedCases &&
              !p.allowedCases.some(
                (c) =>
                  c.projectId === args.project_id &&
                  c.cycleYearMonth === args.cycle_year_month,
              ))
          )
            fail("invalid_scope");
          await checkAuthority();
          if (!auth?.getClient) fail("source_credentials_missing");
          client = await auth.getClient();
          transaction = (
            await request(`${root}:beginTransaction`, "POST", {
              options: {
                readOnly: {},
              },
            })
          )?.transaction;
          if (typeof transaction !== "string" || !transaction)
            fail("source_invalid_response");
          const id = args.project_id,
            cycle = args.cycle_year_month,
            requestId = `${id}-${cycle}`,
            target = monthAt(monthIndex(cycle) - 1);
          const header = await read(
            `cashflow_month_close_requests/${requestId}`,
            [
              "contractVersion",
              "requestId",
              "projectId",
              "cycleYearMonth",
              "yearMonth",
              "fromMonth",
              "throughMonth",
              "monthCloseTargetYearMonth",
              "status",
              "revision",
              "evidenceRevision",
              "workflowRevision",
              "manifestHash",
              "monthCount",
            ],
          );
          check("header_exists", !!header);
          check("actual_http_request_matches_header", null, {
            missing_data:
              "Failed JVM HTTP request requestRevision, manifestHash, expectedWorkflowRevision and idempotency evidence.",
          });
          if (header) {
            const revision = integer(header.evidenceRevision);
            check(
              "header_identity",
              header.contractVersion === CONTRACT &&
                header.requestId === requestId &&
                header.projectId === id &&
                (typeof header.cycleYearMonth === "string" && header.cycleYearMonth.trim() ? header.cycleYearMonth : header.yearMonth) === cycle &&
                header.fromMonth === "2023-01",
            );
            check(
              "header_pending_approval",
              header.status === "PENDING_APPROVAL",
            );
            check("header_revision", revision === null ? null : revision > 0);
            check(
              "cycle_target",
              header.monthCloseTargetYearMonth === target &&
                header.throughMonth === target,
            );
            const months = Array.from(
              {
                length: monthIndex(target) - monthIndex("2023-01") + 1,
              },
              (_, n) => monthAt(monthIndex("2023-01") + n),
            );
            check(
              "month_count",
              integer(header.monthCount) === null
                ? null
                : integer(header.monthCount) === months.length,
            );
            const manifestMonths = [];
            let allHashes = true;
            if (Number.isSafeInteger(revision) && revision > 0)
              for (const month of months) {
                const shard = await read(
                  `cashflow_month_close_request_months/${requestId}-r${revision}-${month}`,
                  [
                    "contractVersion",
                    "requestId",
                    "requestRevision",
                    "projectId",
                    "yearMonth",
                    "cells",
                    "source",
                    "shardHash",
                  ],
                );
                check("shard_exists", !!shard, {
                  month,
                });
                if (!shard) {
                  allHashes = false;
                  continue;
                }
                check(
                  "shard_scope",
                  integer(shard.requestRevision) === null
                    ? null
                    : shard.contractVersion === CONTRACT &&
                        shard.requestId === requestId &&
                        integer(shard.requestRevision) === revision &&
                        shard.projectId === id &&
                        shard.yearMonth === month,
                  {
                    month,
                  },
                );
                const normalized = canonicalCells(shard.cells);
                check(
                  normalized.code || "cell_shape",
                  normalized.unknown ? null : !!normalized.cells,
                  {
                    month,
                  },
                );
                if (!normalized.cells) {
                  allHashes = false;
                  continue;
                }
                const source =
                  shard.source &&
                  typeof shard.source === "object" &&
                  !Array.isArray(shard.source)
                    ? shard.source
                    : {};
                if (!safeNumericDomain(source)) {
                  check("shard_hash", null, {
                    month,
                    missing_data:
                      "Numeric source representation is outside proven JVM/JS parity domain.",
                  });
                  allHashes = false;
                  continue;
                }
                const computed = cashflowCloseHash({
                  contractVersion: CONTRACT,
                  requestId,
                  requestRevision: revision,
                  projectId: id,
                  yearMonth: month,
                  cells: normalized.cells,
                  source,
                });
                const stored = safeHash(shard.shardHash);
                check("shard_hash", stored === computed, {
                  month,
                  stored_hash: stored,
                  computed_hash: computed,
                });
                manifestMonths.push({
                  yearMonth: month,
                  shardHash: shard.shardHash,
                });
              }
            else allHashes = false;
            const computed = allHashes
              ? cashflowCloseHash({
                  contractVersion: CONTRACT,
                  requestId,
                  requestRevision: revision,
                  projectId: id,
                  fromMonth: "2023-01",
                  yearMonth: cycle,
                  months: manifestMonths,
                })
              : null;
            check(
              "manifest_hash",
              computed ? computed === header.manifestHash : null,
              {
                stored_hash: safeHash(header.manifestHash),
                computed_hash: computed,
              },
            );
            const coordinator = await read(
              `cashflow_month_close_requests/__active__-${id}`,
              ["activeRequestId", "activeState", "workflowRevision"],
            );
            check(
              "coordinator_request",
              coordinator?.activeRequestId === requestId,
            );
            check(
              "coordinator_state",
              coordinator?.activeState === "PENDING_APPROVAL",
            );
            check(
              "coordinator_revision_matches_header",
              integer(header.workflowRevision) === null ||
                integer(coordinator?.workflowRevision) === null
                ? null
                : integer(coordinator.workflowRevision) ===
                    integer(header.workflowRevision),
            );
            const settlement = await read(
              `cashflow_settlement_statuses/${id}-${cycle}`,
              ["tenantId", "projectId", "yearMonth", "periods.MONTH.status"],
            );
            check(
              "settlement_scope",
              settlement?.tenantId === "mysc" &&
                settlement?.projectId === id &&
                settlement?.yearMonth === cycle,
            );
            check(
              "settlement_month_submitted",
              ["SUBMITTED", "PENDING_APPROVAL"].includes(
                String(settlement?.periods?.MONTH?.status || "")
                  .trim()
                  .toUpperCase(),
              ),
            );
            const head = await read(`cashflow_cumulative_close_heads/${id}`, [
              "closedThrough",
              "settlementMonth",
              "authorityExists",
            ]);
            const previous = typeof head?.closedThrough === "string" ? (head.closedThrough.trim() ? head.closedThrough : "") : head?.closedThrough;
            const settlementMonth = typeof head?.settlementMonth === "string" ? (head.settlementMonth.trim() ? head.settlementMonth : "") : head?.settlementMonth;
            check(
              "head_horizon_extends",
              !previous
                ? true
                : !MONTH.test(previous) || (settlementMonth && !MONTH.test(settlementMonth))
                  ? null
                  : previous <
                    (!settlementMonth || settlementMonth === previous
                      ? cycle
                      : target),
            );
            check("head_full_canonical_validity", null, {
              missing_data:
                "Full canonical head/closedRanges validation and live deployed rule identity are outside this inspection.",
            });
          }

          // A read-only transaction has no writes. Rollback releases it; no business mutation is attempted.
          await request(`${root}:rollback`, "POST", {
            transaction,
          });
          transaction = null;
          await checkAuthority();
          return envelope("available");
        } catch (e) {
          signal?.throwIfAborted();
          rows.length = 0;
          documents.length = 0;
          const allowed = [
            "source_authorization_revoked",
            "invalid_scope",
            "source_credentials_missing",
            "source_invalid_response",
            "unsupported_canonical_value",
          ];
          return envelope(
            "unavailable",
            allowed.includes(e.safeCode)
              ? e.safeCode
              : Number(e?.response?.status) === 403
                ? "source_access_denied"
                : "source_unavailable",
          );
        } finally {
          if (transaction && client) {
            try {
              await client.request({
                url: `https://firestore.googleapis.com/v1/${root}:rollback`,
                method: "POST",
                data: {
                  transaction,
                },
                timeout: 20000,
                retry: false,
              });
            } catch {
              /* No provider detail or transaction token is exposed. */
            }
          }
        }
      },
    },
  };
}
