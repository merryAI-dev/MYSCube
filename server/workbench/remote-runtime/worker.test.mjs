import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getReactPackageSet, compileReactPreview } from '../react-compiler.mjs';

// Local fixtures exercise protocol/React behavior, never the Docker isolation guarantee.
describe('local renderer protocol and actual React DOM (not isolation proof)', () => {
  let directory, process, reader; const messages = []; const waiters = [];
  const waitFor = (match) => new Promise((resolve, reject) => {
    const existing = messages.find(match); if (existing) { resolve(existing); return; }
    const timer = setTimeout(() => reject(new Error('renderer protocol timeout')), 12000);
    waiters.push({ match, resolve: value => { clearTimeout(timer); resolve(value); } });
  });
  const send = message => process.stdin.write(JSON.stringify(message) + '\n');
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'axr-renderer-fixture-')); const file = join(directory, 'packages.json');
    await writeFile(file, JSON.stringify(await getReactPackageSet()));
    const worker = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', `import { runRendererWorker } from ${JSON.stringify(worker)}; await runRendererWorker({packageFile:${JSON.stringify(file)}});`], { stdio: ['pipe', 'pipe', 'pipe'] });
    reader = createInterface({ input: process.stdout });
    reader.on('line', line => { const message = JSON.parse(line); messages.push(message); for (const waiter of [...waiters]) if (waiter.match(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); } });
  });
  afterAll(async () => {
    if (process && process.exitCode === null) {
      const exited = new Promise(resolve => process.once('exit', resolve));
      process.stdin.end();
      const timer = setTimeout(() => process.kill('SIGKILL'), 3000);
      await exited; clearTimeout(timer);
    }
    reader?.close(); if (directory) await rm(directory, { recursive: true, force: true });
  });
  it('renders styled React, routes two live state changes through IPC and emits changed PNG frames', async () => {
    const apiId = '11111111-1111-4111-8111-111111111111';
    const source = { title: 'Synthetic local fixture', code: `import React,{useState} from 'react'; export default function App(){const[n,setN]=useState(0);return <button className="bg-blue-600 text-white p-4" style={{position:'absolute',left:20,top:20}} onClick={()=>{setN(n+1);window.workbench.callApi('${apiId}',{count:n+1});}}>Counter {n}</button>}` };
    const artifact = await compileReactPreview(source);
    send({ type: 'init', requestId: 'initialize', viewport: { width: 640, height: 480 }, artifact });
    const first = await waitFor(message => ['frame','error'].includes(message.type) && message.requestId === 'initialize');
    expect(first.type, JSON.stringify(first)).toBe('frame'); expect(first.pngBase64.startsWith('iVBORw0KGgo')).toBe(true);
    for (let count = 1; count <= 2; count++) {
      send({ type: 'event', requestId: `click-${count}`, event: { type: 'click', x: 50, y: 40 } });
      const api = await waitFor(message => message.type === 'api-call' && message.input.count === count);
      send({ type: 'api-result', requestId: api.requestId, ok: true, result: { data: { value: 0 } } });
      const frame = await waitFor(message => message.type === 'frame' && message.requestId === `click-${count}`);
      expect(frame.sequence).toBe(count + 1); expect(frame.pngBase64).not.toBe(first.pngBase64);
    }
  });
});
