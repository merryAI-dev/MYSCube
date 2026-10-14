import {
  createHmac,
  timingSafeEqual,
  createHash,
  randomUUID,
} from 'node:crypto';
import express from 'express';
import { requireQaProjectGrant, qaPlatformScope } from './qa-scope.mjs';
const id = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const reject = (code) => {
  throw Object.assign(new Error(code), { code });
};
export function verifySlackEnvelope({
  rawBody,
  timestamp,
  signature,
  signingSecret,
  nowMs = Date.now(),
}) {
  if (
    !Buffer.isBuffer(rawBody) ||
    rawBody.length > 65536 ||
    typeof signingSecret !== 'string' ||
    !signingSecret ||
    !/^\d{10}$/.test(timestamp || '') ||
    Math.abs(nowMs - Number(timestamp) * 1000) > 300000 ||
    !/^v0=[a-f0-9]{64}$/.test(signature || '')
  )
    reject('slack_signature_invalid');
  const expected =
    'v0=' +
    createHmac('sha256', signingSecret)
      .update(`v0:${timestamp}:`)
      .update(rawBody)
      .digest('hex');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature)))
    reject('slack_signature_invalid');
  let body;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    reject('slack_body_invalid');
  }
  return body;
}
export function createQaSlackIngress({
  db,
  tenantId,
  teamId,
  allowedChannels,
  now = () => new Date().toISOString(),
}) {
  if (
    !id(tenantId) ||
    !/^T[A-Z0-9]+$/.test(teamId) ||
    !Array.isArray(allowedChannels) ||
    !allowedChannels.length ||
    allowedChannels.some((c) => !/^C[A-Z0-9]+$/.test(c))
  )
    throw Error('slack_config_invalid');
  // Caller must use acceptSigned; there is deliberately no public parsed-event entrypoint.
  return {
    async acceptSigned({ rawBody, timestamp, signature, signingSecret }) {
      const body = verifySlackEnvelope({
        rawBody,
        timestamp,
        signature,
        signingSecret,
        nowMs: Date.parse(now()),
      });
      if (body.type === 'url_verification') {
        if (body.team_id && body.team_id !== teamId)
          reject('slack_scope_invalid');
        if (typeof body.challenge !== 'string' || body.challenge.length > 200)
          reject('slack_body_invalid');
        return { challenge: body.challenge };
      }
      if (
        body.type !== 'event_callback' ||
        body.team_id !== teamId ||
        !/^Ev[A-Za-z0-9]+$/.test(body.event_id || '')
      )
        reject('slack_scope_invalid');
      const e = body.event;
      if (!e || !allowedChannels.includes(e.channel))
        reject('slack_scope_invalid');
      if (
        e.type !== 'message' ||
        e.subtype ||
        e.bot_id ||
        e.bot_profile ||
        !/^U[A-Z0-9]+$/.test(e.user || '')
      )
        return { ignored: true };
      if (
        typeof e.text !== 'string' ||
        !e.text.trim() ||
        e.text.length > 4000 ||
        !/^\d{10}\.\d{6}$/.test(e.ts || '') ||
        (e.thread_ts && !/^\d{10}\.\d{6}$/.test(e.thread_ts))
      )
        reject('slack_body_invalid');
      const base = `orgs/${tenantId}`,
        caseId = randomUUID(),
        eventId = randomUUID();
      const fingerprint = createHash('sha256')
        .update(JSON.stringify({ team: body.team_id, event: e }))
        .digest('hex');
      return db.runTransaction(async (tx) => {
        const binding = (
          await tx.get(db.doc(`${base}/qa_slack_bindings/${teamId}_${e.user}`))
        ).data();
        if (
          !binding ||
          binding.status !== 'ACTIVE' ||
          binding.team_id !== teamId ||
          binding.user_id !== e.user ||
          !id(binding.actor_id) ||
          binding.platform_key !== 'myscube' ||
          !Array.isArray(binding.allowed_channel_ids) ||
          !binding.allowed_channel_ids.includes(e.channel) ||
          !Array.isArray(binding.allowed_project_ids) ||
          binding.allowed_project_ids.some((p) => !/^p[0-9]{10,20}$/.test(p))
        )
          reject('slack_binding_required');
        const member = (
          await tx.get(db.doc(`${base}/members/${binding.actor_id}`))
        ).data();
        if (member?.status !== 'ACTIVE') reject('member_inactive');
        const link = (await tx.get(db.doc(`${base}/qa_actor_business_links/${binding.actor_id}`))).data();
        if (!link || link.status !== 'ACTIVE' || link.qa_actor_id !== binding.actor_id
          || link.source !== 'dual_firebase_tokens' || !id(link.business_actor_id)) reject('slack_identity_link_required');
        const scope = (
          await tx.get(
            db.doc(`${base}/qa_slack_channel_scopes/${teamId}_${e.channel}`)
          )
        ).data();
        const selected =
          scope?.status === 'ACTIVE' &&
          scope.team_id === teamId &&
          scope.channel_id === e.channel &&
          scope.platform_key === 'myscube'
            ? scope.project_ids
            : null;
        const platformScope = scope?.status === 'ACTIVE' && scope.team_id === teamId
          && scope.channel_id === e.channel && scope.platform_key === 'myscube'
          && scope.scope_kind === 'platform' && Array.isArray(scope.project_ids)
          && scope.project_ids.length === 0
          && Array.isArray(binding.allowed_scope_kinds) && binding.allowed_scope_kinds.includes('platform');
        const scoped =
          (!scope?.scope_kind || scope.scope_kind === 'project') &&
          Array.isArray(selected) &&
          selected.length > 0 &&
          selected.every(
            (p) =>
              /^p[0-9]{10,20}$/.test(p) &&
              binding.allowed_project_ids.includes(p)
          );
        // A channel and Slack-user binding select projects; the business ACL
        // projection authorizes each one separately.
        const grants = [];
        if (scoped) for (const p of selected) {
          try {
            grants.push(await requireQaProjectGrant(tx, db, { tenantId, actorId: binding.actor_id,
              projectId: p, at: now() }));
          } catch { reject('slack_project_scope_invalid'); }
        }
        const dedup = db.doc(
          `${base}/qa_slack_events/${teamId}_${body.event_id}`
        );
        const old = (await tx.get(dedup)).data();
        if (old) {
          if (old.fingerprint !== fingerprint) reject('slack_event_conflict');
          return { case_id: old.case_id, replayed: true };
        }
        const at = now(),
          source = {
            type: 'slack',
            team_id: teamId,
            channel_id: e.channel,
            thread_ts: e.thread_ts || e.ts,
            user_id: e.user,
          };
        const value = {
          case_id: caseId,
          workspace_id: tenantId,
          actor_id: binding.actor_id,
          platform_key: 'myscube',
          title: e.text.trim().slice(0, 160),
          description: e.text.trim(),
          reported_context: {},
          case_type: 'bug',
          case_status: scoped || platformScope ? 'received' : 'awaiting_scope',
          execution_status: scoped || platformScope ? 'queued' : 'awaiting_scope',
          investigation_event_id: eventId,
          aggregate_version: 1,
          correlation_status: 'unverified',
          visibility: 'private',
          source,
          investigation_scope: platformScope ? qaPlatformScope(tenantId) : scoped
            ? {
                authority: 'server_binding',
                tenant_id: tenantId,
                scope_kind: 'project',
                project_ids: [...new Set(selected)],
                grant_source_revisions: Object.fromEntries(selected.map((p, i) => [p, grants[i].source_revision])),
              }
            : null,
          created_at: at,
          updated_at: at,
        };
        tx.create(db.doc(`${base}/qa_cases/${caseId}`), value);
        tx.create(db.doc(`${base}/qa_cases/${caseId}/activity/0000000001`), {
          schema_version: 1,
          activity_id: '0000000001',
          activity_type: 'case_received',
          case_id: caseId,
          aggregate_version: 1,
          event_id: eventId,
          occurred_at: at,
          case_status: value.case_status,
          execution_status: value.execution_status,
        });
        // Scope-unknown cases remain queued for resolution; consumers must not investigate them.
        tx.create(db.doc(`${base}/qa_kafka_outbox/${eventId}`), {
          event_id: eventId,
          schema_version: 1,
          event_type: 'qa.investigation.requested',
          workspace_id: tenantId,
          case_id: caseId,
          aggregate_type: 'qa_case',
          aggregate_id: caseId,
          aggregate_version: 1,
          partition_key: `${tenantId}:${caseId}`,
          occurred_at: at,
          delivery_status: 'intent_saved',
          attempt_count: 0,
        });
        tx.create(dedup, { case_id: caseId, fingerprint, received_at: at });
        return { case_id: caseId, replayed: false, awaiting_scope: !(scoped || platformScope) };
      });
    },
  };
}

export function mountQaSlackIngressRoute(app, { ingress, signingSecret, path = '/hooks/slack/events' }) {
  if (typeof signingSecret !== 'string' || !signingSecret) throw Error('slack_signing_secret_required');
  app.post(path, express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      const result = await ingress.acceptSigned({ rawBody: req.body,
        timestamp: req.header('x-slack-request-timestamp'),
        signature: req.header('x-slack-signature'), signingSecret });
      res.status(200).json(result.challenge ? { challenge: result.challenge } : { ok: true });
    } catch (error) {
      const code = error?.code || error?.message;
      const status = new Map(Object.entries({slack_signature_invalid:401, slack_body_invalid:400,
        slack_scope_invalid:403, slack_binding_required:403, slack_identity_link_required:403,
        slack_project_scope_invalid:403, member_inactive:403, slack_event_conflict:409})).get(code) || 503;
      res.status(status).json({error:status === 503 ? 'slack_ingress_unavailable'
        : code === 'member_inactive' ? 'slack_ingress_rejected' : code});
    }
  });
}
