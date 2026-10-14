import { createPublicKey, verify as verifySignature } from 'node:crypto';

const QA_PROJECT = 'inner-platform-qa-20260310';
const BUSINESS_PROJECT = 'inner-platform-live-20260316';
const CERT_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const FIREBASE_TOKEN = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;
const CASE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROJECT_ID = /^p[0-9]{10,20}$/;
const AUTHORITY_ORIGIN = /^https:\/\/mysc-qa-authority-[a-z0-9-]+(?:\.asia-northeast3|\.a)?\.run\.app$/;
const INTAKE_ORIGIN = /^https:\/\/mysc-qa-intake-[a-z0-9-]+(?:\.asia-northeast3|\.a)?\.run\.app$/;

const failure = (status, code) => Object.assign(new Error(code), { status, safeCode: code });
const readJson = (value) => {
  try { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw failure(401, 'firebase_login_required'); }
};

export function createUserEntry({ auth, authorityOrigin, intakeOrigin, fetcher = fetch, now = () => Date.now() }) {
  if (!AUTHORITY_ORIGIN.test(authorityOrigin || '') || !INTAKE_ORIGIN.test(intakeOrigin || ''))
    throw Error('invalid_qa_user_service_origins');
  let certs = null;
  let certExpiry = 0;
  async function certificates() {
    if (certs && now() < certExpiry) return certs;
    let response;
    try { response = await fetcher(CERT_URL, { signal: AbortSignal.timeout(8000) }); }
    catch { throw failure(503, 'firebase_verification_unavailable'); }
    if (!response.ok) throw failure(503, 'firebase_verification_unavailable');
    const result = await response.json();
    if (!result || typeof result !== 'object' || Object.keys(result).length < 1)
      throw failure(503, 'firebase_verification_unavailable');
    const ttl = Math.min(Number(/max-age=(\d+)/.exec(response.headers.get('cache-control') || '')?.[1]) || 300, 3600);
    certs = result;
    certExpiry = now() + ttl * 1000;
    return result;
  }
  async function firebaseIdentity(header, project, iapEmail) {
    const match = FIREBASE_TOKEN.exec(header || '');
    if (!match || match[1].length > 16384) throw failure(401, 'firebase_login_required');
    const [encodedHeader, encodedPayload, encodedSignature] = match[1].split('.');
    const tokenHeader = readJson(encodedHeader);
    const payload = readJson(encodedPayload);
    if (tokenHeader?.alg !== 'RS256' || typeof tokenHeader.kid !== 'string' || !tokenHeader.kid)
      throw failure(401, 'firebase_login_required');
    const pem = (await certificates())[tokenHeader.kid];
    if (typeof pem !== 'string') throw failure(401, 'firebase_login_required');
    let valid = false;
    try {
      valid = verifySignature('RSA-SHA256', Buffer.from(`${encodedHeader}.${encodedPayload}`),
        createPublicKey(pem), Buffer.from(encodedSignature, 'base64url'));
    } catch { /* malformed signature */ }
    const time = Math.floor(now() / 1000);
    if (!valid || payload?.aud !== project || payload.iss !== `https://securetoken.google.com/${project}`
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(payload.sub)
      || !Number.isSafeInteger(payload.iat) || payload.iat > time + 30
      || !Number.isSafeInteger(payload.exp) || payload.exp <= time - 30
      || !Number.isSafeInteger(payload.auth_time) || payload.auth_time > time + 30
      || payload.email_verified !== true || typeof payload.email !== 'string'
      || payload.email.trim().toLowerCase() !== iapEmail)
      throw failure(403, 'identity_mismatch');
    return payload;
  }
  async function serviceRequest(origin, path, method, qaBearer, businessBearer, body) {
    let iamBearer;
    try {
      const client = await auth.getIdTokenClient(origin);
      const headers = await client.getRequestHeaders(origin);
      iamBearer = headers.get?.('authorization') || headers.Authorization || headers.authorization;
    } catch { throw failure(503, 'qa_service_unavailable'); }
    if (typeof iamBearer !== 'string' || !iamBearer.startsWith('Bearer '))
      throw failure(503, 'qa_service_unavailable');
    let response;
    try {
      response = await fetcher(`${origin}${path}`, {
        method,
        headers: {
          'Authorization': qaBearer,
          'X-Serverless-Authorization': iamBearer,
          ...(businessBearer ? { 'X-Business-Authorization': businessBearer } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(origin === intakeOrigin && method === 'POST' && body?.key ? { 'Idempotency-Key': body.key } : {}),
          ...(origin === intakeOrigin ? { 'X-Tenant-Id': 'mysc' } : {}),
        },
        ...(body ? { body: JSON.stringify(body.payload) } : {}),
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
        credentials: 'omit',
      });
    } catch { throw failure(503, 'qa_service_unavailable'); }
    if (!response.ok) {
      if (response.status === 503) {
        const error = await response.json().catch(() => ({}));
        if (['qa_lifecycle_authority_unavailable','qa_member_authority_unavailable'].includes(error?.error))
          throw failure(503, error.error);
        throw failure(503, 'qa_service_unavailable');
      }
      if ([400, 401, 403, 404, 409].includes(response.status)) {
        const error = await response.json().catch(() => ({}));
        const code = typeof error.error === 'string' && /^[a-z_]+$/.test(error.error)
          ? error.error : 'qa_request_denied';
        throw failure(response.status, code);
      }
      throw failure(503, 'qa_service_unavailable');
    }
    return response.json().catch(() => { throw failure(503, 'qa_service_unavailable'); });
  }
  async function handle(req, iapEmail, path, body, searchParams = new URLSearchParams()) {
    const qaBearer = req.headers.authorization;
    const qa = await firebaseIdentity(qaBearer, QA_PROJECT, iapEmail);
    const needsBusiness = path === '/api/me/link' && req.method === 'POST'
      || /^\/api\/me\/project-grants\//.test(path);
    const businessBearer = needsBusiness ? req.headers['x-business-authorization'] : null;
    if (needsBusiness) await firebaseIdentity(businessBearer, BUSINESS_PROJECT, iapEmail);
    if (path === '/api/me/link' && req.method === 'POST') {
      if (!body || Object.keys(body).length) throw failure(400, 'invalid_request');
      return serviceRequest(authorityOrigin, '/user/link', 'POST', qaBearer, businessBearer, { payload: {} });
    }
    if (path === '/api/me/link' && req.method === 'DELETE')
      return serviceRequest(authorityOrigin, '/user/link', 'DELETE', qaBearer, null);
    const grant = /^\/api\/me\/project-grants\/(p[0-9]{10,20})$/.exec(path);
    if (grant && req.method === 'PUT') {
      if (!body || Object.keys(body).length) throw failure(400, 'invalid_request');
      return serviceRequest(authorityOrigin, `/user/project-grants/${grant[1]}`, 'PUT', qaBearer, businessBearer, { payload: {} });
    }
    if (path === '/api/me/cases' && req.method === 'POST') {
      if (!body || typeof body !== 'object' || !/^[a-f0-9-]{36}$/i.test(body.idempotency_key || ''))
        throw failure(400, 'invalid_request');
      const { idempotency_key, ...payload } = body;
      if (payload.investigation_target?.kind === 'project' && !PROJECT_ID.test(payload.investigation_target.project_id || ''))
        throw failure(400, 'invalid_request');
      return serviceRequest(intakeOrigin, '/api/v1/qa-cases', 'POST', qaBearer, null,
        { key: idempotency_key, payload });
    }
    if (['/api/me/cases', '/api/me/shared-cases'].includes(path) && req.method === 'GET') {
      const keys = [...searchParams.keys()];
      if (keys.some((key) => !['limit', 'cursor'].includes(key))
        || keys.filter((key) => key === 'limit').length > 1
        || keys.filter((key) => key === 'cursor').length > 1)
        throw failure(400, 'invalid_request');
      const limit = searchParams.get('limit') || '50';
      const cursor = searchParams.get('cursor');
      if (!/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit) || (cursor && !CASE_ID.test(cursor)))
        throw failure(400, 'invalid_request');
      const query = `?limit=${limit}${cursor ? `&cursor=${cursor}` : ''}`;
      const endpoint = path === '/api/me/shared-cases' ? 'qa-shared-cases' : 'qa-cases';
      return serviceRequest(intakeOrigin, `/api/v1/${endpoint}${query}`, 'GET', qaBearer, null);
    }
    const publication = /^\/api\/me\/cases\/([a-f0-9-]{36})\/publication$/i.exec(path);
    if (publication && CASE_ID.test(publication[1])) {
      const target = `/api/v1/qa-cases/${publication[1]}/publication`;
      if (req.method === 'GET') return serviceRequest(intakeOrigin, target, 'GET', qaBearer, null);
      if (req.method === 'POST') {
        if (!body || !CASE_ID.test(body.idempotency_key || '') || !['publish', 'withdraw'].includes(body.action))
          throw failure(400, 'invalid_request');
        const { idempotency_key, ...payload } = body;
        return serviceRequest(intakeOrigin, target, 'POST', qaBearer, null, { key: idempotency_key, payload });
      }
    }
    const lifecycle = /^\/api\/me\/cases\/([a-f0-9-]{36})\/lifecycle$/i.exec(path);
    if (lifecycle && CASE_ID.test(lifecycle[1])) {
      const target = `/api/v1/qa-cases/${lifecycle[1]}/lifecycle`;
      if (req.method === 'GET') return serviceRequest(intakeOrigin, target, 'GET', qaBearer, null);
      if (req.method === 'POST') {
        if (!body || !/^[a-f0-9-]{36}$/i.test(body.idempotency_key || '')
          || !['cancel', 'reopen'].includes(body.action)
          || !Number.isSafeInteger(body.expected_version) || body.expected_version < 0
          || typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 500
          || Object.keys(body).sort().join(',') !== 'action,expected_version,idempotency_key,reason')
          throw failure(400, 'invalid_request');
        return serviceRequest(intakeOrigin, target, 'POST', qaBearer, null, {
          key: body.idempotency_key,
          payload: { action: body.action, expected_version: body.expected_version, reason: body.reason.trim() },
        });
      }
    }
    const caseMatch = /^\/api\/me\/cases\/([a-f0-9-]{36})(\/activity|\/result)?$/i.exec(path);
    if (caseMatch && req.method === 'GET' && CASE_ID.test(caseMatch[1]))
      return serviceRequest(intakeOrigin,
        `/api/v1/qa-cases/${caseMatch[1]}${caseMatch[2] || ''}`, 'GET', qaBearer, null);
    throw failure(404, 'not_found');
  }
  return { handle, firebaseIdentity };
}
