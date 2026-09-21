import { describe, expect, it } from 'vitest';
import {
  canChooseWorkspace,
  canEnterPortalWorkspace,
  isPortalStandaloneEntryPath,
  isAdminSpaceRole,
  isPortalRole,
  normalizeRequestedPath,
  resolveActiveWorkspacePreference,
  resolvePortalEntryPath,
  resolveHomePath,
  resolveLoginSuccessPath,
  resolveRequestedRedirectPath,
  resolvePostLoginPath,
  resolveWorkspaceSelectionPath,
  shouldPromptWorkspaceSelection,
} from './navigation';

const ALL_ROLES = ['admin', 'finance', 'pm', 'viewer'] as const;

describe('role classification', () => {
  it('isPortalRole: pm and viewer only', () => {
    expect(isPortalRole('pm')).toBe(true);
    expect(isPortalRole('viewer')).toBe(true);
    expect(isPortalRole('admin')).toBe(false);
    expect(isPortalRole('finance')).toBe(false);
    expect(isPortalRole('')).toBe(false);
    expect(isPortalRole(null)).toBe(false);
    expect(isPortalRole(undefined)).toBe(false);
  });

  it('isAdminSpaceRole: admin and finance only', () => {
    expect(isAdminSpaceRole('admin')).toBe(true);
    expect(isAdminSpaceRole('finance')).toBe(true);
    expect(isAdminSpaceRole('pm')).toBe(false);
    expect(isAdminSpaceRole('viewer')).toBe(false);
    expect(isAdminSpaceRole('')).toBe(false);
    expect(isAdminSpaceRole(null)).toBe(false);
  });

  it('normalizes case and whitespace', () => {
    expect(isPortalRole(' PM ')).toBe(true);
    expect(isPortalRole('VIEWER')).toBe(true);
    expect(isAdminSpaceRole('ADMIN')).toBe(true);
    expect(isAdminSpaceRole(' Finance ')).toBe(true);
  });
});

describe('workspace selection', () => {
  it('only roles that can genuinely access both spaces can choose workspace', () => {
    expect(canChooseWorkspace('admin')).toBe(true);
    expect(canChooseWorkspace('finance')).toBe(true);
    expect(canChooseWorkspace('pm')).toBe(false);
    expect(canChooseWorkspace('viewer')).toBe(false);
  });

  it('empty/null/undefined cannot choose workspace', () => {
    expect(canChooseWorkspace('')).toBe(false);
    expect(canChooseWorkspace(null)).toBe(false);
    expect(canChooseWorkspace(undefined)).toBe(false);
  });

  it('all valid roles can enter portal workspace', () => {
    for (const role of ALL_ROLES) {
      expect(canEnterPortalWorkspace(role), `${role} should enter portal`).toBe(true);
    }
  });

  it('empty role cannot enter portal workspace', () => {
    expect(canEnterPortalWorkspace('')).toBe(false);
  });
});

describe('shouldPromptWorkspaceSelection', () => {
  it('prompts only when a dual-space role has no preferred workspace yet', () => {
    expect(shouldPromptWorkspaceSelection('admin', undefined)).toBe(true);
    expect(shouldPromptWorkspaceSelection('finance', undefined)).toBe(true);
    expect(shouldPromptWorkspaceSelection('admin', 'portal')).toBe(false);
    expect(shouldPromptWorkspaceSelection('finance', 'admin')).toBe(false);
    expect(shouldPromptWorkspaceSelection('pm', undefined)).toBe(false);
    expect(shouldPromptWorkspaceSelection('viewer', undefined)).toBe(false);
  });

  it('does NOT prompt for empty role', () => {
    expect(shouldPromptWorkspaceSelection('', undefined)).toBe(false);
    expect(shouldPromptWorkspaceSelection(null, 'admin')).toBe(false);
  });
});

describe('resolveActiveWorkspacePreference', () => {
  it('prefers the last workspace for current-session routing', () => {
    expect(resolveActiveWorkspacePreference('admin', 'portal')).toBe('admin');
    expect(resolveActiveWorkspacePreference('portal', 'admin')).toBe('portal');
  });

  it('falls back to default workspace when no last workspace exists', () => {
    expect(resolveActiveWorkspacePreference(undefined, 'portal')).toBe('portal');
    expect(resolveActiveWorkspacePreference(undefined, 'admin')).toBe('admin');
  });

  it('ignores invalid workspace values', () => {
    expect(resolveActiveWorkspacePreference('invalid', 'portal')).toBe('portal');
    expect(resolveActiveWorkspacePreference(null, '')).toBeUndefined();
  });
});

