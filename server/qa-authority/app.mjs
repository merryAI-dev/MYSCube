import express from 'express';
import { createQaAuthorityService } from './service.mjs';

const token = (raw) => {
  const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i.exec(raw || '');
  if (!match || match[1].length > 16384) throw Object.assign(new Error('qa_authority_auth_required'), { code: 'qa_authority_auth_required', statusCode: 401 });
  return match[1];
};
const fail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { code, statusCode }); };
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function createQaAuthorityApp({ qaDb, businessDb, verifyQaToken, verifyBusinessToken,
  getQaUser, getBusinessUser, verifyWorkerToken, workerAudience, workerEmails, reopenWorkerEmails = [], memberWorkerEmails = [], projectWorkerEmails = [], now }) {
  if (!/^https:\/\/[^\s/]+$/.test(workerAudience || '') || !Array.isArray(workerEmails)
    || !workerEmails.length || workerEmails.some((email) => !/^[a-z0-9._+-]+@[^\s@]+\.iam\.gserviceaccount\.com$/.test(email)))
    throw Error('qa_authority_worker_config_invalid');
  const service = createQaAuthorityService({ qaDb, businessDb, getQaUser, getBusinessUser, now });
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb', strict: true }));
  const route = (handler) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { await handler(req, res); }
    catch (error) {
      const status = Number.isInteger(error?.statusCode) ? error.statusCode : 503;
      res.status(status).json({ error: status < 500 ? error.code || 'qa_authority_denied' : 'qa_authority_unavailable' });
    }
  };
  async function verifyUser(bearer, verify, provider) {
    try { return await verify(bearer); }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z/_-]{1,80}$/.test(error.code) ? error.code : 'unknown';
      const unauthorized = ['auth/argument-error', 'auth/invalid-id-token', 'auth/id-token-expired',
        'auth/id-token-revoked', 'auth/user-disabled', 'auth/user-not-found'].includes(code);
      console.error(JSON.stringify({ severity: 'ERROR', component: 'qa_authority_token_verification', provider, code }));
      fail(unauthorized ? 'qa_authority_auth_required' : 'qa_authority_auth_unavailable', unauthorized ? 401 : 503);
    }
  }
  async function userIdentity(req) {
    let qaToken, businessToken;
    try {
      const qaBearer = token(req.header('authorization'));
      const businessBearer = token(req.header('x-business-authorization'));
      [qaToken, businessToken] = await Promise.all([
        verifyUser(qaBearer, verifyQaToken, "qa"),
        verifyUser(businessBearer, verifyBusinessToken, "business"),
      ]);
    } catch (error) {
      if (error?.statusCode) throw error;
      fail('qa_authority_auth_required', 401);
    }
    return { qaToken, businessToken };
  }
  app.post('/user/link', route(async (req, res) => {
    if (Object.keys(req.body || {}).length) fail('qa_authority_request_invalid', 400);
    res.json(await service.linkOwnIdentity(await userIdentity(req)));
  }));
  app.delete('/user/link', route(async (req, res) => {
    let qaToken;
    try { qaToken = await verifyQaToken(token(req.header('authorization'))); }
    catch { fail('qa_authority_auth_required', 401); }
    res.json(await service.unlinkOwnIdentity({ qaToken }));
  }));
  app.put('/user/project-grants/:projectId', route(async (req, res) => {
    if (Object.keys(req.body || {}).length) fail('qa_authority_request_invalid', 400);
    res.json(await service.linkOwnIdentity({ ...await userIdentity(req), projectId: req.params.projectId }));
  }));
  app.post('/internal/authorize-member', route(async (req, res) => {
    let payload;
    try { payload = await verifyWorkerToken(token(req.header('authorization')), workerAudience); }
    catch { fail('qa_authority_auth_required', 401); }
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload?.iss)
      || payload.aud !== workerAudience || payload.email_verified !== true
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.sub || '')
      || !workerEmails.includes(payload.email) || !memberWorkerEmails.includes(payload.email))
      fail('qa_authority_worker_forbidden');
    if (!req.body || Object.keys(req.body).join(',') !== 'qa_actor_id'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(req.body.qa_actor_id || ''))
      fail('qa_authority_request_invalid', 400);
    res.json(await service.authorizeMember(req.body));
  }));
  app.post('/internal/authorize-case-project', route(async (req, res) => {
    let payload;
    try { payload = await verifyWorkerToken(token(req.header('authorization')), workerAudience); }
    catch { fail('qa_authority_auth_required', 401); }
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload?.iss)
      || payload.aud !== workerAudience || payload.email_verified !== true
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.sub || '')
      || !workerEmails.includes(payload.email) || !projectWorkerEmails.includes(payload.email))
      fail('qa_authority_worker_forbidden');
    const body = req.body;
    if (!body || Object.keys(body).sort().join(',') !== 'case_id,project_id,run_id'
      || !UUID.test(body.case_id || '') || !UUID.test(body.run_id?.slice(3) || '')
      || body.run_id !== `qa-${body.run_id.slice(3)}` || !/^p[0-9]{10,20}$/.test(body.project_id || ''))
      fail('qa_authority_request_invalid', 400);
    res.json(await service.authorizeCaseProject(body));
  }));
  app.post('/internal/authorize-case', route(async (req, res) => {
    let payload;
    try { payload = await verifyWorkerToken(token(req.header('authorization')), workerAudience); }
    catch { fail('qa_authority_auth_required', 401); }
    if (!['https://accounts.google.com', 'accounts.google.com'].includes(payload?.iss)
      || payload.aud !== workerAudience || payload.email_verified !== true
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.sub)
      || !workerEmails.includes(payload.email)) fail('qa_authority_worker_forbidden');
    const body = req.body;
    if (body?.phase === 'reopen' && !reopenWorkerEmails.includes(payload.email)) fail('qa_authority_worker_forbidden');
    if (!body || Object.keys(body).sort().join(',') !== 'case_id,phase,run_id'
      || !UUID.test(body.case_id || '') || !UUID.test(body.run_id?.slice(3) || '')
      || body.run_id !== `qa-${body.run_id.slice(3)}`)
      fail('qa_authority_request_invalid', 400);
    res.json(await service.authorizeCase(body));
  }));
  return app;
}
