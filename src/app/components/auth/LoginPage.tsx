import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import {
  ArrowRight,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Card, CardContent } from '../ui/card';
import { Button } from '../ui/button';
import { useAuth } from '../../data/auth-store';
import {
  resolveActiveWorkspacePreference,
  resolveLoginSuccessPath,
  resolveRequestedRedirectPath,
} from '../../platform/navigation';
import { readFirebaseEmulatorConfig } from '../../lib/firebase';
import {
  buildPreviewAuthFallbackUrl,
  buildPreviewAuthBlockedMessage,
  readPreviewAuthGuardConfig,
  shouldBlockFirebasePopupAuth,
} from '../../platform/preview-auth';
import { readDevAuthHarnessConfig } from '../../platform/dev-harness';
import { MyscWordmark } from '../brand/MyscWordmark';

// ═══════════════════════════════════════════════════════════════
// LoginPage — 통합 로그인 페이지
// 로그인 후 전용 기능 검색 엔트리로 부드럽게 라우팅
// ═══════════════════════════════════════════════════════════════

const POST_LOGIN_TRANSITION_MS = 700;

function PostLoginTransition({ displayName }: { displayName: string }) {
  return (
    <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-[linear-gradient(135deg,#eaf4ff_0%,#f8fbff_45%,#eafaf4_100%)] px-4 py-6 dark:bg-[linear-gradient(135deg,#05182d_0%,#0f172a_52%,#062d2a_100%)]">
      <div className="absolute inset-0 bg-white/20 backdrop-blur-3xl dark:bg-slate-950/10" />
      <div className="relative w-full max-w-[520px] animate-in fade-in-0 zoom-in-95 duration-700">
        <section className="overflow-hidden rounded-lg border border-white/65 bg-white/55 shadow-[0_30px_90px_rgba(15,23,42,0.14)] backdrop-blur-2xl dark:border-white/10 dark:bg-slate-950/45">
          <div className="border-b border-white/20 bg-[#0f2747]/90 px-6 py-5 text-white shadow-inner shadow-white/5">
            <MyscWordmark tone="onDark" size="md" />
          </div>
          <div className="space-y-6 px-6 py-8 text-center">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg border border-sky-200/80 bg-sky-50/80 text-sky-800 shadow-lg shadow-sky-900/10 backdrop-blur-md dark:border-sky-400/20 dark:bg-sky-950/40 dark:text-sky-200">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
            <div>
              <p className="text-[12px] font-semibold uppercase tracking-[0.12em] text-sky-700 dark:text-sky-300">
                Login Complete
              </p>
              <h1 className="mt-2 text-[24px] font-extrabold leading-tight text-slate-950 dark:text-slate-50 md:text-[30px]">
                {displayName}님, 시작 화면을 준비하고 있습니다
              </h1>
              <p className="mt-3 text-[13px] leading-6 text-slate-600 dark:text-slate-300">
                현재 기기와 요청한 링크에 맞는 진입 화면을 여는 중입니다.
              </p>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-200/80 dark:bg-slate-800/80">
              <div className="h-full w-2/3 animate-pulse rounded-full bg-[linear-gradient(90deg,#0369a1,#059669)]" />
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    loginWithGoogle,
    loginWithDevHarness,
    isLoading,
    isAuthenticated,
    isFirebaseAuthEnabled,
    user,
  } = useAuth();
  const [error, setError] = useState('');
  const redirectFrom = resolveRequestedRedirectPath(
    (location.state as { from?: string } | null)?.from,
    location.search,
  );
  const emulatorConfig = readFirebaseEmulatorConfig(import.meta.env);
  const previewAuthConfig = readPreviewAuthGuardConfig(import.meta.env);
  const currentHost = typeof window !== 'undefined' ? window.location.hostname : '';
  const devAuthHarness = readDevAuthHarnessConfig(import.meta.env, typeof window !== 'undefined' ? window.location : undefined);
  const loginBlockedOnPreview = shouldBlockFirebasePopupAuth(currentHost, import.meta.env);
  const previewBlockMessage = loginBlockedOnPreview
    ? buildPreviewAuthBlockedMessage(currentHost, import.meta.env)
    : '';
  const activeWorkspace = resolveActiveWorkspacePreference(user?.lastWorkspace, user?.defaultWorkspace);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (emulatorConfig.authEnabled) return;

    const { hostname, protocol, port, pathname, search, hash } = window.location;
    if (!['127.0.0.1', '0.0.0.0', '::1', '[::1]'].includes(hostname)) return;

    const target = `${protocol}//localhost${port ? `:${port}` : ''}${pathname}${search}${hash}`;
    window.location.replace(target);
  }, [emulatorConfig.authEnabled]);

  // 이미 인증된 사용자는 전환 화면을 거쳐 기능 검색 엔트리로 이동
  useEffect(() => {
    if (isLoading) return;
    if (isAuthenticated && user) {
      const target = resolveLoginSuccessPath(
        user.role,
        activeWorkspace,
        redirectFrom,
      );
      const timer = window.setTimeout(() => {
        navigate(target, { replace: true });
      }, POST_LOGIN_TRANSITION_MS);
      return () => window.clearTimeout(timer);
    }
  }, [activeWorkspace, isAuthenticated, isLoading, navigate, redirectFrom, user]);

  if (isAuthenticated && user) {
    return <PostLoginTransition displayName={user.name?.trim() || '구성원'} />;
  }

  const handleLogin = async () => {
    setError('');
    const result = await loginWithGoogle();
    if (!result.success) {
      setError(result.error || 'Google 로그인에 실패했습니다.');
    }
  };

  const handleDevHarnessLogin = async (preset: 'pm' | 'admin') => {
    setError('');
    const result = await loginWithDevHarness(preset);
    if (!result.success) {
      setError(result.error || '개발용 로그인에 실패했습니다.');
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-[linear-gradient(180deg,#f8fafc_0%,#f3f7fb_58%,#eef6f9_100%)] p-4 dark:bg-[linear-gradient(180deg,#07111f_0%,#0b1727_58%,#0b2530_100%)]">
      <div className="w-full max-w-[420px]">
        {/* ── Brand Header ── */}
        <div className="text-center mb-8">
          <MyscWordmark tone="light" size="lg" className="mb-4 justify-center" />
          <h1 className="text-[22px] text-foreground mb-1" style={{ fontWeight: 800, letterSpacing: '-0.03em' }}>
            프로젝트 운영 플랫폼
          </h1>
          <p className="text-[13px] text-muted-foreground">
            통합 플랫폼에 로그인하세요
          </p>
        </div>

        {/* ── Login Form ── */}
        <Card className="border-border/80 shadow-lg shadow-slate-900/6 dark:shadow-black/20">
          <CardContent className="p-6">
            <div className="space-y-4">
              {!isFirebaseAuthEnabled && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200/60 text-amber-700 text-[12px]">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>Firebase Auth가 비활성화되어 있습니다. 환경 설정을 확인해 주세요.</span>
                </div>
              )}

              {loginBlockedOnPreview && (
                <div className="rounded-lg border border-amber-200/60 bg-amber-50 p-3 text-[12px] text-amber-800">
                  <div className="flex items-start gap-2">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <div className="space-y-2">
                      <p>{previewBlockMessage}</p>
                      {previewAuthConfig.fallbackUrl ? (
                        <div className="flex flex-wrap items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            className="h-8 border-amber-300 bg-white px-3 text-[11px] text-amber-900 hover:bg-amber-100"
                            onClick={() => window.location.assign(buildPreviewAuthFallbackUrl(previewAuthConfig.fallbackUrl, redirectFrom))}
                          >
                            고정 preview로 이동
                          </Button>
                          <span className="break-all text-[10px] text-amber-700/90">
                            {previewAuthConfig.fallbackUrl}
                          </span>
                        </div>
                      ) : (
                        <p className="text-[11px] text-amber-700/90">
                          `VITE_FIREBASE_AUTH_FALLBACK_URL`을 설정하면 여기서 바로 고정 preview 주소로 이동할 수 있습니다.
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}

              {error && (
                <div className="flex items-center gap-2 p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-800/40 text-rose-700 dark:text-rose-300 text-[12px]">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{error}</span>
                </div>
              )}

              <Button
                type="button"
                className="w-full h-11 text-[13px] gap-2"
                disabled={isLoading || !isFirebaseAuthEnabled || loginBlockedOnPreview}
                onClick={() => handleLogin()}
                style={{ background: 'linear-gradient(135deg, #0891b2, #0f766e)' }}
              >
                {isLoading ? (
                  <><Loader2 className="w-4 h-4 animate-spin" /> Google 인증 중...</>
                ) : (
                  <>Google 계정으로 로그인 <ArrowRight className="w-4 h-4" /></>
                )}
              </Button>

              <p className="text-[11px] text-muted-foreground text-center">
                `mysc.co.kr` 계정만 로그인할 수 있습니다.
              </p>

              {devAuthHarness.enabled && (
                <div className="rounded-lg border border-sky-200/60 bg-sky-50 p-3">
                  <p className="text-[11px] font-medium text-sky-900">로컬 개발용 인증 harness</p>
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 border-sky-300 bg-white text-[12px] text-sky-900 hover:bg-sky-100"
                      onClick={() => void handleDevHarnessLogin('pm')}
                    >
                      PM 샘플 로그인
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      className="h-9 border-sky-300 bg-white text-[12px] text-sky-900 hover:bg-sky-100"
                      onClick={() => void handleDevHarnessLogin('admin')}
                    >
                      관리자 샘플 로그인
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        {/* Footer */}
        <p className="text-center text-[10px] text-muted-foreground/60 mt-6">
          MYSC 사업관리통합플랫폼 v1.0
        </p>
      </div>
    </div>
  );
}
