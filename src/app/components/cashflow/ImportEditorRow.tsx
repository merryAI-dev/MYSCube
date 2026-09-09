import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
  ClipboardEvent as ReactClipboardEvent,
  MouseEvent as ReactMouseEvent,
} from 'react';
import { Check, ExternalLink, GripVertical, Plus, Upload, X } from 'lucide-react';
import type { BudgetCodeEntry, BudgetTreeV2, Transaction, SettlementSheetPolicy } from '../../data/types';
import { parseNumber } from '../../platform/csv-utils';
import { findBudgetTreeSubItem } from '../../platform/budget-tree-v2';
import { isValidDriveUrl } from '../../platform/evidence-helpers';
import type { CounterpartySuggestion } from '../../platform/counterparty-normalizer';
import {
  SETTLEMENT_COLUMNS,
  type ImportRow,
} from '../../platform/settlement-csv';
import {
  hasImportRowReviewRequirement,
  isImportRowReviewConfirmed,
  isImportRowReviewPending,
} from '../../platform/settlement-review';
import {
  buildCommentThreadKey,
  buildSheetRowCommentId,
  composeContentStatusNote,
  findLatestFieldEdit,
  formatBudgetCodeLabel,
  formatCommentTime,
  formatSubCodeLabel,
  METHOD_OPTIONS,
  normalizeBudgetLabel,
  parseContentStatusNote,
  toFieldSlug,
} from '../../platform/settlement-grid-helpers';
import { resolveEvidenceRequiredDesc } from '../../platform/settlement-sheet-prepare';
import { resolveSelectPopupPosition } from './select-popup-position';
import { Button } from '../ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import type { ActiveCommentAnchor } from './SettlementCommentThreadSheet';
import { CellCommentButton } from './CellCommentButton';

// ── SelectCell (module-level to preserve React identity across renders) ──

