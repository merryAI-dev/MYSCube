import test from "node:test";
import assert from "node:assert/strict";
import { loadPipelineContext, decodeFields } from "./pipeline-context.mjs";
import { candidateHash } from "../qa-shared/candidate-integrity.mjs";
const id = "11111111-1111-4111-8111-111111111111",
  caseId = "22222222-2222-4222-8222-222222222222",
  runId = `qa-${id}`;
const root =
    "projects/inner-platform-qa-20260310/databases/qa-assistant/documents",
  base = `${root}/orgs/mysc`;
const runPath = `${base}/qa_runs/${runId}`,
  casePath = `${base}/qa_cases/${caseId}`;
const initial = {
  run_id: runId,
  tenant_id: "mysc",
  input_hash: "fixture-hash",
  title: "fixture",
  model: "test-model",
  provider: "openai",
  status: "running",
  execution_name: "qa-investigator-pipeline-first1",
};
const encode = (v) =>
  v === null
    ? {
        nullValue: null,
      }
    : typeof v === "string"
      ? {
          stringValue: v,
        }
      : typeof v === "boolean"
        ? {
            booleanValue: v,
          }
        : typeof v === "number"
          ? {
              integerValue: String(v),
            }
          : Array.isArray(v)
            ? {
                arrayValue: {
                  values: v.map(encode),
                },
              }
            : {
                mapValue: {
                  fields: fields(v),
                },
              };
const fields = (v) =>
  Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
