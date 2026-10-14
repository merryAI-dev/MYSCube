import { escape, page } from './files.mjs';

// 회의록 마크다운을 팀 드라이브 폴더에 저장한다. 드라이브 쓰기는 폴더 소유 계정의 Apps Script 웹 앱이 하고,
// 이 Worker 는 내용만 넘긴다(폴더는 회사 계정만 접근하는 공유 드라이브). ChatGPT처럼 대화 안 쓰기가 막히면 저장 링크 화면의 버튼으로 저장한다.
const NOTE_TTL_SECONDS = 24 * 60 * 60;

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
    if (!response.ok || !body?.ok) throw new Error('드라이브에 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    return { fileId: body.fileId, url: body.url, name: body.name, updated: body.updated === true };
  };
}

export const NOT_CONFIGURED = '드라이브 저장이 아직 연결되지 않았습니다(관리자 설정 필요). 마크다운을 내려받아 폴더에 직접 올려 주세요.';

// 저장 링크 화면. GET 은 미리보기만, POST 버튼을 눌러야 저장한다. ?download=1 은 .md 파일로 내려받는다.
export async function handleNotePage(request, { notes, token, save }) {
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
  const preview = `<p><strong>${escape(note.fileName)}</strong></p><pre style="white-space:pre-wrap;background:#f8fafc;padding:1rem;border-radius:.5rem;font-size:13px">${escape(note.markdown)}</pre>`;
  const download = `<p><a href="?download=1">.md 파일로 내려받기</a></p>`;
  if (request.method === 'GET') {
    return page('회의록 저장', `<h1>팀 드라이브에 저장할까요?</h1>${preview}
${save ? '<form method="post"><p><button type="submit">드라이브에 저장</button></p></form>' : `<p>${escape(NOT_CONFIGURED)}</p>`}${download}
<p class="muted">같은 파일명이나 같은 원본(sourceRef)이 이미 있으면 새로 만들지 않고 내용을 갱신합니다. 링크는 24시간 뒤 만료됩니다.</p>`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });
  if (!save) return page('회의록 저장', `<h1>저장할 수 없습니다</h1><p>${escape(NOT_CONFIGURED)}</p>${download}`, 503);
  try {
    const saved = await save(note);
    return page('회의록 저장', `<h1>${saved.updated ? '기존 파일을 갱신했습니다' : '저장했습니다'}</h1>
<p><a href="${escape(saved.url)}" target="_blank" rel="noopener">${escape(saved.name)}</a></p><p>이제 AI 대화로 돌아가셔도 됩니다.</p>`);
  } catch (error) {
    return page('회의록 저장', `<h1>저장하지 못했습니다</h1><p>${escape(error.message)}</p><form method="post"><p><button type="submit">다시 시도</button></p></form>${download}`, 502);
  }
}
