import {
  buildStandardHeaders,
  type BuildStandardHeadersInput,
  type RequestActor,
} from './request-context';
import { captureException, sanitizeDiagnosticUrl } from './observability';
import { recordDevtoolsLog, toDevtoolsError, toSafeDiagnosticCode } from './devtools-transaction-log';

const DEFAULT_RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface ApiResponse<T> {
  status: number;
  requestId: string;
  data: T;
  headers: Headers;
}

export interface PlatformRequestOptions {
  method?: string;
  tenantId: string;
  actor: RequestActor;
  headers?: HeadersInit;
  body?: unknown;
  idempotencyKey?: string;
  requestId?: string;
  signal?: AbortSignal;
  retries?: number;
  timeoutMs?: number;
  retryOnStatuses?: number[];
}

interface JwtClaimsSummary {
  aud?: string;
  iss?: string;
  sub?: string;
  email?: string;
  exp?: number;
}

function normalizeTokenClaimString(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTokenClaimString(item)).filter(Boolean).join(',');
  }
  return undefined;
}

function decodeBase64Url(base64Url: string): string {
  const missingPadding = (4 - (base64Url.length % 4)) % 4;
  const normalized = base64Url
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .concat('='.repeat(missingPadding));

  if (typeof atob === 'function') return atob(normalized);
  throw new Error('Base64 decode unavailable');
}

function parseJwtClaims(token: string): JwtClaimsSummary | undefined {
  const parts = token.split('.');
  if (parts.length < 2) return undefined;
  try {
    const payloadText = decodeBase64Url(parts[1]);
    const payload = JSON.parse(payloadText) as Record<string, unknown>;
    return {
      aud: normalizeTokenClaimString(payload.aud),
      iss: normalizeTokenClaimString(payload.iss),
      sub: normalizeTokenClaimString(payload.sub),
      email: normalizeTokenClaimString(payload.email),
      exp: typeof payload.exp === 'number' && Number.isFinite(payload.exp) ? payload.exp : undefined,
    };
  } catch {
    return undefined;
  }
}

function readErrorCode(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const response = body as { code?: unknown; error?: unknown };
  const safeCode = (value: unknown) => value === 'forbidden' || value === 'unauthorized' ? value : toSafeDiagnosticCode(value);
  return safeCode(response.code) || safeCode(response.error);
}

function safeDiagnosticId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function projectDiagnostics(path: string, method: string, error: unknown, body: unknown): Record<string, unknown> {
  const pathname = sanitizeDiagnosticUrl(path).replace(/^https?:\/\/[^/]+/, '');
  const match = pathname.match(/^\/api\/v1\/(project-info-drafts|project-registration-drafts)(?:\/([^/]+))?(?:\/(.*))?$/);
  if (!match) return {};
  const suffix = match[3] || '';
  const action = suffix.startsWith('attachments') ? 'attachment'
    : ['open', 'submit', 'rebase', 'withdraw', 'alias'].includes(suffix) ? suffix
      : method === 'PATCH' ? 'save' : method === 'DELETE' ? 'discard' : method === 'POST' ? 'create' : 'read';
  const response = error instanceof PlatformApiError && error.body && typeof error.body === 'object'
    ? error.body as Record<string, unknown> : {};
  const details = response.details && typeof response.details === 'object' ? response.details as Record<string, unknown> : {};
  const input = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const numeric = Object.fromEntries(['expectedDraftRevision', 'actualDraftRevision', 'expectedVersion', 'actualVersion']
    .flatMap((key) => {
      const value = details[key] ?? (key.startsWith('expected') ? input[key] : undefined);
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? [[key, value]] : [];
    }));
  return {
    operation: `project_${match[1] === 'project-info-drafts' ? 'info' : 'registration'}_draft_${action}`,
    [match[1] === 'project-info-drafts' ? 'projectId' : 'draftId']: safeDiagnosticId(match[2]),
    projectRequestId: safeDiagnosticId(input.projectRequestId),
    ...numeric,
    conflictReason: ['revision_changed', 'canonical_changed', 'source_changed', 'attachments_changed', 'registration_changed', 'target_changed'].includes(String(details.conflictReason)) ? details.conflictReason : undefined,
  };
}

function readErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const value = (body as { message?: unknown }).message;
  return typeof value === 'string' ? value : undefined;
}

function isBinaryBody(value: unknown): value is Blob | ArrayBuffer | Uint8Array {
  return (
    (typeof Blob !== 'undefined' && value instanceof Blob)
    || value instanceof ArrayBuffer
    || value instanceof Uint8Array
  );
}

