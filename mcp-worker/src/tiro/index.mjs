import { noteSaverFrom } from '../ema/note-save.mjs';
import { composerFrom, noteGuidFromEvent, processNote, runOnce, tiroClientFrom, verifyWebhook } from './autosave.mjs';

// Tiro 회의록 자동 저장 Worker(tiro-autosave.myscguard.app). 사람 개입 없이 돈다.
// - 크론(10분): 최근 3일 끝난 노트를 훑어 아직 안 올린 것과 요약이 바뀐 것을 팀 드라이브에 저장한다. 웹훅이 빠져도 이것이 받친다.
// - POST /tiro/webhook: Tiro 웹훅(note_summary.generated 등)을 받으면 그 노트를 바로 처리한다.
// - GET /healthz: 설정 상태(비밀값 유무만)와 마지막 크론 결과.

function depsFrom(env) {
  const missing = ['TIRO_API_KEY', 'ANTHROPIC_API_KEY', 'NOTES_SAVE_URL'].filter((name) => !env[name]);
  if (missing.length) throw new Error(`설정이 빠졌습니다: ${missing.join(', ')}`);
  return {
    tiro: tiroClientFrom({ apiKey: env.TIRO_API_KEY }),
    compose: composerFrom({ apiKey: env.ANTHROPIC_API_KEY, model: env.ANTHROPIC_MODEL || undefined }),
    saveNote: noteSaverFrom(env),
    kv: env.STATE_KV,
    scope: env.TIRO_SCOPE === 'organization' ? 'organization' : 'workspace',
    skipPattern: env.TIRO_SKIP_PATTERN ?? undefined,
  };
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (pathname === '/healthz' && request.method === 'GET') {
      return json({
        service: 'myscube-tiro-autosave',
        configured: { tiro: Boolean(env.TIRO_API_KEY), claude: Boolean(env.ANTHROPIC_API_KEY), drive: Boolean(env.NOTES_SAVE_URL), webhook: Boolean(env.TIRO_WEBHOOK_SECRET) },
        lastRun: JSON.parse((await env.STATE_KV.get('tiro:last-run')) || 'null'),
      });
    }
    if (pathname === '/tiro/webhook' && request.method === 'POST') {
      const rawBody = await request.text();
      const verified = await verifyWebhook({
        secret: env.TIRO_WEBHOOK_SECRET, rawBody,
        authorization: request.headers.get('authorization'), signature: request.headers.get('x-tiro-signature'),
      });
      if (!verified) return json({ ok: false }, 401);
      let event = null;
      try { event = JSON.parse(rawBody); } catch { return json({ ok: false, error: 'bad_request' }, 400); }
      const guid = noteGuidFromEvent(event);
      if (!guid) return json({ ok: true, ignored: true });
      // Tiro는 60초 안에 2xx를 기다린다. 처리는 응답 뒤에 이어서 한다. 실패해도 다음 크론이 다시 잡는다.
      ctx.waitUntil((async () => {
        const deps = depsFrom(env);
        const note = await deps.tiro.getNote(guid);
        if (!note) return;
        const result = await processNote(note, deps);
        console.log(JSON.stringify({ event: 'tiro_autosave_webhook', type: event.type, ...result }));
      })().catch((error) => console.error(JSON.stringify({ event: 'tiro_autosave_webhook_error', guid, error: error.message }))));
      return json({ ok: true });
    }
    return new Response('Not found', { status: 404 });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const report = await runOnce({ ...depsFrom(env), log: console.log });
      const { results, ...summary } = report;
      await env.STATE_KV.put('tiro:last-run', JSON.stringify({
        at: new Date().toISOString(), ...summary,
        saved: results.filter((r) => ['saved', 'updated'].includes(r.status)).map(({ fileName, url }) => ({ fileName, url })),
        errors: results.filter((r) => r.status === 'error').map(({ guid, error }) => ({ guid, error })),
      }));
    })().catch(async (error) => {
      console.error(JSON.stringify({ event: 'tiro_autosave_run_error', error: error.message }));
      await env.STATE_KV.put('tiro:last-run', JSON.stringify({ at: new Date().toISOString(), error: error.message }));
    }));
  },
};
