import { normalizeWorkspaceId, type WorkspaceId } from '../data/member-workspace';
import { canAccessAdminPath } from './admin-nav';

export type HomePath = '/' | '/portal/project-select';

function normalizeRole(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return normalized === 'viewer' ? 'pm' : normalized;
}

const ADMIN_SPACE_ROLES = new Set([
  'admin',
  'finance',
]);

export function isPortalRole(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return normalized === 'pm';
}

export function isAdminSpaceRole(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return ADMIN_SPACE_ROLES.has(normalized);
}

export function canEnterPortalWorkspace(role: unknown): boolean {
  const normalized = normalizeRole(role);
  return !!normalized;
}

export function canChooseWorkspace(role: unknown): boolean {
  return isAdminSpaceRole(role);
}

export function shouldPromptWorkspaceSelection(
  role: unknown,
  preferredWorkspace: unknown,
): boolean {
  if (!canChooseWorkspace(role)) return false;
  return normalizeWorkspaceId(preferredWorkspace) == null;
}

export function resolveActiveWorkspacePreference(
  lastWorkspace?: WorkspaceId | unknown,
  defaultWorkspace?: WorkspaceId | unknown,
): WorkspaceId | undefined {
  return normalizeWorkspaceId(lastWorkspace) ?? normalizeWorkspaceId(defaultWorkspace);
}

export function resolveHomePath(role: unknown, preferredWorkspace?: WorkspaceId | unknown): HomePath {
  const normalized = normalizeRole(role);
  if (!normalized) return '/portal/project-select';
  if (isPortalRole(normalized)) return '/portal/project-select';
  if (isAdminSpaceRole(normalized) && normalizeWorkspaceId(preferredWorkspace) === 'portal') {
    return '/portal/project-select';
  }
  if (isAdminSpaceRole(normalized)) return '/';
  return '/portal/project-select';
}

export function normalizeRequestedPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed.startsWith('/')) return '';
  if (['/mobile-entry', '/business-cards', '/portal/business-cards'].includes(trimmed.split(/[?#]/)[0])) return '/';
  if (trimmed === '/login' || trimmed === '/workspace-select') return '';
  if (trimmed.startsWith('/portal/project-select?')) return '/portal/project-select';
  return trimmed;
}

export function resolveRequestedRedirectPath(
  stateFrom?: unknown,
  search?: unknown,
): string {
  const fromState = normalizeRequestedPath(stateFrom);
  if (fromState) return fromState;
  const searchText = typeof search === 'string' ? search : '';
  const params = new URLSearchParams(searchText);
  return normalizeRequestedPath(params.get('redirect'));
}

export function resolvePostLoginPath(
  role: unknown,
  preferredWorkspace: WorkspaceId | unknown,
  requestedPath?: unknown,
): string {
  const fallback = resolveHomePath(role, preferredWorkspace);
  const normalizedPath = normalizeRequestedPath(requestedPath);
  if (!normalizedPath) return fallback;

  if (normalizedPath === '/portal' || normalizedPath.startsWith('/portal/')) {
    return canEnterPortalWorkspace(role) ? normalizedPath : fallback;
  }

  if (canAccessAdminPath(role, normalizedPath)) {
    return normalizedPath;
  }

  return fallback;
}

export function resolvePortalEntryPath(
  role: unknown,
  preferredWorkspace: WorkspaceId | unknown,
  requestedPath?: unknown,
): string {
  return resolvePostLoginPath(role, preferredWorkspace, requestedPath);
}

export function resolveLoginSuccessPath(
  role: unknown,
  preferredWorkspace: WorkspaceId | unknown,
  requestedPath?: unknown,
): string {
  const normalizedPath = normalizeRequestedPath(requestedPath);
  if (!normalizedPath || normalizedPath === '/') return resolveHomePath(role, preferredWorkspace);
  return resolvePortalEntryPath(role, preferredWorkspace, normalizedPath);
}

export function resolveWorkspaceSelectionPath(
  role: unknown,
  selectedWorkspace: WorkspaceId | unknown,
  requestedPath?: unknown,
): string {
  const normalizedWorkspace = normalizeWorkspaceId(selectedWorkspace);
  const normalizedPath = normalizeRequestedPath(requestedPath);

  if (normalizedWorkspace === 'portal') {
    const portalRequested = normalizedPath.startsWith('/portal/')
      ? normalizedPath
      : undefined;
    return portalRequested
      ? resolvePortalEntryPath(role, normalizedWorkspace, portalRequested)
      : '/portal/project-select';
  }

  if (normalizedWorkspace === 'admin') {
    const adminRequested = normalizedPath && !normalizedPath.startsWith('/portal/')
      ? normalizedPath
      : undefined;
    return resolvePostLoginPath(role, normalizedWorkspace, adminRequested);
  }

  return resolvePostLoginPath(role, selectedWorkspace, requestedPath);
}

function matchesPathPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const PORTAL_STANDALONE_ENTRY_PATHS = [
  '/portal/onboarding',
  '/portal/project-select',
  '/portal/project-approvals',
  '/portal/register-project',
  '/portal/weekly-expenses',
] as const;

export function isPortalStandaloneEntryPath(pathname: string): boolean {
  if (['/portal/work-pages', '/portal/cashflow-assistant', '/portal/service-guidance'].includes(pathname)) return true;
  return PORTAL_STANDALONE_ENTRY_PATHS.some((path) => matchesPathPrefix(pathname, path));
}
