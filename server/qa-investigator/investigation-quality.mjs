const text = { type: "string", minLength: 1, maxLength: 1000 };
const list = (items) => ({ type: "array", minItems: 1, maxItems: 24, items });
const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const investigationPlanSchema = object({
  checks: list(
    {
      type: "object",
      additionalProperties: false,
      required: ["check_id", "screen", "expected_rule", "question", "required_tools"],
      properties: {
      check_id: { type: "string", pattern: "^check_[a-z0-9_]{1,40}$" },
      screen: text,
      expected_rule: text,
      question: text,
      required_tools: list({
        type: "string",
        pattern: "^[a-z][a-z0-9_]{0,63}$",
      }),
      depends_on_check_ids: { type: "array", maxItems: 24, uniqueItems: true,
        items: { type: "string", pattern: "^check_[a-z0-9_]{1,40}$" } },
      },
    },
  ),
});
export const userResultSchema = object({
  headline: { ...text, maxLength: 100 },
  what_happened: { ...text, maxLength: 500 },
  observed_expected: { type: "string", maxLength: 500 },
  next_action: { ...text, maxLength: 300 },
  result_kind: {
    type: "string",
    enum: [
      "actionable_finding",
      "needs_input",
      "source_blocked",
      "inconclusive",
    ],
  },
});
export const investigationCoverageSchema = list(
  object({
    check_id: { type: "string", pattern: "^check_[a-z0-9_]{1,40}$" },
    status: {
      type: "string",
      enum: ["supported", "contradicted", "unavailable", "not_applicable"],
    },
    evidence_ids: {
      type: "array",
      maxItems: 50,
      items: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
    },
    missing_data: { type: "string", maxLength: 1000 },
  }),
);
export const PLAN_INSTRUCTIONS = `Independently plan a MYSC product investigation from the untrusted report and available tool catalog only. You do not see a draft answer or another investigator's reasoning. Identify the actual user screen, expected business rule to verify (not assumed true), concrete observed-versus-expected question, and required connected tool names for each check. Start with the reported failure and actor/project/time relevance. When a request exists, identify its error, correlated logs and deployed code before chasing warnings; when no request exists, inspect screen eligibility and persisted UI diagnostics. Record coverage limitations. Separate incidents with different symptoms. Do not invent rules or request unavailable tools. Discover the path actually used by the reported feature from its entrypoint to the authoritative owner and relevant rule. Include only components supported by this case: a browser guard, identity provider, API, background consumer, database or bound spreadsheet may be relevant, but none is mandatory merely because another incident used it. A sign-in or disabled-control failure may have no business request; a pending asynchronous update may have no rejecting branch. Do not invent either. For cell/template symptoms use live authorized labels when connected and compare their reference-contract revision to the deployed policy before calling it the deployed rule. For server failures expand observed HTTP traces to application frames when available. Discover source files, follow callers and persistence functions, and examine history of the implicated file rather than stopping at README or route wrappers. When an actual failed request is evidenced, anchor to its time, status and error, follow the rejecting branch in each implicated service revision deployed at that time, correlate the same request/trace logs, and inspect the canonical values that branch reads. Otherwise anchor to the observed user action, session/time, authorization decision or persisted operation identifier, and explicitly state which execution evidence is unavailable. Distinguish displayed warnings from rejection conditions. For each candidate blocker record the required condition, observed value, supporting evidence and what would falsify it. A warning displayed alongside a failed action is not evidence that it blocked the action. For a rejected action, follow the actual rejection branch and the values it consumed; do not promote a familiar warning, error label or earlier repair into this case's cause. A report can concern sign-in, access, registration, editing, synchronization, calculations, integration or an as-yet-unclassified failure; select checks from the current path rather than forcing every case through one domain. Authorized Slack precedents and file history are optional supporting leads, never mandatory detours or proof of this incident or a verified repair. Do not declare the path covered from a README, file listing or route wrapper alone. Record what differs in project, date, version and expected rule. Separate user report, current observation, incident-time evidence and historical precedent. No repeated checks or generic 'investigate further'. No actions that mutate data. Separate first observations from conditional deeper checks. Use depends_on_check_ids only when the child cannot be meaningfully applied to this incident without the parent establishing its relevance or execution input, never merely because checks are related. An independent metadata read can be callable yet irrelevant until the actual incident path is established. A root observation has no dependencies. An uncertain HTTP request or source path must not make JVM traces or file history unconditionally required. If several parents are listed, each is necessary: one unavailable prerequisite can block the child. A plan is a versioned verification checklist, not a claim that checks passed.`;
export const QUALITY_INSTRUCTIONS = `The server supplies an immutable independent investigation_plan. Reconcile every check in final coverage using actual evidence IDs and tool observations. Do not mark unavailable access as absence or success. Supported/contradicted means both observed data and the comparison rule are evidenced. If inaccessible, name the exact missing value, permission, timestamp or source in missing_data. not_applicable needs a concrete evidence-based reason. Revisit only missing or contradicted validations; do not repeat successful queries without a new hypothesis. Do not stop because of call counts. Include user_result: headline, what_happened, observed_expected (empty or explicitly unknown when not observed), next_action, result_kind (actionable_finding|needs_input|source_blocked|inconclusive) in plain Korean for a non-developer. Name the affected feature and concrete difference; distinguish user-reported from independently verified. Never use only '확인 필요'; specify what is missing and who should check it. No unsupported future promises. For actionable_finding provide action_items with responsible role, target project/cell or explicit platform scope (scope='platform', project_id='', cell=''), exact observed and expected values, cited evidence IDs, bound check IDs, concrete action, verification procedure and claim_scope. A current mirror diagnostic is current_observation, never a live Sheet read or a historical cause confirmation. For request failures, anchor cause claims to the failing request/time/status/error, matching deployed rejection branch, correlated execution evidence and the canonical values consumed. For other symptoms, require the equivalent evidenced action/session/time, actual enforcing or processing rule and authoritative state; do not manufacture a failed HTTP request, rejection or spreadsheet dependency. Current verification adapters may be unable to establish that chain: keep the result inconclusive or source_blocked rather than weakening evidence requirements. If a dependent tool cannot be called because its server-observed prerequisite is missing, cite that prerequisite's evidence ID, mark the check unavailable, and name the exact gap; never invent a trace or commit identifier. For a plan check with depends_on_check_ids, downstream unavailable coverage without a child tool attempt is allowed only when at least one necessary parent is verified unavailable by server observation, the child cites that parent’s evidence, and child missing_data names the precise missing prerequisite and bounded observation. Different wording need not copy parent prose. An unrelated, unsupported, or merely not_applicable parent does not permit skipping a tool. A bounded page without an observed server request does not prove that no request existed. Mark a relevance-blocked child unavailable, not not_applicable or disproven; name the missing incident-path evidence, not a fictitious outage of a callable tool. Supported and contradicted checks always need their own required tools and available evidence. Explicitly separate warning-only conditions from actual blockers and preserve counterevidence or unverified necessary conditions in coverage. An attachment or earlier discussion is reported evidence, not a complete verified cause. Do not recommend editing a Sheet merely because a warning or label difference exists: first establish the relevant failing branch and rule, or recommend a precise read-only verification instead. Historical Slack and hotfix examples are optional context. Keep technical identifiers in facts/coverage/action_items, not user_result.`;
// Resolvers are private server functions attached to tool instances. Their output
// is derived from persisted adapter evidence, never final-answer prose.
export function deriveBlockedDependencies({ evidence, resolvers = {} }) {
  const blocks = {};
  if (!(evidence instanceof Map)) return blocks;
  for (const [name, resolver] of Object.entries(resolvers)) {
    if (typeof resolver !== 'function') continue;
    let block;
    try { block = resolver({ evidence }); }
    catch { continue; } // A broken resolver never grants a coverage exception.
    if (!block || !Array.isArray(block.evidence_ids) || !block.evidence_ids.length
      || block.evidence_ids.some((id) => !/^ev_[a-f0-9]{64}$/.test(id) || !evidence.has(id))
      || !/^[a-z][a-z0-9_]{1,100}$/.test(block.reason_code || '')) continue;
    blocks[name] = { evidence_ids: [...new Set(block.evidence_ids)], reason_code: block.reason_code };
  }
  return blocks;
}
export function validatePlan(plan, toolNames) {
  const errors = [];
  const ids = new Set();
  if (!Array.isArray(plan?.checks) || !plan.checks.length)
    return ["Plan has no checks."];
  for (const c of plan.checks) {
    if (ids.has(c.check_id)) errors.push(`Duplicate plan check ${c.check_id}`);
    ids.add(c.check_id);
    if (
      !Array.isArray(c.required_tools) ||
      !c.required_tools.length ||
      c.required_tools.some((t) => !toolNames.includes(t))
    )
      errors.push(`Unknown required tool in ${c.check_id}`);
    if (c.depends_on_check_ids !== undefined &&
      (!Array.isArray(c.depends_on_check_ids) ||
       new Set(c.depends_on_check_ids).size !== c.depends_on_check_ids.length))
      errors.push(`Invalid dependencies in ${c.check_id}`);
  }
  if (!plan.checks.some((c) => !c.depends_on_check_ids?.length))
    errors.push('Plan needs an observation root check.');
  const graph = new Map(plan.checks.map((c) => [c.check_id, c.depends_on_check_ids || []]));
  for (const [id, deps] of graph) for (const dep of deps) {
    if (!graph.has(dep)) errors.push(`Unknown dependency ${dep} in ${id}`);
    if (dep === id) errors.push(`Self dependency in ${id}`);
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { errors.push(`Cyclic dependency at ${id}`); return; }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id) || []) if (graph.has(dep)) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return errors;
}
export function reconcileInvestigationQuality({
  plan,
  answer,
  evidence,
  observedTools,
  dependencyBlocks = {},
}) {
  const errors = [];
  const rows = answer.coverage;
  const result = answer.user_result;
  if (
    !result ||
    ["headline", "what_happened", "next_action", "result_kind"].some(
      (k) => typeof result[k] !== "string" || !result[k].trim(),
    )
  )
    errors.push(
      "Provide the plain-language user_result fields and result_kind.",
    );
  if (
    result &&
    /^(?:확인\s*필요|추가\s*확인\s*필요|확인해\s*주세요)[.!\s]*$/.test(
      result.next_action || "",
    )
  )
    errors.push(
      "Name the concrete missing information and responsible human in next_action.",
    );
  if (!Array.isArray(rows))
    return [...errors, "Provide coverage for every independent plan check."];
  const checks = new Map(plan.checks.map((c) => [c.check_id, c])),
    seen = new Set();
  const coverageById = new Map();
  for (const row of rows)
    if (!coverageById.has(row.check_id)) coverageById.set(row.check_id, row);
  // A plan edge is useful only when the upstream unavailable conclusion itself
  // rests on observed adapter evidence. A model's coverage label is insufficient.
  const verifiedUnavailable = new Map(), checking = new Set();
  function unavailableWithEvidence(checkId) {
    if (verifiedUnavailable.has(checkId)) return verifiedUnavailable.get(checkId);
    if (checking.has(checkId)) return false;
    checking.add(checkId);
    const check = checks.get(checkId), row = coverageById.get(checkId);
    const ids = Array.isArray(row?.evidence_ids) ? row.evidence_ids : [];
    const parents = check?.depends_on_check_ids || [];
    // Every declared edge is a necessary prerequisite. One verified missing
    // prerequisite blocks a child, even if another prerequisite was observed.
    const citedBlockedParent = parents.some((id) =>
      unavailableWithEvidence(id) &&
      coverageById.get(id).evidence_ids.some((evidenceId) => ids.includes(evidenceId)));
    const directEvidence = ids.some((id) => {
      const item = evidence.get(id);
      return check?.required_tools?.includes(item?.source) &&
        (item.status === 'unavailable' ||
          (item.status === 'available' &&
            item.coverage?.dependency_prerequisite?.observed === false &&
            item.coverage?.dependency_prerequisite?.scope === 'bounded_page'));
    });
    const missingToolsCovered = check?.required_tools?.every((name) =>
      observedTools.has(name) ||
      dependencyBlocks[name]?.evidence_ids?.some((id) => ids.includes(id)) ||
      citedBlockedParent);
    const positiveOwnEvidence = ids.some((id) => {
      const item = evidence.get(id);
      return item?.status === 'available' &&
        check?.required_tools?.includes(item.source) &&
        (item.coverage?.dependency_prerequisite?.observed === true ||
          (['query_runtime_logs', 'query_live_vercel_request_logs'].includes(item.source) &&
            item.rows?.some((entry) => typeof entry.path === 'string' &&
              entry.path.startsWith('/api/') && typeof entry.timestamp === 'string')));
    });
    const valid = Boolean(check && row?.status === 'unavailable' &&
      ids.length && ids.every((id) => evidence.has(id)) &&
      typeof row.missing_data === 'string' && row.missing_data.trim().length >= 12 &&
      missingToolsCovered && !positiveOwnEvidence &&
      (directEvidence || citedBlockedParent));
    checking.delete(checkId);
    verifiedUnavailable.set(checkId, valid);
    return valid;
  }
  for (const row of rows) {
    const check = checks.get(row.check_id);
    if (!check || seen.has(row.check_id)) {
      errors.push(`Unknown or duplicate coverage ${row.check_id}`);
      continue;
    }
    seen.add(row.check_id);
    const ids = Array.isArray(row.evidence_ids) ? row.evidence_ids : [];
    if (ids.some((id) => !evidence.has(id)))
      errors.push(`Unknown evidence in ${row.check_id}`);
    const attempted = check.required_tools.filter(
      (name) => !observedTools.has(name),
    );
    const parentBlocked = (check.depends_on_check_ids || []).length > 0 &&
      unavailableWithEvidence(row.check_id);
    for (const name of attempted) {
      const block = dependencyBlocks[name];
      if (row.status === 'unavailable' && parentBlocked) continue;
      if (row.status === 'unavailable' && block?.evidence_ids?.some((id) => ids.includes(id))) continue;
      errors.push(block
        ? `${row.check_id}: ${name} is dependency-blocked (${block.reason_code}); only unavailable coverage may cite prerequisite evidence ${block.evidence_ids.join(', ')} with the exact missing data.`
        : `${row.check_id}: attempt missing tools ${name}${check.depends_on_check_ids?.length
          ? ' or cite validated unavailable prerequisite coverage and exact missing data' : ''}.`);
    }
    if (["supported", "contradicted"].includes(row.status)) {
      if (
        !ids.length ||
        ids.some((id) => evidence.get(id)?.status !== "available")
      )
        errors.push(`${row.check_id}: conclusions require available evidence.`);
      for (const tool of check.required_tools)
        if (
          !ids.some(
            (id) =>
              evidence.get(id)?.source === tool &&
              evidence.get(id)?.status === "available",
          )
        )
          errors.push(
            `${row.check_id}: cite available ${tool} evidence or record unavailable with exact missing data.`,
          );
    } else if (
      !row.missing_data ||
      row.missing_data.trim().length < 12 ||
      /^(?:확인\s*필요|추가\s*확인\s*필요)[.!\s]*$/.test(row.missing_data)
    )
      errors.push(
        `${row.check_id}: specify the missing data or inapplicability reason.`,
      );
    if (!ids.length)
      errors.push(
        `${row.check_id}: cite the observed result, including unavailable results.`,
      );
  }
  for (const id of checks.keys())
    if (!seen.has(id)) {
      const blocked = checks.get(id).required_tools.flatMap((name) =>
        dependencyBlocks[name] ? [`${name}: ${dependencyBlocks[name].reason_code} (cite ${dependencyBlocks[name].evidence_ids.join(', ')})`] : []);
      errors.push(`Missing validation ${id}; complete only this missing check.${blocked.length
        ? ` Server-observed prerequisites permit unavailable coverage only: ${blocked.join('; ')}.` : ''}`);
    }
  return [
    ...new Set([
      ...errors,
      ...structuredQualityErrors({ plan, answer, evidence }),
    ]),
  ];
}

