import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {
  createQaSlackIngress,
  mountQaSlackIngressRoute,
  verifySlackEnvelope,
} from './qa-slack-ingress.mjs';
const now = '2026-10-12T08:00:00Z',
  timestamp = String(Date.parse(now) / 1000),
  secret = 'synthetic-test';
const payload = () => ({
  type: 'event_callback',
  team_id: 'TABC',
  event_id: 'EvABC',
  event: {
    type: 'message',
    user: 'UABC',
    channel: 'CABC',
    ts: '1791792000.000001',
    text: '현금흐름 확인',
  },
});
function sign(p) {
  const rawBody = Buffer.from(JSON.stringify(p));
  return {
    rawBody,
    timestamp,
    signature:
      'v0=' +
      createHmac('sha256', secret)
        .update(`v0:${timestamp}:`)
        .update(rawBody)
        .digest('hex'),
    signingSecret: secret,
  };
}
function harness() {
  const docs = new Map([
    [
      'orgs/mysc/qa_slack_bindings/TABC_UABC',
      {
        status: 'ACTIVE',
        team_id: 'TABC',
        user_id: 'UABC',
        actor_id: 'actor',
        platform_key: 'myscube',
        allowed_channel_ids: ['CABC'],
        allowed_project_ids: ['p1779092105308'],
      },
    ],
    ['orgs/mysc/members/actor', { status: 'ACTIVE' }],
    ['orgs/mysc/qa_actor_business_links/actor', { status: 'ACTIVE', qa_actor_id: 'actor', business_actor_id: 'business-actor', source: 'dual_firebase_tokens' }],
    [
      'orgs/mysc/qa_slack_channel_scopes/TABC_CABC',
      {
        status: 'ACTIVE',
        team_id: 'TABC',
        channel_id: 'CABC',
        platform_key: 'myscube',
        project_ids: ['p1779092105308'],
      },
    ],
    ['orgs/mysc/projects/p1779092105308', { id: 'p1779092105308' }],
    ['orgs/mysc/qa_project_grants/actor_p1779092105308', {
      status: 'ACTIVE', actor_id: 'actor', project_id: 'p1779092105308',
      source_system: 'myscube_business_acl', source_revision: 'revision-1',
      expires_at: '2026-10-12T08:04:00Z', revoked_at: null,
    }],
  ]);
  const db = {
    doc: (path) => ({ path }),
    runTransaction: async (fn) => {
      const writes = [];
      const result = await fn({
        get: async (r) => ({ data: () => docs.get(r.path) }),
        create: (r, v) => {
          assert.equal(docs.has(r.path), false);
          writes.push([r.path, v]);
        },
      });
      for (const [k, v] of writes) docs.set(k, v);
      return result;
    },
  };
  return {
    docs,
    service: createQaSlackIngress({
      db,
      tenantId: 'mysc',
      teamId: 'TABC',
      allowedChannels: ['CABC'],
      now: () => now,
    }),
  };
}
test('signature verifies exact bytes and rejects stale or altered body', () => {
  const s = sign(payload());
  assert.equal(
    verifySlackEnvelope({ ...s, nowMs: Date.parse(now) }).team_id,
    'TABC'
  );
  assert.throws(() =>
    verifySlackEnvelope({ ...s, nowMs: Date.parse(now) + 300001 })
  );
  assert.throws(() =>
    verifySlackEnvelope({
      ...s,
      rawBody: Buffer.from('{}'),
      nowMs: Date.parse(now),
    })
  );
});
test('same Slack event atomically creates four records and replays once', async () => {
  const { docs, service } = harness();
  const a = await service.acceptSigned(sign(payload()));
  const b = await service.acceptSigned(sign(payload()));
  assert.equal(a.case_id, b.case_id);
  assert.equal(b.replayed, true);
  assert.equal(docs.size, 10);
});
test('bot and edit ignored; wrong channel rejected', async () => {
  const { service, docs } = harness();
  const p = payload();
  p.event.bot_id = 'BABC';
  assert.equal((await service.acceptSigned(sign(p))).ignored, true);
  assert.equal(docs.size, 6);
  delete p.event.bot_id;
  p.event.subtype = 'message_changed';
  assert.equal((await service.acceptSigned(sign(p))).ignored, true);
  p.event.channel = 'COTHER';
  await assert.rejects(service.acceptSigned(sign(p)), /slack_scope_invalid/);
});
test('missing project selection stays awaiting_scope without broadening', async () => {
  const { docs, service } = harness();
  docs.delete('orgs/mysc/qa_slack_channel_scopes/TABC_CABC');
  const a = await service.acceptSigned(sign(payload()));
  const item = docs.get(`orgs/mysc/qa_cases/${a.case_id}`);
  assert.equal(item.case_status, 'awaiting_scope');
  assert.equal(item.investigation_scope, null);
});
test('revoked binding or member cannot replay', async () => {
  const { docs, service } = harness();
  await service.acceptSigned(sign(payload()));
  docs.set('orgs/mysc/members/actor', { status: 'REVOKED' });
  await assert.rejects(
    service.acceptSigned(sign(payload())),
    /member_inactive/
  );
});
test('revoked project grant blocks scoped Slack intake', async () => {
  const { docs, service } = harness();
  docs.get('orgs/mysc/qa_project_grants/actor_p1779092105308').status = 'REVOKED';
  await assert.rejects(service.acceptSigned(sign(payload())), /slack_project_scope_invalid/);
});
test('signed HTTP route reads exact raw bytes before JSON parsing', async () => {
  const { service } = harness();
  const app = express();
  mountQaSlackIngressRoute(app, { ingress: service, signingSecret: secret });
  const signed = sign(payload());
  const ok = await request(app).post('/hooks/slack/events').set({
    'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signed.signature,
  }).send(signed.rawBody.toString('utf8'));
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body, { ok: true });
  const bad = await request(app).post('/hooks/slack/events').set({
    'content-type': 'application/json', 'x-slack-request-timestamp': timestamp,
    'x-slack-signature': signed.signature,
  }).send(JSON.stringify({ ...payload(), event_id: 'EvALTERED' }));
  assert.equal(bad.status, 401);
});


