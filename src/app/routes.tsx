import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Navigate } from 'react-router';
import { AppLayout } from './components/layout/AppLayout';
import { PortalLayout } from './components/portal/PortalLayout';
import { AdminRouteProviders } from './data/admin-route-providers';
import { PortalRouteProviders } from './data/portal-route-providers';
import { loadLazyRouteModule } from './platform/lazy-route';
import { shouldUseBusinessCardMobileEntry } from './platform/mobile-entry';

function RouteChunkFallback() {
  return (
    <div className="flex min-h-[240px] items-center justify-center px-6 text-center text-sm text-muted-foreground">
      <div className="space-y-4">
        <p>새 버전이 배포되었습니다. 저장할 내용을 확인한 뒤 새 버전을 불러와 주세요.</p>
        <button
          type="button"
          className="inline-flex h-9 items-center justify-center rounded-md bg-slate-900 px-4 text-sm font-medium text-white hover:bg-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 focus-visible:ring-offset-2"
          onClick={() => window.location.reload()}
        >
          새 버전 불러오기
        </button>
      </div>
    </div>
  );
}

function lazyRoute<TModule extends Record<string, unknown>>(
  loader: () => Promise<TModule>,
  exportName: keyof TModule,
) {
  return lazy(() => loadLazyRouteModule(
    loader,
    exportName,
    RouteChunkFallback,
    `[routes] failed to load ${String(exportName)}:`,
  ));
}

