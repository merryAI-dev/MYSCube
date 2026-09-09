import * as Sentry from '@sentry/react';
import { buildStandardHeaders, createRequestId } from './request-context';

export interface ObservabilityUserContext {
  id: string;
  email?: string;
  role?: string;
  tenantId?: string;
  idToken?: string;
}

export interface ObservabilityCaptureOptions {
  level?: 'info' | 'warning' | 'error' | 'fatal';
  tags?: Record<string, string | number | boolean | null | undefined>;
  extra?: Record<string, unknown>;
  fingerprint?: string[];
}

const errorCaptureMarker = Symbol.for('mysc.observability.captured');
const ACTIVE_TENANT_STORAGE_KEY = 'MYSC_ACTIVE_TENANT';
const DEFAULT_INTERNAL_API_BASE_URL = 'http://127.0.0.1:8787';
const INTERNAL_CLIENT_ERROR_PATH = '/api/v1/client-errors';
const globalState = globalThis as typeof globalThis & {
  __MYSC_OBSERVABILITY__?: {
    sentryEnabled: boolean;
    installedGlobalHandlers: boolean;
    user: ObservabilityUserContext | null;
  };
};

if (!globalState.__MYSC_OBSERVABILITY__) {
  globalState.__MYSC_OBSERVABILITY__ = {
    sentryEnabled: false,
    installedGlobalHandlers: false,
    user: null,
  };
}

function readEnvString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readEnvNumber(value: unknown, fallback: number): number {
  const parsed = Number.parseFloat(readEnvString(value));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truncateText(value: unknown, maxLength: number): string | undefined {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return undefined;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase();
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '0.0.0.0'
    || normalized === '[::1]'
    || normalized === '::1'
    || normalized.endsWith('.localhost');
}

function getRuntimeOrigin(): string {
  if (typeof window === 'undefined') return '';
  return typeof window.location?.origin === 'string'
    ? window.location.origin
    : '';
}

function getRuntimeHostname(): string {
  if (typeof window === 'undefined') return '';
  return typeof window.location?.hostname === 'string'
    ? window.location.hostname
    : '';
}

function getCurrentRoute(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function getCurrentHref(): string {
  if (typeof window === 'undefined') return '';
  return window.location.href;
}

function toError(value: unknown, fallbackMessage: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === 'string' && value.trim()) return new Error(value.trim());
  return new Error(fallbackMessage);
}

function alreadyCaptured(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && (error as Record<PropertyKey, unknown>)[errorCaptureMarker]);
}

function markCaptured(error: unknown): void {
  if (!error || typeof error !== 'object') return;
  Object.defineProperty(error, errorCaptureMarker, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: true,
  });
}

function normalizeTags(
  tags: ObservabilityCaptureOptions['tags'] | undefined,
): Record<string, string | number | boolean | null> | undefined {
  if (!tags) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(tags)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, value === undefined ? null : value] as const),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeExtra(
  extra: ObservabilityCaptureOptions['extra'] | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const normalized = Object.fromEntries(
    Object.entries(extra)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => {
        if (typeof value === 'string') {
          return [key, truncateText(value, 4000)] as const;
        }
        return [key, value] as const;
      })
      .filter(([, value]) => value !== undefined),
  );
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function resolveObservabilityTenantId(): string {
  const state = globalState.__MYSC_OBSERVABILITY__;
  const fromUser = readEnvString(state?.user?.tenantId);
  if (fromUser) return fromUser;

  if (typeof localStorage === 'undefined') return '';
  try {
    return readEnvString(localStorage.getItem(ACTIVE_TENANT_STORAGE_KEY));
  } catch {
    return '';
  }
}

function resolveInternalApiBaseUrl(env: Record<string, unknown> = import.meta.env): string {
  const configured = readEnvString(env.VITE_PLATFORM_API_BASE_URL).replace(/\/$/, '');
  const runtimeOrigin = getRuntimeOrigin().replace(/\/$/, '');
  const runtimeHostname = getRuntimeHostname();
  const hostedOrigin = runtimeOrigin && runtimeHostname && !isLoopbackHostname(runtimeHostname);

  if (!configured) {
    return hostedOrigin ? runtimeOrigin : DEFAULT_INTERNAL_API_BASE_URL;
  }

  try {
    const parsed = new URL(configured, runtimeOrigin || 'http://localhost');
    if (
      hostedOrigin
      && (isLoopbackHostname(parsed.hostname) || parsed.hostname.includes('innerplatform-jvm-weekly-api'))
    ) {
      return runtimeOrigin;
    }
  } catch {
    if (hostedOrigin && /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1)/i.test(configured)) {
      return runtimeOrigin;
    }
  }

  return configured;
}

