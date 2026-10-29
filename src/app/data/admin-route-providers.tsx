import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import { BoardProvider } from './board-store';
import { CashflowWeekProvider } from './cashflow-weeks-store';
import { FirestoreRouteModeProvider } from './firestore-realtime-mode';
import { HrAnnouncementProvider } from './hr-announcements-store';
import { PayrollProvider } from './payroll-store';
import { TrainingProvider } from './training-store';

export function resolveAdminProviderScope(pathname: string) {
  const path = pathname.replace(/\/+$/, '') || '/';
  const isDashboard = path === '/dashboard';
  return {
    hrAnnouncements: isDashboard || path.startsWith('/hr-announcements'),
    payroll: isDashboard || path.startsWith('/payroll'),
    cashflowWeeks: isDashboard || path.startsWith('/payroll') || (path.startsWith('/cashflow') && path !== '/cashflow/export'),
    board: path.startsWith('/board'),
    training: path.startsWith('/training'),
  };
}

export function isCashflowOverviewRoute(pathname: string) {
  const path = pathname.replace(/\/+$/, '') || '/';
  return path === '/cashflow' || path === '/cashflow/weekly' || path === '/cashflow/projects';
}

export function AdminRouteProviderFrame({ children, pathname }: { children: ReactNode; pathname: string }) {
  const scope = resolveAdminProviderScope(pathname);
  let tree = children;
  if (scope.training) tree = <TrainingProvider>{tree}</TrainingProvider>;
  if (scope.board) tree = <BoardProvider>{tree}</BoardProvider>;
  if (scope.cashflowWeeks) tree = <CashflowWeekProvider loadWeeks={!isCashflowOverviewRoute(pathname)}>{tree}</CashflowWeekProvider>;
  if (scope.payroll) tree = <PayrollProvider>{tree}</PayrollProvider>;
  if (scope.hrAnnouncements) tree = <HrAnnouncementProvider>{tree}</HrAnnouncementProvider>;
  return <FirestoreRouteModeProvider mode="admin-live">{tree}</FirestoreRouteModeProvider>;
}

export function AdminRouteProviders({ children }: { children: ReactNode }) {
  const location = useLocation();
  return <AdminRouteProviderFrame pathname={location.pathname}>{children}</AdminRouteProviderFrame>;
}
