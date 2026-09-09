import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { createFirestoreDb } from './firestore.mjs';
import { PROJECT_DOCUMENTS, projectUpdatePayload } from '../../src/app/platform/project-documents';
import type { Project } from '../../src/app/data/types';

const suite = process.env.FIRESTORE_EMULATOR_HOST ? describe : describe.skip;
suite('project attachment SSOT through both write routes', () => {
  const projectId = 'demo-project-write-ssot';
  const tenantId = `ssot-${randomUUID().slice(0, 8)}`;
  const db = createFirestoreDb({ projectId });
  const api = request(createBffApp({ projectId, db, authMode: 'headers', env: { BFF_DEPLOY_ENV: 'local', BFF_SCHEDULER_OWNER: 'disabled' } }));
  afterAll(() => db.terminate());

  function write(route: string, payload: Record<string, unknown>, expectedVersion = 2) {
    return api.post(route).set({ 'x-tenant-id': tenantId, 'x-actor-id': 'admin', 'x-actor-role': 'admin', 'idempotency-key': randomUUID() })
      .send(route === '/api/v1/projects' ? { ...payload, expectedVersion } : { entityType: 'project', entityId: payload.id, patch: payload, expectedVersion, options: { sync: false } });
  }

  const original = { path: 'original.pdf', name: 'original.pdf', size: 1, contentType: 'application/pdf' };
  const repaired = Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, { ...original, path: `${field}.pdf`, downloadURL: `https://old.example/${field}` }]));
  const empty = Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, null]));

  it.each(['/api/v1/projects', '/api/v1/write'])('%s compares originals inside the final transaction after a racing repair', async route => {
    const id = randomUUID();
    const ref = db.doc(`orgs/${tenantId}/projects/${id}`);
    const cached = { id, name: 'Project', version: 2, ...empty } as Project;
    await ref.set(cached);
    const runTransaction = db.runTransaction.bind(db);
    let repairedDuringTransaction = false;
    const spy = vi.spyOn(db, 'runTransaction').mockImplementation((callback: any) => runTransaction(async (tx: any) => {
      const get = tx.get.bind(tx);
      tx.get = async (target: any, ...args: any[]) => {
        if (target.path === ref.path && !repairedDuringTransaction) {
          repairedDuringTransaction = true;
          await ref.update(repaired);
        }
        return get(target, ...args);
      };
      return callback(tx);
    }));
    try {
      const response = await write(route, projectUpdatePayload(cached, { contractDocument: original }));
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(repairedDuringTransaction).toBe(true);
      expect((await ref.get()).data()).toMatchObject({ ...repaired, version: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it.each(['/api/v1/projects', '/api/v1/write'])('%s preserves all repaired fields on stale status/checkout writes', async route => {
    const id = randomUUID();
    const ref = db.doc(`orgs/${tenantId}/projects/${id}`);
    const cached = { id, name: 'Project', version: 2, ...empty } as Project;
    await ref.set(cached);
    await ref.update(repaired);
    for (const [index, updates] of [{ status: 'COMPLETED' }, { checkout: { finalReport: true } }].entries()) {
      const response = await write(route, projectUpdatePayload(cached, updates as Partial<Project>), 2 + index);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const current = (await ref.get()).data()!;
      expect(current).toMatchObject({ ...repaired, ...updates, version: 3 + index });
      expect(current).not.toHaveProperty('expectedProjectDocuments');
    }
  });

  it.each(['/api/v1/projects', '/api/v1/write'])('%s rejects stale or missing originals and accepts replacement/deletion', async route => {
    const id = randomUUID();
    const ref = db.doc(`orgs/${tenantId}/projects/${id}`);
    const cached = { id, name: 'Project', version: 2, ...empty } as Project;
    await ref.set({ ...cached, ...repaired });
    for (const { field } of PROJECT_DOCUMENTS) {
      for (const patch of [
        { id, name: 'Project', [field]: null },
        projectUpdatePayload(cached, { [field]: original }),
        { id, name: 'Project', [field]: null, expectedProjectDocuments: { [field]: original } },
      ]) {
        const response = await write(route, patch);
        expect(response.status, JSON.stringify(response.body)).toBe(409);
      }
    }
    expect((await ref.get()).data()).toMatchObject({ ...repaired, version: 2 });
    for (const originals of [null, 1, 'invalid', true, []]) {
      const malformed = await write(route, { id, name: 'Project', contractDocument: null, expectedProjectDocuments: originals });
      expect(malformed.status, JSON.stringify(malformed.body)).toBe(409);
    }
    const unchanged = await write(route, { id, name: 'Project', ...repaired });
    expect(unchanged.status, JSON.stringify(unchanged.body)).toBe(200);
    const replacements = Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, original]));
    const replaced = await write(route, { id, name: 'Project', ...replacements, expectedProjectDocuments: repaired }, 3);
    expect(replaced.status, JSON.stringify(replaced.body)).toBe(200);
    const afterReplacement = (await ref.get()).data()!;
    expect(afterReplacement).toMatchObject({ ...replacements, version: 4 });
    for (const { field } of PROJECT_DOCUMENTS) expect(afterReplacement[field]).toEqual(original);
    const removed = await write(route, { id, name: 'Project', ...empty, expectedProjectDocuments: replacements }, 4);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    expect((await ref.get()).data()).toMatchObject({ ...empty, version: 5 });
    expect((await ref.get()).data()).not.toHaveProperty('expectedProjectDocuments');
  });
});
