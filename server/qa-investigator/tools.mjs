import { myscRequestPath } from './request-path.mjs';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';

const CLOUD_PROJECT = 'inner-platform-live-20260316';
const TENANT = 'mysc';
const PROJECTS = [
  'p1779092105308',
  'p1774438127328',
  'p1775179565523',
  'p1775209276694',
  'p1776043128740',
  'p1784169189118',
];
const REPORT_ARTIFACTS = Object.freeze({
  dtips: 'dtips-evaluation.json',
  'jvm-unconfigured': 'jvm-unconfigured-evaluation.json',
});
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;
const ISO =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const scalar = (value) =>
  ['string', 'number', 'boolean'].includes(typeof value) &&
  String(value).length <= 200;
const select = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => scalar(value?.[key])).map((key) => [key, value[key]])
  );
const schema = (properties, required) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const timeParameters = {
  start_at: { type: 'string', format: 'date-time' },
  end_at: { type: 'string', format: 'date-time' },
};
const fields = (names) => names.map((fieldPath) => ({ fieldPath }));
const timestamp = (value) =>
  typeof value === 'string' &&
  ISO.test(value) &&
  Number.isFinite(Date.parse(value));
const safeRequestId = (value) =>
  typeof value === 'string' &&
  /^(?:req_[A-Za-z0-9_-]{1,120}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(
    value
  )
    ? value
    : null;
const safeErrorCode = (value) =>
  typeof value === 'string' && /^[a-z][a-z0-9_]{0,99}$/.test(value)
    ? value
    : null;
const safeSha = (value) =>
  typeof value === 'string' && /^[a-f0-9]{40}$/.test(value) ? value : null;
function clientRequestPath(value, projectIds) {
  if (typeof value !== 'string' || value.length > 4000) return null;
  let path;
  try {
    path = new URL(value, 'https://request-path.invalid').pathname;
  } catch {
    return null;
  }
  if (path === '/api/v1/cashflow/projection-actual-summary/batch') return path;
  if (path.length > 250 || !/^\/[A-Za-z0-9/_-]+$/.test(path)) return null;
  return projectIds.some((id) => path.startsWith(`/api/v1/cashflow/${id}/`))
    ? path
    : null;
}
const platformClientRequestPath = myscRequestPath;
function invalid() {
  throw Object.assign(new Error('Invalid investigation scope'), {
    safeCode: 'invalid_scope',
  });
}
function strict(input, keys) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    invalid();
}
function decode(value) {
  if (!value || typeof value !== 'object') return null;
  if ('stringValue' in value) return value.stringValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('booleanValue' in value) return value.booleanValue;
  if ('mapValue' in value) return decodeFields(value.mapValue.fields);
  if ('arrayValue' in value)
    return (value.arrayValue.values || []).slice(0, 100).map(decode);
  return null;
}
function decodeFields(value = {}) {
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, decode(item)])
  );
}
function errorCode(error) {
  if (['invalid_scope', 'actor_scope_changed'].includes(error?.safeCode))
    return error.safeCode;
  const status = Number(
    error?.response?.status || error?.status || error?.code
  );
  return status === 403
    ? 'source_access_denied'
    : status === 401
      ? 'source_auth_unavailable'
      : 'source_unavailable';
}

// A report ID selects a packaged operator artifact, never a caller supplied path
// or authority. The legacy report remains byte-for-byte unchanged for replay.
export async function loadEvaluationReport(reportId = 'dtips') {
  if (
    typeof reportId !== 'string' ||
    !Object.hasOwn(REPORT_ARTIFACTS, reportId)
  ) {
    throw new Error('invalid_report_id');
  }
  let request;
  try {
    request = JSON.parse(
      await readFile(
        new URL(`./${REPORT_ARTIFACTS[reportId]}`, import.meta.url),
        'utf8'
      )
    );
  } catch {
    throw new Error('invalid_report_artifact');
  }
  const title =
    request?.title ??
    (reportId === 'dtips' ? 'D-TIPS·농식품 월별 정산 제보 조사' : undefined);
  if (
    request?.schema_version !== 1 ||
    request?.policy?.tenant !== TENANT ||
    !request.report ||
    typeof request.report !== 'object' ||
    Array.isArray(request.report) ||
    typeof request.report.text !== 'string' ||
    !request.report.text.trim() ||
    typeof title !== 'string' ||
    title !== title.trim() ||
    !title.length ||
    title.length > 160 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(title)
  ) {
    throw new Error('invalid_report_artifact');
  }
  return { reportId, title, request };
}

