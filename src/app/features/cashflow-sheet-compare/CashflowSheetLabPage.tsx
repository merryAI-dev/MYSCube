import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, CheckCircle2, Copy, HelpCircle, Loader2, RefreshCw, Save, UserPlus } from 'lucide-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useAuth } from '../../data/auth-store';
import { usePortalStore } from '../../data/portal-store';
import { CASHFLOW_SHEET_LINE_LABELS, type CashflowSheetLineId } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';
import { getAuthInstance } from '../../lib/firebase';
import {
  extractSpreadsheetIdFromSheetInput,
  applyCashflowSheetLabViaBff,
  cashflowFormulaMismatchesFromError,
  isCashflowSheetApplyResultUncertain,
  getCashflowSheetLabApplyStatusViaBff,
  getCashflowSheetLabShareAccountViaBff,
  refreshCashflowSheetLabMirrorViaBff,
  saveCashflowSheetLabConfigViaBff,
  stageCashflowSheetLabViaBff,
  type CashflowSheetLabShareAccountResult,
  type CashflowSheetLabMirrorResult,
  type CashflowSheetLabStageResult,
  type CashflowFormulaMismatch,
  cashflowSheetErrorPhase,
} from '../../lib/sheets-cashflow-readonly-client';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '../../components/ui/tooltip';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog';
import { rememberRecentPortalProject } from '../../platform/portal-recent-projects';
import { recordDevtoolsLog } from '../../platform/devtools-transaction-log';
import { resolveApiErrorPresentation } from '../../platform/api-error-messages';
import { describeApiError, formatApiErrorDescription } from '../../platform/api-error-message';
import { PlatformApiError } from '../../platform/api-client';
import { resolvePortalProjectContextSync, resolvePortalProjectResourcePath } from '../../platform/portal-project-selection';
import { CashflowSheetSyncOverlay, type CashflowSheetSyncOperation } from '../../components/cashflow/CashflowSheetSyncOverlay';
import { CashflowFormulaMismatchDialog } from '../../components/cashflow/CashflowFormulaMismatchDialog';
import { shouldApplyCashflowSheetLabProjectResult } from './cashflow-sheet-lab-project-scope';

function formatError(error: unknown, phase = '') {
  const apiError = error as { body?: { code?: string; error?: string; message?: string; statusCode?: number }; requestId?: string; status?: number };
  const code = getErrorCode(error);
  if (code === 'google_sheets_not_configured') {
    return '서버의 Google Sheets 서비스 계정이 설정되지 않았습니다. 관리자에게 환경 변수 설정을 요청하세요.';
  }
  if (code === 'google_sheet_service_account_forbidden') {
    return '시트를 시스템 계정에 공유해 주세요. 공유 후 다시 연동하면 됩니다.';
  }
  // 서버가 사람에게 쓴 문구를 그대로 보여 주고, 단계와 문의용 코드를 붙인다.
  if (error instanceof PlatformApiError) {
    return formatApiErrorDescription(describeApiError(error, { fallback: '시트 구조를 확인하지 못했습니다.', phase }));
  }
  const bodyMessage = apiError?.body?.message;
  if (code) {
    const presentation = resolveApiErrorPresentation(
      code,
      Number(apiError.status || apiError.body?.statusCode || 0),
    );
    return `${presentation.guide}${apiError.requestId ? ` (요청 ID: ${apiError.requestId})` : ''}`;
  }
  if (bodyMessage) {
    return bodyMessage;
  }
  if (error instanceof Error) return error.message;
  return '시트 구조를 확인하지 못했습니다.';
}

function getErrorCode(error: unknown) {
  const apiError = error as { code?: string; body?: { code?: string; error?: string } };
  return apiError?.code || apiError?.body?.code || apiError?.body?.error || '';
}

function getClosedMonthDifferences(error: unknown) {
  const apiError = error as {
    body?: { details?: { closedMonthDifferences?: CashflowSheetLabStageResult['closedMonthDifferences'] } };
  };
  return apiError.body?.details?.closedMonthDifferences || [];
}

function logCashflowLab(event: string, details: Record<string, unknown>, level: 'info' | 'warn' = 'info') {
  recordDevtoolsLog({
    kind: 'cashflow_transaction',
    phase: level === 'warn' ? 'error' : 'info',
    operation: `cashflow.sheet_lab.${event}`,
    transport: 'bff',
    projectId: typeof details.projectId === 'string' ? details.projectId : undefined,
    durationMs: typeof details.durationMs === 'number' ? details.durationMs : undefined,
    summary: details,
  });
}

function errorDiagnostics(error: unknown) {
  const apiError = error as { body?: { code?: string; error?: string; message?: string }; requestId?: string; status?: number; message?: string };
  return {
    status: apiError?.status || null,
    code: apiError?.body?.code || apiError?.body?.error || null,
    message: apiError?.body?.message || apiError?.message || 'Unknown error',
    requestId: apiError?.requestId || null,
  };
}

function isBffAuthError(error: unknown): boolean {
  const apiError = error as { status?: number; body?: { code?: unknown; error?: unknown } };
  const status = apiError?.status;
  const code = typeof apiError?.body?.code === 'string'
    ? apiError.body.code
    : typeof apiError?.body?.error === 'string'
      ? apiError.body.error
      : '';
  if (code === 'google_sheets_api_error') return false;
  return status === 401 || status === 403 || code === 'missing_bearer_token' || code === 'invalid_token';
}

function buildSourceKey({
  projectId,
  sourceYear,
  value,
  sheetName,
}: {
  projectId: string;
  sourceYear: number;
  value: string;
  sheetName: string;
}) {
  return JSON.stringify({
    projectId: projectId.trim(),
    sourceYear,
    value: value.trim(),
    sheetName: sheetName.trim(),
  });
}

function HelpMemo({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="inline-flex h-6 w-6 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-slate-100 hover:text-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
          aria-label="도움말"
        >
          <HelpCircle className="h-3.5 w-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[260px] bg-slate-950 text-[11px] leading-relaxed text-white">
        {children}
      </TooltipContent>
    </Tooltip>
  );
}