function toBinaryBody(value: Blob | ArrayBuffer | Uint8Array): BodyInit {
  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return value.slice().buffer as ArrayBuffer;
  }
  return value;
}

export interface PlatformApiClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  retryDelayMs?: number;
  retryOnStatuses?: number[];
  timeoutMs?: number;
}

export class PlatformApiError extends Error {
  status: number;
  requestId?: string;
  body?: unknown;
  code: string;
  serverMessage: string;

  constructor(message: string, status: number, requestId?: string, body?: unknown) {
    super(message);
    this.name = 'PlatformApiError';
    this.status = status;
    this.requestId = requestId;
    this.body = body;
    const responseCode = readErrorCode(body)
      || (body && typeof body === 'object' ? (body as { code?: unknown }).code : undefined);
    this.code = typeof responseCode === 'string' ? responseCode : '';
    this.serverMessage = readErrorMessage(body) || '';
  }
}

function normalizeRetryCount(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeDelay(value: number | undefined, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return fallback;
  return Math.floor(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function isRetryableMethod(method: string, headers: Headers): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return headers.has('idempotency-key');
  }
  return false;
}

function buildRequestUrl(baseUrl: string, path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  if (!baseUrl) return path;
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function readResponseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) {
    return null;
  }

  const text = await response.text();
  if (!text) return null;

  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  return text;
}

