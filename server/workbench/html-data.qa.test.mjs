import { describe, expect, it, vi } from 'vitest';
import { createHtmlDataPolicy } from './html-data.mjs';
import { resolveHtmlBindings } from './html-bindings.mjs';

const template = { title: '근거 화면', html: '<!doctype html><html><head><meta name="viewport" content="width=device-width"></head><body><section data-binding="actual"></section></body></html>' };
const evidence = { evidenceId: 'evidence-a', columns: [{ name: 'amount', type: 'number' }], rows: [{ amount: 0 }], metadata: { asOf: '2026-09-22', completeness: 'partial' } };
const definitions = { actual: { evidenceId: evidence.evidenceId, kind: 'table' } };
function fixture() {
  const context = { actorId: 'a', tenantId: 't', analyticsScope: { fingerprint: 'scope-v1' } };
  const resolved = resolveHtmlBindings({ ...template, bindings: definitions }, [evidence]);
  const binding = { template, bindings: definitions, scopeFingerprint: 'scope-v1' };
  const analytics = { evidence: vi.fn().mockResolvedValue(evidence) };
  const authorize = vi.fn().mockResolvedValue(undefined);
  return { context, binding, resolved, analytics, authorize, check: createHtmlDataPolicy({ analytics, authorize }) };
}

describe('independent HTML data policy QA', () => {
  it('re-reads authorized evidence and preserves explicit zero and provenance in exact bound source', async () => {
    const f = fixture();
    const result = await f.check(f.context, f.binding, f.resolved.source);
    expect(f.analytics.evidence).toHaveBeenCalledWith(f.context, 'evidence-a');
    expect(f.authorize).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ evidenceIds: ['evidence-a'], scopeFingerprint: 'scope-v1' });
    expect(f.resolved.source.html).toContain('<td>0</td>');
    expect(f.resolved.source.html).toContain('완전성: partial');
  });
  it('rejects an old permission fingerprint before evidence lookup', async () => {
    const f = fixture();
    await expect(f.check(f.context, { ...f.binding, scopeFingerprint: 'old-grant' }, f.resolved.source)).rejects.toMatchObject({ statusCode: 403, code: 'html_data_scope_changed' });
    expect(f.analytics.evidence).not.toHaveBeenCalled();
  });
  it.each(['html', 'title'])('rejects altered source %s instead of keeping a verified-data claim', async (field) => {
    const f = fixture();
    const changed = { ...f.resolved.source, [field]: field === 'html' ? f.resolved.source.html.replace('<td>0</td>', '<td>9000</td>') : '다른 자료' };
    await expect(f.check(f.context, f.binding, changed)).rejects.toMatchObject({ statusCode: 409, code: 'html_binding_changed' });
  });
  it('propagates evidence owner/tenant refusal without returning bound data', async () => {
    const f = fixture(); f.analytics.evidence.mockRejectedValue(Object.assign(new Error('forbidden evidence'), { statusCode: 403 }));
    await expect(f.check(f.context, f.binding, f.resolved.source)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('withholds the resolved source when permissions change during evidence read', async () => {
    const f = fixture();
    f.analytics.evidence.mockImplementation(async () => { f.authorize.mockRejectedValue(Object.assign(new Error('scope changed'), { statusCode: 403 })); return evidence; });
    await expect(f.check(f.context, f.binding, f.resolved.source)).rejects.toMatchObject({ statusCode: 403 });
  });
  it('does not silently replace saved numeric content if the evidence reader returns changed rows', async () => {
    const f = fixture(); f.analytics.evidence.mockResolvedValue({ ...evidence, rows: [{ amount: 200 }] });
    await expect(f.check(f.context, f.binding, f.resolved.source)).rejects.toMatchObject({ code: 'html_binding_changed' });
  });
  it('rejects a binding pointing at an unreturned evidence ID', async () => {
    const f = fixture();
    await expect(f.check(f.context, { ...f.binding, bindings: { actual: { evidenceId: 'foreign-evidence', kind: 'table' } } }, f.resolved.source)).rejects.toMatchObject({ code: 'html_binding_invalid' });
  });
});
