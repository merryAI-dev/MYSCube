import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Firestore } from '@google-cloud/firestore';
import { createHash } from 'node:crypto';
import { createGitDeliveryService } from './git-delivery.mjs';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('Git delivery durable receipts', () => {
  const db = new Firestore({ projectId: 'demo-git-delivery' });
  const context = { tenantId: 'git-integration', actorId: 'member-1' };
  const root = db.doc(`orgs/${context.tenantId}`);
  const code = 'export default function App() { return <p>독립 QA 자료 미연결</p>; }';
  const input = { pageId: 'qa-only', version: 1, title: '독립 검증', sourceHash: createHash('sha256').update(code).digest('hex'), code, apiIds: [], packageSetHash: 'react19-v1' };
  const env = { WORKBENCH_GIT_REPOSITORY: 'test/review', WORKBENCH_GITHUB_TOKEN: 'test-only' };
  beforeEach(async () => { await db.recursiveDelete(root); });
  afterAll(async () => { await db.recursiveDelete(root); await db.terminate(); });
  it('persists failure and resumes with a new service instance without re-creating the commit', async () => {
    let commitCalls = 0; let branch = false; let failPull = true;
    const fetchImpl = async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname.replace('/repos/test/review', '');
      const body = options.body ? JSON.parse(String(options.body)) : {};
      const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (path === '') return reply({ full_name: 'test/review', private: true });
      if (path === '/git/ref/heads/main') return reply({ object: { sha: 'a'.repeat(40) } });
      if (path === `/git/commits/${'a'.repeat(40)}`) return reply({ tree: { sha: 'b'.repeat(40) } });
      if (path === '/git/blobs' || path === '/git/trees') return reply({ sha: 'c'.repeat(40) });
      if (path === '/git/commits') { commitCalls++; return reply({ sha: 'd'.repeat(40) }); }
      if (path.startsWith('/git/ref/heads/axr/')) return branch ? reply({ object: { sha: 'd'.repeat(40) } }) : reply({}, 404);
      if (path === '/git/refs') { branch = true; return reply({}, 201); }
      if (path === '/pulls' && options.method === 'GET') return reply([]);
      if (path === '/pulls' && failPull) throw new Error('simulated provider timeout');
      if (path === '/pulls') return reply({ state: 'open', number: 27, head: { sha: 'd'.repeat(40), ref: body.head, repo: { full_name: 'test/review' } }, base: { ref: 'main' } });
      throw new Error('unexpected endpoint');
    };
    const options = { db, env, retryDelayMs: 0, authorize: async () => {}, fetchImpl };
    await expect(createGitDeliveryService(options).publish(context, input)).rejects.toMatchObject({ code: 'git_transport_failed' });
    const rows = await root.collection('workbench_git_deliveries').get();
    expect(rows.size).toBe(1);
    expect(rows.docs[0].data()).toMatchObject({ status: 'retryable', commitSha: 'd'.repeat(40), leaseUntil: 0 });
    failPull = false;
    const receipt = await createGitDeliveryService(options).publish(context, input);
    expect(receipt).toMatchObject({ status: 'complete', pullNumber: 27 });
    expect(commitCalls).toBe(1);
    expect((await rows.docs[0].ref.get()).data()?.status).toBe('complete');
    expect((await root.collection('projects').get()).empty).toBe(true);
  });
});
