import { createHash } from "node:crypto";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const EVIDENCE_ID = /^ev_[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9_]{0,99}$/;
const ANCHOR_FIELDS = Object.freeze({
  project_id: /^p[0-9]{10,20}$/,
  request_id: /^[A-Za-z0-9_-]{1,128}$/,
  trace_id: /^[a-f0-9]{32}$/,
  deployment_id: /^[A-Za-z0-9_-]{1,128}$/,
  revision: /^[a-f0-9]{40}$/,
  runtime_revision: /^[A-Za-z0-9._-]{1,128}$/,
  path: /^\/?[A-Za-z0-9._/-]{1,256}$/,
  service: /^[A-Za-z0-9_-]{1,128}$/,
  region: /^[a-z0-9-]{1,60}$/,
});

function invalid(code) {
  throw Object.assign(new Error(code), { code });
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
function json(value) {
  let serialized;
  try {
    serialized = JSON.stringify(canonical(value));
  } catch {
    invalid("session_context_invalid_json");
  }
  if (typeof serialized !== "string") invalid("session_context_invalid_json");
  return serialized;
}
const digest = (value) =>
  createHash("sha256").update(json(value)).digest("hex");
const bytes = (value) => Buffer.byteLength(json(value));
const clone = (value) => {
  json(value);
  // Source envelopes may hash insertion order; canonicalization is only for our integrity digests.
  return JSON.parse(JSON.stringify(value));
};
function sameObservationContent(first, second) {
  if (!first?.content_hash || !second?.content_hash) return false;
  const withoutTime = ({ observed_at: _observed_at, ...body }) => body;
  return digest(withoutTime(first)) === digest(withoutTime(second));
}

export function normalizeInvestigationBinding(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.tenant_id || "") ||
    !UUID.test(value.case_id || "") ||
    typeof value.run_id !== "string" ||
    !value.run_id.startsWith("qa-") ||
    !UUID.test(value.run_id.slice(3)) ||
    !SHA.test(value.case_input_hash || "") ||
    !Number.isSafeInteger(value.aggregate_version) ||
    value.aggregate_version < 1
  )
    invalid("session_binding_invalid");
  return clone({
    tenant_id: value.tenant_id,
    case_id: value.case_id,
    run_id: value.run_id,
    case_input_hash: value.case_input_hash,
    aggregate_version: value.aggregate_version,
  });
}

function envelope(value, runBinding) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !EVIDENCE_ID.test(value.evidence_id || "") ||
    !NAME.test(value.source || "") ||
    !["available", "unavailable"].includes(value.status) ||
    typeof value.observed_at !== "string" ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    (value.content_hash !== undefined &&
      (!SHA.test(value.content_hash) ||
        value.evidence_id !== `ev_${value.content_hash}`))
  )
    invalid("session_evidence_invalid");
  for (const [field, expected] of Object.entries({
    tenant_id: runBinding.tenant_id,
    workspace_id: runBinding.tenant_id,
    case_id: runBinding.case_id,
    run_id: runBinding.run_id,
    case_input_hash: runBinding.case_input_hash,
    aggregate_version: runBinding.aggregate_version,
  })) {
    if (Object.hasOwn(value, field) && value[field] !== expected)
      invalid("session_evidence_binding_mismatch");
  }
  const item = clone(value);
  if (bytes(item) > 1048576) invalid("session_evidence_too_large");
  return item;
}

export function validateInvestigationEvidence(value, runBinding) {
  return envelope(value, normalizeInvestigationBinding(runBinding));
}

function descriptor(item) {
  const anchor = {};
  for (const [field, pattern] of Object.entries(ANCHOR_FIELDS)) {
    if (typeof item[field] === "string" && pattern.test(item[field]))
      anchor[field] = item[field];
  }
  return {
    evidence_id: item.evidence_id,
    source: item.source,
    status: item.status,
    observed_at: item.observed_at,
    content_sha256: digest(item),
    source_anchor: anchor,
  };
}

/** Verify every stored field against the bound run before loading a resumed session. */
export function verifyStoredEvidence({ documentId, stored, runBinding }) {
  const bound = normalizeInvestigationBinding(runBinding);
  if (
    !stored ||
    documentId !== stored.evidence_id ||
    !EVIDENCE_ID.test(documentId || "") ||
    stored.run_id !== bound.run_id ||
    stored.tenant_id !== bound.tenant_id ||
    stored.case_id !== bound.case_id ||
    stored.case_input_hash !== bound.case_input_hash ||
    stored.aggregate_version !== bound.aggregate_version ||
    !SHA.test(stored.payload_sha256 || "") ||
    typeof stored.payload_json !== "string"
  )
    invalid("session_stored_evidence_binding_invalid");
  let parsed;
  try {
    parsed = JSON.parse(stored.payload_json);
  } catch {
    invalid("session_stored_evidence_invalid");
  }
  const item = envelope(parsed, bound);
  if (
    item.evidence_id !== documentId ||
    item.source !== stored.source ||
    item.status !== stored.status ||
    item.observed_at !== stored.observed_at ||
    digest(item) !== stored.payload_sha256
  )
    invalid("session_stored_evidence_invalid");
  return { evidence: item, content_sha256: stored.payload_sha256 };
}