function buildInternalClientErrorUrl(env: Record<string, unknown> = import.meta.env): string {
  const baseUrl = resolveInternalApiBaseUrl(env);
  if (!baseUrl) return INTERNAL_CLIENT_ERROR_PATH;
  return `${baseUrl}${INTERNAL_CLIENT_ERROR_PATH}`;
}

function buildInternalErrorPayload(params: {
  eventType: 'exception' | 'message';
  message: string;
  name?: string;
  stack?: string;
  options?: ObservabilityCaptureOptions;
}) {
  const clientRequestId = truncateText(
    typeof params.options?.extra?.requestId === 'string'
      ? params.options.extra.requestId
      : undefined,
    200,
  );

  return {
    eventType: params.eventType,
    message: truncateText(params.message, 4000) || 'Unknown application error',
    name: truncateText(params.name, 200),
    stack: truncateText(params.stack, 16000),
    level: params.options?.level || (params.eventType === 'message' ? 'info' : 'error'),
    source: truncateText(String(params.options?.tags?.surface || 'application'), 120) || 'application',
    route: truncateText(getCurrentRoute(), 500),
    href: truncateText(getCurrentHref(), 2000),
    clientRequestId,
    fingerprint: (params.options?.fingerprint || [])
      .map((entry) => readEnvString(entry))
      .filter(Boolean)
      .slice(0, 8),
    tags: normalizeTags(params.options?.tags),
    extra: normalizeExtra(params.options?.extra),
    occurredAt: new Date().toISOString(),
  };
}

