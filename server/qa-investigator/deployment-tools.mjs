import { createHash } from 'node:crypto';

// Established production origin: server/bff/runtime-safety.mjs DEFAULT_LIVE_ALLOWED_ORIGINS.
// Endpoint contract: server/bff/app.mjs /api/v1/health. It publishes no source SHA.
const ENDPOINT = 'https://myscube.myscguard.app/api/v1/health';
const SOURCE = 'read_public_deployment_identity';
const hash = (value) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createDeploymentTools({ fetchImpl = fetch } = {}) {
  return {
    [SOURCE]: {
      description:
        'Read only the fixed public MYSCube production health endpoint without credentials. Current observation is not historical request evidence. Health does not establish a Git revision, JVM configuration, or root cause; blocked/non-JSON responses remain unavailable.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
        additionalProperties: false,
      },
      async execute(args, { signal } = {}) {
        signal?.throwIfAborted();
        const observed_at = new Date().toISOString();
        const base = {
          endpoint: ENDPOINT,
          observation_scope: 'current_public_health',
          revision: null,
          revision_provenance: 'not_published_by_endpoint',
          historical_request_verified: false,
        };
        function envelope(result) {
          const content_hash = hash({ source: SOURCE, ...result });
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: SOURCE,
            ...result,
            cause_status: 'not_established',
          };
        }
        const unavailable = (error_code, http_status) =>
          envelope({
            status: 'unavailable',
            error_code,
            ...base,
            ...(http_status ? { http_status } : {}),
            rows: [],
            coverage: { complete: false },
          });
        if (
          !args ||
          typeof args !== 'object' ||
          Array.isArray(args) ||
          Object.keys(args).length
        )
          return unavailable('invalid_deployment_request');
        const timeout = AbortSignal.timeout(20000);
        const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
        try {
          const response = await fetchImpl(ENDPOINT, {
            method: 'GET',
            redirect: 'manual',
            credentials: 'omit',
            headers: { Accept: 'application/json' },
            signal: combined,
          });
          // Never forward credentials or follow a login/CDN/alternate-host redirect.
          if (response.status >= 300 && response.status < 400) {
            await response.body?.cancel();
            return unavailable('deployment_redirect', response.status);
          }
          if (!response.ok) {
            await response.body?.cancel();
            return unavailable(
              [401, 403].includes(response.status)
                ? 'source_access_denied'
                : 'source_unavailable',
              response.status
            );
          }
          if (
            !/^application\/json(?:\s*;|$)/i.test(
              response.headers.get('content-type') || ''
            )
          ) {
            await response.body?.cancel();
            return unavailable('deployment_non_json', response.status);
          }
          const reader = response.body?.getReader();
          if (!reader)
            return unavailable('deployment_invalid_schema', response.status);
          const chunks = [];
          let size = 0;
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > 32768) {
                await reader.cancel();
                return unavailable(
                  'deployment_response_too_large',
                  response.status
                );
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
          const bytes = new Uint8Array(size);
          let cursor = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, cursor);
            cursor += chunk.length;
          }
          let data;
          try {
            data = JSON.parse(
              new TextDecoder('utf-8', { fatal: true }).decode(bytes)
            );
          } catch {
            return unavailable('deployment_invalid_json', response.status);
          }
          if (!data || data.ok !== true || data.service !== 'mysc-bff')
            return unavailable('deployment_invalid_schema', response.status);
          signal?.throwIfAborted();
          // Only confirmed public contract fields; no authMode, projectId, cookies, arbitrary strings or inferred SHA.
          return envelope({
            status: 'available',
            ...base,
            http_status: response.status,
            rows: [{ ok: true, service: 'mysc-bff' }],
            coverage: {
              complete: true,
              scope: 'public_health_only',
              deployment_identity_complete: false,
            },
          });
        } catch {
          signal?.throwIfAborted();
          return unavailable(
            timeout.aborted ? 'source_timeout' : 'source_unavailable'
          );
        }
      },
    },
  };
}

