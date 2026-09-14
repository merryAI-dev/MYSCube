import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function verifySlackRequest({ body, timestamp, signature, secret, now = Date.now() }) {
  if (!secret || !Buffer.isBuffer(body) || !/^\d+$/.test(timestamp || '')
    || Math.abs(now / 1000 - Number(timestamp)) > 300
    || !/^v0=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createSlackIngress({ db, secret, teamId, channelId = 'C0BQ6980HR6', now = () => Date.now() }) {
  if (!teamId || !secret) throw new Error('Slack workspace and signing secret are required');
  return async function ingest(req, res) {
    if (!verifySlackRequest({ body: req.body, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), secret, now: now() })) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }
    if (payload.type === 'url_verification') return res.json({ challenge: payload.challenge });
    if (payload.team_id !== teamId) return res.status(403).json({ error: 'workspace_not_allowed' });
    const event = payload.event;
    if (payload.type !== 'event_callback' || event?.type !== 'app_mention' || event.bot_id || event.subtype
      || event.channel !== channelId) return res.json({ ok: true, ignored: true });
    if (!/^[UW][A-Z0-9]+$/.test(event.user || '') || typeof payload.event_id !== 'string'
      || typeof event.text !== 'string' || event.text.length > 8000) return res.status(400).json({ error: 'invalid_event' });
    const key = createHash('sha256').update(`${teamId}:${payload.event_id}`).digest('hex');
    try {
      await db.doc(`settlement_agent_jobs/${key}`).create({
        teamId, channelId, slackUserId: event.user, eventId: payload.event_id,
        threadTs: event.thread_ts || event.ts, question: event.text,
        status: 'queued', createdAt: new Date(now()).toISOString(), attempts: 0,
      });
    } catch (error) {
      if (error?.code !== 6 && error?.code !== 'already-exists') return res.status(503).json({ error: 'queue_unavailable' });
    }
    return res.json({ ok: true });
  };
}