// Lazy-loaded pages — each becomes a separate chunk
const LoginPage = lazyRoute(() => import('./components/auth/LoginPage'), 'LoginPage');
const McpAuthorizePage = lazyRoute(() => import('./components/auth/McpAuthorizePage'), 'McpAuthorizePage');
const WorkspaceSelectPage = lazyRoute(() => import('./components/auth/WorkspaceSelectPage'), 'WorkspaceSelectPage');
const PwaInstallPage = lazyRoute(() => import('./components/pwa/PwaInstallPage'), 'PwaInstallPage');
const MobileEntryPage = lazyRoute(() => import('./components/pwa/MobileEntryPage'), 'MobileEntryPage');
const FeatureSearchPage = lazyRoute(() => import('./components/dashboard/FeatureSearchPage'), 'FeatureSearchPage');
const DashboardPage = lazyRoute(() => import('./components/dashboard/DashboardPage'), 'DashboardPage');
const BoardFeedPage = lazyRoute(() => import('./components/board/BoardFeedPage'), 'BoardFeedPage');
const BoardPostPage = lazyRoute(() => import('./components/board/BoardPostPage'), 'BoardPostPage');
const ProjectListPage = lazyRoute(() => import('./components/projects/ProjectListPage'), 'ProjectListPage');
const ProjectAssigneeApprovalPage = lazyRoute(() => import('./components/projects/ProjectMigrationAuditPage'), 'ProjectAssigneeApprovalPage');
const ProjectCodeIssuancePage = lazyRoute(() => import('./components/projects/ProjectCodeIssuancePage'), 'ProjectCodeIssuancePage');
const ProjectDetailPage = lazyRoute(() => import('./components/projects/ProjectDetailPage'), 'ProjectDetailPage');
const ProjectWizardPage = lazyRoute(() => import('./components/projects/ProjectWizardPage'), 'ProjectWizardPage');
const ProjectRegisterRedirectPage = lazyRoute(() => import('./components/projects/ProjectRegisterRedirectPage'), 'ProjectRegisterRedirectPage');
const LedgerDetailPage = lazyRoute(() => import('./components/ledgers/LedgerDetailPage'), 'LedgerDetailPage');
const CashflowPage = lazyRoute(() => import('./components/cashflow/CashflowPage'), 'CashflowPage');
const CashflowWeeklyPage = lazyRoute(() => import('./components/cashflow/CashflowWeeklyPage'), 'CashflowWeeklyPage');
const CashflowAnalyticsPage = lazyRoute(() => import('./components/cashflow/CashflowAnalyticsPage'), 'CashflowAnalyticsPage');
const CashflowExportPage = lazyRoute(() => import('./components/cashflow/CashflowExportPage'), 'CashflowExportPage');
const CashflowPeriodPolicyPage = lazyRoute(() => import('./components/cashflow/CashflowPeriodPolicyPage'), 'CashflowPeriodPolicyPage');
const ProjectCashflowSheetPage = lazyRoute(() => import('./components/cashflow/ProjectCashflowSheetPage'), 'ProjectCashflowSheetPage');
const EvidenceQueuePage = lazyRoute(() => import('./components/evidence/EvidenceQueuePage'), 'EvidenceQueuePage');
const AuditLogPage = lazyRoute(() => import('./components/audit/AuditLogPage'), 'AuditLogPage');
const SettingsPage = lazyRoute(() => import('./components/settings/SettingsPage'), 'SettingsPage');
const ParticipationPage = lazyRoute(() => import('./components/participation/ParticipationPage'), 'ParticipationPage');
const PeopleDirectoryPage = lazyRoute(() => import('./components/people/PeopleDirectoryPage'), 'PeopleDirectoryPage');
const KoicaPersonnelPage = lazyRoute(() => import('./components/koica/KoicaPersonnelPage'), 'KoicaPersonnelPage');
const PersonnelChangePage = lazyRoute(() => import('./components/koica/PersonnelChangePage'), 'PersonnelChangePage');
const BudgetSummaryPage = lazyRoute(() => import('./components/budget/BudgetSummaryPage'), 'BudgetSummaryPage');
const ExpenseManagementPage = lazyRoute(() => import('./components/expense/ExpenseManagementPage'), 'ExpenseManagementPage');
const AdminApprovalPage = lazyRoute(() => import('./components/approval/AdminApprovalPage'), 'AdminApprovalPage');
const UserManagementPage = lazyRoute(() => import('./components/users/UserManagementPage'), 'UserManagementPage');
const AdminHrAnnouncementPage = lazyRoute(() => import('./components/hr/AdminHrAnnouncementPage'), 'AdminHrAnnouncementPage');
const AdminPayrollPage = lazyRoute(() => import('./components/payroll/AdminPayrollPage'), 'AdminPayrollPage');
const TrainingManagePage = lazyRoute(() => import('./components/training/TrainingManagePage'), 'TrainingManagePage');
const NotFoundPage = lazyRoute(() => import('./components/layout/NotFoundPage'), 'NotFoundPage');

// Portal pages
const PortalOnboarding = lazyRoute(() => import('./components/portal/PortalOnboarding'), 'PortalOnboarding');
const PortalProjectSelectPage = lazyRoute(() => import('./components/portal/PortalProjectSelectPage'), 'PortalProjectSelectPage');
const PortalBudget = lazyRoute(() => import('./components/portal/PortalBudget'), 'PortalBudget');
const PortalPersonnel = lazyRoute(() => import('./components/portal/PortalPersonnel'), 'PortalPersonnel');
const PortalChangeRequests = lazyRoute(() => import('./components/portal/PortalChangeRequests'), 'PortalChangeRequests');
const PortalProjectRegister = lazyRoute(() => import('./components/portal/PortalProjectRegister'), 'PortalProjectRegister');
const PortalProjectEdit = lazyRoute(() => import('./components/portal/PortalProjectEdit'), 'PortalProjectEdit');
const PortalProjectCheckout = lazyRoute(() => import('./components/portal/PortalProjectCheckout'), 'PortalProjectCheckout');
const PortalPayrollPage = lazyRoute(() => import('./components/portal/PortalPayrollPage'), 'PortalPayrollPage');
const PortalCashflowPage = lazyRoute(() => import('./components/portal/PortalCashflowPage'), 'PortalCashflowPage');
const CashflowSheetLabPage = lazyRoute(() => import('./features/cashflow-sheet-compare/CashflowSheetLabPage'), 'CashflowSheetLabPage');
const CareerProfilePage = lazyRoute(() => import('./components/portal/CareerProfilePage'), 'CareerProfilePage');
const PortalTrainingPage = lazyRoute(() => import('./components/portal/PortalTrainingPage'), 'PortalTrainingPage');
const PortalWeeklyExpensePage = lazyRoute(() => import('./components/portal/PortalWeeklyExpensePage'), 'PortalWeeklyExpensePage');
const GuideChatPage = lazyRoute(() => import('./components/guide-chat/GuideChatPage'), 'GuideChatPage');
const BusinessCardLabPage = lazyRoute(() => import('./components/business-cards/BusinessCardLabPage'), 'BusinessCardLabPage');

