import { describe, expect, it } from 'vitest';
import { createStore, handleFileDownload, handleUpload } from '../src/ema/files.mjs';
import { buildXlsx } from '../src/ema/xlsx.mjs';
import { memoryKv } from './ema-support.mjs';

const upload = (token, file) => {
  const form = new FormData();
  if (file) form.set('file', file);
  return new Request(`https://ema-mcp.myscguard.app/upload/${token}`, { method: 'POST', body: form });
};
const xlsxFile = (rows) => new File([buildXlsx({ headers: ['기업명', '창업자'], rows })], '등록.xlsx');

describe('upload page', () => {
  it('shows the form for a live link, turns an uploaded sheet into a batch for that member, and burns the link', async () => {
    const store = createStore(memoryKv());
    const { token } = await store.createUploadLink('u1');
    const page = await handleUpload(new Request(`https://x/upload/${token}`), store, token);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(await page.text()).toContain('type="file"');

    const done = await handleUpload(upload(token, xlsxFile([['에코랩', '홍길동'], ['블루', '김초록']])), store, token);
    expect(done.status).toBe(200);
    const html = await done.text();
    expect(html).toContain('2행을 읽었습니다');
    const batchId = /<code>([^<]+)<\/code>/.exec(html)[1];
    const batch = await store.loadBatch(batchId, 'u1');
    expect(batch).toMatchObject({ source: 'upload', fileName: '등록.xlsx', rowNumbers: [2, 3] });
    expect(batch.rows[1]).toEqual({ 기업명: '블루', 창업자: '김초록' });
    expect(await store.loadBatch(batchId, 'u2')).toBeNull();

    const reused = await handleUpload(upload(token, xlsxFile([['x', 'y']])), store, token);
    expect(reused.status).toBe(410);
  });

  it('rejects unknown links, missing files and non-xlsx files without burning the link', async () => {
    const store = createStore(memoryKv());
    expect((await handleUpload(new Request('https://x/upload/nope'), store, 'nope')).status).toBe(410);
    const { token } = await store.createUploadLink('u1');
    expect((await handleUpload(upload(token), store, token)).status).toBe(400);
    const bad = await handleUpload(upload(token, new File(['hello'], 'a.xlsx')), store, token);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('엑셀');
    expect(await store.readUpload(token)).toEqual({ uid: 'u1' });
  });
});

describe('download', () => {
  it('serves a file once with a safe attachment header, then it is gone', async () => {
    const store = createStore(memoryKv());
    const { token } = await store.saveFile('u1', { name: 'EMA-기업등록.xlsx', contentType: 'application/vnd.ms-excel', bytes: new Uint8Array([1, 2, 3]) });
    const first = await handleFileDownload(store, token);
    expect(first.status).toBe(200);
    expect(first.headers.get('content-disposition')).toContain("filename*=UTF-8''EMA-%EA%B8%B0%EC%97%85%EB%93%B1%EB%A1%9D.xlsx");
    expect(first.headers.get('cache-control')).toBe('no-store');
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect((await handleFileDownload(store, token)).status).toBe(410);
  });
});
