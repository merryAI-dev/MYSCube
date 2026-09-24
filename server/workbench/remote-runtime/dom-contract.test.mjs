import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RemoteDomFrameSchema, RemoteDomEventSchema, isRemoteDomStyleValue } from '../../../shared/workbench-remote-dom.mjs';
import { checkDomEvent } from './dom-events.mjs';
import { domFrame, domEvent, domNodeId as id } from './dom-test-fixtures.mjs';

describe('untrusted DOM transport rejects unsafe structure/styles and wrong event identities', () => {
  it('keeps the browser declaration generated from the runtime schema and bundles its renderer dependencies', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-dom-declaration-'));
    try {
      await promisify(execFile)(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--allowJs', '--declaration', '--emitDeclarationOnly', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', '--skipLibCheck', '--outDir', directory, 'shared/workbench-remote-dom.mjs']);
      expect(await readFile(join(directory, 'workbench-remote-dom.d.mts'), 'utf8')).toBe(await readFile('shared/workbench-remote-dom.d.mts', 'utf8'));
      const dockerfile = await readFile('server/workbench/remote-runtime/Dockerfile', 'utf8');
      expect(dockerfile).toContain('COPY shared/workbench-remote-dom.mjs ./shared/workbench-remote-dom.mjs');
      expect(dockerfile).toContain('server/workbench/remote-runtime/dom-snapshot.mjs server/workbench/remote-runtime/dom-events.mjs');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('accepts an explicit bounded native DOM frame and its button event', () => { const frame = domFrame(); expect(RemoteDomFrameSchema.safeParse(frame).success).toBe(true); expect(checkDomEvent(domEvent(frame), frame).type).toBe('click'); });
  it('accepts bounded viewport-only events and rejects node fields, stale sequences and unsafe dimensions',()=>{
    const frame=domFrame(),event={type:'resize',eventId:randomUUID(),sessionId:frame.sessionId,sourceHash:frame.sourceHash,documentEpoch:frame.documentEpoch,baseSequence:frame.sequence,baseRevision:frame.snapshot.revision,width:340,height:700};
    expect(checkDomEvent(event,frame)).toEqual(event);expect(RemoteDomEventSchema.safeParse({...event,nodeId:frame.snapshot.rootNodeId}).success).toBe(false);
    for(const width of [319,1601,NaN,340.5])expect(RemoteDomEventSchema.safeParse({...event,width}).success).toBe(false);
    expect(()=>checkDomEvent({...event,baseSequence:frame.sequence+1},frame)).toThrow();
  });
  it.each(['script', 'url', 'css-url', 'css-filter', 'duplicate', 'cycle', 'extra-root', 'reference', 'fake-focus', 'control-mismatch', 'span-size', 'autofill', 'pattern', 'positive-tab'])('rejects %s from the renderer boundary', (kind) => {
    const frame = domFrame(), node = frame.snapshot.nodes[1];
    if (kind === 'script') node.tag = 'script';
    if (kind === 'url') node.attributes.src = 'https://outside.invalid';
    if (kind === 'css-url') node.style['background-color'] = 'url(https://outside.invalid)';
    if (kind === 'css-filter') node.style.filter = 'blur(999px)';
    if (kind === 'duplicate') frame.snapshot.nodes.push(structuredClone(node));
    if (kind === 'cycle') node.parentId = node.id;
    if (kind === 'extra-root') node.parentId = null;
    if (kind === 'reference') node.attributes['aria-labelledby'] = id('f');
    if (kind === 'fake-focus') frame.snapshot.focusedNodeId = id('f');
    if (kind === 'control-mismatch') frame.snapshot.nodes[2].control.type = 'select';
    if (kind === 'span-size') node.attributes.colspan = '999999';
    if (kind === 'autofill') node.attributes.autocomplete = 'email';
    if (kind === 'pattern') node.attributes.pattern = '(a+)+$';
    if (kind === 'positive-tab') node.attributes.tabindex = '1';
    expect(RemoteDomFrameSchema.safeParse(frame).success).toBe(false);
  });
  it.each(['sessionId', 'sourceHash', 'documentEpoch', 'baseRevision', 'nodeId'])('rejects stale or wrong %s before native commands', (field) => {
    const frame = domFrame(), event = domEvent(frame, { [field]: { sessionId: randomUUID(), sourceHash: 'b'.repeat(64), documentEpoch: randomUUID(), baseRevision: 2, nodeId: id('f') }[field] });
    expect(() => checkDomEvent(event, frame)).toThrow();
  });
  it('rejects read-only/disabled/type-invalid controls and invalid UTF-16 selections', () => {
    const frame = domFrame(), node = frame.snapshot.nodes[2]; node.control.readOnly = true;
    const input = domEvent(frame, { nodeId: node.id, type: 'input', value: 'A', inputType: 'insertText', data: 'A', selectionStart: 1, selectionEnd: 1, inputRevision: 1 });
    expect(() => checkDomEvent(input, frame)).toThrow(/입력/); node.control.readOnly = false; node.control.disabled = true;
    expect(() => checkDomEvent(input, frame)).toThrow(/사용/); node.control.disabled = false;
    expect(RemoteDomEventSchema.safeParse({ ...input, selectionEnd: 2 }).success).toBe(false);
    expect(() => checkDomEvent(domEvent(frame, { nodeId: node.id, type: 'check', checked: true, inputRevision: 1 }), frame)).toThrow();
  });
  it('rejects oversized cumulative layout and asymmetric null selections', () => {
    const frame = domFrame();
    frame.snapshot.nodes[0].style = { width: '4096px', height: '4096px' };
    expect(RemoteDomFrameSchema.safeParse(frame).success).toBe(false);
    const clean = domFrame(); clean.snapshot.nodes[2].control.selectionEnd = null;
    expect(RemoteDomFrameSchema.safeParse(clean).success).toBe(false);
    const hidden = domFrame(); hidden.snapshot.nodes[0].style.display = 'none';
    expect(() => checkDomEvent(domEvent(hidden), hidden)).toThrow(/보이지/);
  });
  it('allows bounded computed Tailwind color and refuses resource-bearing values and extreme sizes', () => {
    expect(isRemoteDomStyleValue('background-color', 'oklch(0.546 0.245 262.881)')).toBe(true);
    for (const value of ['url(x)', 'var(--x)', 'expression(x)', '1px;position:fixed', '999999px']) expect(isRemoteDomStyleValue('width', value)).toBe(false);
  });
});
