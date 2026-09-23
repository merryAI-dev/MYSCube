import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { HTML_PREVIEW_CSP, MAX_HTML_LENGTH, validateHtmlSource } from '../../shared/workbench-html.mjs';
import { generateHtmlPage } from './html-pages.mjs';
import { HTML_EXAMPLE, HTML_SECOND_EXAMPLE, HTML_REFERENCES } from './html-references.mjs';

const source = (html = HTML_EXAMPLE) => ({ title: '검토할 페이지', html });
const add = (html) => HTML_EXAMPLE.replace('</body>', `${html}</body>`);
const answer = (html = HTML_EXAMPLE) => ({ tool_calls: [{ function: { name: 'render_html_document', arguments: JSON.stringify(source(html)) } }] });

describe('reviewable HTML source admission', () => {
  it.each([HTML_EXAMPLE, HTML_SECOND_EXAMPLE])('accepts structurally different authored layouts and adds an execution-only policy', (html) => {
    const input = source(html);
    const result = validateHtmlSource(input);
    expect(result.ok).toBe(true);
    expect(result.document).toContain('Content-Security-Policy');
    expect(result.document).toContain(HTML_PREVIEW_CSP);
    expect(result.document).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(input.html).toBe(html);
    expect(input.html).not.toContain('Content-Security-Policy');
  });

  it.each([
    ['script', '<script>alert(1)</script>'], ['entity-encoded event', '<div on&#99;lick="alert(1)">안내</div>'],
    ['event', '<div onclick="alert(1)">안내</div>'], ['form', '<form action="#x"></form>'],
    ['frame', '<iframe srcdoc="test"></iframe>'], ['SVG namespace', '<svg><foreignObject><p>nested</p></foreignObject></svg>'],
    ['external image', '<img src="https://example.org/image.png" alt="image">'], ['encoded URL', '<a href="&#x6a;avascript:alert(1)">link</a>'],
    ['protocol-relative URL', '<a href="//example.org">link</a>'], ['popup target', '<a href="#status" target="_top">link</a>'],
    ['srcset', '<img src="data:image/png;base64,aGVsbG8=" srcset="https://example.org/a 2x" alt="test">'],
    ['resource hint', '<link rel="preconnect" href="https://example.org">'], ['CSS URL', '<style>body{background:url(https://example.org)}</style>'],
    ['escaped CSS URL', '<style>body{background:u\\72l(https://example.org)}</style>'],
    ['CSS import', '<style>@import "https://example.org/style.css";</style>'],
    ['CSS image set', '<style>body{background:image-set("https://example.org/image.png" 1x)}</style>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://example.org">'],
    ['policy override', '<meta http-equiv="Content-Security-Policy" content="script-src *">'],
    ['template', '<template><script>evil()</script></template>'], ['noscript parsing difference', '<noscript><img src="https://example.org"></noscript>'],
  ])('rejects %s instead of silently saving a different source', (_, markup) => {
    const html = add(markup);
    const result = validateHtmlSource(source(html));
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.document).toBeUndefined();
  });

  it('allows native disclosure, same-document navigation and embedded raster images', () => {
    expect(validateHtmlSource(source(add('<a href="#status">현재 상태</a><section id="status"><details><summary>더 보기</summary><p>확인</p></details><img src="data:image/png;base64,aGVsbG8=" alt="내장 예제"></section>'))).ok).toBe(true);
  });
  it('does not interpret displayed escaped source as executable markup', () => {
    expect(validateHtmlSource(source(add('<pre>&lt;script&gt;예제&lt;/script&gt;</pre>'))).ok).toBe(true);
  });
  it('rejects fragments, oversized input, invalid titles and missing responsive viewport', () => {
    for (const value of [source('<div>fragment</div>'), source('x'.repeat(MAX_HTML_LENGTH + 1)), { ...source(), title: '' }, source(HTML_EXAMPLE.replace('width=device-width', 'width=1200'))]) {
      expect(validateHtmlSource(value).ok).toBe(false);
    }
  });
  it('rejects duplicate attributes before parser normalization hides them', () => {
    expect(validateHtmlSource(source(add('<div class="one" class="two">duplicate</div>'))).issues).toContainEqual(expect.objectContaining({ code: 'duplicate_attribute' }));
  });
  it('bounds parsed tree depth and node count before serializing the preview', () => {
    const deep = add(`${'<div>'.repeat(10000)}nested${'</div>'.repeat(10000)}`);
    const broad = add('<span>cell</span>'.repeat(3000));
    for (const html of [deep, broad]) expect(validateHtmlSource(source(html)).issues).toContainEqual(expect.objectContaining({ code: 'document_complexity_exceeded' }));
  });
  it('bounds total inline and stylesheet CSS size', () => {
    expect(validateHtmlSource(source(add(`<style>${' '.repeat(80_001)}</style>`))).issues).toContainEqual(expect.objectContaining({ code: 'css_size_exceeded' }));
  });
});

