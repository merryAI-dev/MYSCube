import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { compileHtmlPreview } from './html-tailwind.mjs';
import { HTML_EXAMPLE, HTML_SECOND_EXAMPLE } from './html-references.mjs';
import { validateHtmlPreviewArtifact } from '../../shared/workbench-html.mjs';

const source = (html = HTML_EXAMPLE) => ({ title: '스타일 검토', html });
const add = (body) => HTML_EXAMPLE.replace('</body>', `${body}</body>`);
const hash = (value) => createHash('sha256').update(value).digest('hex');

describe('isolated pinned Tailwind compilation', () => {
  it('compiles real responsive utility styles and preserves original source separately', async () => {
    const input = source();
    const artifact = await compileHtmlPreview(input);
    expect(input.html).toBe(HTML_EXAMPLE);
    expect(artifact.css).toContain('.bg-blue-600');
    expect(artifact.css).toContain('@media');
    expect(artifact.previewHtml).toContain(artifact.css);
    expect(artifact.previewHash).toBe(hash(artifact.previewHtml));
    expect(artifact.cssHash).toBe(hash(artifact.css));
    expect(artifact.contentHash).toBe(hash(HTML_EXAMPLE));
    expect(artifact.dependencies).toEqual([{ name: 'tailwindcss', version: '4.1.12' }]);
    expect(validateHtmlPreviewArtifact(artifact.previewHtml).ok).toBe(true);
  });
  it('produces deterministic artifacts and materially different responsive example layouts', async () => {
    const first = await compileHtmlPreview(source());
    const repeat = await compileHtmlPreview(source());
    const second = await compileHtmlPreview(source(HTML_SECOND_EXAMPLE));
    expect(repeat).toEqual(first);
    expect(second.cssHash).not.toBe(first.cssHash);
    expect(second.previewHtml).toContain('md:sticky');
    expect(second.previewHtml).toContain('오류 대응은');
  });
  it.each([
    'bg-[url(https://example.org/private)]',
    "before:content-['</style><script>alert(1)</script>']",
  ])('rejects arbitrary utility output containing network URLs or closing-style injection: %s', async (candidate) => {
    await expect(compileHtmlPreview(source(add(`<div class="${candidate}">test</div>`)))).rejects.toMatchObject({ code: 'html_style_unsafe' });
  });
  it('enforces class count and per-class length before starting compilation', async () => {
    const many = Array.from({ length: 1501 }, (_, index) => `p-${index}`).join(' ');
    await expect(compileHtmlPreview(source(add(`<div class="${many}"></div>`)))).rejects.toMatchObject({ code: 'html_style_class_limit' });
    await expect(compileHtmlPreview(source(add(`<div class="${'x'.repeat(513)}"></div>`)))).rejects.toMatchObject({ code: 'html_style_class_too_long' });
  });
  it('enforces the combined authored and generated CSS capacity', async () => {
    const html = HTML_EXAMPLE.replace('</head>', `<style>${' '.repeat(76_000)}</style></head>`);
    await expect(compileHtmlPreview(source(html))).rejects.toMatchObject({ code: 'html_style_unsafe', issues: [expect.objectContaining({ code: 'css_size_exceeded' })] });
  });
  it('terminates timed-out compilation and permits the next request', async () => {
    await expect(compileHtmlPreview(source(), { timeoutMs: 1 })).rejects.toMatchObject({ code: 'html_style_timeout' });
    expect((await compileHtmlPreview(source())).css).toContain('.bg-blue-600');
  });
  it('rejects work above two concurrent compilers without an unbounded queue', async () => {
    const results = await Promise.allSettled([compileHtmlPreview(source()), compileHtmlPreview(source()), compileHtmlPreview(source())]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { statusCode: 429, code: 'html_style_busy' } });
  });
  it('rejects missing, altered, duplicate or misplaced preview policies and active markup', async () => {
    const { previewHtml } = await compileHtmlPreview(source());
    const variants = [previewHtml.replace('script-src &#39;none&#39;', 'script-src *').replace("script-src 'none'", 'script-src *'),
      previewHtml.replace('<head><meta', '<head><title>moved</title><meta'),
      previewHtml.replace('</head>', '<meta http-equiv="Content-Security-Policy" content="default-src *"></head>'),
      previewHtml.replace('</body>', '<script>alert(1)</script></body>'), HTML_EXAMPLE];
    for (const html of variants) expect(validateHtmlPreviewArtifact(html).ok).toBe(false);
  });
});
