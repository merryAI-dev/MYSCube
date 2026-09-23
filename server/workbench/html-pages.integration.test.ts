import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import { createHtmlPageService, generateHtmlPage } from './html-pages.mjs';
import { HTML_EXAMPLE, HTML_SECOND_EXAMPLE } from './html-references.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('HTML source versions in independent Firestore', () => {
  const db = new Firestore({ projectId: 'demo-html-workbench' });
  const businessDb = new Firestore({ projectId: 'demo-html-business' });
  const context = { tenantId: 'html-pages-it', actorId: 'admin-a', actorRole: 'admin' };
  const other = { ...context, actorId: 'admin-b' };
  const root = `orgs/${context.tenantId}`;
  const owner = createHash('sha256').update(context.actorId).digest('hex');
  let at = '2026-09-22T12:00:00.000Z';
  const service = createHtmlPageService({ db, now: () => at });
  const source = { title: '처음 화면', html: HTML_EXAMPLE };
  const first = () => service.save(context, null, { expectedVersion: 0, source });
  const ref = (id: string) => db.doc(`${root}/html_work_pages/${owner}/pages/${id}`);
  beforeEach(async () => {
    expect(db.projectId).not.toBe(businessDb.projectId);
    at = '2026-09-22T12:00:00.000Z';
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await businessDb.doc(`${root}/projects/p1`).set({ name: '실제 업무 원본', amount: 123, revision: 'untouched' });
  });
  afterAll(async () => {
    await db.recursiveDelete(db.doc(root));
    await businessDb.recursiveDelete(businessDb.doc(root));
    await Promise.all([db.terminate(), businessDb.terminate()]);
  });

  it('generates actual source, persists explicitly, restores as a new version and leaves business data unchanged', async () => {
    const generated = await generateHtmlPage({ input: { prompt: 'CEO 화면 생성' }, complete: async () => ({ tool_calls: [{ function: {
      name: 'render_html_document', arguments: JSON.stringify(source),
    } }] }) });
    expect((await service.list(context)).items).toEqual([]);
    const saved = await service.save(context, null, { expectedVersion: 0, source: generated.source, referenceIds: generated.referenceIds });
    expect((await service.get(context, saved.id)).source).toEqual(source);
    at = '2026-09-22T12:05:00.000Z';
    const second = await service.save(context, saved.id, { expectedVersion: 1, source: { title: '변경 화면', html: HTML_SECOND_EXAMPLE } });
    at = '2026-09-22T12:10:00.000Z';
    const restored = await service.restore(context, saved.id, { expectedVersion: second.version, version: 1 });
    expect(restored).toMatchObject({ version: 3, restoredFrom: 1, source, updatedBy: context.actorId, updatedAt: at });
    expect(restored.previewHtml).toBe(saved.previewHtml);
    expect(restored.previewHash).toBe(saved.previewHash);
    expect(restored.css).toBe(saved.css);
    expect(restored.cssHash).toBe(saved.cssHash);
    expect(await service.getVersion(context, saved.id, 1)).toEqual(saved);
    expect((await service.history(context, saved.id)).items.map((item: any) => item.version)).toEqual([3, 2, 1]);
    expect((await service.list(context)).items[0].source).toBeUndefined();
    expect((await businessDb.doc(`${root}/projects/p1`).get()).data()).toEqual({ name: '실제 업무 원본', amount: 123, revision: 'untouched' });
  });

  it('exports the selected exact source with a verifiable manifest instead of auto-committing or exporting latest by mistake', async () => {
    const saved = await first();
    await service.save(context, saved.id, { expectedVersion: 1, source: { title: '수정됨', html: HTML_SECOND_EXAMPLE } });
    const exported = await service.exportReview(context, saved.id, 1);
    expect(exported.files['index.html']).toBe(HTML_EXAMPLE);
    expect(exported.manifest).toMatchObject({ version: 1, contentHash: createHash('sha256').update(HTML_EXAMPLE).digest('hex'), scriptsAllowed: false, externalNetwork: false,
      dependencies: [{ name: 'tailwindcss', version: '4.1.12' }] });
    expect(exported.files['preview.html']).toBe(saved.previewHtml);
    expect(createHash('sha256').update(exported.files['preview.html']).digest('hex')).toBe(exported.manifest.previewHash);
    expect(createHash('sha256').update(exported.files['styles.css']).digest('hex')).toBe(exported.manifest.cssHash);
    expect(JSON.parse(exported.files['manifest.json'])).toEqual(exported.manifest);
    expect((await service.exportReview(context, saved.id)).files['index.html']).toBe(HTML_SECOND_EXAMPLE);
  });

  it('rejects simultaneous stale saves rather than silently overwriting another version', async () => {
    const saved = await first();
    const results = await Promise.allSettled([
      service.save(context, saved.id, { expectedVersion: 1, source: { ...source, title: '창 A' } }),
      service.save(context, saved.id, { expectedVersion: 1, source: { ...source, title: '창 B' } }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 409, code: 'html_page_conflict' } });
    expect((await service.history(context, saved.id)).items).toHaveLength(2);
  });

  it('enforces owner and tenant boundaries on every read, restore and review export', async () => {
    const saved = await first();
    for (const actor of [other, { ...context, tenantId: 'another-tenant' }]) {
      expect((await service.list(actor)).items).toEqual([]);
      await expect(service.get(actor, saved.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.history(actor, saved.id)).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.restore(actor, saved.id, { expectedVersion: 1, version: 1 })).rejects.toMatchObject({ statusCode: 404 });
      await expect(service.exportReview(actor, saved.id, 1)).rejects.toMatchObject({ statusCode: 404 });
    }
  });

  it('rejects invalid source before creating any page or revision', async () => {
    await expect(service.save(context, null, { expectedVersion: 0, source: { ...source, html: HTML_EXAMPLE.replace('</body>', '<script>bad()</script></body>') } }))
      .rejects.toMatchObject({ statusCode: 400, code: 'html_source_invalid' });
    expect((await service.list(context)).items).toEqual([]);
  });

  it('uses create semantics for immutable versions and rolls back the head if an existing version would be overwritten', async () => {
    const saved = await first();
    await ref(saved.id).collection('versions').doc('2').create({ reservedForIntegrityTest: true });
    await expect(service.save(context, saved.id, { expectedVersion: 1, source: { ...source, title: '충돌' } })).rejects.toBeDefined();
    expect(await service.get(context, saved.id)).toEqual(saved);
    expect((await ref(saved.id).collection('versions').doc('2').get()).data()).toEqual({ reservedForIntegrityTest: true });
  });

  it('refuses corrupt stored source rather than exporting it as a verified revision', async () => {
    const saved = await first();
    await ref(saved.id).update({ 'source.html': HTML_SECOND_EXAMPLE });
    await expect(service.get(context, saved.id)).rejects.toMatchObject({ code: 'html_page_integrity_failed' });
    await expect(service.exportReview(context, saved.id)).rejects.toMatchObject({ code: 'html_page_integrity_failed' });
  });

  it('refuses corrupt compiled CSS and preview artifacts', async () => {
    const saved = await first();
    await ref(saved.id).update({ css: 'changed' });
    await expect(service.get(context, saved.id)).rejects.toMatchObject({ code: 'html_page_integrity_failed' });
    await ref(saved.id).set({ ...saved, previewHtml: 'changed' });
    await expect(service.exportReview(context, saved.id)).rejects.toMatchObject({ code: 'html_page_integrity_failed' });
  });

  it('rejects restoring an unsupported renderer version instead of silently recompiling it', async () => {
    const saved = await first();
    await ref(saved.id).collection('versions').doc('1').update({ runtimeVersion: 'an-older-renderer' });
    await expect(service.restore(context, saved.id, { expectedVersion: 1, version: 1 })).rejects.toMatchObject({ code: 'html_runtime_unsupported' });
    expect((await service.get(context, saved.id)).version).toBe(1);
  });

  it('checks combined UTF-8 storage size before writing source plus reproducible artifacts', async () => {
    const html = HTML_EXAMPLE.replace('</body>', `<p>${'한'.repeat(155_000)}</p></body>`);
    await expect(service.save(context, null, { expectedVersion: 0, source: { ...source, html } })).rejects.toMatchObject({ statusCode: 413, code: 'html_page_storage_size_exceeded' });
    expect((await service.list(context)).items).toEqual([]);
  });
});
