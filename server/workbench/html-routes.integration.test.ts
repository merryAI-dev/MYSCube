import { beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from './app.mjs';
import { HTML_EXAMPLE } from './html-references.mjs';
const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('isolated HTML HTTP contracts (fixture model, not live AI)', () => {
  const env = { WORKBENCH_PROJECT_ID: 'demo-html-http', PRODUCTION_PROJECT_ID: 'demo-business-app', WORKBENCH_MODEL_PROJECT_ID: 'demo-html-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-business-model', WORKBENCH_AI_ENABLED: 'true', WORKBENCH_GEMINI_API_KEY: 'fixture-never-sent' };
  const db = new Firestore({ projectId: env.WORKBENCH_PROJECT_ID });
  const root = 'orgs/html-http';
  const now = () => new Date().toISOString();
  const complete = vi.fn(async () => ({ tool_calls: [{ function: { name: 'render_html_document', arguments: JSON.stringify({ title: '생성 계약 검증', html: HTML_EXAMPLE }) } }] }));
  const app = () => createWorkbenchApp({ db, env, now, authMode: 'headers', htmlCompletionFactory: () => complete });
  const call = (verb: string, path: string, actor = 'admin-a') => (request(app()) as any)[verb](`/api/v1/html-work-pages${path}`).set('x-tenant-id', 'html-http').set('x-actor-id', actor).set('Idempotency-Key', crypto.randomUUID());
  beforeEach(async () => {
    await db.recursiveDelete(db.doc(root)); complete.mockClear();
    await db.doc(`${root}/members/admin-a`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now() });
    await db.doc(`${root}/members/admin-b`).set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: now() });
    await db.doc(`${root}/members/member-a`).set({ status: 'ACTIVE', role: 'member', permissionsCapturedAt: now() });
  });
  afterAll(async () => { await db.recursiveDelete(db.doc(root)); await db.terminate(); });
  it('generates real HTML transport with reference body, no autosave, and duplicate request protection', async () => {
    const idempotency = crypto.randomUUID();
    const generated = await call('post', '/generate').set('Idempotency-Key', idempotency).send({ prompt: '서로 다른 레이아웃의 HTML', referenceIds: ['toss-preview-runtime'] });
    expect(generated.status).toBe(200); expect(generated.body.source.html).toContain('<!doctype html>'); expect(generated.body.saved).toBe(false);
    expect(complete.mock.calls[0][0].messages[0].content).toContain('REFERENCE');
    expect((await call('get', '')).body.items).toEqual([]);
    expect((await call('post', '/generate').set('Idempotency-Key', idempotency).send({ prompt: '서로 다른 레이아웃의 HTML', referenceIds: ['toss-preview-runtime'] })).status).toBe(409);
    expect(complete).toHaveBeenCalledTimes(1);
  });
  it('rejects non-admin, stale permission and other owner without altering source', async () => {
    expect((await call('get', '', 'member-a')).status).toBe(403);
    const saved = await call('post', '').send({ expectedVersion: 0, source: { title: '비공개', html: HTML_EXAMPLE } });
    expect(saved.status).toBe(201);
    expect((await call('get', `/${saved.body.id}`, 'admin-b')).status).toBe(404);
    expect((await call('get', `/${saved.body.id}/review`, 'admin-b')).status).toBe(404);
    await db.doc(`${root}/members/admin-a`).update({ permissionsCapturedAt: '2020-01-01T00:00:00Z' });
    expect((await call('get', `/${saved.body.id}`)).status).toBe(403);
  });
  it('preview compiles without saving and refuses executable or externally connected HTML', async () => {
    const result = await call('post', '/preview').send({ source: { title: '미리보기', html: HTML_EXAMPLE } });
    expect(result.status).toBe(200); expect(result.body.previewHtml).toContain('style'); expect(result.body.previewHash).toMatch(/^[a-f0-9]{64}$/);
    const invalid = HTML_EXAMPLE.replace('</body>', '<script>while(true){}</script></body>');
    expect((await call('post', '/preview').send({ source: { title: '금지', html: invalid } })).status).toBe(400);
    expect((await call('get', '')).body.items).toEqual([]);
  });
  it('failed provider leaves saved HTML unchanged and the read API available', async () => {
    const saved = await call('post', '').send({ expectedVersion: 0, source: { title: '정상', html: HTML_EXAMPLE } });
    expect(saved.status).toBe(201);
    complete.mockRejectedValueOnce(new Error('fixture provider unavailable'));
    expect((await call('post', '/generate').send({ prompt: '수정' })).status).toBe(502);
    const reread = await call('get', `/${saved.body.id}`);
    expect(reread.status).toBe(200); expect(reread.body.source.html).toBe(HTML_EXAMPLE); expect(reread.body.version).toBe(1);
  });
});
