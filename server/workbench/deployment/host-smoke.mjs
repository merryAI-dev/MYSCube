import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { getReactPackageSet, compileReactPreview } from '../react-compiler.mjs';
import { executeAnalyticsQuery } from '../analytics-engine.mjs';

assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'x64');
assert.match(process.version, /^v24\./);
const metadata = JSON.parse(await readFile('workbench-build.json', 'utf8'));
assert.equal(metadata.classification, 'production_candidate');
assert.equal(metadata.sourceSha, process.env.WORKBENCH_EXPECTED_SOURCE_SHA);
const packages = await getReactPackageSet();
const artifact = await compileReactPreview({ title: '배포 실행 확인', code: "import React from 'react';export default function App(){return <h1 className=\"text-blue-600\">AXR deployment check</h1>}" });
assert.ok(artifact.bundle.length > 0);
assert.ok(artifact.css.includes('text-blue-600'));
assert.equal(artifact.packageSetHash, packages.packageSetHash);
const result = await executeAnalyticsQuery({ sql: 'SELECT SUM(amount) AS total FROM synthetic', datasets: [{ datasetId: 'synthetic', schema: [{ name: 'amount', type: 'decimal', scale: 0 }], rows: [{ amount: '10' }, { amount: '0' }] }] });
assert.equal(result.rows[0].total, '10');
console.log(JSON.stringify({ status: 'PASS', sourceSha: metadata.sourceSha, checks: ['native-node', 'tsx-tailwind', 'package-set', 'native-duckdb'], productionReads: 0, modelCalls: 0 }));