// The trusted server supplies a packaged, sanitized control-plane observation.
// This tool never imports operator credentials or calls the control plane itself.
export async function createDeploymentObservationTool({ snapshotPath }) {
  const { readFile, lstat } = await import('node:fs/promises');
  const invalid = () => {
    throw new Error('invalid_deployment_observation');
  };
  const exact = (value, keys) => {
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).length !== keys.length ||
      keys.some((k) => !Object.hasOwn(value, k))
    )
      invalid();
  };
  const text = (value, pattern) => {
    if (typeof value !== 'string' || !pattern.test(value)) invalid();
  };
  if (typeof snapshotPath !== 'string' || !snapshotPath) invalid();
  const info = await lstat(snapshotPath);
  if (!info.isFile() || info.size > 16384) invalid();
  let snapshot;
  try {
    snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  } catch {
    invalid();
  }
  exact(snapshot, [
    'schema_version',
    'observed_at',
    'canonical_host',
    'deployment',
    'environment',
    'coverage',
    'source_api',
    'credential_source',
  ]);
  if (
    snapshot.schema_version !== 1 ||
    snapshot.canonical_host !== 'myscube.myscguard.app' ||
    snapshot.source_api !==
      'Vercel GET /v13/deployments/myscube.myscguard.app' ||
    snapshot.credential_source !== 'operator_cli_auth_not_shipped'
  )
    invalid();
  text(
    snapshot.observed_at,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/
  );
  if (!Number.isFinite(Date.parse(snapshot.observed_at))) invalid();
  const d = snapshot.deployment;
  exact(d, [
    'id',
    'url',
    'project_id',
    'ready_state',
    'target',
    'source',
    'created_at',
    'metadata_commit_sha',
    'metadata_branch',
    'github_actions_invocation',
  ]);
  text(d.id, /^dpl_[A-Za-z0-9]{1,100}$/);
  text(d.project_id, /^prj_[A-Za-z0-9]{1,100}$/);
  text(d.url, /^(?:https:\/\/)?[a-z0-9-]{1,200}\.vercel\.app$/);
  if (
    ![
      'READY',
      'ERROR',
      'BUILDING',
      'QUEUED',
      'CANCELED',
      'INITIALIZING',
    ].includes(d.ready_state) ||
    d.target !== 'production' ||
    !['cli', 'git', 'import', 'api'].includes(d.source)
  )
    invalid();
  if (typeof d.created_at === 'number') {
    if (!Number.isSafeInteger(d.created_at) || d.created_at < 0) invalid();
  } else {
    text(d.created_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/);
    if (!Number.isFinite(Date.parse(d.created_at))) invalid();
  }
  if (d.metadata_commit_sha !== null)
    text(d.metadata_commit_sha, /^[a-f0-9]{40}$/);
  if (d.metadata_branch !== null)
    text(d.metadata_branch, /^[A-Za-z0-9_./-]{1,200}$/);
  if (d.github_actions_invocation !== null) invalid();
  exact(snapshot.environment, [
    'metadata_key_scope',
    'jvm_base_url_key_present',
    'legacy_base_url_key_present',
  ]);
  if (
    snapshot.environment.metadata_key_scope !==
      'deployment_metadata_not_effective_function_environment' ||
    typeof snapshot.environment.jvm_base_url_key_present !== 'boolean' ||
    typeof snapshot.environment.legacy_base_url_key_present !== 'boolean'
  )
    invalid();
  exact(snapshot.coverage, [
    'runtime_environment_values_verified',
    'request_to_deployment_correlation_verified',
    'alias_at_incident_verified',
  ]);
  if (Object.values(snapshot.coverage).some((v) => v !== false)) invalid();
  const name = 'read_deployment_observation_snapshot';
  const content_hash = hash({ source: name, ...snapshot });
  return {
    [name]: {
      description:
        'Read an imported authenticated control-plane snapshot taken by an operator. Observation time is historical and retained. Deployment metadata key presence is NOT effective function environment configuration. Does not verify request-to-deployment correlation or alias at incident time.',
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
          throw new Error('invalid_deployment_request');
        return {
          evidence_id: `ev_${content_hash}`,
          content_hash,
          source: name,
          status: 'available',
          observed_at: snapshot.observed_at,
          read_at: new Date().toISOString(),
          provenance: 'imported_authenticated_control_plane_snapshot',
          rows: [structuredClone(snapshot)],
          coverage: {
            complete: true,
            scope: 'imported_observation_only',
            ...snapshot.coverage,
          },
          cause_status: 'not_established',
        };
      },
    },
  };
}
