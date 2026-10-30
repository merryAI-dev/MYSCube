import { Navigate } from 'react-router';
import { useAuth } from '../../data/auth-store';
import { OnboardingGuide } from './OnboardingGuide';
export function OnboardingGuidePage() {
  const { isLoading, isAuthenticated } = useAuth();
  if (isLoading) return <p role="status">로그인 상태를 확인하고 있어요</p>;
  if (!isAuthenticated) return <Navigate to="/login" replace state={{ from: '/guides/onboarding' }} />;
  return <OnboardingGuide />;
}
