import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { deadlineContinuation } from './runner-persistence.mjs';

const source = await readFile(new URL('./runner.mjs', import.meta.url), 'utf8');
async function runFailure(text, persist = true) {
  const writes = [], logs = [];
  const context = {
    error: { code: 'investigation_provider_credit_exhausted' },
    signal: { aborted: false }, deadlineSignal: { aborted: false },
    leaseAbort: { signal: { aborted: false } }, pipeline: { reviewAuthorityBinding: () => ({}) },
    deadlineContinuation, runBinding: {}, durableSession: null, executionStartOrdinal: 0,
    durablePending: null, durableReviewReceipt: null, DRAFT_PROTOCOL: 'draft',
    REVIEW_IMPLEMENTATION_SHA256: 'review',
    sessionLedger: { manifestPage: () => ({ manifest_hash: 'manifest' }) },
    investigationPlan: null, request: { report: { description: 'test' } },
    observedEvidence: new Map(), checkpointCount: 0, lastStep: 0,
    runPath: 'test/run', runId: 'test-run', startedAtMs: Date.now(),
    update: (path, data) => ({ path, data }), create: (path, data) => ({ path, data }),
    commit: async changes => { if (!persist) throw new Error('secret must not appear'); writes.push(...changes); },
    console: { error: line => logs.push(JSON.parse(line)) }, process: { env: {}, exitCode: 0 },
  };
  // Resolve the binding from the real runner import, so removing it breaks this path.
  const imported = text.match(/import\s*\{\s*candidateHash\s*\}\s*from\s*['"]([^'"]+)['"]/);
  if (imported) context.candidateHash = (await import(new URL(imported[1], import.meta.url))).candidateHash;
  const start = text.lastIndexOf('} catch (error) {');
  const end = text.indexOf('} finally {', start);
  assert(start > 0 && end > start);
  await runInNewContext(`(async () => {${text.slice(start + '} catch (error) {'.length, end)}})()`, context);
  return { writes, logs, exitCode: context.process.exitCode };
}

test('actual runner failure path persists a provider rejection and exits unsuccessfully', async () => {
  const result = await runFailure(source);
  assert.equal(result.writes.length, 1);
  assert.equal(result.writes[0].data.status, 'failed');
  assert.equal(result.writes[0].data.error_code, 'investigation_provider_credit_exhausted');
  assert.equal(result.exitCode, 1);
});

test('regression detects the missing candidateHash import seen in the real execution', async () => {
  await assert.rejects(runFailure(source.replace(/^import \{ candidateHash \}[^\n]+\n/m, '')),
    /candidateHash is not defined/);
});

test('failure persistence outage logs only the safe failure marker', async () => {
  const result = await runFailure(source, false);
  assert.equal(result.writes.length, 0);
  assert.equal(result.exitCode, 1);
  assert(result.logs.some(item => item.phase === 'failure_status_unpersisted'));
  assert(!JSON.stringify(result.logs).includes('secret'));
});
