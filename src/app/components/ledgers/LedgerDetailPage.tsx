import React, { useState, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router';
import {
  ArrowLeft, Plus, Send, CheckCircle2, XCircle, MessageSquare,
  Paperclip, FileText, Download, ChevronDown, ChevronUp, Filter,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Input } from '../ui/input';
import { Label } from '../ui/label';
import { Textarea } from '../ui/textarea';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '../ui/select';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '../ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '../ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Separator } from '../ui/separator';
import { useAppStore } from '../../data/store';
import { resolveApiErrorMessage } from '../../platform/api-error-message';
import {
  TX_STATE_LABELS, DIRECTION_LABELS, CASHFLOW_CATEGORY_LABELS, PAYMENT_METHOD_LABELS,
  EVIDENCE_STATUS_LABELS, BASIS_LABELS, SETTLEMENT_TYPE_LABELS,
  type Transaction, type TransactionState, type Direction, type CashflowCategory,
  type PaymentMethod, type Comment as CommentType,
} from '../../data/types';
import { toast } from 'sonner';

const txStateColor: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  SUBMITTED: 'bg-yellow-100 text-yellow-800',
  APPROVED: 'bg-green-100 text-green-800',
  REJECTED: 'bg-red-100 text-red-800',
};

const evidenceColor: Record<string, string> = {
  MISSING: 'bg-red-100 text-red-700',
  PARTIAL: 'bg-amber-100 text-amber-700',
  COMPLETE: 'bg-green-100 text-green-700',
};

function fmt(n: number) {
  return n.toLocaleString('ko-KR');
}

function fmtShort(n: number) {
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + '억';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(0) + '만';
  return n.toLocaleString();
}

