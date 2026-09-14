import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export function verifySlackRequest({ body, timestamp, signature, secret, now = Date.now() }) {
  if (!secret || !Buffer.isBuffer(body) || !/^\d+$/.test(timestamp || '')
    || Math.abs(now / 1000 - Number(timestamp)) > 300
    || !/^v0=[a-f0-9]{64}$/.test(signature || '')) return false;
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:`).update(body).digest('hex')}`;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

export function createSlackIngress({ db, secret, teamId, channelId = 'C0BQ6980HR6', botToken, fetchImpl = fetch, now = () => Date.now() }) {
  if (!teamId || !secret) throw new Error('Slack workspace and signing secret are required');
  return async function ingest(req, res) {
    const started = performance.now();
    if (!verifySlackRequest({ body: req.body, timestamp: req.get('x-slack-request-timestamp'), signature: req.get('x-slack-signature'), secret, now: now() })) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    let payload;
    try { payload = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'invalid_json' }); }
    if (payload.type === 'url_verification') return res.json({ challenge: payload.challenge });
    if (payload.team_id !== teamId) return res.status(403).json({ error: 'workspace_not_allowed' });
    const event = payload.event;
    if (payload.type !== 'event_callback' || !['app_mention', 'message'].includes(event?.type) || event.bot_id || event.subtype
      || event.channel !== channelId) return res.json({ ok: true, ignored: true });
    if (!/^[UW][A-Z0-9]+$/.test(event.user || '') || typeof payload.event_id !== 'string'
      || typeof event.text !== 'string' || !event.text.trim() || event.text.length > 8000
      || !/^\d{1,12}\.\d{1,6}$/.test(event.ts || '')
      || (event.thread_ts && !/^\d{1,12}\.\d{1,6}$/.test(event.thread_ts))) return res.status(400).json({ error: 'invalid_event' });
    if (event.type === 'message' && !event.thread_ts) return res.json({ ok: true, ignored: true });
    const threadTs = event.thread_ts || event.ts;
    const key = createHash('sha256').update(`${teamId}:${channelId}:${event.ts}`).digest('hex');
    const conversationId = createHash('sha256').update(`${teamId}:${channelId}:${threadTs}:${event.user}`).digest('hex');
    try {
      const accepted = await db.runTransaction(async (tx) => {
        const jobRef = db.doc(`settlement_agent_jobs/${key}`);
        const conversationRef = db.doc(`settlement_agent_threads/${conversationId}`);
        const [job, stored] = await Promise.all([tx.get(jobRef), tx.get(conversationRef)]);
        if (job.exists) return 'duplicate';
        if (!stored.exists && event.type !== 'app_mention') return false;
        const conversation = stored.data() || { teamId, channelId, slackUserId: event.user, threadTs, turns: [], queue: [] };
        if (conversation.queue.length >= 10) throw new Error('thread_queue_full');
        const queuedAt = Math.max(now(), (conversation.lastQueuedAt || 0) + 1);
        tx.set(conversationRef, { ...conversation, lastQueuedAt: queuedAt, queue: [...conversation.queue, key] });
        tx.create(jobRef, { teamId, channelId, slackUserId: event.user, eventId: payload.event_id,
          conversationId, threadTs, question: event.text,
          status: 'queued', createdAt: new Date(queuedAt).toISOString(), attempts: 0 });
        return 'created';
      });
      const receiptTimeout = Math.min(800, Math.floor(2400 - (performance.now() - started)));
      if (accepted === 'created' && botToken && receiptTimeout > 0) {
        try {
          const receipt = await fetchImpl('https://slack.com/api/chat.postMessage', {
            method: 'POST', headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/json' },
            signal: AbortSignal.timeout(receiptTimeout),
            body: JSON.stringify({ channel: channelId, thread_ts: threadTs,
              text: `안녕하세요 <@${event.user}>님! 요청을 접수했어요. 순서대로 조회해볼게요. 결과는 이곳에 이어서 알려드릴게요.`,
            }),
          });
          if (!receipt.ok || !(await receipt.json()).ok) throw new Error('receipt_failed');
        } catch {
          // The durable job must still run when this best-effort receipt cannot be delivered.
          console.warn('[settlement-agent] receipt_unavailable', key.slice(0, 8));
        }
      }
      return res.json({ ok: true, ...(!accepted ? { ignored: true } : {}) });
    } catch (error) {
      return res.status(503).json({ error: 'queue_unavailable' });
    }
  };
}
