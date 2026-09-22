import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { reliabilityResponseMiddleware } from './reliability-middleware.mjs';

const operationId = 'b9bf1270-158c-49ef-8a9a-26976085bd63';
function setup(observe) {
  const service = { observe, collectionFailed: vi.fn() };
  const app = express();
  app.use((req, _res, next) => { req.context = { tenantId: 'test', actorId: 'a', requestId: 'request-1' }; next(); });
  app.use(reliabilityResponseMiddleware({ service, environment: 'local', budgetMs: 10 }));
  app.post('/api/v1/project-registration-drafts/draft/submit', (_req, res) => res.json({ status: 'SUBMITTED', projectId: 'project', outbox: { pending: true } }));
  return { api: request(app), service };
}
describe('bounded reliable response observation', () => {
  it('records authoritative saved response with attachment follow-up unconfirmed', async () => {
    const { api, service } = setup(vi.fn().mockResolvedValue({}));
    const response = await api.post('/api/v1/project-registration-drafts/draft/submit').set('x-operation-id', operationId);
    expect(response.status).toBe(200);
    expect(response.headers['x-observation-status']).toBe('recorded');
    expect(service.observe).toHaveBeenCalledWith(expect.objectContaining({ actorId: 'a' }), expect.objectContaining({ authority: 'server', operationId, outcome: 'saved', followup: 'unconfirmed', requestId: 'request-1' }));
  });
  it.each(['reject', 'hang'])('preserves the original business response when collection %s', async (mode) => {
    const { api, service } = setup(vi.fn(() => mode === 'reject' ? Promise.reject(new Error('offline')) : new Promise(() => {})));
    const response = await api.post('/api/v1/project-registration-drafts/draft/submit').set('x-operation-id', operationId);
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'SUBMITTED', projectId: 'project', outbox: { pending: true } });
    expect(response.headers['x-observation-status']).toBe('unconfirmed');
    expect(service.collectionFailed).toHaveBeenCalledTimes(1);
  });
  it('leaves uninstrumented requests untouched', async () => {
    const { api, service } = setup(vi.fn());
    expect((await api.post('/api/v1/project-registration-drafts/draft/submit')).status).toBe(200);
    expect(service.observe).not.toHaveBeenCalled();
  });
});
