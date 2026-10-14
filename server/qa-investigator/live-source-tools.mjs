import { myscRequestPath } from './request-path.mjs';
import { createSourceNavigation } from "./source-navigation.mjs";
import { readFile } from "node:fs/promises";
import { createHash, createSign } from "node:crypto";
const sha = (v) => typeof v === "string" && /^[a-f0-9]{40}$/.test(v);
const digest = (v) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex");
const obj = (properties = {}, required = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const fail = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};
const strict = (args, keys) => {
  if (
    !args ||
    typeof args !== "object" ||
    Array.isArray(args) ||
    Object.keys(args).some((k) => !keys.includes(k))
  )
    fail("invalid_scope");
};
// Policy and secret paths are supplied by the server; never model arguments.
export function createLiveSourceTools({
  policy,
  resolveDeployedRevision,
  github = {},
  vercel = {},
  fetchImpl = fetch,
}) {
  if (
    !policy ||
    !["MYSCube", "EMA_Station"].includes(policy.repository) ||
    !Array.isArray(policy.allowedPaths) ||
    policy.allowedPaths.some(
      (p) =>
        typeof p !== "string" ||
        !/^((server|src|policies)\/)[A-Za-z0-9_./-]+$/.test(p) ||
        p.split("/").some((x) => x === ".." || x === ".") ||
        /secret|credential|\.env/i.test(p),
    )
  )
    throw Error("invalid_live_source_policy");
  const config = structuredClone(policy);
  const platformOnly = config.scopeKind === 'platform';
  const reporterRequests = new Map();
  const attemptedRequestAnchors = new Set();
  const pendingLogPages = new Map();
  if (platformOnly && (typeof config.trustedActorId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(config.trustedActorId))) throw Error('invalid_live_source_policy');
  if (
    config.allowedProjectIds !== undefined &&
    (!Array.isArray(config.allowedProjectIds) ||
      config.allowedProjectIds.some((id) => !/^p[0-9]{10,20}$/.test(id)))
  )
    throw Error("invalid_live_source_policy");
  // These are server-defined routes, not a model-supplied prefix or regexp.
  // Approval URLs contain a request document ID and cannot use the old exact
  // /month-close allowlist alone.
  function requestPathAllowed(path) {
    if (platformOnly) return myscRequestPath(path) === path && [...reporterRequests.values()].some((r) => r.path === path);
    if (config.allowedRequestPaths.includes(path)) return true;
    const match =
      /^\/api\/v1\/cashflow\/(p[0-9]{10,20})\/month-close\/requests\/([A-Za-z0-9_-]{1,128})\/(review|status-review|withdraw|months|revision-diff)$/.exec(
        path || "",
      );
    return Boolean(match && config.allowedProjectIds?.includes(match[1]));
  }
  async function secret(path) {
    if (!path) fail("source_credentials_missing");
    try {
      const v = (await readFile(path, "utf8")).trim();
      if (!v) fail("source_credentials_missing");
      return v;
    } catch {
      fail("source_credentials_missing");
    }
  }
  async function json(
    url,
    token,
    { method = "GET", body, signal, maxBytes = 2000000 } = {},
  ) {
    const parsed = new URL(url);
    if (
      !(
        ["https://api.github.com", "https://api.vercel.com"].includes(
          parsed.origin,
        ) ||
        (parsed.origin === "https://vercel.com" &&
          parsed.pathname === "/api/logs/request-logs")
      )
    )
      fail("invalid_scope");
    const timeout = AbortSignal.timeout(20000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const r = await fetchImpl(url, {
      method,
      redirect: "error",
      credentials: "omit",
      signal: combined,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...(parsed.hostname === "api.github.com"
          ? { "X-GitHub-Api-Version": "2022-11-28" }
          : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!r.ok) {
      await r.body?.cancel();
      fail(
        r.status === 401
          ? "source_auth_unavailable"
          : r.status === 403
            ? "source_access_denied"
            : "source_unavailable",
      );
    }
    const reader = r.body?.getReader();
    if (!reader) fail("source_invalid_response");
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          fail("source_response_too_large");
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("source_invalid_response");
    }
  }
  async function githubToken(signal) {
    if (github.tokenPath) return secret(github.tokenPath);
    if (github.publicRepository === true) {
      const repository = await json(`https://api.github.com/repos/merryAI-dev/${config.repository}`, null, {signal});
      if (repository.private !== false || repository.full_name !== `merryAI-dev/${config.repository}`) fail('source_access_denied');
      return null;
    }
    if (
      !/^\d+$/.test(String(github.appId || "")) ||
      !/^\d+$/.test(String(github.installationId || ""))
    )
      fail("source_credentials_missing");
    const key = await secret(github.privateKeyPath);
    const now = Math.floor(Date.now() / 1000);
    const encoded = (v) => Buffer.from(JSON.stringify(v)).toString("base64url");
    const data = `${encoded({ alg: "RS256", typ: "JWT" })}.${encoded({ iat: now - 60, exp: now + 540, iss: String(github.appId) })}`;
    const signing = createSign("RSA-SHA256");
    signing.update(data);
    signing.end();
    const jwt = `${data}.${signing.sign(key, "base64url")}`;
    const result = await json(
      `https://api.github.com/app/installations/${github.installationId}/access_tokens`,
      jwt,
      {
        method: "POST",
        body: {
          repositories: [config.repository],
          permissions: { contents: "read" },
        },
        signal,
      },
    );
    if (typeof result.token !== "string" || !result.token)
      fail("source_auth_unavailable");
    return result.token;
  }
  function tool(name, description, parameters, execute, provenance = () => ({})) {
    return {
      description,
      parameters,
      async execute(args, { signal } = {}) {
        signal?.throwIfAborted();
        const observed_at = new Date().toISOString();
        const bound = provenance(args);
        try {
          const result = await execute(args, signal);
          signal?.throwIfAborted();
          const content_hash = digest({ source: name, ...bound, ...result });
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: name,
            status: "available",
            ...bound,
            ...result,
            cause_status: "not_established",
          };
        } catch (e) {
          signal?.throwIfAborted();
          const body = {
            observed_at,
            source: name,
            status: "unavailable",
            ...bound,
            error_code: [
              "invalid_scope",
              "source_credentials_missing",
              "source_auth_unavailable",
              "source_access_denied",
              "source_unavailable",
              "source_invalid_response",
              "source_response_too_large",
              "deployment_revision_unverified",
              "source_service_revision_mismatch",
              "source_tree_incomplete",
              "source_path_not_found",
              "history_commit_unobserved",
              "reporter_request_unobserved",
              "source_page_not_pending",
            ].includes(e.safeCode)
              ? e.safeCode
              : "source_unavailable",
            rows: [],
            coverage: { complete: false, snapshot_fallback: false },
            cause_status: "not_established",
          };
          const content_hash = digest(body);
          return { evidence_id: `ev_${content_hash}`, content_hash, ...body };
        }
      },
    };
  }
  const registry = {};
  const incidentDeployments = new Set();
  registry.read_live_deployed_code = tool(
    "read_live_deployed_code",
    "Read bounded source lines from GitHub App at a deployment SHA supplied by the trusted server resolver, never model-selected ref. Deployment metadata is not proof of the incident executing this code. Missing credentials or revision return unavailable without historical snapshot fallback.",
    obj(
      {
        path: { type: "string", enum: config.allowedPaths },
        start_line: { type: "integer", minimum: 1 },
        end_line: { type: "integer", minimum: 1 },
      },
      ["path", "start_line", "end_line"],
    ),
    async (a, signal) => {
      strict(a, ["path", "start_line", "end_line"]);
      if (
        !config.allowedPaths.includes(a.path) ||
        !Number.isSafeInteger(a.start_line) ||
        !Number.isSafeInteger(a.end_line) ||
        a.start_line < 1 ||
        a.end_line < a.start_line ||
        a.end_line - a.start_line >= 160
      )
        fail("invalid_scope");
      const resolved = await resolveDeployedRevision?.({
        repository: config.repository,
        signal,
      });
      if (!sha(resolved?.revision) || resolved.repository !== config.repository)
        fail("deployment_revision_unverified");
      const token = await githubToken(signal);
      const d = await json(
        `https://api.github.com/repos/merryAI-dev/${config.repository}/contents/${a.path.split("/").map(encodeURIComponent).join("/")}?ref=${resolved.revision}`,
        token,
        { signal },
      );
      if (
        d.type !== "file" ||
        d.path !== a.path ||
        d.encoding !== "base64" ||
        !sha(d.sha) ||
        !Number.isSafeInteger(d.size) ||
        d.size > 1000000 ||
        typeof d.content !== "string"
      )
        fail("source_invalid_response");
      const bytes = Buffer.from(d.content, "base64");
      if (
        bytes.length !== d.size ||
        createHash("sha1")
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest("hex") !== d.sha
      )
        fail("source_invalid_response");
      const lines = new TextDecoder("utf-8", { fatal: true })
        .decode(bytes)
        .split("\n");
      if (lines.at(-1) === "") lines.pop();
      if (a.end_line > lines.length) fail("invalid_scope");
      return {
        repository: config.repository,
        revision: resolved.revision,
        path: a.path,
        blob_sha: d.sha,
        file_sha256: createHash("sha256").update(bytes).digest("hex"),
        rows: lines.slice(a.start_line - 1, a.end_line).map((text, i) => ({
          line: a.start_line + i,
          text: text.slice(0, 1000),
          truncated: text.length > 1000,
        })),
        coverage: {
          complete: lines
            .slice(a.start_line - 1, a.end_line)
            .every((line) => line.length <= 1000),
          scope: "requested_source_range",
          historical_request_execution_verified: false,
          revision_source: "trusted_server_resolver",
        },
      };
    },
  );
  registry.read_live_vercel_deployment = tool(
    "read_live_vercel_deployment",
    "Read live Vercel deployment metadata for the fixed production hostname. Excludes environment values and credentials; metadata does not establish effective function environment or incident alias history.",
    obj({ scope: { type: "string", enum: ["current", "incident"] } }),
    async (a, signal) => {
      strict(a, ["scope"]);
      if (a.scope !== undefined && !["current", "incident"].includes(a.scope))
        fail("invalid_scope");
      if (a.scope === "incident" && incidentDeployments.size !== 1)
        fail("deployment_revision_unverified");
      const deployment =
        a.scope === "incident"
          ? [...incidentDeployments][0]
          : "myscube.myscguard.app";
      if (
        !/^team_[A-Za-z0-9]+$/.test(vercel.teamId || "") ||
        vercel.projectId !== "prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0"
      )
        fail("invalid_scope");
      const token = await secret(vercel.tokenPath);
      const d = await json(
        `https://api.vercel.com/v13/deployments/${deployment}?teamId=${encodeURIComponent(vercel.teamId)}`,
        token,
        { signal },
      );
      if (
        d.projectId !== vercel.projectId ||
        !/^dpl_[A-Za-z0-9]+$/.test(d.id || "") ||
        (a.scope === "incident" && d.id !== deployment)
      )
        fail("source_invalid_response");
      return {
        rows: [
          {
            deployment_id: d.id,
            project_id: d.projectId,
            ready_state: [
              "READY",
              "ERROR",
              "BUILDING",
              "QUEUED",
              "CANCELED",
            ].includes(d.readyState)
              ? d.readyState
              : null,
            metadata_commit_sha:
              sha(d.meta?.githubCommitSha) &&
              sha(d.meta?.gitCommitSha) &&
              d.meta.githubCommitSha !== d.meta.gitCommitSha
                ? null
                : sha(d.meta?.githubCommitSha)
                  ? d.meta.githubCommitSha
                  : sha(d.meta?.gitCommitSha)
                    ? d.meta.gitCommitSha
                    : null,
          },
        ],
        coverage: {
          complete: true,
          scope:
            a.scope === "incident"
              ? "request_observed_deployment_metadata"
              : "current_deployment_metadata",
          request_deployment_observed: a.scope === "incident",
          effective_environment_verified: false,
          alias_at_incident_verified: false,
        },
      };
    },
  );
  registry.query_live_vercel_request_logs = tool(
    "query_live_vercel_request_logs",
    "Read live bounded Vercel request metadata in the trusted incident window. Only server-authorized project paths and structured event metadata are returned; exact report request IDs are matched when supplied; raw messages never leave adapter. CLI-observed endpoint, not a guaranteed public REST contract. Page through the returned next_page when present; a page is not the whole incident window. source_page_not_pending means that page is not currently available for this query (unissued or already consumed), not an authentication failure. Inspect stored observations first; never guess page numbers. Start at page 0 when a new query is required.",
    obj({ page: { type: "integer", minimum: 0 }, request_id: { type: "string", description: "Optional observed application request ID. Searches log text for this exact ID; use to narrow a broad search. This is not Vercel's infrastructure request ID." } }),
    async (a, signal) => {
      strict(a, ["page", "request_id"]);
      if (platformOnly && reporterRequests.size === 0) fail('reporter_request_unobserved');
      const requestId = a.request_id;
      if (requestId !== undefined && (!/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(requestId) || !(platformOnly ? reporterRequests.has(requestId) : config.allowedRequestIds?.includes(requestId)))) fail('invalid_scope');
      const page = a.page ?? 0;
      const pageKey = `${requestId || '*'}:${page}`;
      if (!Number.isSafeInteger(page) || page < 0 || page > 100000)
        fail("invalid_scope");
      if (platformOnly && page !== 0 && !pendingLogPages.has(pageKey)) fail('source_page_not_pending');
      if (platformOnly && page !== 0 && [...reporterRequests].some(([id, anchor]) => (!requestId || id === requestId) && !attemptedRequestAnchors.has(`${id}:${anchor.path}`))) fail('invalid_scope');
      if (
        vercel.teamId !== "team_A7cbzLIfAhnrz35sykcSyM5L" ||
        vercel.projectId !== "prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0" ||
        !Array.isArray(config.allowedRequestPaths) ||
        config.allowedRequestPaths.some(
          (p) =>
            !(platformOnly && myscRequestPath(p) === p) && !/^\/api\/v1\/(?:cashflow\/p[0-9]+\/[A-Za-z0-9_/-]+|projects\/p[0-9]+\/cashflow-sheet-lab\/[A-Za-z0-9_/-]+)$/.test(
              p,
            ),
        ) ||
        !Array.isArray(config.allowedRequestIds) ||
        config.allowedRequestIds.some(
          (v) => !/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(v),
        )
      )
        fail("invalid_scope");
      const start = Date.parse(config.startAt),
        end = Date.parse(config.endAt);
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start >= end ||
        end - start > 86400000
      )
        fail("invalid_scope");
      for (const [id, anchor] of reporterRequests) if (!requestId || id === requestId) attemptedRequestAnchors.add(`${id}:${anchor.path}`);
      pendingLogPages.delete(pageKey);
      const token = await secret(vercel.tokenPath);
      const q = new URLSearchParams({
        projectId: vercel.projectId,
        ownerId: vercel.teamId,
        page: String(page),
        startDate: String(start),
        endDate: String(end),
        environment: "production",
      });
      if (requestId) q.set('search', requestId);
      const data = await json(
        `https://vercel.com/api/logs/request-logs?${q}`,
        token,
        { signal },
      );
      if (!Array.isArray(data.rows)) fail("source_invalid_response");
      if (platformOnly && data.hasMoreRows) pendingLogPages.set(`${requestId || '*'}:${page + 1}`, {page: page + 1, ...(requestId ? {request_id: requestId} : {})});
      let excluded = 0;
      const rows = [];
      for (const r of data.rows.slice(0, 100)) {
        const t =
          typeof r.timestamp === "number"
            ? r.timestamp
            : Date.parse(r.timestamp);
        if (
          !Number.isFinite(t) ||
          t < start ||
          t >= end ||
          r.domain !== "myscube.myscguard.app" ||
          !requestPathAllowed(r.requestPath) ||
          !/^dpl_[A-Za-z0-9]+$/.test(r.deploymentId || "") ||
          !Number.isInteger(r.statusCode) ||
          r.statusCode < 100 ||
          r.statusCode > 599
        ) {
          excluded++;
          continue;
        }
        const events = [];
        for (const entry of (Array.isArray(r.logs) ? r.logs : []).slice(
          0,
          100,
        )) {
          if (typeof entry.message !== "string" || entry.message.length > 20000)
            continue;
          let log;
          try {
            log = JSON.parse(entry.message);
          } catch {
            continue;
          }
          if (
            !/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(log.requestId || "") ||
            (requestId && log.requestId !== requestId) ||
            (platformOnly && reporterRequests.get(log.requestId)?.path !== r.requestPath) ||
            (config.allowedRequestIds.length &&
              !config.allowedRequestIds.includes(log.requestId))
          )
            continue;
          events.push({
            request_id: log.requestId,
            error_code: /^(?:[a-z][a-z0-9_]{0,99}|AbortError|TypeError|Error)$/.test(log.errorCode || "") ? log.errorCode : null,
            outcome: ["ok", "error", "started", "retry"].includes(log.outcome) ? log.outcome : null,
            attempt: Number.isSafeInteger(log.attempt) && log.attempt > 0 && log.attempt <= 100 ? log.attempt : null,
            operation: /^[a-z][a-z0-9_.]{0,99}$/.test(log.operation || "") ? log.operation : null,
            phase: /^[a-z][a-z0-9_]{0,79}$/.test(log.phase || "") ? log.phase : null,
            duration_ms: Number.isSafeInteger(log.durationMs) && log.durationMs >= 0 && log.durationMs <= 3600000 ? log.durationMs : null,
            total_ms: Number.isSafeInteger(log.totalMs) && log.totalMs >= 0 && log.totalMs <= 3600000 ? log.totalMs : null,
            project_count: Number.isSafeInteger(log.projectCount) && log.projectCount >= 0 && log.projectCount <= 100 ? log.projectCount : null,
            status:
              Number.isInteger(log.statusCode) &&
              log.statusCode >= 100 &&
              log.statusCode <= 599
                ? log.statusCode
                : null,
            upstream_status:
              Number.isInteger(log.upstreamStatus) &&
              log.upstreamStatus >= 100 &&
              log.upstreamStatus <= 599
                ? log.upstreamStatus
                : null,
          });
        }
        if (platformOnly && events.length === 0) { excluded++; continue; }
        if (events.length) incidentDeployments.add(r.deploymentId);
        rows.push({
          timestamp: new Date(t).toISOString(),
          deployment_id: r.deploymentId,
          path: r.requestPath,
          status: r.statusCode,
          method: ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(
            r.requestMethod,
          )
            ? r.requestMethod
            : null,
          events,
        });
      }
      return {
        rows,
        next_page: data.hasMoreRows ? page + 1 : null,
        coverage: {
          page,
          searched_request_id: requestId || null,
          complete:
            page === 0 &&
            !data.hasMoreRows &&
            data.rows.length <= 100 &&
            excluded === 0,
          limit: 100,
          excluded,
          scope: "selected_live_request_metadata",
          raw_messages_included: false,
          request_correlation_complete: false,
          request_id_correlation: platformOnly ? 'client_claimed_request_id_matched_server_log' : config.allowedRequestIds.length
            ? "only_exact_structured_json_matches"
            : "project_path_and_time_only",
          snapshot_fallback: false,
        },
      };
    },
  );
  const navigation = createSourceNavigation({
      policy: config,
      resolveDeployedRevision,
      githubToken,
      json,
      tool,
    });
  Object.assign(registry, navigation);
  Object.defineProperty(registry, 'observeEvidence', { value(evidence) {
    navigation.observeEvidence(evidence);
    if (!platformOnly || evidence?.source !== 'query_client_errors' || evidence.status !== 'available' || evidence.coverage?.scope !== 'trusted_actor') return;
    const {evidence_id, content_hash, observed_at, source, cause_status, ...body} = evidence;
    if (!/^[a-f0-9]{64}$/.test(content_hash || '') || evidence_id !== `ev_${content_hash}` || digest({tool: source, ...body}) !== content_hash) return;
    for (const row of evidence.rows || []) {
      const at = Date.parse(row.received_at);
      if (row.actor_mask !== `actor_${digest(config.trustedActorId).slice(0, 16)}` || (!row.request_path || myscRequestPath(row.request_path) !== row.request_path) || !Number.isFinite(at) || at < Date.parse(config.startAt) || at >= Date.parse(config.endAt)) continue;
      for (const id of [row.reported_response_request_id, row.reported_request_id]) {
        if (/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(id || '')) reporterRequests.set(id, {path: row.request_path, evidence_id: evidence.evidence_id});
      }
    }
  }});
  Object.defineProperty(registry, 'requestLogAnchors', { value(evidence) {
    if (evidence?.source !== 'query_live_vercel_request_logs' || evidence.status !== 'available'
        || !Array.isArray(evidence.rows) || evidence.evidence_id !== `ev_${evidence.content_hash}`) return [];
    const body = {source:evidence.source, rows:evidence.rows, next_page:evidence.next_page, coverage:evidence.coverage};
    if (digest(body) !== evidence.content_hash) return [];
    const anchors=[];
    for (const row of evidence.rows) {
      const t=Date.parse(row.timestamp);
      if (!Number.isFinite(t) || t<Date.parse(config.startAt) || t>=Date.parse(config.endAt)
          || !requestPathAllowed(row.path) || !/^dpl_[A-Za-z0-9]+$/.test(row.deployment_id || '')
          || !Number.isInteger(row.status) || row.status<100 || row.status>599) continue;
      for (const event of row.events || []) {
        const id=event.request_id, client=reporterRequests.get(id);
        if (!/^req_[0-9]{13}_[a-f0-9]{12,64}$/.test(id || '')
            || (platformOnly ? client?.path !== row.path : config.allowedRequestIds.length && !config.allowedRequestIds.includes(id))) continue;
        anchors.push({evidence_id:evidence.evidence_id, request_id:id, timestamp:row.timestamp,
          path:row.path, deployment_id:row.deployment_id, status:row.status,
          ...(platformOnly ? {client_evidence_id:client.evidence_id} : {})});
      }
    }
    return [...new Map(anchors.map(a=>[digest(a),a])).values()];
  }});
  Object.defineProperty(registry, 'requiredFollowups', { value() {
    if (!platformOnly || !vercel.tokenPath) return [];
    const unqueried = [...reporterRequests].some(([id, anchor]) => !attemptedRequestAnchors.has(`${id}:${anchor.path}`));
    if (!unqueried && pendingLogPages.size === 0) return [];
    return [{tool: 'query_live_vercel_request_logs', reason: unqueried
      ? 'A reporter-associated request ID and service path were observed. Query page 0 to correlate them with the connected server logs before ending this investigation; caller metadata alone cannot settle the failure.'
      : `Server log search is incomplete. Continue with page ${pendingLogPages.values().next().value.page}, arguments ${JSON.stringify(pendingLogPages.values().next().value)}; an empty or partial page does not establish absence of the request.`}];
  }});
  return registry;
}
