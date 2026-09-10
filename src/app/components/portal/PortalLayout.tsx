import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, NavLink, useLocation, useNavigate } from 'react-router';
import {
  LogOut,
  FolderKanban, Menu,
  Plus, Pencil,
  ClipboardCheck,
  CircleDollarSign,
  BarChart3,
  Loader2,
  FileSpreadsheet,
  Sparkles,
  ArrowRight,
  Shield,
  ChevronLeft,
  ChevronRight,
  Search,
  Bell,
  UserCircle2,
  User,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react';
import { PortalProvider, usePortalStore } from '../../data/portal-store';
import { useAuth } from '../../data/auth-store';
import { useHrAnnouncements } from '../../data/hr-announcements-store';
import { usePayroll } from '../../data/payroll-store';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../ui/tooltip';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import {
  CommandDialog,
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from '../ui/command';
import { DarkModeToggle } from '../layout/DarkModeToggle';
import { PageTransition } from '../layout/PageTransition';
import { ErrorBoundary } from '../layout/ErrorBoundary';
import { MyscWordmark } from '../brand/MyscWordmark';
import { normalizeProjectIds } from '../../data/project-assignment';
import {
  canChooseWorkspace,
  canEnterPortalWorkspace,
  isPortalStandaloneEntryPath,
  isAdminSpaceRole,
} from '../../platform/navigation';
import { getSeoulTodayIso } from '../../platform/business-days';
import { normalizeProjectFundInputMode } from '../../data/types';
import { rememberRecentPortalProject } from '../../platform/portal-recent-projects';
import { matchesProjectSearch } from '../../platform/project-search';
import { buildPortalShellCommandItems, buildPortalShellNotificationItems } from '../../platform/portal-shell-actions';
import { shouldShowShellRoute, useShellLabEnabled } from '../../platform/shell-lab-visibility';
import {
  resolvePortalProjectCandidates,
  resolvePortalRouteProjectId,
  runPortalProjectSwitch,
} from '../../platform/portal-project-selection';

// ═══════════════════════════════════════════════════════════════
// PortalLayout — 사용자(PM) 전용 레이아웃
// 하나의 프로젝트만 볼 수 있는 간소화된 UI
// ═══════════════════════════════════════════════════════════════

type PortalNavItem = {
  to: string;
  icon: LucideIcon;
  label: string;
  accent?: boolean;
  exact?: boolean;
  hidden?: boolean;
};

type PortalNavSection = {
  title: string;
  items: PortalNavItem[];
};

const NAV_SECTIONS: PortalNavSection[] = [
  {
    title: '마이메뉴',
    items: [
      // 자기 인사정보를 넣는 자리다. 아바타 드롭다운 안에만 두면 실무자가 못 찾는다.
      { to: '/portal/career-profile', icon: User, label: '마이페이지' },
      { to: '/portal/payroll', icon: CircleDollarSign, label: '인건비/공지', accent: true, hidden: true },
    ],
  },
  {
    title: '사업비관리',
    items: [
      { to: '/portal/budget', icon: BarChart3, label: '예산총괄' },
      { to: '/portal/cashflow', icon: BarChart3, label: '캐시플로(주간)' },
      { to: '/portal/cashflow/sheets-lab', icon: FileSpreadsheet, label: '시트 연동 검토', hidden: true },
    ],
  },
  {
    title: '프로젝트 배정 및 등록',
    items: [
      { to: '/portal/edit-project', icon: Pencil, label: '프로젝트 수정' },
      { to: '/portal/project-checkout', icon: ClipboardCheck, label: '종료사업 체크아웃' },
      { to: '/portal/register-project', icon: Plus, label: '프로젝트 등록 요청', accent: true },
      { to: '/portal/business-cards', icon: UserRoundCheck, label: '명함 DB' },
    ],
  },
];

type PortalNavigationAttempt = {
  path: string;
  label: string;
};

type PortalNavigationGuardValue = {
  registerNavigationHandler: (handler: ((attempt: PortalNavigationAttempt) => boolean) | null) => void;
};

const PortalNavigationGuardContext = createContext<PortalNavigationGuardValue>({
  registerNavigationHandler: () => {},
});

const PORTAL_SIDEBAR_STORAGE_KEY = 'mysc-portal-sidebar-collapsed';

function readPortalSidebarCollapsed(uid?: string | null): boolean {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid || typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(`${PORTAL_SIDEBAR_STORAGE_KEY}:${normalizedUid}`) === 'true';
  } catch {
    return false;
  }
}

function writePortalSidebarCollapsed(uid: string | null | undefined, collapsed: boolean) {
  const normalizedUid = String(uid || '').trim();
  if (!normalizedUid || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(`${PORTAL_SIDEBAR_STORAGE_KEY}:${normalizedUid}`, collapsed ? 'true' : 'false');
  } catch {
    // ignore localStorage failures
  }
}

function buildPortalNavTestId(path: string) {
  return `portal-nav-${path.replace(/^\/+/, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '')}`;
}

