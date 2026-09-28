import React, { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import {
  ChevronLeft, ChevronRight,
  Search, HelpCircle,
  Menu, LogOut, ExternalLink,
} from 'lucide-react';
import { useAppStore, AppProvider } from '../../data/store';
import { useAuth } from '../../data/auth-store';
import { useOptionalHrAnnouncements } from '../../data/hr-announcements-store';
import { FirebaseStatusBadge } from '../settings/FirebaseSetup';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import { Separator } from '../ui/separator';
import { CommandPalette } from './CommandPalette';
import { NotificationPanel } from './NotificationPanel';
import { Breadcrumbs } from './Breadcrumbs';
import { StatusBar } from './StatusBar';
import { DarkModeToggle } from './DarkModeToggle';
import { KeyboardShortcuts } from './KeyboardShortcuts';
import { ScrollToTop } from './ScrollToTop';
import { QuickActionFab } from './QuickActionFab';
import { PageTransition } from './PageTransition';
import { ErrorBoundary } from './ErrorBoundary';
import { canChooseWorkspace, isPortalRole } from '../../platform/navigation';
import { canAccessAdminPath, canShowAdminNavItem } from '../../platform/admin-nav';
import { NAV_GROUPS } from '../../platform/nav-config';
import { readShellLabEnabled, shouldShowShellRoute, writeShellLabEnabled } from '../../platform/shell-lab-visibility';
import { TenantSwitcher, TenantBadge } from '../settings/TenantSwitcher';
import { MyscWordmark } from '../brand/MyscWordmark';

function AppLayoutContent() {
  const { currentUser, transactions, dataSource } = useAppStore();
  const { isAuthenticated, isLoading: authLoading, user: authUser, logout, setWorkspacePreference } = useAuth();
  const hrAnnouncements = useOptionalHrAnnouncements();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [labEnabled, setLabEnabled] = useState(() => readShellLabEnabled());
  const location = useLocation();
  const navigate = useNavigate();
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const displayUser = authUser || currentUser;
  const blockedAdminPath = Boolean(
    !authLoading
    && isAuthenticated
    && displayUser?.role
    && !canAccessAdminPath(displayUser.role, location.pathname)
  );

  // Auth guard — 미인증 시 로그인 페이지로
  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      navigate('/login', { replace: true, state: { from: currentPath } });
    }
  }, [authLoading, currentPath, isAuthenticated, navigate]);

  useEffect(() => {
    if (authLoading) return;
    const role = authUser?.role;
    if (!isAuthenticated || !role || !canChooseWorkspace(role)) return;
    // pm/viewer가 잠깐 admin 라우트에 들어와도 workspace를 덮어쓰지 않음
    if (isPortalRole(role)) return;
    if (authUser?.lastWorkspace === 'admin') return;
    void setWorkspacePreference('admin', { persistDefault: false });
  }, [authLoading, authUser?.lastWorkspace, authUser?.role, isAuthenticated, setWorkspacePreference]);

  // Close mobile sidebar on route change
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  const navGroups = React.useMemo(() => {
    return NAV_GROUPS
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => (
          canShowAdminNavItem(displayUser?.role, item.to)
          && shouldShowShellRoute(item.to, 'admin', 'nav', { labEnabled })
        )),
      }))
      .filter((group) => group.items.length > 0);
  }, [displayUser?.role, labEnabled]);

  function toggleLab() {
    const next = !labEnabled;
    writeShellLabEnabled(next);
    setLabEnabled(next);
  }

  function openPortalWorkspace() {
    void setWorkspacePreference('portal', { persistDefault: false })
      .finally(() => navigate('/portal/project-select'));
  }

  const pendingCount = transactions.filter(t => t.state === 'SUBMITTED').length;
  const missingEvidenceCount = transactions.filter(t => t.evidenceStatus !== 'COMPLETE' && t.state !== 'REJECTED').length;

  const totalAlerts = pendingCount;

  if (authLoading || !isAuthenticated) return null;

  if (blockedAdminPath) {
    return (
      <TooltipProvider delayDuration={300}>
        <CommandPalette />
        <KeyboardShortcuts />
        <main className="min-h-dvh bg-background p-6">
          <div className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
            <Badge variant="outline">접근 제한</Badge>
            <h1 className="mt-4 text-lg font-semibold text-slate-950">이 화면을 열 수 없습니다</h1>
            <p className="mt-2 text-sm text-slate-600">
              권한 또는 작업 공간 상태를 확인해 주세요. 현재 URL은 유지했습니다.
            </p>
            {isPortalRole(displayUser?.role) && (
              <Button type="button" className="mt-5" onClick={openPortalWorkspace}>
                실무자 포털 열기
              </Button>
            )}
          </div>
        </main>
      </TooltipProvider>
    );
  }

  if (location.pathname === '/') {
    return (
      <TooltipProvider delayDuration={300}>
        <CommandPalette />
        <KeyboardShortcuts />
        <main className="min-h-dvh">
          <PageTransition>
            <ErrorBoundary resetKey={location.pathname}>
              <Outlet />
            </ErrorBoundary>
          </PageTransition>
        </main>
      </TooltipProvider>
    );
  }

  function getBadgeCount(to: string): number | null {
    if (to === '/evidence' && missingEvidenceCount > 0) return missingEvidenceCount;
    if (to === '/hr-announcements') {
      const hrCount = hrAnnouncements?.getAllPendingCount() ?? 0;
      return hrCount > 0 ? hrCount : null;
    }
    return null;
  }

  function isActive(to: string): boolean {
    const [targetPath, targetQuery] = to.split('?');
    if (targetQuery) {
      return location.pathname === targetPath && location.search === `?${targetQuery}`;
    }
    if (to === '/') return location.pathname === '/';
    if (to === '/projects/new') return location.pathname.startsWith('/projects/new');
    if (to === '/projects') return location.pathname.startsWith('/projects') && !location.pathname.startsWith('/projects/new');
    return location.pathname.startsWith(to);
  }

  return (
    <TooltipProvider delayDuration={300}>
      <CommandPalette />
      <KeyboardShortcuts />
      <div className="flex h-screen w-full overflow-hidden relative">
        {/* ━━━ Mobile Overlay ━━━ */}
        {mobileOpen && (
          <div
            className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 lg:hidden"
            onClick={() => setMobileOpen(false)}
          />
        )}

        {/* ━━━ Sidebar ━━━ */}
        <aside
          className={`flex flex-col transition-all duration-200 ease-out shrink-0
            ${collapsed ? 'w-[60px]' : 'w-[240px]'}
            fixed lg:relative inset-y-0 left-0 z-50
            ${mobileOpen ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0
            bg-sidebar border-r border-sidebar-border
          `}
        >
          {/* Brand */}
          <div className={`flex h-[48px] items-center px-3 ${collapsed ? 'justify-center overflow-hidden' : ''}`}>
            <button
              type="button"
              aria-label="홈으로 이동"
              onClick={() => navigate('/')}
              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <MyscWordmark
                tone="onDark"
                size={collapsed ? 'sm' : 'md'}
                className={collapsed ? 'max-w-8 overflow-hidden' : ''}
                imageClassName={collapsed ? 'max-w-none' : ''}
              />
            </button>
          </div>

          {/* Quick search */}
          {!collapsed && (
            <div className="px-2.5 mb-1">
              <button
                className="flex h-9 w-full items-center gap-2 rounded-md border border-sidebar-border bg-white/6 px-2.5 text-[11px] text-slate-300 transition-colors hover:bg-white/10"
                onClick={() => {
                  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
                }}
              >
                <Search className="w-3 h-3" />
                <span className="flex-1 text-left">빠른 검색...</span>
                <kbd className="rounded bg-slate-950/50 px-1 py-0.5 text-[9px] text-slate-400">⌘K</kbd>
              </button>
            </div>
          )}

          {/* Navigation */}
          <nav className="flex-1 py-1.5 overflow-y-auto">
            {navGroups.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? 'mt-3' : ''}>
                {!collapsed && (
                  <p className="border-b border-white/10 px-4 pb-2 text-[12px] tracking-[0.02em] text-slate-200" style={{ fontWeight: 700 }}>
                    {group.label}
                  </p>
                )}
                {collapsed && gi > 0 && <div className="mx-3 my-1.5 border-t border-white/10" />}
                <div className="space-y-px px-2">
                  {group.items.map(item => {
                    const active = isActive(item.to);
                    const badge = getBadgeCount(item.to);
                    const accent = (item as any).accent;

                    const navLink = (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        className={`
                          group relative flex items-center gap-2 rounded-md text-[12px] transition-all duration-100
                          ${collapsed ? 'justify-center h-10 w-full' : 'min-h-9 px-2.5 py-2'}
                          ${active
                            ? 'bg-cyan-400/12 text-white'
                            : 'text-slate-400 hover:text-slate-100 hover:bg-white/7'
                          }
                        `}
                      >
                        {active && !collapsed && (
                          <div className="absolute left-0 top-1/2 h-4 w-[2px] -translate-y-1/2 rounded-r bg-cyan-300" />
                        )}
                        <item.icon className={`w-[15px] h-[15px] shrink-0 ${
                          active ? 'text-cyan-300' : accent ? 'text-cyan-500/65' : 'text-slate-500 group-hover:text-slate-300'
                        }`} />
                        {!collapsed && (
                          <>
                            <span style={{ fontWeight: active ? 500 : 400 }}>{item.label}</span>
                            {badge !== null && (
                              <span className="ml-auto flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-rose-500/90 text-[9px] text-white px-1" style={{ fontWeight: 700 }}>
                                {badge}
                              </span>
                            )}
                          </>
                        )}
                      </NavLink>
                    );

                    if (collapsed) {
                      return (
                        <Tooltip key={item.to}>
                          <TooltipTrigger asChild>{navLink}</TooltipTrigger>
                          <TooltipContent side="right" className="text-[11px]" sideOffset={8}>
                            <div className="flex items-center gap-2">
                              {item.label}
                              {badge !== null && <span className="text-rose-400 text-[10px]" style={{ fontWeight: 600 }}>{badge}</span>}
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      );
                    }
                    return navLink;
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Footer */}
          <div className="border-t border-white/10 p-2 space-y-1.5">
            {/* Tenant switcher */}
            <TenantSwitcher collapsed={collapsed} userRole={displayUser.role} />
            {!collapsed && (
              <div className="px-1 mb-1">
                <FirebaseStatusBadge />
              </div>
            )}
            <DarkModeToggle collapsed={collapsed} />
            <button
              type="button"
              onClick={toggleLab}
              aria-pressed={labEnabled}
              aria-label={labEnabled ? 'LAB 메뉴 숨기기' : 'LAB 메뉴 보이기'}
              title={labEnabled ? 'LAB 메뉴 숨기기' : 'LAB 메뉴 보이기'}
              className={`w-full flex items-center justify-center h-7 rounded-md text-[10px] transition-colors ${
                labEnabled
                  ? 'bg-cyan-400/14 text-cyan-100'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/10'
              }`}
            >
              {collapsed ? 'LAB' : `LAB ${labEnabled ? 'ON' : 'OFF'}`}
            </button>
            {!collapsed && (
              <div className="flex items-center gap-2 rounded-md border border-sidebar-border bg-white/6 px-2 py-2">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-[10px] text-white"
                  style={{ fontWeight: 700, background: 'linear-gradient(135deg, #0891b2, #0f766e)' }}
                >
                  {displayUser.name.charAt(0)}
                </div>
                <div className="overflow-hidden flex-1">
                  <p className="text-[11px] text-slate-300 truncate" style={{ fontWeight: 500 }}>{displayUser.name}</p>
                  <p className="text-[9px] text-slate-600">{displayUser.role}</p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { logout(); navigate('/login'); }}
                      className="rounded p-1 text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-300"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">로그아웃</TooltipContent>
                </Tooltip>
              </div>
            )}
            <button
              onClick={() => setCollapsed(!collapsed)}
              className="flex h-8 w-full items-center justify-center rounded-md text-slate-500 transition-colors hover:bg-white/10 hover:text-slate-300"
            >
              {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
            </button>
          </div>
        </aside>

        {/* ━━━ Main ━━━ */}
        <div className="flex-1 flex flex-col min-w-0 bg-background">
          {/* Top Header */}
          <header className="sticky top-0 z-30 flex h-[48px] shrink-0 items-center justify-between border-b border-border bg-card/95 px-5 shadow-sm">
            <div className="flex items-center gap-3">
              {/* Mobile hamburger */}
              <button
                className="lg:hidden flex items-center justify-center w-7 h-7 rounded-md text-muted-foreground hover:bg-muted transition-colors"
                onClick={() => setMobileOpen(!mobileOpen)}
                aria-label={mobileOpen ? '메뉴 닫기' : '메뉴 열기'}
              >
                <Menu className="w-4 h-4" />
              </button>
              <Breadcrumbs />
            </div>

            <div className="flex items-center gap-1.5">
              {/* Data source pill */}
              {dataSource === 'firestore' ? (
                <div className="flex items-center gap-1.5 text-[10px] text-emerald-600 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/50 border border-emerald-200/60 dark:border-emerald-800/40 rounded-full px-2 py-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                  서버 연결
                </div>
              ) : (
                <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground bg-muted border border-border/60 rounded-full px-2 py-0.5">
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/50" />
                  로컬
                </div>
              )}

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    size="sm"
                    onClick={openPortalWorkspace}
                    className="h-8 gap-1.5 rounded-md border border-slate-950 bg-slate-950 px-3 text-[12px] font-semibold text-white shadow-sm transition-colors hover:bg-slate-800 hover:text-white focus-visible:ring-2 focus-visible:ring-slate-400 dark:border-slate-200 dark:bg-slate-100 dark:text-slate-950 dark:hover:bg-white"
                    aria-label="로그아웃 없이 실무자 포털로 이동"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    <span className="hidden sm:inline">실무자 포털</span>
                    <span className="sm:hidden">포털</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-[11px]">로그아웃 없이 실무자 포털로 이동</TooltipContent>
              </Tooltip>

              <div className="w-px h-4 bg-border/50 mx-0.5" />

              {/* Tenant badge */}
              <TenantBadge />

              <div className="w-px h-4 bg-border/50 mx-0.5" />

              {/* Search */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    aria-label="검색 열기"
                    onClick={() => {
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
                    }}
                  >
                    <Search className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-[11px]">검색 (⌘K)</TooltipContent>
              </Tooltip>

              {/* Keyboard shortcuts */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground"
                    aria-label="단축키 열기"
                    onClick={() => {
                      document.dispatchEvent(new KeyboardEvent('keydown', { key: '/', metaKey: true }));
                    }}
                  >
                    <HelpCircle className="w-3.5 h-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent className="text-[11px]">단축키 (⌘/)</TooltipContent>
              </Tooltip>

              {/* Notifications */}
              <NotificationPanel />

              <div className="w-px h-4 bg-border/50 mx-0.5" />

              {/* User avatar */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className="w-7 h-7 rounded-md flex items-center justify-center text-white text-[10px] cursor-pointer ring-1 ring-white/20"
                    style={{ fontWeight: 700, background: 'linear-gradient(135deg, #0891b2, #0f766e)' }}
                  >
                    {displayUser.name.charAt(0)}
                  </div>
                </TooltipTrigger>
                <TooltipContent className="text-[11px]">{displayUser.name} ({displayUser.role})</TooltipContent>
              </Tooltip>
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 overflow-y-auto">
            <div className="p-5 max-w-[1600px] mx-auto">
              <PageTransition>
                <ErrorBoundary resetKey={location.pathname}>
                  <Outlet />
                </ErrorBoundary>
              </PageTransition>
            </div>
          </main>

          {/* Status Bar */}
          <StatusBar />
        </div>
      </div>
      <ScrollToTop />
      <QuickActionFab />
    </TooltipProvider>
  );
}

export function AppLayout() {
  return (
    <AppProvider>
      <AppLayoutContent />
    </AppProvider>
  );
}