export function CashflowSheetLabPage() {
  const { user: authUser, loginWithGoogle } = useAuth();
  const { activeProjectId, myProject } = usePortalStore();
  const { orgId } = useFirebase();
  const { projectId: routeProjectIdParam } = useParams<{ projectId: string }>();
  const routeProjectId = routeProjectIdParam?.trim() || '';
  const location = useLocation();
  const navigate = useNavigate();
  const portalProjectId = activeProjectId || myProject?.id || '';
  const projectYears = useMemo(() => {
    const startYear = /^\d{4}-/.test(myProject?.contractStart || '') ? Number(myProject?.contractStart.slice(0, 4)) : Number.NaN;
    const endYear = /^\d{4}-/.test(myProject?.contractEnd || '') ? Number(myProject?.contractEnd.slice(0, 4)) : Number.NaN;
    if (Number.isSafeInteger(startYear) && Number.isSafeInteger(endYear) && startYear <= endYear) {
      return Array.from({ length: endYear - startYear + 1 }, (_, index) => startYear + index);
    }
    const financialYears = (myProject?.financialYears || []).map((row) => row.year).filter(Number.isSafeInteger);
    return financialYears.length > 0 ? financialYears : [2026];
  }, [myProject?.contractEnd, myProject?.contractStart, myProject?.financialYears]);
  const [sourceYear, setSourceYear] = useState(() => (
    projectYears.includes(2026) ? 2026 : projectYears[0] || 2026
  ));
  const [sheetLink, setSheetLink] = useState('');
  const [sheetName, setSheetName] = useState('cashflow(사용내역 연동)');
  const [mirror, setMirror] = useState<CashflowSheetLabMirrorResult | null>(null);
  const [reviewedSourceKey, setReviewedSourceKey] = useState('');
  const [savedConfig, setSavedConfig] = useState<CashflowSheetLabShareAccountResult['config']>(null);
  const [savedConfigs, setSavedConfigs] = useState<NonNullable<CashflowSheetLabShareAccountResult['config']>[]>([]);
  const [systemAccountEmail, setSystemAccountEmail] = useState('');
  const [reflectResult, setReflectResult] = useState<{
    appliedLineCount: number;
    projectionLineCount: number;
    actualLineCount: number;
    skippedRiskLineCount?: number;
    lastAppliedAt?: string;
  } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [closedMonthWarning, setClosedMonthWarning] = useState<NonNullable<CashflowSheetLabStageResult['closedMonthDifferences']>>([]);
  const [closedMonthStage, setClosedMonthStage] = useState<CashflowSheetLabStageResult | null>(null);
  const closedMonthChangeRows = closedMonthWarning.flatMap((month) => month.changes || []);
  const closedMonthManifestComplete = Boolean(closedMonthStage?.closedMonthDifferenceManifestHash)
    && closedMonthStage?.closedMonthDifferenceCount === closedMonthChangeRows.length
    && closedMonthWarning.every((month) => !month.truncatedChangeCount);
  const [applyResumeRequired, setApplyResumeRequired] = useState(false);
  const [applyStatusState, setApplyStatusState] = useState<'checking' | 'ready' | 'error'>('checking');
  const [applyStatusRetry, setApplyStatusRetry] = useState(0);
  const [closedMonthChangeReason, setClosedMonthChangeReason] = useState('');
  const [closedMonthFormulaAccepted, setClosedMonthFormulaAccepted] = useState(false);
  const [closedMonthPendingApprovalAccepted, setClosedMonthPendingApprovalAccepted] = useState(false);
  const [pendingApprovalStage, setPendingApprovalStage] = useState<CashflowSheetLabStageResult | null>(null);
  const [pendingApprovalClosedMonthChangeReason, setPendingApprovalClosedMonthChangeReason] = useState('');
  const [pendingApprovalFormulaAccepted, setPendingApprovalFormulaAccepted] = useState(false);
  const pendingApprovalDifferences = pendingApprovalStage?.pendingApprovalDifferences || [];
  const pendingApprovalChangeRows = pendingApprovalDifferences.flatMap((month) => month.changes || []);
  const pendingApprovalManifestComplete = Boolean(pendingApprovalStage?.pendingApprovalDifferenceManifestHash)
    && pendingApprovalStage?.pendingApprovalDifferenceCount === pendingApprovalChangeRows.length
    && pendingApprovalDifferences.every((month) => !month.truncatedChangeCount);
  const [formulaMismatchPrompt, setFormulaMismatchPrompt] = useState<{
    stage: CashflowSheetLabStageResult;
    issues: CashflowFormulaMismatch[];
    closedMonthChangeReason: string;
    acceptPendingApprovalDifferences: boolean;
  } | null>(null);
  const [loadingOperation, setLoadingOperation] = useState<CashflowSheetSyncOperation | null>(null);
  const loading = loadingOperation !== null;
  const [accountLoading, setAccountLoading] = useState(false);
  const configLoadGenerationRef = useRef(0);
  const sheetOperationGenerationRef = useRef(0);
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const projectContextSync = resolvePortalProjectContextSync({
    routeProjectId,
    sessionProjectId: portalProjectId,
    currentPath,
  });
  const projectId = projectContextSync.projectId;
  const selectedProjectIdRef = useRef(projectId);
  const selectedSourceYearRef = useRef(sourceYear);
  selectedProjectIdRef.current = projectId;
  selectedSourceYearRef.current = sourceYear;
  const projectContextAction = projectContextSync.action;
  const projectContextPath = projectContextSync.path;
  const spreadsheetId = useMemo(() => extractSpreadsheetIdFromSheetInput(sheetLink), [sheetLink]);
  const hasSheetDraft = Boolean(sheetLink.trim() || sheetName.trim());
  const sourceKey = useMemo(() => buildSourceKey({
    projectId,
    sourceYear,
    value: sheetLink,
    sheetName,
  }), [projectId, sheetLink, sheetName, sourceYear]);
  const savedConfigSourceKey = useMemo(() => (
    savedConfig?.value
      ? buildSourceKey({
          projectId,
          sourceYear,
          value: savedConfig.value,
          sheetName: savedConfig.sheetName || '',
        })
      : ''
  ), [projectId, savedConfig, sourceYear]);
  const actor = useMemo(() => ({
    uid: authUser?.uid || 'workspace-user',
    email: authUser?.email || '',
    role: authUser?.role || 'workspace_user',
    idToken: authUser?.idToken,
  }), [
    authUser?.uid,
    authUser?.email,
    authUser?.role,
    authUser?.idToken,
  ]);
  const requestLoginFlow = useCallback(async () => {
    logCashflowLab('auth.popup.start', {
      projectId,
      actorEmail: actor.email,
      hasIdToken: Boolean(actor.idToken),
    }, 'warn');
    const result = await loginWithGoogle();
    if (selectedProjectIdRef.current !== projectId) return false;
    if (!result.success) {
      logCashflowLab('auth.popup.error', {
        projectId,
        actorEmail: actor.email,
        error: result.error || 'Google OAuth popup failed',
      }, 'warn');
      setErrorMessage(result.error || 'Google 계정 권한을 확인하지 못했습니다.');
      return false;
    }
    logCashflowLab('auth.popup.ok', {
      projectId,
      actorEmail: actor.email,
    });
    return true;
  }, [actor.email, actor.idToken, loginWithGoogle, projectId]);

  const resolveBffActor = useCallback(async (options: { forceRefresh?: boolean } = {}) => {
    const firebaseAuthUser = getAuthInstance()?.currentUser;
    const firebaseToken = await firebaseAuthUser?.getIdToken(Boolean(options.forceRefresh)).catch((error) => {
      logCashflowLab('auth.token.resolve.error', {
        projectId,
        actorEmail: actor.email,
        forceRefresh: Boolean(options.forceRefresh),
        message: error instanceof Error ? error.message : String(error),
      }, 'warn');
      return undefined;
    });
    const resolvedToken = firebaseToken || actor.idToken;
    if (!resolvedToken) return null;
    if (firebaseToken || options.forceRefresh) {
      logCashflowLab('auth.token.resolve', {
        projectId,
        actorEmail: actor.email,
        tokenSource: firebaseToken ? 'firebase' : 'store',
        forceRefresh: Boolean(options.forceRefresh),
      });
    }
    return {
      ...actor,
      idToken: resolvedToken,
    };
  }, [actor, projectId]);

  const requestBffActorAfterAuth = useCallback(async (action: string) => {
    logCashflowLab(`${action}.bffAuth.popup.required`, {
      projectId,
      actorEmail: actor.email,
      hasStoredToken: Boolean(actor.idToken),
    }, 'warn');
    const popupOk = await requestLoginFlow();
    if (!popupOk) return null;
    const resolved = await resolveBffActor({ forceRefresh: true });
    if (selectedProjectIdRef.current !== projectId) return null;
    if (!resolved?.idToken) {
      logCashflowLab(`${action}.bffAuth.token_missing`, { projectId }, 'warn');
      setErrorMessage('Google 로그인 후에도 서버 인증 토큰을 확인하지 못했습니다. 다시 시도해 주세요.');
      return null;
    }
    return resolved;
  }, [actor.email, actor.idToken, projectId, requestLoginFlow, resolveBffActor]);

  const requireBffActor = useCallback(async () => {
    let resolved = await resolveBffActor();
    if (!resolved?.idToken) {
      resolved = await requestBffActorAfterAuth('auth.required');
    }
    return resolved;
  }, [requestBffActorAfterAuth, resolveBffActor]);

  async function runWithBffAuthRetry<T>(
    action: string,
    operation: (requestActor: typeof actor) => Promise<T>,
  ): Promise<T | null> {
    const requestActor = await requireBffActor();
    if (!requestActor) return null;
    try {
      return await operation(requestActor);
    } catch (error) {
      if (!isBffAuthError(error)) {
        throw error;
      }
      logCashflowLab(`${action}.bffAuth.rejected`, {
        projectId,
        ...errorDiagnostics(error),
      }, 'warn');
      const retryActor = await requestBffActorAfterAuth(action);
      if (!retryActor) {
        throw error;
      }
      return operation(retryActor);
    }
  }

  // URL route projectId와 상단 선택 프로젝트를 항상 한 프로젝트로 맞춘다.
  useEffect(() => {
    if (projectContextAction === 'canonicalize-path') {
      if (projectContextPath && projectContextPath !== currentPath) {
        navigate(projectContextPath, { replace: true });
      }
    }
  }, [currentPath, navigate, projectContextAction, projectContextPath]);

  useEffect(() => {
    if (!projectId) return;
    rememberRecentPortalProject(projectId);
  }, [projectId]);

  // 프로젝트가 바뀌면 이전 프로젝트의 반영 복구 상태를 새 프로젝트로 이어받지 않는다.
  useEffect(() => {
    setClosedMonthStage(null);
    setClosedMonthWarning([]);
    setClosedMonthChangeReason('');
    setClosedMonthFormulaAccepted(false);
    setClosedMonthPendingApprovalAccepted(false);
    setPendingApprovalStage(null);
    setPendingApprovalClosedMonthChangeReason('');
    setPendingApprovalFormulaAccepted(false);
    setFormulaMismatchPrompt(null);
    setApplyResumeRequired(false);
    setApplyStatusState('checking');
  }, [projectId]);

  useEffect(() => {
    let cancelled = false;
    if (!projectId || !actor.idToken) return () => { cancelled = true; };
    setApplyStatusState('checking');
    const loadApplyStatus = async (): Promise<void> => {
      try {
        const result = await runWithBffAuthRetry('apply.status', (requestActor) => (
          getCashflowSheetLabApplyStatusViaBff({
            tenantId: orgId,
            actor: requestActor,
            projectId,
          })
        ));
        if (cancelled) return;
        if (!result) {
          setApplyStatusState('error');
          setErrorMessage('기존 시트 반영 상태를 확인하지 못했습니다. 다시 확인해 주세요.');
          return;
        }
        setApplyStatusState('ready');
        if (result?.status !== 'APPLYING' || !result.stagedRun) return;
        setClosedMonthStage(result.stagedRun);
        setClosedMonthWarning(result.stagedRun.closedMonthDifferences || []);
        setClosedMonthChangeReason(result.applyInput?.closedMonthChangeReason || '');
        setClosedMonthFormulaAccepted(result.applyInput?.acceptFormulaMismatches === true);
        setClosedMonthPendingApprovalAccepted(result.applyInput?.acceptPendingApprovalDifferences === true);
        setApplyResumeRequired(true);
        setErrorMessage('이전 시트 반영이 아직 완료 상태로 확인되지 않았습니다. 반영 상태를 확인해 주세요.');
      } catch (error) {
        if (cancelled) return;
        setApplyStatusState('error');
        setErrorMessage(`기존 시트 반영 상태를 확인하지 못했습니다. ${formatError(error)}`);
      }
    };
    void loadApplyStatus();
    return () => {
      cancelled = true;
    };
  }, [actor.idToken, applyStatusRetry, orgId, projectId]);

  useEffect(() => {
    if (projectYears.includes(sourceYear)) return;
    setSourceYear(projectYears[0] || 2026);
  }, [projectYears, sourceYear]);

  function handleSourceYearChange(nextYear: number) {
    const nextConfig = savedConfigs.find((config) => config.sourceYear === nextYear) || null;
    selectedSourceYearRef.current = nextYear;
    setSourceYear(nextYear);
    setSavedConfig(nextConfig);
    setSheetLink(nextConfig?.value || '');
    setSheetName(nextConfig?.sheetName || 'cashflow(사용내역 연동)');
    setReviewedSourceKey('');
    setReflectResult(null);
    setStatusMessage('');
    setErrorMessage('');
  }

  async function handleLoadShareAccount({ forceHydrate = false } = {}) {
    if (!projectId) return;
    const requestedProjectId = projectId;
    const requestedSourceYear = sourceYear;
    const generation = ++configLoadGenerationRef.current;
    const isCurrentRequest = () => shouldApplyCashflowSheetLabProjectResult({
      requestGeneration: generation,
      currentGeneration: configLoadGenerationRef.current,
      requestedProjectId,
      selectedProjectId: selectedProjectIdRef.current,
      requestedSourceYear,
      selectedSourceYear: selectedSourceYearRef.current,
    });
    setAccountLoading(true);
    setStatusMessage('');
    try {
      const result = await runWithBffAuthRetry('share_account.load', async (requestActor) => {
        if (!isCurrentRequest()) return null;
        return getCashflowSheetLabShareAccountViaBff({
          tenantId: orgId,
          actor: requestActor,
          projectId: requestedProjectId,
          sourceYear: requestedSourceYear,
        });
      });
      if (!result || !isCurrentRequest()) return;
      const email = result.systemAccountEmail || result.accessPolicy?.serviceAccountEmail || '';
      if (!email) {
        setErrorMessage('서버의 Google Sheets 서비스 계정 이메일을 확인하지 못했습니다.');
        return;
      }
      setSystemAccountEmail(email);
      const configs = Array.isArray(result.configs) ? result.configs : [];
      const scopedConfig = configs.find((config) => config.sourceYear === requestedSourceYear)
        || (result.config?.sourceYear === requestedSourceYear ? result.config : null);
      setSavedConfig(scopedConfig);
      setSavedConfigs(configs);
      if (scopedConfig?.value && (forceHydrate || !hasSheetDraft || scopedConfig.sourceYear !== savedConfig?.sourceYear)) {
        setSheetLink(scopedConfig.value);
        setSheetName(scopedConfig.sheetName || 'cashflow(사용내역 연동)');
      }
      if (!scopedConfig?.value) setStatusMessage('공유 계정을 확인했습니다.');
      logCashflowLab('share_account.load.ok', {
        projectId: requestedProjectId,
        hasSystemAccountEmail: true,
      });
    } catch (error) {
      if (isCurrentRequest()) {
        logCashflowLab('share_account.load.error', { projectId: requestedProjectId, ...errorDiagnostics(error) }, 'warn');
      }
      if (isCurrentRequest()) setErrorMessage(formatError(error));
    } finally {
      if (isCurrentRequest()) setAccountLoading(false);
    }
  }

  // 프로젝트나 연동 연도가 바뀌면 이전 시트 draft를 남기지 않는다.
  useEffect(() => {
    configLoadGenerationRef.current += 1;
    sheetOperationGenerationRef.current += 1;
    setLoadingOperation(null);
    setAccountLoading(false);
    setSavedConfig(null);
    setSavedConfigs([]);
    setSheetLink('');
    setSheetName('cashflow(사용내역 연동)');
    setMirror(null);
    setReviewedSourceKey('');
    setReflectResult(null);
    setStatusMessage('');
    setErrorMessage('');
  }, [projectId, sourceYear]);

  useEffect(() => {
    if (!projectId || !actor.idToken) return;
    void handleLoadShareAccount({ forceHydrate: true });
  }, [actor.idToken, projectId, sourceYear]);

  function handleCopyShareAccount() {
    if (!systemAccountEmail) return;
    void navigator.clipboard?.writeText(systemAccountEmail).catch(() => undefined);
    setStatusMessage('공유 계정을 복사했습니다.');
    logCashflowLab('share_account.copy', { projectId, hasSystemAccountEmail: true });
  }

  async function handleSaveSheetConfig() {
    if (!projectId || loading || !spreadsheetId) return;
    const requestedProjectId = projectId;
    const requestedSourceYear = sourceYear;
    const requestGeneration = ++sheetOperationGenerationRef.current;
    const isCurrentRequest = () => shouldApplyCashflowSheetLabProjectResult({
      requestGeneration,
      currentGeneration: sheetOperationGenerationRef.current,
      requestedProjectId,
      selectedProjectId: selectedProjectIdRef.current,
      requestedSourceYear,
      selectedSourceYear: selectedSourceYearRef.current,
    });
    if (!isCurrentRequest()) return;
    setLoadingOperation('saving');
    setErrorMessage('');
    setStatusMessage('');
    setReviewedSourceKey('');
    setReflectResult(null);
    try {
      const result = await runWithBffAuthRetry('settings.save', async (requestActor) => {
        if (!isCurrentRequest()) return null;
        return saveCashflowSheetLabConfigViaBff({
          tenantId: orgId,
          actor: requestActor,
          projectId: requestedProjectId,
          sourceYear: requestedSourceYear,
          value: sheetLink,
          sheetName: sheetName || undefined,
        });
      });
      if (!isCurrentRequest()) return;
      if (!result) return;
      setSavedConfig(result.config || null);
      setSavedConfigs(result.configs || []);
      setStatusMessage('시트 정보를 저장했습니다. 금액은 아직 MYSCube에 반영되지 않았습니다.');
      logCashflowLab('settings.save.ok', { projectId: requestedProjectId, spreadsheetId, sheetName: sheetName || null });
    } catch (error) {
      if (!isCurrentRequest()) return;
      logCashflowLab('settings.save.error', { projectId: requestedProjectId, spreadsheetId, ...errorDiagnostics(error) }, 'warn');
      setErrorMessage(formatError(error));
    } finally {
      if (isCurrentRequest()) setLoadingOperation(null);
    }
  }
  async function handleRefreshSheetMirror() {
    if (!projectId || loading || !spreadsheetId) return;
    const requestedProjectId = projectId;
    const requestedSourceYear = sourceYear;
    const requestGeneration = ++sheetOperationGenerationRef.current;
    const isCurrentRequest = () => shouldApplyCashflowSheetLabProjectResult({
      requestGeneration,
      currentGeneration: sheetOperationGenerationRef.current,
      requestedProjectId,
      selectedProjectId: selectedProjectIdRef.current,
      requestedSourceYear,
      selectedSourceYear: selectedSourceYearRef.current,
    });
    if (!isCurrentRequest()) return;
    const startedAt = Date.now();
    const refreshIdempotencyKey = `cashflow-sheet-lab-refresh:${requestedProjectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    setLoadingOperation('refresh');
    setErrorMessage('');
    setStatusMessage('');
    setReviewedSourceKey('');
    setReflectResult(null);
    try {
      logCashflowLab('mirror.refresh.start', {
        projectId: requestedProjectId,
        spreadsheetId,
        sheetName: sheetName || null,
      });
      const result = await runWithBffAuthRetry('mirror.refresh', async (requestActor) => {
        if (!isCurrentRequest()) return null;
        return refreshCashflowSheetLabMirrorViaBff({
          tenantId: orgId,
          actor: requestActor,
          projectId: requestedProjectId,
          sourceYear: requestedSourceYear,
          value: sheetLink,
          sheetName: sheetName || undefined,
          idempotencyKey: refreshIdempotencyKey,
        });
      });
      if (!isCurrentRequest()) return;
      if (!result) return;
      const nextSheetName = sheetName || result.selectedSheetName || '';
      setMirror((current) => result.status === 'STALE' && current?.sourceRevision
        ? {
            ...current,
            ...result,
            sourceRevision: result.sourceRevision || current.sourceRevision,
            capturedAt: result.capturedAt || current.capturedAt,
            summary: result.summary || current.summary,
            cells: result.cells || current.cells,
          }
        : result);
      setReviewedSourceKey(result.status === 'FRESH' && result.sourceRevision
        ? buildSourceKey({ projectId: requestedProjectId, sourceYear: requestedSourceYear, value: sheetLink, sheetName: nextSheetName })
        : '');
      if (result.status === 'FRESH' && result.sourceRevision) {
        setStatusMessage('시트 최신값을 고정했습니다. 시트 값으로 덮어쓸 수 있습니다.');
      } else if (result.status === 'STALE') {
        setStatusMessage('');
      } else {
        setErrorMessage(result.lastRefreshError?.message || '시트 연동에 실패했습니다.');
      }
      logCashflowLab('mirror.refresh.ok', {
        projectId: requestedProjectId,
        spreadsheetId: result.spreadsheetId,
        sheetName: result.selectedSheetName,
        mirrorStatus: result.status,
        sourceRevision: result.sourceRevision,
        cellCount: result.summary?.cellCount || 0,
        durationMs: Date.now() - startedAt,
      });
      if (!sheetName && result.selectedSheetName) setSheetName(result.selectedSheetName);
    } catch (error) {
      if (!isCurrentRequest()) return;
      logCashflowLab('mirror.refresh.error', {
        projectId: requestedProjectId,
        spreadsheetId,
        durationMs: Date.now() - startedAt,
        ...errorDiagnostics(error),
      }, 'warn');
      setErrorMessage(formatError(error, cashflowSheetErrorPhase('refresh', error)));
      if (getErrorCode(error) === 'google_sheet_service_account_forbidden') {
        void handleLoadShareAccount();
      }
    } finally {
      if (isCurrentRequest()) setLoadingOperation(null);
    }
  }

  async function handleOverwriteSheetValues(
    monthCloseChangeReason = '',
    stagedOverride: CashflowSheetLabStageResult | null = null,
    acceptFormulaMismatches = false,
    acceptPendingApprovalDifferences = false,
  ) {
    if (
      !projectId
      || loading
      || applyStatusState !== 'ready'
      || (applyResumeRequired && !stagedOverride)
      || (!stagedOverride && !spreadsheetId)
      || (!stagedOverride && (mirror?.status !== 'FRESH' || !mirror.sourceRevision || reviewedSourceKey !== sourceKey))
    ) return;
    const requestedProjectId = projectId;
    const requestedSourceYear = sourceYear;
    const requestGeneration = ++sheetOperationGenerationRef.current;
    const isCurrentRequest = () => shouldApplyCashflowSheetLabProjectResult({
      requestGeneration,
      currentGeneration: sheetOperationGenerationRef.current,
      requestedProjectId,
      selectedProjectId: selectedProjectIdRef.current,
      requestedSourceYear,
      selectedSourceYear: selectedSourceYearRef.current,
    });
    if (!isCurrentRequest()) return;
    const startedAt = Date.now();
    const expectedMirrorRevision = mirror?.sourceRevision || '';
    const stageIdempotencyKey = `cashflow-sheet-lab-stage:${requestedProjectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    const applyIdempotencyKey = `cashflow-sheet-lab-apply:${requestedProjectId}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
    let activeStep: 'stage' | 'apply' = stagedOverride ? 'apply' : 'stage';
    let staged = stagedOverride;
    let stageDurationMs = 0;
    setLoadingOperation(stagedOverride ? 'applying' : 'staging');
    setErrorMessage('');
    setStatusMessage('');
    if (!stagedOverride) {
      setClosedMonthWarning([]);
      setClosedMonthStage(null);
      setClosedMonthChangeReason('');
      setClosedMonthPendingApprovalAccepted(false);
      setPendingApprovalStage(null);
    }
    setReflectResult(null);
    logCashflowLab('overwrite.sheet_values.start', {
      projectId: requestedProjectId,
      spreadsheetId,
    });
    try {
      if (!staged) {
        logCashflowLab('stage.sheet_values.start', { projectId: requestedProjectId, spreadsheetId });
        const stageStartedAt = Date.now();
        staged = await runWithBffAuthRetry('stage.sheet_values', async (requestActor) => {
          if (!isCurrentRequest()) return null;
          return stageCashflowSheetLabViaBff({
            tenantId: orgId,
            actor: requestActor,
            projectId: requestedProjectId,
            expectedMirrorRevision,
            replaceAllActualSources: true,
            idempotencyKey: stageIdempotencyKey,
          });
        });
        if (!isCurrentRequest()) return;
        stageDurationMs = Date.now() - stageStartedAt;
      }
      if (!staged) {
        logCashflowLab('overwrite.sheet_values.cancelled', {
          projectId: requestedProjectId,
          spreadsheetId,
          step: activeStep,
          durationMs: Date.now() - startedAt,
        }, 'warn');
        return;
      }
      if (!stagedOverride) {
        setReviewedSourceKey(sourceKey);
        logCashflowLab('stage.sheet_values.ok', {
          projectId: requestedProjectId,
          spreadsheetId: staged.spreadsheetId,
          sheetName: staged.selectedSheetName,
          stagedLineCount: staged.stagedLineCount,
          projectionLineCount: staged.projectionLineCount,
          actualLineCount: staged.actualLineCount,
          riskLineCount: staged.riskLineCount,
          durationMs: stageDurationMs,
          totalDurationMs: Date.now() - startedAt,
        });
      }
      if (staged.status === 'BLOCKED') {
        logCashflowLab('overwrite.sheet_values.blocked', {
          projectId: requestedProjectId,
          spreadsheetId,
          riskLineCount: staged.riskLineCount,
          durationMs: Date.now() - startedAt,
        }, 'warn');
        const contractIssue = staged.pendingApprovalContractIssues?.[0];
        const blockedMonths = (contractIssue?.blockedMonths || staged.blockedMonths || []).join(', ');
        setErrorMessage(contractIssue
          ? `${contractIssue.message}${blockedMonths ? ` 확인할 월: ${blockedMonths}` : ''}${contractIssue.requestId !== 'unknown' ? ` (요청 ID: ${contractIssue.requestId})` : ''}`
          : `반영할 수 없는 시트 범위가 있습니다.${blockedMonths ? ` 확인할 월: ${blockedMonths}` : ''}`);
        return;
      }
      if (staged.stagedLineCount === 0) {
        setReflectResult({ appliedLineCount: 0, projectionLineCount: 0, actualLineCount: 0 });
        setStatusMessage('MYSCube가 이미 시트 최신값과 같습니다.');
        logCashflowLab('overwrite.sheet_values.noop', {
          projectId: requestedProjectId,
          spreadsheetId,
          durationMs: Date.now() - startedAt,
          stageDurationMs,
        });
        return;
      }
      if (!stagedOverride && staged.closedMonthDifferences?.length) {
        setClosedMonthStage(staged);
        setClosedMonthWarning(staged.closedMonthDifferences);
        setApplyResumeRequired(false);
        setClosedMonthFormulaAccepted(false);
        setClosedMonthPendingApprovalAccepted(false);
        return;
      }
      if (!acceptPendingApprovalDifferences && staged.pendingApprovalDifferences?.length) {
        closeClosedMonthDialog();
        setPendingApprovalStage(staged);
        setPendingApprovalClosedMonthChangeReason(monthCloseChangeReason);
        setPendingApprovalFormulaAccepted(acceptFormulaMismatches);
        return;
      }
      activeStep = 'apply';
      setLoadingOperation('applying');
      const applyStartedAt = Date.now();
      const stagedRunId = staged.runId;
      const stagedEvidence = staged;
      logCashflowLab('apply.sheet_values.start', {
        projectId: requestedProjectId,
        spreadsheetId,
        stageRunId: staged.runId,
        stagedLineCount: staged.stagedLineCount,
        elapsedMs: applyStartedAt - startedAt,
      });
      const result = await runWithBffAuthRetry('apply.sheet_values', async (requestActor) => {
        if (!isCurrentRequest()) return null;
        return applyCashflowSheetLabViaBff({
          tenantId: orgId,
          actor: requestActor,
          projectId: requestedProjectId,
          stageRunId: stagedRunId,
          replaceAllActualSources: true,
          closedMonthChangeReason: monthCloseChangeReason,
          closedMonthDifferenceCount: stagedEvidence.closedMonthDifferenceCount,
          closedMonthDifferenceManifestHash: stagedEvidence.closedMonthDifferenceManifestHash,
          acceptPendingApprovalDifferences,
          pendingApprovalDifferenceCount: stagedEvidence.pendingApprovalDifferenceCount,
          pendingApprovalDifferenceManifestHash: stagedEvidence.pendingApprovalDifferenceManifestHash,
          acceptFormulaMismatches,
          idempotencyKey: applyIdempotencyKey,
        });
      });
      if (!isCurrentRequest()) return;
      if (!result) {
        logCashflowLab('overwrite.sheet_values.cancelled', {
          projectId: requestedProjectId,
          spreadsheetId,
          step: activeStep,
          durationMs: Date.now() - startedAt,
          stageDurationMs,
        }, 'warn');
        return;
      }
      const applyDurationMs = Date.now() - applyStartedAt;
      const totalDurationMs = Date.now() - startedAt;
      setReflectResult({
        appliedLineCount: result.appliedLineCount,
        projectionLineCount: result.projectionLineCount,
        actualLineCount: result.actualLineCount,
        skippedRiskLineCount: result.skippedRiskLineCount,
        lastAppliedAt: result.lastAppliedAt,
      });
      setClosedMonthStage(null);
      setApplyResumeRequired(false);
      setClosedMonthWarning([]);
      setClosedMonthChangeReason('');
      setClosedMonthFormulaAccepted(false);
      setClosedMonthPendingApprovalAccepted(false);
      setPendingApprovalStage(null);
      setFormulaMismatchPrompt(null);
      setStatusMessage(`시트 값 ${result.appliedLineCount.toLocaleString()}건으로 MYSCube를 덮어썼습니다.`);
      logCashflowLab('apply.sheet_values.ok', {
        projectId: requestedProjectId,
        spreadsheetId: result.spreadsheetId,
        sheetName: result.selectedSheetName,
        appliedLineCount: result.appliedLineCount,
        projectionLineCount: result.projectionLineCount,
        actualLineCount: result.actualLineCount,
        durationMs: applyDurationMs,
        totalDurationMs,
        stageDurationMs,
      });
      logCashflowLab('overwrite.sheet_values.ok', {
        projectId: requestedProjectId,
        spreadsheetId: result.spreadsheetId,
        appliedLineCount: result.appliedLineCount,
        durationMs: totalDurationMs,
        totalDurationMs,
        stageDurationMs,
        applyDurationMs,
      });
    } catch (error) {
      if (!isCurrentRequest()) return;
      logCashflowLab('overwrite.sheet_values.error', {
        projectId: requestedProjectId,
        spreadsheetId,
        step: activeStep,
        durationMs: Date.now() - startedAt,
        totalDurationMs: Date.now() - startedAt,
        ...errorDiagnostics(error),
      }, 'warn');
      if (activeStep === 'apply' && getErrorCode(error) === 'cashflow_sheet_apply_in_progress') {
        closeClosedMonthDialog();
        setApplyStatusState('checking');
        setApplyStatusRetry((current) => current + 1);
        setErrorMessage('진행 중인 시트 반영 작업을 확인하고 있습니다.');
        return;
      }
      if (activeStep === 'apply' && getErrorCode(error) === 'cashflow_formula_mismatch_confirmation_required' && staged) {
        const issues = cashflowFormulaMismatchesFromError(error);
        if (issues.length > 0) {
          closeClosedMonthDialog();
          setFormulaMismatchPrompt({
            stage: staged,
            issues,
            closedMonthChangeReason: monthCloseChangeReason,
            acceptPendingApprovalDifferences,
          });
          return;
        }
      }
      if (activeStep === 'apply' && getErrorCode(error) === 'cashflow_pending_approval_confirmation_required' && staged) {
        const details = (error as {
          body?: { details?: Pick<CashflowSheetLabStageResult, 'pendingApprovalDifferences' | 'pendingApprovalDifferenceCount' | 'pendingApprovalDifferenceManifestHash'> };
        }).body?.details;
        closeClosedMonthDialog();
        setPendingApprovalStage({
          ...staged,
          pendingApprovalDifferences: details?.pendingApprovalDifferences?.length
            ? details.pendingApprovalDifferences
            : staged.pendingApprovalDifferences,
          pendingApprovalDifferenceCount: details?.pendingApprovalDifferenceCount ?? staged.pendingApprovalDifferenceCount,
          pendingApprovalDifferenceManifestHash: details?.pendingApprovalDifferenceManifestHash || staged.pendingApprovalDifferenceManifestHash,
        });
        setPendingApprovalClosedMonthChangeReason(monthCloseChangeReason);
        setPendingApprovalFormulaAccepted(acceptFormulaMismatches);
        return;
      }
      if (activeStep === 'apply' && getErrorCode(error) === 'cashflow_closed_month_reason_required') {
        const serverDifferences = getClosedMonthDifferences(error);
        setClosedMonthStage(staged);
        setClosedMonthWarning(
          serverDifferences.length
            ? serverDifferences
            : staged?.closedMonthDifferences || [],
        );
        setApplyResumeRequired(false);
        setClosedMonthFormulaAccepted(acceptFormulaMismatches);
        setClosedMonthPendingApprovalAccepted(acceptPendingApprovalDifferences);
      } else if (activeStep === 'apply' && staged && isCashflowSheetApplyResultUncertain(error)) {
        if (applyResumeRequired) {
          closeClosedMonthDialog();
          setErrorMessage('서버가 반영 결과를 확인하고 있습니다. 잠시 후 시트 값을 다시 불러와 확인해 주세요.');
          return;
        }
        setClosedMonthStage(staged);
        setClosedMonthChangeReason(stagedOverride ? monthCloseChangeReason.trim() : '');
        setClosedMonthFormulaAccepted(acceptFormulaMismatches);
        setClosedMonthPendingApprovalAccepted(acceptPendingApprovalDifferences);
        setApplyResumeRequired(true);
        setErrorMessage(`${formatError(error, cashflowSheetErrorPhase(activeStep, error))} 같은 검토본으로 이어서 완료할 수 있습니다.`);
      } else {
        if (activeStep === 'apply' && ['cashflow_sheet_config_changed', 'cashflow_sheet_mirror_stale', 'cashflow_sheet_mirror_revision_conflict'].includes(getErrorCode(error))) {
          closeClosedMonthDialog();
        }
        setErrorMessage(formatError(error, cashflowSheetErrorPhase(activeStep, error)));
      }
    } finally {
      if (isCurrentRequest()) setLoadingOperation(null);
    }
  }

  const isCurrentSheetConfigSaved = Boolean(savedConfigSourceKey && savedConfigSourceKey === sourceKey);
  const canRefresh = Boolean(projectId && spreadsheetId && isCurrentSheetConfigSaved && !loading);
  const canSaveConfig = Boolean(projectId && spreadsheetId && !loading);
  const hasCurrentFreshMirror = Boolean(mirror?.status === 'FRESH' && mirror.sourceRevision && reviewedSourceKey === sourceKey);
  const canOverwrite = Boolean(
    projectId
    && spreadsheetId
    && hasCurrentFreshMirror
    && !reflectResult
    && !loading
    && applyStatusState === 'ready'
    && !applyResumeRequired
  );
  const hasSavedConfig = Boolean(savedConfig?.value);
  const currentStep = reflectResult || hasCurrentFreshMirror ? 3 : isCurrentSheetConfigSaved ? 2 : 1;
  const stepNumberClass = (step: number) =>
    `z-10 flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-bold ${
      step <= currentStep
        ? 'bg-[#001e46] text-white shadow-[0_0_0_4px_rgba(0,30,70,0.08)]'
        : 'bg-slate-100 text-slate-500'
    }`;

  function closeClosedMonthDialog() {
    setClosedMonthStage(null);
    setApplyResumeRequired(false);
    setClosedMonthWarning([]);
    setClosedMonthChangeReason('');
    setClosedMonthFormulaAccepted(false);
    setClosedMonthPendingApprovalAccepted(false);
  }

  return (
    <>
    <div className="bg-white px-5 py-6 sm:bg-slate-100 sm:px-6" inert={loading || undefined} aria-busy={loading}>
      <div className="relative mx-auto max-w-[560px]">
        {loading ? <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-10 rounded-md border-2 border-slate-200 border-t-[#17324D] motion-safe:animate-spin" /> : null}
        <section className="relative bg-white sm:border sm:border-slate-200 sm:p-8 sm:shadow-sm">
        <header className="border-b border-slate-200 pb-5">
          <h1 className="text-[22px] font-bold tracking-[-0.02em] text-slate-950">사업비 관리시트 연동</h1>
          <p className="mt-1 text-[13px] leading-relaxed text-slate-500">필요할 때 시트 최신값을 가져와 MYSCube에 반영합니다.</p>
        </header>

        <ol className="relative mt-10 space-y-8 before:absolute before:left-[17px] before:bottom-6 before:top-8 before:w-px before:bg-slate-200">
          <li className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-4">
            <span className={stepNumberClass(1)}>1</span>
            <div className="min-w-0 space-y-2 pb-1">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[19px] font-bold text-slate-950">시트 연결</h2>
                <HelpMemo>사업기간의 연도마다 해당 연도 주차 시트를 연결합니다. 이 단계에서는 금액을 저장하지 않습니다.</HelpMemo>
              </div>
              <label className="block text-[12px] font-semibold text-slate-700">
                연동 연도
                <select
                  value={sourceYear}
                  onChange={(event) => handleSourceYearChange(Number(event.target.value))}
                  className="mt-1 h-10 w-full rounded-md border border-slate-300 bg-white px-3 text-[13px] text-slate-900"
                  aria-label="연동 연도"
                >
                  {projectYears.map((year) => (
                    <option key={year} value={year}>
                      {year}년{savedConfigs.some((config) => config.sourceYear === year) ? ' · 연결됨' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <Input
                value={sheetLink}
                onChange={(event) => setSheetLink(event.target.value)}
                placeholder="Google Sheet 링크"
                aria-label="Google Sheet 링크"
                className="h-11 text-[13px]"
              />
              <div>
                <Input
                  value={sheetName}
                  onChange={(event) => setSheetName(event.target.value)}
                  placeholder="시트 탭 이름"
                  aria-label="시트 탭 이름"
                  className="h-10 text-[12px]"
                />
              </div>
              <div className="flex flex-wrap items-center gap-2 pt-2">
                <Button
                  type="button"
                  variant={isCurrentSheetConfigSaved ? 'outline' : 'default'}
                  className="h-9 gap-1.5 px-3 text-[12px]"
                  disabled={!canSaveConfig || isCurrentSheetConfigSaved}
                  onClick={() => void handleSaveSheetConfig()}
                >
                  {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {isCurrentSheetConfigSaved ? '저장됨' : '시트 정보 저장'}
                </Button>
                <div className="text-[12px] text-slate-500">
                  {sourceYear}년 링크와 탭 이름을 입력하면 선택한 탭 전체를 불러옵니다.
                </div>
              </div>
              <div className="mt-2 space-y-2 border-l-2 border-blue-200 pl-3 text-[12px] text-slate-600" aria-label="Google Sheet 편집자 공유 안내">
                  <strong className="block text-slate-800">먼저 아래 서비스 계정을 Google Sheet 편집자로 공유해 주세요.</strong>
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="outline" className="h-8 gap-1.5 px-3 text-[12px]" disabled={!projectId || accountLoading} onClick={() => void handleLoadShareAccount()}>
                      {accountLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
                      다시 불러오기
                    </Button>
                    <Button type="button" variant="outline" className="h-8 gap-1.5 px-3 text-[12px]" disabled={!systemAccountEmail} onClick={handleCopyShareAccount}>
                      <Copy className="h-3.5 w-3.5" />공유 계정 복사
                    </Button>
                  </div>
                  {systemAccountEmail ? <div className="break-all bg-blue-50 px-3 py-2 font-mono text-blue-900">{systemAccountEmail}</div> : <div role="status" className="bg-slate-50 px-3 py-2 text-slate-500">{accountLoading ? '서비스 계정 이메일을 불러오는 중입니다.' : '서비스 계정 이메일을 확인하지 못했습니다. 다시 불러오기를 눌러 주세요.'}</div>}
                  <p>Google Sheet 공유 창에서 위 계정을 추가하고 권한을 <strong>편집자</strong>로 선택하세요.</p>
              </div>
            </div>
          </li>

          <li className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-4">
            <span className={stepNumberClass(2)}>2</span>
            <div className="min-w-0 space-y-3 pb-1">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[19px] font-bold text-slate-950">시트 값 가져오기</h2>
                <HelpMemo>저장한 설정으로 Google Sheet 최신값을 읽어 서버 고정본으로 만듭니다. 아직 MYSCube에는 저장하지 않습니다.</HelpMemo>
              </div>
              <Button
                type="button"
                variant="outline"
                className="h-10 gap-1.5 px-4 text-[13px]"
                disabled={!canRefresh}
                onClick={() => void handleRefreshSheetMirror()}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                {mirror?.sourceRevision ? '시트 값 다시 가져오기' : '시트 값 가져오기'}
              </Button>
              {mirror?.lastRefreshError?.message ? (
                <div className="border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-900">
                  <span className="font-bold">시트 연동 오류</span> · {mirror.lastRefreshError.message}
                  {mirror.lastRefreshError.diagnostics?.length ? (
                    <ul className="mt-2 space-y-1 border-t border-red-200 pt-2">
                      {mirror.lastRefreshError.diagnostics.map((diagnostic, index) => (
                        <li key={`${diagnostic.code}-${diagnostic.sourceCell || index}`}>
                          {diagnostic.sourceCell ? `${diagnostic.sourceCell} · ` : ''}{diagnostic.message}
                          <span className="ml-1 text-red-700">({diagnostic.code})</span>
                        </li>
                      ))}
                      {(mirror.lastRefreshError.diagnosticCount || 0) > mirror.lastRefreshError.diagnostics.length ? (
                        <li>외 {(mirror.lastRefreshError.diagnosticCount || 0) - mirror.lastRefreshError.diagnostics.length}건</li>
                      ) : null}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>

          <li className="relative grid grid-cols-[36px_minmax(0,1fr)] gap-4">
            <span className={stepNumberClass(3)}>3</span>
            <div className="min-w-0 space-y-3 pb-1">
              <div className="flex items-center gap-1.5">
                <h2 className="text-[19px] font-bold text-slate-950">시트 값으로 덮어쓰기</h2>
                <HelpMemo>고정한 시트의 Projection과 Actual로 MYSCube 값을 덮어씁니다. 별도 운영자 검토는 없으며, 월 결산된 기간만 보호됩니다.</HelpMemo>
              </div>
              {reflectResult ? (
                <div className="space-y-3">
                  <div className="border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-900">
                    {reflectResult.appliedLineCount > 0 ? (
                      <>
                        덮어쓰기 완료 · {reflectResult.appliedLineCount.toLocaleString()}건
                        {' · '}Projection {reflectResult.projectionLineCount.toLocaleString()}건
                        {' · '}Actual {reflectResult.actualLineCount.toLocaleString()}건
                      </>
                    ) : '이미 시트 최신값과 같습니다.'}
                  </div>
                  <Button asChild variant="outline" className="h-9 px-3 text-[12px]">
                    <Link to={resolvePortalProjectResourcePath('/portal/cashflow', projectId)}>캐시플로우로 이동</Link>
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <Button
                    type="button"
                    className="h-10 gap-1.5 px-4 text-[13px]"
                    disabled={applyStatusState === 'error' ? loading : !canOverwrite}
                    onClick={() => {
                      if (applyStatusState === 'error') {
                        setErrorMessage('');
                        setApplyStatusRetry((current) => current + 1);
                        return;
                      }
                      void handleOverwriteSheetValues();
                    }}
                  >
                    {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                    {applyStatusState === 'error' ? '반영 상태 다시 확인' : '시트 값으로 덮어쓰기'}
                  </Button>
                </div>
              )}
            </div>
          </li>
        </ol>

        {errorMessage && (
          <div className="mt-6 flex items-center gap-2 border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-800">
            <AlertCircle className="h-4 w-4" />
            <span>{errorMessage}</span>
          </div>
        )}
        {statusMessage && (
          <div className="mt-3 flex items-center gap-2 border border-emerald-200 bg-emerald-50 px-3 py-2 text-[12px] text-emerald-800">
            <CheckCircle2 className="h-4 w-4" />
            <span>{statusMessage}</span>
          </div>
        )}
        </section>
      </div>

      <CashflowFormulaMismatchDialog
        issues={formulaMismatchPrompt?.issues || []}
        busy={loading}
        onCancel={() => setFormulaMismatchPrompt(null)}
        onConfirm={() => {
          if (!formulaMismatchPrompt) return;
          const pending = formulaMismatchPrompt;
          setFormulaMismatchPrompt(null);
          void handleOverwriteSheetValues(
            pending.closedMonthChangeReason,
            pending.stage,
            true,
            pending.acceptPendingApprovalDifferences,
          );
        }}
      />

      <Dialog open={Boolean(pendingApprovalStage)} onOpenChange={(open) => {
        if (!open) {
          setPendingApprovalStage(null);
          setPendingApprovalClosedMonthChangeReason('');
          setPendingApprovalFormulaAccepted(false);
        }
      }}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[760px] gap-4 overflow-y-auto rounded-xl p-5">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-[17px]">결재 중인 누적 결산과 값이 달라요</DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed text-slate-600">
              그대로 반영하시면 경고 1회가 추가됩니다. 그래도 진행하시겠습니까?
            </DialogDescription>
          </DialogHeader>
          <div role={pendingApprovalManifestComplete ? 'status' : 'alert'} className={`rounded-lg border px-3 py-2 text-[12px] ${pendingApprovalManifestComplete ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-red-300 bg-red-50 text-red-800'}`}>
            {pendingApprovalManifestComplete ? `결재 중 변경 후보 전체 ${pendingApprovalChangeRows.length.toLocaleString()}건 · manifest 확인됨` : '변경 후보의 manifest 또는 전체 건수가 일치하지 않아 반영할 수 없습니다.'}
          </div>
          <div className="max-h-72 space-y-3 overflow-auto rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-950" role="region" aria-label="결재 중 누적 결산 변경 후보 전체 목록" tabIndex={0}>
            {pendingApprovalDifferences.map((summary) => (
              <div key={`${summary.requestId}:${summary.yearMonth}`}>
                <div className="font-semibold">
                  {summary.yearMonth} · {summary.requestStatus} · {summary.differenceCount.toLocaleString()}건 변경
                </div>
                {summary.changes.map((change) => (
                  <div key={`${change.mode}:${change.weekNo}:${change.lineId}`} className="mt-1 grid grid-cols-[auto_1fr_auto] gap-2 border-t border-amber-200 pt-1">
                    <span className="whitespace-nowrap text-amber-800">{change.mode === 'projection' ? 'Projection' : 'Actual'} {change.weekNo}주차</span>
                    <span>{CASHFLOW_SHEET_LINE_LABELS[change.lineId as CashflowSheetLineId] || change.lineId}</span>
                    <span className="whitespace-nowrap text-right tabular-nums">
                      {change.beforeState} {change.beforeHadValue ? `${Number(change.beforeAmount).toLocaleString()}원` : '미작성'}
                      {' → '}
                      <strong>{change.afterState} {change.afterHadValue ? `${Number(change.afterAmount).toLocaleString()}원` : '미작성'}</strong>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <DialogFooter className="flex-row justify-end gap-2 sm:space-x-0">
            <Button type="button" variant="outline" className="h-9" onClick={() => {
              setPendingApprovalStage(null);
              setPendingApprovalClosedMonthChangeReason('');
              setPendingApprovalFormulaAccepted(false);
            }}>닫기</Button>
            <Button
              type="button"
              className="h-9"
              disabled={loading || !pendingApprovalStage || !pendingApprovalManifestComplete}
              onClick={() => {
                const staged = pendingApprovalStage;
                setPendingApprovalStage(null);
                if (staged) void handleOverwriteSheetValues(
                  pendingApprovalClosedMonthChangeReason,
                  staged,
                  pendingApprovalFormulaAccepted,
                  true,
                );
              }}
            >반영</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={Boolean(closedMonthStage)}
        onOpenChange={(open) => {
          if (!open) closeClosedMonthDialog();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-[760px] gap-4 overflow-y-auto rounded-xl p-5">
          <DialogHeader className="space-y-1 text-left">
            <DialogTitle className="text-[17px]">{applyResumeRequired ? '시트 반영 상태 확인 필요' : '결산 후 값이 달라요'}</DialogTitle>
            <DialogDescription className="text-[12px] leading-relaxed text-slate-600">
              {applyResumeRequired
                ? '이전 반영이 완료됐는지 서버에서 확인합니다. 완료된 값은 다시 저장하지 않으며, 확인이 오래 걸리면 창을 닫고 잠시 후 다시 시도해 주세요.'
                : '월 결산 이후 변경입니다. 사유를 남기면 변경 이력과 경고 횟수에 함께 기록됩니다. 그래도 반영할까요?'}
            </DialogDescription>
          </DialogHeader>
          {!applyResumeRequired && closedMonthWarning.length > 0 && (
            <div className="space-y-3">
              <div role={closedMonthManifestComplete ? 'status' : 'alert'} className={`rounded-lg border px-3 py-2 text-[12px] ${closedMonthManifestComplete ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-red-300 bg-red-50 text-red-800'}`}>
                {closedMonthManifestComplete ? `반영 전 변경 후보 전체 ${closedMonthChangeRows.length.toLocaleString()}건 · manifest 확인됨` : '변경 후보의 manifest 또는 전체 건수가 일치하지 않아 반영할 수 없습니다.'}
              </div>
              <div className="max-h-72 space-y-3 overflow-auto rounded-lg bg-amber-50 px-3 py-2 text-[12px] text-amber-950" role="region" aria-label="결산 후 변경 후보 전체 목록" tabIndex={0}>
              {closedMonthWarning.map((summary) => (
                <div key={summary.yearMonth}>
                  <div className="font-semibold">
                    {summary.yearMonth} · {summary.weeks.length}개 주차 · {summary.differenceCount.toLocaleString()}건 변경
                  </div>
                  {(summary.changes || []).map((change) => (
                    <div key={`${change.mode}:${change.weekNo}:${change.lineId}`} className="mt-1 grid grid-cols-[auto_1fr_auto] gap-2 border-t border-amber-200 pt-1">
                      <span className="whitespace-nowrap text-amber-800">
                        {change.mode === 'projection' ? 'Projection' : 'Actual'} {change.weekNo}주차
                      </span>
                      <span>{CASHFLOW_SHEET_LINE_LABELS[change.lineId as CashflowSheetLineId] || change.lineId}</span>
                      <span className="whitespace-nowrap text-right tabular-nums">
                        {change.beforeHadValue ? `${Number(change.beforeAmount || 0).toLocaleString()}원` : '미작성'}
                        {' → '}
                        <strong>{change.afterHadValue ? `${Number(change.afterAmount || 0).toLocaleString()}원` : '미작성'}</strong>
                      </span>
                    </div>
                  ))}
                </div>
              ))}
              </div>
            </div>
          )}
          {!applyResumeRequired && (
            <textarea
              value={closedMonthChangeReason}
              onChange={(event) => setClosedMonthChangeReason(event.target.value.slice(0, 1000))}
              placeholder="예: 결산 후 확인된 실제 입금액 정정"
              className="min-h-20 w-full rounded-lg border border-slate-300 px-3 py-2 text-[13px]"
              disabled={loading}
            />
          )}
          <DialogFooter className="flex-row justify-end gap-2 sm:space-x-0">
            {!applyResumeRequired && (
              <Button type="button" variant="outline" className="h-9" onClick={closeClosedMonthDialog}>
                닫기
              </Button>
            )}
            <Button
              type="button"
              className="h-9"
              disabled={loading || !closedMonthStage || (!applyResumeRequired && (!closedMonthChangeReason.trim() || !closedMonthManifestComplete))}
              onClick={() => void handleOverwriteSheetValues(
                closedMonthChangeReason.trim(),
                closedMonthStage,
                closedMonthFormulaAccepted,
                closedMonthPendingApprovalAccepted,
              )}
            >
              {applyResumeRequired ? '반영 상태 확인' : '사유와 함께 반영'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </div>
    {loadingOperation ? <CashflowSheetSyncOverlay operation={loadingOperation} /> : null}
    </>
  );
}
