import { readXlsx, XlsxError } from './xlsx.mjs';

// 업로드·다운로드·일괄 등록 배치를 KV 에 잠깐 보관한다. 전부 만료 시각이 있고, 로그인한 구성원(uid)에 묶인다.
const UPLOAD_TTL_SECONDS = 15 * 60;
const FILE_TTL_SECONDS = 15 * 60;
const BATCH_TTL_SECONDS = 24 * 60 * 60;
const CONFIRM_TTL_SECONDS = 15 * 60;
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const KV_VALUE_LIMIT = 24 * 1024 * 1024;

const randomId = (bytes = 24) => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...raw)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export function createStore(kv) {
  return {
    async createUploadLink(uid) {
      const token = randomId(32);
      await kv.put(`ema:upload:${token}`, JSON.stringify({ uid }), { expirationTtl: UPLOAD_TTL_SECONDS });
      return { token, expiresInMinutes: UPLOAD_TTL_SECONDS / 60 };
    },
    async readUpload(token) {
      const raw = await kv.get(`ema:upload:${token}`);
      return raw ? JSON.parse(raw) : null;
    },
    async consumeUpload(token) {
      await kv.delete(`ema:upload:${token}`);
    },
    async saveBatch(batchId, batch) {
      const text = JSON.stringify(batch);
      if (text.length > KV_VALUE_LIMIT) throw new Error('배치가 너무 커서 보관할 수 없습니다. 파일을 나눠 올려 주세요.');
      await kv.put(`ema:batch:${batchId}`, text, { expirationTtl: BATCH_TTL_SECONDS });
    },
    async createBatch(uid, data) {
      const batchId = randomId(18);
      await this.saveBatch(batchId, { uid, createdAt: new Date().toISOString(), ...data });
      return batchId;
    },
    async loadBatch(batchId, uid) {
      if (!/^[A-Za-z0-9_-]{8,80}$/u.test(batchId)) return null;
      const raw = await kv.get(`ema:batch:${batchId}`);
      const batch = raw ? JSON.parse(raw) : null;
      return batch && batch.uid === uid ? batch : null;
    },
    // 웹 확정 화면용. 링크 안의 로그인 증명은 링크보다 오래 살지 않게 만료를 맞춘다.
    async createConfirmLink({ uid, batchId, excludeRows, idToken, idTokenExpiresAt }, nowMs = Date.now()) {
      const remaining = Math.floor(((idTokenExpiresAt ?? nowMs + 55 * 60_000) - nowMs) / 1000) - 30;
      const ttl = Math.min(CONFIRM_TTL_SECONDS, remaining);
      if (ttl < 60) throw new Error('로그인 유효 시간이 얼마 남지 않았습니다. 잠시 후 다시 시도해 주세요.');
      const token = randomId(32);
      await kv.put(`ema:confirm:${token}`, JSON.stringify({ uid, batchId, excludeRows, idToken }), { expirationTtl: ttl });
      return { token, expiresInMinutes: Math.max(1, Math.floor(ttl / 60)) };
    },
    async readConfirm(token) {
      const raw = await kv.get(`ema:confirm:${token}`);
      return raw ? JSON.parse(raw) : null;
    },
    async consumeConfirm(token) {
      await kv.delete(`ema:confirm:${token}`);
    },
    async saveFile(uid, { name, contentType, bytes }) {
      const token = randomId(32);
      await kv.put(`ema:file:${token}`, bytes, { expirationTtl: FILE_TTL_SECONDS, metadata: { uid, name, contentType } });
      return { token, expiresInMinutes: FILE_TTL_SECONDS / 60 };
    },
    async takeFile(token) {
      const entry = await kv.getWithMetadata(`ema:file:${token}`, { type: 'arrayBuffer' });
      if (!entry?.value) return null;
      await kv.delete(`ema:file:${token}`);
      return { bytes: entry.value, ...entry.metadata };
    },
  };
}

const HTML_HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
export const escape = (value) => String(value).replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);

export function page(title, body, status = 200) {
  return new Response(`<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title>
<style>body{font:15px/1.6 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1f2937}
button{font:inherit;padding:.6rem 1.2rem;border-radius:.5rem;border:1px solid #0f172a;background:#0f172a;color:#fff;cursor:pointer}
code{background:#f1f5f9;padding:.1rem .35rem;border-radius:.25rem}.muted{color:#64748b;font-size:13px}</style>${body}</html>`, { status, headers: HTML_HEADERS });
}

