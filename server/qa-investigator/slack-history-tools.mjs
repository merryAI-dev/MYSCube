import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
const digest = (v) =>
  createHash('sha256').update(JSON.stringify(v)).digest('hex');
const fail = (code) => {
  throw Object.assign(new Error(code), {
    safeCode: code,
  });
};
const ts = (v) => typeof v === 'string' && /^\d{10}\.\d{6}$/.test(v);
const strict = (a, keys) => {
  if (
    !a ||
    typeof a !== 'object' ||
    Array.isArray(a) ||
    Object.keys(a).some((k) => !keys.includes(k))
  )
    fail('invalid_scope');
};
// Read-only bot history, rather than search.messages (user-token search:read).
export function createSlackHistoryTools({
  policy,
  tokenPath,
  threadUserTokenPath,
  threadUserId,
  authorize,
  fetchImpl = fetch,
}) {
  if (
    !policy ||
    !/^T[A-Z0-9]+$/.test(policy.workspaceId) ||
    !Array.isArray(policy.allowedChannelIds) ||
    !policy.allowedChannelIds.length ||
    policy.allowedChannelIds.some((c) => !/^C[A-Z0-9]+$/.test(c)) ||
    typeof authorize !== 'function' ||
    !['private', 'organization'].includes(policy.runVisibility)
  )
    throw Error('invalid_slack_history_policy');
  const config = structuredClone(policy),
    start = Date.parse(config.startAt),
    end = Date.parse(config.endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw Error('invalid_slack_history_policy');
  const knownThreads = new Set(),
    continuations = new Map();
  const continuationSchema = {
    type: 'string',
    pattern: '^[a-f0-9-]{36}$',
  };
  function continuation(a, kind) {
    if (!a.continuation) return null;
    const c = continuations.get(a.continuation);
    if (
      !c ||
      c.kind !== kind ||
      c.channel !== a.channel_id ||
      (kind === 'search' ? c.query !== a.query : c.thread !== a.thread_ts)
    )
      fail('invalid_scope');
    return c;
  }
  function next(data, scope) {
    const cursor = data.response_metadata?.next_cursor;
    if (!cursor) return null;
    if (typeof cursor !== 'string' || cursor.length > 2000)
      fail('source_invalid_response');
    const token = randomUUID();
    continuations.set(token, {
      ...scope,
      cursor,
    });
    return token;
  }
  async function api(method, params, signal, useThreadUser = false) {
    signal?.throwIfAborted();
    let token;
    try {
      token = (
        await readFile(useThreadUser ? threadUserTokenPath : tokenPath, 'utf8')
      ).trim();
    } catch {
      fail('source_credentials_missing');
    }
    if (!(useThreadUser ? /^xoxp-/ : /^xoxb-/).test(token))
      fail('source_credentials_invalid');
    const r = await fetchImpl(
      `https://slack.com/api/${method}?${new URLSearchParams(params)}`,
      {
        method: 'GET',
        credentials: 'omit',
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(20000)])
          : AbortSignal.timeout(20000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      }
    );
    if (r.status === 429) {
      await r.body?.cancel();
      fail('source_rate_limited');
    }
    if (!r.ok) {
      await r.body?.cancel();
      fail('source_unavailable');
    }
    const reader = r.body?.getReader();
    if (!reader) fail('source_invalid_response');
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1048576) {
          await reader.cancel();
          fail('source_response_too_large');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      fail('source_invalid_response');
    }
    if (!data.ok)
      fail(
        ['missing_scope', 'not_in_channel', 'channel_not_found'].includes(
          data.error
        )
          ? 'source_access_denied'
          : 'source_unavailable'
      );
    return data;
  }
  async function channelAccess(channel, signal, useThreadUser = false) {
    if (!config.allowedChannelIds.includes(channel)) fail('invalid_scope');
    const acl = await authorize();
    if (
      acl?.workspaceId !== config.workspaceId ||
      !acl.allowedChannelIds?.includes(channel)
    )
      fail('source_access_denied');
    const identity = await api('auth.test', {}, signal, useThreadUser);
    if (
      identity.team_id !== config.workspaceId ||
      (useThreadUser && identity.user_id !== threadUserId)
    )
      fail('source_workspace_mismatch');
    const info = (
      await api(
        'conversations.info',
        {
          channel,
        },
        signal,
        useThreadUser
      )
    ).channel;
    if (
      config.runVisibility === 'organization' &&
      acl.organizationSummaryAllowed !== true
    )
      fail('source_access_denied');
    if (
      !info ||
      info.id !== channel ||
      info.is_im ||
      info.is_mpim ||
      info.is_ext_shared ||
      info.is_org_shared ||
      (info.is_private !== false && config.runVisibility === 'organization')
    )
      fail('source_access_denied');
    return {
      private: info.is_private === true,
    };
  }
  function projectMessage(message, channel) {
    if (!ts(message.ts)) return null;
    const raw = typeof message.text === 'string' ? message.text : '';
    const text = raw
      .slice(0, 4000)
      .replace(
        /Bearer\s+\S+|xox[baprs]-\S+|https?:\/\/\S+|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
        '[비공개]'
      )
      .replace(/<@[A-Z0-9]+>/g, '[사용자]');
    const bot = !!message.bot_id || message.subtype === 'bot_message';
    return {
      message_ts: message.ts,
      thread_ts: ts(message.thread_ts) ? message.thread_ts : message.ts,
      source_hash: digest({
        channel,
        message,
      }),
      text,
      edited_at: ts(message.edited?.ts)
        ? new Date(Number(message.edited.ts) * 1000).toISOString()
        : null,
      deleted: message.subtype === 'message_deleted' || message.hidden === true,
      is_bot: bot,
      candidate_role: bot
        ? 'bot_comment'
        : /해결|정상|수정.*완료/.test(text)
          ? 'resolution_claim'
          : /수정|조치|변경/.test(text)
            ? 'action_claim'
            : 'report_or_discussion',
      resolution_verified: false,
      text_truncated: raw.length > 4000,
    };
  }
  function tool(name, description, parameters, execute) {
    return {
      description,
      parameters,
      async execute(a, { signal } = {}) {
        const observed_at = new Date().toISOString();
        try {
          const result = await execute(a, signal);
          signal?.throwIfAborted();
          const content_hash = digest({
            source: name,
            ...result,
          });
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: name,
            status: 'available',
            ...result,
            cause_status: 'not_established',
          };
        } catch (e) {
          signal?.throwIfAborted();
          return {
            evidence_id: `ev_${digest({
              name,
              observed_at,
            })}`,
            observed_at,
            source: name,
            status: 'unavailable',
            error_code: [
              'invalid_scope',
              'source_credentials_missing',
              'source_credentials_invalid',
              'source_rate_limited',
              'source_access_denied',
              'source_workspace_mismatch',
              'source_invalid_response',
              'source_response_too_large',
            ].includes(e.safeCode)
              ? e.safeCode
              : 'source_unavailable',
            rows: [],
            coverage: {
              complete: false,
              snapshot_fallback: false,
            },
            cause_status: 'not_established',
          };
        }
      },
    };
  }
  const channel = {
    type: 'string',
    enum: config.allowedChannelIds,
  };
  const schema = (properties, required) => ({
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  });
  return {
    search_slack_history: tool(
      'search_slack_history',
      'Search literal keywords in a bounded permitted channel history window using a dedicated bot. Partial historical recall, not workspace-wide search. Report/action/resolution labels are candidates; past bot answers are never resolution proof or current-cause proof.',
      schema(
        {
          channel_id: channel,
          query: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
          },
          continuation: continuationSchema,
        },
        ['channel_id', 'query']
      ),
      async (a, signal) => {
        strict(a, ['channel_id', 'query', 'continuation']);
        if (
          typeof a.query !== 'string' ||
          !a.query.trim() ||
          a.query.length > 80 ||
          /[\r\n]/.test(a.query)
        )
          fail('invalid_scope');
        const prior = continuation(a, 'search');
        const access = await channelAccess(a.channel_id, signal);
        const cursor = prior?.cursor || '';
        let scanned = 0;
        const rows = [];
        {
          const data = await api(
            'conversations.history',
            {
              channel: a.channel_id,
              oldest: String(start / 1000),
              latest: String(end / 1000),
              inclusive: 'false',
              limit: '100',
              ...(cursor
                ? {
                    cursor,
                  }
                : {}),
            },
            signal
          );
          if (!Array.isArray(data.messages)) fail('source_invalid_response');
          for (const m of data.messages) {
            scanned++;
            if (
              !ts(m.ts) ||
              Number(m.ts) * 1000 < start ||
              Number(m.ts) * 1000 >= end ||
              typeof m.text !== 'string' ||
              !m.text.toLowerCase().includes(a.query.toLowerCase())
            )
              continue;
            const row = projectMessage(m, a.channel_id);
            if (row) {
              knownThreads.add(`${a.channel_id}:${row.thread_ts}`);
              rows.push(row);
            }
          }
          const next_token = next(data, {
            kind: 'search',
            channel: a.channel_id,
            query: a.query,
          });
          return {
            next_continuation: next_token,
            channel_id: a.channel_id,
            visibility: access.private ? 'private' : 'organization',
            rows,
            coverage: {
              complete: !next_token && data.has_more !== true,
              scope: 'bounded_channel_history_literal_search',
              scanned_messages: scanned,
              matched_messages: rows.length,
              thread_replies_searched: false,
              deleted_history_recoverable: false,
              current_cause_verified: false,
              start_at: config.startAt,
              end_at: config.endAt,
            },
          };
        }
      }
    ),
    read_slack_history_thread: tool(
      'read_slack_history_thread',
      'Read a thread discovered by this run history search. Includes parent/replies with original timestamps, edit/deletion observations and hash. Missing replies, retention or deleted content remain unknown. Human resolution claims need verification; bot comments do not establish resolution.',
      schema(
        {
          channel_id: channel,
          thread_ts: {
            type: 'string',
            pattern: '^\\d{10}\\.\\d{6}$',
          },
          continuation: continuationSchema,
        },
        ['channel_id', 'thread_ts']
      ),
      async (a, signal) => {
        strict(a, ['channel_id', 'thread_ts', 'continuation']);
        if (!knownThreads.has(`${a.channel_id}:${a.thread_ts}`))
          fail('invalid_scope');
        const prior = continuation(a, 'thread');
        const userMode = !!threadUserTokenPath;
        if (userMode && !/^U[A-Z0-9]+$/.test(threadUserId || ''))
          fail('source_credentials_invalid');
        const access = await channelAccess(a.channel_id, signal, userMode);
        const cursor = prior?.cursor || '';
        const rows = [];
        {
          const data = await api(
            'conversations.replies',
            {
              channel: a.channel_id,
              ts: a.thread_ts,
              limit: '100',
              ...(cursor
                ? {
                    cursor,
                  }
                : {}),
            },
            signal,
            userMode
          );
          if (!Array.isArray(data.messages)) fail('source_invalid_response');
          for (const m of data.messages) {
            if (m.thread_ts && m.thread_ts !== a.thread_ts)
              fail('source_invalid_response');
            const row = projectMessage(m, a.channel_id);
            if (row) rows.push(row);
          }
          const next_token = next(data, {
            kind: 'thread',
            channel: a.channel_id,
            thread: a.thread_ts,
          });
          let permalink = null;
          try {
            const link = (
              await api(
                'chat.getPermalink',
                {
                  conversation_id: a.channel_id,
                  message_ts: a.thread_ts,
                },
                signal,
                userMode
              )
            ).permalink;
            if (
              typeof link === 'string' &&
              /^https:\/\/[a-z0-9-]+\.slack\.com\/archives\/C[A-Z0-9]+\/p[0-9]+$/.test(
                link
              ) &&
              new URL(link).pathname.startsWith(`/archives/${a.channel_id}/`)
            )
              permalink = link;
          } catch {
            /* Thread evidence survives missing permalink permission. */
          }
          return {
            next_continuation: next_token,
            auth_mode: userMode
              ? 'explicit_service_user'
              : 'bot_api_access_unverified',
            channel_id: a.channel_id,
            thread_ts: a.thread_ts,
            permalink,
            visibility: access.private ? 'private' : 'organization',
            rows,
            coverage: {
              complete:
                !next_token &&
                data.has_more !== true &&
                rows.every((r) => !r.text_truncated),
              scope: 'observed_thread_at_read_time',
              deleted_history_recoverable: false,
              includes_replies_outside_search_window: true,
              current_cause_verified: false,
              resolution_verified: false,
            },
          };
        }
      }
    ),
  };
}