export function createSessionContext({
  runBinding,
  report,
  priorEvidence = [],
  maxContextBytes = 98304,
}) {
  const bound = normalizeInvestigationBinding(runBinding);
  if (
    !report ||
    typeof report !== "object" ||
    Array.isArray(report) ||
    !Array.isArray(priorEvidence) ||
    !Number.isSafeInteger(maxContextBytes) ||
    maxContextBytes < 4096 ||
    maxContextBytes > 1048576
  )
    invalid("session_context_invalid");
  const sourceReport = clone(report);
  const plan = sourceReport.investigation_plan;
  delete sourceReport.investigation_plan;
  const entries = new Map();
  function insert(item) {
    const hash = digest(item);
    const old = entries.get(item.evidence_id);
    // Some adapters bind the source result before attaching observed_at. A
    // repeated identical read can therefore carry the same ID at a later time.
    // Keep the first immutable envelope; any other same-ID change is corrupt.
    if (old && old.content_sha256 !== hash) {
      if (!sameObservationContent(old.item, item))
        invalid("session_evidence_collision");
    }
    if (!old) entries.set(item.evidence_id, { item, content_sha256: hash });
    return descriptor(old?.item || item);
  }
  for (const row of priorEvidence) {
    const verified = verifyStoredEvidence({ ...row, runBinding: bound });
    insert(verified.evidence);
  }
  const observe = (evidence) => insert(envelope(evidence, bound));
  const snapshot = () => {
    const items = [...entries.values()]
      .map(({ item }) => descriptor(item))
      .sort((a, b) => a.evidence_id.localeCompare(b.evidence_id));
    return { items, hash: digest({ runBinding: bound, items }) };
  };
  function manifestPage({ cursor = null, maxBytes = 32768 } = {}) {
    if (
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 512 ||
      maxBytes > maxContextBytes
    )
      invalid("session_manifest_budget_invalid");
    const manifest = snapshot();
    let start = 0;
    if (cursor !== null) {
      const match = /^m_([a-f0-9]{64}):([0-9]+)$/.exec(cursor);
      if (!match || match[1] !== manifest.hash)
        invalid("session_manifest_cursor_invalid");
      start = Number(match[2]);
      if (
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start >= manifest.items.length
      )
        invalid("session_manifest_cursor_invalid");
    }
    const result = {
      items: [],
      total_count: manifest.items.length,
      manifest_hash: manifest.hash,
      next_cursor: null,
      complete: true,
    };
    for (let i = start; i < manifest.items.length; i++) {
      const candidate = [...result.items, manifest.items[i]];
      const next =
        i + 1 < manifest.items.length ? `m_${manifest.hash}:${i + 1}` : null;
      if (
        bytes({
          ...result,
          items: candidate,
          next_cursor: next,
          complete: next === null,
        }) > maxBytes
      ) {
        if (!result.items.length) invalid("session_manifest_budget_too_small");
        result.next_cursor = `m_${manifest.hash}:${i}`;
        result.complete = false;
        break;
      }
      result.items = candidate;
    }
    return clone(result);
  }
  function readEvidence({
    evidence_id,
    start_offset = 0,
    max_bytes = 32768,
  } = {}) {
    if (
      !EVIDENCE_ID.test(evidence_id || "") ||
      !Number.isSafeInteger(start_offset) ||
      start_offset < 0 ||
      !Number.isSafeInteger(max_bytes) ||
      max_bytes < 512 ||
      max_bytes > Math.min(65536, maxContextBytes)
    )
      invalid("session_evidence_read_invalid");
    const found = entries.get(evidence_id);
    if (!found) invalid("session_evidence_not_found");
    if (digest(found.item) !== found.content_sha256)
      invalid("session_evidence_changed");
    const raw = Buffer.from(json(found.item));
    if (start_offset >= raw.length && start_offset !== 0)
      invalid("session_evidence_read_invalid");
    // A session read is a reference to stored evidence, not a new tool
    // observation. Keep evidence_id below reference so the runner's ordinary
    // tool-output persistence path cannot mistake a chunk for fresh evidence.
    const base = {
      reference: {
        evidence_id,
        content_sha256: found.content_sha256,
        source: found.item.source,
        status: found.item.status,
        observed_at: found.item.observed_at,
      },
      total_bytes: raw.length,
    };
    if (start_offset === 0 && raw.length <= max_bytes)
      return {
        ...base,
        envelope: clone(found.item),
        next_offset: null,
        complete: true,
      };
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let end = Math.min(raw.length, start_offset + max_bytes),
      chunk;
    try {
      decoder.decode(raw.subarray(0, start_offset));
    } catch {
      invalid("session_evidence_read_invalid");
    }
    while (end > start_offset) {
      try {
        chunk = decoder.decode(raw.subarray(start_offset, end));
        break;
      } catch {
        end--;
      }
    }
    if (!chunk) invalid("session_evidence_read_invalid");
    return {
      ...base,
      start_offset,
      chunk,
      next_offset: end < raw.length ? end : null,
      complete: end === raw.length,
    };
  }
  function build({
    stage,
    checkId = null,
    requestedEvidenceIds = [],
    lastResult = null,
    sessionOrdinal,
  } = {}) {
    if (
      !NAME.test(stage || "") ||
      !Number.isSafeInteger(sessionOrdinal) ||
      sessionOrdinal < 0 ||
      !Array.isArray(requestedEvidenceIds) ||
      requestedEvidenceIds.some(
        (id) => !EVIDENCE_ID.test(id || "") || !entries.has(id),
      )
    )
      invalid("session_build_invalid");
    let activeCheck = null;
    if (checkId !== null) {
      if (
        !/^check_[a-z0-9_]{1,40}$/.test(checkId) ||
        !Array.isArray(plan?.checks)
      )
        invalid("session_check_invalid");
      activeCheck = plan.checks.find((check) => check?.check_id === checkId);
      if (
        !activeCheck ||
        plan.checks.filter((check) => check?.check_id === checkId).length !== 1
      )
        invalid("session_check_invalid");
      activeCheck = clone(activeCheck);
    }
    const selected = [...new Set(requestedEvidenceIds)];
    let lastResultError = null;
    if (lastResult !== null) {
      const result = lastResult?.output || lastResult;
      if (EVIDENCE_ID.test(result?.evidence_id || "")) {
        const stored = entries.get(result.evidence_id);
        if (
          !stored ||
          (digest(result) !== stored.content_sha256 &&
            !sameObservationContent(stored.item, result))
        )
          invalid("session_last_result_invalid");
        selected.unshift(result.evidence_id);
      } else if (EVIDENCE_ID.test(result?.reference?.evidence_id || "")) {
        const stored = entries.get(result.reference.evidence_id);
        if (
          !stored ||
          result.reference.content_sha256 !== stored.content_sha256
        )
          invalid("session_last_result_invalid");
        selected.unshift(result.reference.evidence_id);
      } else if (NAME.test(result?.error || "")) lastResultError = result.error;
      else invalid("session_last_result_invalid");
    }
    const requested = [...new Set(selected)];
    const manifest = snapshot();
    const input = {
      untrusted_report: sourceReport,
      active_check: activeCheck,
      evidence_manifest: [],
      recent_observations: [],
      omissions: {
        manifest_total_count: manifest.items.length,
        manifest_included_count: 0,
        manifest_next_cursor: null,
        recent_requested_count: requested.length,
        recent_included_count: 0,
        recent_not_inlined_count: requested.length,
        recent_not_inlined_ids: [],
        ...(lastResultError ? { last_result_error: lastResultError } : {}),
      },
    };
    if (bytes(input) > maxContextBytes - 512)
      invalid("session_report_too_large");
    const manifestBudget = Math.min(
      32768,
      Math.max(512, Math.floor((maxContextBytes - bytes(input)) / 2)),
    );
    const first = manifestPage({ maxBytes: manifestBudget });
    input.evidence_manifest = first.items;
    input.omissions.manifest_included_count = first.items.length;
    input.omissions.manifest_next_cursor = first.next_cursor;
    for (const id of requested) {
      const candidate = [...input.recent_observations, entries.get(id).item];
      if (
        bytes({ ...input, recent_observations: candidate }) <= maxContextBytes
      )
        input.recent_observations = candidate;
    }
    input.omissions.recent_included_count = input.recent_observations.length;
    input.omissions.recent_not_inlined_count =
      requested.length - input.recent_observations.length;
    const included = new Set(
      input.recent_observations.map((item) => item.evidence_id),
    );
    for (const id of requested) {
      if (included.has(id)) continue;
      const candidate = [...input.omissions.recent_not_inlined_ids, id];
      if (
        bytes({
          ...input,
          omissions: { ...input.omissions, recent_not_inlined_ids: candidate },
        }) > maxContextBytes
      )
        break;
      input.omissions.recent_not_inlined_ids = candidate;
    }
    if (bytes(input) > maxContextBytes)
      invalid("session_context_budget_exceeded");
    const inputHash = digest(input);
    return {
      session_id: `session_${digest({
        runBinding: bound,
        sessionOrdinal,
        manifest_hash: manifest.hash,
        stage,
        checkId,
        input_sha256: inputHash,
      })}`,
      input: clone(input),
      manifest: {
        hash: manifest.hash,
        total_count: manifest.items.length,
        included_count: first.items.length,
        next_cursor: first.next_cursor,
        input_sha256: inputHash,
        context_bytes: bytes(input),
        max_context_bytes: maxContextBytes,
      },
    };
  }
  return { observe, build, manifestPage, readEvidence };
}
