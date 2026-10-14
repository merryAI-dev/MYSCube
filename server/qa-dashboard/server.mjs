import {createOperationsReader} from './operations.mjs';
import {
  projectStages,
  safeDiagnostics,
  projectRunMetrics,
  projectInvestigationQuality,
} from './stages.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import { createUserEntry } from './user-entry.mjs';

const project = 'inner-platform-qa-20260310';
const audience =
  '/projects/1084486080400/locations/asia-northeast3/services/mysc-qa-dashboard';
if (
  process.env.GOOGLE_CLOUD_PROJECT !== project ||
  process.env.FIRESTORE_EMULATOR_HOST
)
  throw new Error('invalid_dashboard_environment');
const base = `https://firestore.googleapis.com/v1/projects/${project}/databases/qa-assistant/documents/orgs/mysc`;
const auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
});
const operations = createOperationsReader({request: async (options) => {
  const client=await auth.getClient();
  return (await client.request({...options,timeout:8000,retry:false})).data;
}});
const oauth = new OAuth2Client();
const userEntry = createUserEntry({
  auth,
  authorityOrigin: process.env.QA_AUTHORITY_ORIGIN,
  intakeOrigin: process.env.QA_INTAKE_ORIGIN,
});
const page = await readFile('./index.html', 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)?.[1];
if (!script) throw new Error('missing_dashboard_script');
const scriptHash = createHash('sha256').update(script).digest('base64');
let certCache,
  certExpires = 0;
const safeError = (status, code) =>
  Object.assign(new Error(code), { status, safeCode: code });
async function identity(req) {
  const assertion = req.headers['x-goog-iap-jwt-assertion'];
  if (typeof assertion !== 'string' || assertion.length > 16384)
    throw safeError(401, 'login_required');
  try {
    if (!certCache || Date.now() >= certExpires) {
      certCache = (await oauth.getIapPublicKeys()).pubkeys;
      certExpires = Date.now() + 5 * 60 * 1000;
    }
    const ticket = await oauth.verifySignedJwtWithCertsAsync(
      assertion,
      certCache,
      audience,
      ['https://cloud.google.com/iap']
    );
    const payload = ticket.getPayload();
    const seconds = Date.now() / 1000;
    if (
      !payload?.sub ||
      typeof payload.email !== 'string' ||
      !payload.email.toLowerCase().endsWith('@mysc.co.kr') ||
      payload.hd !== 'mysc.co.kr' ||
      !Number.isFinite(payload.iat) ||
      !Number.isFinite(payload.exp) ||
      payload.iat > seconds + 30 ||
      payload.exp < seconds - 30 ||
      payload.exp - payload.iat > 660
    )
      throw new Error('invalid_identity');
    return payload.email.trim().toLowerCase();
  } catch {
    throw safeError(403, 'organization_access_required');
  }
}
function decode(value) {
  if (!value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields);
  return null;
}
const decodeFields = (value) =>
  Object.fromEntries(
    Object.entries(value || {}).map(([k, v]) => [k, decode(v)])
  );
async function source(url, data) {
  try {
    const client = await auth.getClient();
    return (
      await client.request({
        url,
        method: data ? 'POST' : 'GET',
        ...(data ? { data } : {}),
        timeout: 15000,
        retry: false,
      })
    ).data;
  } catch (error) {
    throw safeError(
      Number(error?.response?.status) === 404 ? 404 : 503,
      'source_unavailable'
    );
  }
}
const safeText = (value) =>
  String(value)
    .replace(/Bearer\s+\S+/gi, '[비공개]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[이메일 비공개]');
const strings = (value, max = 12000) =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every((s) => typeof s === 'string' && s.length <= max);
const claims = (value) =>
  Array.isArray(value) &&
  value.length <= 50 &&
  value.every(
    (c) =>
      typeof c?.claim === 'string' &&
      c.claim.length <= 4000 &&
      strings(c.evidence_ids, 100) &&
      c.evidence_ids.every((id) => /^ev_[a-f0-9]{64}$/.test(id))
  );
