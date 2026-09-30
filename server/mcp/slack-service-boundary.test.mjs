import { describe, it, expect } from 'vitest';
import { createSlackServiceHandler } from './slack-service-boundary.mjs';

describe('separate Slack service boundary', () => {
  const request = (url, method = 'GET') => {
    let passed = false, status, body;
    const req = { url, method };
    const res = { setHeader() {}, status(value) { status = value; return this; }, json(value) { body = value; } };
    createSlackServiceHandler(() => { passed = true; }, { release: 'release' })(req, res);
    return { passed, status, body, url: req.url };
  };
  it('exposes only required routes and preserves raw request for existing signatures', () => {
    expect(request('/api/bff?__path=/api/slack/events', 'POST')).toMatchObject({ passed: true, url: '/api/slack/events' });
    expect(request('/api/slack/interactions', 'POST').passed).toBe(true);
    expect(request('/api/internal/workers/settlement-agent/run').passed).toBe(true);
    expect(request('/api/v1/merryhere/connect', 'POST').passed).toBe(true);
  });
  it.each(['/api/v1/projects', '/api/v1/health', '/', '/api/bff', '/api/bff?__path=/api/v1/projects', '/api/slack/events/extra', '/api/v1/merryhere/connect/extra'])('denies unrelated path %s', path => {
    expect(request(path, 'POST')).toMatchObject({ passed: false, status: 404 });
  });
  it('reports the deployed release without invoking the BFF', () => {
    expect(request('/healthz')).toMatchObject({ passed: false, status: 200, body: { service: 'mysc-slack-agent', release: 'release' } });
  });
  it('does not permit wrong HTTP methods', () => expect(request('/api/slack/events')).toMatchObject({ passed: false, status: 404 }));
});
