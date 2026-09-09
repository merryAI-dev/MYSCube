import { useState, useMemo } from 'react';
import {
  Plus, Search, Filter, ChevronDown, ChevronRight,
  FileText, Wallet, ArrowUpRight, ArrowDownRight,
  Clock, CheckCircle2, XCircle, AlertTriangle,
  Upload, Paperclip, Trash2, Edit3, Eye,
  Copy, Send, MoreHorizontal, Calendar,
  CreditCard, Banknote, CircleDollarSign, Receipt,
  ListFilter, LayoutGrid, LayoutList, X,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Separator } from '../ui/separator';
import { ScrollArea } from '../ui/scroll-area';
import { Textarea } from '../ui/textarea';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '../ui/dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '../ui/tooltip';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { PageHeader } from '../layout/PageHeader';
import {
  EXPENSE_SETS, BUDGET_CODE_BOOK,
  EXPENSE_STATUS_LABELS, EXPENSE_STATUS_COLORS,
  EVIDENCE_STATUS_LABELS, EVIDENCE_STATUS_COLORS,
  PAYMENT_METHOD_MAP,
  fmtKRW, fmtShort,
  type ExpenseSet, type ExpenseSetStatus, type ExpenseItem,
} from '../../data/budget-data';
import { useAppStore } from '../../data/store';

// ═══════════════════════════════════════════════════════════════
// ExpenseManagementPage — 사업비 관리/입력
// 관리자 이외의 회원들이 세트를 만들고 관리할 수 있음
// ═══════════════════════════════════════════════════════════════

type ViewMode = 'list' | 'grid';
type FilterStatus = ExpenseSetStatus | 'ALL';

