import { describe, expect, it } from 'vitest';
import { resolveHtmlBindings } from './html-bindings.mjs';

const template = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>검토</title></head><body><main><section data-evidence="projects"></section><p data-binding="amount"></p></main></body></html>';
const evidence = [{ evidenceId: 'projects', columns: [{ name: 'project', label: '프로젝트' }, { name: 'amount', label: '금액' }], rows: [{ project: '<img src=x>', amount: 0 }, { project: null, amount: 12 }], metadata: { provenance: '프로젝트 원장', asOf: '2026-09-22', completeness: '완료' } }];
const bindings = { amount: { evidenceId: 'projects', kind: 'value', row: 0, column: 'amount' } };

describe('HTML evidence bindings', () => {
  it('renders verified evidence as escaped server-owned table and text while preserving template lineage', () => {
    const result = resolveHtmlBindings({ title: '검토', html: template, bindings }, evidence);
    expect(result).toMatchObject({ template: { title: '검토', html: template }, bindings, evidenceIds: ['projects'] });
    expect(result.source.html).toContain('&lt;img src=x&gt;');
    expect(result.source.html).toContain('>0<');
    expect(result.source.html).toContain('자료 없음');
    expect(result.source.html).toContain('출처: 프로젝트 원장 · 기준 시각: 2026-09-22 · 완전성: 완료');
    expect(result.source.html).not.toContain('data-evidence');
    expect(result.source.html).not.toContain('data-binding');
  });

  it.each([
    ['unknown evidence marker', template.replace('projects', 'unknown'), bindings],
    ['unknown binding marker', template.replace('amount', 'missing'), bindings],
    ['unknown column', template, { amount: { evidenceId: 'projects', kind: 'value', row: 0, column: 'nope' } }],
    ['unknown row', template, { amount: { evidenceId: 'projects', kind: 'value', row: 4, column: 'amount' } }],
    ['extra execution field', template, { amount: { evidenceId: 'projects', kind: 'value', row: 0, column: 'amount', execute: 'write' } }],
  ])('rejects %s', (_, html, nextBindings) => {
    expect(() => resolveHtmlBindings({ title: '검토', html, bindings: nextBindings }, evidence)).toThrow();
  });

  it('requires the evidence placeholder to be a section and does not accept unresolved unsafe HTML', () => {
    expect(() => resolveHtmlBindings({ title: '검토', html: template.replace('<section', '<div').replace('</section>', '</div>'), bindings }, evidence)).toThrow('binding_marker_invalid');
    expect(() => resolveHtmlBindings({ title: '검토', html: template.replace('</body>', '<script>bad()</script></body>'), bindings }, evidence)).toThrow('binding_resolved_html_invalid');
  });
});