function SelectCell({
  value,
  options,
  onChange,
  onFocus,
  cellColIdx,
  rowIdx,
  disabled = false,
  isOpen,
  onOpen,
  onClose,
}: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (next: string) => void;
  onFocus: () => void;
  cellColIdx: number;
  rowIdx: number;
  disabled?: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const [popupRect, setPopupRect] = useState<{ left: number; top: number } | null>(null);
  const popupWidth = 160;
  const popupHeight = Math.min(320, 32 * (options.length + 1));

  useLayoutEffect(() => {
    if (!isOpen) return;
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPopupRect(resolveSelectPopupPosition({
      triggerRect: rect,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      popupWidth,
      popupHeight,
    }));
  }, [isOpen, popupHeight, popupWidth]);

  useEffect(() => {
    if (!isOpen) return;
    const update = () => {
      const rect = btnRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPopupRect(resolveSelectPopupPosition({
        triggerRect: rect,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        popupWidth,
        popupHeight,
      }));
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [isOpen, popupHeight, popupWidth]);

  const openPicker = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (disabled) return;
    onFocus();
    onOpen();
  };
  const label = options.find((o) => o.value === value)?.label || value || '-';
  return (
    <div className="relative w-full">
      <div className={`flex items-center justify-between gap-1 px-1 py-0.5 text-[11px] ${disabled ? 'text-muted-foreground' : ''}`}>
        <span className="truncate">{label}</span>
        <button
          type="button"
          className={`shrink-0 h-4 w-4 rounded border border-slate-200/80 dark:border-slate-700 bg-white/50 dark:bg-slate-900/30 text-[9px] leading-none text-slate-500 dark:text-slate-400 ${disabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-slate-100/80 dark:hover:bg-slate-800/60'}`}
          onMouseDown={(e) => e.stopPropagation()}
          onMouseDownCapture={openPicker}
          data-select-toggle
          data-cell-row={rowIdx}
          data-cell-col={cellColIdx}
          title="옵션 열기"
          ref={btnRef}
        >
          ▼
        </button>
      </div>
      {isOpen && !disabled && popupRect && createPortal(
        <div
          className="fixed z-[120] w-40 max-h-80 overflow-auto rounded-md border bg-background shadow-lg"
          style={{ left: popupRect.left, top: popupRect.top }}
          onMouseDown={(e) => e.stopPropagation()}
          data-select-popup
        >
          <button
            type="button"
            className="w-full text-left px-2 py-1 text-[11px] hover:bg-muted"
            onClick={() => {
              onChange('');
              onClose();
            }}
          >
            -
          </button>
          {options.map((o) => (
            <button
              key={o.value}
              type="button"
              className="w-full text-left px-2 py-1 text-[11px] hover:bg-muted"
              onClick={() => {
                onChange(o.value);
                onClose();
              }}
            >
              {o.label}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

function ImportEditorRow({
  row,
  rowIdx,
  onCellChange,
  onRowChange,
  onRemove,
  onInsertBelow,
  onPasteRange,
  settlementSheetPolicy,
  onCellFocus,
  onCellMouseDown,
  onCellMouseEnter,
  selectionBounds,
  openSelect,
  onOpenSelect,
  onCloseSelect,
  authorIdx,
  authorListId,
  authorOptions,
  budgetCodeBook,
  budgetTreeV2,
  budgetCodeIdx,
  subCodeIdx,
  subSubCodeIdx,
  evidenceIdx,
  weekIdx,
  cashflowIdx,
  weekOptions,
  cashflowOptions,
  evidenceRequiredMap,
  commentCountByCell,
  onOpenCellComments,
  onProvisionEvidenceDriveById,
  onSyncEvidenceDriveById,
  onOpenEvidenceUpload,
  persistedTransactionId,
  persistedTransaction,
  onEnsurePersistedTransaction,
  noIdx,
  colWidths,
  budgetSuggestion,
  counterpartyHint,
  onBudgetSuggestionAccepted,
  readOnly = false,
}: {
  row: ImportRow;
  rowIdx: number;
  onCellChange: (colIdx: number, value: string) => void;
  onRowChange: (updater: (row: ImportRow) => ImportRow) => void;
  onRemove: () => void;
  onInsertBelow: () => void;
  onPasteRange: (rowIdx: number, colIdx: number, text: string) => void;
  settlementSheetPolicy: SettlementSheetPolicy;
  onCellFocus: (rowIdx: number, colIdx: number) => void;
  onCellMouseDown: (rowIdx: number, colIdx: number) => void;
  onCellMouseEnter: (rowIdx: number, colIdx: number) => void;
  selectionBounds: { r1: number; r2: number; c1: number; c2: number } | null;
  openSelect: { rowIdx: number; colIdx: number } | null;
  onOpenSelect: (rowIdx: number, colIdx: number) => void;
  onCloseSelect: () => void;
  authorIdx: number;
  authorListId: string;
  authorOptions?: string[];
  budgetCodeBook: BudgetCodeEntry[];
  budgetTreeV2?: BudgetTreeV2 | null;
  budgetCodeIdx: number;
  subCodeIdx: number;
  subSubCodeIdx: number;
  evidenceIdx: number;
  weekIdx: number;
  cashflowIdx: number;
  weekOptions: { value: string; label: string }[];
  cashflowOptions: { value: string; label: string }[];
  evidenceRequiredMap?: Record<string, string>;
  commentCountByCell: Map<string, number>;
  onOpenCellComments: (anchor: ActiveCommentAnchor) => void;
  onProvisionEvidenceDriveById?: (txId: string) => void | Promise<unknown>;
  onSyncEvidenceDriveById?: (txId: string) => void | Promise<unknown>;
  onOpenEvidenceUpload?: (txId: string) => void;
  persistedTransactionId?: string;
  persistedTransaction?: Transaction;
  onEnsurePersistedTransaction?: () => Promise<string | null>;
  noIdx: number;
  colWidths: number[];
  budgetSuggestion?: { budgetCategory: string; budgetSubCategory: string; confidence?: 'history' | 'codebook' } | null;
  counterpartyHint?: CounterpartySuggestion | null;
  onBudgetSuggestionAccepted?: (confidence: 'history' | 'codebook') => void;
  readOnly?: boolean;
}) {
  const hasError = Boolean(row.error);
  const hasReviewHint = hasImportRowReviewRequirement(row);
  const isReviewConfirmed = isImportRowReviewConfirmed(row);
  const isReviewPending = isImportRowReviewPending(row);
  const reviewHintLabel = row.reviewHints?.[0] || '';
  const hasMissingCell = useMemo(() => {
    const cells = row.cells || [];
    const hasAnyValue = cells.some((cell, idx) => idx !== noIdx && String(cell || '').trim() !== '');
    if (!hasAnyValue) return false;
    return cells.some((cell, idx) => idx !== noIdx && String(cell || '').trim() === '');
  }, [row.cells, noIdx]);
  const methodIdx = useMemo(
    () => SETTLEMENT_COLUMNS.findIndex((c) => c.csvHeader === '지출구분'),
    [],
  );
  const dateIdx = useMemo(
    () => SETTLEMENT_COLUMNS.findIndex((c) => c.csvHeader === '거래일시'),
    [],
  );
  const budgetCodeRaw = budgetCodeIdx >= 0 ? row.cells[budgetCodeIdx] : '';
  const budgetCode = normalizeBudgetLabel(String(budgetCodeRaw || ''));
  const subCodeRaw = subCodeIdx >= 0 ? row.cells[subCodeIdx] : '';
  const subCode = normalizeBudgetLabel(String(subCodeRaw || ''));
  const isAdjustmentRow = row.entryKind === 'ADJUSTMENT';
  const subCodes = useMemo(() => {
    const entry = budgetCodeBook.find((c) => c.code === budgetCode);
    return entry ? entry.subCodes : [];
  }, [budgetCode, budgetCodeBook]);
  const subItem = useMemo(
    () => findBudgetTreeSubItem(budgetTreeV2?.codes, budgetCode, subCode),
    [budgetTreeV2?.codes, budgetCode, subCode],
  );
  const subSubCodeOptions = useMemo(
    () => (subItem?.leafItems || [])
      .map((leaf) => normalizeBudgetLabel(leaf.subSubCode))
      .filter((value): value is string => Boolean(value)),
    [subItem],
  );
  const rowLabel = `${rowIdx + 1}행`;
  const commentTransactionId = row.sourceTxId || buildSheetRowCommentId(row.tempId);
  const [driveAction, setDriveAction] = useState<'' | 'provision' | 'sync'>('');
  const hasSourceTransaction = Boolean(persistedTransactionId);
  const canUseDrive = hasSourceTransaction || !!onEnsurePersistedTransaction;
  const expenseAudit = useMemo(
    () => findLatestFieldEdit(persistedTransaction, 'amounts.expenseAmount'),
    [persistedTransaction],
  );
  const persistedDriveStatusLabel = persistedTransaction?.evidenceDriveSyncStatus === 'UPLOADED'
    ? '업로드됨'
    : persistedTransaction?.evidenceDriveSyncStatus === 'SYNCED'
      ? '동기화됨'
      : '';
  const isCellSelected = useCallback((colIdx: number) => {
    if (!selectionBounds || colIdx === noIdx) return false;
    return rowIdx >= selectionBounds.r1
      && rowIdx <= selectionBounds.r2
      && colIdx >= selectionBounds.c1
      && colIdx <= selectionBounds.c2;
  }, [selectionBounds, rowIdx, noIdx]);
  const formatNumberInput = useCallback((value: string) => {
    if (!value) return '';
    const num = parseNumber(value);
    if (num == null) return value;
    return Number.isFinite(num) ? num.toLocaleString('ko-KR') : value;
  }, []);
  const isManualPriorityOutflowField = useCallback((header: string) => (
    header === '사업비 사용액' || header === '매입부가세'
  ), []);
  const isDerivedFieldLocked = useCallback((header: string) => {
    if (isManualPriorityOutflowField(header)) return false;
    if (header === '통장잔액') {
      return settlementSheetPolicy.readOnlyDerivedFields.includes('balance') && !isAdjustmentRow;
    }
    if (!isAdjustmentRow) return false;
    if (header === '사업비 사용액') return settlementSheetPolicy.readOnlyDerivedFields.includes('expenseAmount');
    if (header === '통장에 찍힌 입/출금액') return settlementSheetPolicy.readOnlyDerivedFields.includes('bankAmount');
    if (header === '매입부가세') return settlementSheetPolicy.readOnlyDerivedFields.includes('vatIn');
    return false;
  }, [isAdjustmentRow, isManualPriorityOutflowField, settlementSheetPolicy.readOnlyDerivedFields]);
  const resolveCellSource = useCallback((colIdx: number, header: string) => {
    if (isDerivedFieldLocked(header)) {
      return { label: '계산', className: 'bg-slate-100 text-slate-600' };
    }
    if (row.userEditedCells?.has(colIdx)) {
      return { label: '수정', className: 'bg-teal-100 text-teal-700' };
    }
    if (row.reviewRequiredCellIndexes?.includes(colIdx)) {
      return isReviewConfirmed
        ? { label: '확인', className: 'bg-slate-100 text-slate-700' }
        : { label: '검토', className: 'bg-[#26415f]/10 text-[#26415f]' };
    }
    const cellValue = String(row.cells[colIdx] || '').trim();
    if (
      row.sourceTxId
      && cellValue
      && (
        colIdx === budgetCodeIdx
        || colIdx === subCodeIdx
        || colIdx === cashflowIdx
        || colIdx === weekIdx
        || header === '통장잔액'
        || header === '통장에 찍힌 입/출금액'
        || header === '사업비 사용액'
        || header === '매입부가세'
        || header === '지급처'
      )
    ) {
      return { label: '원본', className: 'bg-slate-100 text-slate-600' };
    }
    return null;
  }, [budgetCodeIdx, cashflowIdx, isReviewConfirmed, row.cells, row.reviewRequiredCellIndexes, row.sourceTxId, row.userEditedCells, subCodeIdx, weekIdx, isDerivedFieldLocked]);
  const renderCommentButton = useCallback((fieldLabel: string) => {
    const fieldKey = toFieldSlug(fieldLabel);
    const count = commentCountByCell.get(buildCommentThreadKey(commentTransactionId, fieldKey)) || 0;
    return (
      <CellCommentButton
        count={count}
        onClick={() => {
          onOpenCellComments({
            transactionId: commentTransactionId,
            fieldKey,
            fieldLabel,
            rowLabel,
          });
        }}
      />
    );
  }, [commentCountByCell, commentTransactionId, onOpenCellComments, rowLabel]);

  const handlePaste = useCallback((
    colIdx: number,
    e: ReactClipboardEvent<HTMLTableCellElement | HTMLInputElement | HTMLSelectElement>,
  ) => {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    onPasteRange(rowIdx, colIdx, text);
  }, [onPasteRange, rowIdx]);

  const runDriveAction = useCallback(async (
    action: 'provision' | 'sync',
    handler?: (txId: string) => void | Promise<unknown>,
  ) => {
    if (!handler) return;
    const txId = persistedTransactionId || await onEnsurePersistedTransaction?.();
    if (!txId) return;
    setDriveAction(action);
    try {
      await handler(txId);
    } finally {
      setDriveAction('');
    }
  }, [onEnsurePersistedTransaction, persistedTransactionId]);

  return (
    <tr className={`${hasError
      ? 'bg-red-50/60 dark:bg-red-950/20'
      : hasMissingCell
        ? 'bg-red-50/40 dark:bg-red-950/10'
        : 'hover:bg-muted/30'
    } transition-colors`}>
      {/* Data cells */}
      {SETTLEMENT_COLUMNS.map((col, colIdx) => {
        const isReadOnly = readOnly || col.csvHeader === 'No.';
        const isBudgetCode = colIdx === budgetCodeIdx;
        const isSubCode = colIdx === subCodeIdx;
        const isSubSubCode = colIdx === subSubCodeIdx;
        const isWeek = colIdx === weekIdx;
        const isCashflow = colIdx === cashflowIdx;
        const isAuthor = colIdx === authorIdx;
        const isCounterparty = col.csvHeader === '지급처';
        const isDriveLink = col.csvHeader === '증빙자료 드라이브';
        const isExpenseAmount = col.csvHeader === '사업비 사용액';
        const isVatIn = col.csvHeader === '매입부가세';
        const isSettlementNote = col.csvHeader === '비고';
        const isDerivedLocked = isDerivedFieldLocked(col.csvHeader);
        const isManualPriorityField = isManualPriorityOutflowField(col.csvHeader);
        const cellSource = resolveCellSource(colIdx, col.csvHeader);
        const showCellBadge = Boolean(isDerivedLocked || cellSource);
        const isFirstColumn = colIdx === 0;
        const cellToneClass = isExpenseAmount || isVatIn
          ? 'bg-yellow-50/80 dark:bg-yellow-950/15'
          : '';
        const inputToneClass = isExpenseAmount || isVatIn
          ? 'bg-yellow-50/90 dark:bg-yellow-950/20 ring-1 ring-inset ring-yellow-200/80 dark:ring-yellow-800/50 rounded'
          : '';
        const hasAuthorOptions = (authorOptions || []).length > 0;
        return (
          <td
            key={colIdx}
            className={`px-0.5 py-0.5 border-b border-r focus-within:bg-teal-50/20 focus-within:shadow-[inset_0_0_0_2px_rgba(20,184,166,0.8)] ${cellToneClass} ${isCellSelected(colIdx)
              ? 'bg-teal-50/40 dark:bg-teal-900/20 shadow-[inset_0_0_0_2px_rgba(20,184,166,0.7)]'
              : ''
            }`}
            style={{ width: colWidths[colIdx], minWidth: 60 }}
            onPaste={(e) => {
              if (isReadOnly) return;
              handlePaste(colIdx, e);
            }}
            onMouseDown={() => onCellMouseDown(rowIdx, colIdx)}
            onMouseEnter={() => onCellMouseEnter(rowIdx, colIdx)}
          >
            <div className={`group relative ${showCellBadge ? 'pt-4' : ''}`}>
              {isFirstColumn && !readOnly && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className="absolute right-1 top-1 z-10 inline-flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
                      title="행 작업"
                    >
                      <GripVertical className="h-2.5 w-2.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="text-[11px]">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onInsertBelow();
                      }}
                    >
                      <Plus className="h-3.5 w-3.5" />
                      아래에 행 추가
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      disabled={!settlementSheetPolicy.allowRowDelete}
                      onClick={(e) => {
                        e.stopPropagation();
                        if (!settlementSheetPolicy.allowRowDelete) return;
                        onRemove();
                      }}
                    >
                      <X className="h-3.5 w-3.5" />
                      {settlementSheetPolicy.allowRowDelete ? '행 삭제' : '행 삭제 잠금'}
                    </DropdownMenuItem>
                    {hasReviewHint && (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          onClick={(e) => {
                            e.stopPropagation();
                            onRowChange((prev) => {
                              if (!hasImportRowReviewRequirement(prev)) return prev;
                              if (isImportRowReviewConfirmed(prev)) {
                                const next: ImportRow = { ...prev, reviewStatus: 'pending' };
                                delete next.reviewConfirmedAt;
                                return next;
                              }
                              return {
                                ...prev,
                                reviewStatus: 'confirmed',
                                reviewConfirmedAt: new Date().toISOString(),
                              };
                            });
                          }}
                        >
                          <Check className="h-3.5 w-3.5" />
                          {isReviewConfirmed ? '검토 완료 해제' : '검토 완료'}
                        </DropdownMenuItem>
                      </>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              {isFirstColumn && (hasError || hasMissingCell || isReviewPending) && (
                <span
                  className={`absolute left-1 top-1 h-1 w-1 rounded-full ${
                    hasError || hasMissingCell ? 'bg-rose-500' : 'bg-[#26415f]'
                  }`}
                  title={hasError ? (row.error || '행 오류') : hasMissingCell ? '미입력 셀 있음' : reviewHintLabel}
                />
              )}
              {isReadOnly ? (
                <span className="block pr-6 text-[10px] text-muted-foreground px-1">
                  {row.cells[colIdx]}
                </span>
              ) : isWeek ? (
                <div className="pr-6">
                  <SelectCell
                    value={row.cells[colIdx] || ''}
                    options={weekOptions}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(next) => onCellChange(colIdx, next)}
                  />
                </div>
              ) : colIdx === methodIdx ? (
                <div className="pr-6">
                  <SelectCell
                    value={row.cells[colIdx] || ''}
                    options={METHOD_OPTIONS.map((o) => ({ value: o.label, label: o.label }))}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(next) => {
                      if (next !== row.cells[colIdx]) onCellChange(colIdx, next);
                    }}
                  />
                </div>
              ) : isCashflow ? (
                <div className="pr-6">
                  <SelectCell
                    value={row.cells[colIdx] || ''}
                    options={cashflowOptions.map((o) => ({ value: o.label, label: o.label }))}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(next) => onCellChange(colIdx, next)}
                  />
                </div>
              ) : isBudgetCode ? (
                <div className="pr-6">
                  <SelectCell
                    value={normalizeBudgetLabel(String(row.cells[colIdx] || ''))}
                    options={budgetCodeBook.map((c, idx) => ({ value: c.code, label: formatBudgetCodeLabel(idx, c.code) }))}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(nextCode) => {
                      onRowChange((prev) => {
                        if (budgetCodeIdx < 0) return prev;
                        const cells = [...prev.cells];
                        cells[budgetCodeIdx] = nextCode;
                        if (subCodeIdx >= 0) {
                          const allowed = budgetCodeBook.find((c) => c.code === nextCode)?.subCodes || [];
                          const currentSub = normalizeBudgetLabel(String(cells[subCodeIdx] || ''));
                          if (!allowed.includes(currentSub)) {
                            cells[subCodeIdx] = '';
                          } else {
                            cells[subCodeIdx] = currentSub;
                          }
                        }
                        if (subSubCodeIdx >= 0) {
                          cells[subSubCodeIdx] = '';
                        }
                        if (evidenceIdx >= 0) {
                          const mapped = resolveEvidenceRequiredDesc(evidenceRequiredMap, nextCode, cells[subCodeIdx] || '');
                          if (mapped) cells[evidenceIdx] = mapped;
                        }
                        return { ...prev, cells };
                      });
                    }}
                  />
                  {budgetSuggestion && !budgetCode && (
                    <button
                      type="button"
                      className="mt-0.5 w-full text-left text-[9px] bg-teal-50 border border-teal-200 rounded px-1.5 py-0.5 text-teal-700 hover:bg-teal-100 truncate leading-tight"
                      title={`${budgetSuggestion.confidence === 'codebook' ? '코드북 기반 제안' : '이전 거래 기반 제안'}: ${budgetSuggestion.budgetCategory}${budgetSuggestion.budgetSubCategory ? ` · ${budgetSuggestion.budgetSubCategory}` : ''}`}
                      onClick={() => {
                        onBudgetSuggestionAccepted?.(budgetSuggestion.confidence ?? 'history');
                        onRowChange((prev) => {
                          if (budgetCodeIdx < 0) return prev;
                          const cells = [...prev.cells];
                          cells[budgetCodeIdx] = budgetSuggestion.budgetCategory;
                          if (subCodeIdx >= 0 && budgetSuggestion.budgetSubCategory) {
                            cells[subCodeIdx] = budgetSuggestion.budgetSubCategory;
                          }
                          if (subSubCodeIdx >= 0) {
                            cells[subSubCodeIdx] = '';
                          }
                          if (evidenceIdx >= 0) {
                            const mapped = resolveEvidenceRequiredDesc(evidenceRequiredMap, budgetSuggestion.budgetCategory, budgetSuggestion.budgetSubCategory);
                            if (mapped) cells[evidenceIdx] = mapped;
                          }
                          return { ...prev, cells };
                        });
                      }}
                    >
                      ↑ {budgetSuggestion.budgetCategory}{budgetSuggestion.budgetSubCategory ? ` · ${budgetSuggestion.budgetSubCategory}` : ''}
                    </button>
                  )}
                </div>
              ) : isSubCode ? (
                <div className="pr-6">
                  {!budgetCode ? (
                    <SelectCell
                      value={normalizeBudgetLabel(String(row.cells[colIdx] || ''))}
                      options={budgetCodeBook.flatMap((c, codeIdx) =>
                        c.subCodes.map((sc, sidx) => ({
                          value: `${c.code}::${sc}`,
                          label: `${formatBudgetCodeLabel(codeIdx, c.code)} > ${formatSubCodeLabel(codeIdx, sidx, sc)}`,
                        })),
                      )}
                      onFocus={() => onCellFocus(rowIdx, colIdx)}
                      rowIdx={rowIdx}
                      cellColIdx={colIdx}
                      isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                      onOpen={() => onOpenSelect(rowIdx, colIdx)}
                      onClose={onCloseSelect}
                      onChange={(packed) => {
                        const [parentCode, nextSub] = packed.split('::');
                        onRowChange((prev) => {
                          const cells = [...prev.cells];
                          if (budgetCodeIdx >= 0) cells[budgetCodeIdx] = parentCode;
                          if (subCodeIdx >= 0) cells[subCodeIdx] = nextSub;
                          if (subSubCodeIdx >= 0) cells[subSubCodeIdx] = '';
                          if (evidenceIdx >= 0) {
                            const mapped = resolveEvidenceRequiredDesc(evidenceRequiredMap, parentCode, nextSub);
                            if (mapped) cells[evidenceIdx] = mapped;
                          }
                          return { ...prev, cells };
                        });
                      }}
                    />
                  ) : (
                    <SelectCell
                      value={normalizeBudgetLabel(String(row.cells[colIdx] || ''))}
                      options={subCodes.map((sc, sidx) => {
                        const codeIdx = Math.max(0, budgetCodeBook.findIndex((c) => c.code === budgetCode));
                        return { value: sc, label: formatSubCodeLabel(codeIdx, sidx, sc) };
                      })}
                      onFocus={() => onCellFocus(rowIdx, colIdx)}
                      rowIdx={rowIdx}
                      cellColIdx={colIdx}
                      isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                      onOpen={() => onOpenSelect(rowIdx, colIdx)}
                      onClose={onCloseSelect}
                      onChange={(nextSub) => {
                        onRowChange((prev) => {
                          if (subCodeIdx < 0) return prev;
                          const cells = [...prev.cells];
                          cells[subCodeIdx] = nextSub;
                          if (subSubCodeIdx >= 0) cells[subSubCodeIdx] = '';
                          if (evidenceIdx >= 0) {
                            const mapped = resolveEvidenceRequiredDesc(evidenceRequiredMap, budgetCode, nextSub);
                            if (mapped) cells[evidenceIdx] = mapped;
                          }
                          return { ...prev, cells };
                        });
                      }}
                    />
                  )}
                </div>
              ) : isSubSubCode ? (
                <div className="pr-6">
                  <SelectCell
                    value={normalizeBudgetLabel(String(row.cells[colIdx] || ''))}
                    options={subSubCodeOptions.map((value, idx) => ({
                      value,
                      label: `${idx + 1}. ${value}`,
                    }))}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    disabled={!budgetCode || !subCode || subSubCodeOptions.length === 0}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(nextSubSub) => onCellChange(colIdx, nextSubSub)}
                  />
                </div>
              ) : isAuthor && hasAuthorOptions ? (
                <div className="pr-6">
                  <SelectCell
                    value={row.cells[colIdx] || ''}
                    options={(authorOptions || []).map((name) => ({ value: name, label: name }))}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    rowIdx={rowIdx}
                    cellColIdx={colIdx}
                    isOpen={openSelect?.rowIdx === rowIdx && openSelect?.colIdx === colIdx}
                    onOpen={() => onOpenSelect(rowIdx, colIdx)}
                    onClose={onCloseSelect}
                    onChange={(next) => onCellChange(colIdx, next)}
                  />
                </div>
              ) : isSettlementNote ? (
                <div className="flex items-center gap-1 pr-6">
                  <select
                    value={parseContentStatusNote(String(row.cells[colIdx] || '')).status}
                    data-cell-row={rowIdx}
                    data-cell-col={colIdx}
                    className="h-6 rounded border bg-background px-1 text-[10px]"
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    onChange={(e) => {
                      const parsed = parseContentStatusNote(String(row.cells[colIdx] || ''));
                      onCellChange(colIdx, composeContentStatusNote(
                        (e.target.value as '' | '미완료' | '완료'),
                        parsed.text,
                      ));
                    }}
                  >
                    <option value="">상태</option>
                    <option value="미완료">미완료</option>
                    <option value="완료">완료</option>
                  </select>
                  <input
                    type="text"
                    value={parseContentStatusNote(String(row.cells[colIdx] || '')).text}
                    className="w-full bg-transparent outline-none text-[11px] px-1 py-0.5"
                    data-cell-row={rowIdx}
                    data-cell-col={colIdx}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    onPaste={(e) => handlePaste(colIdx, e)}
                    onChange={(e) => {
                      const parsed = parseContentStatusNote(String(row.cells[colIdx] || ''));
                      onCellChange(colIdx, composeContentStatusNote(parsed.status, e.target.value));
                    }}
                  />
                </div>
              ) : isDriveLink ? (
                <div className="space-y-1.5 pr-10">
                  <div className="flex flex-wrap items-center gap-1">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[9px]"
                      disabled={readOnly || driveAction !== '' || !canUseDrive || !onProvisionEvidenceDriveById}
                      title={hasSourceTransaction ? '거래별 증빙 폴더 생성' : '필요한 값을 확인한 뒤 실제 거래로 저장하고 계속합니다'}
                      onClick={() => {
                        void runDriveAction('provision', onProvisionEvidenceDriveById);
                      }}
                    >
                      {driveAction === 'provision' ? '생성중' : '생성'}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[9px]"
                      disabled={readOnly || !canUseDrive || !onOpenEvidenceUpload}
                      title={hasSourceTransaction ? '파일 업로드 및 분류 검토' : '필요한 값을 확인한 뒤 실제 거래로 저장하고 계속합니다'}
                      onClick={() => {
                        if (!onOpenEvidenceUpload) return;
                        void (async () => {
                          const txId = persistedTransactionId || await onEnsurePersistedTransaction?.();
                          if (!txId) return;
                          onOpenEvidenceUpload(txId);
                        })();
                      }}
                    >
                      <Upload className="mr-1 h-2.5 w-2.5" />
                      업로드
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-5 px-1.5 text-[9px]"
                      disabled={readOnly || driveAction !== '' || !canUseDrive || !onSyncEvidenceDriveById}
                      title={hasSourceTransaction ? 'Drive 폴더 파일을 다시 읽어 완료 목록에 반영' : '필요한 값을 확인한 뒤 실제 거래로 저장하고 계속합니다'}
                      onClick={() => {
                        void runDriveAction('sync', onSyncEvidenceDriveById);
                      }}
                    >
                      {driveAction === 'sync' ? '동기화중' : '동기화'}
                    </Button>
                    {persistedDriveStatusLabel && (
                      <span
                        className={`rounded-full border px-1.5 py-0.5 text-[9px] font-medium ${
                          persistedTransaction?.evidenceDriveSyncStatus === 'UPLOADED'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-sky-200 bg-sky-50 text-sky-700'
                        }`}
                        title={persistedTransaction?.evidenceDriveSyncStatus === 'UPLOADED'
                          ? '업로드는 완료됐고 완료 목록도 바로 반영된 상태입니다.'
                          : 'Drive 폴더 파일 기준 완료 목록이 반영된 상태입니다.'}
                      >
                        {persistedDriveStatusLabel}
                      </span>
                    )}
                  </div>
                  <input
                    type="text"
                    value={row.cells[colIdx] || ''}
                    className="w-full bg-transparent outline-none text-[11px] px-1 py-0.5"
                    data-cell-row={rowIdx}
                    data-cell-col={colIdx}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    onPaste={(e) => handlePaste(colIdx, e)}
                    onChange={(e) => onCellChange(colIdx, e.target.value)}
                    placeholder={hasSourceTransaction ? '' : '행 저장 후 Drive 사용 가능'}
                  />
                </div>
              ) : isExpenseAmount ? (
                <div className="space-y-0.5 pr-6">
                  <input
                    type="text"
                    value={row.cells[colIdx] || ''}
                    className={`w-full outline-none text-[11px] px-1 py-0.5 ${isDerivedLocked ? 'bg-muted/40 text-muted-foreground cursor-not-allowed rounded' : inputToneClass}`}
                    data-cell-row={rowIdx}
                    data-cell-col={colIdx}
                    readOnly={isDerivedLocked}
                    onFocus={() => onCellFocus(rowIdx, colIdx)}
                    onPaste={(e) => handlePaste(colIdx, e)}
                    onChange={(e) => onCellChange(colIdx, formatNumberInput(e.target.value))}
                  />
                  {expenseAudit && (
                    <div className="px-1 text-[9px] leading-tight text-muted-foreground">
                      최종 수정 {expenseAudit.editedBy} · {formatCommentTime(expenseAudit.editedAt)}
                    </div>
                  )}
                </div>
              ) : (
                <input
                  type="text"
                  value={row.cells[colIdx] || ''}
                  className={`w-full outline-none text-[11px] px-1 py-0.5 pr-6 ${isDerivedLocked ? 'bg-muted/40 text-muted-foreground cursor-not-allowed rounded' : isManualPriorityField ? inputToneClass : 'bg-transparent'} ${hasError && colIdx === dateIdx && !row.cells[colIdx]
                    ? 'ring-1 ring-red-300 rounded'
                    : ''
                    }`}
                  data-cell-row={rowIdx}
                  data-cell-col={colIdx}
                  list={isAuthor && authorListId ? authorListId : undefined}
                  readOnly={isDerivedLocked}
                  onFocus={() => onCellFocus(rowIdx, colIdx)}
                  onPaste={(e) => handlePaste(colIdx, e)}
                  onChange={(e) => {
                    if (isDerivedLocked) return;
                    const next = col.format === 'number'
                      ? formatNumberInput(e.target.value)
                      : e.target.value;
                    onCellChange(colIdx, next);
                  }}
                />
              )}
              {isDerivedLocked && (
                <span className="absolute left-1 top-0.5 rounded bg-muted px-1 text-[9px] text-muted-foreground">
                  계산값
                </span>
              )}
              {cellSource && !isDerivedLocked && (
                <span className={`absolute left-1 top-0.5 rounded px-1 text-[9px] ${cellSource.className}`}>
                  {cellSource.label}
                </span>
              )}
              {isCounterparty && counterpartyHint && !readOnly && (
                <button
                  type="button"
                  className="mt-0.5 w-full text-left text-[9px] bg-amber-50 border border-amber-200 rounded px-1.5 py-0.5 text-amber-700 hover:bg-amber-100 truncate leading-tight"
                  title={`혹시 "${counterpartyHint.original}"을(를) 입력하려 하셨나요?`}
                  onClick={() => onCellChange(colIdx, counterpartyHint.original)}
                >
                  혹시 {counterpartyHint.original}?
                </button>
              )}
              {isDriveLink && isValidDriveUrl(String(row.cells[colIdx] || '')) && (
                <a
                  href={String(row.cells[colIdx] || '')}
                  target="_blank"
                  rel="noreferrer"
                  className="absolute top-1 right-7 inline-flex h-5 w-5 items-center justify-center rounded-md border bg-background text-[10px] hover:bg-muted"
                  title="증빙 드라이브 열기"
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  <ExternalLink className="h-3 w-3" />
                </a>
              )}
              {renderCommentButton(col.csvHeader)}
            </div>
          </td>
        );
      })}
    </tr>
  );
}

function selectionKeyForRow(
  rowIdx: number,
  selectionBounds: { r1: number; r2: number; c1: number; c2: number } | null,
): string {
  if (!selectionBounds || rowIdx < selectionBounds.r1 || rowIdx > selectionBounds.r2) {
    return '';
  }
  return `${selectionBounds.c1}:${selectionBounds.c2}`;
}

function openSelectKeyForRow(
  rowIdx: number,
  openSelect: { rowIdx: number; colIdx: number } | null,
): string {
  return openSelect?.rowIdx === rowIdx ? String(openSelect.colIdx) : '';
}

export const MemoizedImportEditorRow = memo(ImportEditorRow, (prev, next) => {
  return prev.row === next.row
    && prev.rowIdx === next.rowIdx
    && prev.authorListId === next.authorListId
    && prev.authorOptions === next.authorOptions
    && prev.budgetCodeBook === next.budgetCodeBook
    && prev.budgetTreeV2 === next.budgetTreeV2
    && prev.budgetCodeIdx === next.budgetCodeIdx
    && prev.subCodeIdx === next.subCodeIdx
    && prev.subSubCodeIdx === next.subSubCodeIdx
    && prev.evidenceIdx === next.evidenceIdx
    && prev.weekIdx === next.weekIdx
    && prev.cashflowIdx === next.cashflowIdx
    && prev.weekOptions === next.weekOptions
    && prev.cashflowOptions === next.cashflowOptions
    && prev.settlementSheetPolicy === next.settlementSheetPolicy
    && prev.evidenceRequiredMap === next.evidenceRequiredMap
    && prev.commentCountByCell === next.commentCountByCell
    && prev.persistedTransactionId === next.persistedTransactionId
    && prev.noIdx === next.noIdx
    && prev.colWidths === next.colWidths
    && selectionKeyForRow(prev.rowIdx, prev.selectionBounds) === selectionKeyForRow(next.rowIdx, next.selectionBounds)
    && openSelectKeyForRow(prev.rowIdx, prev.openSelect) === openSelectKeyForRow(next.rowIdx, next.openSelect)
    && prev.budgetSuggestion === next.budgetSuggestion
    && prev.counterpartyHint === next.counterpartyHint;
});