export const actionItemsSchema = {
  type: "array",
  maxItems: 12,
  items: object({
    owner_role: { ...text, maxLength: 120 },
    target: {
      type: "object",
      additionalProperties: false,
      // Existing project actions remain valid without a scope property.
      required: ["project_id", "cell"],
      properties: {
        scope: { type: "string", enum: ["project", "platform"] },
        project_id: { type: "string", pattern: "^(?:p[0-9]{10,20})?$" },
        cell: { type: "string", pattern: "^(?:[A-Z]{1,3}[1-9][0-9]{0,5})?$" },
      },
    },
    observed_value: { type: "string", maxLength: 1000 },
    expected_value: { type: "string", maxLength: 1000 },
    evidence_ids: {
      type: "array",
      minItems: 1,
      maxItems: 50,
      items: { type: "string", pattern: "^ev_[a-f0-9]{64}$" },
    },
    check_ids: {
      type: "array",
      minItems: 1,
      maxItems: 24,
      items: { type: "string", pattern: "^check_[a-z0-9_]{1,40}$" },
    },
    next_action: { ...text, maxLength: 500 },
    verification: { ...text, maxLength: 1000 },
    claim_scope: {
      type: "string",
      enum: [
        "current_observation",
        "historical_observation",
        "static_rule",
        "unverified",
      ],
    },
  }),
};
const genericAction = (value) =>
  typeof value !== "string" ||
  /^(?:(?:담당자|담당자가|운영자|운영자가)\s*)?(?:추가\s*)?확인(?:이|이\s*더|을)?\s*(?:필요(?:합니다)?|진행해\s*주세요|해\s*주세요|해보세요)[.!\s]*$/.test(
    value.trim(),
  );