// Suspense wrapper — layouts already provide visual chrome, so a minimal fallback suffices
function S({ C }: { C: ComponentType }) {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-40 text-sm text-muted-foreground">로딩 중…</div>}>
      <C />
    </Suspense>
  );
}

function AdminRouteShell() {
  return <AdminRouteProviders><AppLayout /></AdminRouteProviders>;
}

function PortalRouteShell() {
  return <PortalRouteProviders><PortalLayout /></PortalRouteProviders>;
}

function MobileAwareAdminHome() {
  const useBusinessCardEntry = shouldUseBusinessCardMobileEntry({
    userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    viewportWidth: typeof window !== 'undefined' ? window.innerWidth : undefined,
    requestedPath: typeof window !== 'undefined' ? window.location.pathname : '/',
  });

  return useBusinessCardEntry
    ? <S C={BusinessCardLabPage} />
    : <S C={FeatureSearchPage} />;
}

export const router = createBrowserRouter([
  // ── Login ──
  { path: '/login', element: <S C={LoginPage} /> },
  { path: '/mcp/authorize', element: <S C={McpAuthorizePage} /> },
  { path: '/workspace-select', element: <S C={WorkspaceSelectPage} /> },
  { path: '/install', element: <S C={PwaInstallPage} /> },
  { path: '/install/ios', element: <S C={PwaInstallPage} /> },
  { path: '/install/android', element: <S C={PwaInstallPage} /> },
  { path: '/mobile-entry', element: <S C={MobileEntryPage} /> },
  // ── Admin (관리자) ──
  {
    path: '/',
    element: <AdminRouteShell />,
    children: [
      { index: true, element: <MobileAwareAdminHome /> },
      { path: 'dashboard', element: <S C={DashboardPage} /> },
      { path: 'business-cards', element: <S C={BusinessCardLabPage} /> },
      // ── Company Board (전사 게시판) ──
      {
        path: 'board',
        children: [
          { index: true, element: <S C={BoardFeedPage} /> },
          { path: ':postId', element: <S C={BoardPostPage} /> },
        ],
      },
      { path: 'projects', element: <S C={ProjectListPage} /> },
      { path: 'projects/migration-audit', element: <S C={AdminApprovalPage} /> },
      { path: 'management-planning/project-codes', element: <S C={ProjectCodeIssuancePage} /> },
      { path: 'projects/new', element: <S C={ProjectRegisterRedirectPage} /> },
      { path: 'projects/:projectId', element: <S C={ProjectDetailPage} /> },
      { path: 'projects/:projectId/edit', element: <S C={ProjectWizardPage} /> },
      { path: 'projects/:projectId/ledgers/:ledgerId', element: <S C={LedgerDetailPage} /> },
      { path: 'cashflow', element: <S C={CashflowPage} /> },
      { path: 'cashflow/weekly', element: <S C={CashflowWeeklyPage} /> },
      { path: 'cashflow/analytics', element: <S C={CashflowAnalyticsPage} /> },
      { path: 'cashflow/export', element: <S C={CashflowExportPage} /> },
      { path: 'axr', element: <Navigate to="/axr/cashflow-period-policy" replace /> },
      { path: 'axr/cashflow-period-policy', element: <S C={CashflowPeriodPolicyPage} /> },
      { path: 'cashflow/projects', element: <S C={CashflowPage} /> },
      { path: 'cashflow/projects/:projectId', element: <S C={ProjectCashflowSheetPage} /> },
      { path: 'evidence', element: <S C={EvidenceQueuePage} /> },
      { path: 'participation', element: <S C={ParticipationPage} /> },
      { path: 'people', element: <S C={PeopleDirectoryPage} /> },
      { path: 'koica-personnel', element: <S C={KoicaPersonnelPage} /> },
      { path: 'personnel-changes', element: <S C={PersonnelChangePage} /> },
      { path: 'budget-summary', element: <S C={BudgetSummaryPage} /> },
      { path: 'expense-management', element: <S C={ExpenseManagementPage} /> },
      { path: 'payroll', element: <S C={AdminPayrollPage} /> },
      { path: 'approvals', element: <S C={AdminApprovalPage} /> },
      { path: 'users', element: <S C={UserManagementPage} /> },
      { path: 'hr-announcements', element: <S C={AdminHrAnnouncementPage} /> },
      { path: 'training', element: <S C={TrainingManagePage} /> },
      { path: 'audit', element: <S C={AuditLogPage} /> },
      { path: 'settings', element: <S C={SettingsPage} /> },
      { path: '*', element: <S C={NotFoundPage} /> },
    ],
  },
  // ── Portal (사용자/PM 전용) ──
  {
    path: '/portal',
    element: <PortalRouteShell />,
    children: [
      { index: true, element: <S C={PortalProjectSelectPage} /> },
      // ── Company Board (전사 게시판) ──
      {
        path: 'board',
        children: [
          { index: true, element: <S C={BoardFeedPage} /> },
          { path: ':postId', element: <S C={BoardPostPage} /> },
        ],
      },
      { path: 'onboarding', element: <S C={PortalOnboarding} /> },
      { path: 'project-select', element: <S C={PortalProjectSelectPage} /> },
      { path: 'project-settings', element: <S C={PortalProjectSelectPage} /> },
      { path: 'submissions', element: <S C={PortalProjectSelectPage} /> },
      { path: 'payroll', element: <S C={PortalPayrollPage} /> },
      { path: 'cashflow', element: <S C={PortalCashflowPage} /> },
      { path: 'cashflow/sheets-lab', element: <S C={CashflowSheetLabPage} /> },
      { path: 'cashflow/:projectId', element: <S C={PortalCashflowPage} /> },
      { path: 'cashflow/:projectId/sheets-lab', element: <S C={CashflowSheetLabPage} /> },
      { path: 'budget', element: <S C={PortalBudget} /> },
      { path: 'weekly-expenses', element: <S C={PortalWeeklyExpensePage} /> },
      { path: 'personnel', element: <S C={PortalPersonnel} /> },
      { path: 'change-requests', element: <S C={PortalChangeRequests} /> },
      { path: 'project-approvals', element: <S C={ProjectAssigneeApprovalPage} /> },
      { path: 'register-project', element: <S C={PortalProjectRegister} /> },
      { path: 'register-project/:draftId', element: <S C={PortalProjectRegister} /> },
      { path: 'edit-project', element: <S C={PortalProjectEdit} /> },
      { path: 'edit-project/:projectId', element: <S C={PortalProjectEdit} /> },
      { path: 'project-checkout', element: <S C={PortalProjectCheckout} /> },
      { path: 'training', element: <S C={PortalTrainingPage} /> },
      { path: 'career-profile', element: <S C={CareerProfilePage} /> },
      { path: 'guide-chat', element: <S C={GuideChatPage} /> },
      { path: 'business-cards', element: <S C={BusinessCardLabPage} /> },
    ],
  },
]);
