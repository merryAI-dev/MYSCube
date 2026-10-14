import { randomUUID } from "node:crypto";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
import { verifyStoredEvidence, validateInvestigationEvidence } from "./session-context.mjs";
const QA = "inner-platform-qa-20260310",
  TENANT = "mysc";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const PROJECT_ID = /^p[0-9]{10,20}$/;
const EXECUTION_NAME = /^qa-investigator-pipeline-[a-z0-9]+(?:-[a-z0-9]+)*$/;
export function decodeValue(v) {
  if (!v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in v) return decodeFields(v.mapValue.fields);
  return null;
}
export const decodeFields = (v) =>
  Object.fromEntries(
    Object.entries(v || {}).map(([k, x]) => [k, decodeValue(x)]),
  );
function encode(v) {
  if (v === null)
    return {
      nullValue: null,
    };
  if (typeof v === "string")
    return {
      stringValue: v,
    };
  if (typeof v === "boolean")
    return {
      booleanValue: v,
    };
  if (Number.isSafeInteger(v))
    return {
      integerValue: String(v),
    };
  if (typeof v === "number")
    return {
      doubleValue: v,
    };
  if (Array.isArray(v))
    return {
      arrayValue: {
        values: v.map(encode),
      },
    };
  return {
    mapValue: {
      fields: fields(v),
    },
  };
}
const fields = (o) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, encode(v)]));
const invalid = (code) => {
  throw Object.assign(new Error(code), {
    code,
  });
};
export async function loadPipelineContext({
  client,
  dispatchId,
  runId,
  tenantId,
  authorizeScope,
}) {
  if (
    tenantId !== TENANT ||
    !UUID.test(dispatchId) ||
    runId !== `qa-${dispatchId}`
  )
    invalid("investigation_pipeline_scope_invalid");
  const root = `projects/${QA}/databases/qa-assistant/documents`,
    base = `${root}/orgs/${TENANT}`;
  const dispatchPath = `${base}/qa_dispatches/${dispatchId}`,
    runPath = `${base}/qa_runs/${runId}`;
  async function request(path, method = "GET", data) {
    try {
      return (
        await client.request({
          url: `https://firestore.googleapis.com/v1/${path}`,
          method,
          ...(data
            ? {
                data,
              }
            : {}),
          timeout: 20000,
          retry: false,
        })
      ).data;
    } catch (e) {
      if (Number(e?.response?.status) === 404) return null;
      invalid("investigation_storage_unavailable");
    }
  }
  const dispatchDoc = await request(dispatchPath),
    dispatch = decodeFields(dispatchDoc?.fields);
  if (
    dispatch.dispatch_id !== dispatchId ||
    dispatch.event_id !== dispatchId ||
    dispatch.workspace_id !== TENANT ||
    dispatch.run_id !== runId ||
    !UUID.test(dispatch.case_id || "")
  )
    invalid("investigation_dispatch_invalid");
  const casePath = `${base}/qa_cases/${dispatch.case_id}`;
  const caseDoc = await request(casePath),
    qa = decodeFields(caseDoc?.fields);
  const scope = qa.investigation_scope;
  if (
    qa.workspace_id !== TENANT ||
    qa.case_id !== dispatch.case_id ||
    qa.platform_key !== "myscube" ||
    !Number.isSafeInteger(qa.aggregate_version) ||
    qa.aggregate_version < 1 ||
    (dispatch.aggregate_version ?? 1) !== qa.aggregate_version ||
    (qa.investigation_event_id
      ? qa.investigation_event_id !== dispatchId
      : qa.aggregate_version !== 1) ||
    typeof qa.description !== "string" ||
    !qa.description.trim() ||
    qa.description.length > 4000 ||
    !scope ||
    scope.authority !== "server_binding" ||
    scope.tenant_id !== TENANT ||
    !Array.isArray(scope.project_ids) ||
    !["project", "platform"].includes(scope.scope_kind || "project") ||
    (scope.scope_kind === "platform"
      ? scope.project_ids.length !== 0
      : !scope.project_ids.length) ||
    scope.project_ids.some((p) => !PROJECT_ID.test(p)) ||
    new Set(scope.project_ids).size !== scope.project_ids.length ||
    !/^[-A-Za-z0-9_]{1,128}$/.test(qa.actor_id || "")
  )
    invalid("investigation_scope_binding_required");
  if (typeof authorizeScope !== "function")
    invalid("investigation_authority_unconfigured");
  // Firestore map field order can change between identical REST reads.
  const scopeDigest = candidateHash(scope);
  const caseInputHash = candidateHash({
    actor_id: qa.actor_id,
    aggregate_version: qa.aggregate_version,
    title: qa.title,
    description: qa.description,
    investigation_scope: qa.investigation_scope,
  });
  const runBinding = {
    tenant_id: TENANT,
    case_id: qa.case_id,
    run_id: runId,
    case_input_hash: caseInputHash,
    aggregate_version: qa.aggregate_version,
  };
  const owner = randomUUID();
  let leaseAcquired = false;
  let leasedExecutionName;
  let businessActorId;
  async function authorize(transaction) {
    const read = (path) =>
      request(
        transaction
          ? `${path}?transaction=${encodeURIComponent(transaction)}`
          : path,
      );
    const [latest, member, leaseDoc, linkDoc] = await Promise.all([
      read(casePath),
      read(`${base}/members/${qa.actor_id}`),
      leaseAcquired ? read(runPath) : Promise.resolve(null),
      read(`${base}/qa_actor_business_links/${qa.actor_id}`),
    ]);
    const current = decodeFields(latest?.fields),
      m = decodeFields(member?.fields),
      link = decodeFields(linkDoc?.fields);
    if (leaseAcquired) {
      const lease = decodeFields(leaseDoc?.fields),
        expires = Date.parse(lease.lease_expires_at);
      if (
        lease.lease_owner !== owner ||
        !Number.isFinite(expires) ||
        expires <= Date.now()
      )
        invalid("investigation_lease_lost");
    }
    if (
      m.status !== "ACTIVE" ||
      link.status !== "ACTIVE" ||
      link.qa_actor_id !== qa.actor_id ||
      link.source !== "dual_firebase_tokens" ||
      (businessActorId && link.business_actor_id !== businessActorId) ||
      current.actor_id !== qa.actor_id ||
      current.description !== qa.description ||
      current.title !== qa.title ||
      current.aggregate_version !== qa.aggregate_version ||
      candidateHash(current.investigation_scope) !== scopeDigest ||
      current.case_status === "cancelled"
    )
      invalid("investigation_authority_revoked");
    // Remote authorization is refreshed before the write transaction. Transactional
    // reads then fence local revocation, case edits and lease changes atomically.
    if (transaction) return leaseDoc;
    const decision = await authorizeScope({
      caseId: qa.case_id,
      runId,
      phase: leaseAcquired ? "run" : "intake",
      actorId: qa.actor_id,
      scope,
    });
    if (!/^[-A-Za-z0-9_]{1,128}$/.test(decision?.businessActorId || ""))
      invalid("investigation_authority_invalid");
    if (
      decision.businessActorId !== link.business_actor_id ||
      (businessActorId && decision.businessActorId !== businessActorId)
    )
      invalid("investigation_authority_revoked");
    businessActorId = decision.businessActorId;
    return leaseDoc;
  }
  await authorize();
  async function authorizeSlackHistory() {
    await authorize();
    const grant = decodeFields(
      (await request(`${base}/qa_slack_history_access/${qa.actor_id}`))?.fields,
    );
    if (
      grant.status !== "ACTIVE" ||
      grant.actor_id !== qa.actor_id ||
      !/^T[A-Z0-9]+$/.test(grant.workspace_id || "") ||
      !Array.isArray(grant.channel_ids) ||
      !grant.channel_ids.length ||
      grant.channel_ids.some((id) => !/^C[A-Z0-9]+$/.test(id))
    )
      return null;
    return {
      workspaceId: grant.workspace_id,
      allowedChannelIds: [...new Set(grant.channel_ids)],
      organizationSummaryAllowed: grant.organization_summary_allowed === true,
    };
  }
  const slackGrant = await authorizeSlackHistory();
  const received = Date.parse(qa.created_at);
  if (!Number.isFinite(received)) invalid("investigation_case_invalid");
  const requestedStart = Date.parse(
      qa.reported_context?.reported_window_start_at,
    ),
    requestedEnd = Date.parse(qa.reported_context?.reported_window_end_at);
  const explicit =
    Number.isFinite(requestedStart) && Number.isFinite(requestedEnd);
  const start = explicit ? requestedStart : received - 86400000,
    end = explicit ? requestedEnd : received;
  if (
    start >= end ||
    end - start > 86400000 ||
    start < received - 30 * 86400000 ||
    end > received + 300000
  )
    invalid("investigation_window_invalid");
  const policy = {
    cloudProject: "inner-platform-live-20260316",
    tenant: TENANT,
    allowedProjectIds: scope.project_ids,
    scopeKind: scope.scope_kind || "project",
    trustedActorId: businessActorId,
    allowedStartAt: new Date(start).toISOString(),
    allowedEndAt: new Date(end).toISOString(),
    services: [
      {
        name: "innerplatform-jvm-weekly-api-live",
        region: "us-central1",
      },
      {
        name: "innerplatform-jvm-weekly-api-live",
        region: "asia-northeast3",
      },
    ],
  };
  const report = {
    text: qa.description,
    server_context: {
      received_at: qa.created_at,
      timezone: "Asia/Seoul",
      reporter_verified: true,
      platform_key: qa.platform_key,
      scope_kind: policy.scopeKind,
      project_ids: scope.project_ids,
      time_window: {
        start_at: policy.allowedStartAt,
        end_at: policy.allowedEndAt,
        source: explicit ? "reporter_supplied" : "default_previous_24_hours",
      },
      reported_request_id: qa.reported_context?.claimed_request_id || null,
      source_availability: {
        client_error_metadata: "reporter_only_client_reported",
        measured_operation_state: "reporter_registration_change_aggregates_at_read_time",
        business_state:
          scope.scope_kind === "platform"
            ? "correlated_server_request_project_and_current_reporter_acl_required"
            : "permitted_projects_only",
        server_execution_logs: "discover_connected_sources_in_tool_catalog",
        slack_history: slackGrant
          ? "server_acl_connected"
          : "actor_grant_missing",
      },
      task: "Start from the reported feature and observable symptom. If a failed request exists, anchor its ID, time, path, status and error, then follow the implicated deployed code and correlated logs to the canonical values it consumed. Otherwise use the observed action, session/time, authorization decision or persisted operation, without inventing a request or rejection. Discover the actual component path; do not require a particular service, database or spreadsheet. Select only authorized connected tools, and report missing source coverage. Distinguish warnings from blockers and pending work from lost data. Use UI diagnostics when no request was emitted. Historical Slack and hotfixes are optional leads. Explain verified facts, the remaining discriminating check and the concrete next action in plain Korean. Current records do not prove past state.",
    },
  };
  let chain = Promise.resolve(),
    leaseMs = 180000;
  const serialized = (fn) => {
    const next = chain.then(fn);
    chain = next.catch(() => {});
    return next;
  };
  const patch = (name, value, precondition) => ({
    update: {
      name,
      fields: fields(value),
    },
    updateMask: {
      fieldPaths: Object.keys(value),
    },
    currentDocument: precondition,
  });
  async function commitRaw(writes, transaction) {
    const r = await request(`${root}:commit`, "POST", {
      writes,
      ...(transaction
        ? {
            transaction,
          }
        : {}),
    });
    if (!r) invalid("investigation_storage_unavailable");
    return r;
  }
  async function evidence() {
    let pageToken,
      items = [],
      records = [];
    do {
      const q = new URLSearchParams({
        pageSize: "100",
      });
      if (pageToken) q.set("pageToken", pageToken);
      const page = await request(`${runPath}/evidence?${q}`);
      for (const doc of page?.documents || []) {
        const record = {
          documentId: doc.name?.split("/").at(-1),
          stored: decodeFields(doc.fields),
        };
        const verified = verifyStoredEvidence({ ...record, runBinding });
        records.push(record);
        items.push(verified.evidence);
      }
      pageToken = page?.nextPageToken;
    } while (pageToken);
    return { items, records };
  }
  async function reviewReceipts() {
    await authorize();
    const receipts = [];
    let pageToken;
    do {
      const query = new URLSearchParams({pageSize: '100'});
      if (pageToken) query.set('pageToken', pageToken);
      const page = await request(`${runPath}/checkpoints?${query}`);
      if (!page) invalid('investigation_storage_unavailable');
      for (const doc of page.documents || []) {
        if (!doc.name?.startsWith(`${runPath}/checkpoints/`)
          || doc.name.slice(`${runPath}/checkpoints/`.length).includes('/'))
          invalid('investigation_review_receipt_invalid');
        const stored = decodeFields(doc.fields);
        if (stored.phase !== 'review_session_validated') continue;
        let event;
        try { event = JSON.parse(stored.payload_json); }
        catch { invalid('investigation_review_receipt_invalid'); }
        if (event.phase !== stored.phase || !event.receipt
          || event.receipt_sha256 !== candidateHash(event.receipt)
          || event.receipt.result_sha256 !== candidateHash(event.receipt.result)
          || candidateHash(event.receipt.snapshot?.run_binding) !== candidateHash(runBinding))
          invalid('investigation_review_receipt_invalid');
        receipts.push({...event, checkpoint_path:doc.name});
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    await authorize();
    return receipts;
  }
  async function begin(initial) {
    // The runner supplies this from Cloud Run's server-owned execution context.
    // Do not take the current execution from prior records or model checkpoints.
    const currentExecutionName = initial?.execution_name;
    if (
      typeof currentExecutionName !== "string" ||
      currentExecutionName.length > 63 ||
      !EXECUTION_NAME.test(currentExecutionName)
    )
      invalid("investigation_execution_identity_invalid");
    const previousDoc = await request(runPath),
      previous = decodeFields(previousDoc?.fields);
    const at = Date.now();
    if (
      previousDoc &&
      (previous.run_id !== runId ||
        previous.case_id !== qa.case_id ||
        previous.dispatch_id !== dispatchId ||
        previous.tenant_id !== TENANT ||
        previous.input_hash !== initial.input_hash ||
        previous.title !== initial.title ||
        previous.model !== initial.model ||
        previous.provider !== initial.provider ||
        previous.case_input_hash !== caseInputHash ||
        previous.case_aggregate_version !== qa.aggregate_version ||
        previous.case_actor_id !== qa.actor_id)
    )
      invalid("investigation_resume_identity_mismatch");
    if (
      previousDoc &&
      (["completed", "failed", "needs_review"].includes(previous.status) ||
        Date.parse(previous.lease_expires_at) > at)
    )
      return {
        skip: true,
      };
    const lease = {
      lease_owner: owner,
      lease_expires_at: new Date(at + leaseMs).toISOString(),
      resumed_at: previousDoc ? new Date(at).toISOString() : null,
      current_execution_name: currentExecutionName,
    };
    const value = previousDoc
      ? {
          status: "running",
          execution_yield_reason:null,
          execution_yield_execution:null,
          execution_yield_checkpoint_sha256:null,
          execution_yield_pending_sha256:null,
          error_code:null,
          current_stage:'preparing',
          ...lease,
        }
      : {
          ...initial,
          case_id: qa.case_id,
          dispatch_id: dispatchId,
          case_actor_id: qa.actor_id,
          case_aggregate_version: qa.aggregate_version,
          case_input_hash: caseInputHash,
          visibility:
            qa.visibility === "organization" &&
            scope.organization_summary_allowed === true
              ? "organization"
              : "private",
          ...lease,
        };
    // Reject corrupt or cross-case evidence before claiming a resume lease.
    const resumedEvidence = previousDoc
      ? await evidence()
      : { items: [], records: [] };
    await commitRaw([
      previousDoc
        ? patch(runPath, value, {
            updateTime: previousDoc.updateTime,
          })
        : {
            update: {
              name: runPath,
              fields: fields(value),
            },
            currentDocument: {
              exists: false,
            },
          },
    ]);
    leaseAcquired = true;
    leasedExecutionName = currentExecutionName;
    return {
      skip: false,
      previous: previousDoc ? previous : null,
      priorEvidence: resumedEvidence.items,
      priorEvidenceRecords: resumedEvidence.records,
    };
  }
  async function fencedCommit(writes) {
    return serialized(async () => {
      await authorize();
      const started = await request(`${root}:beginTransaction`, "POST", {
        options: {
          readWrite: {},
        },
      });
      const transaction = started?.transaction;
      if (typeof transaction !== "string" || !transaction)
        invalid("investigation_storage_unavailable");
      try {
        const doc = await authorize(transaction),
          r = decodeFields(doc?.fields),
          at = Date.now();
        if (
          !doc ||
          r.lease_owner !== owner ||
          !Number.isFinite(Date.parse(r.lease_expires_at)) ||
          Date.parse(r.lease_expires_at) <= at
        )
          invalid("investigation_lease_lost");
        if (
          writes.some(
            (w) =>
              !w.update ||
              !(
                [runPath].includes(w.update.name) ||
                new RegExp(`^${runPath}/(?:evidence|checkpoints)/[^/]+$`).test(
                  w.update.name,
                )
              ),
          )
        )
          invalid("investigation_invalid_write");
        const own = writes.filter((w) => w.update?.name === runPath);
        if (own.length > 1) invalid("investigation_invalid_write");
        const changes = own.length ? decodeFields(own[0].update.fields) : {};
        if (
          Object.hasOwn(changes, "execution_name") ||
          Object.hasOwn(changes, "current_execution_name")
        )
          invalid("investigation_invalid_write");
        if (Object.hasOwn(changes,'execution_yield_reason') && (
          r.status !== 'running' || changes.status !== 'running'
          || changes.execution_yield_reason !== 'execution_deadline'
          || r.current_execution_name !== leasedExecutionName
          || changes.execution_yield_execution !== leasedExecutionName
          || changes.execution_yield_checkpoint_sha256 !== r.session_state?.state_sha256
          || (changes.execution_yield_pending_sha256 && changes.execution_yield_pending_sha256 !== r.pending_answer?.snapshot_sha256)
        )) invalid('investigation_yield_state_invalid');
        const terminal = ["completed", "failed", "needs_review"].includes(
          changes.status,
        );
        const output = [];
        for (const write of writes.filter(w => w.update?.name !== runPath)) {
          if (write.update.name.startsWith(`${runPath}/checkpoints/mcp_`)) {
            const existing = await request(`${write.update.name}?transaction=${encodeURIComponent(transaction)}`);
            if (existing) {
              if (candidateHash(decodeFields(existing.fields)) !== candidateHash(decodeFields(write.update.fields))) {
                invalid('investigation_mcp_receipt_collision');
              }
              continue;
            }
            output.push({ ...write, currentDocument: { exists: false } });
          } else output.push(write);
        }
        output.push(
          patch(
            runPath,
            {
              ...changes,
              lease_owner: terminal ? null : owner,
              lease_expires_at: terminal
                ? null
                : new Date(at + leaseMs).toISOString(),
            },
            {
              updateTime: doc.updateTime,
            },
          ),
        );
        return await commitRaw(output, transaction);
      } catch (error) {
        // Rollback is best effort; never expose the transaction token or reuse stale authority.
        try {
          await request(`${root}:rollback`, "POST", {
            transaction,
          });
        } catch {}
        throw error;
      }
    });
  }
  async function recordMcpReceipt({ runBinding: supplied, source, evidenceId, payloadSha256, transportEvidence, signal }) {
    signal?.throwIfAborted();
    const transport = transportEvidence, result = transport?.result, original = result?.structuredContent;
    if (!supplied || !transport || !original) invalid('investigation_mcp_receipt_invalid');
    validateInvestigationEvidence(original, runBinding);
    validateInvestigationEvidence(transport, runBinding);
    const { content_hash: transportHash, evidence_id: transportId, ...transportBody } = transport;
    if (candidateHash(transportBody) !== transportHash || transportId !== `ev_${transportHash}`
      || transport.status !== 'available' || transport.remote_tool !== source
      || !/^[a-z][a-z0-9_-]{0,31}$/.test(transport.server_id || '')
      || ['schema_sha256', 'scope_sha256', 'arguments_sha256'].some(key => !/^[a-f0-9]{64}$/.test(transport[key] || ''))
      || result._meta?.['mysc/payload_sha256'] !== payloadSha256
      || result._meta?.['mysc/input_schema_sha256'] !== transport.schema_sha256) invalid('investigation_mcp_receipt_invalid');
    if (candidateHash(supplied) !== candidateHash(runBinding)
      || original?.source !== source || original?.evidence_id !== evidenceId
      || !/^ev_[a-f0-9]{64}$/.test(evidenceId || '')
      || candidateHash(original) !== payloadSha256
      || candidateHash(transport?.run_binding) !== candidateHash(runBinding)
      || !/^[a-f0-9]{64}$/.test(result?._meta?.['mysc/authority_binding'] || '')) {
      invalid('investigation_mcp_receipt_invalid');
    }
    const body = { kind: 'mcp_source_receipt', run_binding: runBinding, source,
      evidence_id: evidenceId, payload_sha256: payloadSha256,
      transport_sha256: candidateHash(transport), server_id: transport.server_id,
      schema_sha256: transport.schema_sha256, scope_sha256: transport.scope_sha256,
      arguments_sha256: transport.arguments_sha256,
      authority_binding: result._meta['mysc/authority_binding'] };
    const receiptHash = candidateHash(body);
    const path = `${runPath}/checkpoints/mcp_${receiptHash}`;
    const receipt = { ...body, receipt_sha256: receiptHash };
    await fencedCommit([{ update: { name: path, fields: fields(receipt) } }]);
    signal?.throwIfAborted();
    await authorize();
    const saved = await request(path);
    await authorize();
    signal?.throwIfAborted();
    if (candidateHash(decodeFields(saved?.fields)) !== candidateHash(receipt)) {
      invalid('investigation_mcp_receipt_not_persisted');
    }
    return { receipt_id: `mcp_${receiptHash}`, receipt_sha256: receiptHash };
  }
  return {
    title: qa.title,
    request: {
      report,
      policy,
    },
    reportId: "case",
    begin,
    commit: fencedCommit,
    recordMcpReceipt,
    authorize,
    async authorizeProject(projectId) {
      await authorize();
      const decision = await authorizeScope({caseId:qa.case_id,runId,phase:'run',actorId:qa.actor_id,
        scope,projectId,aggregateVersion:qa.aggregate_version});
      if(decision.businessActorId !== businessActorId || decision.projectId !== projectId)
        invalid('investigation_authority_invalid');
      await authorize();
      return decision;
    },
    authorizeSlackHistory,
    reviewReceipts,
    reviewAuthorityBinding: () => ({actor_id:qa.actor_id, business_actor_id:businessActorId,
      scope_sha256:scopeDigest}),
    slackHistory: slackGrant
      ? {
          ...slackGrant,
          runVisibility:
            qa.visibility === "organization" &&
            scope.organization_summary_allowed === true
              ? "organization"
              : "private",
          startAt: new Date(received - 365 * 86400000).toISOString(),
          endAt: new Date(received).toISOString(),
        }
      : null,
    heartbeat: () => fencedCommit([]),
    runPath,
    root,
    caseId: qa.case_id,
    runBinding,
    read: request,
  };
}
