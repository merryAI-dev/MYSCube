const targets = new Set([
  "web_current",
  "web_incident",
  "jvm_current",
  "jvm_incident",
]);
const fail = (code) => {
  throw Object.assign(new Error(code), { safeCode: code });
};

export function createRevisionResolver({
  priorEvidence = [],
  readWeb,
  readJvm,
}) {
  const anchors = new Map();
  for (const evidence of priorEvidence) {
    if (
      evidence.repository !== "MYSCube" ||
      !targets.has(evidence.revision_target) ||
      !/^[a-f0-9]{40}$/.test(evidence.revision || "")
    )
      continue;
    const previous = anchors.get(evidence.revision_target);
    if (previous && previous.revision !== evidence.revision)
      fail("investigation_revision_anchor_conflict");
    anchors.set(evidence.revision_target, {
      repository: "MYSCube",
      revision: evidence.revision,
      deployment_id: evidence.deployment_id,
      runtime_revision: evidence.runtime_revision,
      request_log_evidence_ids: evidence.request_log_evidence_ids,
      deployment_observation: evidence.deployment_observation,
    });
  }
  return async ({ target = "web_current", signal } = {}) => {
    if (!targets.has(target)) fail("invalid_scope");
    const incident = target.endsWith("_incident");
    const previous = anchors.get(target);
    // New observations can make an incident ambiguous, including after resume.
    if (previous && !incident) return previous;
    const result = await (target.startsWith("jvm_") ? readJvm : readWeb)(
      { scope: incident ? "incident" : "current" },
      { signal },
    );
    if (
      result.status !== "available" ||
      result.rows?.length !== 1 ||
      !/^[a-f0-9]{40}$/.test(result.rows[0].metadata_commit_sha || "")
    )
      fail("deployment_revision_unverified");
    const row = result.rows[0];
    const anchor = {
      repository: "MYSCube",
      revision: row.metadata_commit_sha,
      deployment_id: row.deployment_id,
      runtime_revision: row.revision_name,
      request_log_evidence_ids: row.request_log_evidence_ids,
      deployment_observation: structuredClone(result),
    };
    if (
      previous &&
      (previous.revision !== anchor.revision ||
        (previous.runtime_revision &&
          previous.runtime_revision !== anchor.runtime_revision) ||
        (previous.deployment_id &&
          previous.deployment_id !== anchor.deployment_id))
    )
      fail("investigation_revision_anchor_conflict");
    anchors.set(target, anchor);
    return anchor;
  };
}