export function usePortalNavigationGuard() {
  return useContext(PortalNavigationGuardContext);
}

function PortalContent() {
  const {
    activeProjectId,
    isLoading: portalLoading,
    portalUser,
    myProject,
    logout: portalLogout,
    changeRequests,
    projects,
    setSessionActiveProject,
  } = usePortalStore();
  const {
    isAuthenticated,
    isLoading: authLoading,
    user: authUser,
    logout: authLogout,
    setWorkspacePreference,
  } = useAuth();
  const { getUnacknowledgedCount } = useHrAnnouncements();
  const { runs } = usePayroll();
  const location = useLocation();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');
  const [portalBootstrapped, setPortalBootstrapped] = useState(false);
  const [labEnabled, setLabEnabled] = useShellLabEnabled();
  const navigationHandlerRef = useRef<((attempt: PortalNavigationAttempt) => boolean) | null>(null);
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const isCashflowWorkspace = location.pathname.startsWith('/portal/cashflow');
  const isProjectRegistrationPath = location.pathname === '/portal/register-project'
    || location.pathname.startsWith('/portal/register-project/');
  const blockedPortalAccess = Boolean(
    !authLoading
    && !portalLoading
    && isAuthenticated
    && authUser?.role
    && !canEnterPortalWorkspace(authUser.role)
  );
  const registerNavigationHandler = useCallback((handler: ((attempt: PortalNavigationAttempt) => boolean) | null) => {
    navigationHandlerRef.current = handler;
  }, []);
  const requestPortalNavigation = useCallback((path: string, label: string) => {
    if (navigationHandlerRef.current?.({ path, label })) return;
    navigate(path);
  }, [navigate]);
  const requestAdminNavigation = useCallback(() => {
    if (navigationHandlerRef.current?.({ path: '/', label: '관리자 공간' })) return;
    void setWorkspacePreference('admin', { persistDefault: false })
      .finally(() => navigate('/'));
  }, [navigate, setWorkspacePreference]);
  const handleLogout = useCallback(() => {
    portalLogout();
    authLogout();
    navigate('/login');
  }, [authLogout, navigate, portalLogout]);

  // ── 모든 hooks는 early return 전에 호출 ──
  const assignedProjectIds = useMemo(() => normalizeProjectIds([
    ...(Array.isArray(portalUser?.projectIds) ? portalUser.projectIds : []),
    portalUser?.projectId,
    ...(Array.isArray(authUser?.projectIds) ? authUser.projectIds : []),
    authUser?.projectId,
  ]), [authUser?.projectId, authUser?.projectIds, portalUser?.projectId, portalUser?.projectIds]);
  const candidateProjects = useMemo(() => resolvePortalProjectCandidates({
    role: authUser?.role,
    authUid: authUser?.uid,
    assignedProjectIds,
    projects,
  }), [assignedProjectIds, authUser?.role, authUser?.uid, projects]);
  const assignedProjects = useMemo(() => {
    if (candidateProjects.priorityProjects.length > 0) return candidateProjects.priorityProjects;
    return myProject ? [myProject] : [];
  }, [candidateProjects.priorityProjects, myProject]);

  const projectOptions = useMemo(() => {
    return candidateProjects.searchProjects.map((project) => ({
      id: project.id,
      name: project.name,
    }));
  }, [candidateProjects.searchProjects]);
  const filteredProjectOptions = useMemo(() => (
    candidateProjects.searchProjects.filter((project) => matchesProjectSearch(project, projectSearch))
  ), [candidateProjects.searchProjects, projectSearch]);

  const routeProjectId = useMemo(
    () => resolvePortalRouteProjectId(location.pathname),
    [location.pathname],
  );

  const currentProject = useMemo(() => {
    if (routeProjectId) {
      const routeProject = candidateProjects.searchProjects.find((project) => project.id === routeProjectId);
      if (routeProject) return routeProject;
    }
    if (activeProjectId) {
      return candidateProjects.searchProjects.find((project) => project.id === activeProjectId) || myProject;
    }
    return myProject || candidateProjects.priorityProjects[0] || candidateProjects.searchProjects[0] || null;
  }, [activeProjectId, candidateProjects.priorityProjects, candidateProjects.searchProjects, myProject, routeProjectId]);

  useEffect(() => {
    if (!routeProjectId || routeProjectId === activeProjectId) return;
    if (!candidateProjects.searchProjects.some((project) => project.id === routeProjectId)) return;
    void setSessionActiveProject(routeProjectId);
  }, [activeProjectId, candidateProjects.searchProjects, routeProjectId, setSessionActiveProject]);

  const selectedProjectOptionValue = useMemo(() => {
    if (!currentProject?.id) return '';
    return projectOptions.some((item) => item.id === currentProject.id) ? currentProject.id : '';
  }, [currentProject?.id, projectOptions]);

  useEffect(() => {
    if (!currentProject?.id) return;
    rememberRecentPortalProject(currentProject.id);
  }, [currentProject?.id]);

  useEffect(() => {
    setCollapsed(readPortalSidebarCollapsed(authUser?.uid));
  }, [authUser?.uid]);

  const toggleSidebar = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writePortalSidebarCollapsed(authUser?.uid, next);
      return next;
    });
  }, [authUser?.uid]);

  const currentProjectName = currentProject?.name || myProject?.name || '';
  const cashflowHasProjectContext = Boolean(
    portalUser
    && (activeProjectId || myProject?.id || authUser?.projectId || currentProject?.id || assignedProjectIds.length > 0),
  );
  useEffect(() => {
    if (!authLoading && !portalLoading) setPortalBootstrapped(true);
  }, [authLoading, portalLoading]);
  const shouldShowPortalLoading = !portalBootstrapped && (
    authLoading || (portalLoading && (!isCashflowWorkspace || !cashflowHasProjectContext))
  );
  const portalDisplayName = portalUser?.name || authUser?.name || '사용자';
  const portalDisplayRole = portalUser?.role || authUser?.role || 'pm';
  const currentFundInputMode = normalizeProjectFundInputMode(currentProject?.fundInputMode);
  const navSections = useMemo(() => (
    NAV_SECTIONS.map((section) => ({
      ...section,
      items: section.items.filter((item) => {
        if ('hidden' in item && item.hidden) return false;
        return shouldShowShellRoute(item.to, 'portal', 'nav', {
          fundInputMode: currentFundInputMode,
          labEnabled,
        });
      }),
    }))
  ), [currentFundInputMode, labEnabled]);
  const topNavItems = useMemo(() => navSections.flatMap((section) => section.items), [navSections]);
  const currentSectionLabel = useMemo(() => {
    if (isProjectRegistrationPath) return '프로젝트 등록';
    const current = topNavItems.find((item) => isActive(item.to, item.exact));
    return current?.label || '프로젝트 선택';
  }, [isProjectRegistrationPath, topNavItems, location.pathname]);
  const shellCommandItems = useMemo(() => buildPortalShellCommandItems({
    role: authUser?.role,
    currentPath,
    currentProject: currentProject ? { id: currentProject.id, name: currentProject.name } : null,
    availableProjects: projectOptions,
    fundInputMode: currentFundInputMode,
    labEnabled,
  }), [authUser?.role, currentFundInputMode, currentPath, currentProject, labEnabled, projectOptions]);
  const workCommandItems = useMemo(() => shellCommandItems.filter((item) => item.category === '업무'), [shellCommandItems]);
  const projectCommandItems = useMemo(() => shellCommandItems.filter((item) => item.category === '프로젝트'), [shellCommandItems]);
  const adminCommandItems = useMemo(() => shellCommandItems.filter((item) => item.category === '관리'), [shellCommandItems]);
  const switchProjectInPlace = useCallback((projectId: string, targetPath = currentPath) => {
    void runPortalProjectSwitch({
      projectId,
      currentPath: targetPath,
      label: currentSectionLabel,
      isNavigationBlocked: (attempt) => Boolean(navigationHandlerRef.current?.(attempt)),
      setActiveProject: setSessionActiveProject,
      navigate: (path) => navigate(path),
    });
  }, [currentPath, currentSectionLabel, navigate, setSessionActiveProject]);


  // 미인증 시 로그인으로
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
    // admin/finance가 portal을 잠깐 방문할 때 workspace를 덮어쓰지 않음
    if (isAdminSpaceRole(role)) return;
    if (authUser?.lastWorkspace === 'portal') return;
    void setWorkspacePreference('portal', { persistDefault: false });
  }, [authLoading, authUser?.lastWorkspace, authUser?.role, isAuthenticated, setWorkspacePreference]);

  // Close mobile sidebar on navigation
  useEffect(() => {
    setMobileOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isEditable = !!target && (
        target.tagName === 'INPUT'
        || target.tagName === 'TEXTAREA'
        || target.isContentEditable
      );
      if (isEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setCommandOpen((prev) => !prev);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (shouldShowPortalLoading) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-5 h-5 mx-auto animate-spin text-muted-foreground" />
          <p className="mt-2 text-[12px] text-muted-foreground">포털 데이터를 불러오는 중...</p>
        </div>
      </div>
    );
  }

  if (blockedPortalAccess) {
    return (
      <div className="min-h-screen bg-slate-50 px-6 py-8 dark:bg-slate-950">
        <div className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <Badge variant="outline">접근 제한</Badge>
          <h1 className="mt-4 text-lg font-semibold text-slate-950 dark:text-slate-50">이 포털 화면을 열 수 없습니다</h1>
          <p className="mt-2 text-sm text-slate-600 dark:text-slate-300">
            권한 또는 작업 공간 상태를 확인해 주세요. 현재 URL은 유지했습니다.
          </p>
          {isAdminSpaceRole(authUser?.role) && (
            <Button type="button" className="mt-5" onClick={requestAdminNavigation}>
              관리자 공간 열기
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (location.pathname === '/portal/project-select' && canEnterPortalWorkspace(authUser?.role)) {
    return <Outlet />;
  }

  if (isPortalStandaloneEntryPath(location.pathname)
    && !isProjectRegistrationPath
    && !isAdminSpaceRole(authUser?.role)) {
    return <Outlet />;
  }

  if (!portalUser && !isProjectRegistrationPath && !isAdminSpaceRole(authUser?.role)) {
    return (
      <div className="min-h-screen bg-slate-50 px-6 py-8 dark:bg-slate-950">
        <div className="mx-auto w-full max-w-6xl">
          {/* 환영 헤더 */}
          <div className="text-center mb-8">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-lg bg-[#001e46] shadow-sm mb-4">
              <Sparkles className="w-7 h-7 text-white" />
            </div>
            <h1 className="text-xl font-bold tracking-tight">
              환영합니다!
            </h1>
            <p className="text-sm text-muted-foreground mt-1.5">
              프로젝트 관리를 시작하려면 아래에서 선택해 주세요
            </p>
          </div>

          {/* 선택 카드 */}
          <div className="grid gap-3">
            <button
              onClick={() => navigate('/portal/project-select')}
              className="group relative flex items-center gap-4 rounded-lg border border-border bg-white p-5 text-left shadow-sm transition-all duration-200 hover:border-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-sky-50 text-sky-700 transition-transform group-hover:scale-105 dark:bg-sky-950 dark:text-sky-300">
                <FolderKanban className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">기존 프로젝트 선택</p>
                <p className="text-xs text-muted-foreground mt-0.5">이미 등록된 프로젝트에서 선택하여 시작합니다</p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-[#001e46] group-hover:translate-x-0.5 transition-all" />
            </button>

            <button
              onClick={() => navigate('/portal/register-project')}
              className="group relative flex items-center gap-4 rounded-lg border border-border bg-white p-5 text-left shadow-sm transition-all duration-200 hover:border-slate-300 hover:bg-slate-50 dark:bg-slate-900 dark:hover:bg-slate-800"
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md bg-slate-100 text-[#001e46] transition-transform group-hover:scale-105 dark:bg-slate-800 dark:text-slate-200">
                <Plus className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold">새 프로젝트 등록</p>
                <p className="text-xs text-muted-foreground mt-0.5">새로운 프로젝트를 제안하고 등록을 시작합니다</p>
              </div>
              <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-[#001e46] group-hover:translate-x-0.5 transition-all" />
            </button>

            {isAdminSpaceRole(authUser?.role) && (
              <button
                onClick={requestAdminNavigation}
                className="group relative flex items-center gap-4 p-5 rounded-2xl border border-border/60 bg-white/80 dark:bg-slate-800/60 backdrop-blur-sm hover:border-slate-300 hover:shadow-md hover:shadow-slate-500/5 transition-all duration-200 text-left"
              >
                <div className="shrink-0 flex items-center justify-center w-11 h-11 rounded-xl bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-200 group-hover:scale-105 transition-transform">
                  <Shield className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold">관리자 공간으로 이동</p>
                  <p className="text-xs text-muted-foreground mt-0.5">조직 운영, 사용자 관리, 전사 설정 화면으로 이동합니다</p>
                </div>
                <ArrowRight className="w-4 h-4 text-muted-foreground/40 group-hover:text-slate-500 group-hover:translate-x-0.5 transition-all" />
              </button>
            )}
          </div>

          {/* 로그아웃 */}
          <div className="mt-6 text-center">
            <button
              onClick={() => { portalLogout(); authLogout(); navigate('/login'); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              다른 계정으로 로그인
            </button>
          </div>
        </div>
      </div>
    );
  }

  // 배지 카운트
  const pendingChanges = changeRequests.filter(r => r.state === 'SUBMITTED').length;
  const hrAlertCount = getUnacknowledgedCount();
  const payrollPendingCount = (() => {
    const today = getSeoulTodayIso();
    const yearMonth = today.slice(0, 7);
    const projectId = currentProject?.id;
    if (!projectId) return 0;
    const run = runs.find((r) => r.projectId === projectId && r.yearMonth === yearMonth);
    return run && today >= run.noticeDate && !run.acknowledged ? 1 : 0;
  })();
  const notificationItems = buildPortalShellNotificationItems({
    pendingChanges,
    hrAlertCount,
    payrollPendingCount,
  });
  function isActive(to: string, exact?: boolean) {
    if (exact) return location.pathname === to;
    return location.pathname.startsWith(to);
  }

  function getBadge(to: string): number | null {
    if (to === '/portal/payroll' && payrollPendingCount > 0) return payrollPendingCount;
    if (to === '/portal/change-requests') {
      const total = pendingChanges + hrAlertCount;
      return total > 0 ? total : null;
    }
    return null;
  }

  const useWidePortalCanvas = location.pathname === '/portal/weekly-expenses' || isCashflowWorkspace;

  return (
    <PortalNavigationGuardContext.Provider value={{ registerNavigationHandler }}>
      <TooltipProvider delayDuration={300}>
      <div className="flex h-screen w-full overflow-hidden relative">
        {portalBootstrapped && (authLoading || portalLoading) && (
          <div
            data-testid="portal-background-loading"
            className="fixed right-4 top-4 z-[70] flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs text-slate-600 shadow-sm"
            role="status"
          >
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            최신 정보를 확인하는 중...
          </div>
        )}
        {/* ── Mobile overlay ── */}
        {mobileOpen && (
          <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-40 lg:hidden" onClick={() => setMobileOpen(false)} />
        )}

        {/* ── Mobile drawer ── */}
        <aside className={`
          ${collapsed ? 'w-[60px]' : 'w-[240px]'} flex flex-col shrink-0 z-50
          fixed inset-y-0 left-0 lg:hidden
          transition-all duration-200
          ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}
          bg-sidebar/90 backdrop-blur-xl border-r border-white/10
        `}>
          {/* Brand */}
          <div className={`flex items-center gap-2.5 h-[48px] px-3 ${collapsed ? 'justify-center' : ''}`}>
            <button
              type="button"
              aria-label="처음 화면으로 이동"
              onClick={() => requestPortalNavigation('/', '처음 화면')}
              className="rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
            >
              <MyscWordmark
                tone="onDark"
                size={collapsed ? 'sm' : 'md'}
                className={collapsed ? 'max-w-8 overflow-hidden' : ''}
                imageClassName={collapsed ? 'max-w-none' : ''}
              />
            </button>
            {!collapsed && (
              <div className="flex-1" />
            )}
          </div>

          {/* 프로젝트 정보 카드 */}
          {currentProject && !collapsed && (
            <div className="mx-2.5 mb-2 p-2.5 rounded-xl bg-white/8 border border-white/20">
              <p className="text-[10px] text-slate-500 mb-0.5">내 프로젝트</p>
              {projectOptions.length > 0 ? (
                <Select
                  value={selectedProjectOptionValue}
                  onValueChange={(value) => {
                    if (value && value !== currentProject?.id) {
                      switchProjectInPlace(value);
                    }
                  }}
                >
                  <SelectTrigger className="h-7 text-[10px] px-2 bg-white/8 border-white/20 text-slate-200">
                    <SelectValue placeholder="프로젝트 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {projectOptions.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-[11px] text-white truncate" style={{ fontWeight: 600 }}>
                  {currentProjectName.length > 28 ? currentProjectName.slice(0, 28) + '...' : currentProjectName}
                </p>
              )}
              <div className="flex items-center gap-1.5 mt-1">
                <Badge className="text-[8px] h-3.5 px-1 border-white/20 bg-white/10 text-slate-200">
                  {currentProject?.clientOrg || ''}
                </Badge>
                <span className="text-[9px] text-slate-600">{currentProject?.department || ''}</span>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="mt-2 h-6 text-[10px] w-full border-white/20 bg-white/8 text-slate-200 hover:bg-white/15"
                onClick={() => requestPortalNavigation('/portal/project-select', '프로젝트 선택')}
              >
                프로젝트 선택
              </Button>
            </div>
          )}

          {currentProject && collapsed && (
            <div className="mx-2.5 mb-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="outline"
                    size="icon"
                    className="h-9 w-9 border-white/20 bg-white/8 text-slate-200 hover:bg-white/15"
                    onClick={() => requestPortalNavigation('/portal/project-select', '프로젝트 선택')}
                  >
                    <FolderKanban className="h-4 w-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right" className="text-[11px]">
                  <div className="space-y-1">
                    <p className="font-medium text-slate-900">{currentProjectName || '프로젝트 미선택'}</p>
                    <p className="text-slate-500">프로젝트 선택</p>
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>
          )}

          {/* Navigation */}
          <nav className="flex-1 py-1 overflow-y-auto">
            <div className="space-y-3 px-2">
              {navSections.map((section) => {
                const visibleItems = section.items;
                if (visibleItems.length === 0) return null;
                return (
                  <div key={section.title} className="space-y-1">
                    {!collapsed && (
                      <p className="px-2.5 text-[10px] text-slate-500 tracking-wide" style={{ fontWeight: 700 }}>
                        {section.title}
                      </p>
                    )}
                    <div className="space-y-px">
                      {visibleItems.map((item) => {
                        const active = isActive(item.to, item.exact);
                        const badge = getBadge(item.to);
                        const navLink = (
                          <NavLink
                            key={item.to}
                            to={item.to}
                            end={item.exact}
                            data-testid={buildPortalNavTestId(item.to)}
                            onClick={(event) => {
                              event.preventDefault();
                              requestPortalNavigation(item.to, item.label);
                            }}
                            className={`
                              group relative flex items-center gap-2 rounded-md text-[12px] transition-all duration-100
                              ${collapsed ? 'justify-center h-9 w-full px-0' : 'px-2.5 py-[7px]'}
                              ${active
                                ? 'bg-white/12 text-white'
                                : 'text-slate-400 hover:text-slate-200 hover:bg-white/8'
                              }
                            `}
                          >
                            {active && !collapsed && (
                              <div className="absolute left-0 top-1/2 -translate-y-1/2 w-[2px] h-3.5 rounded-r bg-[#5bbfdf]" />
                            )}
                            <item.icon className={`w-[15px] h-[15px] shrink-0 ${active ? 'text-[#5bbfdf]' : 'text-slate-600 group-hover:text-slate-400'}`} />
                            {!collapsed && (
                              <>
                                <span style={{ fontWeight: active ? 500 : 400 }}>{item.label}</span>
                                {badge !== null && (
                                  <span className="ml-auto flex items-center justify-center min-w-[16px] h-[16px] rounded-full bg-[#5bbfdf] text-[9px] text-[#001e46] px-1" style={{ fontWeight: 700 }}>
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
                              <TooltipContent side="right" className="text-[11px]">
                                <div className="flex items-center gap-2">
                                  <span>{item.label}</span>
                                  {badge !== null && <span className="text-[#001e46]">{badge}</span>}
                                </div>
                              </TooltipContent>
                            </Tooltip>
                          );
                        }
                        return navLink;
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

          </nav>

          {/* Footer */}
          <div className="border-t border-white/10 p-2 space-y-1.5">
            <DarkModeToggle collapsed={collapsed} />
            <button
              type="button"
              onClick={() => setLabEnabled(!labEnabled)}
              aria-label={labEnabled ? 'LAB 메뉴 숨기기' : 'LAB 메뉴 보이기'}
              title={labEnabled ? 'LAB 메뉴 숨기기' : 'LAB 메뉴 보이기'}
              className={`w-full flex items-center justify-center h-7 rounded-md text-[10px] transition-colors ${
                labEnabled
                  ? 'bg-white/12 text-slate-100'
                  : 'text-slate-500 hover:text-slate-300 hover:bg-white/10'
              }`}
              aria-pressed={labEnabled}
            >
              LAB
            </button>
            {!collapsed ? (
              <div className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-white/8 border border-white/10">
                <div
                  className="w-6 h-6 rounded-md flex items-center justify-center shrink-0 text-[10px] text-white"
                  style={{ fontWeight: 700, background: '#001e46' }}
                >
                  {portalDisplayName.charAt(0)}
                </div>
                <div className="overflow-hidden flex-1">
                  <p className="text-[11px] text-slate-300 truncate" style={{ fontWeight: 500 }}>{portalDisplayName}</p>
                  <p className="text-[9px] text-slate-600">{portalDisplayRole}</p>
                </div>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { portalLogout(); authLogout(); navigate('/login'); }}
                      aria-label="로그아웃"
                      className="p-1 rounded hover:bg-white/15 text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="text-[11px]">로그아웃</TooltipContent>
                </Tooltip>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-2">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => { portalLogout(); authLogout(); navigate('/login'); }}
                      aria-label="로그아웃"
                      className="flex h-9 w-9 items-center justify-center rounded-md border border-white/10 bg-white/8 text-slate-400 hover:bg-white/15 hover:text-slate-200 transition-colors"
                    >
                      <LogOut className="w-3.5 h-3.5" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right" className="text-[11px]">로그아웃</TooltipContent>
                </Tooltip>
              </div>
            )}
            <button
              onClick={toggleSidebar}
              aria-label={collapsed ? '사이드바 펼치기' : '사이드바 접기'}
              className="w-full flex items-center justify-center h-7 rounded-md text-slate-500 hover:text-slate-300 hover:bg-white/10 transition-colors"
            >
              {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronLeft className="w-3.5 h-3.5" />}
            </button>
          </div>
        </aside>

        {/* ── Main ── */}
        <div className="flex-1 flex flex-col min-w-0 bg-slate-50">
          <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200 bg-white shadow-[0_1px_0_rgba(15,23,42,0.04)]">
            <div className="flex h-14 items-center gap-3 border-b border-slate-200 bg-[#0f2747] px-4 text-white md:px-6">
              <button
                className="rounded-md p-1.5 text-slate-200 transition-colors hover:bg-white/10 lg:hidden"
                onClick={() => setMobileOpen(true)}
                aria-label="포털 메뉴 열기"
              >
                <Menu className="h-4 w-4" />
              </button>
              <div className="flex min-w-0 items-center gap-2">
                <button
                  type="button"
                  aria-label="처음 화면으로 이동"
                  onClick={() => requestPortalNavigation('/', '처음 화면')}
                  className="shrink-0 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
                >
                  <MyscWordmark tone="onDark" size="md" />
                </button>
              </div>
              <div className="hidden flex-1 items-center justify-center px-4 md:flex">
                <button
                  type="button"
                  data-testid="portal-project-switch-trigger"
                  onClick={() => setCommandOpen(true)}
                  aria-label="검색 또는 열기"
                  className="flex h-10 w-full max-w-none items-center gap-2 rounded-lg border border-white/15 bg-white/8 px-3 text-left text-slate-200 transition-colors hover:bg-white/12"
                >
                  <Search className="h-4 w-4 text-slate-300" />
                  <span className="truncate text-[12px] text-slate-300">검색 또는 열기</span>
                  <span className="ml-auto rounded-md border border-white/15 bg-white/8 px-2 py-1 text-[10px] font-semibold text-slate-300">
                    ⌘K
                  </span>
                </button>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                {isAdminSpaceRole(authUser?.role) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="hidden h-8 border-white/15 bg-white/8 text-[11px] text-white hover:bg-white/12 md:inline-flex"
                    onClick={requestAdminNavigation}
                  >
                    <Shield className="mr-1 h-3.5 w-3.5" />
                    관리자 공간
                  </Button>
                )}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="알림 메뉴 열기"
                      className="relative rounded-md p-2 text-slate-200 transition-colors hover:bg-white/10"
                    >
                      <Bell className="h-4 w-4" />
                      {notificationItems.length > 0 && (
                        <span className="absolute right-1 top-1 inline-flex h-2 w-2 rounded-full bg-[#5bbfdf]" />
                      )}
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-72 text-[12px]">
                    <DropdownMenuLabel>알림</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    {notificationItems.length === 0 ? (
                      <DropdownMenuItem disabled>처리할 알림 없음</DropdownMenuItem>
                    ) : (
                      <DropdownMenuGroup>
                        {notificationItems.map((item) => (
                          <DropdownMenuItem
                            key={item.id}
                            onClick={() => requestPortalNavigation(item.to, item.label)}
                            className="flex flex-col items-start gap-0.5 py-2"
                          >
                            <span className="font-medium text-slate-900">{item.label}</span>
                            <span className="text-[11px] text-slate-500">{item.description}</span>
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuGroup>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      aria-label="사용자 메뉴 열기"
                      className="rounded-md p-2 text-slate-200 transition-colors hover:bg-white/10"
                    >
                      <UserCircle2 className="h-4 w-4" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64 text-[12px]">
                    <DropdownMenuLabel className="space-y-0.5">
                      <div className="text-[12px] font-semibold text-slate-900">{portalDisplayName}</div>
                      <div className="text-[11px] font-normal text-slate-500">{authUser?.email || ''}</div>
                    </DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuGroup>
                      <DropdownMenuItem onClick={() => requestPortalNavigation('/portal/career-profile', '내 프로필')}>
                        <User className="h-4 w-4" />
                        내 프로필
                      </DropdownMenuItem>
                      {isAdminSpaceRole(authUser?.role) && (
                        <DropdownMenuItem onClick={requestAdminNavigation}>
                          <Shield className="h-4 w-4" />
                          관리자 공간
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={handleLogout}>
                      <LogOut className="h-4 w-4" />
                      로그아웃
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            <div className="flex flex-col gap-3 px-4 py-3 md:px-6 lg:gap-0">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-[20px] font-semibold tracking-[-0.03em] text-slate-950">{currentSectionLabel}</p>
                      <Badge className="h-5 rounded-full bg-[#e8f0fb] px-2 text-[10px] font-semibold text-[#1b4f8f]">
                        {portalDisplayRole}
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  {projectOptions.length > 0 ? (
                    <Popover open={projectPickerOpen} onOpenChange={setProjectPickerOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          role="combobox"
                          data-testid="portal-header-project-search"
                          aria-expanded={projectPickerOpen}
                          className="h-10 min-w-[220px] justify-between rounded-xl border-slate-300 bg-white px-3 text-[12px] font-medium text-slate-900 shadow-sm"
                        >
                          <span className="truncate">{currentProjectName || '프로젝트 선택'}</span>
                          <Search className="h-4 w-4 text-slate-400" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="w-[var(--radix-popover-trigger-width)] p-0">
                        <Command shouldFilter={false}>
                          <CommandInput
                            value={projectSearch}
                            onValueChange={setProjectSearch}
                            placeholder="프로젝트명 또는 ID 검색"
                          />
                          <CommandList>
                            <CommandEmpty>일치하는 프로젝트가 없습니다.</CommandEmpty>
                            <CommandGroup heading="프로젝트">
                              {filteredProjectOptions.map((project) => (
                                <CommandItem
                                  key={project.id}
                                  value={project.id}
                                  onSelect={() => {
                                    setProjectPickerOpen(false);
                                    setProjectSearch('');
                                    if (project.id !== currentProject?.id) switchProjectInPlace(project.id);
                                  }}
                                >
                                  <span className="truncate">{project.name}</span>
                                  <span className="ml-auto text-[10px] text-slate-500">{project.id}</span>
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                  ) : (
                    <div className="flex h-10 items-center rounded-xl border border-slate-300 bg-white px-3 text-[12px] font-medium text-slate-900 shadow-sm">
                      {currentProjectName || '프로젝트 미선택'}
                    </div>
                  )}
                </div>
              </div>

              <div className="-mx-4 overflow-x-auto px-4 pb-1 pt-1 md:-mx-6 md:px-6">
                <nav className="flex min-w-max items-center gap-1">
                  {topNavItems.map((item) => {
                    const active = isActive(item.to, item.exact);
                    const badge = getBadge(item.to);
                    return (
                      <NavLink
                        key={item.to}
                        to={item.to}
                        end={item.exact}
                        data-testid={buildPortalNavTestId(item.to)}
                        onClick={(event) => {
                          event.preventDefault();
                          requestPortalNavigation(item.to, item.label);
                        }}
                        className={`group inline-flex h-10 items-center gap-2 rounded-t-xl border-b-2 px-3 text-[12px] font-medium transition-colors ${
                          active
                            ? 'border-[#1b6dff] text-[#1b4f8f]'
                            : 'border-transparent text-slate-600 hover:text-slate-900'
                        }`}
                      >
                        <item.icon className={`h-3.5 w-3.5 ${active ? 'text-[#1b6dff]' : 'text-slate-400 group-hover:text-slate-600'}`} />
                        <span className="whitespace-nowrap">
                          {item.label.replace('(주간)', '')}
                        </span>
                        {badge !== null && (
                          <span className="inline-flex min-w-[18px] items-center justify-center rounded-full bg-slate-100 px-1.5 text-[10px] font-semibold text-slate-700">
                            {badge}
                          </span>
                        )}
                      </NavLink>
                    );
                  })}
                </nav>
              </div>
            </div>
          </header>

          {/* Content */}
          <main className="flex-1 overflow-y-auto">
            <div className={useWidePortalCanvas ? 'w-full max-w-none px-5 py-2.5' : 'mx-auto w-full max-w-[1480px] px-5 py-2.5'}>
              <PageTransition>
                <ErrorBoundary homePath="/portal/project-select" resetKey={location.pathname}>
                  <Outlet />
                </ErrorBoundary>
              </PageTransition>
            </div>
          </main>
        </div>
        <CommandDialog
          open={commandOpen}
          onOpenChange={setCommandOpen}
          title="열기"
          description="업무 화면을 열거나 담당 프로젝트를 전환합니다."
        >
          <CommandInput placeholder="업무, 프로젝트, 화면 검색..." />
          <CommandList>
            <CommandEmpty>일치하는 프로젝트가 없습니다.</CommandEmpty>
            {workCommandItems.length > 0 && (
              <CommandGroup heading="업무 바로가기">
                {workCommandItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.description} ${item.keywords.join(' ')}`}
                    onSelect={() => {
                      setCommandOpen(false);
                      if (item.kind === 'portal') {
                        requestPortalNavigation(item.to, item.label);
                      }
                    }}
                    className="flex items-center gap-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[12px] font-medium text-slate-900">{item.label}</span>
                      <span className="text-[11px] text-slate-500">{item.description}</span>
                    </div>
                    <CommandShortcut>{item.category}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {workCommandItems.length > 0 && projectCommandItems.length > 0 && <CommandSeparator />}
            {projectCommandItems.length > 0 && (
              <CommandGroup heading="프로젝트 전환">
                {projectCommandItems.map((item) => (
                <CommandItem
                  key={item.id}
                  value={`${item.label} ${item.description} ${item.keywords.join(' ')}`}
                  onSelect={() => {
                    setCommandOpen(false);
                    if (item.kind === 'admin') {
                      requestAdminNavigation();
                      return;
                    }
                    if (item.kind === 'project' && item.projectId) {
                      switchProjectInPlace(item.projectId, item.to);
                      return;
                    }
                  }}
                  className="flex items-center gap-3"
                >
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[12px] font-medium text-slate-900">{item.label}</span>
                    <span className="text-[11px] text-slate-500">{item.description}</span>
                  </div>
                  <CommandShortcut>{item.category}</CommandShortcut>
                </CommandItem>
                ))}
              </CommandGroup>
            )}
            {projectCommandItems.length > 0 && adminCommandItems.length > 0 && <CommandSeparator />}
            {adminCommandItems.length > 0 && (
              <CommandGroup heading="관리">
                {adminCommandItems.map((item) => (
                  <CommandItem
                    key={item.id}
                    value={`${item.label} ${item.description} ${item.keywords.join(' ')}`}
                    onSelect={() => {
                      setCommandOpen(false);
                      if (item.kind === 'admin') requestAdminNavigation();
                    }}
                    className="flex items-center gap-3"
                  >
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="text-[12px] font-medium text-slate-900">{item.label}</span>
                      <span className="text-[11px] text-slate-500">{item.description}</span>
                    </div>
                    <CommandShortcut>{item.category}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </CommandDialog>
      </div>
      </TooltipProvider>
    </PortalNavigationGuardContext.Provider>
  );
}

export function PortalLayout() {
  return (
    <PortalProvider>
      <PortalContent />
    </PortalProvider>
  );
}