// policy is trusted server configuration, never copied from model tool arguments.
export function createInvestigationTools({
  auth,
  policy,
  allowDynamicScope = false,
}) {
  const platformOnly = allowDynamicScope && policy?.scopeKind === 'platform'
    && Array.isArray(policy.allowedProjectIds) && policy.allowedProjectIds.length === 0
    && typeof policy.trustedActorId === 'string' && IDENTIFIER.test(policy.trustedActorId);
  if (
    !auth ||
    !policy ||
    policy.cloudProject !== CLOUD_PROJECT ||
    policy.tenant !== TENANT ||
    !Array.isArray(policy.allowedProjectIds) ||
    (!policy.allowedProjectIds.length && !platformOnly) ||
    new Set(policy.allowedProjectIds).size !==
      policy.allowedProjectIds.length ||
    policy.allowedProjectIds.some((id) =>
      allowDynamicScope ? !/^p[0-9]{10,20}$/.test(id) : !PROJECTS.includes(id)
    ) ||
    !timestamp(policy.allowedStartAt) ||
    !timestamp(policy.allowedEndAt) ||
    Date.parse(policy.allowedStartAt) >= Date.parse(policy.allowedEndAt) ||
    (platformOnly && Date.parse(policy.allowedEndAt) - Date.parse(policy.allowedStartAt) > 86400000) ||
    !Array.isArray(policy.services) ||
    (!policy.services.length && !platformOnly) ||
    policy.services.some(
      (service) =>
        service.name !== 'innerplatform-jvm-weekly-api-live' ||
        !['us-central1', 'asia-northeast3'].includes(service.region)
    ) ||
    (policy.trustedActorId != null && !IDENTIFIER.test(policy.trustedActorId))
  ) {
    throw new Error('Invalid trusted investigation policy');
  }
  const config = structuredClone(policy);
  const projectParameter = {
    type: 'string',
    enum: [...config.allowedProjectIds],
  };
  const base = `https://firestore.googleapis.com/v1/projects/${CLOUD_PROJECT}/databases/(default)/documents`;
  const tenantPath = `orgs/${TENANT}`;
  let client;
  const execution = new AsyncLocalStorage();
  async function request(url, method = 'GET', data) {
    const signal = execution.getStore()?.signal;
    signal?.throwIfAborted();
    client ||= await auth.getClient();
    const result = await client.request({
      url,
      method,
      ...(data === undefined ? {} : { data }),
      timeout: 20000,
      retry: false,
      ...(signal ? { signal } : {}),
    });
    return result.data;
  }
  async function document(path, keys) {
    const query = new URLSearchParams();
    for (const key of keys) query.append('mask.fieldPaths', key);
    try {
      const result = await request(`${base}/${tenantPath}/${path}?${query}`);
      return {
        exists: true,
        value: decodeFields(result.fields),
        update_time: result.updateTime || null,
      };
    } catch (error) {
      if (Number(error?.response?.status || error?.code) === 404)
        return { exists: false, value: {}, update_time: null };
      throw error;
    }
  }
  function project(id) {
    if (!config.allowedProjectIds.includes(id)) invalid();
    return id;
  }
  function window(input) {
    if (
      !timestamp(input.start_at) ||
      !timestamp(input.end_at) ||
      Date.parse(input.start_at) >= Date.parse(input.end_at) ||
      Date.parse(input.start_at) < Date.parse(config.allowedStartAt) ||
      Date.parse(input.end_at) > Date.parse(config.allowedEndAt)
    )
      invalid();
    return {
      start_at: new Date(input.start_at).toISOString(),
      end_at: new Date(input.end_at).toISOString(),
    };
  }
  function tool(name, description, parameters, execute, provenance = () => ({})) {
    return {
      description,
      parameters,
      async execute(input, { signal } = {}) {
        const observed_at = new Date().toISOString();
        let bound = {};
        try {
          signal?.throwIfAborted();
          bound = provenance(input);
          const result = await execution.run({ signal }, () => execute(input));
          const content_hash = hash({ tool: name, ...bound, ...result });
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: name,
            ...bound,
            ...result,
            cause_status: 'not_established',
          };
        } catch (error) {
          const code = errorCode(error);
          const body = {
            observed_at,
            source: name,
            status: 'unavailable',
            ...bound,
            error_code: code,
            rows: [],
            coverage: { complete: false },
            cause_status: 'not_established',
          };
          const content_hash = hash(body);
          return { evidence_id: `ev_${content_hash}`, content_hash, ...body };
        }
      },
    };
  }

  const registry = {};
  registry.read_project_state = tool(
    'read_project_state',
    'Read current canonical project and settlement metadata. Current state is not historical incident state; excludes amounts and contact data.',
    schema(
      {
        project_id: projectParameter,
        cycle_year_month: {
          type: 'string',
          pattern: '^20[0-9]{2}-(0[1-9]|1[0-2])$',
        },
      },
      ['project_id', 'cycle_year_month']
    ),
    async (input) => {
      strict(input, ['project_id', 'cycle_year_month']);
      const id = project(input.project_id);
      if (
        typeof input.cycle_year_month !== 'string' ||
        !/^20\d{2}-(0[1-9]|1[0-2])$/.test(input.cycle_year_month)
      )
        invalid();
      const month = input.cycle_year_month;
      const target = new Date(`${month}-01T00:00:00Z`);
      target.setUTCMonth(target.getUTCMonth() - 1);
      const months = [month, target.toISOString().slice(0, 7)];
      const specs = [
        [
          'project',
          `projects/${id}`,
          [
            'id',
            'version',
            'status',
            'executiveApproverId',
            'managerId',
            'updatedAt',
          ],
        ],
        [
          'coordinator',
          `cashflow_month_close_requests/__active__-${id}`,
          [
            'documentType',
            'projectId',
            'activeState',
            'activeCycleYearMonth',
            'activeRequestId',
            'workflowRevision',
            'updatedAt',
          ],
        ],
        [
          'request',
          `cashflow_month_close_requests/${id}-${month}`,
          [
            'projectId',
            'status',
            'workflowRevision',
            'cycleYearMonth',
            'throughMonth',
            'updatedAt',
            'createdAt',
          ],
        ],
        ...months.map((m) => [
          `settlement:${m}`,
          `cashflow_settlement_statuses/${id}-${m}`,
          [
            'projectId',
            'yearMonth',
            'status',
            'revision',
            'updatedAt',
            'periods.MONTH.status',
            'periods.MONTH.revision',
            'periods.MONTH.submittedAt',
            'periods.MONTH.approvedAt',
          ],
        ]),
        ...months.map((m) => [
          `close:${m}`,
          `monthly_closes/${id}-${m}`,
          ['projectId', 'yearMonth', 'status', 'version', 'updatedAt'],
        ]),
        [
          'head',
          `cashflow_cumulative_close_heads/${id}`,
          [
            'projectId',
            'tenantId',
            'closedThrough',
            'settlementMonth',
            'status',
            'contractVersion',
            'fromMonth',
            'rootHash',
            'revision',
            'updatedAt',
          ],
        ],
      ];
      const rows = [];
      for (const [kind, path, keys] of specs) {
        const doc = await document(path, keys);
        const data = select(
          doc.value,
          keys.filter(
            (key) => !['managerId', 'executiveApproverId'].includes(key)
          )
        );
        if (kind.startsWith('settlement:'))
          data.month = select(doc.value.periods?.MONTH, [
            'status',
            'revision',
            'submittedAt',
            'approvedAt',
          ]);
        if (kind === 'project') {
          for (const [field, label] of [
            ['managerId', 'manager'],
            ['executiveApproverId', 'approver'],
          ]) {
            const uid = doc.value[field];
            data[`${label}_configured`] = typeof uid === 'string' && !!uid;
            if (typeof uid === 'string' && IDENTIFIER.test(uid)) {
              const member = await document(`members/${uid}`, ['status']);
              data[`${label}_active`] =
                member.exists && member.value.status === 'ACTIVE';
            }
          }
        }
        rows.push({
          kind,
          exists: doc.exists,
          update_time: doc.update_time,
          data,
        });
      }
      return {
        status: 'available',
        project_id: id,
        cycle_year_month: month,
        rows,
        coverage: {
          complete: true,
          scope: 'current_selected_documents',
          historical_state: false,
          atomic_snapshot: false,
          canonical_head_validity: 'not_evaluated',
          lock_scope: 'unknown',
          monthly_closes_are_history_not_lock_authority: true,
        },
      };
    }
  );

  registry.read_cashflow_sheet_diagnostics = tool(
    'read_cashflow_sheet_diagnostics',
    'Read current persisted cashflow mirror diagnostics also shown in the platform UI. FRESH may coexist with lastRefreshError: prior pinned data may remain usable while a refresh failed. Not a live Google Sheets read or proof of historical state or JVM 503 cause.',
    schema({ project_id: projectParameter }, ['project_id']),
    async (input) => {
      strict(input, ['project_id']);
      const id = project(input.project_id);
      const keys = [
        'projectId',
        'status',
        'sourceRevision',
        'capturedAt',
        'lastRefreshAttemptAt',
        'lastRefreshError.code',
        'lastRefreshError.at',
        'lastRefreshError.diagnosticCount',
        'lastRefreshError.diagnostics',
      ];
      const doc = await document(`cashflow_sheet_mirrors/${id}`, keys);
      if (doc.exists && doc.value.projectId !== id) invalid();
      const value = doc.value,
        error = value.lastRefreshError || {};
      // Only label diagnostics, never amounts, raw provider errors, URLs or credentials.
      const label = (text) =>
        typeof text === 'string' &&
        text.length > 0 &&
        text.length <= 100 &&
        /^(?:MYSC )?(?:선입금[ -]*)?(?:MYSC )?(?:매입부가세|메입부가세|인건비|직접사업비|매출액|매출부가세|팀지원금|은행이자|입금|출금|잔액)(?:\s*\((?:입금|출금)\))?$/.test(
          text.trim()
        )
          ? text.trim()
          : null;
      const cell = (text) =>
        typeof text === 'string' &&
        /^(?:[A-Z]|B[A-T])(?:[1-9]|[1-5][0-9]|60)$/.test(text)
          ? text
          : null;
      const raw = Array.isArray(error.diagnostics) ? error.diagnostics : [];
      const diagnostics = raw.slice(0, 20).flatMap((item) => {
        if (item?.code !== 'cashflow_line_invalid' || !cell(item.sourceCell))
          return [];
        // Never expose arbitrary persisted diagnostic text: extract only known business labels.
        const parsed =
          typeof item.message === 'string' && item.message.length <= 400
            ? item.message.match(
                /^([A-Z]+[0-9]+) 칸의 항목명이 (.+) 이어야 하는데 (.+)\.$/
              )
            : null;
        const expected =
          label(item.expectedLabel) ||
          (parsed && parsed[1] === item.sourceCell ? label(parsed[2]) : null);
        const actual =
          label(item.actualLabel) ||
          (parsed && parsed[1] === item.sourceCell ? label(parsed[3]) : null);
        const message =
          expected && actual
            ? `${item.sourceCell} 항목명 불일치: 기대 ${expected}, 관찰 ${actual}`
            : null;
        return [
          {
            code: item.code,
            source_cell: cell(item.sourceCell),
            message,
            ...(expected ? { expected_label: expected } : {}),
            ...(actual ? { actual_label: actual } : {}),
            message_redacted: message === null,
          },
        ];
      });
      const count =
        Number.isSafeInteger(error.diagnosticCount) &&
        error.diagnosticCount >= 0
          ? error.diagnosticCount
          : null;
      return {
        status: 'available',
        project_id: id,
        rows: [
          {
            exists: doc.exists,
            update_time: timestamp(doc.update_time) ? doc.update_time : null,
            mirror_status: ['FRESH', 'STALE', 'ERROR'].includes(value.status)
              ? value.status
              : null,
            source_revision:
              typeof value.sourceRevision === 'string' &&
              /^(?:sha256:)?[a-f0-9]{64}$/.test(value.sourceRevision)
                ? value.sourceRevision
                : null,
            captured_at: timestamp(value.capturedAt) ? value.capturedAt : null,
            last_refresh_attempt_at: timestamp(value.lastRefreshAttemptAt)
              ? value.lastRefreshAttemptAt
              : null,
            last_refresh_error: {
              code: safeErrorCode(error.code),
              at: timestamp(error.at) ? error.at : null,
              diagnostic_count: count,
              diagnostics,
            },
          },
        ],
        coverage: {
          complete:
            raw.length <= 20 &&
            diagnostics.length === raw.length &&
            diagnostics.every((item) => !item.message_redacted) &&
            (count === null || count === raw.length),
          scope: 'current_persisted_ui_label_diagnostics',
          historical_state: false,
          live_google_sheet_read: false,
          amounts_included: false,
          omitted_diagnostics:
            Math.max(raw.length, count || 0) - diagnostics.length,
          prior_fresh_snapshot_may_coexist_with_refresh_error: true,
        },
      };
    }
  );

  registry.query_runtime_logs = tool(
    'query_runtime_logs',
    'Read bounded Cloud Run HTTP metadata for one permitted project and time window. Empty results do not prove absence of frontend/BFF errors.',
    schema(
      {
        project_id: projectParameter,
        ...timeParameters,
        kind: { type: 'string', enum: ['errors', 'writes', 'reads'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      ['project_id', 'start_at', 'end_at']
    ),
    async (input) => {
      strict(input, ['project_id', 'start_at', 'end_at', 'kind', 'limit']);
      const id = project(input.project_id),
        span = window(input);
      const kind = input.kind ?? 'errors',
        limit = input.limit ?? 100;
      if (
        !['errors', 'writes', 'reads'].includes(kind) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 100
      )
        invalid();
      const serviceFilter = config.services
        .map(
          (s) =>
            `(resource.labels.service_name="${s.name}" AND resource.labels.location="${s.region}")`
        )
        .join(' OR ');
      const filter = [
        `resource.type="cloud_run_revision"`,
        `(${serviceFilter})`,
        `timestamp >= "${span.start_at}"`,
        `timestamp < "${span.end_at}"`,
        `httpRequest.requestUrl=~"^https://[^/?]+/api/v1/cashflow/${id}/"`,
        kind === 'errors'
          ? 'httpRequest.status>=400'
          : kind === 'writes'
            ? '(httpRequest.requestMethod="POST" OR httpRequest.requestMethod="PUT" OR httpRequest.requestMethod="PATCH" OR httpRequest.requestMethod="DELETE")'
            : 'httpRequest.requestMethod="GET"',
      ].join('\n');
      const result = await request(
        'https://logging.googleapis.com/v2/entries:list',
        'POST',
        {
          resourceNames: [`projects/${CLOUD_PROJECT}`],
          filter,
          orderBy: 'timestamp asc',
          pageSize: limit,
        }
      );
      let excluded = 0;
      const rows = (result.entries || []).flatMap((entry) => {
        let path = null;
        try {
          path = new URL(entry.httpRequest?.requestUrl).pathname;
        } catch {
          /* No raw URL fallback. */
        }
        if (!path?.startsWith(`/api/v1/cashflow/${id}/`) || path.length > 250) {
          excluded++;
          return [];
        }
        return [
          {
            timestamp: timestamp(entry.timestamp) ? entry.timestamp : null,
            status: Number.isInteger(entry.httpRequest?.status)
              ? entry.httpRequest.status
              : null,
            method: [
              'GET',
              'POST',
              'PUT',
              'PATCH',
              'DELETE',
              'OPTIONS',
              'HEAD',
            ].includes(entry.httpRequest?.requestMethod)
              ? entry.httpRequest.requestMethod
              : null,
            path:
              path?.startsWith(`/api/v1/cashflow/${id}/`) && path.length <= 250
                ? path
                : null,
            region: config.services.some(
              (s) => s.region === entry.resource?.labels?.location
            )
              ? entry.resource.labels.location
              : null,
            revision: /^[a-zA-Z0-9-]{1,100}$/.test(
              entry.resource?.labels?.revision_name || ''
            )
              ? entry.resource.labels.revision_name
              : null,
            trace:
              typeof entry.trace === 'string' &&
              new RegExp(
                `^projects/${CLOUD_PROJECT}/traces/[a-f0-9]{32}$`
              ).test(entry.trace)
                ? entry.trace
                : null,
          },
        ];
      });
      return {
        status: 'available',
        project_id: id,
        ...span,
        kind,
        rows,
        coverage: {
          complete: !result.nextPageToken && excluded === 0,
          excluded_path_mismatch: excluded,
          truncated: !!result.nextPageToken,
          limit,
          scope: 'selected_cloud_run_http_metadata',
          project_batch_requests_excluded: true,
          application_logs_included: false,
        },
      };
    },
    (input) => {
      strict(input, ['project_id', 'start_at', 'end_at', 'kind', 'limit']);
      const id = project(input.project_id), span = window(input);
      if (input.kind !== undefined && !['errors', 'writes', 'reads'].includes(input.kind)) invalid();
      if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)) invalid();
      return { project_id: id, ...span };
    }
  );

  registry.query_client_errors = tool(
    'query_client_errors',
    'Read bounded client error metadata for trusted actor or current active project managers. Actor association is a candidate, not proof of project or causal association.',
    schema({ ...timeParameters, ...(!platformOnly ? {project_id:projectParameter} : {}), cursor:{type:'string',maxLength:4096}}, [
      'start_at',
      'end_at',
    ]),
    async (input) => {
      strict(input, platformOnly ? ['start_at', 'end_at', 'cursor'] : ['start_at', 'end_at', 'project_id', 'cursor']);
      const span = window(input),
        ids = platformOnly ? [] : input.project_id
          ? [project(input.project_id)]
          : config.allowedProjectIds;
      const actors = new Set();
      const managerBindings = new Map();
      if (config.trustedActorId) actors.add(config.trustedActorId);
      else
        for (const id of ids) {
          const doc = await document(`projects/${id}`, ['managerId']);
          if (
            typeof doc.value.managerId === 'string' &&
            IDENTIFIER.test(doc.value.managerId)
          ) {
            actors.add(doc.value.managerId);
            managerBindings.set(id, doc.value.managerId);
          }
        }
      const verified = [];
      for (const uid of actors) {
        const member = await document(`members/${uid}`, ['status']);
        if (member.exists && member.value.status === 'ACTIVE')
          verified.push(uid);
      }
      if (!verified.length)
        return {
          status: 'unavailable',
          error_code: 'no_verified_actor_scope',
          rows: [],
          coverage: { complete: false },
        };
      const keys = [
        'actorId',
        'createdAt',
        'occurredAt',
        'eventType',
        'level',
        'release',
        'ingestRelease',
        'clientRequestId',
        'extra.projectId',
        'tags.projectId',
        'extra.status',
        'extra.errorCode',
        'extra.code',
        'extra.requestUrl',
        'extra.requestId',
        'extra.responseRequestId',
      ];
      const cursorScope=hash({actors:[...verified].sort(),span,projects:[...ids].sort(),platformOnly});
      const prefix=`projects/${CLOUD_PROJECT}/databases/(default)/documents/${tenantPath}/client_error_events/`;
      const validPosition=position=>position&&Object.keys(position).sort().join(',')==='created_at,name,scope'
        &&position.scope===cursorScope&&timestamp(position.created_at)
        &&Date.parse(position.created_at)>=Date.parse(span.start_at)&&Date.parse(position.created_at)<Date.parse(span.end_at)
        &&typeof position.name==='string'&&position.name.startsWith(prefix)
        &&/^[A-Za-z0-9_-]{1,128}$/.test(position.name.slice(prefix.length));
      let after;
      if(input.cursor!==undefined){
        if(typeof input.cursor!=='string'||!input.cursor.length||input.cursor.length>4096||!/^[A-Za-z0-9_-]+$/.test(input.cursor))invalid();
        try{after=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'));}catch{invalid();}
        if(!validPosition(after))invalid();
      }
      const result = await request(`${base}/${tenantPath}:runQuery`, 'POST', {
        structuredQuery: {
          ...(after?{startAt:{values:[{stringValue:after.created_at},{referenceValue:after.name}],before:false}}:{}),
          from: [{ collectionId: 'client_error_events' }],
          select: { fields: fields(keys) },
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                {
                  fieldFilter: {
                    field: { fieldPath: 'actorId' },
                    op: verified.length === 1 ? 'EQUAL' : 'IN',
                    value: verified.length === 1
                      ? { stringValue: verified[0] }
                      : { arrayValue: { values: verified.map((uid) => ({ stringValue: uid })) } },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'createdAt' },
                    op: 'GREATER_THAN_OR_EQUAL',
                    value: { stringValue: span.start_at },
                  },
                },
                {
                  fieldFilter: {
                    field: { fieldPath: 'createdAt' },
                    op: 'LESS_THAN',
                    value: { stringValue: span.end_at },
                  },
                },
              ],
            },
          },
          orderBy: [
            { field: { fieldPath: 'createdAt' }, direction: 'ASCENDING' },
            { field: { fieldPath: '__name__' }, direction: 'ASCENDING' },
          ],
          limit: 101,
        },
      });
      const documents=(result||[]).filter(item=>item.document).map(item=>item.document);
      const docs=documents.map(item=>decodeFields(item.fields));
      let nextCursor=null;
      if(documents.length>100){
        const position={scope:cursorScope,created_at:docs[99].createdAt,name:documents[99].name};
        if(!validPosition(position))invalid();
        nextCursor=Buffer.from(JSON.stringify(position)).toString('base64url');
      }
      const rows = docs.slice(0,100)
        .filter((row) => verified.includes(row.actorId))
        .map((row) => {
          const reportedProject = row.extra?.projectId || row.tags?.projectId;
          return {
            received_at: timestamp(row.createdAt) ? row.createdAt : null,
            occurred_at: timestamp(row.occurredAt) ? row.occurredAt : null,
            actor_mask: `actor_${hash(row.actorId).slice(0, 16)}`,
            event_type: ['exception', 'message'].includes(row.eventType)
              ? row.eventType
              : 'other',
            level: ['error', 'warn', 'info'].includes(row.level)
              ? row.level
              : null,
            http_status:
              Number.isInteger(row.extra?.status) &&
              row.extra.status >= 100 &&
              row.extra.status <= 599
                ? row.extra.status
                : null,
            error_code:
              safeErrorCode(row.extra?.errorCode) ||
              safeErrorCode(row.extra?.code),
            request_path: platformOnly
              ? platformClientRequestPath(row.extra?.requestUrl)
              : clientRequestPath(row.extra?.requestUrl, ids),
            request_id: safeRequestId(row.clientRequestId),
            reported_request_id: safeRequestId(row.extra?.requestId),
            reported_response_request_id: safeRequestId(
              row.extra?.responseRequestId
            ),
            client_release: safeSha(row.release),
            ingest_release: safeSha(row.ingestRelease),
            project_id: ids.includes(reportedProject) ? reportedProject : null,
            correlation: ids.includes(reportedProject)
              ? 'client_reported_project_and_actor'
              : 'actor_only_candidate',
          };
        });
      // Assignment or membership changes during the query invalidate the result.
      for (const [id, uid] of managerBindings) {
        const current = await document(`projects/${id}`, ['managerId']);
        if (current.value.managerId !== uid)
          throw Object.assign(new Error('Scope changed'), {
            safeCode: 'actor_scope_changed',
          });
      }
      for (const uid of verified) {
        const current = await document(`members/${uid}`, ['status']);
        if (!current.exists || current.value.status !== 'ACTIVE')
          throw Object.assign(new Error('Scope changed'), {
            safeCode: 'actor_scope_changed',
          });
      }
      return {
        status: 'available',
        ...span,
        rows,
        next_cursor:nextCursor,
        coverage: {
          complete: false,
          // Client-reported request metadata cannot establish a server-side
          // request to correlate. This describes only this bounded actor page.
          dependency_prerequisite: {
            kind: 'server_request', observed: false, scope: 'bounded_page',
          },
          scanned: Math.min(docs.length, 100),
          truncated: docs.length > 100,
          page_exhausted:nextCursor===null,
          snapshot_consistent:false,
          limit: 100,
          scope: config.trustedActorId
            ? 'trusted_actor'
            : 'current_project_manager_candidates',
          time_field: 'createdAt',
          project_correlation_verified: false,
          batch_project_ids_verified: false,
          request_metadata_authority: 'client_reported',
          client_release_is_failing_server_release: false,
          ingest_release_is_failing_request_release: false,
          note: 'Actor-filtered, time-bounded page; use next_cursor to continue. Pages are not a fixed-time snapshot; batch failures do not identify the failing project. Request IDs/status/path are client reports, not server verification. Missing or later records and uncollected browser errors are not ruled out.',
        },
      };
    }
  );
  return platformOnly ? { query_client_errors: registry.query_client_errors } : registry;
}
