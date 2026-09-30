// Run with: node --test scripts/lib/firestore-ownership.test.mjs
// (vitest.config.ts only includes src/ and server/, so this is not part of `npm test`.)
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, evaluate, compareToBaseline } from './firestore-ownership.mjs';

const manifest = {
  collections: {
    ledgers: { owner: 'jvm' },
    members: { owner: 'bff' },
    agent_notes: { owner: 'agent' },
  },
};
const run = (actorFiles) => evaluate(scan(actorFiles), manifest);

test('a non-owner write is a single-writer violation', () => {
  const { violations } = run({
    bff: [{ path: 'server/bff/a.mjs', text: [
      'const ref = db.doc(`orgs/${tenantId}/ledgers/${id}`);',
      'await db.runTransaction(async (transaction) => { transaction.set(ref, data); });',
    ].join('\n') }],
  });
  assert.deepEqual(violations.map((v) => [v.rule, v.actor, v.collection]), [['single-writer', 'bff', 'ledgers']]);
});

test('reading another owner collection is allowed for services', () => {
  const { violations } = run({
    bff: [{ path: 'server/bff/a.mjs', text: 'const snap = await db.doc(`orgs/${t}/ledgers/${id}`).get();' }],
  });
  assert.equal(violations.length, 0);
});

test('agent code may not read domain collections', () => {
  const { violations } = run({
    agent: [{ path: 'server/mcp/x.mjs', text: 'const m = await db.doc(`orgs/${t}/members/${id}`).get();' }],
  });
  assert.deepEqual(violations.map((v) => v.rule), ['agent-isolation']);
});

test('agent-owned collections are free for agents', () => {
  const { violations } = run({
    agent: [{ path: 'server/mcp/x.mjs', text: "await db.doc(`agent_notes/${id}`).set({ a: 1 });" }],
  });
  assert.equal(violations.length, 0);
});

test('path helpers and collection constants resolve to their collection', () => {
  const { violations } = run({
    bff: [{ path: 'server/bff/a.mjs', text: [
      'const LEDGERS_COLLECTION_ID = \'ledgers\';',
      'export function ledgerPath(t, id) { return `orgs/${t}/ledgers/${id}`; }',
      'const viaHelper = db.doc(ledgerPath(t, id));',
      'transaction.set(viaHelper, data);',
      'const viaConst = db.doc(`orgs/${t}/${LEDGERS_COLLECTION_ID}/${id}`);',
      'batch.delete(viaConst);',
    ].join('\n') }],
  });
  assert.ok(violations.length >= 1);
  assert.ok(violations.every((v) => v.collection === 'ledgers'));
});

test('an unknown collection must be registered', () => {
  const { unregistered } = run({
    bff: [{ path: 'server/bff/a.mjs', text: 'await db.doc(`orgs/${t}/brand_new/${id}`).set({});' }],
  });
  assert.deepEqual(unregistered, ['brand_new']);
});

test('baseline lets known violations pass and flags new ones', () => {
  const known = { rule: 'single-writer', actor: 'bff', collection: 'ledgers', file: 'a.mjs', kind: 'write' };
  const fresh = { ...known, file: 'b.mjs' };
  const { added, stale } = compareToBaseline([known, fresh], { violations: [known, { ...known, file: 'gone.mjs' }] });
  assert.deepEqual(added, [fresh]);
  assert.equal(stale.length, 1);
});
