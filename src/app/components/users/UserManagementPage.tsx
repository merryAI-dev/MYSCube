import { PeopleAccountLink } from './PeopleAccountLink';
import { governanceErrorMessage } from './auth-governance-errors';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Database,
  GitMerge,
  KeyRound,
  RefreshCw,
  Search,
  Shield,
  UserCog,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { featureFlags } from '../../config/feature-flags';
import { useAuth } from '../../data/auth-store';
import type { UserRole } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';
import {
  deepSyncAuthGovernanceUserViaBff,
  deepSyncAuthGovernanceUsersViaBff,
  fetchAuthGovernanceUsersViaBff,
  type AuthGovernanceUserRow,
  type AuthGovernanceSummary,
} from '../../lib/platform-bff-client';
import { PageHeader } from '../layout/PageHeader';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Input } from '../ui/input';
import { ScrollArea } from '../ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../ui/select';
import { Separator } from '../ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../ui/table';
import {
  getCurrentGovernancePermissionLabel,
  emptyGovernanceSummary,
  filterGovernanceRows,
  getFriendlyGovernanceIssueLabels,
  getGovernanceOperatorStatus,
  getRecommendedGovernanceRole,
  type AuthGovernanceFilters,
} from './auth-governance-view-model';

const ROLE_OPTIONS: Array<{ value: UserRole; label: string }> = [
  { value: 'admin', label: '관리자' },
  { value: 'finance', label: '경영기획실' },
  { value: 'pm', label: 'PM' },
  { value: 'viewer', label: '실무자' },
];

const ROLE_BADGE_CLASS: Record<string, string> = {
  admin: 'bg-stone-900 text-white',
  finance: 'bg-stone-700 text-white',
  pm: 'bg-stone-200 text-stone-900',
  viewer: 'bg-stone-100 text-stone-700',
};

const OPERATOR_STATUS_CLASS = {
  success: 'bg-white text-stone-700 border border-stone-300',
  warning: 'bg-white text-red-700 border border-stone-300',
  danger: 'bg-white text-red-700 border border-stone-300',
} as const;

function roleLabel(role: string | null | undefined): string {
  const normalized = (role || '').trim().toLowerCase();
  return ROLE_OPTIONS.find((item) => item.value === normalized)?.label || (normalized || '미지정');
}

function statusLabel(status: string | null | undefined): string {
  if (status === 'ACTIVE') return '활성';
  if (status === 'INACTIVE') return '비활성';
  if (status === 'PENDING') return '대기';
  return '미지정';
}

