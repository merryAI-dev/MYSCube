import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';

const LIVE_PROJECT_ID = 'inner-platform-live-20260316';
const LIVE_ORIGIN = 'https://myscube.myscguard.app';
const LONG_CRON_SECRET = 'vercel-cron-secret-32-characters-ok';
const LONG_K8S_SECRET = 'k8s-worker-secret-32-characters-ok';
const INTERNAL_WORKER_PATHS = [
  '/api/internal/workers/outbox/run',
  '/api/internal/workers/work-queue/run',
  '/api/internal/workers/payroll/run',
  '/api/internal/workers/client-errors/run',
];

function createTestApp(options: Parameters<typeof createBffApp>[0] = {}) {
  // These tests assert routing + auth gates only (no Firestore calls should happen).
  const stubDb = {
    doc: () => { throw new Error('db not expected'); },
    runTransaction: async () => { throw new Error('db not expected'); },
    collection: () => { throw new Error('db not expected'); },
  } as any;

  return createBffApp({
    projectId: 'demo-mysc',
    db: stubDb,
    authMode: 'headers',
    tokenVerifier: async () => ({}),
    workerSecret: 'test-secret',
    ...options,
  });
}

describe('internal worker endpoints (cron)', () => {
  it('isolates the cloud agent token and blocks maintenance before database access', async () => {
    const get = vi.fn(async () => ({ docs: [] }));
    const db = { collection: vi.fn(() => ({ where: () => ({ limit: () => ({ get }) }) })),
      doc: () => { throw new Error('Unexpected document access'); }, runTransaction: () => { throw new Error('Unexpected write'); } };
    const env = { BFF_DEPLOY_ENV: 'local', BFF_SCHEDULER_OWNER: 'vercel', CRON_SECRET: LONG_CRON_SECRET,
      SETTLEMENT_AGENT_ENABLED: 'true', SETTLEMENT_AGENT_WORKER_SECRET: 'agent-only', SLACK_ALERT_BOT_TOKEN: 'fixture', SLACK_SIGNING_SECRET: 'fixture' };
    const path = '/api/internal/workers/settlement-agent/run';
    const app = createTestApp({ db, env });
    await request(app).get(path).expect(401);
    await request(app).get(path).set('Authorization', `Bearer ${LONG_CRON_SECRET}`).expect(401);
    await request(app).get(path).set('x-worker-secret', 'agent-only').expect(401);
    await request(app).get('/api/internal/workers/outbox/run').set('Authorization', 'Bearer agent-only').expect(401);
    expect(get).not.toHaveBeenCalled();
    const response = await request(app).get(path).set('Authorization', 'Bearer agent-only').expect(200);
    expect(response.body).toEqual({ ok: true, processed: 0 });
    expect(get).toHaveBeenCalledTimes(1);
    for (const blocked of [{ BFF_MAINTENANCE_READ_ONLY: ' TRUE ' }, { BFF_WORKERS_ENABLED: ' false ' }, { BFF_SCHEDULER_OWNER: 'disabled' }]) {
      await request(createTestApp({ db, env: { ...env, ...blocked } })).get(path).set('Authorization', 'Bearer agent-only').expect(401);
    }
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('keeps the Live maintenance probe open while workers stay disabled', async () => {
    const app = createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: [LIVE_ORIGIN],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_MAINTENANCE_READ_ONLY: 'false',
        BFF_WORKERS_ENABLED: 'false',
      },
    });

    const mutationProbe = await request(app).post('/api/v1/__maintenance_probe__');
    expect(mutationProbe.status).toBe(400);
    expect(mutationProbe.body?.error).not.toBe('maintenance_read_only');

    const workerProbe = await request(app).get('/api/internal/workers/outbox/run');
    expect(workerProbe.status).toBe(503);
    expect(workerProbe.body?.error).toBe('worker_scheduler_disabled');
  });

  it('keeps health readable but blocks every mutation during live maintenance', async () => {
    const app = createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: [LIVE_ORIGIN],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_MAINTENANCE_READ_ONLY: 'true',
        BFF_WORKERS_ENABLED: 'false',
      },
    });

    await request(app).get('/api/v1/health').expect(200);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      const mutation = await request(app)[method]('/api/internal/workers/outbox/run');
      expect(mutation.status).toBe(503);
      expect(mutation.body?.error).toBe('maintenance_read_only');
    }
  });

  it('does not expose the retired payroll monthly-close worker', async () => {
    const app = createTestApp();
    const res = await request(app).get('/api/internal/workers/monthly-close/run');
    expect(res.status).toBe(404);
  });

  it.each(INTERNAL_WORKER_PATHS)('supports GET auth gate for %s', async (workerPath) => {
    const app = createTestApp();
    const res = await request(app).get(workerPath);
    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('unauthorized_worker');
  });

  it.each(INTERNAL_WORKER_PATHS)('fails closed before DB access when live workers are disabled for %s', async (workerPath) => {
    const app = createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: [LIVE_ORIGIN],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_WORKERS_ENABLED: 'false',
      },
    });

    const res = await request(app)
      .get(workerPath)
      .set('Authorization', `Bearer ${LONG_CRON_SECRET}`);

    expect(res.status).toBe(503);
    expect(res.body?.error).toBe('worker_scheduler_disabled');
  });

  it('rejects Vercel-owned worker calls that do not use the Vercel cron bearer token', async () => {
    const app = createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: [LIVE_ORIGIN],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_SCHEDULER_OWNER: 'vercel',
        CRON_SECRET: LONG_CRON_SECRET,
        BFF_WORKER_SECRET: LONG_K8S_SECRET,
      },
    });

    const res = await request(app)
      .get('/api/internal/workers/work-queue/run')
      .set('x-worker-secret', LONG_CRON_SECRET);

    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('unauthorized_worker');
  });

  it('rejects Kubernetes-owned worker calls that use the Vercel cron token', async () => {
    const app = createTestApp({
      projectId: 'local-bff',
      allowedOrigins: ['http://127.0.0.1:5173'],
      env: {
        BFF_DEPLOY_ENV: 'local',
        BFF_SCHEDULER_OWNER: 'k8s',
        CRON_SECRET: LONG_CRON_SECRET,
        K8S_WORKER_SECRET: LONG_K8S_SECRET,
      },
    });

    const res = await request(app)
      .get('/api/internal/workers/payroll/run')
      .set('Authorization', `Bearer ${LONG_CRON_SECRET}`);

    expect(res.status).toBe(401);
    expect(res.body?.error).toBe('unauthorized_worker');
  });

  it('rejects unsafe runtime configuration before creating the Firestore client', () => {
    let createDbCalled = false;

    expect(() => createBffApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: ['*'],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_SCHEDULER_OWNER: 'vercel',
        CRON_SECRET: LONG_CRON_SECRET,
      },
      createDb: () => {
        createDbCalled = true;
        throw new Error('createDb should not be called');
      },
    })).toThrow(/BFF_ALLOWED_ORIGINS cannot include \*/);
    expect(createDbCalled).toBe(false);
  });

  it('rejects unsafe live runtime configuration before worker routes are available', () => {
    expect(() => createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: ['*'],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_SCHEDULER_OWNER: 'vercel',
        CRON_SECRET: LONG_CRON_SECRET,
      },
    })).toThrow(/BFF_ALLOWED_ORIGINS cannot include \*/);
  });

  it('does not auto-allow Vercel preview origins in live mode', async () => {
    const app = createTestApp({
      projectId: LIVE_PROJECT_ID,
      allowedOrigins: [LIVE_ORIGIN],
      env: {
        BFF_DEPLOY_ENV: 'live',
        BFF_SCHEDULER_OWNER: 'vercel',
        CRON_SECRET: LONG_CRON_SECRET,
      },
    });

    const res = await request(app)
      .get('/api/internal/workers/payroll/run')
      .set('Origin', 'https://inner-platform-git-feature-merryai-devs-projects.vercel.app')
      .set('Authorization', `Bearer ${LONG_CRON_SECRET}`);

    expect(res.status).toBe(403);
    expect(res.body?.error).toBe('origin_not_allowed');
  });

});
