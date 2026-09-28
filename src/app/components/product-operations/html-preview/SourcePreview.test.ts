import { describe, expect, it } from 'vitest';
import { matchesExpectedArtifactHash, sha256Source, SOURCE_PREVIEW_CANDIDATE_STYLE, SOURCE_PREVIEW_COMMITTED_STYLE, SOURCE_PREVIEW_HASH_STYLE } from './SourcePreview';
import { HTML_PREVIEW_CSP, validateHtmlSource } from '../../../../../shared/workbench-html.mjs';

const validHtml = `<!doctype html><html lang="ko"><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>@media (max-width: 640px) { main { padding: 1rem; } }</style></head><body><main><details><summary>자세히 보기</summary><p>정적 내용</p></details></main></body></html>`;

describe('SourcePreview static document policy', () => {
  it('keeps a loaded candidate invisible so the last committed document remains visible', () => {
    expect(SOURCE_PREVIEW_COMMITTED_STYLE).toMatchObject({ display: 'block', width: '100%', minHeight: 540 });
    expect(SOURCE_PREVIEW_CANDIDATE_STYLE).toMatchObject({ position: 'absolute', width: 1, height: 1, minHeight: 0, visibility: 'hidden', pointerEvents: 'none' });
  });

  it('lets a full SHA-256 value wrap within a narrow standalone workspace column', () => {
    expect(SOURCE_PREVIEW_HASH_STYLE).toMatchObject({ minWidth: 0, overflowWrap: 'anywhere' });
  });

  it('uses the same full SHA-256 fingerprint as review and persistence records', async () => {
    expect(await sha256Source('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('rejects a compiled artifact whose expected SHA-256 does not match its actual bytes', async () => {
    const expected = await sha256Source('compiled preview A');
    expect(matchesExpectedArtifactHash(await sha256Source('compiled preview A'), expected)).toBe(true);
    expect(matchesExpectedArtifactHash(await sha256Source('compiled preview B'), expected)).toBe(false);
  });

  it('uses the shared static-document artifact with the restrictive preview policy', () => {
    const result = validateHtmlSource({ title: '미리보기', html: validHtml });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('valid static document was rejected');
    const { document } = result;
    expect(document).toContain('<details><summary>자세히 보기</summary>');
    expect(document).toContain('@media (max-width: 640px)');
    expect(document).toContain(HTML_PREVIEW_CSP);
  });

  it.each([
    '<script>window.alert(1)</script>',
    '<button onclick="alert(1)">실행</button>',
    '<form action="https://outside.example"><input></form>',
    '<a href="https://outside.example">외부</a>',
  ])('rejects an unsafe browser capability before an iframe is created: %s', (unsafe) => {
    const html = validHtml.replace('</body>', `${unsafe}</body>`);
    expect(validateHtmlSource({ title: '미리보기', html })).toMatchObject({ ok: false });
  });
});
