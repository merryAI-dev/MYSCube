import { describe, expect, it, vi } from 'vitest';
import { BffError, createBffClient } from '../src/bff.mjs';

// 시간과 대기를 테스트에서 조종한다(실제로 기다리지 않음).
function clock() {
  let t = 0;
  return { now: () => t, sleep: vi.fn(async (ms) => { t += ms; }), advance: (ms) => { t += ms; } };
}
const client = (fetchImpl, c = clock(), extra = {}) => ({
  c, bff: createBffClient({ baseUrl: 'https://b', idToken: 't', fetchImpl, now: c.now, sleep: c.sleep, random: () => 0, ...extra }),
});
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('BFF client limits and retries', () => {
  it('retries a GET on 503 with backoff and returns the later success', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({ code: 'unavailable' }, 503))
      .mockResolvedValueOnce(json({ code: 'unavailable' }, 503))
      .mockResolvedValueOnce(json({ ok: true }));
    const { bff, c } = client(fetchImpl);
    await expect(bff.get('/api/v1/projects')).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(c.sleep.mock.calls.map(([ms]) => ms)).toEqual([300, 600]);
  });

  it('follows Retry-After in seconds and caps it', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '2' }))
      .mockResolvedValueOnce(json({}, 429, { 'retry-after': '120' }))
      .mockResolvedValueOnce(json({ ok: true }));
    const { bff, c } = client(fetchImpl);
    await bff.get('/api/v1/projects');
    expect(c.sleep.mock.calls.map(([ms]) => ms)).toEqual([2000, 5000]);
  });

  it('stops after two retries and reports the last error with the BFF message', async () => {
    const fetchImpl = vi.fn(async () => json({ code: 'unavailable', message: 'BFF 점검 중' }, 503));
    const { bff } = client(fetchImpl);
    await expect(bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 503, code: 'unavailable', message: 'BFF 점검 중', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('never retries POST reads or 4xx answers', async () => {
    const post = vi.fn(async () => json({ code: 'unavailable' }, 503));
    await expect(client(post).bff.post('/api/v1/project-requests/review-inbox', {})).rejects.toMatchObject({ status: 503 });
    expect(post).toHaveBeenCalledTimes(1);
    const forbidden = vi.fn(async () => json({ code: 'forbidden', message: 'Project attachment access denied' }, 403));
    await expect(client(forbidden).bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 403, code: 'forbidden', retryable: false });
    expect(forbidden).toHaveBeenCalledTimes(1);
  });

  it('keeps the whole call, retries included, inside the time budget and keeps the error body', async () => {
    const c = clock();
    const fetchImpl = vi.fn(async () => { c.advance(24_900); return json({ code: 'unavailable', message: '느림' }, 503, { 'retry-after': '1' }); });
    const { bff } = client(fetchImpl, c);
    // 첫 응답 뒤 남은 시간(100ms)이 Retry-After(1초)보다 짧아 재시도하지 않고, 오류 본문을 그대로 돌려준다.
    await expect(bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 503, message: '느림' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(c.sleep).not.toHaveBeenCalled();
  });

  it('retries a GET network failure, then reports a retryable network error', async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError('fetch failed'); });
    const { bff } = client(fetchImpl);
    await expect(bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 502, code: 'network_error', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('refuses a body larger than the limit, by header or while reading', async () => {
    const declared = vi.fn(async () => new Response('x'.repeat(10), { headers: { 'content-length': '999999' } }));
    await expect(client(declared).bff.get('/api/v1/projects', {}, { maxBytes: 1000 })).rejects.toMatchObject({ code: 'response_too_large' });
    // 헤더 없이 흘러오는 본문도 누적 바이트로 끊는다.
    const stream = new ReadableStream({ start(controller) { for (let i = 0; i < 5; i += 1) controller.enqueue(new TextEncoder().encode('y'.repeat(400))); controller.close(); } });
    const streamed = vi.fn(async () => new Response(stream));
    await expect(client(streamed).bff.get('/api/v1/projects', {}, { maxBytes: 1000 })).rejects.toBeInstanceOf(BffError);
    // 상한 안이면 그대로 읽는다(다중 바이트 한글 포함).
    const ok = vi.fn(async () => json({ name: '계약서' }));
    await expect(client(ok).bff.get('/api/v1/projects', {}, { maxBytes: 1000 })).resolves.toEqual({ name: '계약서' });
  });

  it('turns a timeout while reading the body into a retryable timeout error (review #3)', async () => {
    const stream = new ReadableStream({ pull() { throw Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }); } });
    const fetchImpl = vi.fn(async () => new Response(stream, { status: 200 }));
    await expect(client(fetchImpl).bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 504, code: 'timeout', retryable: true });
    const broken = new ReadableStream({ pull() { throw new TypeError('connection reset'); } });
    await expect(client(vi.fn(async () => new Response(broken))).bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 502, code: 'network_error', retryable: true });
  });

  it('keeps the real HTTP status when an error body cannot be read (2nd review #9)', async () => {
    const broken = new ReadableStream({ pull() { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); } });
    const fetchImpl = vi.fn(async () => new Response(broken, { status: 403 }));
    await expect(client(fetchImpl).bff.get('/api/v1/projects')).rejects.toMatchObject({ status: 403, retryable: false, code: 'response_incomplete', message: expect.stringContaining('HTTP 403') });
  });
});