test('explicitly authorized platform channel queues a bound investigation without a project grant', async () => {
  const {docs,service}=harness();
  docs.get('orgs/mysc/qa_slack_bindings/TABC_UABC').allowed_scope_kinds=['platform'];
  Object.assign(docs.get('orgs/mysc/qa_slack_channel_scopes/TABC_CABC'),{scope_kind:'platform',project_ids:[]});
  docs.delete('orgs/mysc/qa_project_grants/actor_p1779092105308');
  const result=await service.acceptSigned(sign(payload()));
  const item=docs.get(`orgs/mysc/qa_cases/${result.case_id}`);
  assert.equal(item.case_status,'received');assert.equal(item.execution_status,'queued');
  assert.deepEqual(item.investigation_scope,{authority:'server_binding',tenant_id:'mysc',scope_kind:'platform',project_ids:[]});
  assert.equal(docs.get(`orgs/mysc/qa_kafka_outbox/${item.investigation_event_id}`).case_id,result.case_id);
});
test('platform channel alone cannot expand a Slack user scope', async () => {
  const {docs,service}=harness();
  Object.assign(docs.get('orgs/mysc/qa_slack_channel_scopes/TABC_CABC'),{scope_kind:'platform',project_ids:[]});
  const result=await service.acceptSigned(sign(payload()));
  assert.equal(docs.get(`orgs/mysc/qa_cases/${result.case_id}`).investigation_scope,null);
  assert.equal(result.awaiting_scope,true);
});
test('revoked business link denies new intake and replay without additional writes', async () => {
  const {docs,service}=harness();await service.acceptSigned(sign(payload()));
  docs.get('orgs/mysc/qa_actor_business_links/actor').status='REVOKED';
  const size=docs.size;
  await assert.rejects(service.acceptSigned(sign(payload())),/slack_identity_link_required/);
  const next=payload();next.event_id='EvNEW';
  await assert.rejects(service.acceptSigned(sign(next)),/slack_identity_link_required/);
  assert.equal(docs.size,size);
});


test('platform declaration with project IDs cannot silently become project scope', async () => {
  const {docs,service}=harness();
  docs.get('orgs/mysc/qa_slack_bindings/TABC_UABC').allowed_scope_kinds=['platform'];
  docs.get('orgs/mysc/qa_slack_channel_scopes/TABC_CABC').scope_kind='platform';
  const result=await service.acceptSigned(sign(payload()));
  assert.equal(result.awaiting_scope,true);
  assert.equal(docs.get(`orgs/mysc/qa_cases/${result.case_id}`).investigation_scope,null);
});
test('project intake retains grant revisions and the same event on redelivery', async () => {
  const {docs,service}=harness();const a=await service.acceptSigned(sign(payload()));
  const item=docs.get(`orgs/mysc/qa_cases/${a.case_id}`),event=item.investigation_event_id;
  assert.equal(item.case_status,'received');
  assert.deepEqual(item.investigation_scope.grant_source_revisions,{'p1779092105308':'revision-1'});
  await service.acceptSigned(sign(payload()));
  assert.equal(docs.get(`orgs/mysc/qa_cases/${a.case_id}`).investigation_event_id,event);
  assert.equal([...docs.keys()].filter(key=>key.includes('/qa_kafka_outbox/')).length,1);
});


test('incomplete business identity cannot create a queued Slack case', async () => {
  for(const business_actor_id of [undefined,'','bad/path']) {
    const {docs,service}=harness(),size=docs.size;
    docs.get('orgs/mysc/qa_actor_business_links/actor').business_actor_id=business_actor_id;
    await assert.rejects(service.acceptSigned(sign(payload())),/slack_identity_link_required/);
    assert.equal(docs.size,size);
  }
});

test('transient ingress failure returns sanitized 503 and subsequent delivery succeeds once', async () => {
  const {docs,service}=harness();let fail=true;
  const app=express();mountQaSlackIngressRoute(app,{signingSecret:secret,ingress:{acceptSigned:async args=>{
    const result=await service.acceptSigned(args);
    if(fail){fail=false;throw Error('PRIVATE database response lost');}return result;
  }}});
  const s=sign(payload());const send=()=>request(app).post('/hooks/slack/events').set({
    'content-type':'application/json','x-slack-request-timestamp':timestamp,'x-slack-signature':s.signature,
  }).send(s.rawBody.toString('utf8'));
  const failed=await send();assert.equal(failed.status,503);assert.deepEqual(failed.body,{error:'slack_ingress_unavailable'});
  const retried=await send();assert.equal(retried.status,200);
  assert.equal([...docs.keys()].filter(key=>key.includes('/qa_kafka_outbox/')).length,1);
});
