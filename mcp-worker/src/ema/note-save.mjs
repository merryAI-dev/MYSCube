import { escape, page } from './files.mjs';

// 회의록 저장. 저장 위치는 명시적으로 고른다.
// - drive: 팀 드라이브 전사 회의록 폴더. 폴더 소유 계정의 Apps Script 웹 앱이 쓰고, 이 Worker 는 내용만 넘긴다.
// - ema_draft: EMA 보고서 초안함(saveMeetingDraft). 오피스아워 원장에는 쓰지 않는다.
// ChatGPT처럼 대화 안 쓰기가 막히면 저장 링크 화면의 버튼으로 같은 저장을 한다.
const NOTE_TTL_SECONDS = 24 * 60 * 60;
const MAX_DRAFT_TEXT = 60_000;
export const DESTINATIONS = ['drive', 'ema_draft', 'both'];
const LABELS = { drive: '팀 드라이브', ema_draft: 'EMA 보고서 초안함' };

const randomToken = () => {
  const raw = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...raw)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export function createNoteStore(kv) {
  return {
    async put(uid, note) {
      const token = randomToken();
      await kv.put(`ema:note:${token}`, JSON.stringify({ uid, ...note }), { expirationTtl: NOTE_TTL_SECONDS });
      return token;
    },
    async get(token) {
      if (!/^[A-Za-z0-9_-]{20,80}$/u.test(token)) return null;
      const raw = await kv.get(`ema:note:${token}`);
      return raw ? JSON.parse(raw) : null;
    },
  };
}

export function noteSaverFrom(env, fetchImpl = fetch) {
  if (!env.NOTES_SAVE_URL) return null;
  return async ({ fileName, markdown, sourceRef }) => {
    const response = await fetchImpl(env.NOTES_SAVE_URL, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileName, markdown, sourceRef: sourceRef || '' }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || !body?.ok) throw new Error('팀 드라이브에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return { fileId: body.fileId, url: body.url, name: body.name, updated: body.updated === true };
  };
}

export const NOT_CONFIGURED = '팀 드라이브 저장이 아직 연결되지 않았습니다(관리자 설정 필요). 마크다운을 내려받아 폴더에 직접 올려 주세요.';

// 저장 링크 화면에서 EMA 초안함 저장이 가능한지(로그인 증명이 아직 유효한지).
export function canSaveDraft(note, nowMs = Date.now()) {
  return Boolean(note.idToken) && Number(note.idTokenExpiresAt) > nowMs + 60_000;
}

async function saveDraft(ema, note) {
  const text = note.markdown.slice(0, MAX_DRAFT_TEXT);
  const { draft } = await ema.call('draftMeetingRecordFromFile', { text });
  const saved = await ema.call('saveMeetingDraft', {
    source: note.source || 'manual', sourceRef: note.sourceRef || '', title: note.title || draft.topic,
    meetingDate: note.date, rawText: text, draft,
  });
  return { draftId: saved.id, updated: saved.replaced === true, expiresAt: saved.expiresAt,
    next: 'EMA 화면의 "회의록 추가 → 초안 불러오기"에서 확정하세요.' };
}

// 각 위치를 따로 시도하고 결과를 위치별로 돌려준다. 한쪽이 실패해도 다른 쪽 결과는 남긴다.
export async function saveToDestinations({ note, destination, saveNote, ema }) {
  if (!DESTINATIONS.includes(destination)) throw new Error('저장 위치는 drive, ema_draft, both 중 하나입니다.');
  const targets = destination === 'both' ? ['drive', 'ema_draft'] : [destination];
  const results = {};
  for (const target of targets) {
    try {
      if (target === 'drive') {
        if (!saveNote) throw new Error(NOT_CONFIGURED);
        results.drive = { ok: true, ...(await saveNote(note)) };
      } else {
        if (!ema) throw new Error('EMA 보고서 초안함은 EMA 관리자·컨설턴트 계정으로 연결했을 때만 쓸 수 있습니다.');
        results.ema_draft = { ok: true, ...(await saveDraft(ema, note)) };
      }
    } catch (error) {
      results[target] = { ok: false, error: error instanceof Error && error.message ? error.message : `${LABELS[target]} 저장에 실패했습니다.` };
    }
  }
  return { destination, results, allSaved: Object.values(results).every((result) => result.ok) };
}

