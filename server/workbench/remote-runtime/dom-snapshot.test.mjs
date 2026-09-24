import { chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDomSnapshot } from './dom-snapshot.mjs';
let browser;
beforeAll(async () => { browser = await chromium.launch({ headless: true }); });
afterAll(async () => { await browser?.close(); });
async function sample(html, action) {
  const context = await browser.newContext(); await context.route('**/*', route => route.abort()); const page = await context.newPage();
  try {
    await page.setContent('<div id="root"></div>'); const cdp = await context.newCDPSession(page), { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#root' }), { node } = await cdp.send('DOM.describeNode', { nodeId });
    const { frameTree } = await cdp.send('Page.getFrameTree'); const dom = await createDomSnapshot({ cdp, frameId: frameTree.frame.id, rootBackendNodeId: node.backendNodeId });
    await page.evaluate(value => { document.getElementById('root').innerHTML = value; }, html);
    if (action) await action(page); return await dom.capture();
  } finally { await context.close(); }
}
describe('bounded CDP snapshot of actual native DOM', () => {
  it('preserves hidden vs display-contents and native selected option state', async () => {
    const value = await sample('<main><span style="display:none">숨김</span><div style="display:contents"><b>표시</b></div><select><option value="a">A</option><option value="b" selected>B</option></select></main>');
    expect(value.unsupported).toBeUndefined(); expect(value.snapshot.nodes.find(node => node.tag === 'span').style.display).toBe('none');
    expect(value.snapshot.nodes.find(node => node.tag === 'div' && node.parentId !== null).style.display).toBe('contents');
    expect(value.snapshot.nodes.find(node => node.tag === 'select').control.selectedValues).toEqual(['b']);
  });
  it.each([
    ['external', '<main><img src="https://outside.invalid/leak"></main>'],
    ['background', '<main style="background-image:url(https://outside.invalid)">내용</main>'],
    ['text-mask', '<input value="masked-value" style="-webkit-text-security:disc">'], ['content-hidden', '<div style="content-visibility:hidden">숨은 내용</div>'], ['canvas', '<canvas></canvas>'], ['password', '<input type="password" value="synthetic">'], ['file', '<input type="file">'],
    ['pattern', '<input pattern="(a+)+$">'], ['broken-label', '<label for="missing">입력</label>'],
    ['span-budget', '<table><tr><td colspan="99999999">내용</td></tr></table>'],
  ])('returns an explicit unsupported result for %s instead of a partial normal screen', async (_kind, html) => { expect((await sample(html)).unsupported.length).toBeGreaterThan(0); });
  it('refuses closed shadow DOM, portals and pseudoelements instead of silently losing them', async () => {
    const shadow = await sample('<div id="shadow"></div>', page => page.evaluate(() => { document.getElementById('shadow').attachShadow({ mode: 'closed' }).innerHTML = '<b>숨은 요소</b>'; }));
    expect(shadow.unsupported).toBeDefined();
    const portal = await sample('<main>원본</main>', page => page.evaluate(() => { const node = document.createElement('aside'); node.textContent = '포털'; document.body.append(node); }));
    expect(portal.unsupported[0].code).toBe('dom_portal_unsupported');
    const pseudo = await sample('<p>본문</p>', page => page.addStyleTag({ content: 'p::before{content:"추가"}' })); expect(pseudo.unsupported).toBeDefined();
  });
  it('measures ordinary tables and explicitly rejects a table exceeding the byte budget', async () => {
    const measured = [];
    for (const rows of [10, 20, 50, 100]) {
      const result = await sample(`<table><thead><tr><th>사업</th><th>상태</th><th>금액</th></tr></thead><tbody>${Array.from({ length: rows }, (_, index) => `<tr><td>합성 ${index}</td><td>확인</td><td>100</td></tr>`).join('')}</tbody></table>`);
      measured.push({ rows, bytes: result.snapshot ? Buffer.byteLength(JSON.stringify(result.snapshot)) : null, nodes: result.snapshot?.nodes.length ?? null, unsupported: Boolean(result.unsupported) });
    }
    expect(measured[0].unsupported).toBe(false); expect(measured.at(-1).unsupported).toBe(true);
    console.log(JSON.stringify({ syntheticTableSnapshotBudget: measured }));
  });
});
