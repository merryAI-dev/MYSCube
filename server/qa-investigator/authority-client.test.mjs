import test from "node:test";
import assert from "node:assert/strict";
import { createCaseAuthorityClient } from "./authority-client.mjs";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
const scope = {
  authority: "server_binding",
  tenant_id: "mysc",
  scope_kind: "platform",
  project_ids: [],
};
const input = {
  caseId: "case",
  runId: "run",
  actorId: "actor",
  phase: "run",
  scope,
};
const origin = "https://mysc-qa-authority-fixture.a.run.app";
const at = "2026-10-13T00:00:00Z";
const good = {
  allowed: true,
  phase: "run",
  case_id: "case",
  run_id: "run",
  qa_actor_id: "actor",
  business_actor_id: "business-actor",
  tenant_id: "mysc",
  scope_hash: candidateHash(scope),
  checked_at: at,
};
const auth = {
  getIdTokenClient: async (audience) => {
    assert.equal(audience, origin);
    return {
      getRequestHeaders: async () =>
        new Headers({ authorization: "Bearer fixture" }),
    };
  },
};
test("authority decision binds case, actor, tenant, exact scope and fresh time; sends no caller identity override", async () => {
  let body;
  const verify = createCaseAuthorityClient({
    auth,
    origin,
    now: () => Date.parse(at),
    fetchImpl: async (url, options) => {
      assert.equal(url, origin + "/internal/authorize-case");
      body = JSON.parse(options.body);
      return Response.json(good);
    },
  });
  assert.deepEqual(await verify(input), { businessActorId: "business-actor" });
  assert.deepEqual(body, { case_id: "case", run_id: "run", phase: "run" });
});
test("revoked, unavailable, replayed or different-scope authorization never becomes permission", async () => {
  for (const response of [
    new Response("", { status: 403 }),
    new Response("", { status: 503 }),
    Response.json({ ...good, scope_hash: "bad" }),
    Response.json({ ...good, qa_actor_id: "other" }),
    Response.json({ ...good, checked_at: "2026-10-12T00:00:00Z" }),
    Response.json({ ...good, allowed: false }),
    Response.json({ ...good, phase: "intake" }),
  ]) {
    const verify = createCaseAuthorityClient({
      auth,
      origin,
      now: () => Date.parse(at),
      fetchImpl: async () => response,
    });
    await assert.rejects(verify(input));
  }
  assert.throws(() =>
    createCaseAuthorityClient({ auth, origin: "https://evil.example" }),
  );
});

test('accepts observed regional Cloud Run authority URL',()=>{
 assert.doesNotThrow(()=>createCaseAuthorityClient({auth,origin:'https://mysc-qa-authority-1084486080400.asia-northeast3.run.app'}));
});

test('discovered project receipt binds project, case generation, event and read purpose',async()=>{
 const projectId='p1779092105308',runId='qa-22222222-2222-4222-8222-222222222222';
 const request={...input,runId,projectId,aggregateVersion:3};
 const receipt={...good,run_id:runId,project_id:projectId,aggregate_version:3,event_id:runId.slice(3),purpose:'investigation_read',project_source_revision:'a'.repeat(64)};
 let posted;
 const verify=createCaseAuthorityClient({auth,origin,now:()=>Date.parse(at),fetchImpl:async(url,options)=>{assert.equal(url,origin+'/internal/authorize-case-project');posted=JSON.parse(options.body);return Response.json(receipt);}});
 assert.deepEqual(await verify(request),{businessActorId:'business-actor',projectId,sourceRevision:'a'.repeat(64)});
 assert.deepEqual(posted,{case_id:input.caseId,run_id:runId,project_id:projectId});
 for(const changed of [{project_id:'p1779092105309'},{aggregate_version:2},{event_id:'other'},{purpose:'write'},{case_id:'foreign'},{run_id:'foreign'},{checked_at:'2099-01-01T00:00:00Z'},{checked_at:'2020-01-01T00:00:00Z'},{project_source_revision:''}]){
  const check=createCaseAuthorityClient({auth,origin,now:()=>Date.parse(at),fetchImpl:async()=>Response.json({...receipt,...changed})});
  await assert.rejects(check(request),/investigation_authority_invalid/);
 }
});
