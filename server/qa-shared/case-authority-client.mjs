import { candidateHash } from "./candidate-integrity.mjs";
const fail = (code) => {
  throw Object.assign(new Error(code), { code, safeCode: code });
};
export function createCaseAuthorityClient({
  auth,
  origin,
  fetchImpl = fetch,
  now = Date.now,
}) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    fail("investigation_authority_unconfigured");
  }
  if (
    url.protocol !== "https:" ||
    !/^mysc-qa-authority-[a-z0-9-]+(?:\.asia-northeast3|\.a)?\.run\.app$/.test(url.hostname) ||
    origin !== url.origin
  )
    fail("investigation_authority_unconfigured");
  return async ({ caseId, runId, phase, actorId, scope, projectId, aggregateVersion }) => {
    const projectRead = projectId !== undefined;
    if (projectRead && (phase !== "run" || !/^p[0-9]{10,20}$/.test(projectId)
      || !Number.isSafeInteger(aggregateVersion) || aggregateVersion < 1))
      fail("investigation_authority_invalid");
    let response;
    try {
      const client = await auth.getIdTokenClient(origin);
      const headers = await client.getRequestHeaders(origin);
      const token = headers.get
        ? headers.get("authorization")
        : headers.Authorization;
      if (!/^Bearer \S+$/.test(token || ""))
        fail("investigation_authority_unavailable");
      response = await fetchImpl(`${origin}/internal/${projectRead ? "authorize-case-project" : "authorize-case"}`, {
        method: "POST",
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(15000),
        headers: { Authorization: token, "Content-Type": "application/json" },
        body: JSON.stringify(projectRead ? { case_id: caseId, run_id: runId, project_id: projectId } : { case_id: caseId, run_id: runId, phase }),
      });
    } catch {
      fail("investigation_authority_unavailable");
    }
    if (!response.ok) {
      await response.body?.cancel();
      fail(
        [401, 403, 404].includes(response.status)
          ? "investigation_authority_revoked"
          : "investigation_authority_unavailable",
      );
    }
    let data;
    try {
      const reader = response.body.getReader();
      let size = 0;
      const chunks = [];
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 8192) {
            await reader.cancel();
            throw Error();
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      fail("investigation_authority_invalid");
    }
    if (
      data.allowed !== true ||
      data.case_id !== caseId ||
      data.run_id !== runId ||
      data.phase !== phase ||
      data.qa_actor_id !== actorId ||
      !/^[-A-Za-z0-9_]{1,128}$/.test(data.business_actor_id || "") ||
      data.tenant_id !== scope.tenant_id ||
      data.scope_hash !== candidateHash(scope) ||
      !Number.isFinite(Date.parse(data.checked_at)) ||
      Math.abs(now() - Date.parse(data.checked_at)) > 30000
    )
      fail("investigation_authority_invalid");
    if (projectRead && (data.project_id !== projectId || data.purpose !== 'investigation_read'
      || data.aggregate_version !== aggregateVersion || data.event_id !== runId.slice(3)
      || !/^[a-f0-9]{64}$/.test(data.project_source_revision || '')))
      fail("investigation_authority_invalid");
    return { businessActorId: data.business_actor_id,
      ...(projectRead ? {projectId:data.project_id,sourceRevision:data.project_source_revision} : {}) };
  };
}
