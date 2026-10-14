import { readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const NAME = 'read_bff_request_log_snapshot';
const DEPLOYMENT = 'dpl_CEpFLsfaiAkYneZ4658qZUqTZxcH';
const PROJECT = 'prj_aYK7ibY0SrmbuGpRPVz2PAl0Ioq0';
const PROJECTS = [
  'p1779092105308',
  'p1775179565523',
  'p1775209276694',
  'p1776043128740',
  'p1784169189118',
];
const START = '2026-10-12T08:00:00Z',
  END = '2026-10-12T08:10:00Z';
const NOTE =
  'Filtered request metadata and allowlisted structured log fields; not full traffic or environment values.';
const invalid = () => {
  throw new Error('invalid_bff_log_snapshot');
};
function exact(v, keys) {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    invalid();
}
function timestamp(v) {
  if (
    typeof v !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(v) ||
    !Number.isFinite(Date.parse(v))
  )
    invalid();
  return Date.parse(v);
}
export async function createBffLogSnapshotTools({ snapshotPath }) {
  if (typeof snapshotPath !== 'string' || !snapshotPath) invalid();
  const stat = await lstat(snapshotPath);
  if (!stat.isFile() || stat.size > 262144) invalid();
  let data;
  try {
    data = JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch {
    invalid();
  }
  exact(data, [
    'schema_version',
    'observed_at',
    'source_api',
    'source_kind',
    'query',
    'rows',
    'coverage',
  ]);
  if (
    data.schema_version !== 1 ||
    data.source_api !== 'Vercel CLI 60.1.3 request logs' ||
    data.source_kind !== 'authenticated_operator_import'
  )
    invalid();
  const observed = timestamp(data.observed_at);
  exact(data.query, [
    'project_id',
    'deployment_id',
    'start_at',
    'end_at',
    'http_status',
    'limit',
  ]);
  const q = data.query;
  if (
    q.project_id !== PROJECT ||
    q.deployment_id !== DEPLOYMENT ||
    q.start_at !== START ||
    q.end_at !== END ||
    q.http_status !== 503 ||
    q.limit !== 100
  )
    invalid();
  if (!Array.isArray(data.rows) || !data.rows.length || data.rows.length > 100)
    invalid();
  const ids = new Set();
  for (const r of data.rows) {
    exact(r, [
      'timestamp',
      'vercel_request_id',
      'request_id',
      'deployment_id',
      'domain',
      'method',
      'path',
      'status',
      'events',
    ]);
    const time = timestamp(r.timestamp);
    if (time < Date.parse(START) || time >= Date.parse(END) || time > observed)
      invalid();
    if (
      typeof r.vercel_request_id !== 'string' ||
      !/^[A-Za-z0-9:_-]{1,200}$/.test(r.vercel_request_id) ||
      typeof r.request_id !== 'string' ||
      !/^req_\d{13}_[a-f0-9]{16,64}$/.test(r.request_id)
    )
      invalid();
    if (ids.has(r.vercel_request_id)) invalid();
    ids.add(r.vercel_request_id);
    if (
      r.deployment_id !== DEPLOYMENT ||
      r.domain !== 'myscube.myscguard.app' ||
      r.method !== 'GET' ||
      r.status !== 503 ||
      !PROJECTS.some((id) => r.path === `/api/v1/cashflow/${id}/month-close`)
    )
      invalid();
    if (!Array.isArray(r.events) || !r.events.length || r.events.length > 20)
      invalid();
    for (const e of r.events) {
      exact(e, ['operation', 'phase', 'status_code', 'error_code']);
      if (
        !['get', 'cashflow.month_close.read'].includes(e.operation) ||
        !['request_rejected', 'jvm_dashboard'].includes(e.phase) ||
        e.status_code !== 503 ||
        e.error_code !== 'jvm_weekly_api_unconfigured'
      )
        invalid();
    }
  }
  exact(data.coverage, [
    'complete',
    'raw_logs_included',
    'source_credentials_included',
    'scope',
    'note',
  ]);
  const c = data.coverage;
  if (
    c.complete !== false ||
    c.raw_logs_included !== false ||
    c.source_credentials_included !== false ||
    c.scope !== 'selected_503_request_logs' ||
    c.note !== NOTE
  )
    invalid();
  const content_hash = createHash('sha256')
    .update(JSON.stringify({ source: NAME, ...data }))
    .digest('hex');
  return {
    [NAME]: {
      description:
        'Read a fixed sanitized authenticated operator import of selected Vercel 503 request logs during this incident. Contains request IDs for explicit correlation. Not a live query, full traffic, environment values, or proof about unobserved downstream requests.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      async execute(args, { signal } = {}) {
        signal?.throwIfAborted();
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length
        )
          throw new Error('invalid_bff_log_request');
        return {
          evidence_id: `ev_${content_hash}`,
          content_hash,
          source: NAME,
          status: 'available',
          observed_at: data.observed_at,
          read_at: new Date().toISOString(),
          provenance: 'imported_authenticated_request_log_snapshot',
          source_api: data.source_api,
          query: structuredClone(data.query),
          rows: structuredClone(data.rows),
          coverage: structuredClone(data.coverage),
          cause_status: 'not_established',
        };
      },
    },
  };
}