describe('resolveHomePath', () => {
  it('admin defaults to /', () => {
    expect(resolveHomePath('admin')).toBe('/');
    expect(resolveHomePath('admin', 'admin')).toBe('/');
  });

  it('dual-space roles with portal preference go to the explicit portal home', () => {
    expect(resolveHomePath('admin', 'portal')).toBe('/portal/project-select');
    expect(resolveHomePath('finance', 'portal')).toBe('/portal/project-select');
  });

  it('finance defaults to /', () => {
    expect(resolveHomePath('finance')).toBe('/');
  });

  it('pm and viewer default to the explicit portal home', () => {
    expect(resolveHomePath('pm')).toBe('/portal/project-select');
    expect(resolveHomePath('viewer')).toBe('/portal/project-select');
  });

  it('unknown roles default to the explicit portal home', () => {
    expect(resolveHomePath('unknown_role')).toBe('/portal/project-select');
    expect(resolveHomePath('')).toBe('/portal/project-select');
    expect(resolveHomePath(null)).toBe('/portal/project-select');
  });

  it('normalizes role casing', () => {
    expect(resolveHomePath(' PM ')).toBe('/portal/project-select');
    expect(resolveHomePath('ADMIN')).toBe('/');
    expect(resolveHomePath('FINANCE')).toBe('/');
  });
});

describe('resolvePostLoginPath', () => {
  // ── portal paths ──
  it('pm can access portal paths', () => {
    expect(resolvePostLoginPath('pm', undefined, '/portal/weekly-expenses')).toBe('/portal/weekly-expenses');
    expect(resolvePostLoginPath('pm', undefined, '/portal/budget')).toBe('/portal/budget');
    expect(resolvePostLoginPath('pm', undefined, '/portal')).toBe('/portal');
  });

  it('admin can access portal paths', () => {
    expect(resolvePostLoginPath('admin', 'portal', '/portal/budget')).toBe('/portal/budget');
  });

  it('finance can access portal paths', () => {
    expect(resolvePostLoginPath('finance', undefined, '/portal/weekly-expenses')).toBe('/portal/weekly-expenses');
  });

  // ── admin paths ──
  it('admin can access admin paths', () => {
    expect(resolvePostLoginPath('admin', 'admin', '/settings')).toBe('/settings');
    expect(resolvePostLoginPath('admin', 'admin', '/users')).toBe('/users');
  });

  it('finance can access finance-allowed admin paths', () => {
    expect(resolvePostLoginPath('finance', undefined, '/cashflow')).toBe('/cashflow');
    expect(resolvePostLoginPath('finance', undefined, '/approvals')).toBe('/approvals');
  });

  it('finance falls back for admin-only paths outside its route permissions', () => {
    expect(resolvePostLoginPath('finance', undefined, '/audit')).toBe('/');
    expect(resolvePostLoginPath('finance', undefined, '/users')).toBe('/');
    expect(resolvePostLoginPath('finance', undefined, '/settings')).toBe('/');
  });

  it('pm keeps the approval path but falls back for other admin-only paths', () => {
    expect(resolvePostLoginPath('pm', undefined, '/approvals')).toBe('/approvals');
    expect(resolvePostLoginPath('pm', undefined, '/settings')).toBe('/portal/project-select');
    expect(resolvePostLoginPath('pm', undefined, '/users')).toBe('/portal/project-select');
  });

  it('viewer falls back to portal for admin-only paths', () => {
    expect(resolvePostLoginPath('viewer', undefined, '/settings')).toBe('/portal/project-select');
    expect(resolvePostLoginPath('viewer', undefined, '/users')).toBe('/portal/project-select');
  });

  // ── special paths ──
  it('login/workspace-select paths are ignored (fallback)', () => {
    expect(resolvePostLoginPath('admin', 'admin', '/login')).toBe('/');
    expect(resolvePostLoginPath('admin', 'admin', '/workspace-select')).toBe('/');
  });

  it('no requestedPath → fallback home', () => {
    expect(resolvePostLoginPath('admin', 'admin')).toBe('/');
    expect(resolvePostLoginPath('pm', undefined)).toBe('/portal/project-select');
    expect(resolvePostLoginPath('admin', 'portal')).toBe('/portal/project-select');
  });

  it('non-string requestedPath → fallback', () => {
    expect(resolvePostLoginPath('admin', 'admin', null)).toBe('/');
    expect(resolvePostLoginPath('admin', 'admin', 123)).toBe('/');
  });

  it('relative path (no leading /) → fallback', () => {
    expect(resolvePostLoginPath('admin', 'admin', 'settings')).toBe('/');
  });

  it('empty role requesting portal path → fallback (canEnterPortalWorkspace false)', () => {
    expect(resolvePostLoginPath('', undefined, '/portal/budget')).toBe('/portal/project-select');
  });
});

