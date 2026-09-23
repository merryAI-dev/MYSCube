import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import http from 'node:http';
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
const external = `http://172.17.0.1:${receiver.address().port}/forbidden`;
const apiId = '11111111-1111-4111-8111-111111111111';
const context = actorId => ({ tenantId: 'synthetic-docker-qa', actorId, actorRole: 'admin', analyticsScope: { fingerprint: 'synthetic-only' } });
const spawnDocker = args => { if (args[0] === 'run') containers.push(args[args.indexOf('--name') + 1]); return spawn('docker', args, { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'] }); };
const broker = createRemoteRuntimeBroker({ authorize: async value => { assert.equal(value.tenantId, 'synthetic-docker-qa'); }, callApi: async (_context, input) => { calls.push(input); return { data: { ok: true } }; }, spawnDocker });
const compiled = async code => { const artifact = await compileReactPreview({ title: 'Synthetic isolation QA', code }); return { artifact, sourceHash: artifact.sourceHash, apiBindings: [{ id: apiId, version: 1 }], viewport: { width: 640, height: 480 } }; };
try {
  const normal = await compiled(`import React,{useState} from 'react';export default function App(){const[n,setN]=useState(0);return <button style={{position:'absolute',left:20,top:20}} onClick={()=>{setN(n+1);window.workbench.callApi('${apiId}',{count:n+1})}}>Canary {n}</button>}`);
  const canary = await broker.create(context('canary'), normal);
  const inspected = JSON.parse(execFileSync('docker', ['inspect', `axr-render-${canary.sessionId}`], { encoding: 'utf8' }))[0];
  assert.equal(inspected.HostConfig.NetworkMode, 'none'); assert.equal(inspected.HostConfig.Memory, 512 * 1024 * 1024); assert.equal(inspected.HostConfig.MemorySwap, 512 * 1024 * 1024);
  assert.equal(inspected.HostConfig.NanoCpus, 1000000000); assert.equal(inspected.HostConfig.PidsLimit, 128); assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
  assert.equal(inspected.Config.User, '10001:10001'); assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']); assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
  assert.equal((inspected.HostConfig.Binds || []).length, 0); assert.equal(inspected.HostConfig.Privileged, false);
  const changed = await broker.event(context('canary'), canary.sessionId, { type: 'click', x: 45, y: 28 });
  assert.notEqual(changed.pngBase64, canary.frame.pngBase64); assert.ok(calls.some(call => call.input.count === 1));
  outcomes.push({ case: 'actual-cgroup-network-filesystem-and-react-click', pass: true });
  const egress = await compiled(`import React,{useEffect} from 'react';export default function App(){useEffect(()=>{fetch('${external}').catch(()=>window.workbench.callApi('${apiId}',{egressBlocked:true}));},[]);return <p>Network isolation fixture</p>}`);
  const networking = await broker.create(context('network'), egress);
  for (let attempt = 0; attempt < 20 && !calls.some(call => call.input.egressBlocked === true); attempt++) {
    await broker.frame(context('network'), networking.sessionId); await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(calls.some(call => call.input.egressBlocked === true), 'The browser must actually attempt and reject egress');
  assert.equal(receiverHits, 0);
  await broker.close(context('network'), networking.sessionId);
  outcomes.push({ case: 'external-receiver-received-no-request', pass: true, receiverHits });
  for (const [name, code] of [
    ['infinite-loop', "import React from 'react';export default function App(){while(true){} return null}"],
    ['memory-pressure', "import React from 'react';export default function App(){const values=[];while(true){values.push(new Uint8Array(8000000).fill(1));}return null}"],
    ['api-flood', `import React from 'react';export default function App(){for(let i=0;i<1000;i++)window.workbench.callApi('${apiId}',{i});return <p>Flood</p>}`],
  ]) {
    const payload = await compiled(code); const attack = broker.create(context(name), payload).then(value => ({ value }), error => ({ error }));
    const start = Date.now(); const healthy = await broker.frame(context('canary'), canary.sessionId); assert.ok(healthy.pngBase64); assert.ok(Date.now() - start < 8000);
    const result = await attack;
    if (result.value) { await new Promise(resolve => setTimeout(resolve, 500)); await assert.rejects(broker.frame(context(name), result.value.sessionId)); }
    else assert.ok(['remote_command_timeout', 'remote_exited', 'remote_react_error', 'remote_api_limit'].includes(result.error.code), `${name}: ${result.error.code}`);
    assert.ok((await broker.frame(context('canary'), canary.sessionId)).sequence > healthy.sequence);
    outcomes.push({ case: name, pass: true, canaryAvailable: true });
  }
  await broker.close(context('canary'), canary.sessionId);
  assert.equal(broker.activeSessions, 0); assert.equal(receiverHits, 0);
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

result.cleanupVerified = true;
if (process.env.REMOTE_DOCKER_QA_REPORT) await writeFile(process.env.REMOTE_DOCKER_QA_REPORT, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
