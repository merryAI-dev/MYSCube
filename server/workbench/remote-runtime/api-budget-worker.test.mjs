import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { runRendererWorker } from './worker.mjs';
import { createRemoteRuntimeBroker } from './broker.mjs';
import { compileReactPreview, getReactPackageSet } from '../react-compiler.mjs';
import { digest } from './contract.mjs';

const company = '11111111-1111-4111-8111-111111111111', ordinary = '22222222-2222-4222-8222-222222222222';
let directory, packageFile;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), 'axr-api-budget-')); packageFile = join(directory, 'packages.json'); await writeFile(packageFile, JSON.stringify(await getReactPackageSet())); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

describe('worker API deadline policy with controlled time (browser mock)', () => {
  it('enforces 10/55s independently, rejects undeclared calls and drops late responses', async () => {
    const artifact = { runtimeVersion: 'react-preview-v1', bundle: 'void 0;', css: '', sourceHash: 'a'.repeat(64), packageSetHash: (await getReactPackageSet()).packageSetHash, bundleHash: digest('void 0;'), cssHash: digest('') };
    let binding; const output = new PassThrough(), input = new PassThrough(), messages = [];
    output.on('data', value => messages.push(...value.toString().trim().split('\n').map(JSON.parse)));
    const page = { setDefaultTimeout() {}, on() {}, exposeBinding: async (_name, value) => { binding = value; }, setContent: async () => {}, evaluate: async () => {}, locator: () => ({ waitFor: async () => {} }), screenshot: async () => Buffer.from('fixture') };
    const browser = { close: vi.fn(async () => {}), newContext: async () => ({ route: async () => {}, on() {}, newPage: async () => page }) };
    vi.useFakeTimers(); const worker = await runRendererWorker({ input, output, packageFile, launch: async () => browser });
    try {
      input.write(JSON.stringify({ type: 'init', requestId: 'init', artifact, apiIds: [company, ordinary], apiBudgets: { [company]: 55000, [ordinary]: 10000 } }) + '\n');
      await vi.advanceTimersByTimeAsync(0); expect(messages.at(-1).type, JSON.stringify(messages.at(-1))).toBe('frame');
      let longSettled = false; const longCall = binding(null, company, {});
      void longCall.then(() => { longSettled = true; }, () => { longSettled = true; });
      const long = expect(longCall).rejects.toThrow('응답 시간이');
      const short = expect(binding(null, ordinary, {})).rejects.toThrow('응답 시간이');
      await expect(binding(null, randomUUID(), {})).rejects.toThrow('허용되지');
      await vi.advanceTimersByTimeAsync(10000); await short;
      const late = messages.find(message => message.type === 'api-call' && message.apiId === ordinary);
      input.write(JSON.stringify({ type: 'api-result', requestId: late.requestId, ok: true, result: { late: true } }) + '\n');
      await vi.advanceTimersByTimeAsync(44999); expect(longSettled).toBe(false); expect(browser.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); await long; expect(longSettled).toBe(true); expect(browser.close).not.toHaveBeenCalled();
    } finally { await worker.close(); vi.useRealTimers(); input.destroy(); output.destroy(); }
  });
});

describe('actual React + worker + broker local IPC (no Docker or live API claims)', () => {
  it('renders a company response after 10s while an ordinary call expires and native events continue', async () => {
    const apis = [company, ordinary].map(id => ({ id, version: 1, definition: { kind: 'external-read', parameters: {} }, responseKind: 'external-read', responseSchema: { type: 'object', properties: { value: { type: 'string', maxLength: 20 } }, required: ['value'], additionalProperties: false } }));
    const artifact = await compileReactPreview({ title: 'Synthetic deadline fixture', code: `import React,{useEffect,useState} from 'react';export default function App(){const[a,A]=useState('company waiting');const[b,B]=useState('ordinary waiting');const[n,N]=useState(0);useEffect(()=>{void window.workbench.callApi('${company}',{}).then(r=>A(r.data.value),()=>A('company expired'));void window.workbench.callApi('${ordinary}',{}).then(r=>B(r.data.value),()=>B('ordinary expired'));},[]);return <main><p>{a}</p><p>{b}</p><button onClick={()=>N(n+1)}>Count {n}</button></main>}` }, { apis });
    const children = [], timers = [], signals = new Map();
    const workerFile = fileURLToPath(new URL('./worker.mjs', import.meta.url));
    const spawnDocker = args => {
      if (args[0] !== 'run') { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => true; queueMicrotask(() => child.emit('close', 0)); return child; }
      const child = spawn(process.execPath, ['--input-type=module', '-e', `import{runRendererWorker}from${JSON.stringify(workerFile)};await runRendererWorker({packageFile:${JSON.stringify(packageFile)}})`], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child); return child;
    };
    const broker = createRemoteRuntimeBroker({ authorize: async () => {}, spawnDocker, callApi: async (_context, { apiId, signal }) => {
      signals.set(apiId, signal);
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('synthetic aborted')), { once: true });
        if (apiId === company) timers.push(setTimeout(() => resolve({ data: { value: 'company completed' } }), 11200));
      });
    } });
    const context = { tenantId: `synthetic-${randomUUID()}`, actorId: 'fixture', analyticsScope: { fingerprint: 'fixture' } };
    try {
      const created = await broker.create(context, { artifact, sourceHash: artifact.sourceHash, apiBindings: apis.map(({ id, version }) => ({ id, version })), apiBudgets: { [company]: 55000, [ordinary]: 10000 }, viewMode: 'dom' });
      const button = created.frame.snapshot.nodes.find(node => node.tag === 'button');
      const frame = await broker.event(context, created.sessionId, { type: 'click', sessionId: created.sessionId, sourceHash: artifact.sourceHash, documentEpoch: created.frame.documentEpoch, nodeId: button.id, eventId: randomUUID(), baseRevision: created.frame.snapshot.revision });
      const text = value => value.snapshot.nodes.filter(node => node.kind === 'text').map(node => node.text).join(' ').replace(/\s+/g, ' ');
      expect(text(frame)).toContain('Count 1'); expect(text(frame)).toContain('company waiting');
      await vi.waitFor(async () => {
        const value = await broker.frame(context, created.sessionId);
        expect(text(value)).toContain('company completed'); expect(text(value)).toContain('ordinary expired'); expect(text(value)).toContain('Count 1');
      }, { timeout: 14000, interval: 300 });
      expect(signals.get(ordinary).aborted).toBe(true); expect(signals.get(company).aborted).toBe(false);
      expect(broker.activeSessions).toBe(1); await broker.close(context, created.sessionId); expect(broker.activeSessions).toBe(0);
    } finally {
      broker.shutdown(); for (const timer of timers) clearTimeout(timer);
      await Promise.all(children.map(child => child.exitCode !== null ? undefined : new Promise(resolve => { child.once('close', resolve); child.kill('SIGKILL'); })));
    }
  });
});
