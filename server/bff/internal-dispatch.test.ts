import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createBffApp } from './app.mjs';
import { dispatchInternalGet } from './internal-dispatch.mjs';

function createTestApp() {
  const stubDb = {
    doc: () => { throw new Error('db not expected'); },
    runTransaction: async () => { throw new Error('db not expected'); },
    collection: () => { throw new Error('db not expected'); },
  } as any;
  return createBffApp({ projectId: 'demo-mysc', db: stubDb, authMode: 'firebase_required', tokenVerifier: async () => { throw new Error('invalid token'); } });
}

describe('MCP internal dispatch', () => {
  it('runs existing routes with the MCP caller context so their role checks still apply', async () => {
    const app = createTestApp();
    const context = { tenantId: 'mysc', actorId: 'u1', actorRole: 'support', actorEmail: 'u1@mysc.co.kr' };
    const denied = await dispatchInternalGet(app, { path: '/api/v1/audit-logs', context: { ...context, actorRole: 'viewer' } });
    expect(denied.status).toBe(403);
    expect(JSON.stringify(denied.body)).toContain('read audit logs');
  });

  it('cannot be reached over HTTP: the same route still requires a real login', async () => {
    const app = createTestApp();
    await request(app).get('/api/v1/audit-logs')
      .set('x-actor-id', 'u1').set('x-actor-role', 'admin').set('x-tenant-id', 'mysc')
      .expect((response) => expect([401, 403]).toContain(response.status));
  });

  it('only builds GET requests under /api/v1', () => {
    expect(() => dispatchInternalGet(createTestApp(), { path: '/api/internal/workers/outbox/run', context: {} })).toThrow('internal_dispatch_path_invalid');
  });
});
