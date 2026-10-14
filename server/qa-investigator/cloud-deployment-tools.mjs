import { createHash } from "node:crypto";

const PROJECT = "inner-platform-live-20260316";
const REGION = "us-central1";
const SERVICE = "innerplatform-jvm-weekly-api-live";
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function createCloudDeploymentTools({ auth, policy, diagnosticRevisionAnchors = () => [], diagnosticsReady = () => true } = {}) {
  const observed = new Map(), diagnosticEvidence = new Map();
  const start = Date.parse(policy?.allowedStartAt),
    end = Date.parse(policy?.allowedEndAt);
  const revisionPattern = new RegExp(`^${SERVICE}-[a-z0-9-]+$`);
  function register(region, revision, evidenceId) {
    const key=`${region}:${revision}`;
    const entry=observed.get(key) || {region, revision, refs:new Set()};
    entry.refs.add(evidenceId);observed.set(key,entry);
  }
  function observeEvidence(evidence) {
    if (evidence?.source === 'query_jvm_request_diagnostics') {
      if (policy?.cloudProject !== PROJECT || policy?.tenant !== 'mysc') return;
      diagnosticEvidence.set(evidence.evidence_id, structuredClone(evidence));
      return;
    }

    if (
      policy?.cloudProject !== PROJECT ||
      policy?.tenant !== "mysc" ||
      !policy.services?.some(
        (item) => item.name === SERVICE && item.region === REGION,
      ) ||
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      start >= end ||
      evidence?.source !== "query_runtime_logs" ||
      evidence.status !== "available" ||
      !/^ev_[a-f0-9]{64}$/.test(evidence.evidence_id || "") ||
      evidence.evidence_id !== `ev_${evidence.content_hash}` ||
      !policy.allowedProjectIds?.includes(evidence.project_id) ||
      !Array.isArray(evidence.rows)
    )
      return;
    const a = Date.parse(evidence.start_at),
      b = Date.parse(evidence.end_at);
    if (
      !Number.isFinite(a) ||
      !Number.isFinite(b) ||
      a < start ||
      b > end ||
      a >= b
    )
      return;
    for (const row of evidence.rows) {
      const at = Date.parse(row.timestamp);
      if (
        !revisionPattern.test(row.revision || "") ||
        row.region !== REGION ||
        !Number.isFinite(at) ||
        at < a ||
        at >= b ||
        !Number.isInteger(row.status) ||
        row.status < 400 ||
        row.status > 599 ||
        typeof row.path !== "string" ||
        !row.path.startsWith(`/api/v1/cashflow/${evidence.project_id}/`) ||
        !new RegExp(`^projects/${PROJECT}/traces/[a-f0-9]{32}$`).test(
          row.trace || "",
        )
      )
        continue;
      register(row.region, row.revision, evidence.evidence_id);
    }
  }
  const registry = {
    read_live_jvm_deployment: {
      description:
        "Read current JVM traffic metadata, or scope=incident for the unique JVM revision observed in permitted HTTP trace logs or server-anchored request diagnostics. Incident reads never use current traffic as fallback. No environment values. A deployment SHA label is metadata, not image attestation or proof of root cause.",
      parameters: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["current", "incident"] },
        },
        required: [],
        additionalProperties: false,
      },
      async execute(args, { signal } = {}) {
        const observed_at = new Date().toISOString();
        try {
          if (
            !args ||
            typeof args !== "object" ||
            Array.isArray(args) ||
            Object.keys(args).some((key) => key !== "scope") ||
            (args.scope !== undefined &&
              !["current", "incident"].includes(args.scope))
          )
            throw new Error("invalid_scope");
          const incident = args.scope === "incident";
          if (incident && !diagnosticsReady()) throw new Error("incident_diagnostics_incomplete");
          const candidates = new Map([...observed].map(([key,value])=>[key,{...value,refs:new Set(value.refs)}]));
          if (incident) for (const item of diagnosticEvidence.values()) for (const ref of diagnosticRevisionAnchors(item)) {
            if (!policy.services?.some(s=>s.name===SERVICE && s.region===ref.region)
                || !['us-central1','asia-northeast3'].includes(ref.region)
                || !revisionPattern.test(ref.revision || '') || !/^ev_[a-f0-9]{64}$/.test(ref.evidence_id || '')) continue;
            const key=`${ref.region}:${ref.revision}`;
            const candidate=candidates.get(key) || {region:ref.region,revision:ref.revision,refs:new Set()};
            candidate.refs.add(ref.evidence_id);candidates.set(key,candidate);
          }
          if (incident && candidates.size !== 1)
            throw new Error(
              candidates.size
                ? "incident_revision_ambiguous"
                : "incident_revision_not_observed",
            );
          const selected = incident ? candidates.values().next().value : null;
          const region = selected?.region || REGION;
          const client = await auth.getClient();
          const origin = `https://${region}-run.googleapis.com/apis/serving.knative.dev/v1/namespaces/${PROJECT}`;
          const read = async (path) => {
            signal?.throwIfAborted();
            return (
              await client.request({
                url: `${origin}/${path}`,
                method: "GET",
                timeout: 20000,
                retry: false,
                ...(signal ? { signal } : {}),
              })
            ).data;
          };
          let revisionName;
          if (incident) revisionName = selected.revision;
          else {
            const first = await read(`services/${SERVICE}`);
            const serving = (first.status?.traffic || []).filter(
              (item) => item.percent > 0,
            );
            if (
              serving.length !== 1 ||
              serving[0].percent !== 100 ||
              !revisionPattern.test(serving[0].revisionName || "")
            )
              throw new Error("deployment_revision_unverified");
            revisionName = serving[0].revisionName;
          }
          const revision = await read(`revisions/${revisionName}`);
          if (
            revision.metadata?.name !== revisionName ||
            revision.metadata?.labels?.["serving.knative.dev/service"] !==
              SERVICE
          )
            throw new Error("deployment_revision_unverified");
          const sha = revision.metadata?.labels?.["myscube-deploy-sha"];
          if (!/^[a-f0-9]{40}$/.test(sha || ""))
            throw new Error("deployment_revision_unverified");
          if (!incident) {
            const last = await read(`services/${SERVICE}`);
            const current = (last.status?.traffic || []).filter(
              (item) => item.percent > 0,
            );
            if (
              current.length !== 1 ||
              current[0].percent !== 100 ||
              current[0].revisionName !== revisionName
            )
              throw new Error("deployment_changed_during_read");
          }
          const result = {
            rows: [
              {
                service: SERVICE,
                region,
                revision_name: revisionName,
                traffic_percent: incident ? null : 100,
                request_log_evidence_ids: incident
                  ? [...selected.refs].sort()
                  : [],
                metadata_commit_sha: sha,
              },
            ],
            coverage: {
              complete: true,
              scope: incident
                ? "observed_request_revision_metadata"
                : "current_cloud_run_revision_metadata",
              request_revision_observed: incident,
              incident_request_uniquely_identified: false,
              historical_state: false,
              image_attestation_verified: false,
              effective_environment_verified: false,
            },
          };
          const content_hash = hash(result);
          return {
            source: "read_live_jvm_deployment",
            status: "available",
            observed_at,
            evidence_id: `ev_${content_hash}`,
            content_hash,
            ...result,
            cause_status: "not_established",
          };
        } catch (error) {
          signal?.throwIfAborted();
          const error_code = [
            "invalid_scope",
            "deployment_revision_unverified",
            "deployment_changed_during_read",
            "incident_revision_not_observed",
            "incident_diagnostics_incomplete",
            "incident_revision_ambiguous",
          ].includes(error.message)
            ? error.message
            : Number(error?.response?.status) === 403
              ? "source_access_denied"
              : "source_unavailable";
          return {
            source: "read_live_jvm_deployment",
            status: "unavailable",
            observed_at,
            evidence_id: `ev_${hash({ error_code, observed_at })}`,
            error_code,
            rows: [],
            coverage: { complete: false, snapshot_fallback: false },
            cause_status: "not_established",
          };
        }
      },
    },
  };
  Object.defineProperty(registry, "observeEvidence", {
    value: observeEvidence,
  });
  return registry;
}
