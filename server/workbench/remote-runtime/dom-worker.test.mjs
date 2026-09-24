import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReactPackageSet, compileReactPreview } from '../react-compiler.mjs';
import { RemoteDomFrameSchema } from '../../../shared/workbench-remote-dom.mjs';

const source = { title: 'Native DOM synthetic fixture', code: `import React,{useState} from 'react';
export default function App(){const[q,setQ]=useState('');const[checked,setChecked]=useState(false);const[choice,setChoice]=useState('a');const[submitted,setSubmitted]=useState(0);const[clicks,setClicks]=useState(0);const[compositions,setCompositions]=useState('');return <main className="p-4 font-sans bg-slate-50 rounded-xl shadow-sm"><h1 className="text-2xl font-bold">원본 React 표</h1><form onSubmit={e=>{e.preventDefault();setSubmitted(n=>n+1)}}><label htmlFor="search">검색</label><input id="search" name="query" required value={q} onChange={e=>setQ(e.target.value)} onCompositionStart={()=>setCompositions(v=>v+'S')} onCompositionEnd={()=>setCompositions(v=>v+'E')}/><label><input type="checkbox" checked={checked} onChange={e=>setChecked(e.target.checked)}/>활성만</label><select aria-label="분류" value={choice} onChange={e=>setChoice(e.target.value)}><option value="a">전체</option><option value="b">계약</option></select><button className="rounded-full bg-blue-600 text-white px-4 py-2" type="submit" onClick={()=>setClicks(n=>n+1)}>제출</button></form><p role="status">상태 {q}|{String(checked)}|{choice}|{submitted}|{clicks}|{compositions}</p><table><thead><tr><th>사업</th><th>금액</th></tr></thead><tbody>{['가나다','한글'].filter(name=>name.includes(q)).map(name=><tr key={name}><td>{name}</td><td>100</td></tr>)}</tbody></table></main>}` };
let directory, packages;
const children = [];
async function renderer(input = source) {
  const artifact = await compileReactPreview(input), sessionId = randomUUID();
  const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import{runRendererWorker}from${JSON.stringify(worker)};await runRendererWorker({packageFile:${JSON.stringify(packages)}})`], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
  const reader = createInterface({ input: child.stdout }), waits = new Map(); let errors = '';
  child.stderr.on('data', value => { errors += value.toString(); });
  reader.on('line', value => { const message = JSON.parse(value), wait = waits.get(message.requestId); if (wait) { waits.delete(message.requestId); clearTimeout(wait.timer); wait.resolve(message); } });
  const send = (message) => new Promise((resolve, reject) => { const requestId = randomUUID(); const timer = setTimeout(() => reject(new Error(`renderer timed out: ${errors.slice(0, 500)}`)), 10000); waits.set(requestId, { resolve, timer }); child.stdin.write(JSON.stringify({ ...message, requestId })+'\n'); });
  let frame = await send({ type: 'init', viewMode: 'dom', sessionId, sourceHash: artifact.sourceHash, viewport: { width: 640, height: 480 }, artifact });
  const normalize = (value) => { const { type, requestId, ...rest } = value; return rest; };
  return { get frame() { return normalize(frame); }, get nodes() { return frame.snapshot?.nodes || []; },
    async event(nodeId, body) { const previous = frame; frame = await send({ type: 'event', event: { sessionId, sourceHash: artifact.sourceHash, documentEpoch: frame.documentEpoch, nodeId, baseRevision: frame.snapshot.revision, eventId: randomUUID(), ...body } }); return { previous: normalize(previous), current: normalize(frame) }; },
    async raw(event) { return send({ type: 'event', event }); },
  };
}
const text = (view) => view.nodes.filter(node => node.kind === 'text').map(node => node.text).join('');
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'axr-dom-worker-')); packages = join(directory, 'packages.json'); await writeFile(packages, JSON.stringify(await getReactPackageSet())); });
afterAll(async () => { await Promise.all(children.map(async child => { if (child.exitCode !== null) return; const closed = new Promise(resolve => child.once('close', resolve)); child.stdin.end(); const timer = setTimeout(() => child.kill('SIGKILL'), 2000); await closed; clearTimeout(timer); })); await rm(directory, { recursive: true, force: true }); });

describe('actual generated React DOM over local CDP (not Docker isolation or OS IME proof)', () => {
  it('preserves headings, table, labels and Tailwind styles from the original rendered DOM', async () => {
    const view = await renderer(); expect(view.frame.kind, JSON.stringify(view.frame.unsupported)).toBe('dom'); expect(RemoteDomFrameSchema.safeParse(view.frame).success).toBe(true);
    expect(view.nodes.some(node => node.tag === 'h1')).toBe(true); expect(view.nodes.some(node => node.tag === 'table')).toBe(true);
    const label = view.nodes.find(node => node.tag === 'label' && node.attributes.for); expect(view.nodes.find(node => node.id === label.attributes.for)?.tag).toBe('input');
    expect(view.nodes.find(node => node.tag === 'main').style['padding-top']).toBe('16px'); expect(text(view)).toContain('한글');
  });
  it('applies text filtering, checkbox and select through actual React state and returns matching input ACKs', async () => {
    const view = await renderer(), input = view.nodes.find(node => node.control?.type === 'text');
    await view.event(input.id, { type: 'input', value: '한', inputType: 'insertText', data: '한', selectionStart: 1, selectionEnd: 1, inputRevision: 1 });
    expect(view.frame.snapshot.ack.inputRevision).toBe(1); expect(view.nodes.find(node => node.id === input.id).control.value).toBe('한'); expect(text(view)).not.toContain('가나다');
    await view.event(view.nodes.find(node => node.control?.type === 'checkbox').id, { type: 'check', checked: true, inputRevision: 1 });
    await view.event(view.nodes.find(node => node.tag === 'select').id, { type: 'select', values: ['b'], inputRevision: 1 });
    expect(text(view)).toContain('상태 한|true|b|0|0|');
  });
  it('runs button onClick once and remote validation before onSubmit, and allows a valid submit once', async () => {
    const view = await renderer(), button = view.nodes.find(node => node.tag === 'button');
    await view.event(button.id, { type: 'click' }); expect(text(view)).toContain('상태 |false|a|0|1|');
    const input = view.nodes.find(node => node.control?.type === 'text');
    await view.event(input.id, { type: 'input', value: '가', inputType: 'insertText', data: '가', selectionStart: 1, selectionEnd: 1, inputRevision: 1 });
    await view.event(button.id, { type: 'click' }); expect(text(view)).toContain('상태 가|false|a|1|2|');
  });
  it('supports real CDP Korean composition and insertion inside an existing controlled value', async () => {
    const view = await renderer(), input = view.nodes.find(node => node.control?.type === 'text');
    await view.event(input.id, { type: 'input', value: 'AB', inputType: 'insertText', data: 'AB', selectionStart: 1, selectionEnd: 1, inputRevision: 1 });
    await view.event(input.id, { type: 'composition', phase: 'start', text: '', selectionStart: 1, selectionEnd: 1, inputRevision: 2 });
    await view.event(input.id, { type: 'composition', phase: 'update', text: 'ㅎ', selectionStart: 1, selectionEnd: 1, inputRevision: 3 });
    await view.event(input.id, { type: 'composition', phase: 'update', text: '한', selectionStart: 1, selectionEnd: 1, inputRevision: 4 });
    await view.event(input.id, { type: 'composition', phase: 'end', text: '한', selectionStart: 1, selectionEnd: 1, inputRevision: 5 });
    expect(view.nodes.find(node => node.id === input.id).control.value).toBe('A한B'); expect(text(view)).toContain('|SE'); expect(view.frame.snapshot.ack.inputRevision).toBe(5);
  });
  it('cancels Korean composition without losing the previous value and keeps a valid keyboard target', async () => {
    const view = await renderer(), input = view.nodes.find(node => node.control?.type === 'text');
    await view.event(input.id, { type: 'input', value: 'AB', inputType: 'insertText', data: 'AB', selectionStart: 1, selectionEnd: 1, inputRevision: 1 });
    await view.event(input.id, { type: 'composition', phase: 'start', text: '', selectionStart: 1, selectionEnd: 1, inputRevision: 2 });
    await view.event(input.id, { type: 'composition', phase: 'update', text: '한', selectionStart: 1, selectionEnd: 1, inputRevision: 3 });
    await view.event(input.id, { type: 'composition', phase: 'cancel', text: '', selectionStart: 0, selectionEnd: 0, inputRevision: 4 });
    expect(view.nodes.find(node => node.id === input.id).control.value).toBe('AB');
    await view.event(input.id, { type: 'key', key: 'End' });
    expect(view.frame.snapshot.focusedNodeId).toBe(input.id); expect(view.nodes.find(node => node.id === input.id).control.selectionEnd).toBe(2);
  });
  it('rejects a removed node and resumes the same session using its current node map', async () => {
    const view = await renderer({ title: 'Removed input fixture', code: `import React,{useState} from 'react';export default function App(){const[shown,setShown]=useState(true);return <main><button onClick={()=>setShown(v=>!v)}>전환</button>{shown?<input aria-label="변경 입력"/>:null}</main>}` });
    const input = view.nodes.find(node => node.tag === 'input'), button = view.nodes.find(node => node.tag === 'button');
    await view.event(button.id, { type: 'click' });
    const response = await view.raw({ type: 'focus', eventId: randomUUID(), sessionId: view.frame.sessionId, sourceHash: view.frame.sourceHash, documentEpoch: view.frame.documentEpoch, baseRevision: view.frame.snapshot.revision, nodeId: input.id });
    expect(response).toMatchObject({ type: 'error', code: 'remote_dom_node_changed', recoverable: true });
    await view.event(button.id, { type: 'click' }); expect(view.nodes.find(node => node.tag === 'input').id).not.toBe(input.id);
  });
  it('ignores generated main-world getter and serializer replacements when copying native input state', async () => {
    const view = await renderer({ title: 'Prototype fixture', code: `import React,{useEffect} from 'react';export default function App(){useEffect(()=>{window.getComputedStyle=()=>{throw Error('forged')};Object.defineProperty(HTMLInputElement.prototype,'value',{get(){return 'FORGED'},set(){}});JSON.stringify=()=> 'FORGED';},[]);return <main><h1>실제 제목</h1><input defaultValue="ACTUAL" readOnly/></main>}` });
    expect(view.frame.kind, JSON.stringify(view.frame.unsupported)).toBe('dom'); expect(view.nodes.find(node => node.tag === 'input').control.value).toBe('ACTUAL'); expect(text(view)).toContain('실제 제목');
  });
  it('explicitly falls back for unsupported canvas instead of reporting omitted content as a normal DOM view', async () => {
    const view = await renderer({ title: 'Unsupported fixture', code: `import React from 'react';export default function App(){return <main><h1>그래프</h1><canvas width={100} height={100}/></main>}` });
    expect(view.frame.kind).toBe('png'); expect(view.frame.unsupported.some(issue => issue.code === 'dom_element_unsupported')).toBe(true); expect(view.frame.pngBase64.startsWith('iVBORw0KGgo')).toBe(true);
  });
});