// REST CAS model: tests contract and fencing, not real Firestore/IAM behavior.
function fixture({
  authorizeScope = async () => ({ businessActorId: "business-actor" }),
} = {}) {
  const docs = new Map(),
    transactions = new Map();
  let version = 0,
    txCounter = 0;
  const set = (path, value) =>
    docs.set(path, {
      name: path,
      fields: fields(value),
      updateTime: `v${++version}`,
    });
  set(`${base}/qa_dispatches/${id}`, {
    dispatch_id: id,
    event_id: id,
    run_id: runId,
    case_id: caseId,
    workspace_id: "mysc",
  });
  set(casePath, {
    case_id: caseId,
    workspace_id: "mysc",
    platform_key: "myscube",
    aggregate_version: 1,
    title: "fixture",
    description: "test",
    actor_id: "actor",
    created_at: new Date().toISOString(),
    investigation_scope: {
      authority: "server_binding",
      tenant_id: "mysc",
      project_ids: ["p1779092105308"],
    },
  });
  set(`${base}/members/actor`, {
    status: "ACTIVE",
  });
  set(`${base}/qa_actor_business_links/actor`, {
    status: "ACTIVE",
    qa_actor_id: "actor",
    business_actor_id: "business-actor",
    source: "dual_firebase_tokens",
  });
  const client = {
    async request({ url, method = "GET", data }) {
      const relative = url.replace("https://firestore.googleapis.com/v1/", ""),
        [path, query] = relative.split("?"),
        transaction = new URLSearchParams(query).get("transaction");
      if (method === "GET") {
        if (transaction)
          transactions.get(transaction).set(path, docs.get(path)?.updateTime);
        if (path.endsWith("/evidence"))
          return {
            data: {
              documents: [...docs.entries()]
                .filter(
                  ([name]) =>
                    name.startsWith(`${path}/`) &&
                    name.slice(path.length + 1).indexOf("/") === -1,
                )
                .map(([, doc]) => structuredClone(doc)),
            },
          };
        if (!docs.has(path))
          throw {
            response: {
              status: 404,
            },
          };
        return {
          data: structuredClone(docs.get(path)),
        };
      }
      if (path === `${root}:beginTransaction`) {
        const transaction = `tx${++txCounter}`;
        transactions.set(transaction, new Map());
        return {
          data: {
            transaction,
          },
        };
      }
      if (path === `${root}:rollback`) {
        transactions.delete(data.transaction);
        return {
          data: {},
        };
      }
      assert.equal(path, `${root}:commit`);
      if (data.transaction) {
        assert.ok(transactions.has(data.transaction));
        for (const [name, version] of transactions.get(data.transaction)) {
          if (docs.get(name)?.updateTime !== version)
            throw {
              response: {
                status: 409,
              },
            };
        }
      }
      if (data.transaction) transactions.delete(data.transaction);
      for (const w of data.writes) {
        const d = docs.get(w.update.name),
          p = w.currentDocument;
        if (
          (p?.exists === false && d) ||
          (p?.exists === true && !d) ||
          (p?.updateTime && d?.updateTime !== p.updateTime)
        )
          throw {
            response: {
              status: 409,
            },
          };
      }
      for (const w of data.writes) {
        const current = decodeFields(docs.get(w.update.name)?.fields);
        set(
          w.update.name,
          w.updateMask
            ? {
                ...current,
                ...decodeFields(w.update.fields),
              }
            : decodeFields(w.update.fields),
        );
      }
      return {
        data: {
          writeResults: data.writes.map(() => ({})),
        },
      };
    },
  };
  return {
    docs,
    transactions,
    set,
    client,
    load: () =>
      loadPipelineContext({
        client,
        dispatchId: id,
        runId,
        tenantId: "mysc",
        authorizeScope,
      }),
  };
}
test("trusted scope required before lease or reads of investigation sources", async () => {
  const f = fixture();
  f.set(casePath, {
    ...decodeFields(f.docs.get(casePath).fields),
    investigation_scope: {
      authority: "reporter_text",
      tenant_id: "mysc",
      project_ids: ["p1779092105308"],
    },
  });
  await assert.rejects(f.load(), /investigation_scope_binding_required/);
  assert.equal(f.docs.has(runPath), false);
});
test("initial run defaults private and active lease prevents second claimant", async () => {
  const f = fixture(),
    a = await f.load();
  assert.equal((await a.begin(initial)).skip, false);
  assert.equal(decodeFields(f.docs.get(runPath).fields).visibility, "private");
  const b = await f.load();
  assert.equal((await b.begin(initial)).skip, true);
});
test("revoked membership blocks later tool authorization and writes", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  f.set(`${base}/members/actor`, {
    status: "REMOVED",
  });
  await assert.rejects(a.authorize(), /investigation_authority_revoked/);
  await assert.rejects(a.heartbeat(), /investigation_authority_revoked/);
});
test("client error scope uses the canonical case actor, never a claimed reporter identity", async () => {
  const f = fixture();
  f.set(casePath, {
    ...decodeFields(f.docs.get(casePath).fields),
    reported_context: {
      actor_id: "someone-else",
      trustedActorId: "someone-else",
    },
  });
  const context = await f.load();
  assert.equal(context.request.policy.trustedActorId, "business-actor");
});
test("planner report carries server-bound platform routing for project scope", async () => {
  const context = await fixture().load();
  assert.equal(context.request.report.server_context.platform_key, "myscube");
  assert.equal(context.request.report.server_context.scope_kind, "project");
  assert.deepEqual(context.request.report.server_context.project_ids, [
    "p1779092105308",
  ]);
});
test("new claimant after expiry fences old process writes", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  f.set(runPath, {
    ...decodeFields(f.docs.get(runPath).fields),
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  const b = await f.load();
  assert.equal((await b.begin(initial)).skip, false);
  await assert.rejects(a.heartbeat(), /investigation_lease_lost/);
  await b.heartbeat();
});
test("resume returns only verified evidence records bound to this case input and version", async () => {
  const f = fixture(),
    first = await f.load();
  await first.begin(initial);
  f.set(runPath, {
    ...decodeFields(f.docs.get(runPath).fields),
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  const item = {
    evidence_id: `ev_${"a".repeat(64)}`,
    source: "query_client_errors",
    status: "available",
    observed_at: "2026-10-13T00:00:00.000Z",
    rows: [],
  };
  const stored = {
    evidence_id: item.evidence_id,
    source: item.source,
    status: item.status,
    observed_at: item.observed_at,
    payload_json: JSON.stringify(item),
    payload_sha256: candidateHash(item),
    ...first.runBinding,
  };
  const evidencePath = `${runPath}/evidence/${item.evidence_id}`;
  f.set(evidencePath, stored);
  const resumed = await (await f.load()).begin(initial);
  assert.deepEqual(resumed.priorEvidence, [item]);
  assert.deepEqual(resumed.priorEvidenceRecords, [
    { documentId: item.evidence_id, stored },
  ]);
  assert.equal(first.runBinding.case_id, caseId);
  assert.equal(first.runBinding.aggregate_version, 1);
  f.set(runPath, {
    ...decodeFields(f.docs.get(runPath).fields),
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  f.set(evidencePath, { ...stored, case_input_hash: "b".repeat(64) });
  await assert.rejects(
    (await f.load()).begin(initial),
    /session_stored_evidence_binding_invalid/,
  );
  assert.equal(
    decodeFields(f.docs.get(runPath).fields).lease_expires_at,
    "2000-01-01T00:00:00Z",
  );
});
test("Slack history grant is explicit and revoked grant closes authorization", async () => {
  const f = fixture();
  assert.equal((await f.load()).slackHistory, null);
  const path = `${base}/qa_slack_history_access/actor`;
  f.set(path, {
    status: "ACTIVE",
    actor_id: "actor",
    workspace_id: "TTEST",
    channel_ids: ["CTEST"],
    organization_summary_allowed: false,
  });
  const a = await f.load();
  await a.begin(initial);
  assert.deepEqual(a.slackHistory.allowedChannelIds, ["CTEST"]);
  f.set(path, {
    status: "REVOKED",
    actor_id: "actor",
    workspace_id: "TTEST",
    channel_ids: ["CTEST"],
  });
  assert.equal(await a.authorizeSlackHistory(), null);
});
test("cancelled case denies later authorization and persistence", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  f.set(casePath, {
    ...decodeFields(f.docs.get(casePath).fields),
    case_status: "cancelled",
  });
  await assert.rejects(a.authorize(), /investigation_authority_revoked/);
  await assert.rejects(a.commit([]), /investigation_authority_revoked/);
});
test("expired or malformed lease is never renewed by its old process", async () => {
  for (const expiry of ["2000-01-01T00:00:00Z", "invalid"]) {
    const f = fixture(),
      a = await f.load();
    await a.begin(initial);
    f.set(runPath, {
      ...decodeFields(f.docs.get(runPath).fields),
      lease_expires_at: expiry,
    });
    await assert.rejects(a.authorize(), /investigation_lease_lost/);
    await assert.rejects(a.heartbeat(), /investigation_lease_lost/);
  }
});
test("resume identity change is rejected before model restart", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  f.set(runPath, {
    ...decodeFields(f.docs.get(runPath).fields),
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  const b = await f.load();
  await assert.rejects(
    b.begin({
      ...initial,
      model: "other-model",
    }),
    /investigation_resume_identity_mismatch/,
  );
});
test("final persist CAS conflict writes neither completion nor delivery", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  const original = f.client.request;
  let raced = false;
  f.client.request = async (input) => {
    if (
      input.method === "POST" &&
      input.data.writes.some(
        (w) => decodeFields(w.update.fields).status === "completed",
      ) &&
      !raced
    ) {
      raced = true;
      f.set(runPath, {
        ...decodeFields(f.docs.get(runPath).fields),
        lease_owner: "new-owner",
      });
    }
    return original(input);
  };
  await assert.rejects(
    a.commit([
      {
        update: {
          name: runPath,
          fields: fields({
            status: "completed",
            review: {
              accepted: true,
            },
            answer: {
              user_reply: "fixture",
            },
          }),
        },
      },
    ]),
    /investigation_storage_unavailable/,
  );
  assert.equal(decodeFields(f.docs.get(runPath).fields).status, "running");
  assert.equal(f.docs.has(`${base}/qa_external_deliveries/${runId}`), false);
  assert.equal(
    decodeFields(f.docs.get(casePath).fields).execution_status,
    undefined,
  );
});
for (const changed of ["member", "case"])
  test(`final transaction rejects ${changed} revocation after authorization`, async () => {
    const f = fixture(),
      a = await f.load();
    await a.begin(initial);
    const original = f.client.request;
    f.client.request = async (input) => {
      if (
        input.method === "POST" &&
        input.data.transaction &&
        input.data.writes
      ) {
        if (changed === "member")
          f.set(`${base}/members/actor`, {
            status: "REMOVED",
          });
        else
          f.set(casePath, {
            ...decodeFields(f.docs.get(casePath).fields),
            case_status: "cancelled",
          });
      }
      return original(input);
    };
    await assert.rejects(
      a.commit([
        {
          update: {
            name: runPath,
            fields: fields({
              status: "completed",
              review: {
                accepted: true,
              },
              answer: {
                user_reply: "fixture",
              },
            }),
          },
        },
      ]),
      /investigation_storage_unavailable/,
    );
    assert.equal(decodeFields(f.docs.get(runPath).fields).status, "running");
    assert.equal(f.docs.has(`${base}/qa_external_deliveries/${runId}`), false);
  });
test("completed run persists only investigator-owned paths and releases lease", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  await a.commit([
    {
      update: {
        name: runPath,
        fields: fields({
          status: "completed",
          review: {
            accepted: true,
          },
          answer: {
            user_reply: "fixture",
          },
        }),
      },
    },
  ]);
  const run = decodeFields(f.docs.get(runPath).fields);
  assert.equal(run.status, "completed");
  assert.equal(run.lease_owner, null);
  assert.match(run.case_input_hash, /^[a-f0-9]{64}$/);
  assert.equal(run.case_actor_id, "actor");
  assert.equal(run.case_aggregate_version, 1);
  assert.equal(
    decodeFields(f.docs.get(casePath).fields).execution_status,
    undefined,
  );
  assert.equal(f.docs.has(`${base}/qa_external_deliveries/${runId}`), false);
});
test("investigator cannot directly mutate a BFF-owned case", async () => {
  const f = fixture(),
    a = await f.load();
  await a.begin(initial);
  await assert.rejects(
    a.commit([
      {
        update: {
          name: casePath,
          fields: fields({
            execution_status: "completed",
          }),
        },
      },
    ]),
    /investigation_invalid_write/,
  );
});

test("typed platform scope supports login QA without inventing project access", async () => {
  const checks = [],
    f = fixture({
      authorizeScope: async (value) => {
        checks.push(value);
        return { businessActorId: "business-actor" };
      },
    });
  const qa = decodeFields(f.docs.get(casePath).fields);
  f.set(casePath, {
    ...qa,
    investigation_scope: {
      authority: "server_binding",
      tenant_id: "mysc",
      scope_kind: "platform",
      project_ids: [],
    },
  });
  const context = await f.load();
  assert.deepEqual(context.request.policy.allowedProjectIds, []);
  assert.equal(context.request.policy.scopeKind, "platform");
  assert.equal(context.request.report.server_context.platform_key, "myscube");
  assert.equal(context.request.report.server_context.scope_kind, "platform");
  assert.deepEqual(context.request.report.server_context.project_ids, []);
  await context.begin(initial);
  await context.authorize();
  assert.ok(checks.some((c) => c.phase === "intake"));
  assert.ok(checks.some((c) => c.phase === "run"));
});
test("current owner denial prevents next tool and checkpoint even when QA grant and member stay active", async () => {
  let revoked = false;
  const f = fixture({
    authorizeScope: async () => {
      if (revoked) throw Error("owner_access_revoked");
      return { businessActorId: "business-actor" };
    },
  });
  const context = await f.load();
  await context.begin(initial);
  revoked = true;
  await assert.rejects(context.authorize(), /owner_access_revoked/);
  await assert.rejects(context.heartbeat(), /owner_access_revoked/);
});

test("a changed business identity fences the existing run instead of changing client-error ownership", async () => {
  let businessActorId = "business-actor";
  const f = fixture({ authorizeScope: async () => ({ businessActorId }) });
  const context = await f.load();
  assert.equal(context.request.policy.trustedActorId, "business-actor");
  businessActorId = "different-business-actor";
  await assert.rejects(context.authorize(), /investigation_authority_revoked/);
});

test("remote authority is refreshed outside every write transaction", async () => {
  let f,
    calls = 0;
  f = fixture({
    authorizeScope: async () => {
      assert.equal(f.transactions.size, 0);
      calls++;
      return { businessActorId: "business-actor" };
    },
  });
  const context = await f.load();
  await context.begin(initial);
  const before = calls;
  await context.heartbeat();
  assert.equal(calls, before + 1);
});
test("unlink after remote authorization fences final persistence", async () => {
  const f = fixture();
  const context = await f.load();
  await context.begin(initial);
  const original = f.client.request;
  f.client.request = async (input) => {
    if (input.url.endsWith(":beginTransaction"))
      f.set(`${base}/qa_actor_business_links/actor`, {
        status: "REVOKED",
        qa_actor_id: "actor",
        business_actor_id: "business-actor",
        source: "dual_firebase_tokens",
      });
    return original(input);
  };
  await assert.rejects(context.heartbeat(), /investigation_authority_revoked/);
});

test("an old dispatch cannot investigate a reopened case generation", async () => {
  const f = fixture();
  f.set(casePath, {
    ...decodeFields(f.docs.get(casePath).fields),
    aggregate_version: 2,
    investigation_event_id: "33333333-3333-4333-8333-333333333333",
  });
  await assert.rejects(f.load(), /investigation_scope_binding_required/);
  assert.equal(f.docs.has(runPath), false);
});

test("Firestore map key order is not a revocation; changed scope still is", async () => {
  const f = fixture();
  const original = f.client.request.bind(f.client);
  let reads = 0;
  f.client.request = async (request) => {
    const response = await original(request);
    if (request.url.includes(`/qa_cases/${caseId}`) && response.data?.fields) {
      const scope = response.data.fields.investigation_scope.mapValue.fields;
      response.data.fields.investigation_scope.mapValue.fields =
        Object.fromEntries(
          reads++ % 2 ? Object.entries(scope).reverse() : Object.entries(scope),
        );
    }
    return response;
  };
  const a = await f.load();
  assert.equal((await a.begin(initial)).skip, false);
  const b = await f.load();
  assert.equal((await b.begin(initial)).skip, true);
  const current = decodeFields(f.docs.get(casePath).fields);
  f.set(casePath, {
    ...current,
    investigation_scope: {
      ...current.investigation_scope,
      project_ids: ["p1775179565523"],
    },
  });
  await assert.rejects(a.authorize(), /investigation_authority_revoked/);
});

test("resume atomically advances current execution with lease while preserving first execution", async () => {
  const f = fixture();
  const first = await f.load();
  await first.begin({
    ...initial,
    current_execution_name: "model-proposed-execution",
  });
  const original = decodeFields(f.docs.get(runPath).fields);
  assert.equal(original.execution_name, initial.execution_name);
  assert.equal(original.current_execution_name, initial.execution_name);

  const nextInitial = {
    ...initial,
    execution_name: "qa-investigator-pipeline-second2",
  };
  assert.equal((await (await f.load()).begin(nextInitial)).skip, true);
  assert.deepEqual(decodeFields(f.docs.get(runPath).fields), original);

  // A legacy run may predate current_execution_name; only the trusted new
  // Cloud Run context can supply it, not any value from the stored record.
  const { current_execution_name, ...legacy } = original;
  f.set(runPath, { ...legacy, lease_expires_at: "2000-01-01T00:00:00Z" });
  assert.equal((await (await f.load()).begin(nextInitial)).skip, false);
  const resumed = decodeFields(f.docs.get(runPath).fields);
  assert.equal(resumed.execution_name, initial.execution_name);
  assert.equal(resumed.current_execution_name, nextInitial.execution_name);
  assert.notEqual(resumed.lease_owner, original.lease_owner);
  assert.ok(Date.parse(resumed.lease_expires_at) > Date.now());
  assert.equal(resumed.case_input_hash, original.case_input_hash);
  await assert.rejects(first.heartbeat(), /investigation_lease_lost/);
});

test("stale resume CAS never overwrites the winning execution identity or lease", async () => {
  const f = fixture();
  await (await f.load()).begin(initial);
  f.set(runPath, {
    ...decodeFields(f.docs.get(runPath).fields),
    lease_expires_at: "2000-01-01T00:00:00Z",
  });
  const stale = await f.load();
  const originalRequest = f.client.request;
  let winner;
  f.client.request = async (input) => {
    if (
      input.method === "POST" &&
      input.data?.writes?.some(
        (write) =>
          decodeFields(write.update.fields).current_execution_name ===
          "qa-investigator-pipeline-stale2",
      )
    ) {
      winner = {
        ...decodeFields(f.docs.get(runPath).fields),
        lease_owner: "winning-owner",
        lease_expires_at: new Date(Date.now() + 180000).toISOString(),
        current_execution_name: "qa-investigator-pipeline-winner3",
      };
      f.set(runPath, winner);
    }
    return originalRequest(input);
  };
  await assert.rejects(
    stale.begin({
      ...initial,
      execution_name: "qa-investigator-pipeline-stale2",
    }),
    /investigation_storage_unavailable/,
  );
  assert.deepEqual(decodeFields(f.docs.get(runPath).fields), winner);
  assert.equal(winner.execution_name, initial.execution_name);
});

test("execution identity accepts only the pipeline job and cannot be changed by later writes", async () => {
  for (const value of [
    undefined,
    "unknown",
    "qa-other-job-ab123",
    "qa-investigator-pipeline-a/b",
    "qa-investigator-pipeline-" + "x".repeat(64),
  ]) {
    const f = fixture();
    const context = await f.load();
    await assert.rejects(
      context.begin({ ...initial, execution_name: value }),
      /investigation_execution_identity_invalid/,
    );
    assert.equal(f.docs.has(runPath), false);
  }
  const f = fixture();
  const context = await f.load();
  await context.begin(initial);
  const original = decodeFields(f.docs.get(runPath).fields);
  for (const key of ["execution_name", "current_execution_name"]) {
    await assert.rejects(
      context.commit([
        {
          update: {
            name: runPath,
            fields: fields({ [key]: "qa-investigator-pipeline-proposal4" }),
          },
        },
      ]),
      /investigation_invalid_write/,
    );
    assert.deepEqual(decodeFields(f.docs.get(runPath).fields), original);
  }
});

function receiptDocument(context, path = `${runPath}/checkpoints/00000001`) {
  const receipt={snapshot:{run_binding:context.runBinding},result:{accepted:false}};
  receipt.result_sha256=candidateHash(receipt.result);
  const event={phase:'review_session_validated',receipt,receipt_sha256:candidateHash(receipt)};
  return {name:path,fields:fields({phase:event.phase,payload_json:JSON.stringify(event)})};
}
test('private receipt reader follows pagination and binds the current authority',async()=>{
  const f=fixture(),context=await f.load();
  await context.begin(initial);
  const original=f.client.request;
  let pages=0;
  f.client.request=async options=>{
    if(options.url.includes('/checkpoints?')) {
      pages++;
      if(!options.url.includes('pageToken='))return {data:{documents:[],nextPageToken:'next'}};
      return {data:{documents:[receiptDocument(context)]}};
    }
    return original(options);
  };
  const receipts=await context.reviewReceipts();
  assert.equal(pages,2);
  assert.equal(receipts.length,1);
  assert.equal(receipts[0].checkpoint_path,`${runPath}/checkpoints/00000001`);
  assert.equal(context.reviewAuthorityBinding().business_actor_id,'business-actor');
});
test('private receipt reader rejects cross-run documents and changed result hashes',async()=>{
  for(const mode of ['path','hash']) {
    const f=fixture(),context=await f.load();
    await context.begin(initial);
    const original=f.client.request;
    const doc=receiptDocument(context,mode==='path'?`${base}/qa_runs/other/checkpoints/1`:undefined);
    if(mode==='hash') {
      const event=JSON.parse(decodeFields(doc.fields).payload_json);
      event.receipt.result.accepted=true;
      doc.fields=fields({phase:event.phase,payload_json:JSON.stringify(event)});
    }
    f.client.request=async options=>options.url.includes('/checkpoints?')?{data:{documents:[doc]}}:original(options);
    await assert.rejects(context.reviewReceipts(),/receipt_invalid/);
  }
});
test('private receipt reader rechecks revocation after reading',async()=>{
  const f=fixture(),context=await f.load();
  await context.begin(initial);
  const original=f.client.request;
  f.client.request=async options=>{
    if(options.url.includes('/checkpoints?')) {
      f.set(`${base}/members/actor`,{status:'DISABLED'});
      return {data:{documents:[receiptDocument(context)]}};
    }
    return original(options);
  };
  await assert.rejects(context.reviewReceipts(),/authority_revoked/);
});

test('yield commit is fenced against terminal, current execution, checkpoint and authority changes',async()=>{
 for(const mode of ['valid','terminal','execution','checkpoint','authority']) {
  const f=fixture(),context=await f.load();await context.begin(initial);
  const value=decodeFields(f.docs.get(runPath).fields);
  value.session_state={state_sha256:'s'};
  if(mode==='terminal')value.status='completed';
  if(mode==='execution')value.current_execution_name='other';
  f.set(runPath,value);
  if(mode==='authority')f.set(`${base}/members/actor`,{status:'DISABLED'});
  const changes={status:'running',execution_yield_reason:'execution_deadline',execution_yield_execution:initial.execution_name,
    execution_yield_checkpoint_sha256:mode==='checkpoint'?'other':'s',execution_yield_pending_sha256:null};
  const operation=context.commit([{update:{name:runPath,fields:fields(changes)}}]);
  if(mode==='valid') {await operation;assert.equal(decodeFields(f.docs.get(runPath).fields).status,'running');}
  else await assert.rejects(operation,/yield_state_invalid|authority_revoked/);
 }
});
test('begin preserves terminal failed runs instead of implicitly reopening them',async()=>{
 const f=fixture(),first=await f.load();await first.begin(initial);
 const previous=decodeFields(f.docs.get(runPath).fields);
 f.set(runPath,{...previous,status:'failed',lease_owner:null,lease_expires_at:null,error_code:'previous_failure'});
 const next=await f.load();assert.equal((await next.begin({...initial,execution_name:'qa-investigator-pipeline-next1'})).skip,true);
 assert.equal(decodeFields(f.docs.get(runPath).fields).error_code,'previous_failure');
});

test('MCP receipt uses current lease and verifies persisted compact record', async () => {
  const f = fixture(), context = await f.load();
  await context.begin(initial);
  const original = { source: 'query_logs', status: 'available', observed_at: '2026-10-14T00:00:00Z', evidence_id: `ev_${'a'.repeat(64)}`, rows: ['private raw content'] };
  const hash = 'b'.repeat(64);
  const transportBody = { source: 'mcp_query_logs', status: 'available', observed_at: '2026-10-14T00:00:00Z', remote_tool: 'query_logs', run_binding: context.runBinding, server_id: 'mysc', schema_sha256: hash,
    scope_sha256: hash, arguments_sha256: hash,
    result: { structuredContent: original, _meta: { 'mysc/authority_binding': hash, 'mysc/payload_sha256': candidateHash(original), 'mysc/input_schema_sha256': hash } } };
  const transportHash = candidateHash(transportBody);
  const transport = { ...transportBody, content_hash: transportHash, evidence_id: `ev_${transportHash}` };
  const input = { runBinding: context.runBinding, source: original.source, evidenceId: original.evidence_id,
    payloadSha256: candidateHash(original), transportEvidence: transport };
  const receipt = await context.recordMcpReceipt(input);
  const saved = decodeFields(f.docs.get(`${runPath}/checkpoints/${receipt.receipt_id}`).fields);
  assert.equal(saved.payload_sha256, candidateHash(original));
  assert.equal(JSON.stringify(saved).includes('private raw content'), false);
  assert.deepEqual(await context.recordMcpReceipt(input), receipt);
  await assert.rejects(context.recordMcpReceipt({ ...input, runBinding: { ...context.runBinding, aggregate_version: 9 } }), /receipt_invalid/);
  const read = f.client.request;
  f.client.request = async input => {
    const result = await read(input);
    if (input.url.includes('/checkpoints/mcp_') && !input.url.includes('transaction=') && (!input.method || input.method === 'GET')) {
      return { data: { ...result.data, fields: fields({ ...decodeFields(result.data.fields), payload_sha256: 'f'.repeat(64) }) } };
    }
    return result;
  };
  await assert.rejects(context.recordMcpReceipt(input), /receipt_not_persisted/);
  f.client.request = read;
  const receiptPath = `${runPath}/checkpoints/${receipt.receipt_id}`;
  const corrupted = { ...decodeFields(f.docs.get(receiptPath).fields), payload_sha256: 'e'.repeat(64) };
  f.set(receiptPath, corrupted);
  const versionBefore = f.docs.get(receiptPath).updateTime;
  await assert.rejects(context.recordMcpReceipt(input), /receipt_collision/);
  assert.deepEqual(decodeFields(f.docs.get(receiptPath).fields), corrupted);
  assert.equal(f.docs.get(receiptPath).updateTime, versionBefore);
  f.set(runPath, { ...decodeFields(f.docs.get(runPath).fields), lease_owner: 'another-worker' });
  await assert.rejects(context.recordMcpReceipt(input), /lease_lost/);
});
