import navPolicyJson from '../../../policies/nav-policy.json';

export const ADMIN_OPEN_TO_ALL_ROLES = false;

function normalizeRole(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// nav-policy.json 기반으로 역할별 허용 경로 Set 동적 생성
const FULL_ACCESS_ROLES = new Set(navPolicyJson.fullAccessRoles);

const ROUTE_PERMISSIONS_BY_ROLE: Record<string, Set<string>> = Object.fromEntries(
  Object.entries(navPolicyJson.routePermissions).map(([role, routes]) => [
    role,
    new Set(routes),
  ]),
);

/**
 * UI-level navigation policy for the admin space (AppLayout).
 * This is intentionally opinionated to keep role experiences clean:
 * - finance shouldn't see HR menus or "new project" CTA
 * - operational settings are admin-scoped
 */
export function canShowAdminNavItem(role: unknown, to: string): boolean {
  const normalized = normalizeRole(role);
  if (!normalized) return false;

  if (FULL_ACCESS_ROLES.has(normalized)) return true;

  const allowed = ROUTE_PERMISSIONS_BY_ROLE[normalized];
  if (allowed) return allowed.has(to);

  // Unknown roles should not be encouraged to navigate into admin-only areas.
  return false;
}

function canonicalizeAdminPath(pathname: string): string | undefined {
  if (pathname === '/axr/qa-evidence' || pathname.startsWith('/axr/qa-evidence/')) return '/axr/qa-evidence';
  if (pathname === '/axr/product-operations' || pathname.startsWith('/axr/product-operations/')) return '/axr/product-operations';
  if (pathname === '/') return '/';
  if (pathname === '/dashboard') return '/dashboard';

  if (pathname === '/projects/migration-audit' || pathname.startsWith('/projects/migration-audit/')) {
    return '/projects/migration-audit';
  }
  if (pathname === '/management-planning/project-codes' || pathname.startsWith('/management-planning/project-codes/')) {
    return '/management-planning/project-codes';
  }
  if (pathname === '/axr' || pathname === '/axr/cashflow-period-policy' || pathname.startsWith('/axr/cashflow-period-policy/')) {
    return '/axr/cashflow-period-policy';
  }
  if (pathname.startsWith('/projects/new')) return '/projects/new';
  if (pathname.startsWith('/projects/') && pathname.endsWith('/edit')) return '/projects/new';
  if (pathname === '/projects' || pathname.startsWith('/projects/')) return '/projects';

  const prefixes = [
    '/cashflow',
    '/evidence',
    '/payroll',
    '/budget-summary',
    '/expense-management',
    '/approvals',
    '/users',
    '/audit',
    '/settings',
    '/claude-sdk-help',
    '/participation',
    '/people',
    '/koica-personnel',
    '/personnel-changes',
    '/hr-announcements',
  ];
  for (const p of prefixes) {
    if (pathname === p || pathname.startsWith(p + '/')) return p;
  }

  return undefined;
}

/**
 * Route-level guard for the admin space.
 *
 * For unknown paths we return true so the router can display NotFoundPage
 * instead of forcing a redirect.
 */
export function canAccessAdminPath(role: unknown, pathname: string): boolean {
  const canonical = canonicalizeAdminPath(pathname);
  if (!canonical) return true;
  return canShowAdminNavItem(role, canonical);
}
