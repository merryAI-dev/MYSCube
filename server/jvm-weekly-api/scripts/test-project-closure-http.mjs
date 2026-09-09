import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createBffApp } from '../../bff/app.mjs';
import { createFirestoreDb } from '../../bff/firestore.mjs';

const [jvmUrl, dataProjectId, tenantId, projectId] = process.argv.slice(2);
assert.match(dataProjectId, /^demo-/);
assert.match(process.env.FIRESTORE_EMULATOR_HOST || '', /^127\.0\.0\.1:/);
assert.match(jvmUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
process.chdir(fileURLToPath(new URL('../../../', import.meta.url)));
const db = createFirestoreDb({ projectId: dataProjectId, appName: 'closure-http-boundary' });
const server = createBffApp({ db, projectId: dataProjectId, authMode: 'headers' }).listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const bffUrl = `http://127.0.0.1:${server.address().port}`;
async function post(base, path, body, actor = 'approver-1', key = '') {
  const response = await fetch(`${base}/api/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-tenant-id': tenantId,
      'x-actor-id': actor, 'x-actor-role': actor === 'admin-2' ? 'admin' : 'pm',
      'x-actor-email': `${actor}@example.test`, ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
try {
  const overviewBody = { projectIds: [projectId], yearMonth: '2026-09' };
  const before = await post(jvmUrl, '/cashflow/weekly-overview', overviewBody);
  assert.equal(before.status, 200, JSON.stringify(before));
  assert.equal(before.body.items[0].settlementEligibility.status, 'ACTIVE');
  const mutation = { idempotencyKey: 'http-before-closure', lines: [
    { yearMonth: '2026-09', weekNo: 1, cashflowLine: 'SALES_IN', amount: 1234 },
  ] };
  const written = await post(jvmUrl, `/cashflow/${projectId}/projection`, mutation);
  assert.equal(written.status, 200, JSON.stringify(written));
  const week = db.doc(`orgs/${tenantId}/cashflow_weeks/${projectId}-2026-09-w1`);
  const history = (await week.get()).data();
  const requested = await post(bffUrl, `/projects/${projectId}/closure-requests`, {
    expectedProjectVersion: 3, retentionStartDate: '2026-09-09', retentionPeriodYears: 5,
    driveFolderLink: '', handoverNote: '통합 HTTP 검증', driveDeletedAt: '', note: '',
  }, 'admin-2', 'http-closure-submit');
  assert.equal(requested.status, 201, JSON.stringify(requested));
  const approved = await post(bffUrl, `/projects/${projectId}/closure-requests/${requested.body.item.id}/review`, {
    decision: 'APPROVED', expectedRequestVersion: 1, comment: '',
  }, 'approver-1', 'http-closure-approve');
  assert.equal(approved.status, 200, JSON.stringify(approved));
  for (const settlementCycle of [false, true]) {
    const after = await post(jvmUrl, '/cashflow/weekly-overview', { ...overviewBody, settlementCycle });
    assert.equal(after.status, 200, JSON.stringify(after));
    assert.deepEqual(after.body.items[0].settlementEligibility,
      { status: 'CLOSED', weekly: false, monthly: false, writable: false });
  }
  const rejected = await post(jvmUrl, `/cashflow/${projectId}/projection`, {
    ...mutation, idempotencyKey: 'http-after-closure',
  });
  assert.equal(rejected.status, 409, JSON.stringify(rejected));
  assert.equal(rejected.body.code, 'project_closed');
  assert.deepEqual((await week.get()).data(), history);
  console.log('PASS shared Firestore HTTP: JVM ACTIVE/write 200 -> BFF request 201/approval 200 -> JVM legacy+cycle CLOSED/write 409; history unchanged');
} finally {
  await new Promise(resolve => server.close(resolve));
  await db.terminate();
}