export async function handleUpload(request, store, token) {
  const upload = await store.readUpload(token);
  if (!upload) {
    return page('업로드 링크', '<h1>링크가 만료됐거나 이미 사용됐습니다</h1><p>AI에게 "엑셀 업로드 링크 다시 줘"라고 요청해 주세요.</p>', 410);
  }
  if (request.method === 'GET') {
    return page('엑셀 업로드', `<h1>기업 등록 엑셀 올리기</h1>
<p>첫 번째 시트의 첫 행을 머리글로 읽습니다. 기업명(또는 법인명)이 있어야 하고, 발굴 경로는 열로 넣거나 AI에게 따로 알려 주세요.</p>
<form method="post" enctype="multipart/form-data"><p><input type="file" name="file" accept=".xlsx" required></p><p><button type="submit">올리기</button></p></form>
<p class="muted">이 링크는 한 번만 쓸 수 있고 ${UPLOAD_TTL_SECONDS / 60}분 뒤 만료됩니다. 파일은 서버에 저장되지 않고, 읽은 내용만 24시간 임시 보관됩니다.</p>`);
  }
  if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

  const length = Number(request.headers.get('content-length') || 0);
  if (length > MAX_UPLOAD_BYTES + 64 * 1024) return page('엑셀 업로드', '<h1>파일이 너무 큽니다</h1><p>20MB 이하로 나눠 올려 주세요.</p>', 413);
  let file;
  try {
    file = (await request.formData()).get('file');
  } catch {
    return page('엑셀 업로드', '<h1>파일을 읽지 못했습니다</h1><p>.xlsx 파일을 선택해 다시 시도해 주세요.</p>', 400);
  }
  if (!file || typeof file === 'string' || file.size === 0) {
    return page('엑셀 업로드', '<h1>파일이 없습니다</h1><p>.xlsx 파일을 선택해 주세요.</p>', 400);
  }
  if (file.size > MAX_UPLOAD_BYTES) return page('엑셀 업로드', '<h1>파일이 너무 큽니다</h1><p>20MB 이하로 나눠 올려 주세요.</p>', 413);

  let sheet;
  try {
    sheet = readXlsx(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    const message = error instanceof XlsxError ? error.message : '엑셀 파일을 읽지 못했습니다.';
    return page('엑셀 업로드', `<h1>읽지 못했습니다</h1><p>${escape(message)}</p>`, 400);
  }
  const batchId = await store.createBatch(upload.uid, {
    source: 'upload', fileName: String(file.name || '').slice(0, 200), sheetName: sheet.sheetName,
    headers: sheet.headers, rows: sheet.rows, rowNumbers: sheet.rowNumbers,
  });
  await store.consumeUpload(token);
  return page('엑셀 업로드', `<h1>${sheet.rows.length}행을 읽었습니다</h1>
<p>시트: <strong>${escape(sheet.sheetName)}</strong> · 열 ${sheet.headers.length}개</p>
<p>이제 AI 대화로 돌아가 <strong>"방금 올린 엑셀 미리보기 해줘"</strong>라고 말해 주세요.</p>
<p class="muted">배치 ID: <code>${escape(batchId)}</code></p>`);
}

const STATUS_LABELS = { new: '신규 등록', match: '기존 기업에 근거 추가', match_deleted: '삭제된 기업과 같음(건너뜀)', match_migrated: '이관 기업과 같음(건너뜀)', duplicate_in_batch: '파일 안 중복(건너뜀)', invalid: '오류(건너뜀)', provided: 'FRN 지정(기존 기업에 연결)' };
const RESULT_LABELS = { created: '신규 등록', linked: '기존 기업에 추가', skipped: '건너뜀', error: '오류' };
const MAX_LISTED = 50;

// 등록 확정 화면. GET 은 보여 주기만 하고, POST 의 버튼 클릭이 있어야 등록한다.
export async function handleConfirm(request, { store, ema, token, runCommit }) {
  const link = await store.readConfirm(token);
  const expired = () => page('등록 확정', '<h1>링크가 만료됐거나 이미 사용됐습니다</h1><p>AI에게 "등록 확정 링크 다시 줘"라고 요청해 주세요.</p>', 410);
  if (!link) return expired();
  const batch = await store.loadBatch(link.batchId, link.uid);
  if (!batch?.preview) return expired();
  if (request.method !== 'GET' && request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'GET, POST' } });

  const excluded = new Set(link.excludeRows ?? []);
  const items = batch.preview.items;
  const actionable = items.filter((item) => !excluded.has(item.sheetRow));
  const willCreate = actionable.filter((item) => item.action === 'create').length;
  const willLink = actionable.filter((item) => item.action === 'link').length;
  const willSkip = items.length - willCreate - willLink;

  if (request.method === 'GET') {
    const problems = items.filter((item) => item.status !== 'new' || excluded.has(item.sheetRow));
    const rows = problems.slice(0, MAX_LISTED).map((item) => `<li>${item.sheetRow}행 ${escape(item.name || '(이름 없음)')} — ${excluded.has(item.sheetRow) ? '제외함' : escape(STATUS_LABELS[item.status] || item.status)}${item.errors?.length ? ` · ${escape(item.errors.join(' / '))}` : ''}</li>`).join('');
    return page('등록 확정', `<h1>기업 ${willCreate + willLink}건을 등록할까요?</h1>
<ul><li>신규 등록 <strong>${willCreate}</strong>건</li><li>기존 기업에 근거 추가 <strong>${willLink}</strong>건(빈 칸만 채우고 기존 값은 바꾸지 않음)</li><li>건너뜀 <strong>${willSkip}</strong>건</li></ul>
${rows ? `<h2 style="font-size:15px">확인이 필요한 행</h2><ul>${rows}</ul>${problems.length > MAX_LISTED ? `<p class="muted">외 ${problems.length - MAX_LISTED}건</p>` : ''}` : ''}
<form method="post"><p><button type="submit">등록 확정</button></p></form>
<p class="muted">기여 크레딧은 부여하지 않습니다. 이 링크는 계정에 묶여 있으며 15분 안에 쓰지 않으면 만료됩니다.</p>`);
  }

  let result;
  try {
    result = await runCommit({ ema, uid: link.uid, batchId: link.batchId, excludeRows: link.excludeRows ?? [] });
  } catch (error) {
    const message = error instanceof Error && error.message ? error.message : '등록 중 오류가 발생했습니다.';
    return page('등록 확정', `<h1>등록하지 못했습니다</h1><p>${escape(message)}</p><form method="post"><p><button type="submit">다시 시도</button></p></form>`, 502);
  }
  const done = result.status === 'done';
  if (done) await store.consumeConfirm(token);
  const created = (result.created ?? []).slice(0, MAX_LISTED).map((entry) => `<li>${escape(entry.name || '')} — <code>${escape(entry.frn || '')}</code></li>`).join('');
  const problems = (result.problems ?? []).slice(0, MAX_LISTED).map((entry) => `<li>${entry.sheetRow ?? ''}행 ${escape(entry.name || '')} — ${escape(RESULT_LABELS[entry.status] || entry.status)} ${escape(entry.message || entry.reason || '')}</li>`).join('');
  return page('등록 확정', `<h1>${done ? '등록을 마쳤습니다' : '일부만 처리했습니다'}</h1>
<p>${Object.entries(result.counts).map(([status, count]) => `${escape(RESULT_LABELS[status] || status)} ${count}건`).join(' · ') || '처리된 행이 없습니다.'}</p>
${created ? `<h2 style="font-size:15px">새로 만든 FRN</h2><ul>${created}</ul>` : ''}
${problems ? `<h2 style="font-size:15px">확인이 필요한 행</h2><ul>${problems}</ul>` : ''}
${done ? '<p>이제 AI 대화로 돌아가 결과를 확인하세요.</p>' : `<p>${escape(result.error || '시간 제한으로 일부만 처리했습니다.')} 아래 버튼을 누르면 이어서 처리하며 중복 등록되지 않습니다.</p><form method="post"><p><button type="submit">이어서 처리</button></p></form>`}`);
}

export async function handleFileDownload(store, token) {
  const file = await store.takeFile(token);
  if (!file) return page('파일 다운로드', '<h1>링크가 만료됐거나 이미 사용됐습니다</h1><p>AI에게 다시 내려받기를 요청해 주세요.</p>', 410);
  const asciiName = String(file.name).replace(/[^\x20-\x7E]/gu, '_').replace(/["\\]/gu, '_');
  return new Response(file.bytes, {
    headers: {
      'content-type': file.contentType,
      'content-disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}
