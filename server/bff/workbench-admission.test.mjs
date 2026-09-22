import express from 'express';
import request from 'supertest';
import { describe, it, expect, vi } from 'vitest';
import { createWorkbenchAdmission, workbenchAdmissionKind, workbenchAdmissionMiddleware } from './workbench-admission.mjs';

function database() {
  const data = new Map();
  let pending = Promise.resolve();
  return { data, doc: (path) => ({ path }), runTransaction: (callback) => {
    const run = pending.then(async () => {
      const writes = new Map();
      const result = await callback({ get: async (ref) => ({ data: () => structuredClone(data.get(ref.path)) }),
        set: (ref, value) => writes.set(ref.path, structuredClone(value)) });
      for (const [key, value] of writes) data.set(key, value);
      return result;
    });
    pending = run.catch(() => {});
    return run;
  } };
}
const context = { tenantId: 't', actorId: 'a', requestId: 'request' };

describe('distributed workbench admission', () => {
  it('shares two slots across service instances and isolates tenants', async () => {
    const db = database();
    const first = createWorkbenchAdmission({ db });
    const second = createWorkbenchAdmission({ db });
    const leases = await Promise.all([first.acquire(context), second.acquire({ ...context, actorId: 'b' })]);
    await expect(first.acquire({ ...context, actorId: 'c' })).rejects.toMatchObject({ code: 'workbench_busy' });
    const other = await second.acquire({ ...context, tenantId: 'other' });
    await leases[0].release();
    const next = await second.acquire(context);
    await Promise.all([leases[1].release(), next.release(), other.release()]);
  });
  it('expires slots and an old owner cannot release a replacement', async () => {
    let at = 0; const db = database(); const service = createWorkbenchAdmission({ db, clock: () => at });
    const old = await service.acquire(context); await service.acquire(context);
    at = 90001;
    await service.acquire(context); await service.acquire(context);
    await old.release();
    await expect(service.acquire(context)).rejects.toMatchObject({ code: 'workbench_busy' });
  });
  it('enforces actor minute budget independently of released slots', async () => {
    let at = 0; const db = database(); const service = createWorkbenchAdmission({ db, clock: () => at, actorLimit: 2 });
    await (await service.acquire(context)).release(); await (await service.acquire(context)).release();
    await expect(service.acquire(context)).rejects.toMatchObject({ code: 'workbench_rate_limited' });
    await (await service.acquire({ ...context, actorId: 'b' })).release();
    at = 60000; await expect(service.acquire(context)).resolves.toHaveProperty('release');
  });
});

function app(service, options = {}) {
  const application = express();
  application.use((req, _res, next) => { req.context = context; next(); });
  application.use(workbenchAdmissionMiddleware({ service, admissionMs: 10, releaseMs: 10, ...options }));
  application.get('/api/v1/cashflow-evidence', (_req, res) => res.json({ data: 'read' }));
  application.post('/api/v1/workbench-assistant/cashflow', (_req, res) => res.json({ answer: 'fixture' }));
  application.post('/api/v1/project-info-drafts/p/submit', (_req, res) => res.json({ saved: true }));
  application.get('/api/v1/health', (_req, res) => res.json({ ok: true }));
  return request(application);
}

describe('workbench-only resource guard', () => {
  it('never calls admission for business endpoints or health, even with disabled reads', async () => {
    const service = { acquire: vi.fn().mockRejectedValue(new Error('down')) };
    const api = app(service, { readsEnabled: false });
    expect((await api.post('/api/v1/project-info-drafts/p/submit')).body).toEqual({ saved: true });
    expect((await api.get('/api/v1/health')).status).toBe(200);
    expect((await api.get('/api/v1/cashflow-evidence')).status).toBe(503);
    expect(service.acquire).not.toHaveBeenCalled();
  });
  it('acquires once for a model request and releases before the response completes', async () => {
    const release = vi.fn().mockResolvedValue(undefined);
    const service = { acquire: vi.fn().mockResolvedValue({ release }) };
    expect((await app(service).post('/api/v1/workbench-assistant/cashflow')).status).toBe(200);
    expect(service.acquire).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
  });
  it('fails only the new tool closed when admission hangs; release failure preserves its response', async () => {
    expect((await app({ acquire: () => new Promise(() => {}) }).get('/api/v1/cashflow-evidence')).status).toBe(503);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const response = await app({ acquire: async () => ({ release: () => new Promise(() => {}) }) }).get('/api/v1/cashflow-evidence');
      expect(response.body).toEqual({ data: 'read' }); expect(warn).toHaveBeenCalledTimes(1);
    } finally { warn.mockRestore(); }
  });
  it('marks limits retryable and recognizes only exact registered paths', async () => {
    const response = await app({ acquire: async () => { throw Object.assign(new Error('busy'), { statusCode: 429, code: 'workbench_busy' }); } }).get('/api/v1/cashflow-evidence');
    expect(response.status).toBe(429); expect(response.headers['retry-after']).toBe('60');
    expect(workbenchAdmissionKind('GET', '/api/v1/cashflow-evidence-extra')).toBe(null);
    expect(workbenchAdmissionKind('GET', '/api/v1/workbench-assistant/capabilities')).toBe(null);
  });
});

it.skipIf(!process.env.FIRESTORE_EMULATOR_HOST)('persists admission across independent instances in Firestore', async () => {
  const { createFirestoreDb } = await import('./firestore.mjs');
  const db = createFirestoreDb({ projectId: 'demo-bff-it' });
  const tenantId = `admission-${Date.now()}`;
  const root = db.doc(`orgs/${tenantId}`);
  const actor = { ...context, tenantId };
  const a = createWorkbenchAdmission({ db });
  const b = createWorkbenchAdmission({ db });
  try {
    const one = await a.acquire(actor);
    const two = await b.acquire({ ...actor, actorId: 'b' });
    await expect(createWorkbenchAdmission({ db }).acquire({ ...actor, actorId: 'c' })).rejects.toMatchObject({ code: 'workbench_busy' });
    const stored = await db.doc(`orgs/${tenantId}/personal_work_pages/_admission/leases/active`).get();
    expect(stored.data().active).toHaveLength(2);
    await one.release();
    const replacement = await b.acquire(actor);
    await one.release();
    expect((await db.doc(`orgs/${tenantId}/personal_work_pages/_admission/leases/active`).get()).data().active).toHaveLength(2);
    await replacement.release(); await two.release();
  } finally { await db.recursiveDelete(root); }
});