function projectRun(doc, detail = false) {
  const run = decodeFields(doc.fields),
    id = doc.name?.split('/').at(-1);
  if (run.visibility !== 'organization') return null;
  if (
    run.schema_version !== 1 ||
    run.tenant_id !== 'mysc' ||
    id !== run.run_id ||
    !/^[a-z0-9-]{8,100}$/.test(id || '') ||
    !['running', 'completed', 'needs_review', 'failed'].includes(run.status) ||
    typeof run.title !== 'string' ||
    run.title.length > 300 ||
    typeof run.model !== 'string' ||
    run.model.length > 120 ||
    !Number.isFinite(Date.parse(run.created_at)) ||
    !Number.isFinite(Date.parse(run.updated_at)) ||
    !['model_step', 'tool_count', 'checkpoint_count', 'evidence_count'].every(
      (k) => Number.isSafeInteger(run[k]) && run[k] >= 0
    ) ||
    !Array.isArray(run.tool_names) ||
    run.tool_names.length > 100 ||
    run.tool_names.some((n) => !/^[a-z_]{1,64}$/.test(n))
  )
    throw safeError(503, 'invalid_run');
  const result = Object.fromEntries(
    [
      'run_id',
      'status',
      'model',
      'created_at',
      'updated_at',
      'model_step',
      'tool_count',
      'checkpoint_count',
      'evidence_count',
      'tool_names',
    ].map((k) => [k, run[k]])
  );
  Object.assign(result, projectRunMetrics(run));
  Object.assign(result, {
    title: safeText(run.title),
    review_accepted: run.review?.accepted === true,
    delivery_status:
      run.delivery_status === 'not_sent' ? 'not_sent' : 'unknown',
    verification_kind:
      run.verification_kind === 'real_cloud_evaluation'
        ? 'real_cloud_evaluation'
        : 'unspecified',
  });
  if (detail) {
    Object.assign(result, safeDiagnostics(run));
    try {
      Object.assign(result, projectInvestigationQuality(run, safeText));
    } catch {
      throw safeError(503, 'invalid_quality_projection');
    }
    result.answer = null;
    if (run.status === 'completed' && run.review?.accepted === true) {
      const a = run.answer;
      if (
        !a ||
        !claims(a.facts) ||
        !claims(a.hypotheses) ||
        !strings(a.unknowns) ||
        !strings(a.next_actions) ||
        typeof a.user_reply !== 'string' ||
        a.user_reply.length > 12000 ||
        !['supported', 'not_established'].includes(a.cause_status)
      )
        throw safeError(503, 'invalid_answer');
      result.answer = {
        facts: a.facts.map((c) => ({
          claim: safeText(c.claim),
          evidence_ids: c.evidence_ids,
        })),
        hypotheses: a.hypotheses.map((c) => ({
          claim: safeText(c.claim),
          evidence_ids: c.evidence_ids,
        })),
        unknowns: a.unknowns.map(safeText),
        next_actions: a.next_actions.map(safeText),
        user_reply: safeText(a.user_reply),
        cause_status: a.cause_status,
      };
    }
  }
  return result;
}
async function listRuns() {
  const docs = await source(`${base}:runQuery`, {
    structuredQuery: {
      from: [{ collectionId: 'qa_runs' }],
      orderBy: [
        { field: { fieldPath: 'created_at' }, direction: 'DESCENDING' },
      ],
      limit: 51,
    },
  });
  const rows = docs.filter((d) => d.document).map((d) => d.document);
  return {
    items: rows
      .slice(0, 50)
      .map((d) => projectRun(d))
      .filter(Boolean),
    truncated: rows.length > 50,
  };
}
async function detailRun(id) {
  const doc = await source(`${base}/qa_runs/${id}`),
    result = projectRun(doc, true);
  if (!result) throw safeError(404, 'run_not_found');
  const entries = await source(
    `${base}/qa_runs/${id}/checkpoints?pageSize=200&orderBy=sequence`
  );
  const checkpoints = [];
  for (const checkpoint of entries.documents || []) {
    const c = decodeFields(checkpoint.fields);
    if (
      !Number.isSafeInteger(c.sequence) ||
      !Number.isFinite(Date.parse(c.occurred_at)) ||
      !Number.isSafeInteger(c.model_step)
    )
      throw safeError(503, 'invalid_timeline');
    let payload;
    try {
      payload = JSON.parse(c.payload_json);
    } catch {
      throw safeError(503, 'invalid_timeline');
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw safeError(503, 'invalid_timeline');
    if (
      (payload.toolCalls &&
        (!Array.isArray(payload.toolCalls) || payload.toolCalls.length > 16)) ||
      (payload.results &&
        (!Array.isArray(payload.results) || payload.results.length > 16))
    )
      throw safeError(503, 'invalid_timeline');
    checkpoints.push({
      sequence: c.sequence,
      phase: c.phase,
      occurred_at: c.occurred_at,
      model_step: c.model_step,
      payload,
    });
  }
  Object.assign(
    result,
    projectStages(result, checkpoints, { truncated: !!entries.nextPageToken })
  );
  return result;
}
http
  .createServer(async (req, res) => {
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'Content-Type': type });
      res.end(
        type.startsWith('application/json') ? JSON.stringify(body) : body
      );
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'sha256-${scriptHash}' https://www.gstatic.com https://apis.google.com; style-src 'unsafe-inline'; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com https://www.googleapis.com https://apis.google.com https://*.firebaseapp.com; frame-src https://*.firebaseapp.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self' https://*.firebaseapp.com`
    );
    try {
      const email = await identity(req);
      const url = new URL(req.url, 'http://internal');
      if (url.search && !(['/api/me/cases', '/api/me/shared-cases', '/api/me/assignment-inbox'].includes(url.pathname) && req.method === 'GET'))
        throw safeError(400, 'invalid_request');
      if (url.pathname.startsWith('/api/me/')) {
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(req.method))
          throw safeError(405, 'method_not_allowed');
        if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
          const origin = req.headers.origin;
          const host = req.headers.host;
          if (origin !== `https://${host}` || req.headers['x-qa-action'] !== 'dashboard')
            throw safeError(403, 'invalid_request_origin');
        }
        let body = null;
        if (req.method === 'POST' || req.method === 'PUT') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || ''))
            throw safeError(415, 'json_required');
          let raw = '';
          for await (const chunk of req) {
            raw += chunk;
            if (raw.length > 8192) throw safeError(413, 'request_too_large');
          }
          try { body = JSON.parse(raw); }
          catch { throw safeError(400, 'invalid_request'); }
          if (!body || Array.isArray(body) || typeof body !== 'object')
            throw safeError(400, 'invalid_request');
        }
        return send(200, await userEntry.handle(req, email, url.pathname, body, url.searchParams));
      }
      if (req.method !== 'GET') throw safeError(405, 'method_not_allowed');
      if (url.pathname === '/')
        return send(200, page, 'text/html; charset=utf-8');
      if (url.pathname === '/api/session') return send(200, { email });
      if (url.pathname === '/api/operations') return send(200, await operations());
      if (url.pathname === '/api/runs') return send(200, await listRuns());
      const match = url.pathname.match(/^\/api\/runs\/([a-z0-9-]{8,100})$/);
      if (match) return send(200, await detailRun(match[1]));
      throw safeError(404, 'not_found');
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 503;
      const code = /^[a-z_]+$/.test(error?.safeCode || '')
        ? error.safeCode
        : 'dashboard_unavailable';
      console.error(
        JSON.stringify({
          severity: status >= 500 ? 'ERROR' : 'WARNING',
          error_code: code,
          status,
        })
      );
      send(status, { error: code });
    }
  })
  .listen(Number(process.env.PORT || 8080), '0.0.0.0');
