import { useCallback, useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Clock3, MessageSquareText, Send, Tag } from 'lucide-react';
import { toast } from 'sonner';
import type { Comment } from '../../data/types';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '../ui/sheet';
import { Textarea } from '../ui/textarea';

export interface ActiveCommentAnchor {
  transactionId: string;
  fieldKey: string;
  fieldLabel: string;
  rowLabel: string;
}

function formatCommentTime(value: string): string {
  return value ? value.slice(0, 16).replace('T', ' ') : '';
}

const QUICK_COMMENT_TEMPLATES = [
  { label: '확인 필요', text: '확인 필요: ' },
  { label: '수정 완료', text: '수정 완료: ' },
  { label: '근거 보강', text: '근거 보강: ' },
] as const;

export function SettlementCommentThreadSheet({
  anchor,
  comments,
  open,
  projectId,
  currentUserId,
  currentUserName,
  onClose,
  onAddComment,
}: {
  anchor: ActiveCommentAnchor | null;
  comments: Comment[];
  open: boolean;
  projectId: string;
  currentUserId: string;
  currentUserName: string;
  onClose: () => void;
  onAddComment?: (comment: Comment) => void | Promise<void>;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const orderedComments = useMemo(
    () => [...comments].sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))),
    [comments],
  );
  const latestComment = orderedComments.length > 0 ? orderedComments[orderedComments.length - 1] : undefined;
  const loopState = orderedComments.length === 0
    ? { label: '기록 전', className: 'border-slate-200 bg-slate-50 text-slate-600' }
    : { label: '논의 중', className: 'border-[#26415f]/25 bg-[#26415f]/5 text-[#26415f]' };

  useEffect(() => {
    if (!open) setDraft('');
  }, [open]);

  const appendTemplate = useCallback((text: string) => {
    setDraft((prev) => {
      const current = prev.trimStart();
      if (current.startsWith(text.trim())) return prev;
      return current ? `${text}${current}` : text;
    });
  }, []);

  const handleSubmit = useCallback(async () => {
    if (!anchor || !onAddComment) return;
    const content = draft.trim();
    if (!content) return;

    setSaving(true);
    try {
      const isSheetRowComment = anchor.transactionId.startsWith('sheet-row:');
      await onAddComment({
        id: `cmt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        transactionId: anchor.transactionId,
        projectId,
        targetType: isSheetRowComment ? 'expense_sheet_row' : 'transaction',
        ...(isSheetRowComment ? { sheetRowId: anchor.transactionId } : {}),
        authorId: currentUserId || currentUserName,
        authorName: currentUserName,
        fieldKey: anchor.fieldKey,
        fieldLabel: anchor.fieldLabel,
        content,
        createdAt: new Date().toISOString(),
      });
      setDraft('');
      toast.success('주석을 남겼습니다.');
    } catch (error) {
      console.error('[SettlementLedger] add comment failed:', error);
      toast.error('주석 저장에 실패했습니다.');
    } finally {
      setSaving(false);
    }
  }, [anchor, currentUserId, currentUserName, draft, onAddComment, projectId]);

  return (
    <Sheet modal={false} open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose(); }}>
      <SheetContent side="right" className="w-[calc(100vw-24px)] gap-0 p-0 sm:w-[460px] sm:max-w-[460px]">
        <SheetHeader className="border-b bg-slate-50/70 px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <SheetTitle className="flex items-center gap-2 text-[15px]">
                <MessageSquareText className="h-4 w-4 text-[#26415f]" />
                셀 주석
              </SheetTitle>
              <SheetDescription className="mt-1 text-[11px]">
                {anchor ? `${anchor.rowLabel} · ${anchor.fieldLabel}` : '선택한 셀의 검토 기록'}
              </SheetDescription>
            </div>
            <Badge variant="outline" className={`h-6 rounded-md px-2 text-[10px] ${loopState.className}`}>
              {loopState.label}
            </Badge>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-md border bg-white px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <MessageSquareText className="h-3 w-3" />
                주석
              </div>
              <p className="mt-1 text-[13px] font-semibold text-slate-950">{orderedComments.length}건</p>
            </div>
            <div className="rounded-md border bg-white px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <Clock3 className="h-3 w-3" />
                최근 기록
              </div>
              <p className="mt-1 truncate text-[13px] font-semibold text-slate-950">
                {latestComment ? formatCommentTime(latestComment.createdAt) : '-'}
              </p>
            </div>
          </div>

          {anchor && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary" className="rounded-md text-[10px]">{anchor.rowLabel}</Badge>
              <Badge variant="outline" className="rounded-md text-[10px]">{anchor.fieldLabel}</Badge>
            </div>
          )}
        </SheetHeader>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {orderedComments.length === 0 ? (
            <div className="rounded-md border border-dashed bg-slate-50 px-4 py-6 text-[12px] text-slate-500">
              아직 주석이 없습니다.
            </div>
          ) : (
            <div className="space-y-0 border-l border-slate-200 pl-4">
              {orderedComments.map((comment) => (
                <div key={comment.id} className="relative pb-4 last:pb-0">
                  <span className="absolute -left-[21px] top-1 flex h-3 w-3 items-center justify-center rounded-full border border-[#26415f]/30 bg-white">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#26415f]" />
                  </span>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-semibold text-slate-950">{comment.authorName}</span>
                    <span className="text-[10px] text-slate-500">{formatCommentTime(comment.createdAt)}</span>
                  </div>
                  {comment.fieldLabel && (
                    <Badge variant="secondary" className="mt-2 rounded-md text-[9px]">{comment.fieldLabel}</Badge>
                  )}
                  <p className="mt-2 whitespace-pre-wrap rounded-md border bg-white px-3 py-2 text-[12px] leading-5 text-slate-800">
                    {comment.content}
                  </p>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="space-y-3 border-t bg-white px-5 py-4">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-slate-500">
              <Tag className="h-3 w-3" />
              빠른 태그
            </span>
            {QUICK_COMMENT_TEMPLATES.map((item) => (
              <button
                key={item.label}
                type="button"
                className="h-6 rounded-md border border-slate-200 bg-slate-50 px-2 text-[10px] text-slate-700 hover:border-[#26415f]/30 hover:bg-[#26415f]/5"
                onClick={() => appendTemplate(item.text)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <Textarea
            value={draft}
            placeholder="검토 내용, 수정 근거, 확인 결과를 남겨주세요"
            className="min-h-24 rounded-md text-[12px]"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void handleSubmit();
              }
            }}
          />
          <div className="flex items-center justify-between gap-2">
            <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
              <CheckCircle2 className="h-3 w-3" />
              같은 셀의 검토 기록에 누적됩니다.
            </span>
            <Button size="sm" className="h-8 gap-1.5 rounded-md text-[11px]" disabled={!draft.trim() || saving || !anchor || !onAddComment} onClick={() => void handleSubmit()}>
              {saving ? '저장 중...' : (
                <>
                  <Send className="h-3.5 w-3.5" />
                  주석 등록
                </>
              )}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