export function ExpenseManagementPage() {
  const { projects, currentUser } = useAppStore();
  const [sets, setSets] = useState<ExpenseSet[]>(EXPENSE_SETS);
  const [searchText, setSearchText] = useState('');
  const [filterStatus, setFilterStatus] = useState<FilterStatus>('ALL');
  const [filterProject, setFilterProject] = useState('ALL');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [selectedSet, setSelectedSet] = useState<ExpenseSet | null>(null);
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showItemDialog, setShowItemDialog] = useState(false);
  const [editingItem, setEditingItem] = useState<ExpenseItem | null>(null);
  const [rejectDialog, setRejectDialog] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  // 새 세트 폼
  const [newSetForm, setNewSetForm] = useState({
    projectId: '',
    title: '',
    period: '',
  });

  // 새 항목 폼
  const [itemForm, setItemForm] = useState<Partial<ExpenseItem>>({
    date: '',
    budgetCode: '',
    subCode: '',
    vendor: '',
    description: '',
    amountNet: 0,
    vat: 0,
    amountGross: 0,
    paymentMethod: 'BANK_TRANSFER',
    note: '',
  });

  // 필터링된 세트
  const filteredSets = useMemo(() => {
    return sets.filter(s => {
      if (filterStatus !== 'ALL' && s.status !== filterStatus) return false;
      if (filterProject !== 'ALL' && s.projectId !== filterProject) return false;
      if (searchText) {
        const q = searchText.toLowerCase();
        if (!s.title.toLowerCase().includes(q) && !s.createdByName.toLowerCase().includes(q)) return false;
      }
      return true;
    });
  }, [sets, filterStatus, filterProject, searchText]);

  // KPI 계산
  const kpi = useMemo(() => {
    const total = sets.length;
    const draft = sets.filter(s => s.status === 'DRAFT').length;
    const submitted = sets.filter(s => s.status === 'SUBMITTED').length;
    const approved = sets.filter(s => s.status === 'APPROVED').length;
    const rejected = sets.filter(s => s.status === 'REJECTED').length;
    const totalAmount = sets.reduce((sum, s) => sum + s.totalGross, 0);
    const approvedAmount = sets.filter(s => s.status === 'APPROVED').reduce((sum, s) => sum + s.totalGross, 0);
    return { total, draft, submitted, approved, rejected, totalAmount, approvedAmount };
  }, [sets]);

  // 프로젝트 맵
  const projectMap = useMemo(() => {
    const m = new Map<string, string>();
    projects.forEach(p => m.set(p.id, p.name));
    return m;
  }, [projects]);

  // 세트 생성
  const handleCreateSet = () => {
    if (!newSetForm.projectId || !newSetForm.title) return;
    const newSet: ExpenseSet = {
      id: `es-${Date.now()}`,
      projectId: newSetForm.projectId,
      ledgerId: '',
      title: newSetForm.title,
      createdBy: currentUser.uid,
      createdByName: currentUser.name,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'DRAFT',
      period: newSetForm.period,
      items: [],
      totalNet: 0,
      totalVat: 0,
      totalGross: 0,
    };
    setSets(prev => [newSet, ...prev]);
    setShowCreateDialog(false);
    setNewSetForm({ projectId: '', title: '', period: '' });
    setSelectedSet(newSet);
  };

  // 항목 추가/수정
  const handleSaveItem = () => {
    if (!selectedSet || !itemForm.date || !itemForm.vendor) return;
    const net = Number(itemForm.amountNet) || 0;
    const vat = Number(itemForm.vat) || 0;
    const gross = net + vat;

    const newItem: ExpenseItem = {
      id: editingItem?.id || `ei-${Date.now()}`,
      setId: selectedSet.id,
      date: itemForm.date || '',
      budgetCode: itemForm.budgetCode || '',
      subCode: itemForm.subCode || '',
      vendor: itemForm.vendor || '',
      description: itemForm.description || '',
      amountNet: net,
      vat,
      amountGross: gross,
      paymentMethod: (itemForm.paymentMethod as any) || 'BANK_TRANSFER',
      evidenceStatus: 'MISSING',
      evidenceFiles: editingItem?.evidenceFiles || [],
      note: itemForm.note || '',
    };

    setSets(prev => prev.map(s => {
      if (s.id !== selectedSet.id) return s;
      const items = editingItem
        ? s.items.map(it => it.id === editingItem.id ? newItem : it)
        : [...s.items, newItem];
      const totalNet = items.reduce((sum, it) => sum + it.amountNet, 0);
      const totalVat = items.reduce((sum, it) => sum + it.vat, 0);
      return { ...s, items, totalNet, totalVat, totalGross: totalNet + totalVat, updatedAt: new Date().toISOString() };
    }));

    // Update selectedSet
    setSelectedSet(prev => {
      if (!prev) return prev;
      const items = editingItem
        ? prev.items.map(it => it.id === editingItem.id ? newItem : it)
        : [...prev.items, newItem];
      const totalNet = items.reduce((sum, it) => sum + it.amountNet, 0);
      const totalVat = items.reduce((sum, it) => sum + it.vat, 0);
      return { ...prev, items, totalNet, totalVat, totalGross: totalNet + totalVat };
    });

    setShowItemDialog(false);
    setEditingItem(null);
    resetItemForm();
  };

  // 항목 삭제
  const handleDeleteItem = (itemId: string) => {
    if (!selectedSet) return;
    setSets(prev => prev.map(s => {
      if (s.id !== selectedSet.id) return s;
      const items = s.items.filter(it => it.id !== itemId);
      const totalNet = items.reduce((sum, it) => sum + it.amountNet, 0);
      const totalVat = items.reduce((sum, it) => sum + it.vat, 0);
      return { ...s, items, totalNet, totalVat, totalGross: totalNet + totalVat };
    }));
    setSelectedSet(prev => {
      if (!prev) return prev;
      const items = prev.items.filter(it => it.id !== itemId);
      const totalNet = items.reduce((sum, it) => sum + it.amountNet, 0);
      const totalVat = items.reduce((sum, it) => sum + it.vat, 0);
      return { ...prev, items, totalNet, totalVat, totalGross: totalNet + totalVat };
    });
  };

  // 상태 변경
  const handleChangeStatus = (setId: string, newStatus: ExpenseSetStatus, reason?: string) => {
    setSets(prev => prev.map(s => {
      if (s.id !== setId) return s;
      const updates: Partial<ExpenseSet> = { status: newStatus, updatedAt: new Date().toISOString() };
      if (newStatus === 'SUBMITTED') updates.submittedAt = new Date().toISOString();
      if (newStatus === 'APPROVED') { updates.approvedBy = currentUser.uid; updates.approvedAt = new Date().toISOString(); }
      if (newStatus === 'REJECTED') updates.rejectedReason = reason;
      return { ...s, ...updates };
    }));
    if (selectedSet?.id === setId) {
      setSelectedSet(prev => prev ? { ...prev, status: newStatus, updatedAt: new Date().toISOString() } : prev);
    }
  };

  // 복제
  const handleDuplicate = (set: ExpenseSet) => {
    const dup: ExpenseSet = {
      ...set,
      id: `es-dup-${Date.now()}`,
      title: `${set.title} (복사)`,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      createdBy: currentUser.uid,
      createdByName: currentUser.name,
      submittedAt: undefined,
      approvedBy: undefined,
      approvedAt: undefined,
      rejectedReason: undefined,
      items: set.items.map(it => ({ ...it, id: `ei-dup-${Date.now()}-${Math.random().toString(36).slice(2)}` })),
    };
    setSets(prev => [dup, ...prev]);
  };

  const resetItemForm = () => {
    setItemForm({
      date: '', budgetCode: '', subCode: '', vendor: '', description: '',
      amountNet: 0, vat: 0, amountGross: 0, paymentMethod: 'BANK_TRANSFER', note: '',
    });
  };

  // VAT 자동 계산
  const handleAmountNetChange = (val: string) => {
    const net = Number(val) || 0;
    const vat = Math.round(net * 0.1);
    setItemForm(prev => ({ ...prev, amountNet: net, vat, amountGross: net + vat }));
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-5">
        {/* Header */}
        <PageHeader
          icon={Wallet}
          iconGradient="linear-gradient(135deg, #0891b2 0%, #0f766e 100%)"
          title="사업비 관리"
          description="사업비 지출 세트를 생성하고 항목별 증빙·승인을 관리합니다"
          badge={`${kpi.total}건`}
          actions={
            <Button
              size="sm"
              className="h-8 text-[12px] gap-1.5"
              onClick={() => setShowCreateDialog(true)}
            >
              <Plus className="w-3.5 h-3.5" />
              새 사업비 세트
            </Button>
          }
        />

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          {[
            { label: '작성중', count: kpi.draft, color: '#64748b', icon: Edit3 },
            { label: '제출완료', count: kpi.submitted, color: '#3b82f6', icon: Send },
            { label: '승인', count: kpi.approved, color: '#059669', icon: CheckCircle2 },
            { label: '반려', count: kpi.rejected, color: '#e11d48', icon: XCircle },
            { label: '총 금액', count: null, amount: fmtShort(kpi.totalAmount), color: '#0891b2', icon: CircleDollarSign },
          ].map(k => (
            <Card key={k.label}>
              <CardContent className="p-3 flex items-center gap-2.5">
                <div
                  className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
                  style={{ background: `${k.color}15` }}
                >
                  <k.icon className="w-3.5 h-3.5" style={{ color: k.color }} />
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">{k.label}</p>
                  <p className="text-[15px]" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {k.count !== null ? k.count : k.amount}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Filter Bar */}
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  value={searchText}
                  onChange={e => setSearchText(e.target.value)}
                  placeholder="세트명, 작성자 검색..."
                  className="h-8 pl-8 text-[12px]"
                />
              </div>

              <Select value={filterStatus} onValueChange={v => setFilterStatus(v as FilterStatus)}>
                <SelectTrigger className="h-8 w-[130px] text-[12px]">
                  <SelectValue placeholder="상태" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">전체 상태</SelectItem>
                  <SelectItem value="DRAFT">작성중</SelectItem>
                  <SelectItem value="SUBMITTED">제출완료</SelectItem>
                  <SelectItem value="APPROVED">승인</SelectItem>
                  <SelectItem value="REJECTED">반려</SelectItem>
                </SelectContent>
              </Select>

              <Select value={filterProject} onValueChange={v => setFilterProject(v)}>
                <SelectTrigger className="h-8 w-[180px] text-[12px]">
                  <SelectValue placeholder="프로젝트" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL">전체 프로젝트</SelectItem>
                  {projects.slice(0, 10).map(p => (
                    <SelectItem key={p.id} value={p.id}>{p.name.length > 25 ? p.name.slice(0, 25) + '...' : p.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Separator orientation="vertical" className="h-5 mx-1" />

              <div className="flex items-center border border-border rounded-md">
                <button
                  className={`p-1.5 transition-colors ${viewMode === 'list' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setViewMode('list')}
                >
                  <LayoutList className="w-3.5 h-3.5" />
                </button>
                <button
                  className={`p-1.5 transition-colors ${viewMode === 'grid' ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                  onClick={() => setViewMode('grid')}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Main Content */}
        <div className="flex gap-4">
          {/* 좌: 세트 리스트 */}
          <div className={selectedSet ? 'w-[380px] shrink-0' : 'w-full'}>
            {viewMode === 'list' ? (
              <SetListView
                sets={filteredSets}
                selectedId={selectedSet?.id}
                projectMap={projectMap}
                onSelect={s => setSelectedSet(s)}
                onDuplicate={handleDuplicate}
                onChangeStatus={handleChangeStatus}
                onReject={id => { setRejectDialog(id); setRejectReason(''); }}
                currentUserRole={currentUser.role}
              />
            ) : (
              <SetGridView
                sets={filteredSets}
                selectedId={selectedSet?.id}
                projectMap={projectMap}
                onSelect={s => setSelectedSet(s)}
              />
            )}
          </div>

          {/* 우: 선택된 세트 상세 */}
          {selectedSet && (
            <div className="flex-1 min-w-0">
              <SetDetail
                set={selectedSet}
                projectMap={projectMap}
                onClose={() => setSelectedSet(null)}
                onAddItem={() => { resetItemForm(); setEditingItem(null); setShowItemDialog(true); }}
                onEditItem={(item) => {
                  setEditingItem(item);
                  setItemForm({
                    date: item.date,
                    budgetCode: item.budgetCode,
                    subCode: item.subCode,
                    vendor: item.vendor,
                    description: item.description,
                    amountNet: item.amountNet,
                    vat: item.vat,
                    amountGross: item.amountGross,
                    paymentMethod: item.paymentMethod,
                    note: item.note,
                  });
                  setShowItemDialog(true);
                }}
                onDeleteItem={handleDeleteItem}
                onChangeStatus={(newStatus) => handleChangeStatus(selectedSet.id, newStatus)}
                currentUserRole={currentUser.role}
              />
            </div>
          )}
        </div>

        {/* ── 새 세트 생성 다이얼로그 ── */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle className="text-[14px]">새 사업비 세트 만들기</DialogTitle>
            </DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <Label className="text-[12px]">프로젝트</Label>
                <Select value={newSetForm.projectId} onValueChange={v => setNewSetForm(prev => ({ ...prev, projectId: v }))}>
                  <SelectTrigger className="h-9 text-[12px] mt-1">
                    <SelectValue placeholder="프로젝트 선택" />
                  </SelectTrigger>
                  <SelectContent>
                    {projects.filter(p => p.status === 'IN_PROGRESS' || p.status === 'COMPLETED_PENDING_PAYMENT').map(p => (
                      <SelectItem key={p.id} value={p.id}>{p.name.length > 35 ? p.name.slice(0, 35) + '...' : p.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-[12px]">세트 제목</Label>
                <Input
                  value={newSetForm.title}
                  onChange={e => setNewSetForm(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="예: 2025년 3월 사업비 정산"
                  className="h-9 text-[12px] mt-1"
                />
              </div>
              <div>
                <Label className="text-[12px]">정산 기간</Label>
                <Input
                  value={newSetForm.period}
                  onChange={e => setNewSetForm(prev => ({ ...prev, period: e.target.value }))}
                  placeholder="예: 2025-03 또는 2025-Q1"
                  className="h-9 text-[12px] mt-1"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setShowCreateDialog(false)}>취소</Button>
              <Button size="sm" onClick={handleCreateSet} disabled={!newSetForm.projectId || !newSetForm.title}>생성</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── 항목 추가/수정 다이얼로그 ── */}
        <Dialog open={showItemDialog} onOpenChange={setShowItemDialog}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle className="text-[14px]">{editingItem ? '항목 수정' : '새 항목 추가'}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[11px]">지출일</Label>
                  <Input
                    type="date"
                    value={itemForm.date}
                    onChange={e => setItemForm(prev => ({ ...prev, date: e.target.value }))}
                    className="h-8 text-[12px] mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">결제방법</Label>
                  <Select value={itemForm.paymentMethod} onValueChange={v => setItemForm(prev => ({ ...prev, paymentMethod: v as any }))}>
                    <SelectTrigger className="h-8 text-[12px] mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="BANK_TRANSFER">계좌이체</SelectItem>
                      <SelectItem value="CARD">카드</SelectItem>
                      <SelectItem value="CASH">현금</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-[11px]">비목</Label>
                  <Select value={itemForm.budgetCode} onValueChange={v => setItemForm(prev => ({ ...prev, budgetCode: v, subCode: '' }))}>
                    <SelectTrigger className="h-8 text-[12px] mt-1">
                      <SelectValue placeholder="비목 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {BUDGET_CODE_BOOK.map(c => (
                        <SelectItem key={c.code} value={c.code}>{c.code}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-[11px]">세목</Label>
                  <Select value={itemForm.subCode} onValueChange={v => setItemForm(prev => ({ ...prev, subCode: v }))}>
                    <SelectTrigger className="h-8 text-[12px] mt-1">
                      <SelectValue placeholder="세목 선택" />
                    </SelectTrigger>
                    <SelectContent>
                      {BUDGET_CODE_BOOK.find(c => c.code === itemForm.budgetCode)?.subCodes.map(sc => (
                        <SelectItem key={sc} value={sc}>{sc}</SelectItem>
                      )) || []}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div>
                <Label className="text-[11px]">거래처</Label>
                <Input
                  value={itemForm.vendor}
                  onChange={e => setItemForm(prev => ({ ...prev, vendor: e.target.value }))}
                  className="h-8 text-[12px] mt-1"
                  placeholder="거래처명"
                />
              </div>
              <div>
                <Label className="text-[11px]">적요/내용</Label>
                <Input
                  value={itemForm.description}
                  onChange={e => setItemForm(prev => ({ ...prev, description: e.target.value }))}
                  className="h-8 text-[12px] mt-1"
                  placeholder="지출 내용"
                />
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <Label className="text-[11px]">공급가액</Label>
                  <Input
                    type="number"
                    value={itemForm.amountNet || ''}
                    onChange={e => handleAmountNetChange(e.target.value)}
                    className="h-8 text-[12px] mt-1"
                    placeholder="0"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">부가세 (자동)</Label>
                  <Input
                    type="number"
                    value={itemForm.vat || ''}
                    onChange={e => {
                      const v = Number(e.target.value) || 0;
                      setItemForm(prev => ({ ...prev, vat: v, amountGross: (prev.amountNet || 0) + v }));
                    }}
                    className="h-8 text-[12px] mt-1"
                  />
                </div>
                <div>
                  <Label className="text-[11px]">공급대가</Label>
                  <Input
                    type="number"
                    value={(Number(itemForm.amountNet) || 0) + (Number(itemForm.vat) || 0) || ''}
                    readOnly
                    className="h-8 text-[12px] mt-1 bg-muted"
                  />
                </div>
              </div>
              <div>
                <Label className="text-[11px]">비고</Label>
                <Textarea
                  value={itemForm.note}
                  onChange={e => setItemForm(prev => ({ ...prev, note: e.target.value }))}
                  className="text-[12px] mt-1 min-h-[60px]"
                  placeholder="비고사항 (선택)"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => { setShowItemDialog(false); setEditingItem(null); }}>취소</Button>
              <Button size="sm" onClick={handleSaveItem} disabled={!itemForm.date || !itemForm.vendor}>
                {editingItem ? '수정' : '추가'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* ── 반려 사유 다이얼로그 ── */}
        <Dialog open={!!rejectDialog} onOpenChange={open => !open && setRejectDialog(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-[14px]">반려 사유 입력</DialogTitle>
            </DialogHeader>
            <div className="py-2">
              <Label className="text-[12px]">반려 사유 (필수)</Label>
              <Textarea
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                className="mt-1 text-[12px] min-h-[80px]"
                placeholder="반려 사유를 입력해 주세요..."
              />
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setRejectDialog(null)}>취소</Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => {
                  if (rejectDialog && rejectReason.trim()) {
                    handleChangeStatus(rejectDialog, 'REJECTED', rejectReason);
                    setRejectDialog(null);
                  }
                }}
                disabled={!rejectReason.trim()}
              >
                반려
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}

// ═══════════════════════════════════════════════════════════════
// SetListView — 리스트 뷰
// ═══════════════════════════════════════════════════════════════

function SetListView({
  sets, selectedId, projectMap, onSelect, onDuplicate, onChangeStatus, onReject, currentUserRole,
}: {
  sets: ExpenseSet[];
  selectedId?: string;
  projectMap: Map<string, string>;
  onSelect: (s: ExpenseSet) => void;
  onDuplicate: (s: ExpenseSet) => void;
  onChangeStatus: (id: string, status: ExpenseSetStatus) => void;
  onReject: (id: string) => void;
  currentUserRole: string;
}) {
  if (sets.length === 0) {
    return (
      <Card className="p-8 text-center">
        <Receipt className="w-8 h-8 mx-auto text-muted-foreground/30 mb-2" />
        <p className="text-[13px] text-muted-foreground">사업비 세트가 없습니다</p>
        <p className="text-[11px] text-muted-foreground/60 mt-1">"새 사업비 세트" 버튼으로 생성해 보세요</p>
      </Card>
    );
  }

  return (
    <div className="space-y-2">
      {sets.map(s => {
        const isSelected = s.id === selectedId;
        const projectName = projectMap.get(s.projectId) || s.projectId;

        return (
          <Card
            key={s.id}
            className={`overflow-hidden cursor-pointer transition-all hover:shadow-sm ${isSelected ? 'ring-2 ring-primary/40 shadow-sm' : ''}`}
            onClick={() => onSelect(s)}
          >
            <CardContent className="p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-[12px] truncate" style={{ fontWeight: 600 }}>{s.title}</span>
                    <Badge className={`text-[9px] h-4 px-1.5 shrink-0 ${EXPENSE_STATUS_COLORS[s.status]}`}>
                      {EXPENSE_STATUS_LABELS[s.status]}
                    </Badge>
                  </div>
                  <p className="text-[10px] text-muted-foreground truncate">{projectName}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
                    <span>{s.createdByName}</span>
                    <span>{s.period}</span>
                    <span>{s.items.length}건</span>
                    <span className="ml-auto" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: '#0891b2' }}>
                      {fmtKRW(s.totalGross)}원
                    </span>
                  </div>
                </div>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="sm" className="h-6 w-6 p-0 shrink-0" onClick={e => e.stopPropagation()}>
                      <MoreHorizontal className="w-3.5 h-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="text-[12px]">
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onSelect(s); }}>
                      <Eye className="w-3.5 h-3.5 mr-2" /> 상세 보기
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDuplicate(s); }}>
                      <Copy className="w-3.5 h-3.5 mr-2" /> 복제
                    </DropdownMenuItem>
                    {s.status === 'DRAFT' && (
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onChangeStatus(s.id, 'SUBMITTED'); }}>
                        <Send className="w-3.5 h-3.5 mr-2" /> 제출
                      </DropdownMenuItem>
                    )}
                    {s.status === 'SUBMITTED' && (currentUserRole === 'admin' || currentUserRole === 'finance') && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onChangeStatus(s.id, 'APPROVED'); }}>
                          <CheckCircle2 className="w-3.5 h-3.5 mr-2 text-emerald-600" /> 승인
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onReject(s.id); }} className="text-rose-600">
                          <XCircle className="w-3.5 h-3.5 mr-2" /> 반려
                        </DropdownMenuItem>
                      </>
                    )}
                    {s.status === 'REJECTED' && (
                      <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onChangeStatus(s.id, 'DRAFT'); }}>
                        <Edit3 className="w-3.5 h-3.5 mr-2" /> 재작성
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>

              {/* 반려 사유 */}
              {s.status === 'REJECTED' && s.rejectedReason && (
                <div className="mt-2 p-2 rounded-md bg-rose-50 dark:bg-rose-950/30 border border-rose-200/60 dark:border-rose-800/40 text-[10px] text-rose-700 dark:text-rose-300">
                  <div className="flex items-center gap-1 mb-0.5" style={{ fontWeight: 600 }}>
                    <XCircle className="w-3 h-3" /> 반려 사유
                  </div>
                  {s.rejectedReason}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SetGridView — 그리드 뷰
// ═══════════════════════════════════════════════════════════════

function SetGridView({
  sets, selectedId, projectMap, onSelect,
}: {
  sets: ExpenseSet[];
  selectedId?: string;
  projectMap: Map<string, string>;
  onSelect: (s: ExpenseSet) => void;
}) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
      {sets.map(s => (
        <Card
          key={s.id}
          className={`overflow-hidden cursor-pointer transition-all hover:shadow-sm ${s.id === selectedId ? 'ring-2 ring-primary/40' : ''}`}
          onClick={() => onSelect(s)}
        >
          <CardContent className="p-4">
            <div className="flex items-center gap-2 mb-2">
              <Badge className={`text-[9px] h-4 px-1.5 ${EXPENSE_STATUS_COLORS[s.status]}`}>
                {EXPENSE_STATUS_LABELS[s.status]}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{s.period}</span>
            </div>
            <p className="text-[13px] mb-1 truncate" style={{ fontWeight: 600 }}>{s.title}</p>
            <p className="text-[10px] text-muted-foreground truncate mb-3">{projectMap.get(s.projectId)}</p>
            <div className="flex items-center justify-between text-[11px]">
              <span className="text-muted-foreground">{s.items.length}건 · {s.createdByName}</span>
              <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#0891b2' }}>{fmtKRW(s.totalGross)}원</span>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// SetDetail — 선택된 세트 상세
// ═══════════════════════════════════════════════════════════════

function SetDetail({
  set, projectMap, onClose, onAddItem, onEditItem, onDeleteItem, onChangeStatus, currentUserRole,
}: {
  set: ExpenseSet;
  projectMap: Map<string, string>;
  onClose: () => void;
  onAddItem: () => void;
  onEditItem: (item: ExpenseItem) => void;
  onDeleteItem: (id: string) => void;
  onChangeStatus: (status: ExpenseSetStatus) => void;
  currentUserRole: string;
}) {
  const isDraft = set.status === 'DRAFT';
  const isEditable = isDraft || set.status === 'REJECTED';
  const canApprove = set.status === 'SUBMITTED' && (currentUserRole === 'admin' || currentUserRole === 'finance');

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between p-4 border-b border-border/50">
        <div className="min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-[14px] truncate" style={{ fontWeight: 700 }}>{set.title}</h3>
            <Badge className={`text-[9px] h-4 px-1.5 ${EXPENSE_STATUS_COLORS[set.status]}`}>
              {EXPENSE_STATUS_LABELS[set.status]}
            </Badge>
          </div>
          <p className="text-[11px] text-muted-foreground">{projectMap.get(set.projectId)}</p>
          <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground">
            <span>작성자: {set.createdByName}</span>
            <span>기간: {set.period}</span>
            <span>생성: {new Date(set.createdAt).toLocaleDateString('ko-KR')}</span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {isEditable && (
            <Button size="sm" className="h-7 text-[11px] gap-1" onClick={onAddItem}>
              <Plus className="w-3 h-3" /> 항목 추가
            </Button>
          )}
          {isDraft && set.items.length > 0 && (
            <Button size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={() => onChangeStatus('SUBMITTED')}>
              <Send className="w-3 h-3" /> 제출
            </Button>
          )}
          {canApprove && (
            <>
              <Button size="sm" className="h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => onChangeStatus('APPROVED')}>
                <CheckCircle2 className="w-3 h-3" /> 승인
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={onClose}>
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* 반려 배너 */}
      {set.status === 'REJECTED' && set.rejectedReason && (
        <div className="px-4 py-2.5 bg-rose-50 dark:bg-rose-950/30 border-b border-rose-200/60 dark:border-rose-800/40">
          <div className="flex items-center gap-1.5 text-[11px] text-rose-700 dark:text-rose-300">
            <XCircle className="w-3.5 h-3.5" />
            <span style={{ fontWeight: 600 }}>반려 사유:</span>
            <span>{set.rejectedReason}</span>
          </div>
        </div>
      )}

      {/* 합계 바 */}
      <div className="px-4 py-2.5 bg-muted/30 border-b border-border/50 flex items-center gap-6 text-[11px]">
        <div>
          <span className="text-muted-foreground">공급가액: </span>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtKRW(set.totalNet)}원</span>
        </div>
        <div>
          <span className="text-muted-foreground">부가세: </span>
          <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtKRW(set.totalVat)}원</span>
        </div>
        <div className="ml-auto">
          <span className="text-muted-foreground">합계: </span>
          <span style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums', color: '#0891b2' }}>{fmtKRW(set.totalGross)}원</span>
        </div>
      </div>

      {/* 항목 테이블 */}
      <div className="overflow-x-auto">
        {set.items.length === 0 ? (
          <div className="p-8 text-center">
            <FileText className="w-7 h-7 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-[12px] text-muted-foreground">"항목 추가" 버튼으로 지출 내역을 추가하세요</p>
          </div>
        ) : (
          <table className="w-full text-[11px] min-w-[700px]">
            <thead>
              <tr className="bg-slate-50/60 dark:bg-slate-800/30 border-b border-border">
                <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>일자</th>
                <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>세목</th>
                <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>거래처</th>
                <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>내용</th>
                <th className="px-3 py-2 text-right" style={{ fontWeight: 600 }}>공급가액</th>
                <th className="px-3 py-2 text-right" style={{ fontWeight: 600 }}>부가세</th>
                <th className="px-3 py-2 text-right" style={{ fontWeight: 600 }}>합계</th>
                <th className="px-3 py-2 text-center" style={{ fontWeight: 600 }}>결제</th>
                <th className="px-3 py-2 text-center" style={{ fontWeight: 600 }}>증빙</th>
                {isEditable && <th className="px-3 py-2 w-16" />}
              </tr>
            </thead>
            <tbody>
              {set.items.map(item => (
                <tr key={item.id} className="border-b border-border/50 hover:bg-muted/20 transition-colors">
                  <td className="px-3 py-2 whitespace-nowrap">{item.date}</td>
                  <td className="px-3 py-2">
                    <span className="text-muted-foreground">{item.subCode || item.budgetCode}</span>
                  </td>
                  <td className="px-3 py-2" style={{ fontWeight: 500 }}>{item.vendor}</td>
                  <td className="px-3 py-2 max-w-[150px] truncate" title={item.description}>{item.description}</td>
                  <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKRW(item.amountNet)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground" style={{ fontVariantNumeric: 'tabular-nums' }}>{fmtKRW(item.vat)}</td>
                  <td className="px-3 py-2 text-right" style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{fmtKRW(item.amountGross)}</td>
                  <td className="px-3 py-2 text-center">
                    <Badge variant="outline" className="text-[9px] h-4 px-1.5">
                      {item.paymentMethod === 'CARD' ? <CreditCard className="w-2.5 h-2.5 mr-0.5" /> : <Banknote className="w-2.5 h-2.5 mr-0.5" />}
                      {PAYMENT_METHOD_MAP[item.paymentMethod]}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Badge className={`text-[9px] h-4 px-1.5 ${EVIDENCE_STATUS_COLORS[item.evidenceStatus]}`}>
                      {item.evidenceFiles.length > 0 && <Paperclip className="w-2.5 h-2.5 mr-0.5" />}
                      {EVIDENCE_STATUS_LABELS[item.evidenceStatus]}
                    </Badge>
                  </td>
                  {isEditable && (
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-0.5">
                        <button
                          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                          onClick={() => onEditItem(item)}
                        >
                          <Edit3 className="w-3 h-3" />
                        </button>
                        <button
                          className="p-1 rounded hover:bg-muted transition-colors text-muted-foreground hover:text-rose-600"
                          onClick={() => onDeleteItem(item.id)}
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Card>
  );
}