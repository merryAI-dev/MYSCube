import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { getReactPackageSet, compileReactPreview } from '../react-compiler.mjs';
import { executeAnalyticsQuery } from '../analytics-engine.mjs';

const env = { PATH: process.env.PATH, NODE_ENV: 'production', PORT: '18971', WORKBENCH_PROJECT_ID: 'demo-image-workbench', PRODUCTION_PROJECT_ID: 'demo-image-business', WORKBENCH_MODEL_PROJECT_ID: 'demo-image-model', PRODUCTION_MODEL_PROJECT_ID: 'demo-image-business-model', WORKBENCH_AUTH_PROJECT_ID: 'demo-image-identity', WORKBENCH_TENANT_ID: 'synthetic-image-qa', WORKBENCH_AI_ENABLED: 'false', WORKBENCH_REMOTE_RUNTIME_ENABLED: 'false' };
const child = spawn(process.execPath, ['server/workbench/server.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let output = 0, report; child.stdout.on('data', data => { output += data.length; }); child.stderr.on('data', data => { output += data.length; });
const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
try {
  const deadline = Date.now() + 8000; let ready = false;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, 'App exited before becoming healthy'); assert.ok(output < 100000, 'App diagnostics exceeded limit');
    try { const response = await fetch('http://127.0.0.1:18971/health', { signal: AbortSignal.timeout(500) }); if (response.ok) { assert.equal((await response.json()).service, 'myscube-workbench'); ready = true; break; } } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.ok(ready, 'App health never became ready');
  const home = await fetch('http://127.0.0.1:18971/', { signal: AbortSignal.timeout(1000) }); assert.equal(home.status, 200); const html = await home.text();
  const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"<>]+)"/g)].map(item => item[1]); assert.ok(assets.some(path => path.endsWith('.js'))); assert.ok(assets.some(path => path.endsWith('.css')));
  let javascript = '';
  for (const asset of assets) { const response = await fetch(`http://127.0.0.1:18971${asset}`, { signal: AbortSignal.timeout(1000) }); assert.equal(response.status, 200); const text = await response.text(); assert.ok(text.length > 0); if (asset.endsWith('.js')) javascript += text; }
  assert.ok(javascript.includes('demo-image-identity'), 'Synthetic frontend auth configuration missing from built assets');
  assert.equal((await fetch('http://127.0.0.1:18971/api/v1/react-work-pages', { signal: AbortSignal.timeout(1000) })).status, 401);
  const packages = await getReactPackageSet(); assert.equal(packages.runtimeVersion, 'react-preview-v1'); assert.ok(packages.bundle.length > 1000);
  const artifact = await compileReactPreview({ title: 'Synthetic image QA', code: "import React from 'react';export default function App(){return <h1 className=\"text-blue-600\">Image smoke</h1>}" });
  assert.ok(artifact.bundle.length > 0); assert.ok(artifact.css.includes('text-blue-600')); assert.equal(artifact.packageSetHash, packages.packageSetHash);
  const query = await executeAnalyticsQuery({ sql: 'SELECT SUM(amount) AS total FROM synthetic', datasets: [{ datasetId: 'synthetic', schema: [{ name: 'amount', type: 'decimal', scale: 0 }], rows: [{ amount: '10' }, { amount: '0' }] }] });
  assert.equal(query.rows[0].total, '10');
  const lock = JSON.parse(await readFile('server/workbench/package-lock.json', 'utf8')); assert.equal(lock.packages['node_modules/@duckdb/node-api'].version, '1.5.5-r.5');
  report = { status: 'PASS', platform: process.platform, architecture: process.arch, checks: ['server-health', 'built-auth-and-assets', 'unauthorized-api', 'react-packages', 'tsx-tailwind-compiler', 'native-duckdb', 'graceful-server-exit'], productionReads: 0 };
} finally {
  clearTimeout(timer);
  if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 11000); await exited; clearTimeout(timeout); }
  assert.equal(child.exitCode, 0, 'Server shutdown must finish without a forced kill or incomplete cleanup');
}
process.stdout.write(`${JSON.stringify(report)}\n`);