async function sendInternalClientError(
  payload: ReturnType<typeof buildInternalErrorPayload>,
  env: Record<string, unknown> = import.meta.env,
): Promise<void> {
  if (typeof fetch !== 'function') return;

  const tenantId = resolveObservabilityTenantId();
  if (!tenantId) return;

  const state = globalState.__MYSC_OBSERVABILITY__;
  const actor = {
    id: readEnvString(state?.user?.id) || 'anonymous',
    email: readEnvString(state?.user?.email) || undefined,
    role: readEnvString(state?.user?.role) || undefined,
    idToken: readEnvString(state?.user?.idToken) || undefined,
  };
  const headers = buildStandardHeaders({
    tenantId,
    actor,
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
  });

  try {
    await fetch(buildInternalClientErrorUrl(env), {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch {
    // Internal telemetry must never cascade into the user flow.
  }
}

function applyScope(
  scope: Sentry.Scope,
  options: ObservabilityCaptureOptions | undefined,
): void {
  const state = globalState.__MYSC_OBSERVABILITY__;
  const route = getCurrentRoute();
  const href = getCurrentHref();

  scope.setTag('app', 'inner-platform');
  if (route) scope.setTag('route', route);
  if (href) scope.setExtra('href', href);
  if (state?.user?.tenantId) scope.setTag('tenantId', state.user.tenantId);
  if (state?.user?.role) scope.setTag('actorRole', state.user.role);
  if (state?.user?.id) scope.setUser({
    id: state.user.id,
    email: state.user.email,
    tenantId: state.user.tenantId,
    role: state.user.role,
  } as Sentry.User);

  if (options?.level) {
    scope.setLevel(options.level);
  }

  Object.entries(options?.tags || {}).forEach(([key, value]) => {
    if (value == null) return;
    scope.setTag(key, String(value));
  });

  Object.entries(options?.extra || {}).forEach(([key, value]) => {
    if (value === undefined) return;
    scope.setExtra(key, value);
  });

  if (options?.fingerprint && options.fingerprint.length > 0) {
    scope.setFingerprint(options.fingerprint);
  }
}

export function initObservability(env: Record<string, unknown> = import.meta.env): void {
  const state = globalState.__MYSC_OBSERVABILITY__;
  if (!state || state.sentryEnabled) return;

  const dsn = readEnvString(env.VITE_SENTRY_DSN);
  if (!dsn) return;

  Sentry.init({
    dsn,
    environment: readEnvString(env.VITE_SENTRY_ENVIRONMENT) || readEnvString(env.MODE) || 'development',
    release: readEnvString(env.VITE_SENTRY_RELEASE) || readEnvString(env.VERCEL_GIT_COMMIT_SHA) || undefined,
    tracesSampleRate: readEnvNumber(env.VITE_SENTRY_TRACES_SAMPLE_RATE, 0),
    sendDefaultPii: true,
  });

  state.sentryEnabled = true;
}

export function setObservabilityUserContext(user: ObservabilityUserContext | null | undefined): void {
  const state = globalState.__MYSC_OBSERVABILITY__;
  if (!state) return;
  state.user = user
    ? {
      id: String(user.id || '').trim(),
      ...(user.email ? { email: String(user.email).trim().toLowerCase() } : {}),
      ...(user.role ? { role: String(user.role).trim() } : {}),
      ...(user.tenantId ? { tenantId: String(user.tenantId).trim() } : {}),
      ...(user.idToken ? { idToken: String(user.idToken).trim() } : {}),
    }
    : null;

  if (!state.sentryEnabled) return;
  if (state.user?.id) {
    Sentry.setUser({
      id: state.user.id,
      email: state.user.email,
      tenantId: state.user.tenantId,
      role: state.user.role,
    } as Sentry.User);
    if (state.user.tenantId) Sentry.setTag('tenantId', state.user.tenantId);
    if (state.user.role) Sentry.setTag('actorRole', state.user.role);
    return;
  }

  Sentry.setUser(null);
}

export function captureException(
  error: unknown,
  options?: ObservabilityCaptureOptions,
): string {
  const normalized = toError(error, 'Unknown application error');
  if (alreadyCaptured(normalized)) return '';
  markCaptured(normalized);

  const payload = buildInternalErrorPayload({
    eventType: 'exception',
    message: normalized.message,
    name: normalized.name,
    stack: normalized.stack,
    options,
  });
  void sendInternalClientError(payload);

  const state = globalState.__MYSC_OBSERVABILITY__;
  if (!state?.sentryEnabled) return '';

  return Sentry.withScope((scope) => {
    applyScope(scope, options);
    return Sentry.captureException(normalized);
  });
}

export function reportError(
  error: unknown,
  params: {
    message: string;
    options?: ObservabilityCaptureOptions;
  },
): string {
  const normalized = toError(error, params.message);
  // eslint-disable-next-line no-console
  console.error(params.message, normalized);
  return captureException(normalized, params.options);
}

export function captureMessage(
  message: string,
  options?: ObservabilityCaptureOptions,
): string {
  const payload = buildInternalErrorPayload({
    eventType: 'message',
    message,
    options,
  });
  void sendInternalClientError(payload);

  const state = globalState.__MYSC_OBSERVABILITY__;
  if (!state?.sentryEnabled) return '';
  return Sentry.withScope((scope) => {
    applyScope(scope, options);
    return Sentry.captureMessage(message, options?.level);
  });
}

export function installGlobalObservabilityHandlers(): void {
  const state = globalState.__MYSC_OBSERVABILITY__;
  if (!state || state.installedGlobalHandlers || typeof window === 'undefined') return;

  const handleWindowError = (event: ErrorEvent) => {
    const error = event.error || new Error(event.message || 'Unhandled window error');
    captureException(error, {
      level: 'error',
      tags: {
        surface: 'window_error',
      },
      extra: {
        fileName: event.filename,
        line: event.lineno,
        column: event.colno,
      },
    });
  };

  const handleUnhandledRejection = (event: PromiseRejectionEvent) => {
    const error = toError(event.reason, 'Unhandled promise rejection');
    captureException(error, {
      level: 'error',
      tags: {
        surface: 'unhandled_rejection',
      },
    });
  };

  window.addEventListener('error', handleWindowError);
  window.addEventListener('unhandledrejection', handleUnhandledRejection);
  state.installedGlobalHandlers = true;
}

export function createClientRequestId(prefix: string = 'ui'): string {
  return createRequestId(prefix);
}
