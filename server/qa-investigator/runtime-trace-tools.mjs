import { createHash, randomUUID } from "node:crypto";
const hash = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const fail = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};
const atom = (v) => typeof v === "string" && /^[a-z][a-z0-9_.-]{0,79}$/.test(v);
const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const FRAME =
  /^\s*at (dev\.merryai\.innerplatform\.weekly(?:\.[A-Za-z_$][\w$]*)+)\.([A-Za-z_$][\w$]*|<init>|<clinit>)\(([A-Za-z_$][\w$]*\.java):(\d{1,7})\)\s*$/;
/** observeEvidence accepts only server-returned tool results, never model arguments. */
export function createRuntimeTraceTools({ auth, policy }) {
  const p = structuredClone(policy),
    start = Date.parse(p?.allowedStartAt),
    end = Date.parse(p?.allowedEndAt);
  if (
    p?.cloudProject !== "inner-platform-live-20260316" ||
    p.tenant !== "mysc" ||
    !Array.isArray(p.allowedProjectIds) ||
    !p.allowedProjectIds.length ||
    p.allowedProjectIds.some((x) => !/^p\d{10,20}$/.test(x)) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start >= end ||
    end - start > 86400000 ||
    !Array.isArray(p.services) ||
    !p.services.length ||
    p.services.some((s) => !atom(s.name) || !atom(s.region))
  )
    throw Error("invalid_runtime_trace_policy");
  const tracePattern = new RegExp(
      `^projects/${p.cloudProject}/traces/[a-f0-9]{32}$`,
    ),
    observed = new Map(),
    pages = new Map();
  const allow = {
    phase: new Set(
      p.safePhases || [
        "started",
        "completed",
        "failed",
        "validation",
        "read",
        "write",
      ],
    ),
    operation: new Set(
      p.safeOperations || [
        "month_close",
        "settlement_submit",
        "settlement_transition",
        "cashflow_refresh",
      ],
    ),
    error_code: new Set(
      p.safeErrorCodes || [
        "jvm_weekly_api_unconfigured",
        "cashflow_sheet_template_unsupported",
        "cashflow_line_invalid",
        "weekly_expense_conflict",
        "cashflow_week_document_invalid",
        "cashflow_month_close_route_timeout",
        "jvm_weekly_api_unreachable",
        "permission_denied",
        "not_found",
      ],
    ),
  };
  if (Object.values(allow).some((s) => [...s].some((v) => !atom(v))))
    throw Error("invalid_runtime_trace_policy");
  function observeEvidence(e) {
    if (
      e?.source !== "query_runtime_logs" ||
      e.status !== "available" ||
      !p.allowedProjectIds.includes(e.project_id) ||
      !Array.isArray(e.rows)
    )
      return;
    const a = Date.parse(e.start_at),
      b = Date.parse(e.end_at);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < start ||
      b > end ||
      a >= b
    )
      return;
    for (const r of e.rows) {
      const t = Date.parse(r.timestamp);
      if (
        !tracePattern.test(r.trace || "") ||
        !Number.isFinite(t) ||
        t < a ||
        t >= b ||
        typeof r.path !== "string" ||
        !r.path.startsWith(`/api/v1/cashflow/${e.project_id}/`) ||
        !atom(r.revision)
      )
        continue;
      const services = p.services.filter(
        (s) => s.region === r.region && r.revision.startsWith(s.name + "-"),
      );
      if (services.length !== 1) continue;
      const key = e.project_id + ":" + r.trace;
      const scopes = observed.get(key) || [];
      const scope = {
        project_id: e.project_id,
        trace: r.trace,
        start_at: e.start_at,
        end_at: e.end_at,
        service: services[0].name,
        region: r.region,
        revision: r.revision,
        http_timestamp: r.timestamp,
      };
      if (!scopes.some((x) => hash(x) === hash(scope))) scopes.push(scope);
      observed.set(key, scopes);
    }
  }
  function envelope(result) {
    const content_hash = hash({
      source: "query_correlated_runtime_trace",
      ...result,
    });
    return {
      evidence_id: "ev_" + content_hash,
      content_hash,
      observed_at: new Date().toISOString(),
      source: "query_correlated_runtime_trace",
      ...result,
      cause_status: "not_established",
    };
  }
  function frames(entry) {
    const fields = [
      entry.textPayload,
      entry.jsonPayload?.message,
      entry.jsonPayload?.stack_trace,
      entry.jsonPayload?.stackTrace,
      entry.jsonPayload?.exception?.stacktrace,
    ];
    const out = [];
    let truncated = false;
    for (const v of fields) {
      if (typeof v !== "string") continue;
      if (v.length > 64000) {
        truncated = true;
        continue;
      }
      for (const line of v.split("\n")) {
        const m = FRAME.exec(line);
        if (!m) continue;
        if (m[1].length > 240 || m[2].length > 120 || m[3].length > 120) {
          truncated = true;
          continue;
        }
        if (out.length >= 40) {
          truncated = true;
          break;
        }
        const n = Number(m[4]);
        if (n < 1) continue;
        const outer = m[1].split("$")[0];
        out.push({
          class_name: m[1],
          method: m[2],
          file: m[3],
          line: n,
          source_path_candidate:
            "server/jvm-weekly-api/src/main/java/" +
            outer.split(".").slice(0, -1).join("/") +
            "/" +
            m[3],
          source_path_verified: false,
        });
      }
    }
    return { frames: out, truncated };
  }
  const tools = {
    query_correlated_runtime_trace: {
      description:
        "Read bounded application logs only for an exact trace previously observed by query_runtime_logs. No trace discovery or request-ID text matching. Correlation is not causal proof; empty logs are not proof of absence. Returns safe structured codes and JVM source-frame candidates, never raw log messages. Continuations are opaque server-issued tokens.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["project_id", "trace_id"],
        properties: {
          project_id: { type: "string", enum: p.allowedProjectIds },
          trace_id: { type: "string", pattern: "^[a-f0-9]{32}$" },
          continuation: { type: "string", pattern: "^[a-f0-9-]{36}$" },
        },
      },
      async execute(a, { signal } = {}) {
        try {
          signal?.throwIfAborted();
          if (
            !a ||
            Array.isArray(a) ||
            Object.keys(a).some(
              (k) => !["project_id", "trace_id", "continuation"].includes(k),
            ) ||
            !p.allowedProjectIds.includes(a.project_id) ||
            !/^[a-f0-9]{32}$/.test(a.trace_id || "")
          )
            fail("invalid_scope");
          const trace = `projects/${p.cloudProject}/traces/${a.trace_id}`,
            key = a.project_id + ":" + trace,
            scopes = observed.get(key);
          if (!scopes?.length) fail("trace_not_observed_in_http_metadata");
          // Ambiguous windows/revisions are not silently merged; investigator can obtain narrower HTTP evidence.
          const unique = new Map(
            scopes.map((s) => [hash({ ...s, http_timestamp: null }), s]),
          );
          if (unique.size !== 1) fail("trace_scope_ambiguous");
          const scope = [...unique.values()][0];
          let pageToken;
          if (a.continuation !== undefined) {
            const c = pages.get(a.continuation);
            if (
              !c ||
              c.key !== key ||
              c.scope_hash !== hash({ ...scope, http_timestamp: null })
            )
              fail("invalid_continuation");
            pageToken = c.pageToken;
          }
          if (!auth?.getClient) fail("source_credentials_missing");
          const client = await auth.getClient();
          const filter = [
            `resource.type="cloud_run_revision"`,
            `resource.labels.project_id="${p.cloudProject}"`,
            `resource.labels.service_name="${scope.service}"`,
            `resource.labels.location="${scope.region}"`,
            `resource.labels.revision_name="${scope.revision}"`,
            `trace="${trace}"`,
            `timestamp >= "${new Date(Date.parse(scope.start_at)).toISOString()}"`,
            `timestamp < "${new Date(Date.parse(scope.end_at)).toISOString()}"`,
          ].join("\n");
          const r = await client.request({
            url: "https://logging.googleapis.com/v2/entries:list",
            method: "POST",
            data: {
              resourceNames: [`projects/${p.cloudProject}`],
              filter,
              orderBy: "timestamp asc",
              pageSize: 100,
              ...(pageToken ? { pageToken } : {}),
            },
            signal,
            timeout: 20000,
            retry: false,
            maxRedirects: 0,
          });
          signal?.throwIfAborted();
          const d = r.data;
          if (
            !d ||
            !Array.isArray(d.entries ?? []) ||
            Buffer.byteLength(JSON.stringify(d)) > 2000000 ||
            (d.entries || []).length > 100
          )
            fail("source_invalid_response");
          let excluded = 0,
            unstructured = 0,
            truncated = false;
          const rows = [];
          for (const e of d.entries || []) {
            const l = e.resource?.labels,
              t = Date.parse(e.timestamp);
            if (
              e.resource?.type !== "cloud_run_revision" ||
              l?.project_id !== p.cloudProject ||
              l.service_name !== scope.service ||
              l.location !== scope.region ||
              l.revision_name !== scope.revision ||
              e.trace !== trace ||
              !Number.isFinite(t) ||
              t < Date.parse(scope.start_at) ||
              t >= Date.parse(scope.end_at)
            ) {
              excluded++;
              continue;
            }
            const parsed = frames(e),
              j = e.jsonPayload || {},
              codes = {};
            truncated ||= parsed.truncated;
            for (const k of Object.keys(allow)) {
              const v = j[k] ?? (k === "error_code" ? j.errorCode : undefined);
              codes[k] = allow[k].has(v) ? v : null;
            }
            if (!parsed.frames.length && !Object.values(codes).some(Boolean))
              unstructured++;
            rows.push({
              timestamp: new Date(t).toISOString(),
              revision: scope.revision,
              region: scope.region,
              ...codes,
              frames: parsed.frames,
            });
          }
          let continuation = null;
          if (d.nextPageToken !== undefined && d.nextPageToken !== "") {
            if (
              typeof d.nextPageToken !== "string" ||
              d.nextPageToken.length > 8192
            )
              fail("source_invalid_response");
            continuation = randomUUID();
            pages.set(continuation, {
              key,
              scope_hash: hash({ ...scope, http_timestamp: null }),
              pageToken: d.nextPageToken,
            });
          }
          const pinned = p.jvmSourceRevisions?.[scope.revision];
          return envelope({
            status: "available",
            project_id: a.project_id,
            trace_id: a.trace_id,
            service: scope.service,
            region: scope.region,
            revision: scope.revision,
            source_revision: sha(pinned) ? pinned : null,
            source_revision_verified: false,
            start_at: scope.start_at,
            end_at: scope.end_at,
            rows,
            continuation,
            coverage: {
              complete: false,
              scope: "observed_http_trace_application_log_page",
              page_exhausted: !continuation,
              excluded_scope_rows: excluded,
              unstructured_rows: unstructured,
              frame_truncated: truncated,
              raw_messages_included: false,
              causal_association_verified: false,
              empty_is_absence_proof: false,
              instrumentation_completeness_verified: false,
            },
          });
        } catch (e) {
          signal?.throwIfAborted();
          const safe = [
            "invalid_scope",
            "trace_not_observed_in_http_metadata",
            "trace_scope_ambiguous",
            "invalid_continuation",
            "source_credentials_missing",
            "source_invalid_response",
          ];
          return envelope({
            status: "unavailable",
            error_code: safe.includes(e.safeCode)
              ? e.safeCode
              : Number(e?.response?.status) === 403
                ? "source_access_denied"
                : "source_unavailable",
            rows: [],
            coverage: {
              complete: false,
              scope: "observed_http_trace_application_logs",
              instrumentation_required_when_trace_missing: true,
            },
          });
        }
      },
    },
  };
  Object.defineProperty(tools.query_correlated_runtime_trace, 'blockedBy', {
    value: ({ evidence }) => {
      const candidates = [...evidence.values()].filter((item) =>
        item?.source === 'query_runtime_logs'
        && /^ev_[a-f0-9]{64}$/.test(item.evidence_id || '')
        && p.allowedProjectIds.includes(item.project_id)
        && (item.status === 'available' && Array.isArray(item.rows)
          || item.status === 'unavailable' && [
            'source_access_denied', 'source_auth_unavailable', 'source_unavailable',
          ].includes(item.error_code) && (() => {
            const { evidence_id, content_hash, ...body } = item;
            return /^[a-f0-9]{64}$/.test(content_hash || '')
              && evidence_id === `ev_${content_hash}` && hash(body) === content_hash;
          })())
        && Number.isFinite(Date.parse(item.start_at))
        && Number.isFinite(Date.parse(item.end_at))
        && Date.parse(item.start_at) >= start && Date.parse(item.end_at) <= end
        && Date.parse(item.start_at) < Date.parse(item.end_at));
      if (!candidates.length) return null;
      // observeEvidence has already verified path, service revision, trace and
      // timestamp. A trace in any cited project means the dependent tool is callable.
      if (candidates.some((item) => [...observed.values()].flat().some((scope) =>
        scope.project_id === item.project_id))) return null;
      return { evidence_ids: candidates.map((item) => item.evidence_id),
        reason_code: 'trace_not_observed_in_bounded_http_metadata' };
    },
  });
  return { tools, observeEvidence };
}
