import { useState, useMemo, useCallback } from 'react';
import {
  FileText, Users, ArrowRightLeft, Clock, CheckCircle2, XCircle,
  AlertTriangle, Eye, ChevronLeft, ChevronRight, Download, Upload, Paperclip,
  UserPlus, UserMinus, Percent, ArrowUpDown, Calendar, MessageSquare,
  Search, FileCheck, ZoomIn, ZoomOut,
  Maximize2, RotateCw, File, Shield,
  ClipboardCheck, History, ArrowRight, Hash,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { Separator } from '../ui/separator';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../ui/dialog';
import { ScrollArea } from '../ui/scroll-area';
import { Textarea } from '../ui/textarea';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '../ui/tooltip';
import { PageHeader } from '../layout/PageHeader';
import {
  CHANGE_REQUESTS, STATE_LABELS, DOC_TYPE_LABELS, getDocCompleteness,
  type ChangeRequest, type ChangeRequestState, type EvidenceDocument,
  type StaffChangeItem, type TimelineEvent,
} from '../../data/personnel-change-data';
import { formatKRW } from '../../data/koica-data';

// ═══════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════

const stateStyles: Record<ChangeRequestState, { bg: string; text: string; border: string; icon: typeof CheckCircle2 }> = {
  DRAFT: { bg: 'bg-slate-100 dark:bg-slate-800/50', text: 'text-slate-600 dark:text-slate-400', border: 'border-slate-300 dark:border-slate-600', icon: FileText },
  SUBMITTED: { bg: 'bg-amber-50 dark:bg-amber-950/30', text: 'text-amber-700 dark:text-amber-400', border: 'border-amber-300 dark:border-amber-700', icon: Clock },
  APPROVED: { bg: 'bg-emerald-50 dark:bg-emerald-950/30', text: 'text-emerald-700 dark:text-emerald-400', border: 'border-emerald-300 dark:border-emerald-700', icon: CheckCircle2 },
  REJECTED: { bg: 'bg-rose-50 dark:bg-rose-950/30', text: 'text-rose-700 dark:text-rose-400', border: 'border-rose-300 dark:border-rose-700', icon: XCircle },
  REVISION_REQUESTED: { bg: 'bg-orange-50 dark:bg-orange-950/30', text: 'text-orange-700 dark:text-orange-400', border: 'border-orange-300 dark:border-orange-700', icon: RotateCw },
};

const priorityStyles: Record<string, string> = {
  HIGH: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  MEDIUM: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  LOW: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
};

const priorityLabels: Record<string, string> = {
  HIGH: '긴급', MEDIUM: '보통', LOW: '낮음',
};

const changeTypeStyles: Record<string, { color: string; bg: string; icon: typeof UserPlus }> = {
  ADD: { color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-950/30', icon: UserPlus },
  REMOVE: { color: 'text-rose-700 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-950/30', icon: UserMinus },
  RATE_CHANGE: { color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-950/30', icon: Percent },
  GRADE_CHANGE: { color: 'text-cyan-700 dark:text-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-950/30', icon: ArrowUpDown },
  MONTHS_CHANGE: { color: 'text-blue-700 dark:text-blue-400', bg: 'bg-blue-50 dark:bg-blue-950/30', icon: Calendar },
  REPLACEMENT: { color: 'text-cyan-700 dark:text-cyan-400', bg: 'bg-cyan-50 dark:bg-cyan-950/30', icon: ArrowRightLeft },
};

const changeTypeLabels: Record<string, string> = {
  ADD: '신규 투입', REMOVE: '투입 해제', RATE_CHANGE: '투입율 변경',
  GRADE_CHANGE: '등급 변경', MONTHS_CHANGE: '기간 변경', REPLACEMENT: '인력 대체',
};

const timelineTypeStyles: Record<string, { color: string; bg: string }> = {
  CREATE: { color: 'text-blue-600 dark:text-blue-400', bg: 'bg-blue-100 dark:bg-blue-900/40' },
  UPDATE: { color: 'text-slate-600 dark:text-slate-400', bg: 'bg-slate-100 dark:bg-slate-800/50' },
  SUBMIT: { color: 'text-amber-600 dark:text-amber-400', bg: 'bg-amber-100 dark:bg-amber-900/40' },
  APPROVE: { color: 'text-emerald-600 dark:text-emerald-400', bg: 'bg-emerald-100 dark:bg-emerald-900/40' },
  REJECT: { color: 'text-rose-600 dark:text-rose-400', bg: 'bg-rose-100 dark:bg-rose-900/40' },
  REVISION: { color: 'text-orange-600 dark:text-orange-400', bg: 'bg-orange-100 dark:bg-orange-900/40' },
  UPLOAD: { color: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-100 dark:bg-cyan-900/40' },
  COMMENT: { color: 'text-cyan-600 dark:text-cyan-400', bg: 'bg-cyan-100 dark:bg-cyan-900/40' },
};

function docStatusBadge(status: string) {
  switch (status) {
    case 'VALID': return <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 text-[9px]">유효</Badge>;
    case 'EXPIRED': return <Badge className="bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 text-[9px]">보완필요</Badge>;
    case 'PENDING_REVIEW': return <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 text-[9px]">검토중</Badge>;
    default: return null;
  }
}

function formatDate(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateTime(iso: string) {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtKRW(n: number) {
  if (!n) return '-';
  if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(1) + '억';
  if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(0) + '만';
  return n.toLocaleString();
}

// ═══════════════════════════════════════════════════════════════
// PDF Preview Modal
// ═══════════════════════════════════════════════════════════════

function PdfPreviewModal({ doc, open, onClose }: { doc: EvidenceDocument | null; open: boolean; onClose: () => void }) {
  const [currentPage, setCurrentPage] = useState(1);
  const [zoom, setZoom] = useState(100);

  if (!doc) return null;
  const pages = doc.previewPages || [];
  const totalPages = pages.length || doc.pageCount || 1;
  const page = pages[currentPage - 1];

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl w-full h-[85vh] flex flex-col p-0 gap-0">
        {/* Header */}
        <DialogHeader className="px-4 py-3 border-b border-border/50 shrink-0">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-8 h-8 rounded-lg bg-rose-100 dark:bg-rose-950/40 flex items-center justify-center shrink-0">
                <FileText className="w-4 h-4 text-rose-600 dark:text-rose-400" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="text-[13px] truncate">{doc.fileName}</DialogTitle>
                <div className="flex items-center gap-2 mt-0.5">
                  <span className="text-[10px] text-muted-foreground">{doc.fileSize}</span>
                  <span className="text-[10px] text-muted-foreground">{DOC_TYPE_LABELS[doc.type]}</span>
                  {docStatusBadge(doc.status)}
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 shrink-0">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(Math.max(50, zoom - 25))}>
                <ZoomOut className="w-3.5 h-3.5" />
              </Button>
              <span className="text-[10px] text-muted-foreground w-10 text-center">{zoom}%</span>
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" onClick={() => setZoom(Math.min(200, zoom + 25))}>
                <ZoomIn className="w-3.5 h-3.5" />
              </Button>
              <Separator orientation="vertical" className="h-4 mx-1" />
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                <Maximize2 className="w-3.5 h-3.5" />
              </Button>
              <Button variant="ghost" size="sm" className="h-7 gap-1 text-[10px] px-2">
                <Download className="w-3 h-3" /> 다운로드
              </Button>
            </div>
          </div>
        </DialogHeader>

        {/* PDF Preview Area */}
        <div className="flex-1 overflow-auto bg-muted/30 flex items-start justify-center p-6">
          <div
            className="bg-card rounded-sm shadow-lg border border-border/40 transition-transform"
            style={{
              width: `${480 * zoom / 100}px`,
              minHeight: `${680 * zoom / 100}px`,
              transform: `scale(1)`,
            }}
          >
            {/* Mock PDF Page */}
            <div className="p-8 space-y-6" style={{ fontSize: `${12 * zoom / 100}px` }}>
              {/* Document Header */}
              <div className="text-center space-y-2 pb-4 border-b border-border/30">
                <div className="flex justify-center mb-3">
                  <div className="w-12 h-12 rounded-lg bg-cyan-100 dark:bg-cyan-950/40 flex items-center justify-center">
                    <Shield className="w-6 h-6 text-cyan-600 dark:text-cyan-400" />
                  </div>
                </div>
                <p className="text-muted-foreground" style={{ fontSize: '0.75em' }}>MYSC 사업관리 통합 플랫폼</p>
                <h3 className="text-foreground" style={{ fontWeight: 700, fontSize: '1.3em' }}>
                  {page?.title || DOC_TYPE_LABELS[doc.type]}
                </h3>
                <p className="text-muted-foreground" style={{ fontSize: '0.8em' }}>
                  페이지 {currentPage} / {totalPages}
                </p>
              </div>

              {/* Page Content */}
              {page ? (
                <div className="space-y-3">
                  {page.sections.map((section, i) => (
                    <div key={i} className="flex items-start gap-2">
                      <div className="w-1.5 h-1.5 rounded-full bg-cyan-400 mt-1.5 shrink-0" />
                      <p className="text-foreground" style={{ fontSize: '0.95em', lineHeight: 1.6 }}>{section}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
                  <File className="w-10 h-10 mb-3 opacity-30" />
                  <p style={{ fontSize: '0.9em' }}>페이지 내용 미리보기</p>
                </div>
              )}

              {/* Mock stamp/watermark */}
              {doc.status === 'VALID' && (
                <div className="flex justify-end pt-6">
                  <div className="border-2 border-emerald-400 dark:border-emerald-600 rounded-lg px-4 py-2 text-center rotate-[-8deg] opacity-60">
                    <p className="text-emerald-600 dark:text-emerald-400" style={{ fontWeight: 800, fontSize: '1.1em' }}>검증완료</p>
                    <p className="text-emerald-500 dark:text-emerald-500" style={{ fontSize: '0.65em' }}>VERIFIED</p>
                  </div>
                </div>
              )}
              {doc.status === 'EXPIRED' && (
                <div className="flex justify-end pt-6">
                  <div className="border-2 border-rose-400 dark:border-rose-600 rounded-lg px-4 py-2 text-center rotate-[-8deg] opacity-60">
                    <p className="text-rose-600 dark:text-rose-400" style={{ fontWeight: 800, fontSize: '1.1em' }}>보완필요</p>
                    <p className="text-rose-500 dark:text-rose-500" style={{ fontSize: '0.65em' }}>REVISION NEEDED</p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Page Navigation */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border/50 bg-muted/20 shrink-0">
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={currentPage <= 1}
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
            >
              <ChevronLeft className="w-3.5 h-3.5" />
            </Button>
            <span className="text-[11px] text-muted-foreground" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {currentPage} / {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              className="h-7 w-7 p-0"
              disabled={currentPage >= totalPages}
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
            >
              <ChevronRight className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
            <span>업로드: {formatDate(doc.uploadedAt)}</span>
            <span>·</span>
            <span>{doc.uploadedBy}</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ═══════════════════════════════════════════════════════════════
// Document Thumbnail Card
// ═══════════════════════════════════════════════════════════════

function DocCard({ doc, onPreview }: { doc: EvidenceDocument; onPreview: (d: EvidenceDocument) => void }) {
  const statusColor = doc.status === 'VALID' ? 'border-emerald-200 dark:border-emerald-800'
    : doc.status === 'EXPIRED' ? 'border-rose-200 dark:border-rose-800'
    : 'border-amber-200 dark:border-amber-800';

  return (
    <div
      className={`group relative border rounded-lg overflow-hidden bg-card hover:shadow-md transition-all cursor-pointer ${statusColor}`}
      onClick={() => onPreview(doc)}
    >
      {/* Mini Preview */}
      <div className="h-24 bg-muted/30 flex flex-col items-center justify-center relative">
        <FileText className="w-8 h-8 text-muted-foreground/30" />
        <p className="text-[9px] text-muted-foreground mt-1">{doc.pageCount || 1}p · {doc.fileSize}</p>
        {/* Hover overlay */}
        <div className="absolute inset-0 bg-primary/10 dark:bg-primary/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
          <div className="bg-card rounded-full p-2 shadow-lg">
            <Eye className="w-4 h-4 text-primary" />
          </div>
        </div>
      </div>
      {/* Info */}
      <div className="p-2 space-y-1">
        <div className="flex items-center gap-1">
          {docStatusBadge(doc.status)}
          <span className="text-[9px] text-muted-foreground">{DOC_TYPE_LABELS[doc.type]}</span>
        </div>
        <p className="text-[10px] text-foreground truncate" style={{ fontWeight: 500 }}>{doc.fileName}</p>
        <p className="text-[9px] text-muted-foreground">{doc.uploadedBy} · {formatDate(doc.uploadedAt)}</p>
      </div>
      {doc.notes && (
        <div className="px-2 pb-2">
          <p className="text-[9px] text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 rounded px-1.5 py-0.5 truncate">
            {doc.notes}
          </p>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Before / After Comparison
// ═══════════════════════════════════════════════════════════════

function BeforeAfterComparison({ change }: { change: StaffChangeItem }) {
  const style = changeTypeStyles[change.changeType];
  const CtIcon = style.icon;

  return (
    <div className={`rounded-lg border ${style.bg} p-3 space-y-2`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className={`w-6 h-6 rounded-md flex items-center justify-center ${style.bg}`}>
            <CtIcon className={`w-3.5 h-3.5 ${style.color}`} />
          </div>
          <span className="text-[12px]" style={{ fontWeight: 600 }}>{change.staffName}</span>
          <Badge className={`text-[9px] ${style.bg} ${style.color} border-none`}>
            {changeTypeLabels[change.changeType]}
          </Badge>
        </div>
        {change.replacedFrom && (
          <span className="text-[10px] text-muted-foreground">
            <ArrowRightLeft className="w-3 h-3 inline mr-0.5" />{change.replacedFrom} 대체
          </span>
        )}
      </div>

      {/* Description */}
      <p className="text-[11px] text-muted-foreground">{change.description}</p>

      {/* Before / After Cards */}
      {(change.before || change.after) && (
        <div className="grid grid-cols-2 gap-2">
          {/* Before */}
          <div className={`rounded-md p-2.5 ${change.before ? 'bg-card border border-border/50' : 'bg-muted/20 border border-dashed border-border/30'}`}>
            <p className="text-[9px] text-muted-foreground mb-1.5" style={{ fontWeight: 600 }}>
              {change.before ? '변경 전 (Before)' : '해당 없음'}
            </p>
            {change.before ? (
              <div className="space-y-1">
                {change.before.grade && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">등급</span>
                    <span className="text-foreground" style={{ fontWeight: 500 }}>{change.before.grade}</span>
                  </div>
                )}
                {change.before.rate !== undefined && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">투입율</span>
                    <span className="text-foreground" style={{ fontWeight: 500 }}>{change.before.rate}%</span>
                  </div>
                )}
                {change.before.months !== undefined && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">개월수</span>
                    <span className="text-foreground" style={{ fontWeight: 500 }}>{change.before.months}개월</span>
                  </div>
                )}
                {change.before.monthlyPay !== undefined && change.before.monthlyPay > 0 && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">월급여</span>
                    <span className="text-foreground" style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {formatKRW(change.before.monthlyPay)}
                    </span>
                  </div>
                )}
                {change.before.total !== undefined && change.before.total > 0 && (
                  <div className="flex justify-between text-[10px] pt-1 border-t border-border/30">
                    <span className="text-muted-foreground" style={{ fontWeight: 600 }}>총계</span>
                    <span className="text-rose-600 dark:text-rose-400" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {formatKRW(change.before.total)}원
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/60 text-center py-2">-</p>
            )}
          </div>

          {/* After */}
          <div className={`rounded-md p-2.5 ${change.after ? 'bg-card border border-border/50' : 'bg-muted/20 border border-dashed border-border/30'}`}>
            <p className="text-[9px] text-muted-foreground mb-1.5" style={{ fontWeight: 600 }}>
              {change.after ? '변경 후 (After)' : '해당 없음'}
            </p>
            {change.after ? (
              <div className="space-y-1">
                {change.after.grade && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">등급</span>
                    <span className={`${change.before?.grade !== change.after.grade ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}
                      style={{ fontWeight: change.before?.grade !== change.after.grade ? 700 : 500 }}>
                      {change.after.grade}
                    </span>
                  </div>
                )}
                {change.after.rate !== undefined && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">투입율</span>
                    <span className={`${change.before?.rate !== change.after.rate ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}
                      style={{ fontWeight: change.before?.rate !== change.after.rate ? 700 : 500 }}>
                      {change.after.rate}%
                    </span>
                  </div>
                )}
                {change.after.months !== undefined && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">개월수</span>
                    <span className={`${change.before?.months !== change.after.months ? 'text-amber-600 dark:text-amber-400' : 'text-foreground'}`}
                      style={{ fontWeight: change.before?.months !== change.after.months ? 700 : 500 }}>
                      {change.after.months}개월
                    </span>
                  </div>
                )}
                {change.after.monthlyPay !== undefined && change.after.monthlyPay > 0 && (
                  <div className="flex justify-between text-[10px]">
                    <span className="text-muted-foreground">월급여</span>
                    <span className="text-foreground" style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>
                      {formatKRW(change.after.monthlyPay)}
                    </span>
                  </div>
                )}
                {change.after.total !== undefined && change.after.total > 0 && (
                  <div className="flex justify-between text-[10px] pt-1 border-t border-border/30">
                    <span className="text-muted-foreground" style={{ fontWeight: 600 }}>총계</span>
                    <span className="text-emerald-600 dark:text-emerald-400" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {formatKRW(change.after.total)}원
                    </span>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[10px] text-muted-foreground/60 text-center py-2">투입 해제</p>
            )}
          </div>
        </div>
      )}

      {/* Required Documents */}
      <div className="flex items-center gap-1 flex-wrap pt-1">
        <Paperclip className="w-3 h-3 text-muted-foreground/60" />
        {change.requiredDocs.map(dt => (
          <span key={dt} className="text-[9px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
            {DOC_TYPE_LABELS[dt]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Timeline
// ═══════════════════════════════════════════════════════════════

function TimelineView({ events }: { events: TimelineEvent[] }) {
  return (
    <div className="relative pl-6 space-y-0">
      {/* Vertical line */}
      <div className="absolute left-[9px] top-2 bottom-2 w-px bg-border" />

      {events.map((ev, i) => {
        const ts = timelineTypeStyles[ev.type] || timelineTypeStyles.UPDATE;
        return (
          <div key={ev.id} className="relative pb-4 last:pb-0">
            {/* Dot */}
            <div className={`absolute left-[-15px] top-1 w-[18px] h-[18px] rounded-full flex items-center justify-center z-10 border-2 border-card ${ts.bg}`}>
              {ev.type === 'APPROVE' && <CheckCircle2 className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'REJECT' && <XCircle className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'SUBMIT' && <ArrowRight className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'CREATE' && <FileText className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'UPLOAD' && <Upload className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'COMMENT' && <MessageSquare className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'REVISION' && <RotateCw className={`w-2.5 h-2.5 ${ts.color}`} />}
              {ev.type === 'UPDATE' && <Hash className={`w-2.5 h-2.5 ${ts.color}`} />}
            </div>

            {/* Content */}
            <div className="ml-2">
              <div className="flex items-center gap-2">
                <span className="text-[11px]" style={{ fontWeight: 600 }}>{ev.action}</span>
                <span className="text-[9px] text-muted-foreground">{formatDateTime(ev.timestamp)}</span>
              </div>
              <p className="text-[10px] text-muted-foreground">{ev.actor}</p>
              {ev.comment && (
                <div className="mt-1 px-2.5 py-1.5 rounded-md bg-muted/40 border border-border/30">
                  <p className="text-[10px] text-foreground" style={{ lineHeight: 1.5 }}>{ev.comment}</p>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Change Request Detail
// ═══════════════════════════════════════════════════════════════

function ChangeRequestDetail({ request, onPreviewDoc, onApprove, onReject, onRequestRevision }: {
  request: ChangeRequest;
  onPreviewDoc: (d: EvidenceDocument) => void;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  onRequestRevision: (id: string) => void;
}) {
  const st = stateStyles[request.state];
  const StIcon = st.icon;
  const docStatus = getDocCompleteness(request);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge className={`${st.bg} ${st.text} border-none text-[10px] gap-1`}>
              <StIcon className="w-3 h-3" />
              {STATE_LABELS[request.state]}
            </Badge>
            <Badge className={`${priorityStyles[request.priority]} text-[10px] border-none`}>
              {priorityLabels[request.priority]}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{request.projectShortName}</Badge>
          </div>
          <h3 className="text-[14px] mt-1.5" style={{ fontWeight: 700 }}>{request.title}</h3>
          <p className="text-[11px] text-muted-foreground mt-0.5">{request.description}</p>
          <div className="flex items-center gap-3 mt-1.5 text-[10px] text-muted-foreground">
            <span>요청: {request.requestedBy} ({formatDate(request.requestedAt)})</span>
            <span>적용일: {request.effectiveDate}</span>
            {request.reviewedBy && <span>검토: {request.reviewedBy} ({formatDate(request.reviewedAt!)})</span>}
          </div>
        </div>

        {/* Cost Impact */}
        {request.costImpact.difference !== 0 && (
          <div className="text-right shrink-0">
            <p className="text-[9px] text-muted-foreground">비용 영향</p>
            <p className={`text-[14px] ${request.costImpact.difference < 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}
              style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {request.costImpact.difference > 0 ? '+' : ''}{fmtKRW(request.costImpact.difference)}원
            </p>
          </div>
        )}
      </div>

      {/* Admin Action Buttons */}
      {(request.state === 'SUBMITTED' || request.state === 'REVISION_REQUESTED') && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50/60 dark:bg-amber-950/10 border border-amber-200/60 dark:border-amber-800/40">
          <Clock className="w-4 h-4 text-amber-500 shrink-0" />
          <span className="text-[11px] text-amber-700 dark:text-amber-300 flex-1" style={{ fontWeight: 500 }}>
            관리자 검토가 필요한 요청입니다
          </span>
          <div className="flex items-center gap-1.5 shrink-0">
            <Button
              size="sm"
              className="h-7 text-[11px] gap-1 bg-emerald-600 hover:bg-emerald-700"
              onClick={() => onApprove(request.id)}
            >
              <CheckCircle2 className="w-3 h-3" /> 승인
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1 text-orange-600 border-orange-200 hover:bg-orange-50 dark:border-orange-800 dark:hover:bg-orange-950/30"
              onClick={() => onRequestRevision(request.id)}
            >
              <RotateCw className="w-3 h-3" /> 수정요청
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] gap-1 text-rose-600 border-rose-200 hover:bg-rose-50 dark:border-rose-800 dark:hover:bg-rose-950/30"
              onClick={() => onReject(request.id)}
            >
              <XCircle className="w-3 h-3" /> 반려
            </Button>
          </div>
        </div>
      )}

      {/* Review Comment (if any) */}
      {request.reviewComment && (
        <div className={`rounded-lg border px-3 py-2.5 ${st.bg} ${st.border}`}>
          <div className="flex items-center gap-1.5 mb-1">
            <MessageSquare className={`w-3.5 h-3.5 ${st.text}`} />
            <span className={`text-[11px] ${st.text}`} style={{ fontWeight: 600 }}>
              {request.state === 'APPROVED' ? '승인 코멘트' : request.state === 'REJECTED' ? '반려 사유' : '수정 요청'}
            </span>
          </div>
          <p className="text-[11px] text-foreground" style={{ lineHeight: 1.5 }}>{request.reviewComment}</p>
        </div>
      )}

      {/* Main Content: Changes + Documents + Timeline */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
        {/* Left: Changes */}
        <div className="xl:col-span-7 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-[12px] flex items-center gap-1.5" style={{ fontWeight: 600 }}>
              <ArrowRightLeft className="w-4 h-4 text-primary" />
              변경 사항 ({request.changes.length}건)
            </h4>
            {/* Doc completeness */}
            <Tooltip>
              <TooltipTrigger>
                <div className="flex items-center gap-1">
                  <FileCheck className={`w-3.5 h-3.5 ${docStatus.missing.length === 0 ? 'text-emerald-500' : 'text-amber-500'}`} />
                  <span className="text-[10px] text-muted-foreground">
                    서류 {docStatus.uploaded}/{docStatus.total}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent className="text-xs">
                {docStatus.missing.length === 0
                  ? '모든 필수 서류 업로드 완료'
                  : `미제출: ${docStatus.missing.map(m => DOC_TYPE_LABELS[m]).join(', ')}`
                }
              </TooltipContent>
            </Tooltip>
          </div>

          {request.changes.map((ch, i) => (
            <BeforeAfterComparison key={i} change={ch} />
          ))}
        </div>

        {/* Right: Documents + Timeline */}
        <div className="xl:col-span-5 space-y-4">
          {/* Documents */}
          <Card className="shadow-sm border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-[12px] flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-md bg-cyan-50 dark:bg-cyan-950/40 flex items-center justify-center">
                  <Paperclip className="w-3 h-3 text-cyan-600 dark:text-cyan-400" />
                </div>
                증빙서류 ({request.documents.length}건)
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2">
                {request.documents.map(doc => (
                  <DocCard key={doc.id} doc={doc} onPreview={onPreviewDoc} />
                ))}
              </div>
              {/* Upload button (mock) */}
              <div className="mt-3">
                <Button variant="outline" size="sm" className="w-full h-8 text-[10px] gap-1.5 border-dashed">
                  <Upload className="w-3 h-3" /> 서류 추가 업로드
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Timeline */}
          <Card className="shadow-sm border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-[12px] flex items-center gap-1.5">
                <div className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-950/40 flex items-center justify-center">
                  <History className="w-3 h-3 text-blue-600 dark:text-blue-400" />
                </div>
                이력
              </CardTitle>
            </CardHeader>
            <CardContent>
              <TimelineView events={request.timeline} />
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// Request List Card
// ═══════════════════════════════════════════════════════════════

function RequestCard({ request, isActive, onClick }: {
  request: ChangeRequest; isActive: boolean; onClick: () => void;
}) {
  const st = stateStyles[request.state];
  const StIcon = st.icon;
  const docStatus = getDocCompleteness(request);

  return (
    <div
      className={`
        relative border rounded-lg p-3 cursor-pointer transition-all
        ${isActive ? 'border-primary bg-primary/5 dark:bg-primary/10 shadow-sm' : 'border-border/50 bg-card hover:border-border hover:shadow-sm'}
      `}
      onClick={onClick}
    >
      {/* State indicator line */}
      <div className={`absolute top-0 left-0 right-0 h-[2px] rounded-t-lg ${st.bg}`} />

      <div className="space-y-2">
        {/* Top badges */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge className={`${st.bg} ${st.text} border-none text-[9px] gap-0.5`}>
            <StIcon className="w-2.5 h-2.5" />
            {STATE_LABELS[request.state]}
          </Badge>
          <Badge className={`${priorityStyles[request.priority]} text-[9px] border-none`}>
            {priorityLabels[request.priority]}
          </Badge>
          <Badge variant="outline" className="text-[9px]">{request.projectShortName}</Badge>
        </div>

        {/* Title */}
        <p className="text-[11px]" style={{ fontWeight: 600 }}>{request.title}</p>

        {/* Meta */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-[9px] text-muted-foreground">
            <span>{request.requestedBy}</span>
            <span>{formatDate(request.requestedAt)}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
              <Users className="w-2.5 h-2.5" />{request.changes.length}
            </span>
            <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
              <Paperclip className="w-2.5 h-2.5" />{request.documents.length}
            </span>
            {docStatus.missing.length > 0 && (
              <AlertTriangle className="w-3 h-3 text-amber-500" />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════

export function PersonnelChangePage() {
  const [requests, setRequests] = useState<ChangeRequest[]>(CHANGE_REQUESTS);
  const [selectedId, setSelectedId] = useState(CHANGE_REQUESTS[0]?.id || '');
  const [previewDoc, setPreviewDoc] = useState<EvidenceDocument | null>(null);
  const [filterState, setFilterState] = useState<string>('ALL');
  const [searchQuery, setSearchQuery] = useState('');
  // 승인/반려 다이얼로그
  const [approvalDialog, setApprovalDialog] = useState<{ id: string; action: 'APPROVED' | 'REJECTED' | 'REVISION_REQUESTED' } | null>(null);
  const [approvalComment, setApprovalComment] = useState('');

  const selectedRequest = useMemo(
    () => requests.find(r => r.id === selectedId) || requests[0],
    [selectedId, requests],
  );

  const filteredRequests = useMemo(() => {
    return requests.filter(r => {
      if (filterState !== 'ALL' && r.state !== filterState) return false;
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        return (
          r.title.toLowerCase().includes(q) ||
          r.projectShortName.toLowerCase().includes(q) ||
          r.requestedBy.toLowerCase().includes(q) ||
          r.changes.some(c => c.staffName.toLowerCase().includes(q))
        );
      }
      return true;
    });
  }, [requests, filterState, searchQuery]);

  // KPI calculations
  const kpis = useMemo(() => {
    const total = requests.length;
    const draft = requests.filter(r => r.state === 'DRAFT').length;
    const submitted = requests.filter(r => r.state === 'SUBMITTED' || r.state === 'REVISION_REQUESTED').length;
    const approved = requests.filter(r => r.state === 'APPROVED').length;
    const totalDocs = requests.reduce((s, r) => s + r.documents.length, 0);
    const totalChanges = requests.reduce((s, r) => s + r.changes.length, 0);
    const missingDocs = requests.reduce((s, r) => s + getDocCompleteness(r).missing.length, 0);
    return { total, draft, submitted, approved, totalDocs, totalChanges, missingDocs };
  }, [requests]);

  // 승인/반려 처리
  const handleApprovalAction = useCallback(() => {
    if (!approvalDialog) return;
    const { id, action } = approvalDialog;
    setRequests(prev => prev.map(r => {
      if (r.id !== id) return r;
      const now = new Date().toISOString();
      const newTimeline: TimelineEvent = {
        id: `tl-${Date.now()}`,
        action: action === 'APPROVED' ? '승인' : action === 'REJECTED' ? '반려' : '수정 요청',
        actor: '관리자',
        timestamp: now,
        comment: approvalComment || undefined,
        type: action === 'APPROVED' ? 'APPROVE' : action === 'REJECTED' ? 'REJECT' : 'REVISION',
      };
      return {
        ...r,
        state: action,
        reviewedBy: '관리자',
        reviewedAt: now,
        reviewComment: approvalComment || undefined,
        timeline: [...r.timeline, newTimeline],
      };
    }));
    setApprovalDialog(null);
    setApprovalComment('');
  }, [approvalDialog, approvalComment]);

  return (
    <TooltipProvider>
      <div className="space-y-5">
        {/* Header */}
        <PageHeader
          icon={ClipboardCheck}
          iconGradient="linear-gradient(135deg, #0f766e, #2dd4bf)"
          title="인력변경 관리"
          description="이전/이후 비교 · 증빙서류 관리 · 변경 승인 워크플로"
          badge={`${kpis.total}건`}
          actions={
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" className="h-8 text-[11px] gap-1.5">
                <Download className="w-3 h-3" /> 내보내기
              </Button>
              <Button
                size="sm"
                className="h-8 text-[11px] gap-1.5 rounded-lg"
                style={{ background: 'linear-gradient(135deg, #0f766e, #2dd4bf)' }}
              >
                <FileText className="w-3 h-3" /> 새 변경 요청
              </Button>
            </div>
          }
        />

        {/* KPI Row */}
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2.5">
          {[
            { label: '전체 요청', value: kpis.total, icon: FileText, color: '#0891b2' },
            { label: '초안', value: kpis.draft, icon: FileText, color: '#94a3b8' },
            { label: '검토 대기', value: kpis.submitted, icon: Clock, color: '#d97706' },
            { label: '승인완료', value: kpis.approved, icon: CheckCircle2, color: '#059669' },
            { label: '총 변경건', value: kpis.totalChanges, icon: ArrowRightLeft, color: '#0f766e' },
            { label: '증빙서류', value: kpis.totalDocs, icon: Paperclip, color: '#0891b2' },
            { label: '미제출 서류', value: kpis.missingDocs, icon: AlertTriangle, color: kpis.missingDocs > 0 ? '#ea580c' : '#94a3b8' },
          ].map((k, i) => (
            <Card key={i} className="shadow-sm border-border/40">
              <CardContent className="p-3 flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: k.color + '14' }}>
                  <k.icon className="w-4 h-4" style={{ color: k.color }} />
                </div>
                <div>
                  <p className="text-[9px] text-muted-foreground">{k.label}</p>
                  <p className="text-[18px] text-foreground" style={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
                    {k.value}
                  </p>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Main Layout: List + Detail */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
          {/* Left: Request List */}
          <div className="xl:col-span-3 space-y-3">
            {/* Filters */}
            <div className="space-y-2">
              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
                <Input
                  placeholder="이름, 사업명 검색..."
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  className="pl-8 h-8 text-[11px]"
                />
              </div>
              <div className="flex gap-1 flex-wrap">
                {['ALL', 'DRAFT', 'SUBMITTED', 'APPROVED', 'REVISION_REQUESTED', 'REJECTED'].map(s => (
                  <button
                    key={s}
                    onClick={() => setFilterState(s)}
                    className={`
                      px-2 py-1 rounded-md text-[10px] border transition-colors
                      ${filterState === s
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-card text-muted-foreground border-border/50 hover:border-border'}
                    `}
                    style={{ fontWeight: filterState === s ? 600 : 400 }}
                  >
                    {s === 'ALL' ? '전체' : STATE_LABELS[s as ChangeRequestState]}
                  </button>
                ))}
              </div>
            </div>

            {/* List */}
            <ScrollArea className="h-[calc(100vh-380px)]">
              <div className="space-y-2 pr-2">
                {filteredRequests.length === 0 ? (
                  <div className="text-center py-8 text-[11px] text-muted-foreground">
                    <FileText className="w-8 h-8 mx-auto mb-2 opacity-30" />
                    검색 결과 없음
                  </div>
                ) : (
                  filteredRequests.map(r => (
                    <RequestCard
                      key={r.id}
                      request={r}
                      isActive={r.id === selectedId}
                      onClick={() => setSelectedId(r.id)}
                    />
                  ))
                )}
              </div>
            </ScrollArea>
          </div>

          {/* Right: Detail */}
          <div className="xl:col-span-9">
            <Card className="shadow-sm border-border/50">
              <CardContent className="p-5">
                {selectedRequest ? (
                  <ChangeRequestDetail
                    request={selectedRequest}
                    onPreviewDoc={setPreviewDoc}
                    onApprove={(id) => { setApprovalDialog({ id, action: 'APPROVED' }); setApprovalComment(''); }}
                    onReject={(id) => { setApprovalDialog({ id, action: 'REJECTED' }); setApprovalComment(''); }}
                    onRequestRevision={(id) => { setApprovalDialog({ id, action: 'REVISION_REQUESTED' }); setApprovalComment(''); }}
                  />
                ) : (
                  <div className="text-center py-16 text-muted-foreground">
                    <ClipboardCheck className="w-12 h-12 mx-auto mb-3 opacity-20" />
                    <p className="text-[13px]">변경 요청을 선택하세요</p>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>

        {/* PDF Preview Modal */}
        <PdfPreviewModal
          doc={previewDoc}
          open={!!previewDoc}
          onClose={() => setPreviewDoc(null)}
        />

        {/* 승인/반려 ��이얼로그 */}
        <Dialog open={!!approvalDialog} onOpenChange={open => !open && setApprovalDialog(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle className="text-[14px]">
                {approvalDialog?.action === 'APPROVED' ? '변경 요청 승인' :
                 approvalDialog?.action === 'REJECTED' ? '변경 요청 반려' :
                 '수정 요청'}
              </DialogTitle>
            </DialogHeader>
            <div className="py-2 space-y-3">
              {approvalDialog?.action === 'APPROVED' && (
                <div className="p-3 rounded-lg bg-emerald-50 dark:bg-emerald-950/20 border border-emerald-200/60 dark:border-emerald-800/40 text-[11px] text-emerald-700 dark:text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 inline mr-1" />
                  이 변경 요청을 승인하시겠습니까?
                </div>
              )}
              {approvalDialog?.action === 'REJECTED' && (
                <div className="p-3 rounded-lg bg-rose-50 dark:bg-rose-950/20 border border-rose-200/60 dark:border-rose-800/40 text-[11px] text-rose-700 dark:text-rose-300">
                  <XCircle className="w-4 h-4 inline mr-1" />
                  이 변경 요청을 반려합니다. 사유를 입력해 주세요.
                </div>
              )}
              {approvalDialog?.action === 'REVISION_REQUESTED' && (
                <div className="p-3 rounded-lg bg-orange-50 dark:bg-orange-950/20 border border-orange-200/60 dark:border-orange-800/40 text-[11px] text-orange-700 dark:text-orange-300">
                  <RotateCw className="w-4 h-4 inline mr-1" />
                  수정 보완 사항을 입력해 주세요.
                </div>
              )}
              <div>
                <Textarea
                  value={approvalComment}
                  onChange={e => setApprovalComment(e.target.value)}
                  className="text-[12px] min-h-[80px]"
                  placeholder={approvalDialog?.action === 'APPROVED' ? '승인 코멘트 (선택)' : '사유를 입력해 주세요 (필수)'}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setApprovalDialog(null)}>취소</Button>
              <Button
                size="sm"
                onClick={handleApprovalAction}
                disabled={approvalDialog?.action !== 'APPROVED' && !approvalComment.trim()}
                className={
                  approvalDialog?.action === 'APPROVED' ? 'bg-emerald-600 hover:bg-emerald-700' :
                  approvalDialog?.action === 'REJECTED' ? 'bg-rose-600 hover:bg-rose-700' :
                  'bg-orange-600 hover:bg-orange-700'
                }
              >
                {approvalDialog?.action === 'APPROVED' ? '승인' :
                 approvalDialog?.action === 'REJECTED' ? '반려' : '수정 요청'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}