// Source navigation proves source content/history, never incident execution by itself.
const staticSources = new Set([
  "read_code",
  "search_code",
  "list_code_snapshots",
  "read_live_deployed_code",
  "list_live_source_files",
  "search_live_source",
  "read_live_source_range",
  "list_live_file_history",
  "read_live_hotfix_diff",
]);
const staticOnly = (e) => staticSources.has(e?.source);
const currentOnly = (e) =>
  e?.coverage?.historical_state === false ||
  e?.coverage?.historical_request_verified === false ||
  e?.coverage?.historical_request_execution_verified === false ||
  e?.coverage?.historical_precedent_only === true ||
  e?.historical_request_verified === false ||
  [
    "current_selected_documents",
    "current_persisted_ui_label_diagnostics",
    "current_deployment_metadata",
    "public_health_only",
  ].includes(e?.coverage?.scope);
function structuredQualityErrors({ plan, answer, evidence }) {
  const errors = [],
    rows = Array.isArray(answer.coverage) ? answer.coverage : [];
  const conclusions = rows.filter((r) =>
    ["supported", "contradicted"].includes(r.status),
  );
  if (
    (answer.cause_status === "supported" ||
      answer.user_result?.result_kind === "actionable_finding") &&
    !conclusions.length
  )
    errors.push(
      "An actionable finding or supported cause requires at least one evidenced supported/contradicted check; all-unavailable coverage cannot confirm a cause.",
    );
  const conclusionSources = conclusions
    .flatMap((row) => (row.evidence_ids || []).map((id) => evidence.get(id)))
    .filter((e) => e?.status === "available");
  if (
    (answer.cause_status === "supported" ||
      answer.user_result?.result_kind === "actionable_finding") &&
    conclusionSources.length &&
    conclusionSources.every(staticOnly)
  )
    errors.push(
      "Static source content or hotfix history alone cannot establish a supported incident cause or actionable incident finding; cite observed runtime or business state.",
    );
  for (const row of conclusions) {
    const check = plan.checks.find((c) => c.check_id === row.check_id);
    const cellComparison = (answer.action_items || []).some(
      (a) => a?.target?.cell && a.check_ids?.includes(row.check_id),
    );
    if (
      cellComparison &&
      check?.required_tools.includes("read_cashflow_sheet_diagnostics")
    ) {
      const observed = (row.evidence_ids || [])
        .map((id) => evidence.get(id))
        .filter(
          (e) =>
            e?.source === "read_cashflow_sheet_diagnostics" &&
            e.status === "available",
        );
      if (
        !observed.some((e) =>
          e.rows?.some(
            (r) =>
              r.exists === true &&
              r.last_refresh_error?.diagnostics?.some(
                (d) =>
                  d.source_cell &&
                  d.expected_label &&
                  d.actual_label &&
                  !d.message_redacted,
              ),
          ),
        )
      )
        errors.push(
          `${row.check_id}: available mirror metadata without an observed label comparison does not support a cell mismatch; record unavailable comparison data.`,
        );
    }
  }
  const actions = Array.isArray(answer.action_items) ? answer.action_items : [];
  if (
    answer.user_result?.result_kind === "actionable_finding" &&
    !actions.length
  )
    errors.push(
      "Provide structured action_items with target, observed/expected values, source scope and verification before claiming an actionable finding.",
    );
  if (genericAction(answer.user_result?.next_action))
    errors.push(
      "Replace the generic referral with a specific target, missing value and verification action.",
    );
  for (const a of actions) {
    if (
      !a ||
      !a.target ||
      (a.target.scope === "platform"
        ? a.target.project_id !== "" || a.target.cell !== ""
        : !/^p[0-9]{10,20}$/.test(a.target.project_id || "")) ||
      !a.owner_role?.trim() ||
      !a.verification?.trim() ||
      genericAction(a.next_action)
    ) {
      errors.push(
        "Action item needs an explicit valid target scope, responsible role, concrete action and verification.",
      );
      continue;
    }
    const ids = Array.isArray(a.evidence_ids) ? a.evidence_ids : [],
      sources = ids.map((id) => evidence.get(id));
    if (!ids.length || sources.some((e) => !e || e.status !== "available"))
      errors.push("Action comparison must cite available evidence.");
    if (
      !Array.isArray(a.check_ids) ||
      !a.check_ids.length ||
      a.check_ids.some((id) => !conclusions.some((r) => r.check_id === id))
    )
      errors.push(
        "Action item must bind to an evidenced supported/contradicted check.",
      );
    if (
      a.claim_scope === "historical_observation" &&
      (!sources.length || sources.every((e) => currentOnly(e) || staticOnly(e)))
    )
      errors.push(
        "Current-only observations or static code cannot establish a historical action comparison.",
      );
    for (const e of sources) {
      if (e?.project_id && e.project_id !== a.target.project_id)
        errors.push("Action target project does not match cited observation.");
    }
    if (a.target.cell) {
      const matches = sources
        .flatMap((e) => {
          if (e?.project_id !== a.target.project_id) return [];
          if (e.source === "read_authorized_sheet_labels")
            return (e.rows || [])
              .filter((r) => !r.redacted && !r.effective_error)
              .map((r) => ({ ...r, actual_label: r.observed_label }));
          return e.source === "read_cashflow_sheet_diagnostics"
            ? (e.rows || []).flatMap(
                (r) => r.last_refresh_error?.diagnostics || [],
              )
            : [];
        })
        .filter((d) => d.source_cell === a.target.cell && !d.message_redacted);
      if (
        !matches.some(
          (d) =>
            d.expected_label === a.expected_value &&
            d.actual_label === a.observed_value,
        )
      )
        errors.push(
          "Cell comparison must exactly match the cited authorized live labels or persisted diagnostic labels and cell; preserve which source was read.",
        );
      if (a.claim_scope !== "current_observation")
        errors.push(
          "Current mirror/live label comparisons must retain current_observation scope; historical cell state is not established.",
        );
    }
  }
  return errors;
}