describe('HTML generation with concrete references', () => {
  it('provides actual reference guidance and two distinct example documents to the model', async () => {
    const complete = vi.fn().mockResolvedValue(answer(HTML_SECOND_EXAMPLE));
    const result = await generateHtmlPage({ complete, input: { prompt: '사이드바와 펼칠 수 있는 검토 노트를 만들어 주세요.' } });
    const system = complete.mock.calls[0][0].messages[0].content;
    expect(system).toContain(HTML_EXAMPLE);
    expect(system).toContain(HTML_SECOND_EXAMPLE);
    expect(system).toContain('https://toss.tech/article/52885');
    expect(system).toContain('No live business data');
    expect(result).toMatchObject({ source: source(HTML_SECOND_EXAMPLE), saved: false, attempts: 1, validation: { execution: 'not_run', data: 'not_connected' } });
    expect(result.contentHash).toBe(createHash('sha256').update(HTML_SECOND_EXAMPLE).digest('hex'));
    expect(result.referenceIds).toEqual(HTML_REFERENCES.map((reference) => reference.id));
  });

  it('passes the full existing source to the edit request without substituting a widget config', async () => {
    const complete = vi.fn().mockResolvedValue(answer(HTML_SECOND_EXAMPLE));
    const result = await generateHtmlPage({ complete, input: { prompt: '카드 대신 사이드바 노트로 바꿔 주세요.', currentHtml: HTML_EXAMPLE, referenceIds: ['mdn-css-grid'] } });
    expect(JSON.parse(complete.mock.calls[0][0].messages[1].content).currentHtml).toBe(HTML_EXAMPLE);
    expect(result.source.html).toBe(HTML_SECOND_EXAMPLE);
    expect(result.referenceIds).toEqual(['mdn-css-grid', 'myscube-html-examples-v1']);
  });

  it('repairs one invalid result with concrete validation errors and returns the repaired exact source', async () => {
    const complete = vi.fn().mockResolvedValueOnce(answer(add('<script>alert(1)</script>'))).mockResolvedValueOnce(answer());
    const result = await generateHtmlPage({ complete, input: { prompt: '현황 페이지 생성' } });
    expect(complete).toHaveBeenCalledTimes(2);
    expect(JSON.parse(complete.mock.calls[1][0].messages[1].content).repairPreviousAttempt.issues).toContainEqual(expect.objectContaining({ code: 'element_forbidden' }));
    expect(result).toMatchObject({ attempts: 2, source: source(), saved: false });
  });

  it('stops after two invalid attempts and never claims execution or persistence succeeded', async () => {
    const complete = vi.fn().mockResolvedValue(answer(add('<script>alert(1)</script>')));
    await expect(generateHtmlPage({ complete, input: { prompt: '현황' } })).rejects.toMatchObject({ statusCode: 502, code: 'html_generation_invalid' });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed model tool output and refuses to invent a missing-data state', async () => {
    const complete = vi.fn().mockResolvedValueOnce({ content: '```html <p>text</p> ```' }).mockResolvedValueOnce(answer(HTML_EXAMPLE.replaceAll('자료 미연결', '성공')));
    await expect(generateHtmlPage({ complete, input: { prompt: '현황' } })).rejects.toMatchObject({ code: 'html_generation_invalid', issues: [expect.objectContaining({ code: 'data_state_missing' })] });
  });

  it('does not call the model for unregistered references or aborted work', async () => {
    const complete = vi.fn();
    await expect(generateHtmlPage({ complete, input: { prompt: '현황', referenceIds: ['unknown-external-url'] } })).rejects.toMatchObject({ statusCode: 400 });
    const abort = new AbortController(); abort.abort();
    await expect(generateHtmlPage({ complete, input: { prompt: '현황' }, signal: abort.signal })).rejects.toBeDefined();
    expect(complete).not.toHaveBeenCalled();
  });

  it('does not turn provider errors into fabricated HTML or a successful template fallback', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('provider unavailable'));
    await expect(generateHtmlPage({ complete, input: { prompt: '현황' } })).rejects.toThrow('provider unavailable');
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
