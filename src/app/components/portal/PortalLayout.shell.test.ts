import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const portalLayoutSource = readFileSync(
  resolve(import.meta.dirname, 'PortalLayout.tsx'),
  'utf8',
);

describe('PortalLayout shell actions', () => {
  it('hides payroll from the primary portal navigation', () => {
    expect(portalLayoutSource).toContain("label: '인건비/공지', accent: true, hidden: true");
    expect(portalLayoutSource).not.toContain('monthlyCloses');
  });

  it('hides budget and weekly expense entry from the global portal navigation', () => {
    expect(portalLayoutSource).not.toContain("label: '예산 편집'");
    expect(portalLayoutSource).not.toContain("label: '사업비 입력(주간)'");
    expect(portalLayoutSource).toContain("label: '인건비/공지'");
    expect(portalLayoutSource).toContain("label: '프로젝트 수정'");
    expect(portalLayoutSource).not.toContain("label: '프로젝트 등록/승인'");
    expect(portalLayoutSource).toContain("to: '/portal/budget'");
    expect(portalLayoutSource).not.toContain("label: '명함 DB'");
  });

  it('turns the top search into a project switcher', () => {
    expect(portalLayoutSource).toContain('CommandDialog');
    expect(portalLayoutSource).toContain('setCommandOpen(true)');
    expect(portalLayoutSource).toContain('title="열기"');
    expect(portalLayoutSource).toContain('검색 또는 열기');
    expect(portalLayoutSource).toContain('업무 바로가기');
    expect(portalLayoutSource).toContain('프로젝트 전환');
    expect(portalLayoutSource).toContain('관리');
    expect(portalLayoutSource).toContain('일치하는 프로젝트가 없습니다.');
    expect(portalLayoutSource).toContain('data-testid="portal-project-switch-trigger"');
    expect(portalLayoutSource).toContain("item.kind === 'portal'");
    expect(portalLayoutSource).toContain("item.kind === 'project'");
    expect(portalLayoutSource).not.toContain('포털 빠른 이동');
    expect(portalLayoutSource).not.toContain('빠른 이동, 담당 사업, 화면 검색');
    expect(portalLayoutSource).not.toContain('담당 사업 검색 또는 전환');
    expect(portalLayoutSource).not.toContain('if (!changed) return;');
  });

  it('makes the header project picker searchable within the permitted project list', () => {
    expect(portalLayoutSource).toContain('data-testid="portal-header-project-search"');
    expect(portalLayoutSource).toContain('placeholder="프로젝트명 또는 ID 검색"');
    expect(portalLayoutSource).toContain('matchesProjectSearch(project, projectSearch)');
    expect(portalLayoutSource).toContain('switchProjectInPlace(project.id)');
  });

  it('uses the shared LAB visibility policy for portal shell items', () => {
    expect(portalLayoutSource).toContain('shouldShowShellRoute');
    expect(portalLayoutSource).toContain('labEnabled');
    expect(portalLayoutSource).toContain('LAB');
    expect(portalLayoutSource).toContain('LAB 메뉴 보이기');
    expect(portalLayoutSource).toContain('포털 메뉴 열기');
    expect(portalLayoutSource).not.toContain("item.to === '/portal/bank-statements' && currentFundInputMode === 'DIRECT_ENTRY'");
  });

  it('wires a user menu with profile, admin access, and logout', () => {
    expect(portalLayoutSource).toContain('내 프로필');
    expect(portalLayoutSource).toContain('로그아웃');
    expect(portalLayoutSource).toContain('관리자 공간');
    expect(portalLayoutSource).toContain('DropdownMenu');
  });

  it('uses a compact MYSC logo without extra workspace subtitle copy', () => {
    expect(portalLayoutSource).toContain('MyscWordmark');
    expect(portalLayoutSource.match(/aria-label="처음 화면으로 이동"/g)).toHaveLength(2);
    expect(portalLayoutSource.match(/aria-label="처음 화면으로 이동"[\s\S]*?onClick=\{\(\) => requestPortalNavigation\('\/', '처음 화면'\)\}/g)).toHaveLength(2);
    expect(portalLayoutSource).not.toContain("onClick={() => navigate('/')}\n");
    expect(portalLayoutSource).not.toContain('aria-label="포털 홈으로 이동"');
    expect(portalLayoutSource).not.toContain('MYSC Workspace');
    expect(portalLayoutSource).not.toContain('Project Operations');
    expect(portalLayoutSource).not.toContain('My Work');
  });

  it('drops a separate submissions tab once submission status is absorbed into the dashboard', () => {
    expect(portalLayoutSource).not.toContain("/portal/submissions");
  });

  it('keeps portal navigation explicit without onboarding or project-select redirect effects', () => {
    expect(portalLayoutSource).toContain('isPortalStandaloneEntryPath');
    expect(portalLayoutSource).toContain('isProjectRegistrationPath');
    expect(portalLayoutSource).toContain('&& !isProjectRegistrationPath');
    expect(portalLayoutSource).toContain('blockedPortalAccess');
    expect(portalLayoutSource).toContain("navigate('/portal/project-select')");
    expect(portalLayoutSource).not.toContain("navigate('/portal/weekly-expenses')");
    expect(portalLayoutSource).toContain("navigate('/portal/register-project')");
    expect(portalLayoutSource).not.toContain("navigate('/', { replace: true })");
    expect(portalLayoutSource).not.toContain('shouldForcePortalOnboarding');
    expect(portalLayoutSource).not.toContain('resolvePortalProjectSelectPath(currentPath)');
  });

  it('keeps project registration inside the global portal shell even before a project is assigned', () => {
    expect(portalLayoutSource).toContain("location.pathname === '/portal/register-project'");
    expect(portalLayoutSource).toContain("location.pathname.startsWith('/portal/register-project/')");
    expect(portalLayoutSource).toContain('!portalUser && !isProjectRegistrationPath');
    expect(portalLayoutSource).toContain("if (isProjectRegistrationPath) return '프로젝트 등록';");
  });

  it('exposes stable portal navigation test ids for release-gate flows', () => {
    expect(portalLayoutSource).toContain('function buildPortalNavTestId');
    expect(portalLayoutSource).toContain('data-testid={buildPortalNavTestId(item.to)}');
    expect(portalLayoutSource).toContain("portal-nav-${path");
  });

  it('uses reduced content padding for workbook-style work surfaces', () => {
    expect(portalLayoutSource).toContain("location.pathname === '/portal/weekly-expenses' ||");
    expect(portalLayoutSource).toContain("location.pathname.startsWith('/portal/cashflow')");
    expect(portalLayoutSource).toContain("w-full max-w-none px-5 py-2.5");
    expect(portalLayoutSource).toContain("mx-auto w-full max-w-[1480px] px-5 py-2.5");
    expect(portalLayoutSource).not.toContain("p-4 md:p-6");
  });

  it('keeps the mounted outlet visible during background auth and portal loading', () => {
    expect(portalLayoutSource).toContain('cashflowHasProjectContext');
    expect(portalLayoutSource).toContain('portalBootstrapped');
    expect(portalLayoutSource).toContain('shouldShowPortalLoading');
    expect(portalLayoutSource).toContain('!portalBootstrapped &&');
    expect(portalLayoutSource).toContain('data-testid="portal-background-loading"');
    expect(portalLayoutSource).not.toContain('if (authLoading || portalLoading)');
  });

  it('checks the dirty guard before changing project state or the canonical URL', () => {
    expect(portalLayoutSource).toContain('runPortalProjectSwitch');
    expect(portalLayoutSource).toContain('resolvePortalRouteProjectId(location.pathname)');
    expect(portalLayoutSource).toContain('setSessionActiveProject(routeProjectId)');
    expect(portalLayoutSource).toContain('isNavigationBlocked: (attempt) => Boolean(navigationHandlerRef.current?.(attempt))');
    expect(portalLayoutSource).not.toContain('setSessionActiveProject(projectId).then');
  });

  it('does not start cashflow realtime presence or edit-lock listeners from the portal shell', () => {
    expect(portalLayoutSource).not.toContain('cashflowPresence');
    expect(portalLayoutSource).not.toContain('cashflowEditLocks');
    expect(portalLayoutSource).not.toContain('cashflowPresenceUsers');
    expect(portalLayoutSource).not.toContain('cashflowEditLock');
    expect(portalLayoutSource).not.toContain('onSnapshot');
  });
});