function formatTimestamp(value: string | null | undefined): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function KpiCard({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: typeof Users;
  label: string;
  value: number;
  tone?: 'default' | 'danger';
}) {
  return (
    <Card className="border-stone-200 bg-white">
      <CardContent className="flex items-center gap-3 p-4">
        <div className={tone === 'danger'
          ? 'flex h-10 w-10 items-center justify-center rounded-lg bg-stone-100 text-red-700'
          : 'flex h-10 w-10 items-center justify-center rounded-lg bg-stone-100 text-stone-700'}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <div className="text-xs text-stone-500">{label}</div>
          <div className="text-2xl font-semibold text-stone-950">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function SourceBadge({ ok, label }: { ok: boolean; label: string }) {
  return (
    <Badge className={ok ? 'bg-white text-stone-700 border border-stone-300' : 'bg-white text-red-700 border border-stone-300'}>
      {label}
    </Badge>
  );
}

function PermissionBadge({ allowed, label }: { allowed: boolean; label: string }) {
  return (
    <Badge className={allowed
      ? 'border border-emerald-200 bg-emerald-50 text-emerald-800'
      : 'border border-stone-200 bg-white text-stone-400'}
    >
      {label} {allowed ? '가능' : '불가'}
    </Badge>
  );
}

export function UserManagementPage() {
  const { user: authUser } = useAuth();
  const { orgId } = useFirebase();
  const [items, setItems] = useState<AuthGovernanceUserRow[]>([]);
  const [summary, setSummary] = useState<AuthGovernanceSummary>(emptyGovernanceSummary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedIdentityKey, setSelectedIdentityKey] = useState<string>('');
  const [syncingIdentityKey, setSyncingIdentityKey] = useState<string>('');
  const [bulkSyncing, setBulkSyncing] = useState(false);
  const [draftRoles, setDraftRoles] = useState<Record<string, UserRole>>({});
  const [filters, setFilters] = useState<AuthGovernanceFilters>({
    searchText: '',
    role: 'ALL',
    drift: 'DRIFT_ONLY',
    source: 'ALL',
  });

  const governanceEnabled = featureFlags.platformApiEnabled && !!authUser?.idToken;

  const loadGovernance = async () => {
    if (!authUser || !governanceEnabled) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetchAuthGovernanceUsersViaBff({
        tenantId: orgId,
        actor: authUser,
      });
      setItems(response.items);
      setSummary(response.summary);
      setDraftRoles((prev) => {
        const next = { ...prev };
        for (const row of response.items) {
          if (!next[row.identityKey]) {
            next[row.identityKey] = getRecommendedGovernanceRole(row);
          }
        }
        return next;
      });
      setSelectedIdentityKey((prev) => {
        if (prev && response.items.some((row) => row.identityKey === prev)) return prev;
        return response.items[0]?.identityKey || '';
      });
    } catch {
      setError('권한 목록을 불러오지 못했습니다. 잠시 후 다시 조회해 주세요.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadGovernance();
  }, [orgId, authUser?.uid, authUser?.idToken]);

  const filteredRows = useMemo(
    () => filterGovernanceRows(items, filters),
    [items, filters],
  );
  const organizationHeadCount = useMemo(
    () => items.filter((row) => (row.permissionOverview?.organizationHeadProjects.length || 0) > 0).length,
    [items],
  );

  const selectedRow = useMemo(
    () => filteredRows.find((row) => row.identityKey === selectedIdentityKey)
      || items.find((row) => row.identityKey === selectedIdentityKey)
      || filteredRows[0]
      || items[0]
      || null,
    [filteredRows, items, selectedIdentityKey],
  );

  useEffect(() => {
    if (selectedRow && selectedRow.identityKey !== selectedIdentityKey) {
      setSelectedIdentityKey(selectedRow.identityKey);
    }
  }, [selectedIdentityKey, selectedRow]);

  const handleDeepSync = async (row: AuthGovernanceUserRow) => {
    if (!authUser) return;
    const role = draftRoles[row.identityKey] || getRecommendedGovernanceRole(row);
    setSyncingIdentityKey(row.identityKey);
    try {
      const result = await deepSyncAuthGovernanceUserViaBff({
        tenantId: orgId,
        actor: authUser,
        identityKey: row.identityKey,
        role,
        reason: 'admin auth governance dashboard deep sync',
      });
      if (result.claimsSyncStatus === 'PENDING') {
        toast.warning(`${row.email} 권한 원본은 저장했지만 로그인 권한 동기화가 대기 중입니다. 잠시 후 다시 확인해 주세요.`);
      } else {
        toast.success(`${row.email} 권한 정렬을 반영했습니다.`);
      }
      await loadGovernance();
    } catch (error) {
      toast.error(governanceErrorMessage(error));
    } finally {
      setSyncingIdentityKey('');
    }
  };

  const handleBulkDeepSync = async () => {
    if (!authUser) return;
    const targets = filteredRows.filter((row) => row.needsDeepSync);
    if (targets.length === 0) {
      toast.info('현재 필터 기준으로 정렬할 대상이 없습니다.');
      return;
    }

    setBulkSyncing(true);
    try {
      const result = await deepSyncAuthGovernanceUsersViaBff({
        tenantId: orgId,
        actor: authUser,
        items: targets.map((row) => ({
          identityKey: row.identityKey,
          role: draftRoles[row.identityKey] || getRecommendedGovernanceRole(row),
        })),
        reason: 'admin auth governance dashboard bulk deep sync',
      });
      if (result.summary.failed > 0) {
        const firstFailure = result.outcomes.find((outcome) => outcome.status === 'FAILED');
        toast.warning(`${result.summary.succeeded}건을 반영했고 ${result.summary.failed}건은 반영하지 못했습니다. ${firstFailure?.message || '목록을 새로고침한 뒤 다시 시도해 주세요.'}`);
      } else if (result.summary.pendingClaimsSync > 0) {
        toast.warning(`${result.summary.succeeded}건의 권한 원본을 반영했고, ${result.summary.pendingClaimsSync}건은 로그인 권한 동기화가 대기 중입니다. 잠시 후 다시 확인해 주세요.`);
      } else {
        toast.success(`${result.summary.succeeded}건의 권한 정렬을 반영했습니다.`);
      }
      await loadGovernance();
    } catch {
      toast.error('일괄 정렬 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    } finally {
      setBulkSyncing(false);
    }
  };

  if (!governanceEnabled) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={UserCog}
          iconGradient="linear-gradient(135deg, #44403c 0%, #0c0a09 100%)"
          title="권한 관리"
          description="관리자, 경영기획실, PM 권한을 한 화면에서 확인하고 반영합니다."
        />
        <Card className="border-stone-200">
          <CardContent className="p-6 text-sm text-stone-600">
            이 화면은 관리자 로그인 환경에서만 사용할 수 있습니다.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={UserCog}
        iconGradient="linear-gradient(135deg, #44403c 0%, #0c0a09 100%)"
        title="권한 관리"
        description="전체 멤버의 로그인 역할, 프로젝트 접근, 조직장 지정과 재무 승인 권한을 한 화면에서 교차검증합니다."
        badge={`${summary.total}건`}
        actions={(
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              className="h-9 gap-2 bg-stone-900 text-white hover:bg-stone-800"
              onClick={() => void handleBulkDeepSync()}
              disabled={loading || bulkSyncing}
            >
              <GitMerge className={`h-4 w-4 ${bulkSyncing ? 'animate-pulse' : ''}`} />
              필요한 권한 모두 반영
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 border-stone-300 bg-white text-stone-900"
              onClick={() => void loadGovernance()}
              disabled={loading || bulkSyncing}
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              목록 다시 불러오기
            </Button>
          </div>
        )}
      />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-7">
        <KpiCard icon={Users} label="전체 사용자" value={summary.total} />
        <KpiCard icon={Shield} label="지정 조직장" value={organizationHeadCount} />
        <KpiCard icon={GitMerge} label="권한 반영 필요" value={summary.needsDeepSync} tone={summary.needsDeepSync > 0 ? 'danger' : 'default'} />
        <KpiCard icon={KeyRound} label="로그인 계정 없음" value={summary.missingAuth} tone={summary.missingAuth > 0 ? 'danger' : 'default'} />
        <KpiCard icon={Database} label="직원 권한 기록 없음" value={summary.missingCanonicalMember} tone={summary.missingCanonicalMember > 0 ? 'danger' : 'default'} />
        <KpiCard icon={AlertTriangle} label="중복 기록" value={summary.duplicateMemberDocs} tone={summary.duplicateMemberDocs > 0 ? 'danger' : 'default'} />
        <KpiCard icon={Shield} label="기본 관리자 후보" value={summary.bootstrapCandidates} />
      </div>

      <div className="rounded-xl border border-stone-200 bg-stone-950 px-5 py-4 text-white shadow-sm">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="text-sm font-semibold">운영 기준</div>
            <div className="mt-1 text-sm text-stone-300">
              권한 반영은 로그인 권한과 직원 권한 기록을 같은 값으로 맞춥니다. 반영 후 사용자는 다시 로그인하면 새 권한으로 들어옵니다.
            </div>
          </div>
          <Badge className="w-fit bg-white text-stone-950">관리자 전용</Badge>
        </div>
      </div>

      <Card className="border-stone-200">
        <CardContent className="flex flex-wrap items-center gap-2 p-3">
          <div className="relative min-w-[220px] flex-1">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" />
            <Input
              value={filters.searchText}
              onChange={(event) => setFilters((prev) => ({ ...prev, searchText: event.target.value }))}
              placeholder="이메일이나 이름으로 검색"
              className="h-9 border-stone-300 pl-9"
            />
          </div>
          <Select value={filters.role} onValueChange={(value) => setFilters((prev) => ({ ...prev, role: value as AuthGovernanceFilters['role'] }))}>
            <SelectTrigger className="h-9 w-[150px] border-stone-300 bg-white">
              <SelectValue placeholder="권한" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">권한 전체</SelectItem>
              {ROLE_OPTIONS.map((item) => (
                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filters.drift} onValueChange={(value) => setFilters((prev) => ({ ...prev, drift: value as AuthGovernanceFilters['drift'] }))}>
            <SelectTrigger className="h-9 w-[150px] border-stone-300 bg-white">
              <SelectValue placeholder="상태" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">상태 전체</SelectItem>
              <SelectItem value="DRIFT_ONLY">확인 필요만</SelectItem>
              <SelectItem value="CLEAN_ONLY">정상만</SelectItem>
            </SelectContent>
          </Select>
          <Select value={filters.source} onValueChange={(value) => setFilters((prev) => ({ ...prev, source: value as AuthGovernanceFilters['source'] }))}>
            <SelectTrigger className="h-9 w-[170px] border-stone-300 bg-white">
              <SelectValue placeholder="계정 상태" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ALL">계정 전체</SelectItem>
              <SelectItem value="AUTH_MISSING">로그인 계정 없음</SelectItem>
              <SelectItem value="MEMBER_MISSING">직원 권한 기록 없음</SelectItem>
              <SelectItem value="BOOTSTRAP">기본 관리자 후보</SelectItem>
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-stone-200 bg-white">
          <CardContent className="flex items-center gap-2 p-4 text-sm text-red-700">
            <AlertTriangle className="h-4 w-4" />
            {error}
          </CardContent>
        </Card>
      )}

      <Card className="border-stone-200" data-testid="member-permission-dashboard">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold text-stone-900">전체 멤버 권한 대시보드</CardTitle>
          <p className="text-xs text-stone-500">
            활성 사용자만 배정된 프로젝트의 결산·재오픈을 요청할 수 있습니다. 프로젝트 등록 승인은 지정 조직장, 재오픈 승인·반려는 Finance/Admin만 가능합니다.
          </p>
        </CardHeader>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <Table className="min-w-[1120px]">
              <TableHeader>
                <TableRow className="bg-stone-50">
                  <TableHead>멤버</TableHead>
                  <TableHead>상태·기본 역할</TableHead>
                  <TableHead>프로젝트 접근</TableHead>
                  <TableHead>지정 조직장</TableHead>
                  <TableHead>결산·재오픈 요청</TableHead>
                  <TableHead>등록 승인</TableHead>
                  <TableHead>재오픈 승인·반려</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((row) => {
                  const permission = row.permissionOverview;
                  const projectNames = permission?.accessibleProjects.map((project) => project.name) || [];
                  const headProjectNames = permission?.organizationHeadProjects.map((project) => project.name) || [];
                  return (
                    <TableRow key={`permission-${row.identityKey}`}>
                      <TableCell>
                        <div className="font-medium text-stone-950">{row.displayName}</div>
                        <div className="text-xs text-stone-500">{row.email}</div>
                      </TableCell>
                      <TableCell>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge className={permission?.isActive ? 'bg-stone-900 text-white' : 'bg-stone-100 text-stone-500'}>
                            {permission?.isActive ? '활성' : '비활성'}
                          </Badge>
                          <Badge className={ROLE_BADGE_CLASS[row.effectiveRole] || 'bg-stone-100 text-stone-700'}>
                            {getCurrentGovernancePermissionLabel(row, roleLabel)}
                          </Badge>
                          {headProjectNames.length > 0 ? (
                            <Badge className="border border-blue-200 bg-blue-50 text-blue-800">조직장</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[260px]">
                        <div className="text-sm text-stone-700">{projectNames.length}개</div>
                        <div className="truncate text-xs text-stone-500" title={projectNames.join(', ')}>
                          {projectNames.join(', ') || '배정 없음'}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-[220px]">
                        <div className="text-sm text-stone-700">{headProjectNames.length}개</div>
                        <div className="truncate text-xs text-stone-500" title={headProjectNames.join(', ')}>
                          {headProjectNames.join(', ') || '지정 없음'}
                        </div>
                      </TableCell>
                      <TableCell><PermissionBadge allowed={Boolean(permission?.canRequestCashflowClose)} label="요청" /></TableCell>
                      <TableCell><PermissionBadge allowed={Boolean(permission?.canApproveProjectRegistration)} label="승인" /></TableCell>
                      <TableCell><PermissionBadge allowed={Boolean(permission?.canDecideCashflowReopen)} label="처리" /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(360px,0.9fr)]">
        <Card className="border-stone-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-stone-900">사용자 권한 목록</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            <ScrollArea className="h-[720px]">
              <div className="divide-y divide-stone-200">
                {filteredRows.map((row) => {
                  const role = draftRoles[row.identityKey] || getRecommendedGovernanceRole(row);
                  const status = getGovernanceOperatorStatus(row);
                  const issueLabels = getFriendlyGovernanceIssueLabels(row);
                  const selected = selectedRow?.identityKey === row.identityKey;
                  return (
                    <div
                      key={row.identityKey}
                      className={`cursor-pointer px-4 py-4 ${selected ? 'bg-stone-100' : 'bg-white hover:bg-stone-50'}`}
                      onClick={() => setSelectedIdentityKey(row.identityKey)}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="text-sm font-semibold text-stone-950">{row.displayName}</div>
                            <Badge className={OPERATOR_STATUS_CLASS[status.tone]}>
                              {status.label}
                            </Badge>
                            {row.bootstrapAdmin && (
                              <Badge className="bg-stone-900 text-white">기본 관리자 후보</Badge>
                            )}
                          </div>
                          <div className="text-sm text-stone-600">{row.email}</div>
                          <div className="text-xs text-stone-500">{status.description}</div>
                          <div className="flex flex-wrap items-center gap-2 text-xs">
                            <SourceBadge ok={Boolean(row.authUid)} label={row.authUid ? '로그인 계정 연결됨' : '로그인 계정 없음'} />
                            <SourceBadge ok={Boolean(row.canonicalMember)} label={row.canonicalMember ? '직원 권한 기록 있음' : '직원 권한 기록 없음'} />
                            <Badge className="bg-stone-100 text-stone-700">예전 기록 {row.legacyMembers.length}건</Badge>
                            <Badge className={ROLE_BADGE_CLASS[row.effectiveRole] || 'bg-stone-200 text-stone-900'}>
                              {getCurrentGovernancePermissionLabel(row, roleLabel)}
                            </Badge>
                            {row.claimRole && (
                              <Badge className="bg-stone-100 text-stone-700">로그인 권한 {roleLabel(row.claimRole)}</Badge>
                            )}
                          </div>
                          {issueLabels.length > 0 && (
                            <div className="flex flex-wrap gap-1.5">
                              {issueLabels.map((label) => (
                                <Badge key={label} className="bg-white text-red-700 border border-stone-300">
                                  {label}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-2">
                          <Select
                            value={role}
                            onValueChange={(value) => setDraftRoles((prev) => ({ ...prev, [row.identityKey]: value as UserRole }))}
                          >
                            <SelectTrigger
                              className="h-9 w-[140px] border-stone-300 bg-white"
                              onClick={(event) => event.stopPropagation()}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {ROLE_OPTIONS.map((item) => (
                                <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            size="sm"
                            className="h-9 min-w-[140px] bg-stone-900 text-white hover:bg-stone-800"
                            onClick={(event) => {
                              event.stopPropagation();
                              void handleDeepSync(row);
                            }}
                            disabled={syncingIdentityKey === row.identityKey}
                          >
                            {syncingIdentityKey === row.identityKey ? (
                              <>
                                <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" />
                                반영 중
                              </>
                            ) : (
                              <>
                                <GitMerge className="mr-2 h-3.5 w-3.5" />
                                권한 반영
                              </>
                            )}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {!loading && filteredRows.length === 0 && (
                  <div className="px-4 py-16 text-center text-sm text-stone-500">
                    조건에 맞는 정렬 대상이 없습니다.
                  </div>
                )}
              </div>
            </ScrollArea>
          </CardContent>
        </Card>

        <Card className="border-stone-200">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-semibold text-stone-900">선택한 사용자</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {!selectedRow ? (
              <div className="text-sm text-stone-500">사용자를 선택하면 권한 상태를 보여줍니다.</div>
            ) : (
              <>
                {(() => {
                  const status = getGovernanceOperatorStatus(selectedRow);
                  return (
                    <div className={`rounded-xl px-4 py-3 text-sm ${OPERATOR_STATUS_CLASS[status.tone]}`}>
                      <div className="font-semibold">{status.label}</div>
                      <div className="mt-1">{status.description}</div>
                    </div>
                  );
                })()}

                <div className="space-y-1">
                  <div className="text-base font-semibold text-stone-950">{selectedRow.displayName}</div>
                  <div className="text-sm text-stone-600">{selectedRow.email}</div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Badge className={ROLE_BADGE_CLASS[selectedRow.effectiveRole] || 'bg-stone-200 text-stone-900'}>
                    {getCurrentGovernancePermissionLabel(selectedRow, roleLabel)}
                  </Badge>
                  <Badge className="bg-stone-100 text-stone-700">
                    반영할 권한 {roleLabel(draftRoles[selectedRow.identityKey] || getRecommendedGovernanceRole(selectedRow))}
                  </Badge>
                </div>

                <Separator />
                {authUser && <PeopleAccountLink key={selectedRow.identityKey} identityKey={selectedRow.identityKey} email={selectedRow.email} actor={authUser} tenantId={orgId} onLinked={loadGovernance} />}

                <div className="space-y-3">
                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                      <KeyRound className="h-3.5 w-3.5" />
                      로그인 계정
                    </div>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                      <div>UID: {selectedRow.authUid || '-'}</div>
                      <div>로그인 권한: {roleLabel(selectedRow.claimRole)}</div>
                      <div>조직: {selectedRow.claimTenantId || '-'}</div>
                      <div>로그인 상태: {selectedRow.authUid ? (selectedRow.authDisabled ? '비활성' : '활성') : '계정 없음'}</div>
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                      <Database className="h-3.5 w-3.5" />
                      직원 권한 기록
                    </div>
                    <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                      {selectedRow.canonicalMember ? (
                        <>
                          <div>docId: {selectedRow.canonicalMember.docId}</div>
                          <div>권한: {roleLabel(selectedRow.canonicalMember.role)}</div>
                          <div>상태: {statusLabel(selectedRow.canonicalMember.status)}</div>
                          <div>이름: {selectedRow.canonicalMember.name || '-'}</div>
                        </>
                      ) : (
                        <div>직원 권한 기록이 없습니다.</div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                      <GitMerge className="h-3.5 w-3.5" />
                      예전 권한 기록
                    </div>
                    <div className="space-y-2">
                      {selectedRow.legacyMembers.length > 0 ? selectedRow.legacyMembers.map((member) => (
                        <div key={member.docId} className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                          <div>docId: {member.docId}</div>
                          <div>권한: {roleLabel(member.role)}</div>
                          <div>상태: {statusLabel(member.status)}</div>
                          <div>이름: {member.name || '-'}</div>
                        </div>
                      )) : (
                        <div className="rounded-xl border border-dashed border-stone-200 bg-white p-3 text-sm text-stone-500">
                          예전 권한 기록은 없습니다.
                        </div>
                      )}
                    </div>
                  </div>

                  <div>
                    <div className="mb-1 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-stone-500">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      조치가 필요한 이유
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {getFriendlyGovernanceIssueLabels(selectedRow).length > 0 ? getFriendlyGovernanceIssueLabels(selectedRow).map((label) => (
                        <Badge key={label} className="bg-white text-red-700 border border-stone-300">
                          {label}
                        </Badge>
                      )) : (
                        <Badge className="bg-white text-stone-700 border border-stone-300">
                          <CheckCircle2 className="mr-1 h-3 w-3" />
                          drift 없음
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                <Separator />

                <div className="rounded-xl border border-stone-200 bg-stone-50 p-3 text-sm text-stone-700">
                  <div className="font-medium text-stone-900">권한 반영을 누르면</div>
                  <div className="mt-2 space-y-1">
                    <div>1. 로그인 권한을 선택한 권한으로 저장합니다.</div>
                    <div>2. 직원 권한 기록과 예전 기록을 같은 값으로 맞춥니다.</div>
                    <div>3. 다음 로그인부터 같은 권한으로 들어오게 합니다.</div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="text-xs text-stone-500">
                    반영할 권한은 {roleLabel(draftRoles[selectedRow.identityKey] || getRecommendedGovernanceRole(selectedRow))} 입니다.
                  </div>
                  <Button
                    className="bg-stone-900 text-white hover:bg-stone-800"
                    onClick={() => void handleDeepSync(selectedRow)}
                    disabled={syncingIdentityKey === selectedRow.identityKey}
                  >
                    {syncingIdentityKey === selectedRow.identityKey ? '반영 중...' : '선택 사용자 권한 반영'}
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