function resultHtml(results) {
  return Object.entries(results).map(([target, result]) => result.ok
    ? `<li><strong>${LABELS[target]}</strong>: ${result.updated ? '기존 것을 갱신했습니다' : '저장했습니다'}${result.url ? ` — <a href="${escape(result.url)}" target="_blank" rel="noopener">${escape(result.name)}</a>` : ''}${target === 'ema_draft' ? ' (EMA 화면 "회의록 추가 → 초안 불러오기"에서 확정)' : ''}</li>`
    : `<li><strong>${LABELS[target]}</strong>: 실패 — ${escape(result.error)}</li>`).join('');
}

// 저장 링크 화면. GET 은 미리보기와 저장 위치 버튼, POST(destination)를 눌러야 저장한다. ?download=1 은 .md 내려받기.
export async function handleNotePage(request, { notes, token, saveNote, emaFor, nowMs = Date.now() }) {
  const note = await notes.get(token);
  if (!note) return page('회의록 저장', '<h1>링크가 만료됐습니다</h1><p>AI에게 회의록 저장 링크를 다시 요청해 주세요.</p>', 410);
  const url = new URL(request.url);
  if (request.method === 'GET' && url.searchParams.get('download') === '1') {
    const asciiName = note.fileName.replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
    return new Response(note.markdown, { headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(note.fileName)}`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
    } });
  }
  const draftReady = canSaveDraft(note, nowMs) && Boolean(emaFor);
  const download = '<p><a href="?download=1">.md 파일로 내려받기</a></p>';
  const buttons = [
    saveNote ? '<button type="submit" name="destination" value="drive">팀 드라이브에 저장</button>' : '',
    draftReady ? '<button type="submit" name="destination" value="ema_draft">EMA 보고서 초안함에 저장</button>' : '',
    saveNote && draftReady ? '<button type="submit" name="destination" value="both">둘 다 저장</button>' : '',
  ].filter(Boolean).join(' ');
  if (request.method === 'GET') {
    return page('회의록 저장', `<h1>어디에 저장할까요?</h1>
<p><strong>${escape(note.fileName)}</strong></p>
<pre style="white-space:pre-wrap;background:#f8fafc;padding:1rem;border-radius:.5rem;font-size:13px;max-height:24rem;overflow:auto">${escape(note.markdown)}</pre>
${buttons ? `<form method="post"><p>${buttons}</p></form>` : `<p>${escape(NOT_CONFIGURED)}</p>`}${download}
<ul class="muted"><li>팀 드라이브: 전사 회의록 폴더에 .md 파일로 저장합니다.</li><li>EMA 보고서 초안함: 오피스아워 보고서 초안으로 넣습니다. 확정은 EMA 화면에서 합니다.${draftReady ? '' : ' (이 링크에서는 사용할 수 없습니다. AI 대화에서 저장하거나 링크를 다시 받아 주세요.)'}</li><li>같은 회의는 새로 만들지 않고 갱신합니다. 링크는 24시간 뒤 만료됩니다.</li></ul>`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  let destination = '';
  try { destination = String((await request.formData()).get('destination') || ''); } catch { /* 아래에서 거절 */ }
  if (!DESTINATIONS.includes(destination)) return page('회의록 저장', '<h1>저장 위치를 골라 주세요</h1><p><a href="">돌아가기</a></p>', 400);
  const needsDraft = destination !== 'drive';
  const { results, allSaved } = await saveToDestinations({
    note, destination, saveNote,
    ema: needsDraft && draftReady ? emaFor(note.idToken) : null,
  });
  return page('회의록 저장', `<h1>${allSaved ? '저장했습니다' : '일부만 저장했습니다'}</h1><ul>${resultHtml(results)}</ul>
${allSaved ? '<p>이제 AI 대화로 돌아가셔도 됩니다.</p>' : `<form method="post"><p><button type="submit" name="destination" value="${escape(destination)}">다시 시도</button></p></form>${download}`}`, allSaved ? 200 : 502);
}
