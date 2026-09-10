import { useCallback, useEffect, useState } from 'react';

export type ShellSpace = 'portal' | 'admin';
export type ShellSurface = 'card' | 'nav' | 'command' | 'quick-action' | 'welcome' | 'shortcut';

export interface ShellVisibilityContext {
  fundInputMode?: string | null;
  labEnabled?: boolean;
}

export const SHELL_LAB_STORAGE_KEY = 'mysc-shell-lab-enabled';

const SHELL_LAB_CHANGE_EVENT = 'mysc-shell-lab-enabled-change';

export const ADMIN_LAB_ROUTES = [
  '/business-cards',
  '/board',
  '/evidence',
  '/payroll',
  '/budget-summary',
  '/expense-management',
  '/koica-personnel',
  '/personnel-changes',
  '/approvals',
  '/audit',
  '/hr-announcements',
  '/training',
  '/settings',
] as const;

export const ADMIN_ALWAYS_VISIBLE_SETTINGS_ROUTES = [
  '/settings?tab=members',
  '/settings?tab=tenants',
] as const;

export const PORTAL_LAB_ROUTES = [
  '/portal/business-cards',
  '/portal/board',
] as const;

function normalizeRoute(route: string): string {
  const base = String(route || '').split(/[?#]/)[0] || '/';
  if (base === '/') return '/';
  return base.replace(/\/+$/, '');
}

function routeMatches(route: string, candidate: string): boolean {
  const normalizedRoute = normalizeRoute(route);
  const normalizedCandidate = normalizeRoute(candidate);
  if (normalizedCandidate === '/') return normalizedRoute === '/';
  return normalizedRoute === normalizedCandidate || normalizedRoute.startsWith(`${normalizedCandidate}/`);
}

function isLabRoute(route: string, routes: readonly string[]): boolean {
  return routes.some((candidate) => routeMatches(route, candidate));
}

function isAlwaysVisibleAdminSettingsRoute(route: string): boolean {
  const withoutHash = String(route || '').split('#')[0] || '/';
  const normalized = withoutHash.replace(/\/+(?=[?#]|$)/, '');
  return ADMIN_ALWAYS_VISIBLE_SETTINGS_ROUTES.includes(normalized as typeof ADMIN_ALWAYS_VISIBLE_SETTINGS_ROUTES[number]);
}

export function shouldShowShellRoute(
  route: string,
  space: ShellSpace,
  _surface: ShellSurface,
  context: ShellVisibilityContext = {},
): boolean {
  const normalizedRoute = normalizeRoute(route);
  const labEnabled = context.labEnabled === true;

  if (space === 'admin' && isAlwaysVisibleAdminSettingsRoute(route)) {
    return true;
  }

  if (space === 'admin' && !labEnabled && isLabRoute(normalizedRoute, ADMIN_LAB_ROUTES)) {
    return false;
  }

  if (space === 'portal' && !labEnabled && isLabRoute(normalizedRoute, PORTAL_LAB_ROUTES)) {
    return false;
  }

  return true;
}

export function readShellLabEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(SHELL_LAB_STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

export function writeShellLabEnabled(enabled: boolean): void {
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(SHELL_LAB_STORAGE_KEY, enabled ? 'true' : 'false');
    } catch {
      // Ignore persistence failures; LAB visibility falls back to off.
    }
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(SHELL_LAB_CHANGE_EVENT, { detail: { enabled } }));
  }
}

export function useShellLabEnabled() {
  const [labEnabled, setLabEnabledState] = useState(() => readShellLabEnabled());

  useEffect(() => {
    function handleStorage(event: StorageEvent) {
      if (event.key === SHELL_LAB_STORAGE_KEY) {
        setLabEnabledState(event.newValue === 'true');
      }
    }

    function handleLocalEvent(event: Event) {
      const detail = (event as CustomEvent<{ enabled?: boolean }>).detail;
      setLabEnabledState(detail?.enabled === true);
    }

    window.addEventListener('storage', handleStorage);
    window.addEventListener(SHELL_LAB_CHANGE_EVENT, handleLocalEvent);
    return () => {
      window.removeEventListener('storage', handleStorage);
      window.removeEventListener(SHELL_LAB_CHANGE_EVENT, handleLocalEvent);
    };
  }, []);

  const setLabEnabled = useCallback((enabled: boolean) => {
    writeShellLabEnabled(enabled);
    setLabEnabledState(enabled);
  }, []);

  return [labEnabled, setLabEnabled] as const;
}
