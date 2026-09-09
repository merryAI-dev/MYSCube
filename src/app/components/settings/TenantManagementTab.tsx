import { useCallback, useEffect, useState } from 'react';
import { Building2, Check, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { Firestore } from 'firebase/firestore';
import {
  collection, deleteDoc, doc, getDocs, limit, query, serverTimestamp, setDoc, where,
} from 'firebase/firestore';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Badge } from '../ui/badge';
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from '../ui/card';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../ui/table';
import { Separator } from '../ui/separator';
import { toast } from 'sonner';
import { isValidTenantId } from '../../platform/tenant';
import {
  mergeTenantRegistryEntries,
  type TenantRegistryEntry,
} from '../../platform/tenant-registry';
import { useFirebase } from '../../lib/firebase-context';

// ── Types ──

type TenantDoc = TenantRegistryEntry;

// ── Firestore helpers ──

function tenantRegistryCollection(db: Firestore, orgId: string) {
  return collection(db, 'orgs', orgId, 'tenant_registry');
}

async function fetchTenants(db: Firestore, adminOrgId: string): Promise<TenantDoc[]> {
  const snap = await getDocs(query(tenantRegistryCollection(db, adminOrgId), where('adminOrgId', '==', adminOrgId), limit(100)));
  return mergeTenantRegistryEntries(adminOrgId, snap.docs.map((d) => ({
    id: d.id,
    name: (d.data().name as string | undefined) || d.id,
    adminOrgId: d.data().adminOrgId as string | undefined,
    createdAt: (d.data().createdAt as any)?.toDate?.()?.toISOString?.() || '',
    protected: d.data().protected === true,
    branding: d.data().branding as TenantDoc['branding'],
  })));
}

async function createTenant(db: Firestore, adminOrgId: string, id: string, name: string): Promise<void> {
  await setDoc(doc(tenantRegistryCollection(db, adminOrgId), id), {
    id,
    name: name || id,
    adminOrgId,
    createdAt: serverTimestamp(),
    protected: false,
    branding: {},
  });
}

async function removeTenant(db: Firestore, adminOrgId: string, id: string): Promise<void> {
  await deleteDoc(doc(tenantRegistryCollection(db, adminOrgId), id));
}

// ── Component ──

export function TenantManagementTab() {
  const { db, orgId } = useFirebase();
  const [tenants, setTenants] = useState<TenantDoc[]>([]);
  const [loading, setLoading] = useState(false);
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [creating, setCreating] = useState(false);
  const [idError, setIdError] = useState('');

  const loadTenants = useCallback(async () => {
    if (!db) return;
    setLoading(true);
    try {
      const list = await fetchTenants(db, orgId);
      setTenants(list);
    } catch (err: any) {
      toast.error('조직 목록 로드 실패: ' + (err.message || ''));
    } finally {
      setLoading(false);
    }
  }, [db, orgId]);

  useEffect(() => { void loadTenants(); }, [loadTenants]);

  const handleCreate = useCallback(async () => {
    const id = newId.trim().toLowerCase();
    if (!isValidTenantId(id)) {
      setIdError('소문자 영문/숫자/-만 허용, 2~32자');
      return;
    }
    setIdError('');
    if (!db) return;
    setCreating(true);
    try {
      await createTenant(db, orgId, id, newName.trim() || id);
      toast.success(`조직 "${id}" 등록 완료`);
      setNewId('');
      setNewName('');
      await loadTenants();
    } catch (err: any) {
      toast.error('등록 실패: ' + (err.message || ''));
    } finally {
      setCreating(false);
    }
  }, [db, newId, newName, loadTenants]);

  const handleDelete = useCallback(async (id: string) => {
    const target = tenants.find((tenant) => tenant.id === id);
    if (target?.protected) { toast.error('보호된 조직은 삭제할 수 없습니다'); return; }
    if (id === orgId) { toast.error('현재 활성 조직은 삭제할 수 없습니다'); return; }
    if (!db) return;
    try {
      await removeTenant(db, orgId, id);
      toast.success(`조직 "${id}" 삭제됨`);
      setTenants((prev) => prev.filter((t) => t.id !== id));
    } catch (err: any) {
      toast.error('삭제 실패: ' + (err.message || ''));
    }
  }, [db, orgId, tenants]);

  return (
    <div className="space-y-6">
      {/* Register new tenant */}
      <Card>
        <CardHeader>
          <CardTitle className="text-[15px]">신규 조직 등록</CardTitle>
          <CardDescription className="text-[12px]">
            새 조직을 플랫폼에 온보딩합니다. 조직 ID는 변경 불가하므로 신중히 입력하세요.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="tenant-id" className="text-[12px]">
                조직 ID <span className="text-destructive">*</span>
              </Label>
              <Input
                id="tenant-id"
                value={newId}
                onChange={(e) => { setNewId(e.target.value); setIdError(''); }}
                placeholder="예: acme-corp"
                className="font-mono text-[13px] h-8"
              />
              {idError && <p className="text-[11px] text-destructive">{idError}</p>}
              <p className="text-[10px] text-muted-foreground">소문자 영문, 숫자, 하이픈(-) 2~32자</p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tenant-name" className="text-[12px]">조직 이름</Label>
              <Input
                id="tenant-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="예: ACME 주식회사"
                className="text-[13px] h-8"
              />
              <p className="text-[10px] text-muted-foreground">미입력 시 ID와 동일하게 설정됩니다</p>
            </div>
          </div>
          <Button
            onClick={handleCreate}
            disabled={creating || !newId}
            size="sm"
            className="gap-1.5"
          >
            {creating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            조직 등록
          </Button>
        </CardContent>
      </Card>

      {/* Tenant list */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between py-3">
          <div>
            <CardTitle className="text-[15px]">등록된 조직</CardTitle>
            <CardDescription className="text-[12px]">플랫폼에 등록된 조직 목록</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-7 gap-1.5 text-[11px]"
            onClick={loadTenants}
            disabled={loading}
          >
            {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
            새로고침
          </Button>
        </CardHeader>
        <CardContent className="p-0">
          {loading && tenants.length === 0 ? (
            <div className="flex items-center justify-center py-8 text-[12px] text-muted-foreground gap-2">
              <Loader2 className="w-4 h-4 animate-spin" /> 로딩 중...
            </div>
          ) : tenants.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-[12px] text-muted-foreground gap-2">
              <Building2 className="w-8 h-8 opacity-20" />
              <p>등록된 조직이 없습니다.</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-[11px] w-40">조직 ID</TableHead>
                  <TableHead className="text-[11px]">조직 이름</TableHead>
                  <TableHead className="text-[11px]">등록일</TableHead>
                  <TableHead className="text-[11px] w-20">상태</TableHead>
                  <TableHead className="text-[11px] w-16" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {tenants.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-mono text-[12px]">{t.id}</TableCell>
                    <TableCell className="text-[12px]">{t.name}</TableCell>
                    <TableCell className="text-[11px] text-muted-foreground">
                      {t.createdAt ? new Date(t.createdAt).toLocaleDateString('ko-KR') : '-'}
                    </TableCell>
                    <TableCell>
                      {t.id === orgId
                        ? <Badge variant="default" className="text-[10px] gap-1"><Check className="w-2.5 h-2.5" />활성</Badge>
                        : <Badge variant="secondary" className="text-[10px]">대기</Badge>
                      }
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                        disabled={t.protected || t.id === orgId}
                        title={t.protected ? '보호된 조직은 삭제 불가' : t.id === orgId ? '활성 조직은 삭제 불가' : '삭제'}
                        onClick={() => void handleDelete(t.id)}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
