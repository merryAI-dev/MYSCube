import React, { useEffect, useMemo, useState } from 'react';
import {
  Settings, Users, Building2, Network, Shield, Search, Save, Trash2,
} from 'lucide-react';
import { toast } from 'sonner';
import { ROLE_META } from '../../platform/role-meta';
import { OrganizationSettingsTab } from './OrganizationSettingsTab';
import { useLocation, useNavigate } from 'react-router';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import { useAppStore } from '../../data/store';
import { TenantManagementTab } from './TenantManagementTab';
import { PageHeader } from '../layout/PageHeader';
import { useAuth } from '../../data/auth-store';
import { MyscWordmark } from '../brand/MyscWordmark';

const DISPLAY_ROLES = ['admin', 'finance', 'pm'] as const;
type DisplayRole = typeof DISPLAY_ROLES[number];
const PRIMARY_SETTINGS_TABS = ['members', 'tenants', 'organizations'] as const;
const PRIMARY_SETTINGS_TAB_SET = new Set<string>(PRIMARY_SETTINGS_TABS);

export function SettingsPage() {
  const { org, members, upsertMember, removeMember } = useAppStore();
  const { isAuthenticated, isLoading: authLoading, user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const requestedTab = searchParams.get('tab') || 'members';
  const initialTab = PRIMARY_SETTINGS_TAB_SET.has(requestedTab) ? requestedTab : 'members';
  const [tab, setTab] = useState(initialTab);
  const [memberSearch, setMemberSearch] = useState('');
  const [savingMember, setSavingMember] = useState(false);
  const [memberDraft, setMemberDraft] = useState({
    uid: '',
    name: '',
    email: '',
    role: 'pm' as DisplayRole,
  });
  const currentPath = `${location.pathname}${location.search}${location.hash}`;
  const settingsAccessBlocked = Boolean(isAuthenticated && user && user.role !== 'admin');
  const filteredMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return members;
    return members.filter((member) => [
      member.name,
      member.email,
      member.uid,
      ROLE_META[member.role]?.label,
      member.role,
    ].some((value) => String(value || '').toLowerCase().includes(query)));
  }, [memberSearch, members]);

  const resetMemberDraft = () => {
    setMemberDraft({ uid: '', name: '', email: '', role: 'pm' });
  };

  const handleSaveMember = async () => {
    const uid = memberDraft.uid.trim();
    const name = memberDraft.name.trim();
    const email = memberDraft.email.trim().toLowerCase();
    if (!uid || !name || !email) {
      toast.error('UID, 이름, 이메일을 모두 입력해 주세요.');
      return;
    }

    setSavingMember(true);
    try {
      await upsertMember({
        uid,
        name,
        email,
        role: memberDraft.role,
        status: 'ACTIVE',
      });
      toast.success('구성원 원장을 저장했습니다.');
      resetMemberDraft();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '구성원 원장 저장에 실패했습니다.');
    } finally {
      setSavingMember(false);
    }
  };

  const handleRemoveMember = async (uid: string, name: string) => {
    if (!window.confirm(`${name || uid} 구성원을 원장에서 제거할까요?`)) return;
    try {
      await removeMember(uid);
      toast.success('구성원 원장에서 제거했습니다.');
      if (memberDraft.uid === uid) resetMemberDraft();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '구성원 제거에 실패했습니다.');
    }
  };

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      navigate('/login', { replace: true, state: { from: currentPath } });
    }
  }, [authLoading, currentPath, isAuthenticated, navigate]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  if (authLoading || !isAuthenticated) return null;
  if (!user) return null;

  if (settingsAccessBlocked) {
    return (
      <div className="space-y-5">
        <PageHeader
          icon={Shield}
          iconGradient="linear-gradient(135deg, #001e46, #001e46)"
          title="설정 접근 권한이 없습니다"
          description="운영 설정은 관리자만 변경할 수 있습니다. 현재 URL은 유지했습니다."
        />
        <Card className="border-slate-200 bg-white">
          <CardContent className="p-5 text-sm text-slate-600">
            필요한 경우 관리자에게 권한 확인을 요청해 주세요.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={Settings}
        iconGradient="linear-gradient(135deg, #001e46, #001e46)"
        title="관리자 DB"
        description="관리자에게 필요한 멤버DB와 조직DB만 관리합니다"
      />

      <div className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <MyscWordmark size="sm" />
            <div className="hidden h-7 w-px bg-slate-200 sm:block" />
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-900">{org.name}</p>
              <p className="truncate text-[11px] text-slate-500">{org.id}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-medium text-slate-500">구성원</p>
              <p className="text-sm font-semibold tabular-nums text-primary">{members.length}명</p>
            </div>
            <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
              <p className="text-[10px] font-medium text-slate-500">현재 조직</p>
              <p className="text-sm font-semibold tabular-nums text-primary">{org.id}</p>
            </div>
          </div>
        </div>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="w-full justify-start overflow-x-auto rounded-lg border border-slate-200 bg-white p-1 shadow-sm">
          <TabsTrigger value="members" className="flex-none rounded-md px-3 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Users className="w-3.5 h-3.5" /> 멤버DB
          </TabsTrigger>
          <TabsTrigger value="tenants" className="flex-none rounded-md px-3 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Building2 className="w-3.5 h-3.5" /> 조직DB
          </TabsTrigger>
          <TabsTrigger value="organizations" className="flex-none rounded-md px-3 text-xs data-[state=active]:bg-primary data-[state=active]:text-primary-foreground">
            <Network className="w-3.5 h-3.5" /> 소속·직급
          </TabsTrigger>
        </TabsList>

        {/* 소속·직급: 인력 명부와 프로젝트 담당조직이 함께 뻗어 나오는 뿌리다. */}
        <TabsContent value="organizations">
          <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
            <CardContent className="p-4">
              <OrganizationSettingsTab />
            </CardContent>
          </Card>
        </TabsContent>

        {/* Members */}
        <TabsContent value="members">
          <div className="space-y-4">
              <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
                <CardHeader className="border-b border-slate-100 pb-4">
                  <div className="flex items-center justify-between gap-3">
                    <CardTitle className="text-base">구성원 원장 추가/수정</CardTitle>
                    <Badge variant="outline" className="border-slate-300 text-[11px] text-slate-700">
                      {memberDraft.uid ? '수정' : '신규'}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="grid gap-3 pt-5 md:grid-cols-2 xl:grid-cols-1">
                  <div>
                    <Label className="text-xs">UID *</Label>
                    <Input
                      value={memberDraft.uid}
                      onChange={(event) => setMemberDraft((prev) => ({ ...prev, uid: event.target.value }))}
                      placeholder="Firebase UID"
                      className="mt-1 border-slate-300"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">이름 *</Label>
                    <Input
                      value={memberDraft.name}
                      onChange={(event) => setMemberDraft((prev) => ({ ...prev, name: event.target.value }))}
                      placeholder="홍길동(닉네임)"
                      className="mt-1 border-slate-300"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">이메일 *</Label>
                    <Input
                      value={memberDraft.email}
                      onChange={(event) => setMemberDraft((prev) => ({ ...prev, email: event.target.value }))}
                      placeholder="name@mysc.co.kr"
                      className="mt-1 border-slate-300"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">역할</Label>
                    <Select value={memberDraft.role} onValueChange={(value) => setMemberDraft((prev) => ({ ...prev, role: value as DisplayRole }))}>
                      <SelectTrigger className="mt-1 h-9 border-slate-300 bg-white">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DISPLAY_ROLES.map((role) => (
                          <SelectItem key={role} value={role}>{ROLE_META[role]?.label ?? role}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex gap-2 md:col-span-2 xl:col-span-1">
                    <Button type="button" onClick={() => void handleSaveMember()} disabled={savingMember} className="flex-1 gap-2">
                      <Save className="h-4 w-4" /> 저장
                    </Button>
                    <Button type="button" variant="outline" onClick={resetMemberDraft}>
                      초기화
                    </Button>
                  </div>
                </CardContent>
              </Card>

            <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
              <CardHeader className="border-b border-slate-100 pb-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <CardTitle className="text-base">구성원 원장 ({members.length}명)</CardTitle>
                  </div>
                  <div className="relative w-full lg:w-[320px]">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                    <Input
                      value={memberSearch}
                      onChange={(event) => setMemberSearch(event.target.value)}
                      placeholder="이름, 이메일, UID 검색"
                      className="h-9 border-slate-300 pl-9"
                    />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="pt-5">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>이름</TableHead>
                    <TableHead>이메일</TableHead>
                    <TableHead>역할</TableHead>
                    <TableHead>UID</TableHead>
                    <TableHead className="w-[160px] text-right">관리</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredMembers.map(m => (
                    <TableRow key={m.uid}>
                      <TableCell style={{ fontWeight: 500 }}>{m.name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{m.email}</TableCell>
                      <TableCell>
                        <span className={`text-xs px-2 py-0.5 rounded ${ROLE_META[m.role]?.badgeClass ?? ''}`}>
                          {ROLE_META[m.role]?.label ?? m.role}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground font-mono">{m.uid}</TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            onClick={() => setMemberDraft({
                              uid: m.uid,
                              name: m.name,
                              email: m.email || '',
                              role: DISPLAY_ROLES.includes(m.role as DisplayRole) ? m.role as DisplayRole : 'pm',
                            })}
                          >
                            수정
                          </Button>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="border-slate-300 text-red-700 hover:text-red-700"
                            onClick={() => void handleRemoveMember(m.uid, m.name)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tenants */}
        <TabsContent value="tenants">
          <TenantManagementTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