export class PlatformApiClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxRetries: number;
  private readonly retryDelayMs: number;
  private readonly retryOnStatuses: Set<number>;
  private readonly timeoutMs: number;
  private readonly inFlightGets = new Map<string, Promise<ApiResponse<unknown>>>();

  constructor(options: PlatformApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl || '').replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl || globalThis.fetch.bind(globalThis);
    this.maxRetries = normalizeRetryCount(options.maxRetries);
    this.retryDelayMs = normalizeDelay(options.retryDelayMs, 150);
    this.retryOnStatuses = new Set(options.retryOnStatuses || Array.from(DEFAULT_RETRY_STATUSES));
    this.timeoutMs = normalizeDelay(options.timeoutMs, 0);
  }

  private async executeFetch(
    url: string,
    init: RequestInit,
    externalSignal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    if (!timeoutMs) {
      return this.fetchImpl(url, { ...init, signal: externalSignal });
    }

    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let didTimeout = false;
    let onAbort: (() => void) | undefined;

    if (externalSignal) {
      if (externalSignal.aborted) {
        controller.abort();
      } else {
        onAbort = () => controller.abort();
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
    }

    timeoutId = setTimeout(() => {
      didTimeout = true;
      controller.abort();
    }, timeoutMs);

    try {
      return await this.fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (didTimeout) {
        // 이 문구는 사용자 화면에 그대로 나간다. 대기 시간(ms)은 개발자 도구 로그의
        // durationMs 로 남으므로 여기에 숫자를 넣지 않는다.
        const timeoutError = new Error('서버 응답이 늦어 요청을 중단했습니다. 잠시 후 다시 시도해 주세요.');
        timeoutError.name = 'TimeoutError';
        (timeoutError as Error & { timeoutMs?: number }).timeoutMs = timeoutMs;
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (externalSignal && onAbort) {
        externalSignal.removeEventListener('abort', onAbort);
      }
    }
  }

  private shouldRetryRequest(params: {
    error: unknown;
    attempt: number;
    maxRetries: number;
    method: string;
    headers: Headers;
    signal?: AbortSignal;
    retryOnStatuses: Set<number>;
  }): boolean {
    const {
      error,
      attempt,
      maxRetries,
      method,
      headers,
      signal,
      retryOnStatuses,
    } = params;

    if (attempt >= maxRetries) return false;
    if (!isRetryableMethod(method, headers)) return false;

    if (signal?.aborted && isAbortError(error)) {
      return false;
    }

    if (error instanceof PlatformApiError) {
      return retryOnStatuses.has(error.status);
    }

    if (isAbortError(error)) {
      return false;
    }

    return true;
  }

  private getRetryDelayMs(attempt: number): number {
    const delay = this.retryDelayMs * Math.pow(2, attempt);
    return Math.min(delay, 3000);
  }

  async request<T>(path: string, options: PlatformRequestOptions): Promise<ApiResponse<T>> {
    const method = (options.method || 'GET').toUpperCase();
    const requestUrl = buildRequestUrl(this.baseUrl, path);
    const diagnosticUrl = sanitizeDiagnosticUrl(requestUrl).replace(/(\/project-(?:info|registration)-drafts)\/[^/]+/, '$1/:resourceId');
    const diagnosticPath = diagnosticUrl.replace(/^https?:\/\/[^/]+/, '');
    const startedAt = Date.now();

    const headerInput: BuildStandardHeadersInput = {
      tenantId: options.tenantId,
      actor: options.actor,
      method,
      requestId: options.requestId,
      idempotencyKey: options.idempotencyKey,
      headers: options.headers,
    };

    const headers = buildStandardHeaders(headerInput);
    const actorIdToken = options.actor.idToken;
    const hasAuthorizationHeader = headers.has('authorization');
    const tokenClaims = actorIdToken ? parseJwtClaims(actorIdToken) : undefined;
    let body: BodyInit | undefined;

    if (options.body !== undefined && options.body !== null) {
      if (options.body instanceof FormData || isBinaryBody(options.body)) {
        body = options.body instanceof FormData ? options.body : toBinaryBody(options.body);
      } else {
        if (!headers.has('content-type')) {
          headers.set('content-type', 'application/json');
        }
        body = JSON.stringify(options.body);
      }
    }

    const maxRetries = normalizeRetryCount(options.retries ?? this.maxRetries);
    const timeoutMs = normalizeDelay(options.timeoutMs ?? this.timeoutMs, 0);
    const retryOnStatuses = new Set(options.retryOnStatuses || Array.from(this.retryOnStatuses));
    const clientRequestId = headers.get('x-request-id') || '';

    if (!hasAuthorizationHeader) {
      recordDevtoolsLog({
        kind: 'bff_request',
        phase: 'info',
        operation: 'bff.authorization.missing',
        method,
        path: diagnosticPath,
        requestId: clientRequestId,
        tenantId: options.tenantId,
        actorId: options.actor.id,
        summary: {
          hasBody: options.body !== undefined && options.body !== null,
          hasAuthorizationHeader: false,
        },
      });
    }

    recordDevtoolsLog({
      kind: 'bff_request',
      phase: 'start',
      operation: diagnosticPath,
      method,
      path: diagnosticPath,
      requestId: clientRequestId,
      tenantId: options.tenantId,
      actorId: options.actor.id,
      maxRetries,
      summary: {
        hasBody: options.body !== undefined && options.body !== null,
        hasAuthorizationHeader,
        actorHasIdToken: Boolean(actorIdToken && actorIdToken.trim()),
        apiBaseUrl: this.baseUrl ? sanitizeDiagnosticUrl(this.baseUrl) : '',
        requestUrl: diagnosticUrl,
        tokenClaims: tokenClaims
          ? {
            aud: tokenClaims.aud,
            iss: tokenClaims.iss,
            sub: tokenClaims.sub,
            email: tokenClaims.email,
            exp: tokenClaims.exp,
          }
          : undefined,
        bodyKind: options.body === undefined || options.body === null
          ? 'none'
          : options.body instanceof FormData
            ? 'form-data'
            : isBinaryBody(options.body)
              ? 'binary'
              : 'json',
        timeoutMs,
      },
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await this.executeFetch(
          requestUrl,
          {
            method,
            headers,
            body,
          },
          options.signal,
          timeoutMs,
        );

        const requestId = response.headers.get('x-request-id') || headers.get('x-request-id') || '';
        const responseBody = await readResponseBody(response);
        const responseCode = readErrorCode(responseBody);
        const responseMessage = readErrorMessage(responseBody);

        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            recordDevtoolsLog({
              kind: 'bff_request',
              phase: 'info',
              operation: 'bff.authorization.rejected',
              method,
              path: diagnosticPath,
              requestId: clientRequestId,
              responseRequestId: requestId,
              status: response.status,
              tenantId: options.tenantId,
              actorId: options.actor.id,
              summary: {
                hasAuthorizationHeader,
                actorHasIdToken: Boolean(actorIdToken && actorIdToken.trim()),
                hasResponseCode: Boolean(responseCode),
              },
            });
          }
          // The browser console is where operators copy failures from, so print the
          // fields needed to find the matching server log instead of a bare message.
          // eslint-disable-next-line no-console
          console.error(`[bff] ${method} ${diagnosticUrl} → ${response.status}`, {
            code: responseCode || '(none)',
            requestId: safeDiagnosticId(requestId) || safeDiagnosticId(clientRequestId) || '(none)',
            tenantId: options.tenantId,
          });
          throw new PlatformApiError(
            // 서버가 문구를 보냈다면 resolveApiErrorMessage 가 body.message 를 먼저 쓴다.
            // 이 문구는 응답 본문이 비어 있을 때(게이트웨이 오류 등)만 사용자에게 보인다.
            '요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
            response.status,
            requestId,
            responseBody,
          );
        }

        recordDevtoolsLog({
          kind: 'bff_request',
          phase: 'success',
          operation: diagnosticPath,
          method,
          path: diagnosticPath,
          requestId: clientRequestId,
          responseRequestId: requestId,
          status: response.status,
          durationMs: Date.now() - startedAt,
          attempt,
          maxRetries,
          summary: {
            responseCode,
            responseMessage,
          },
          tenantId: options.tenantId,
          actorId: options.actor.id,
        });

        return {
          status: response.status,
          requestId,
          data: responseBody as T,
          headers: response.headers,
        };
      } catch (error) {
        const shouldRetry = this.shouldRetryRequest({
          error,
          attempt,
          maxRetries,
          method,
          headers,
          signal: options.signal,
          retryOnStatuses,
        });

        if (!shouldRetry) {
          recordDevtoolsLog({
            kind: 'bff_request',
            phase: 'error',
            operation: diagnosticPath,
            method,
            path: diagnosticPath,
            requestId: clientRequestId,
            responseRequestId: error instanceof PlatformApiError ? error.requestId : undefined,
            status: error instanceof PlatformApiError ? error.status : undefined,
            durationMs: Date.now() - startedAt,
            attempt,
            maxRetries,
            summary: {
              responseCode: error instanceof PlatformApiError && error.body ? readErrorCode(error.body) : undefined,
              responseMessage: error instanceof PlatformApiError && error.body ? readErrorMessage(error.body) : undefined,
            },
            tenantId: options.tenantId,
            actorId: options.actor.id,
            error: toDevtoolsError(error),
          });
          captureException(error, {
            level: 'error',
            tags: {
              surface: 'platform_api',
              method,
            },
            extra: {
              requestUrl: diagnosticUrl,
              attempt,
              maxRetries,
              requestId: safeDiagnosticId(clientRequestId),
              tenantId: safeDiagnosticId(options.tenantId),
              actorId: safeDiagnosticId(options.actor.id),
              actorRole: ['admin', 'finance', 'pm', 'viewer'].includes(options.actor.role || '') ? options.actor.role : undefined,
              errorCode: error instanceof PlatformApiError ? readErrorCode(error.body) : undefined,
              ...projectDiagnostics(path, method, error, options.body),
              status: error instanceof PlatformApiError ? error.status : undefined,
              responseRequestId: error instanceof PlatformApiError ? safeDiagnosticId(error.requestId) : undefined,
            },
          });
          throw error;
        }

        recordDevtoolsLog({
          kind: 'bff_request',
          phase: 'retry',
          operation: diagnosticPath,
          method,
          path: diagnosticPath,
          requestId: clientRequestId,
          responseRequestId: error instanceof PlatformApiError ? error.requestId : undefined,
          status: error instanceof PlatformApiError ? error.status : undefined,
          durationMs: Date.now() - startedAt,
          attempt,
          maxRetries,
          summary: {
            responseCode: error instanceof PlatformApiError && error.body ? readErrorCode(error.body) : undefined,
            responseMessage: error instanceof PlatformApiError && error.body ? readErrorMessage(error.body) : undefined,
          },
          tenantId: options.tenantId,
          actorId: options.actor.id,
          error: toDevtoolsError(error),
        });

        const delayMs = this.getRetryDelayMs(attempt);
        if (delayMs > 0) {
          await sleep(delayMs);
        }
      }
    }
  }

  get<T>(path: string, options: Omit<PlatformRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    if (options.signal || options.requestId) {
      return this.request<T>(path, { ...options, method: 'GET' });
    }
    const key = JSON.stringify([
      path,
      options.tenantId,
      options.actor.id,
      options.actor.role,
      options.actor.idToken,
      options.timeoutMs,
      options.retries,
      Array.from(new Headers(options.headers).entries()).sort(),
    ]);
    const existing = this.inFlightGets.get(key);
    if (existing) return existing as Promise<ApiResponse<T>>;
    const request = this.request<T>(path, { ...options, method: 'GET' });
    this.inFlightGets.set(key, request);
    void request.finally(() => {
      if (this.inFlightGets.get(key) === request) this.inFlightGets.delete(key);
    }).catch(() => undefined);
    return request;
  }

  post<T>(path: string, options: Omit<PlatformRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'POST' });
  }

  patch<T>(path: string, options: Omit<PlatformRequestOptions, 'method'>): Promise<ApiResponse<T>> {
    return this.request<T>(path, { ...options, method: 'PATCH' });
  }
}