export function LedgerDetailPage() {
  const { projectId, ledgerId } = useParams();
  const navigate = useNavigate();
  const {
    getProjectById, getLedgerById, getLedgerTransactions,
    getTransactionComments, getTransactionEvidences,
    addTransaction, updateTransaction, changeTransactionState,
    addComment, addEvidence, currentUser, templates,
  } = useAppStore();

  const project = getProjectById(projectId || '');
  const ledger = getLedgerById(ledgerId || '');
  const allTx = getLedgerTransactions(ledgerId || '');

  // Filters
  const [filterState, setFilterState] = useState<string>('ALL');
  const [filterDirection, setFilterDirection] = useState<string>('ALL');
  const [filterCategory, setFilterCategory] = useState<string>('ALL');
  const [searchText, setSearchText] = useState('');

  // Detail panel
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);
  const [showTxForm, setShowTxForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [commentText, setCommentText] = useState('');

  const filteredTx = useMemo(() => {
    return allTx
      .filter(t => {
        if (filterState !== 'ALL' && t.state !== filterState) return false;
        if (filterDirection !== 'ALL' && t.direction !== filterDirection) return false;
        if (filterCategory !== 'ALL' && t.cashflowCategory !== filterCategory) return false;
        if (searchText) {
          const s = searchText.toLowerCase();
          if (!t.counterparty.toLowerCase().includes(s) && !t.memo.toLowerCase().includes(s)) return false;
        }
        return true;
      })
      .sort((a, b) => b.dateTime.localeCompare(a.dateTime));
  }, [allTx, filterState, filterDirection, filterCategory, searchText]);

  const selectedTx = selectedTxId ? allTx.find(t => t.id === selectedTxId) : null;
  const selectedComments = selectedTx ? getTransactionComments(selectedTx.id) : [];
  const selectedEvidences = selectedTx ? getTransactionEvidences(selectedTx.id) : [];

  // Stats
  const stats = useMemo(() => {
    const totalIn = allTx.filter(t => t.direction === 'IN').reduce((s, t) => s + t.amounts.bankAmount, 0);
    const totalOut = allTx.filter(t => t.direction === 'OUT').reduce((s, t) => s + t.amounts.bankAmount, 0);
    return { totalIn, totalOut, net: totalIn - totalOut, count: allTx.length };
  }, [allTx]);

  // Template for categories
  const template = templates.find(t => t.id === ledger?.templateId);
  const categoryOptions = template?.cashflowEnums || Object.keys(CASHFLOW_CATEGORY_LABELS) as CashflowCategory[];

  // Tx form state
  const [txForm, setTxForm] = useState({
    dateTime: new Date().toISOString().split('T')[0],
    direction: 'OUT' as Direction,
    method: 'TRANSFER' as PaymentMethod,
    cashflowCategory: '' as CashflowCategory,
    counterparty: '',
    memo: '',
    bankAmount: '',
    budgetCategory: '',
  });

  const handleAddTx = async () => {
    const amt = Number(txForm.bankAmount) || 0;
    const dir = txForm.direction;
    const basis = ledger?.basis || '공급가액';
    // VAT calculation based on basis
    let vatIn = 0, vatOut = 0;
    if (basis === '공급대가') {
      // 공급대가 기준: 금액에 VAT 포함
      if (dir === 'OUT') vatIn = Math.round(amt / 11);
      if (dir === 'IN') vatOut = Math.round(amt / 11);
    } else {
      // 공급가액 기준: 금액이 공급가, VAT 별도
      if (dir === 'OUT') vatIn = Math.round(amt * 0.1);
      if (dir === 'IN') vatOut = Math.round(amt * 0.1);
    }

    const evidenceRules = template?.evidenceRules || ['세금계산서'];
    const newTx: Transaction = {
      id: 'tx' + String(Date.now()).slice(-6),
      ledgerId: ledger!.id,
      projectId: project!.id,
      state: 'DRAFT',
      dateTime: txForm.dateTime,
      weekCode: '',
      direction: dir,
      method: txForm.method,
      cashflowCategory: txForm.cashflowCategory,
      cashflowLabel: CASHFLOW_CATEGORY_LABELS[txForm.cashflowCategory] || '',
      budgetCategory: txForm.budgetCategory,
      counterparty: txForm.counterparty,
      memo: txForm.memo,
      amounts: {
        bankAmount: amt,
        depositAmount: dir === 'IN' ? amt : 0,
        expenseAmount: dir === 'OUT' ? amt : 0,
        vatIn,
        vatOut,
        vatRefund: 0,
        balanceAfter: 0,
      },
      evidenceRequired: evidenceRules,
      evidenceStatus: 'MISSING',
      evidenceMissing: [...evidenceRules],
      attachmentsCount: 0,
      createdBy: currentUser.uid,
      createdAt: new Date().toISOString(),
      updatedBy: currentUser.uid,
      updatedAt: new Date().toISOString(),
    };
    try {
      await addTransaction(newTx);
      setShowTxForm(false);
      setTxForm({
        dateTime: new Date().toISOString().split('T')[0],
        direction: 'OUT', method: 'TRANSFER',
        cashflowCategory: '' as CashflowCategory,
        counterparty: '', memo: '', bankAmount: '', budgetCategory: '',
      });
      toast.success('거래가 추가되었습니다.');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '거래가 추가되지 않았습니다.'));
    }
  };

  const handleSubmit = async (txId: string) => {
    try {
      await changeTransactionState(txId, 'SUBMITTED');
      toast.success('제출 완료');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '제출 처리에 실패했습니다.'));
    }
  };

  const handleApprove = async (txId: string) => {
    try {
      await changeTransactionState(txId, 'APPROVED');
      toast.success('승인 완료');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '승인 처리에 실패했습니다.'));
    }
  };

  const handleReject = async () => {
    if (selectedTxId) {
      try {
        await changeTransactionState(selectedTxId, 'REJECTED', rejectReason);
        setShowRejectDialog(false);
        setRejectReason('');
        toast.success('반려 처리됨');
      } catch (error) {
        toast.error(resolveApiErrorMessage(error, '반려 처리에 실패했습니다.'));
      }
    }
  };

  const handleAddComment = async () => {
    if (!selectedTxId || !commentText.trim()) return;
    const newComment: CommentType = {
      id: 'c' + String(Date.now()).slice(-6),
      transactionId: selectedTxId,
      authorId: currentUser.uid,
      authorName: currentUser.name,
      content: commentText.trim(),
      createdAt: new Date().toISOString(),
    };
    try {
      await addComment(newComment);
      setCommentText('');
    } catch (error) {
      toast.error(resolveApiErrorMessage(error, '메모 저장에 실패했습니다.'));
    }
  };

  if (!project || !ledger) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <p className="text-muted-foreground">원장을 찾을 수 없습니다.</p>
        <Button variant="outline" onClick={() => navigate('/projects')}>프로젝트 목록으로</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="sm" onClick={() => navigate(`/projects/${project.id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <div className="flex items-center gap-2">
            <h1>{ledger.name}</h1>
            <Badge variant="outline" className="text-xs">{project.name}</Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {BASIS_LABELS[ledger.basis]} · {SETTLEMENT_TYPE_LABELS[ledger.settlementType]} · {stats.count}건 거래
          </p>
        </div>
        <Button onClick={() => setShowTxForm(true)} className="gap-1.5">
          <Plus className="w-4 h-4" /> 거래 추가
        </Button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-4 gap-3">
        <Card className="bg-green-50/50">
          <CardContent className="py-3 text-center">
            <p className="text-xs text-muted-foreground">입금 합계</p>
            <p className="text-lg text-green-700" style={{ fontWeight: 600 }}>{fmtShort(stats.totalIn)}</p>
          </CardContent>
        </Card>
        <Card className="bg-red-50/50">
          <CardContent className="py-3 text-center">
            <p className="text-xs text-muted-foreground">출금 합계</p>
            <p className="text-lg text-red-600" style={{ fontWeight: 600 }}>{fmtShort(stats.totalOut)}</p>
          </CardContent>
        </Card>
        <Card className="bg-blue-50/50">
          <CardContent className="py-3 text-center">
            <p className="text-xs text-muted-foreground">잔액 (NET)</p>
            <p className="text-lg" style={{ fontWeight: 600 }}>{fmtShort(stats.net)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-xs text-muted-foreground">거래 건수</p>
            <p className="text-lg" style={{ fontWeight: 600 }}>{stats.count}건</p>
          </CardContent>
        </Card>
      </div>

      {/* Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap items-center gap-2">
            <Filter className="w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="거래처/메모 검색..."
              value={searchText}
              onChange={e => setSearchText(e.target.value)}
              className="w-[180px] h-8"
            />
            <Select value={filterState} onValueChange={setFilterState}>
              <SelectTrigger className="w-[110px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체 상태</SelectItem>
                {(Object.keys(TX_STATE_LABELS) as TransactionState[]).map(k => (
                  <SelectItem key={k} value={k}>{TX_STATE_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterDirection} onValueChange={setFilterDirection}>
              <SelectTrigger className="w-[100px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">입출금</SelectItem>
                <SelectItem value="IN">입금</SelectItem>
                <SelectItem value="OUT">출금</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filterCategory} onValueChange={setFilterCategory}>
              <SelectTrigger className="w-[130px] h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL">전체 항목</SelectItem>
                {categoryOptions.map(k => (
                  <SelectItem key={k} value={k}>{CASHFLOW_CATEGORY_LABELS[k]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground ml-auto">
              {filteredTx.length}건 표시
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Main content: Table + Detail Panel */}
      <div className="flex gap-4">
        {/* Transaction Table */}
        <Card className={`flex-1 ${selectedTxId ? 'max-w-[calc(100%-380px)]' : ''}`}>
          <CardContent className="pt-0 pb-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[90px]">일자</TableHead>
                  <TableHead className="w-[50px]">구분</TableHead>
                  <TableHead>항목</TableHead>
                  <TableHead>거래처</TableHead>
                  <TableHead>메모</TableHead>
                  <TableHead className="text-right">금액</TableHead>
                  <TableHead className="text-right">VAT</TableHead>
                  <TableHead className="w-[60px]">증빙</TableHead>
                  <TableHead className="w-[70px]">상태</TableHead>
                  <TableHead className="w-[120px]">액션</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredTx.map(t => (
                  <TableRow
                    key={t.id}
                    className={`cursor-pointer ${selectedTxId === t.id ? 'bg-accent' : ''}`}
                    onClick={() => setSelectedTxId(selectedTxId === t.id ? null : t.id)}
                  >
                    <TableCell className="text-xs">{t.dateTime}</TableCell>
                    <TableCell>
                      <span className={`text-xs px-1.5 py-0.5 rounded ${t.direction === 'IN' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                        {DIRECTION_LABELS[t.direction]}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{CASHFLOW_CATEGORY_LABELS[t.cashflowCategory]}</TableCell>
                    <TableCell className="text-xs max-w-[100px] truncate">{t.counterparty}</TableCell>
                    <TableCell className="text-xs max-w-[120px] truncate">{t.memo}</TableCell>
                    <TableCell className={`text-right text-sm ${t.direction === 'IN' ? 'text-green-700' : 'text-red-600'}`} style={{ fontWeight: 500 }}>
                      {t.direction === 'IN' ? '+' : '-'}{fmt(t.amounts.bankAmount)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {t.direction === 'OUT' && t.amounts.vatIn > 0 ? fmt(t.amounts.vatIn) : ''}
                      {t.direction === 'IN' && t.amounts.vatOut > 0 ? fmt(t.amounts.vatOut) : ''}
                    </TableCell>
                    <TableCell>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${evidenceColor[t.evidenceStatus]}`}>
                        {EVIDENCE_STATUS_LABELS[t.evidenceStatus]}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`text-[10px] px-1.5 py-0.5 rounded ${txStateColor[t.state]}`}>
                        {TX_STATE_LABELS[t.state]}
                      </span>
                    </TableCell>
                    <TableCell onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        {t.state === 'DRAFT' && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs px-2"
                            onClick={() => void handleSubmit(t.id)}
                          >
                            <Send className="w-3 h-3 mr-1" /> 제출
                          </Button>
                        )}
                        {t.state === 'SUBMITTED' && (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs px-2 text-green-700 border-green-300"
                              onClick={() => void handleApprove(t.id)}
                            >
                              <CheckCircle2 className="w-3 h-3" />
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-6 text-xs px-2 text-red-600 border-red-300"
                              onClick={() => { setSelectedTxId(t.id); setShowRejectDialog(true); }}
                            >
                              <XCircle className="w-3 h-3" />
                            </Button>
                          </>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {filteredTx.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center py-8 text-muted-foreground">
                      거래가 없습니다.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {/* Detail Panel */}
        {selectedTx && (
          <Card className="w-[360px] shrink-0 overflow-y-auto max-h-[calc(100vh-280px)]">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">거래 상세</CardTitle>
                <span className={`text-xs px-2 py-0.5 rounded ${txStateColor[selectedTx.state]}`}>
                  {TX_STATE_LABELS[selectedTx.state]}
                </span>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Basic info */}
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div>
                  <span className="text-xs text-muted-foreground">일자</span>
                  <p>{selectedTx.dateTime}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">구분</span>
                  <p>{DIRECTION_LABELS[selectedTx.direction]}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">항목</span>
                  <p>{CASHFLOW_CATEGORY_LABELS[selectedTx.cashflowCategory]}</p>
                </div>
                <div>
                  <span className="text-xs text-muted-foreground">결제수단</span>
                  <p>{PAYMENT_METHOD_LABELS[selectedTx.method]}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted-foreground">거래처</span>
                  <p>{selectedTx.counterparty}</p>
                </div>
                <div className="col-span-2">
                  <span className="text-xs text-muted-foreground">메모</span>
                  <p>{selectedTx.memo}</p>
                </div>
              </div>

              <Separator />

              {/* Amounts */}
              <div>
                <h4 className="text-sm mb-2">금액 상세</h4>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">거래금액</span>
                    <span style={{ fontWeight: 500 }}>{fmt(selectedTx.amounts.bankAmount)}원</span>
                  </div>
                  {selectedTx.amounts.vatIn > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">매입세액 (VAT)</span>
                      <span>{fmt(selectedTx.amounts.vatIn)}원</span>
                    </div>
                  )}
                  {selectedTx.amounts.vatOut > 0 && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">매출세액 (VAT)</span>
                      <span>{fmt(selectedTx.amounts.vatOut)}원</span>
                    </div>
                  )}
                </div>
              </div>

              <Separator />

              {/* Evidence */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm">증빙 체크리스트</h4>
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${evidenceColor[selectedTx.evidenceStatus]}`}>
                    {EVIDENCE_STATUS_LABELS[selectedTx.evidenceStatus]}
                  </span>
                </div>
                <div className="space-y-1.5">
                  {selectedTx.evidenceRequired.map(req => {
                    const isMissing = selectedTx.evidenceMissing.includes(req);
                    return (
                      <div key={req} className="flex items-center gap-2 text-sm">
                        {isMissing ? (
                          <XCircle className="w-3.5 h-3.5 text-red-500" />
                        ) : (
                          <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />
                        )}
                        <span className={isMissing ? 'text-red-600' : 'text-green-700'}>{req}</span>
                      </div>
                    );
                  })}
                </div>
                {/* Uploaded files */}
                {selectedEvidences.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {selectedEvidences.map(ev => (
                      <div key={ev.id} className="flex items-center gap-2 text-xs bg-muted/50 rounded px-2 py-1.5">
                        <Paperclip className="w-3 h-3 text-muted-foreground" />
                        <span className="flex-1 truncate">{ev.fileName}</span>
                        <span className="text-muted-foreground">{(ev.fileSize / 1024).toFixed(0)}KB</span>
                      </div>
                    ))}
                  </div>
                )}
                <Button variant="outline" size="sm" className="mt-2 w-full h-7 text-xs">
                  <Paperclip className="w-3 h-3 mr-1" /> 파일 첨부
                </Button>
              </div>

              <Separator />

              {/* Approval info */}
              {selectedTx.state === 'REJECTED' && selectedTx.rejectedReason && (
                <div className="bg-red-50 rounded-lg p-3">
                  <p className="text-xs text-red-700" style={{ fontWeight: 500 }}>반려 사유</p>
                  <p className="text-sm text-red-800 mt-1">{selectedTx.rejectedReason}</p>
                </div>
              )}

              {/* Comments */}
              <div>
                <h4 className="text-sm mb-2 flex items-center gap-1">
                  <MessageSquare className="w-3.5 h-3.5" /> 코멘트 ({selectedComments.length})
                </h4>
                <div className="space-y-2 max-h-[200px] overflow-y-auto">
                  {selectedComments.map(c => (
                    <div key={c.id} className="bg-muted/50 rounded-lg p-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs" style={{ fontWeight: 500 }}>{c.authorName}</span>
                        <span className="text-[10px] text-muted-foreground">
                          {new Date(c.createdAt).toLocaleDateString('ko-KR')}
                        </span>
                      </div>
                      <p className="text-sm mt-1">{c.content}</p>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2 mt-2">
                  <Input
                    value={commentText}
                    onChange={e => setCommentText(e.target.value)}
                    placeholder="코멘트 입력..."
                    className="h-8 text-sm"
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        void handleAddComment();
                      }
                    }}
                  />
                  <Button size="sm" className="h-8 px-3" onClick={() => void handleAddComment()} disabled={!commentText.trim()}>
                    <Send className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Add Transaction Dialog */}
      <Dialog open={showTxForm} onOpenChange={setShowTxForm}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>거래 추가</DialogTitle>
            <DialogDescription>
              새 거래를 입력합니다. {BASIS_LABELS[ledger.basis]} 기준으로 VAT가 자동 계산됩니다.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <Label>일자 *</Label>
              <Input type="date" value={txForm.dateTime} onChange={e => setTxForm(f => ({ ...f, dateTime: e.target.value }))} />
            </div>
            <div>
              <Label>구분 *</Label>
              <Select value={txForm.direction} onValueChange={v => setTxForm(f => ({ ...f, direction: v as Direction }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="IN">입금</SelectItem>
                  <SelectItem value="OUT">출금</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>결제수단</Label>
              <Select value={txForm.method} onValueChange={v => setTxForm(f => ({ ...f, method: v as PaymentMethod }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(PAYMENT_METHOD_LABELS) as PaymentMethod[]).map(k => (
                    <SelectItem key={k} value={k}>{PAYMENT_METHOD_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>캐시플로 항목 *</Label>
              <Select value={txForm.cashflowCategory} onValueChange={v => setTxForm(f => ({ ...f, cashflowCategory: v as CashflowCategory }))}>
                <SelectTrigger><SelectValue placeholder="선택" /></SelectTrigger>
                <SelectContent>
                  {categoryOptions.map(k => (
                    <SelectItem key={k} value={k}>{CASHFLOW_CATEGORY_LABELS[k]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>거래금액 (원) *</Label>
              <Input
                type="number"
                value={txForm.bankAmount}
                onChange={e => setTxForm(f => ({ ...f, bankAmount: e.target.value }))}
                placeholder="0"
              />
            </div>
            <div>
              <Label>비목/세목</Label>
              <Input value={txForm.budgetCategory} onChange={e => setTxForm(f => ({ ...f, budgetCategory: e.target.value }))} placeholder="선택" />
            </div>
            <div className="col-span-2">
              <Label>거래처 *</Label>
              <Input value={txForm.counterparty} onChange={e => setTxForm(f => ({ ...f, counterparty: e.target.value }))} placeholder="거래처명" />
            </div>
            <div className="col-span-2">
              <Label>메모</Label>
              <Textarea value={txForm.memo} onChange={e => setTxForm(f => ({ ...f, memo: e.target.value }))} rows={2} placeholder="거래 내용을 입력하세요" />
            </div>
          </div>
          {txForm.bankAmount && Number(txForm.bankAmount) > 0 && (
            <div className="bg-muted/50 rounded-lg p-3 text-sm">
              <p className="text-xs text-muted-foreground mb-1">VAT 자동 계산 ({BASIS_LABELS[ledger.basis]})</p>
              <div className="flex gap-4">
                <span>거래금액: {fmt(Number(txForm.bankAmount))}원</span>
                <span>
                  {ledger.basis === '공급대가'
                    ? `VAT: ${fmt(Math.round(Number(txForm.bankAmount) / 11))}원 (포함)`
                    : `VAT: ${fmt(Math.round(Number(txForm.bankAmount) * 0.1))}원 (별도)`
                  }
                </span>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTxForm(false)}>취소</Button>
            <Button
              onClick={() => void handleAddTx()}
              disabled={!txForm.dateTime || !txForm.cashflowCategory || !txForm.counterparty || !txForm.bankAmount}
            >
              추가
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={showRejectDialog} onOpenChange={setShowRejectDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>거래 반려</DialogTitle>
            <DialogDescription>반려 사유를 입력하세요.</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="반려 사유를 입력하세요..."
            rows={3}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowRejectDialog(false)}>취소</Button>
            <Button variant="destructive" onClick={() => void handleReject()} disabled={!rejectReason.trim()}>반려</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
