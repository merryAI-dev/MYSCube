import { Navigate } from 'react-router';
import { useAuth } from '../../data/auth-store';
import { resolveActiveWorkspacePreference, resolveHomePath } from '../../platform/navigation';

export function MobileEntryPage() {
  const { isLoading, isAuthenticated, user } = useAuth();
  if (isLoading) return <div role="status" className="flex min-h-dvh items-center justify-center text-sm text-muted-foreground">홈 화면을 불러오는 중입니다…</div>;
  if (!isAuthenticated || !user) return <Navigate to="/login" replace state={{ from: '/' }} />;
  const workspace = resolveActiveWorkspacePreference(user.lastWorkspace, user.defaultWorkspace);
  return <Navigate to={resolveHomePath(user.role, workspace)} replace />;
}
