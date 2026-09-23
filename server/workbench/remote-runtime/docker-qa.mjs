import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
import { promisify } from 'node:util';
const execute = promisify(execFile);
import { writeFile } from 'node:fs/promises';
import { compileReactPreview } from '../react-compiler.mjs';
import { createRemoteRuntimeBroker } from './broker.mjs';
import { REMOTE_RUNTIME_IMAGE } from './contract.mjs';

try { execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'ignore' }); }
catch {
  console.log(JSON.stringify({ status: 'SKIP', isolationVerified: false, reason: 'A running Docker daemon is required. Local Playwright tests do not prove isolation.' }));
  process.exit(process.env.REQUIRE_REMOTE_DOCKER_QA === 'true' ? 1 : 0);
}
execFileSync('docker', ['image', 'inspect', REMOTE_RUNTIME_IMAGE], { stdio: 'ignore' });
const calls = [], containers = [], outcomes = [];
let receiverHits = 0, result;
const receiver = http.createServer((_req, res) => { receiverHits++; res.end('external receiver'); }).listen(0, '0.0.0.0');
await new Promise(resolve => receiver.once('listening', resolve));
const gateway = JSON.parse(execFileSync('docker', ['network', 'inspect', 'bridge'], { encoding: 'utf8' }))[0].IPAM.Config.find(item => item.Gateway?.includes('.'))?.Gateway;
assert.match(gateway || '', /^[0-9.]+$/);
const external = `http://${gateway}:${receiver.address().port}/forbidden`;
const apiId = '11111111-1111-4111-8111-111111111111';
const context = actorId => ({ tenantId: 'synthetic-docker-qa', actorId, actorRole: 'admin', analyticsScope: { fingerprint: 'synthetic-only' } });
const spawnDocker = args => { if (args[0] === 'run') containers.push(args[args.indexOf('--name') + 1]); return spawn('docker', args, { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] }); };
const broker = createRemoteRuntimeBroker({ authorize: async value => { assert.equal(value.tenantId, 'synthetic-docker-qa'); }, callApi: async (_context, input) => { calls.push(input); return { data: { ok: true } }; }, spawnDocker });
const compiled = async code => { const artifact = await compileReactPreview({ title: 'Synthetic isolation QA', code }); return { artifact, sourceHash: artifact.sourceHash, apiBindings: [{ id: apiId, version: 1 }], viewport: { width: 640, height: 480 } }; };
try {
  const normal = await compiled(`import React,{useState} from 'react';export default function App(){const[n,setN]=useState(0);return <button style={{position:'absolute',left:20,top:20}} onClick={()=>{setN(n+1);window.workbench.callApi('${apiId}',{count:n+1})}}>Canary {n}</button>}`);
  const coldStart = performance.now();
  const canary = await broker.create(context('canary'), normal);
  const firstFrameMs = Math.round(performance.now() - coldStart);
  const inspected = JSON.parse(execFileSync('docker', ['inspect', `axr-render-${canary.sessionId}`], { encoding: 'utf8' }))[0];
  assert.equal(inspected.HostConfig.NetworkMode, 'none'); assert.equal(inspected.HostConfig.Memory, 512 * 1024 * 1024); assert.equal(inspected.HostConfig.MemorySwap, 512 * 1024 * 1024);
  assert.equal(inspected.HostConfig.NanoCpus, 1000000000); assert.equal(inspected.HostConfig.PidsLimit, 128); assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.Config.User, '10001:10001'); assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']); assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal((inspected.HostConfig.Binds || []).length, 0); assert.equal(inspected.HostConfig.Privileged, false);
  const changed = await broker.event(context('canary'), canary.sessionId, { type: 'click', x: 45, y: 28 });
  assert.notEqual(changed.pngBase64, canary.frame.pngBase64); assert.ok(calls.some(call => call.input.count === 1));
  outcomes.push({ case: 'actual-cgroup-network-filesystem-and-react-click', pass: true, firstFrameMs });
  const rawHttp = `const http=require('node:http');const req=http.get(${JSON.stringify(external)},res=>{res.resume();res.on('end',()=>{console.log(res.statusCode);process.exit(res.statusCode===200?0:1)})});req.setTimeout(1500,()=>req.destroy(new Error('timeout')));req.on('error',()=>process.exit(2));`;
  const control = await execute('docker', ['run', '--rm', '--network', 'bridge', '--entrypoint', 'node', REMOTE_RUNTIME_IMAGE, '-e', rawHttp], { timeout: 10000 });
  assert.equal(control.stdout.trim(), '200'); assert.equal(receiverHits, 1); receiverHits = 0;
  const networkingProbe = `
    const http=require('node:http'),net=require('node:net'),dns=require('node:dns').promises,os=require('node:os');
    const tcp=(host,port)=>new Promise(resolve=>{const socket=net.connect({host,port});let done=false;const end=connected=>{if(done)return;done=true;socket.destroy();resolve({host,connected})};socket.setTimeout(800,()=>end(false));socket.once('connect',()=>end(true));socket.once('error',()=>end(false));});
    (async()=>{
      const resolver=new dns.Resolver({timeout:300,tries:1});let dnsReached=false;try{await resolver.resolve4('example.com');dnsReached=true}catch{}
      const sockets=await Promise.all([tcp(${JSON.stringify(gateway)},${receiver.address().port}),tcp('169.254.169.254',80),tcp('1.1.1.1',443),tcp('2606:4700:4700::1111',443)]);
      const nonLoopback=Object.values(os.networkInterfaces()).flat().filter(item=>!item.internal).length;
      console.log(JSON.stringify({sockets,dnsReached,nonLoopback}));
    })().catch(()=>process.exit(1));`;
  const raw = JSON.parse((await execute('docker', ['exec', `axr-render-${canary.sessionId}`, 'node', '-e', networkingProbe], { timeout: 10000 })).stdout);
  assert.equal(raw.nonLoopback, 0); assert.equal(raw.dnsReached, false); assert.ok(raw.sockets.every(item => item.connected === false)); assert.equal(receiverHits, 0);
  outcomes.push({ case: 'raw-container-egress-with-bridge-positive-control', pass: true, positiveControlHits: 1, receiverHits, ...raw });

  const egress = await compiled(`import React,{useEffect} from 'react';export default function App(){useEffect(()=>{fetch('${external}').catch(()=>window.workbench.callApi('${apiId}',{egressBlocked:true}));},[]);return <p>Network isolation fixture</p>}`);
  const warmStart = performance.now();
  const networking = await broker.create(context('network'), egress);
  const nextSessionFirstFrameMs = Math.round(performance.now() - warmStart);
  for (let attempt = 0; attempt < 20 && !calls.some(call => call.input.egressBlocked === true); attempt++) {
    await broker.frame(context('network'), networking.sessionId); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(calls.some(call => call.input.egressBlocked === true), 'The browser must actually attempt and reject egress');
  assert.equal(receiverHits, 0);
  await broker.close(context('network'), networking.sessionId);
  outcomes.push({ case: 'browser-network-block', pass: true, receiverHits, nextSessionFirstFrameMs });
  for (const [name, attackCode] of [
    ['infinite-loop', 'while(true){}'],
    ['memory-pressure', 'const values=[];while(true){values.push(new Uint8Array(8000000).fill(1));}'],
    ['api-flood', `for(let i=0;i<1000;i++)window.workbench.callApi('${apiId}',{i});`],
  ]) {
    const code = `import React from 'react';export default function App(){return <button style={{position:'absolute',left:20,top:20}} onClick={async()=>{await window.workbench.callApi('${apiId}',{attackStarted:'${name}'});${attackCode}}}>Trigger synthetic attack</button>}`;
    const candidate = await broker.create(context(name), await compiled(code));
    const started = Date.now();
    const attack = broker.event(context(name), candidate.sessionId, { type: 'click', x: 50, y: 28 }).then(value => ({ value }), error => ({ error }));
    const canaryStart = Date.now(); const healthy = await broker.frame(context('canary'), canary.sessionId);
    const canaryLatencyMs = Date.now() - canaryStart; assert.ok(healthy.pngBase64); assert.ok(canaryLatencyMs < 8000);
    const result = await attack;
    assert.ok(calls.some(call => call.input.attackStarted === name), `${name} must execute the attack handler before a rejection counts`);
    if (result.value) { await new Promise(resolve => setTimeout(resolve, 500)); await assert.rejects(broker.frame(context(name), candidate.sessionId)); }
    else assert.ok(['remote_command_timeout', 'remote_exited', 'remote_react_error', 'remote_api_limit'].includes(result.error.code), `${name}: ${result.error.code}`);
    const elapsedMs = Date.now() - started; assert.ok(elapsedMs < 12000);
    assert.ok((await broker.frame(context('canary'), canary.sessionId)).sequence > healthy.sequence);
    outcomes.push({ case: name, pass: true, attackStarted: true, elapsedMs, canaryLatencyMs, termination: result.error?.code || 'terminated-after-first-event', memoryCapInspected: true, kernelOomObserved: false });
  }
  await broker.close(context('canary'), canary.sessionId);
  assert.equal(receiverHits, 0);
  result = { status: 'PASS', isolationVerified: true, image: REMOTE_RUNTIME_IMAGE, imageId: inspected.Image, outcomes };

} finally {
  broker.closeAll(); await new Promise(resolve => receiver.close(resolve));
  for (const name of containers) {
    let remaining;
    const until = Date.now() + 5000;
    do {
      remaining = execFileSync('docker', ['ps', '-aq', '--filter', `name=^/${name}$`], { encoding: 'utf8' }).trim();
      if (remaining) await new Promise(resolve => setTimeout(resolve, 100));
    } while (remaining && Date.now() < until);
    assert.equal(remaining, '', `Renderer container not cleaned: ${name}`);
  }
}

assert.equal(broker.activeSessions, 0);
assert.equal(broker.reservedSessions, 0);
result.cleanupVerified = true;
if (process.env.REMOTE_DOCKER_QA_REPORT) await writeFile(process.env.REMOTE_DOCKER_QA_REPORT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