describe('resolvePortalEntryPath', () => {
  it('preserves explicit portal paths without adding project-select redirects', () => {
    expect(resolvePortalEntryPath('pm', undefined, '/portal/budget')).toBe('/portal/budget');
    expect(resolvePortalEntryPath('admin', 'portal', '/portal/cashflow')).toBe('/portal/cashflow');
    expect(resolvePortalEntryPath('pm', undefined, '/portal/project-select?redirect=%2Fportal%2Fbudget')).toBe('/portal/project-select');
    expect(resolvePortalEntryPath('admin', 'admin', '/settings')).toBe('/settings');
  });
});

describe('resolveLoginSuccessPath', () => {
  it('uses the full-screen feature search as the default post-login entry for admin-space users', () => {
    expect(resolveLoginSuccessPath('admin', undefined)).toBe('/');
    expect(resolveLoginSuccessPath('admin', 'admin')).toBe('/');
    expect(resolveLoginSuccessPath('finance', undefined)).toBe('/');
  });

  it('does not force portal-context users back to the admin homepage after login or auth refresh', () => {
    expect(resolveLoginSuccessPath('pm', undefined)).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('viewer', undefined, '/')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('admin', 'portal')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('finance', 'portal')).toBe('/portal/project-select');
  });

  it('uses the regular workspace home for existing mobile app entry links', () => {
    expect(resolveLoginSuccessPath('admin', undefined, '/mobile-entry')).toBe('/');
    expect(resolveLoginSuccessPath('admin', 'portal', '/mobile-entry')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('pm', undefined, '/mobile-entry')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('viewer', undefined, '/mobile-entry?source=pwa')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('admin', 'admin', '/business-cards')).toBe('/');
    expect(resolveLoginSuccessPath('pm', undefined, '/portal/business-cards')).toBe('/portal/project-select');
  });

  it('preserves explicit deep links after login when they are role-safe', () => {
    expect(resolveLoginSuccessPath('admin', 'admin', '/users')).toBe('/users');
    expect(resolveLoginSuccessPath('pm', undefined, '/portal/budget')).toBe('/portal/budget');
    expect(resolveLoginSuccessPath('pm', undefined, '/users')).toBe('/portal/project-select');
    expect(resolveLoginSuccessPath('pm', undefined, '/portal/cashflow')).toBe('/portal/cashflow');
  });
});

describe('resolveWorkspaceSelectionPath', () => {
  it('keeps explicit portal paths when the user explicitly selects portal space', () => {
    expect(resolveWorkspaceSelectionPath('admin', 'portal', '/settings')).toBe('/portal/project-select');
    expect(resolveWorkspaceSelectionPath('admin', 'portal', '/portal/budget')).toBe('/portal/budget');
  });

  it('keeps only admin redirects when the user explicitly selects admin space', () => {
    expect(resolveWorkspaceSelectionPath('admin', 'admin', '/portal/budget')).toBe('/');
    expect(resolveWorkspaceSelectionPath('finance', 'admin', '/cashflow')).toBe('/cashflow');
  });
});

describe('requested redirect restoration', () => {
  it('normalizes requested path values', () => {
    expect(normalizeRequestedPath('/users')).toBe('/users');
    expect(normalizeRequestedPath('/login')).toBe('');
    expect(normalizeRequestedPath('/workspace-select')).toBe('');
    expect(normalizeRequestedPath('/portal/project-select?redirect=%2Fportal%2Fbudget')).toBe('/portal/project-select');
    expect(normalizeRequestedPath('https://example.com/users')).toBe('');
  });

  it('prefers location.state.from when present', () => {
    expect(resolveRequestedRedirectPath('/users', '?redirect=%2Fsettings')).toBe('/users');
  });

  it('falls back to redirect query when state is empty', () => {
    expect(resolveRequestedRedirectPath(undefined, '?redirect=%2Fusers%3Ftab%3Dmembers')).toBe('/users?tab=members');
  });

  it('ignores invalid redirect query', () => {
    expect(resolveRequestedRedirectPath(undefined, '?redirect=https://evil.example.com')).toBe('');
  });
});

describe('portal standalone entry paths', () => {
  it('treats onboarding-related portal routes as standalone entry surfaces', () => {
    expect(isPortalStandaloneEntryPath('/portal/onboarding')).toBe(true);
    expect(isPortalStandaloneEntryPath('/portal/project-select')).toBe(true);
    expect(isPortalStandaloneEntryPath('/portal/project-settings')).toBe(false);
    expect(isPortalStandaloneEntryPath('/portal/weekly-expenses')).toBe(true);
    expect(isPortalStandaloneEntryPath('/portal/register-project')).toBe(true);
    expect(isPortalStandaloneEntryPath('/portal/project-approvals')).toBe(true);
    expect(isPortalStandaloneEntryPath('/portal')).toBe(false);
    expect(isPortalStandaloneEntryPath('/portal/budget')).toBe(false);
  });
});
