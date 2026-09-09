import { Fragment, useState, useMemo, useCallback, useEffect, type DragEvent } from 'react';
import {
  Lock, SlidersHorizontal, ChevronDown, ChevronRight,
  Calculator, Wallet, TrendingUp, Info,
  ArrowUp, ArrowDown, Plus, Trash2, Settings, GripVertical, Upload,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '../ui/dialog';
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '../ui/tooltip';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs';
import { Textarea } from '../ui/textarea';
import { PageHeader } from '../layout/PageHeader';
import { useAuth } from '../../data/auth-store';
import { usePortalStore } from '../../data/portal-store';
import { toast } from 'sonner';
import {
  fmtKRW, fmtPercent, fmtShort,
} from '../../data/budget-data';
import type {
  BudgetPlanRow,
  BudgetCodeEntry,
  BudgetCodeRename,
  BudgetTreeCode,
  BudgetTreeLeafItem,
  BudgetTreeSubItem,
} from '../../data/types';
import { BASIS_LABELS } from '../../data/types';
import { useFirebase } from '../../lib/firebase-context';
import {
  analyzeGoogleSheetImportViaBff,
  isPlatformApiEnabled,
  type GoogleSheetMigrationAnalysisResult,
} from '../../lib/platform-bff-client';
import {
  buildBudgetImportAiMatrixSample,
  buildBudgetImportAiRequestKey,
  resolveBudgetImportAiSheetName,
  shouldAnalyzeBudgetImportWithAi,
} from '../../platform/budget-import-ai';
import {
  mergeBudgetCodeBooks,
  parseBudgetPlanImportText,
  selectBudgetPlanImportSheet,
} from '../../platform/budget-plan-import';
import { parseNumber } from '../../platform/csv-utils';
import {
  aggregateBudgetActualsFromSettlementRowsLocally,
} from '../../platform/settlement-calculation-kernel';
import { buildBudgetLabelKey, normalizeBudgetLabel } from '../../platform/budget-labels';
import {
  buildBudgetTreeFromLegacySnapshots,
  buildLegacyBudgetSnapshotsFromTree,
  budgetTreeHasSubSubCodes,
  cloneBudgetTreeCodes,
  normalizeBudgetTreeCodes,
} from '../../platform/budget-tree-v2';
import { parseBudgetPlanMatrix, planBudgetPlanMerge } from '../../platform/google-sheet-migration';
import { parseLocalWorkbookFile, type LocalWorkbookSheet } from '../../platform/local-workbook';

// ═══════════════════════════════════════════════════════════════
// PortalBudget — 예산총괄 (리디자인 — 모바일 우선, 깨짐 방지)
// ═══════════════════════════════════════════════════════════════

function groupIdForEntry(name: string): string {
  return normalizeBudgetLabel(name) || '기타';
}

function formatBudgetContractPeriod(start: string, end: string): string {
  const startYear = /^\d{4}/.exec(start)?.[0] || '';
  const endYear = /^\d{4}/.exec(end)?.[0] || '';
  if (!startYear && !endYear) return '계약기간 미등록';
  return startYear && endYear && startYear !== endYear ? `${startYear}–${endYear}` : `${startYear || endYear}년`;
}

// 소진율 색상
function burnColor(rate: number): string {
  if (rate >= 0.8) return '#e11d48';
  if (rate >= 0.5) return '#f59e0b';
  if (rate > 0) return '#059669';
  return '#94a3b8';
}

interface BudgetCodeImportPreview {
  rows: BudgetCodeEntry[];
  totalPairs: number;
  duplicatePairs: number;
  skippedRows: number;
  headerDetected: boolean;
  samplePairs: Array<{ code: string; subCode: string }>;
}

type BudgetPlanImportTab = 'file' | 'paste';

const BUDGET_IMPORT_GUIDE_ITEMS = [
  '헤더에는 가능하면 `비목`, `세목`, `최초 승인 예산`을 그대로 넣어 주세요.',
  '한 행에는 하나의 비목/세목 조합만 두고, 데이터 행의 병합 셀은 풀어 주세요.',
  '개인단위와 계약클라이언트는 각각 별도 세목 행으로 나누어 주세요.',
  '소계/합계/총계 행은 가져오기 전에 제거하면 가장 안정적입니다.',
];

const BUDGET_IMPORT_RECOVERY_GUIDE_ITEMS = [
  '헤더를 한 줄로 정리하고 `비목`, `세목`, `최초 승인 예산`, `변경 예산`, `비고`처럼 명확히 써 주세요.',
  '같은 비목이 이어져도 빈칸 대신 비목명을 반복해서 넣으면 인식이 더 안정적입니다.',
  '설명용 안내 문구, 메모 열, 색상 강조는 남겨도 되지만 데이터 본문보다 위쪽 행은 줄여 주세요.',
];

function parseCsvCells(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let idx = 0; idx < line.length; idx += 1) {
    const ch = line[idx];
    if (ch === '"') {
      if (inQuotes && line[idx + 1] === '"') {
        current += '"';
        idx += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

function looksLikeBudgetCodeHeader(code: string, subCode: string): boolean {
  const left = normalizeBudgetLabel(code).replace(/\s+/g, '').toLowerCase();
  const right = normalizeBudgetLabel(subCode).replace(/\s+/g, '').toLowerCase();
  const codeCandidates = new Set(['비목', 'budgetcode', 'budgetcategory', 'category']);
  const subCandidates = new Set(['세목', 'subcode', 'subcategory', 'detailcategory']);
  return codeCandidates.has(left) && subCandidates.has(right);
}

function parseBudgetCodeImportText(text: string): BudgetCodeImportPreview {
  const grouped = new Map<string, { code: string; subCodes: string[]; seenSubs: Set<string> }>();
  const samplePairs: Array<{ code: string; subCode: string }> = [];
  const seenPairs = new Set<string>();
  const lines = text.split(/\r?\n/);
  let totalPairs = 0;
  let duplicatePairs = 0;
  let skippedRows = 0;
  let headerDetected = false;
  let processedLineCount = 0;

  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) return;
    const cells = line.includes('\t') ? line.split('\t').map((cell) => cell.trim()) : parseCsvCells(line);
    const rawCode = String(cells[0] || '').trim();
    const rawSubCode = String(cells[1] || '').trim();
    if (!rawCode || !rawSubCode) {
      skippedRows += 1;
      return;
    }
    if (processedLineCount === 0 && looksLikeBudgetCodeHeader(rawCode, rawSubCode)) {
      headerDetected = true;
      processedLineCount += 1;
      return;
    }
    processedLineCount += 1;

    const codeKey = normalizeBudgetLabel(rawCode);
    const subKey = normalizeBudgetLabel(rawSubCode);
    if (!codeKey || !subKey) {
      skippedRows += 1;
      return;
    }

    const pairKey = `${codeKey}|${subKey}`;
    if (seenPairs.has(pairKey)) {
      duplicatePairs += 1;
      return;
    }
    seenPairs.add(pairKey);
    totalPairs += 1;

    const existing = grouped.get(codeKey);
    if (existing) {
      if (!existing.seenSubs.has(subKey)) {
        existing.subCodes.push(rawSubCode);
        existing.seenSubs.add(subKey);
      }
    } else {
      grouped.set(codeKey, {
        code: rawCode,
        subCodes: [rawSubCode],
        seenSubs: new Set([subKey]),
      });
    }
    if (samplePairs.length < 6) {
      samplePairs.push({ code: rawCode, subCode: rawSubCode });
    }
  });

  return {
    rows: Array.from(grouped.values()).map((entry) => ({ code: entry.code, subCodes: entry.subCodes })),
    totalPairs,
    duplicatePairs,
    skippedRows,
    headerDetected,
    samplePairs,
  };
}

function resolveBudgetImportAnalysisError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'AI 보조 분석을 불러오지 못했습니다.';
}

function formatConfidenceLabel(value?: 'high' | 'medium' | 'low'): string {
  switch (value) {
    case 'high':
      return '높음';
    case 'medium':
      return '중간';
    default:
      return '낮음';
  }
}

interface BudgetDraftRow {
  rowType: 'subItem' | 'leaf';
  budgetCode: string;
  subCode: string;
  subSubCode: string;
  initialBudget: string;
  revisedBudget: string;
  note: string;
}

interface BudgetLeafView {
  key: string;
  budgetCode: string;
  subCode: string;
  subSubCode: string;
  initialBudget: number;
  revisedBudget: number;
  effectiveBudget: number;
  spent: number;
  balance: number;
  burnRate: number;
  note: string;
}

interface BudgetSubItemView {
  key: string;
  budgetCode: string;
  subCode: string;
  leafItems: BudgetLeafView[];
  targetInitialBudget: number;
  targetRevisedBudget: number;
  leafInitialBudgetTotal: number;
  leafRevisedBudgetTotal: number;
  aggregateSpent: number;
  initialBudget: number;
  revisedBudget: number;
  effectiveBudget: number;
  spent: number;
  balance: number;
  burnRate: number;
  isSplit: boolean;
  note: string;
  hasInitialBudgetMismatch: boolean;
  hasRevisedBudgetMismatch: boolean;
}

interface BudgetCodeView {
  key: string;
  budgetCode: string;
  subItems: BudgetSubItemView[];
  initialBudget: number;
  revisedBudget: number;
  effectiveBudget: number;
  spent: number;
  balance: number;
  burnRate: number;
}

interface BudgetTreeDraftValidationResult {
  isValid: boolean;
  errors: string[];
}

function cloneSubItem(subItem: BudgetTreeSubItem): BudgetTreeSubItem {
  return {
    subCode: subItem.subCode,
    ...(typeof subItem.initialBudget === 'number' ? { initialBudget: subItem.initialBudget } : {}),
    ...(typeof subItem.revisedBudget === 'number' ? { revisedBudget: subItem.revisedBudget } : {}),
    ...(subItem.note ? { note: subItem.note } : {}),
    leafItems: subItem.leafItems.map((leaf) => ({
      ...(leaf.subSubCode ? { subSubCode: leaf.subSubCode } : {}),
      initialBudget: leaf.initialBudget,
      ...(typeof leaf.revisedBudget === 'number' ? { revisedBudget: leaf.revisedBudget } : {}),
      ...(leaf.note ? { note: leaf.note } : {}),
    })),
  };
}

function createEmptyLeafItem(): BudgetTreeLeafItem {
  return { initialBudget: 0, revisedBudget: 0, note: '' };
}

function createEmptySubItem(): BudgetTreeSubItem {
  return {
    subCode: '',
    initialBudget: 0,
    revisedBudget: 0,
    leafItems: [createEmptyLeafItem()],
  };
}

function validateBudgetTreeDraft(entries: BudgetTreeCode[]): BudgetTreeDraftValidationResult {
  const errors: string[] = [];
  if (!Array.isArray(entries) || entries.length === 0) {
    return { isValid: false, errors: ['비목을 1개 이상 입력해 주세요.'] };
  }

  entries.forEach((codeEntry, codeIdx) => {
    const codeLabel = normalizeBudgetLabel(codeEntry.code);
    if (!codeLabel) {
      errors.push(`${codeIdx + 1}번째 비목명을 입력해 주세요.`);
      return;
    }
    if (!Array.isArray(codeEntry.subItems) || codeEntry.subItems.length === 0) {
      errors.push(`${codeLabel}에 세목을 1개 이상 추가해 주세요.`);
      return;
    }
    const subSeen = new Set<string>();
    codeEntry.subItems.forEach((subItem, subIdx) => {
      const subLabel = normalizeBudgetLabel(subItem.subCode);
      if (!subLabel) {
        errors.push(`${codeLabel}의 ${subIdx + 1}번째 세목명을 입력해 주세요.`);
        return;
      }
      if (subSeen.has(subLabel)) {
        errors.push(`${codeLabel} 안에 중복된 세목명 ${subLabel}이 있습니다.`);
      }
      subSeen.add(subLabel);

      const normalizedLeafLabels = (subItem.leafItems || []).map((leaf) => normalizeBudgetLabel(leaf.subSubCode));
      const splitMode = normalizedLeafLabels.some(Boolean) || normalizedLeafLabels.length > 1;
      if (!splitMode) return;
      const leafSeen = new Set<string>();
      normalizedLeafLabels.forEach((leafLabel, leafIdx) => {
        if (!leafLabel) {
          errors.push(`${codeLabel} > ${subLabel}의 ${leafIdx + 1}번째 세세목명을 입력해 주세요.`);
          return;
        }
        if (leafSeen.has(leafLabel)) {
          errors.push(`${codeLabel} > ${subLabel} 안에 중복된 세세목명 ${leafLabel}이 있습니다.`);
        }
        leafSeen.add(leafLabel);
      });
    });
  });

  return {
    isValid: errors.length === 0,
    errors,
  };
}

function getLeafRowKey(row: Pick<BudgetDraftRow, 'budgetCode' | 'subCode' | 'subSubCode'>): string {
  return buildBudgetLabelKey(row.budgetCode, row.subCode, row.subSubCode);
}

function getSubItemRowKey(row: Pick<BudgetDraftRow, 'budgetCode' | 'subCode'>): string {
  return buildBudgetLabelKey(row.budgetCode, row.subCode);
}

function buildDraftRowsFromTree(codes: BudgetTreeCode[]): BudgetDraftRow[] {
  return codes.flatMap((codeEntry) => codeEntry.subItems.flatMap((subItem) => {
    const hasSplitLeaves = subItem.leafItems.some((leaf) => normalizeBudgetLabel(leaf.subSubCode));
    const rows: BudgetDraftRow[] = [];
    if (hasSplitLeaves) {
      rows.push({
        rowType: 'subItem',
        budgetCode: codeEntry.code,
        subCode: subItem.subCode,
        subSubCode: '',
        initialBudget: subItem.initialBudget ? subItem.initialBudget.toLocaleString('ko-KR') : '',
        revisedBudget: subItem.revisedBudget ? subItem.revisedBudget.toLocaleString('ko-KR') : '',
        note: subItem.note || '',
      });
    }
    return rows.concat(
      subItem.leafItems.map((leaf) => ({
        rowType: 'leaf',
        budgetCode: codeEntry.code,
        subCode: subItem.subCode,
        subSubCode: leaf.subSubCode || '',
        initialBudget: leaf.initialBudget ? leaf.initialBudget.toLocaleString('ko-KR') : '',
        revisedBudget: leaf.revisedBudget ? leaf.revisedBudget.toLocaleString('ko-KR') : '',
        note: leaf.note || '',
      })),
    );
  }));
}

function mergeDraftRowsIntoTree(codes: BudgetTreeCode[], rows: BudgetDraftRow[]): BudgetTreeCode[] {
  const subItemRowMap = new Map(
    rows
      .filter((row) => row.rowType === 'subItem')
      .map((row) => [getSubItemRowKey(row), row]),
  );
  const leafRowMap = new Map(
    rows
      .filter((row) => row.rowType === 'leaf')
      .map((row) => [getLeafRowKey(row), row]),
  );
  return normalizeBudgetTreeCodes(codes.map((codeEntry) => ({
    code: codeEntry.code,
    subItems: codeEntry.subItems.map((subItem) => ({
      subCode: subItem.subCode,
      ...(() => {
        const subItemDraft = subItemRowMap.get(buildBudgetLabelKey(codeEntry.code, subItem.subCode));
        if (!subItemDraft) {
          return {
            ...(typeof subItem.initialBudget === 'number' ? { initialBudget: subItem.initialBudget } : {}),
            ...(typeof subItem.revisedBudget === 'number' ? { revisedBudget: subItem.revisedBudget } : {}),
            ...(subItem.note ? { note: subItem.note } : {}),
          };
        }
        const initialBudget = parseNumber(subItemDraft.initialBudget) ?? 0;
        const revisedBudget = parseNumber(subItemDraft.revisedBudget) ?? 0;
        return {
          ...(initialBudget > 0 ? { initialBudget } : {}),
          ...(revisedBudget > 0 ? { revisedBudget } : {}),
          ...(subItemDraft.note.trim() ? { note: subItemDraft.note.trim() } : {}),
        };
      })(),
      leafItems: subItem.leafItems.map((leaf) => {
        const key = buildBudgetLabelKey(codeEntry.code, subItem.subCode, leaf.subSubCode || '');
        const draft = leafRowMap.get(key);
        if (!draft) return leaf;
        const initialBudget = parseNumber(draft.initialBudget) ?? 0;
        const revisedBudget = parseNumber(draft.revisedBudget) ?? 0;
        return {
          ...(leaf.subSubCode ? { subSubCode: leaf.subSubCode } : {}),
          initialBudget,
          ...(revisedBudget > 0 ? { revisedBudget } : {}),
          ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
        };
      }),
    })),
  })));
}

function buildBudgetCodeViews(
  codes: BudgetTreeCode[],
  spentMap: Map<string, number>,
): BudgetCodeView[] {
  const getSubItemSpentTotal = (budgetCode: string, subCode: string): number => {
    const baseKey = buildBudgetLabelKey(budgetCode, subCode);
    const splitPrefix = `${baseKey}|`;
    let total = 0;
    spentMap.forEach((amount, key) => {
      if (key === baseKey || key.startsWith(splitPrefix)) total += amount;
    });
    return total;
  };

  return codes.map((codeEntry) => {
    const subItems = codeEntry.subItems.map((subItem) => {
      const isSplit = subItem.leafItems.some((leaf) => normalizeBudgetLabel(leaf.subSubCode));
      const subItemSpentTotal = getSubItemSpentTotal(codeEntry.code, subItem.subCode);
      const leafItems = subItem.leafItems.map((leaf) => {
        const key = buildBudgetLabelKey(codeEntry.code, subItem.subCode, leaf.subSubCode || '');
        const initialBudget = Number.isFinite(leaf.initialBudget) ? leaf.initialBudget : 0;
        const revisedBudget = Number.isFinite(leaf.revisedBudget ?? NaN) ? (leaf.revisedBudget as number) : 0;
        const effectiveBudget = revisedBudget > 0 ? revisedBudget : initialBudget;
        const spent = leaf.subSubCode ? (spentMap.get(key) || 0) : subItemSpentTotal;
        return {
          key,
          budgetCode: codeEntry.code,
          subCode: subItem.subCode,
          subSubCode: leaf.subSubCode || '',
          initialBudget,
          revisedBudget,
          effectiveBudget,
          spent,
          balance: effectiveBudget - spent,
          burnRate: effectiveBudget > 0 ? spent / effectiveBudget : 0,
          note: leaf.note || '',
        } satisfies BudgetLeafView;
      });
      const leafInitialBudgetTotal = leafItems.reduce((sum, leaf) => sum + leaf.initialBudget, 0);
      const leafRevisedBudgetTotal = leafItems.reduce((sum, leaf) => sum + leaf.revisedBudget, 0);
      const targetInitialBudget = Number.isFinite(subItem.initialBudget ?? NaN)
        ? (subItem.initialBudget as number)
        : leafInitialBudgetTotal;
      const targetRevisedBudget = Number.isFinite(subItem.revisedBudget ?? NaN)
        ? (subItem.revisedBudget as number)
        : leafRevisedBudgetTotal;
      const initialBudget = isSplit ? targetInitialBudget : leafInitialBudgetTotal;
      const revisedBudget = isSplit ? targetRevisedBudget : leafRevisedBudgetTotal;
      const effectiveBudget = revisedBudget > 0 ? revisedBudget : initialBudget;
      const leafSpentTotal = leafItems.reduce((sum, leaf) => sum + leaf.spent, 0);
      const spent = isSplit ? subItemSpentTotal : leafSpentTotal;
      const aggregateSpent = spent;
      return {
        key: buildBudgetLabelKey(codeEntry.code, subItem.subCode),
        budgetCode: codeEntry.code,
        subCode: subItem.subCode,
        leafItems,
        targetInitialBudget,
        targetRevisedBudget,
        leafInitialBudgetTotal,
        leafRevisedBudgetTotal,
        aggregateSpent,
        initialBudget,
        revisedBudget,
        effectiveBudget,
        spent,
        balance: effectiveBudget - spent,
        burnRate: effectiveBudget > 0 ? spent / effectiveBudget : 0,
        isSplit,
        note: subItem.note || '',
        hasInitialBudgetMismatch: isSplit && targetInitialBudget !== leafInitialBudgetTotal,
        hasRevisedBudgetMismatch: isSplit && ((targetRevisedBudget > 0 || leafRevisedBudgetTotal > 0) && targetRevisedBudget !== leafRevisedBudgetTotal),
      } satisfies BudgetSubItemView;
    });
    const initialBudget = subItems.reduce((sum, subItem) => sum + subItem.initialBudget, 0);
    const revisedBudget = subItems.reduce((sum, subItem) => sum + subItem.revisedBudget, 0);
    const effectiveBudget = subItems.reduce((sum, subItem) => sum + subItem.effectiveBudget, 0);
    const spent = subItems.reduce((sum, subItem) => sum + subItem.aggregateSpent, 0);
    return {
      key: groupIdForEntry(codeEntry.code),
      budgetCode: codeEntry.code,
      subItems,
      initialBudget,
      revisedBudget,
      effectiveBudget,
      spent,
      balance: effectiveBudget - spent,
      burnRate: effectiveBudget > 0 ? spent / effectiveBudget : 0,
    } satisfies BudgetCodeView;
  });
}

export function PortalBudget() {
  const { user: authUser } = useAuth();
  const { orgId } = useFirebase();
  const {
    portalUser,
    myProject,
    expenseSheets,
    expenseSheetRows,
    budgetPlanRows,
    budgetCodeBook,
    budgetTreeV2,
    saveBudgetPlanRows,
    saveBudgetCodeBook,
    saveBudgetTreeV2,
    sheetSources,
  } = usePortalStore();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [collapsedSubItems, setCollapsedSubItems] = useState<Set<string>>(new Set());
  const [openedLeafEditors, setOpenedLeafEditors] = useState<Set<string>>(new Set());
  const [selectedRow, setSelectedRow] = useState<BudgetLeafView | null>(null);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [codeBookMode, setCodeBookMode] = useState(false);
  const [draftRows, setDraftRows] = useState<BudgetDraftRow[]>([]);
  const [draftTreeCodes, setDraftTreeCodes] = useState<BudgetTreeCode[]>([]);
  const [codeBookEditorTab, setCodeBookEditorTab] = useState<'manual' | 'paste' | 'csv'>('manual');
  const [codeBookImportText, setCodeBookImportText] = useState('');
  const [codeBookImportFileName, setCodeBookImportFileName] = useState('');
  const [codeBookReplaceMode, setCodeBookReplaceMode] = useState(false);
  const [budgetImportOpen, setBudgetImportOpen] = useState(false);
  const [budgetImportTab, setBudgetImportTab] = useState<BudgetPlanImportTab>('file');
  const [budgetImportText, setBudgetImportText] = useState('');
  const [budgetImportFileName, setBudgetImportFileName] = useState('');
  const [budgetImportSheets, setBudgetImportSheets] = useState<LocalWorkbookSheet[]>([]);
  const [budgetImportSheetName, setBudgetImportSheetName] = useState('');
  const [budgetImportLoading, setBudgetImportLoading] = useState(false);
  const [budgetImportApplying, setBudgetImportApplying] = useState(false);
  const [budgetImportSavedSource, setBudgetImportSavedSource] = useState<ProjectSheetSourceSnapshot | null>(null);
  const [budgetImportAiAnalysis, setBudgetImportAiAnalysis] = useState<GoogleSheetMigrationAnalysisResult | null>(null);
  const [budgetImportAiLoading, setBudgetImportAiLoading] = useState(false);
  const [budgetImportAiError, setBudgetImportAiError] = useState('');
  const [budgetImportAiResolvedKey, setBudgetImportAiResolvedKey] = useState('');
  const [draggedSubCode, setDraggedSubCode] = useState<{ codeIdx: number; subIdx: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    codeIdx: number;
    subIdx: number;
    position: 'before' | 'after';
  } | null>(null);
  const projectId = myProject?.id || '';
  const platformApiEnabled = isPlatformApiEnabled();
  const meta = myProject ? {
    projectId: myProject.id,
    projectName: myProject.name,
    funder: myProject.clientOrg,
    basis: BASIS_LABELS[myProject.basis] || myProject.basis,
    totalBudget: myProject.contractAmount,
    lastUpdated: myProject.updatedAt ? new Date(myProject.updatedAt).toLocaleDateString('ko-KR') : '-',
    updatedBy: myProject.managerName || '-',
  } : null;

  const toggleGroup = (gid: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      next.has(gid) ? next.delete(gid) : next.add(gid);
      return next;
    });
  };

  const toggleSubItem = useCallback((key: string) => {
    setCollapsedSubItems((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  const [spentMap, setSpentMap] = useState<Map<string, number>>(
    () => aggregateBudgetActualsFromSettlementRowsLocally(
      expenseSheets.flatMap((sheet) => sheet.rows || []).length > 0
        ? expenseSheets.flatMap((sheet) => sheet.rows || [])
        : expenseSheetRows,
    ),
  );

  const allExpenseSheetRows = useMemo(
    () => {
      const rows = expenseSheets.flatMap((sheet) => sheet.rows || []);
      return rows.length > 0 ? rows : expenseSheetRows;
    },
    [expenseSheets, expenseSheetRows],
  );

  const activeTreeCodes = useMemo(
    () => normalizeBudgetTreeCodes(
      budgetTreeV2?.codes && budgetTreeV2.codes.length > 0
        ? cloneBudgetTreeCodes(budgetTreeV2.codes)
        : buildBudgetTreeFromLegacySnapshots(budgetCodeBook, budgetPlanRows || []),
    ),
    [budgetCodeBook, budgetPlanRows, budgetTreeV2?.codes],
  );

  const codeBookImportPreview = useMemo(
    () => parseBudgetCodeImportText(codeBookImportText),
    [codeBookImportText],
  );
  const codeBookValidation = useMemo(
    () => validateBudgetTreeDraft(draftTreeCodes),
    [draftTreeCodes],
  );
  const budgetImportSelectedSheet = useMemo(
    () => budgetImportSheets.find((sheet) => sheet.name === budgetImportSheetName) || budgetImportSheets[0] || null,
    [budgetImportSheets, budgetImportSheetName],
  );
  const budgetSheetSources = useMemo(
    () => sheetSources
      .filter((source) => source.sourceType === 'budget' && Array.isArray(source.previewMatrix) && source.previewMatrix.length > 0)
      .sort((left, right) => String(right.uploadedAt || '').localeCompare(String(left.uploadedAt || ''))),
    [sheetSources],
  );
  const budgetImportMatrix = useMemo(
    () => (budgetImportSavedSource?.previewMatrix && budgetImportSavedSource.previewMatrix.length > 0
      ? budgetImportSavedSource.previewMatrix
      : budgetImportTab === 'paste'
      ? parseBudgetPlanImportText(budgetImportText)
      : (budgetImportSelectedSheet?.matrix || [])),
    [budgetImportSavedSource?.previewMatrix, budgetImportSelectedSheet?.matrix, budgetImportTab, budgetImportText],
  );
  const budgetImportParsed = useMemo(
    () => parseBudgetPlanMatrix(budgetImportMatrix),
    [budgetImportMatrix],
  );
  const budgetImportMergePlan = useMemo(
    () => planBudgetPlanMerge(budgetPlanRows || [], budgetImportParsed.rows),
    [budgetPlanRows, budgetImportParsed.rows],
  );
  const budgetImportMergedCodeBook = useMemo(
    () => mergeBudgetCodeBooks(budgetCodeBook, budgetImportParsed.codeBook),
    [budgetCodeBook, budgetImportParsed.codeBook],
  );
  const budgetImportMergedSubCodeCount = useMemo(
    () => budgetImportMergedCodeBook.reduce((sum, entry) => sum + entry.subCodes.length, 0),
    [budgetImportMergedCodeBook],
  );
  const budgetImportConfidenceLabel = useMemo(
    () => formatConfidenceLabel(budgetImportParsed.confidence),
    [budgetImportParsed.confidence],
  );
  const budgetImportAiConfidenceLabel = useMemo(
    () => formatConfidenceLabel(budgetImportAiAnalysis?.confidence),
    [budgetImportAiAnalysis?.confidence],
  );
  const bffActor = useMemo(() => ({
    uid: authUser?.uid || portalUser?.id || 'portal-user',
    email: authUser?.email || portalUser?.email || '',
    role: authUser?.role || portalUser?.role || 'pm',
    idToken: authUser?.idToken,
    googleAccessToken: authUser?.googleAccessToken,
  }), [
    authUser?.uid,
    authUser?.email,
    authUser?.role,
    authUser?.idToken,
    authUser?.googleAccessToken,
    portalUser?.id,
    portalUser?.email,
    portalUser?.role,
  ]);
  const budgetImportAiSheetName = useMemo(() => resolveBudgetImportAiSheetName({
    tab: budgetImportTab,
    selectedSheetName: budgetImportSavedSource?.sheetName || budgetImportSelectedSheet?.name,
    fileName: budgetImportSavedSource?.fileName || budgetImportFileName,
  }), [
    budgetImportSavedSource?.fileName,
    budgetImportSavedSource?.sheetName,
    budgetImportFileName,
    budgetImportSelectedSheet?.name,
    budgetImportTab,
  ]);
  const budgetImportAiShouldRun = useMemo(() => shouldAnalyzeBudgetImportWithAi({
    open: budgetImportOpen,
    platformApiEnabled,
    tenantId: orgId,
    projectId,
    matrix: budgetImportMatrix,
    importedRowCount: budgetImportParsed.rows.length,
    confidence: budgetImportParsed.confidence,
    warningCount: budgetImportParsed.warnings?.length || 0,
    formatGuideRecommended: budgetImportParsed.formatGuideRecommended,
  }), [
    budgetImportMatrix,
    budgetImportOpen,
    budgetImportParsed.confidence,
    budgetImportParsed.formatGuideRecommended,
    budgetImportParsed.rows.length,
    budgetImportParsed.warnings?.length,
    orgId,
    platformApiEnabled,
    projectId,
  ]);
  const budgetImportAiMatrixSample = useMemo(
    () => buildBudgetImportAiMatrixSample(budgetImportMatrix),
    [budgetImportMatrix],
  );
  const budgetImportAiKey = useMemo(() => (
    budgetImportAiShouldRun && orgId && projectId
      ? buildBudgetImportAiRequestKey({
        tenantId: orgId,
        projectId,
        sheetName: budgetImportAiSheetName,
        matrix: budgetImportAiMatrixSample,
      })
      : ''
  ), [
    budgetImportAiSheetName,
    budgetImportAiShouldRun,
    budgetImportAiMatrixSample,
    orgId,
    projectId,
  ]);
  const budgetImportShowAiPanel = budgetImportAiShouldRun || budgetImportAiLoading || Boolean(budgetImportAiAnalysis) || Boolean(budgetImportAiError);

  useEffect(() => {
    setSpentMap(aggregateBudgetActualsFromSettlementRowsLocally(allExpenseSheetRows));
  }, [allExpenseSheetRows]);

  const formatInput = useCallback((value: string) => {
    const num = parseNumber(value);
    if (num == null) return '';
    return num.toLocaleString('ko-KR');
  }, []);

  const formatInputLive = useCallback((value: string) => {
    const trimmed = value.replace(/[^0-9.,-]/g, '');
    return formatInput(trimmed);
  }, [formatInput]);

  const resetBudgetImport = useCallback(() => {
    setBudgetImportTab('file');
    setBudgetImportText('');
    setBudgetImportFileName('');
    setBudgetImportSheets([]);
    setBudgetImportSheetName('');
    setBudgetImportSavedSource(null);
    setBudgetImportLoading(false);
    setBudgetImportApplying(false);
    setBudgetImportAiAnalysis(null);
    setBudgetImportAiLoading(false);
    setBudgetImportAiError('');
    setBudgetImportAiResolvedKey('');
  }, []);

  const closeBudgetImport = useCallback(() => {
    if (budgetImportApplying) return;
    setBudgetImportOpen(false);
    resetBudgetImport();
  }, [budgetImportApplying, resetBudgetImport]);

  const updateBudgetCode = useCallback((idx: number, nextCode: string) => {
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => (
      entryIdx === idx ? { ...entry, code: nextCode } : entry
    )));
  }, []);

  const updateSubCode = useCallback((idx: number, subIdx: number, nextSub: string) => {
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => {
      if (entryIdx !== idx) return entry;
      return {
        ...entry,
        subItems: entry.subItems.map((subItem, currentSubIdx) => (
          currentSubIdx === subIdx ? { ...subItem, subCode: nextSub } : subItem
        )),
      };
    }));
  }, []);

  const updateLeafSubSubCode = useCallback((idx: number, subIdx: number, leafIdx: number, nextValue: string) => {
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => {
      if (entryIdx !== idx) return entry;
      return {
        ...entry,
        subItems: entry.subItems.map((subItem, currentSubIdx) => {
          if (currentSubIdx !== subIdx) return subItem;
          return {
            ...subItem,
            leafItems: subItem.leafItems.map((leaf, currentLeafIdx) => (
              currentLeafIdx === leafIdx
                ? { ...leaf, subSubCode: nextValue }
                : leaf
            )),
          };
        }),
      };
    }));
  }, []);

  const addBudgetCode = useCallback(() => {
    setDraftTreeCodes((prev) => ([...prev, { code: '', subItems: [createEmptySubItem()] }]));
  }, []);

  const removeBudgetCode = useCallback((idx: number) => {
    setDraftTreeCodes((prev) => prev.filter((_, entryIdx) => entryIdx !== idx));
  }, []);

  const addSubCode = useCallback((idx: number) => {
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => (
      entryIdx === idx
        ? { ...entry, subItems: [...entry.subItems, createEmptySubItem()] }
        : entry
    )));
  }, []);

  const removeSubCode = useCallback((idx: number, subIdx: number) => {
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => {
      if (entryIdx !== idx) return entry;
      if (entry.subItems.length <= 1) {
        toast.error('각 비목에는 세목이 최소 1개 필요합니다.');
        return entry;
      }
      return {
        ...entry,
        subItems: entry.subItems.filter((_, currentSubIdx) => currentSubIdx !== subIdx),
      };
    }));
  }, []);

  const addLeafItem = useCallback((idx: number, subIdx: number) => {
    const editorKey = `${idx}:${subIdx}`;
    const wasOpened = openedLeafEditors.has(editorKey);
    setOpenedLeafEditors((prev) => {
      const next = new Set(prev);
      next.add(editorKey);
      return next;
    });
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => {
      if (entryIdx !== idx) return entry;
      return {
        ...entry,
        subItems: entry.subItems.map((subItem, currentSubIdx) => (
          currentSubIdx === subIdx
            ? (() => {
              const hasNamedLeaf = subItem.leafItems.some((leaf) => normalizeBudgetLabel(leaf.subSubCode));
              if (!wasOpened && !hasNamedLeaf && subItem.leafItems.length <= 1) {
                const baseLeaf = subItem.leafItems[0];
                return {
                  ...subItem,
                  initialBudget: subItem.initialBudget ?? baseLeaf?.initialBudget ?? 0,
                  revisedBudget: subItem.revisedBudget ?? baseLeaf?.revisedBudget ?? 0,
                  note: subItem.note ?? baseLeaf?.note ?? '',
                  leafItems: subItem.leafItems.length === 0
                    ? [createEmptyLeafItem()]
                    : subItem.leafItems.map((leaf, leafItemIdx) => (
                      leafItemIdx === 0
                        ? { ...leaf, initialBudget: 0, revisedBudget: 0, note: '' }
                        : leaf
                    )),
                };
              }
              return { ...subItem, leafItems: [...subItem.leafItems, createEmptyLeafItem()] };
            })()
            : subItem
        )),
      };
    }));
  }, [openedLeafEditors]);

  const removeLeafItem = useCallback((idx: number, subIdx: number, leafIdx: number) => {
    const editorKey = `${idx}:${subIdx}`;
    let shouldCloseEditor = false;
    let shouldKeepEditorOpen = false;
    setDraftTreeCodes((prev) => prev.map((entry, entryIdx) => {
      if (entryIdx !== idx) return entry;
      return {
        ...entry,
        subItems: entry.subItems.map((subItem, currentSubIdx) => {
          if (currentSubIdx !== subIdx) return subItem;
          if (subItem.leafItems.length <= 1) {
            shouldCloseEditor = true;
            return {
              ...subItem,
              leafItems: [{
                initialBudget: subItem.initialBudget ?? 0,
                revisedBudget: subItem.revisedBudget ?? 0,
                note: subItem.note ?? '',
              }],
            };
          }
          const nextLeafItems = subItem.leafItems.filter((_, currentLeafIdx) => currentLeafIdx !== leafIdx);
          const hasNamedLeaf = nextLeafItems.some((leaf) => normalizeBudgetLabel(leaf.subSubCode));
          if (!hasNamedLeaf && nextLeafItems.length === 0) {
            shouldCloseEditor = true;
            return {
              ...subItem,
              leafItems: [{
                initialBudget: subItem.initialBudget ?? nextLeafItems[0]?.initialBudget ?? 0,
                revisedBudget: subItem.revisedBudget ?? nextLeafItems[0]?.revisedBudget ?? 0,
                note: subItem.note ?? nextLeafItems[0]?.note ?? '',
              }],
            };
          }
          shouldKeepEditorOpen = true;
          return {
            ...subItem,
            leafItems: nextLeafItems,
          };
        }),
      };
    }));
    if (shouldCloseEditor) {
      setOpenedLeafEditors((prev) => {
        if (!prev.has(editorKey)) return prev;
        const next = new Set(prev);
        next.delete(editorKey);
        return next;
      });
    } else if (shouldKeepEditorOpen) {
      setOpenedLeafEditors((prev) => {
        if (prev.has(editorKey)) return prev;
        const next = new Set(prev);
        next.add(editorKey);
        return next;
      });
    }
  }, []);

  const reorderSubCode = useCallback((idx: number, subIdx: number, direction: 'up' | 'down') => {
    setDraftTreeCodes((prev) => {
      const next = cloneBudgetTreeCodes(prev);
      const entry = next[idx];
      if (!entry) return prev;
      const targetIdx = direction === 'up' ? subIdx - 1 : subIdx + 1;
      if (targetIdx < 0 || targetIdx >= entry.subItems.length) return prev;
      const [moved] = entry.subItems.splice(subIdx, 1);
      entry.subItems.splice(targetIdx, 0, moved);
      return next;
    });
  }, []);

  const handleSubCodeDragStart = useCallback((codeIdx: number, subIdx: number) => {
    setDraggedSubCode({ codeIdx, subIdx });
    setDropTarget({ codeIdx, subIdx, position: 'before' });
  }, []);

  const handleSubCodeDragOver = useCallback((
    event: DragEvent<HTMLDivElement>,
    codeIdx: number,
    subIdx: number,
  ) => {
    if (!draggedSubCode || draggedSubCode.codeIdx !== codeIdx) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const position = event.clientY - rect.top > rect.height / 2 ? 'after' : 'before';
    setDropTarget({ codeIdx, subIdx, position });
  }, [draggedSubCode]);

  const handleSubCodeDrop = useCallback((codeIdx: number, subIdx: number) => {
    if (!draggedSubCode || draggedSubCode.codeIdx !== codeIdx) {
      setDraggedSubCode(null);
      setDropTarget(null);
      return;
    }

    setDraftTreeCodes((prev) => {
      const entry = prev[codeIdx];
      if (!entry) return prev;

      const next = cloneBudgetTreeCodes(prev);
      const nextEntry = next[codeIdx];
      if (!nextEntry) return prev;
      const insertIndex = dropTarget?.codeIdx === codeIdx && dropTarget.subIdx === subIdx
        ? (dropTarget.position === 'after' ? subIdx + 1 : subIdx)
        : subIdx;
      const boundedInsertIndex = Math.max(0, Math.min(insertIndex, nextEntry.subItems.length));
      const targetIndex = draggedSubCode.subIdx < boundedInsertIndex
        ? boundedInsertIndex - 1
        : boundedInsertIndex;
      const [moved] = nextEntry.subItems.splice(draggedSubCode.subIdx, 1);
      nextEntry.subItems.splice(targetIndex, 0, moved);
      return next;
    });
    setDraggedSubCode(null);
    setDropTarget(null);
  }, [draggedSubCode, dropTarget]);

  const handleSubCodeDragEnd = useCallback(() => {
    setDraggedSubCode(null);
    setDropTarget(null);
  }, []);

  const startEdit = useCallback(() => {
    setDraftRows(buildDraftRowsFromTree(activeTreeCodes));
    setEditMode(true);
  }, [activeTreeCodes]);

  const startCodeBookEdit = useCallback(() => {
    setDraftTreeCodes(cloneBudgetTreeCodes(activeTreeCodes));
    setOpenedLeafEditors(new Set());
    setCodeBookEditorTab('manual');
    setCodeBookImportText('');
    setCodeBookImportFileName('');
    setCodeBookReplaceMode(false);
    setCodeBookMode(true);
  }, [activeTreeCodes]);

  const cancelEdit = useCallback(() => {
    setEditMode(false);
    setCodeBookMode(false);
    setDraftRows([]);
    setDraftTreeCodes([]);
    setCodeBookEditorTab('manual');
    setCodeBookImportText('');
    setCodeBookImportFileName('');
    setCodeBookReplaceMode(false);
    setOpenedLeafEditors(new Set());
    setDraggedSubCode(null);
    setDropTarget(null);
  }, []);

  const applyImportedCodeBook = useCallback(() => {
    if (codeBookImportPreview.rows.length === 0) {
      toast.error('가져올 비목/세목 구조를 먼저 입력해 주세요.');
      return;
    }
    setDraftTreeCodes(codeBookImportPreview.rows.map((entry) => ({
      code: entry.code,
      subItems: entry.subCodes.map((subCode) => ({
        subCode,
        leafItems: [createEmptyLeafItem()],
      })),
    })));
    setOpenedLeafEditors(new Set());
    setCodeBookReplaceMode(true);
    setCodeBookEditorTab('manual');
    toast.success(`비목 ${codeBookImportPreview.rows.length}개, 세목 ${codeBookImportPreview.totalPairs}건을 구조 초안으로 불러왔습니다.`);
  }, [codeBookImportPreview]);

  const handleCodeBookImportFile = useCallback(async (file: File | null) => {
    if (!file) return;
    try {
      const text = await file.text();
      setCodeBookImportText(text);
      setCodeBookImportFileName(file.name);
      setCodeBookEditorTab('csv');
    } catch (error) {
      console.error('[PortalBudget] code book file import failed:', error);
      toast.error('CSV 파일을 읽지 못했습니다.');
    }
  }, []);

  const handleBudgetImportFile = useCallback(async (file: File | null) => {
    if (!file) return;
    setBudgetImportLoading(true);
    try {
      setBudgetImportSavedSource(null);
      const sheets = await parseLocalWorkbookFile(file);
      const preferredSheet = selectBudgetPlanImportSheet(sheets);
      setBudgetImportFileName(file.name);
      setBudgetImportSheets(sheets);
      setBudgetImportSheetName(preferredSheet?.name || sheets[0]?.name || '');
      setBudgetImportTab('file');
      if (!preferredSheet) {
        toast.error('가져올 시트를 찾지 못했습니다.');
      }
    } catch (error) {
      console.error('[PortalBudget] budget import file parse failed:', error);
      toast.error('예산 파일을 읽지 못했습니다. `.xls`/`.xlsx`/`.csv` 파일인지 확인해 주세요.');
    } finally {
      setBudgetImportLoading(false);
    }
  }, []);

  const handleBudgetImportSavedSource = useCallback((source: ProjectSheetSourceSnapshot) => {
    setBudgetImportSavedSource(source);
    setBudgetImportTab('file');
    setBudgetImportFileName(source.fileName || source.sheetName || '');
    setBudgetImportSheets([]);
    setBudgetImportSheetName(source.sheetName || '');
    setBudgetImportText('');
    setBudgetImportAiAnalysis(null);
    setBudgetImportAiError('');
    setBudgetImportAiResolvedKey('');
    toast.success(`저장된 원본에서 ${source.sheetName} 예산 미리보기를 불러왔습니다.`);
  }, []);

  const rerunBudgetImportAiAnalysis = useCallback(() => {
    setBudgetImportAiAnalysis(null);
    setBudgetImportAiError('');
    setBudgetImportAiResolvedKey('');
  }, []);

  useEffect(() => {
    if (!budgetImportAiShouldRun || !budgetImportAiKey || !orgId || !projectId) {
      setBudgetImportAiAnalysis(null);
      setBudgetImportAiLoading(false);
      setBudgetImportAiError('');
      setBudgetImportAiResolvedKey('');
      return undefined;
    }
    if (budgetImportAiResolvedKey === budgetImportAiKey || budgetImportAiLoading) return undefined;

    let cancelled = false;
    const timer = window.setTimeout(() => {
      setBudgetImportAiLoading(true);
      setBudgetImportAiError('');
      setBudgetImportAiResolvedKey(budgetImportAiKey);
      void analyzeGoogleSheetImportViaBff({
        tenantId: orgId,
        actor: bffActor,
        projectId,
        spreadsheetTitle: budgetImportFileName || '예산총괄 import',
        selectedSheetName: budgetImportAiSheetName,
        matrix: budgetImportAiMatrixSample,
      }).then((result) => {
        if (cancelled) return;
        setBudgetImportAiAnalysis(result);
      }).catch((error) => {
        if (cancelled) return;
        console.error('[PortalBudget] budget import AI analysis failed:', error);
        setBudgetImportAiAnalysis(null);
        setBudgetImportAiError(resolveBudgetImportAnalysisError(error));
      }).finally(() => {
        if (cancelled) return;
        setBudgetImportAiLoading(false);
      });
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    bffActor,
    budgetImportAiKey,
    budgetImportAiLoading,
    budgetImportAiResolvedKey,
    budgetImportAiSheetName,
    budgetImportAiShouldRun,
    budgetImportFileName,
    budgetImportAiMatrixSample,
    orgId,
    projectId,
  ]);

  const buildCodeBookRenames = useCallback((): BudgetCodeRename[] => {
    if (!codeBookMode) return [];
    const renames: BudgetCodeRename[] = [];
    const previousLegacy = buildLegacyBudgetSnapshotsFromTree(activeTreeCodes).codeBook;
    const nextLegacy = buildLegacyBudgetSnapshotsFromTree(draftTreeCodes).codeBook;
    nextLegacy.forEach((nextEntry, idx) => {
      const prevEntry = previousLegacy[idx];
      if (!prevEntry) return;
      const prevCode = normalizeBudgetLabel(prevEntry.code);
      const nextCode = normalizeBudgetLabel(nextEntry.code);
      if (!prevCode || !nextCode) return;
      const prevSubs = prevEntry.subCodes || [];
      const nextSubs = nextEntry.subCodes || [];
      const max = Math.min(prevSubs.length, nextSubs.length);
      for (let sidx = 0; sidx < max; sidx += 1) {
        const prevSub = normalizeBudgetLabel(prevSubs[sidx]);
        const nextSub = normalizeBudgetLabel(nextSubs[sidx]);
        if (!prevSub || !nextSub) continue;
        if (prevCode !== nextCode || prevSub !== nextSub) {
          renames.push({ fromCode: prevCode, fromSub: prevSub, toCode: nextCode, toSub: nextSub });
        }
      }
    });
    return renames;
  }, [activeTreeCodes, codeBookMode, draftTreeCodes]);

  const saveSettings = useCallback(async () => {
    if (!saveBudgetPlanRows && !saveBudgetCodeBook && !saveBudgetTreeV2) return;
    if (codeBookMode) {
      const validation = validateBudgetTreeDraft(draftTreeCodes);
      if (!validation.isValid) {
        toast.error(validation.errors[0] || '예산 구조를 확인해 주세요.');
        return;
      }
    }
    const normalized: Array<BudgetPlanRow & { subSubCode?: string }> = editMode ? draftRows
      .filter((row) => row.rowType === 'leaf')
      .map((row) => {
      const budgetCode = normalizeBudgetLabel(String(row.budgetCode || '').trim());
      const subCode = normalizeBudgetLabel(String(row.subCode || '').trim());
      const subSubCode = normalizeBudgetLabel(String(row.subSubCode || '').trim());
      const initial = parseNumber(row.initialBudget) ?? 0;
      const revised = parseNumber(row.revisedBudget) ?? 0;
      return {
        budgetCode,
        subCode,
        ...(subSubCode ? { subSubCode } : {}),
        initialBudget: initial,
        revisedBudget: revised,
        ...(row.note ? { note: row.note } : {}),
      };
    }).filter((row) => row.budgetCode && row.subCode)
      .filter((row) => row.initialBudget > 0 || (row.revisedBudget ?? 0) > 0 || (row.note && row.note.trim() !== ''))
      : [];

    setSettingsSaving(true);
    try {
      if (codeBookMode) {
        const normalizedTree = normalizeBudgetTreeCodes(draftTreeCodes);
        if (budgetTreeV2 || budgetTreeHasSubSubCodes(normalizedTree)) {
          await saveBudgetTreeV2(normalizedTree);
        } else if (saveBudgetCodeBook) {
          const renames = codeBookReplaceMode ? [] : buildCodeBookRenames();
          const legacy = buildLegacyBudgetSnapshotsFromTree(normalizedTree);
          await saveBudgetCodeBook(legacy.codeBook, renames);
        }
      }
      if (editMode) {
        const shouldUseV2 = Boolean(budgetTreeV2);
        if (shouldUseV2) {
          await saveBudgetTreeV2(mergeDraftRowsIntoTree(activeTreeCodes, draftRows));
        } else {
          await saveBudgetPlanRows(normalized);
        }
      }
      setEditMode(false);
      setCodeBookMode(false);
      setDraftRows([]);
      setDraftTreeCodes([]);
      setCodeBookEditorTab('manual');
      setCodeBookImportText('');
      setCodeBookImportFileName('');
      setCodeBookReplaceMode(false);
      toast.success(codeBookMode && !editMode ? '예산 항목 구조가 저장되었습니다.' : '예산이 저장되었습니다.');
    } catch (err) {
      console.error('[PortalBudget] save failed:', err);
      toast.error(codeBookMode && !editMode ? '예산 항목 구조 저장에 실패했습니다.' : '예산 저장에 실패했습니다.');
    } finally {
      setSettingsSaving(false);
    }
  }, [
    activeTreeCodes,
    buildCodeBookRenames,
    budgetTreeV2,
    codeBookMode,
    codeBookReplaceMode,
    draftRows,
    draftTreeCodes,
    editMode,
    saveBudgetCodeBook,
    saveBudgetPlanRows,
    saveBudgetTreeV2,
  ]);

  const applyBudgetImport = useCallback(async () => {
    if (!saveBudgetPlanRows || !saveBudgetCodeBook) {
      toast.error('예산 저장 기능이 연결되어 있지 않습니다.');
      return;
    }
    if (budgetImportMergePlan.importedRows.length === 0) {
      toast.error('가져올 예산 행을 먼저 준비해 주세요.');
      return;
    }

    setBudgetImportApplying(true);
    try {
      if (budgetTreeV2) {
        await saveBudgetTreeV2(buildBudgetTreeFromLegacySnapshots(
          budgetImportMergedCodeBook,
          budgetImportMergePlan.mergedRows,
        ));
      } else {
        await saveBudgetPlanRows(budgetImportMergePlan.mergedRows);
        await saveBudgetCodeBook(budgetImportMergedCodeBook);
      }
      toast.success(
        `예산 ${budgetImportMergePlan.summary.importedCount}건을 가져왔습니다. `
        + `${budgetImportMergePlan.summary.updateCount}건 갱신, `
        + `${budgetImportMergePlan.summary.createCount}건 추가, `
        + `${budgetImportMergePlan.summary.unchangedCount}건은 그대로 유지했습니다.`,
      );
      setBudgetImportOpen(false);
      resetBudgetImport();
    } catch (error) {
      console.error('[PortalBudget] budget import apply failed:', error);
      toast.error('예산 가져오기에 실패했습니다.');
    } finally {
      setBudgetImportApplying(false);
    }
  }, [
    budgetImportMergePlan,
    budgetImportMergedCodeBook,
    budgetTreeV2,
    resetBudgetImport,
    saveBudgetCodeBook,
    saveBudgetPlanRows,
    saveBudgetTreeV2,
  ]);

  const budgetCodeViews = useMemo(
    () => buildBudgetCodeViews(activeTreeCodes, spentMap),
    [activeTreeCodes, spentMap],
  );

  const total = useMemo(() => {
    const initialSum = budgetCodeViews.reduce((sum, code) => sum + code.initialBudget, 0);
    const revisedSum = budgetCodeViews.reduce((sum, code) => sum + code.revisedBudget, 0);
    const effectiveSum = budgetCodeViews.reduce((sum, code) => sum + code.effectiveBudget, 0);
    const spentSum = budgetCodeViews.reduce((sum, code) => sum + code.spent, 0);
    return {
      initialBudget: initialSum,
      revisedBudget: revisedSum,
      spent: spentSum,
      balance: effectiveSum - spentSum,
      burnRate: effectiveSum > 0 ? spentSum / effectiveSum : 0,
      effectiveBudget: effectiveSum,
    };
  }, [budgetCodeViews]);

  const auxRows = useMemo(() => {
    return budgetCodeViews.map((group) => {
      const effective = group.effectiveBudget;
      return {
        label: group.budgetCode || '기타',
        amount: effective,
      };
    });
  }, [budgetCodeViews]);

  const updateDraftLeafField = useCallback((
    rowKey: string,
    field: keyof Pick<BudgetDraftRow, 'initialBudget' | 'revisedBudget' | 'note'>,
    value: string,
  ) => {
    setDraftRows((prev) => prev.map((row) => (
      row.rowType === 'leaf' && getLeafRowKey(row) === rowKey ? { ...row, [field]: value } : row
    )));
  }, []);

  const updateDraftSubItemField = useCallback((
    rowKey: string,
    field: keyof Pick<BudgetDraftRow, 'initialBudget' | 'revisedBudget' | 'note'>,
    value: string,
  ) => {
    setDraftRows((prev) => prev.map((row) => (
      row.rowType === 'subItem' && getSubItemRowKey(row) === rowKey ? { ...row, [field]: value } : row
    )));
  }, []);

  if (!meta) {
    return <div className="p-8 text-center text-muted-foreground">프로젝트를 선택해 주세요.</div>;
  }

  return (
    <TooltipProvider delayDuration={200}>
      <div className="space-y-4">
        <PageHeader
          icon={Calculator}
          iconGradient="linear-gradient(135deg, #0d9488 0%, #059669 100%)"
          title="예산 편집"
          description={myProject ? myProject.name : '예산 현황'}
          badge={formatBudgetContractPeriod(myProject.contractStart, myProject.contractEnd)}
          headingVisible={false}
          actions={(
            <div className="flex items-center gap-2">
              {editMode ? (
                <>
                  <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={cancelEdit}>
                    취소
                  </Button>
                  <Button size="sm" className="h-8 text-[12px]" onClick={saveSettings} disabled={settingsSaving}>
                    {settingsSaving ? '저장 중...' : '저장'}
                  </Button>
                </>
              ) : !codeBookMode ? (
                <>
                  <Button variant="default" size="sm" className="h-8 text-[12px] shadow-sm" onClick={startEdit}>
                    예산 편집
                  </Button>
                  <Button variant="outline" size="sm" className="h-8 text-[12px] gap-1" onClick={startCodeBookEdit}>
                    <Settings className="w-3.5 h-3.5" />
                    구조 관리
                  </Button>
                </>
              ) : null}
            </div>
          )}
        />
        <Dialog open={budgetImportOpen} onOpenChange={(open) => !open && closeBudgetImport()}>
          <DialogContent className="max-w-3xl max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader className="shrink-0">
              <DialogTitle className="text-[14px]">예산총괄 가져오기</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex flex-1 flex-col gap-3 overflow-hidden">
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-[11px] font-medium text-foreground">예산총괄 엑셀 또는 복붙 데이터를 미리본 뒤 안전하게 반영합니다.</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  기본 동작은 merge입니다. 기존 예산 행은 유지하고, 같은 비목/세목은 갱신하며, 새 항목만 추가합니다.
                </p>
              </div>

              <Tabs
                value={budgetImportTab}
                onValueChange={(value) => setBudgetImportTab(value as BudgetPlanImportTab)}
                className="min-h-0 flex flex-1 flex-col overflow-hidden"
              >
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger value="file" className="text-[11px]">엑셀/CSV 파일</TabsTrigger>
                  <TabsTrigger value="paste" className="text-[11px]">엑셀 붙여넣기</TabsTrigger>
                </TabsList>

                <TabsContent value="file" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  {budgetSheetSources.length > 0 && (
                    <div className="rounded-md border border-emerald-200/70 bg-emerald-50/60 p-3">
                      <div className="flex items-center justify-between gap-2">
                        <div>
                          <p className="text-[11px] font-medium text-foreground">최근 저장된 예산 원본</p>
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            wizard에서 올린 예산 원본을 다시 업로드하지 않고 바로 가져올 수 있습니다.
                          </p>
                        </div>
                        <Badge variant="outline" className="text-[10px]">{budgetSheetSources.length}건</Badge>
                      </div>
                      <div className="mt-3 space-y-2">
                        {budgetSheetSources.slice(0, 3).map((source) => (
                          <div
                            key={`${source.sourceType}-${source.uploadedAt}-${source.sheetName}`}
                            className="flex flex-col gap-2 rounded-md border border-emerald-200/70 bg-white/90 px-3 py-2 md:flex-row md:items-center md:justify-between"
                          >
                            <div className="min-w-0">
                              <p className="truncate text-[11px] font-medium text-slate-900">{source.sheetName}</p>
                              <p className="truncate text-[10px] text-muted-foreground">
                                {source.fileName} · {source.rowCount}행 · {source.columnCount}열
                              </p>
                            </div>
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className="h-7 text-[11px]"
                              onClick={() => handleBudgetImportSavedSource(source)}
                            >
                              저장된 원본 가져오기
                            </Button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="rounded-md border border-border/60 p-3 space-y-2">
                    <p className="text-[11px] font-medium">`.xls`, `.xlsx`, `.csv` 파일을 바로 읽습니다.</p>
                    <p className="text-[10px] text-muted-foreground">
                      시트가 여러 개면 예산총괄로 보이는 탭을 먼저 고르고, 필요하면 아래에서 직접 시트를 바꿀 수 있습니다.
                    </p>
                  </div>
                  <div className="rounded-md border border-dashed border-border/70 p-4">
                    <input
                      type="file"
                      accept=".csv,.xlsx,.xls"
                      className="block w-full text-[11px]"
                      onChange={(event) => {
                        void handleBudgetImportFile(event.target.files?.[0] || null);
                        event.currentTarget.value = '';
                      }}
                    />
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {budgetImportLoading
                        ? '파일을 읽는 중입니다...'
                        : budgetImportFileName
                          ? `${budgetImportFileName} 파일을 읽어 미리보기를 준비했습니다.`
                          : '업로드 후 아래에서 시트와 반영 요약을 확인하세요.'}
                    </p>
                    {budgetImportSavedSource ? (
                      <p className="mt-1 text-[10px] text-emerald-700">
                        현재는 저장된 원본 `{budgetImportSavedSource.sheetName}` 미리보기를 사용 중입니다.
                      </p>
                    ) : null}
                    <div className="mt-3 rounded-md bg-muted/40 p-3">
                      <p className="text-[11px] font-medium text-foreground">잘 읽히는 파일 형식</p>
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-[10px] text-muted-foreground">
                        {BUDGET_IMPORT_GUIDE_ITEMS.map((item) => (
                          <li key={`budget-import-file-guide-${item}`}>{item}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  {budgetImportSheets.length > 1 ? (
                    <div className="space-y-1">
                      <p className="text-[10px] text-muted-foreground">가져올 시트</p>
                      <select
                        value={budgetImportSheetName}
                        onChange={(event) => setBudgetImportSheetName(event.target.value)}
                        className="h-9 w-full rounded-md border border-input bg-background px-3 text-[11px] outline-none"
                      >
                        {budgetImportSheets.map((sheet) => (
                          <option key={sheet.name} value={sheet.name}>
                            {sheet.name}
                          </option>
                        ))}
                      </select>
                    </div>
                  ) : null}
                </TabsContent>

                <TabsContent value="paste" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  <div className="rounded-md border border-border/60 p-3 space-y-2">
                    <p className="text-[11px] font-medium">예산총괄 표를 그대로 복사해서 붙여넣을 수 있습니다.</p>
                    <p className="text-[10px] text-muted-foreground">
                      탭 복붙과 CSV 붙여넣기를 모두 지원합니다. 다만 서식이 흔들릴수록 추정이 늘어나므로 아래 권장 형태에 맞추면 더 안정적으로 읽습니다.
                    </p>
                    <ul className="list-disc space-y-1 pl-4 text-[10px] text-muted-foreground">
                      {BUDGET_IMPORT_GUIDE_ITEMS.map((item) => (
                        <li key={`budget-import-paste-guide-${item}`}>{item}</li>
                      ))}
                    </ul>
                    <div className="rounded-md bg-slate-950 px-3 py-2 font-mono text-[10px] text-slate-50 whitespace-pre-wrap">
                      비목{'\t'}세목{'\t'}최초 승인 예산{'\t'}변경 예산{'\t'}비고{'\n'}
                      인건비{'\t'}개인단위{'\t'}1,000,000{'\t'}1,050,000{'\t'}내부 집행{'\n'}
                      인건비{'\t'}계약클라이언트{'\t'}2,000,000{'\t'}2,100,000{'\t'}외부 계약
                    </div>
                  </div>
                    <Textarea
                    value={budgetImportText}
                    onChange={(event) => {
                      setBudgetImportSavedSource(null);
                      setBudgetImportText(event.target.value);
                    }}
                    placeholder={'비목\t세목\t최초 승인 예산\t변경 예산\t비고\n인건비\t개인단위\t1,000,000\t1,050,000\t내부 집행'}
                    className="min-h-[220px] text-[11px] font-mono"
                  />
                </TabsContent>
              </Tabs>

              <div className="rounded-md border border-border/60 p-3 text-[10px]">
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span>가져온 행 {budgetImportMergePlan.summary.importedCount}건</span>
                  <span>갱신 {budgetImportMergePlan.summary.updateCount}건</span>
                  <span>신규 {budgetImportMergePlan.summary.createCount}건</span>
                  <span>유지 {budgetImportMergePlan.summary.unchangedCount}건</span>
                  <span>비목 {budgetImportMergedCodeBook.length}개</span>
                  <span>세목 {budgetImportMergedSubCodeCount}건</span>
                  <span>신뢰도 {budgetImportConfidenceLabel}</span>
                </div>
                <div className="mt-2 space-y-2 text-muted-foreground leading-[1.65] break-words">
                  {budgetImportTab === 'file' && budgetImportFileName ? (
                    <p>
                      파일: <strong className="text-foreground">{budgetImportFileName}</strong>
                      {budgetImportSelectedSheet ? ` / 시트: ${budgetImportSelectedSheet.name}` : ''}
                    </p>
                  ) : null}
                  {budgetImportMatrix.length > 0 && budgetImportParsed.rows.length === 0 ? (
                    <p className="text-rose-600">
                      예산총괄 헤더를 찾지 못했습니다. `비목`, `세목`, `최초 승인 예산` 열이 들어 있는지 확인해 주세요.
                    </p>
                  ) : null}
                  {budgetImportMergePlan.importedRows.length > 0 ? (
                    <p>
                      동일한 비목/세목 키는 덮어쓰고, 현재 화면에만 있는 기존 예산 항목은 삭제하지 않습니다.
                    </p>
                  ) : null}
                </div>
                {budgetImportParsed.formatGuideRecommended ? (
                  <div className="mt-3 rounded-md border border-amber-200/80 bg-amber-50/70 px-3 py-2">
                    <p className="text-amber-700 leading-[1.65] break-words">
                      현재 표는 일부 열을 추정해 읽었습니다. 아래 권장 형식으로 한 번 정리한 뒤 다시 가져오면 더 안정적으로 반영됩니다.
                    </p>
                    <ul className="mt-2 list-disc space-y-2 pl-4 text-amber-700 leading-[1.65] break-words">
                      {BUDGET_IMPORT_RECOVERY_GUIDE_ITEMS.map((item) => (
                        <li key={`budget-import-recovery-guide-${item}`}>{item}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}
                {(budgetImportParsed.warnings || []).slice(0, 3).map((warning, warningIdx) => (
                  <p
                    key={`budget-import-warning-${warningIdx}`}
                    className="mt-2 text-amber-700 leading-[1.65] break-words"
                  >
                    {warning}
                  </p>
                ))}
              </div>

              {budgetImportShowAiPanel ? (
                <div className="rounded-md border border-sky-200 bg-sky-50/80 p-3 text-[10px] text-sky-950">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <p className="text-[11px] font-medium">AI 보조 판독</p>
                      {budgetImportAiAnalysis ? (
                        <Badge variant="outline" className="border-sky-300 bg-white/80 text-[10px] text-sky-700">
                          {budgetImportAiAnalysis.provider === 'anthropic' ? 'AI' : '기본 분석'} · 신뢰도 {budgetImportAiConfidenceLabel}
                        </Badge>
                      ) : null}
                    </div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[10px] text-sky-700 hover:text-sky-900"
                      onClick={rerunBudgetImportAiAnalysis}
                      disabled={budgetImportAiLoading}
                    >
                      {budgetImportAiLoading ? '분석 중...' : '다시 분석'}
                    </Button>
                  </div>
                  <p className="mt-2 text-sky-900">
                    {budgetImportAiLoading
                      ? '현재 표 구조를 다시 읽고 있습니다. 이 결과는 자동 반영 규칙을 바꾸지 않고, 어떤 형식으로 정리하면 더 안정적으로 읽히는지 설명합니다.'
                      : budgetImportAiAnalysis?.summary || '현재 표 구조가 애매해 보여 추가 보조 분석을 준비했습니다.'}
                  </p>
                  {budgetImportAiError ? (
                    <p className="mt-2 text-rose-600">{budgetImportAiError}</p>
                  ) : null}
                  {budgetImportAiAnalysis?.headerPreview && budgetImportAiAnalysis.headerPreview.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {budgetImportAiAnalysis.headerPreview.slice(0, 6).map((header) => (
                        <span
                          key={`budget-import-ai-header-${header}`}
                          className="rounded-full border border-sky-200 bg-white/80 px-2 py-0.5 text-[10px] text-sky-700"
                        >
                          {header}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {budgetImportAiAnalysis?.warnings && budgetImportAiAnalysis.warnings.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-amber-700">
                      {budgetImportAiAnalysis.warnings.slice(0, 3).map((warning) => (
                        <li key={`budget-import-ai-warning-${warning}`}>{warning}</li>
                      ))}
                    </ul>
                  ) : null}
                  {budgetImportAiAnalysis?.nextActions && budgetImportAiAnalysis.nextActions.length > 0 ? (
                    <ul className="mt-2 list-disc space-y-1 pl-4 text-sky-800">
                      {budgetImportAiAnalysis.nextActions.slice(0, 3).map((action) => (
                        <li key={`budget-import-ai-next-${action}`}>{action}</li>
                      ))}
                    </ul>
                  ) : null}
                  {budgetImportAiAnalysis?.suggestedMappings && budgetImportAiAnalysis.suggestedMappings.length > 0 ? (
                    <div className="mt-3 rounded-md border border-sky-200 bg-white/80 p-2">
                      <p className="text-[10px] font-medium text-sky-900">읽은 헤더 후보</p>
                      <div className="mt-2 space-y-1">
                        {budgetImportAiAnalysis.suggestedMappings.slice(0, 4).map((mapping) => (
                          <p key={`budget-import-ai-mapping-${mapping.sourceHeader}-${mapping.platformField}`} className="text-[10px] text-sky-800">
                            {mapping.sourceHeader} → {mapping.platformField}
                          </p>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              <div className="min-h-0 flex-1 overflow-auto rounded-md border border-border/60">
                {budgetImportMergePlan.importedRows.length > 0 ? (
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="bg-muted/30">
                        <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>비목</th>
                        <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>세목</th>
                        <th className="px-3 py-2 text-right" style={{ fontWeight: 600 }}>최초 승인 예산</th>
                        <th className="px-3 py-2 text-right" style={{ fontWeight: 600 }}>변경 예산</th>
                        <th className="px-3 py-2 text-left" style={{ fontWeight: 600 }}>특이사항</th>
                      </tr>
                    </thead>
                    <tbody>
                      {budgetImportMergePlan.importedRows.slice(0, 8).map((row, rowIdx) => (
                        <tr key={`${buildBudgetLabelKey(row.budgetCode, row.subCode)}-${rowIdx}`} className="border-t border-border/40">
                          <td className="px-3 py-2">{row.budgetCode}</td>
                          <td className="px-3 py-2">{row.subCode}</td>
                          <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {fmtKRW(row.initialBudget)}
                          </td>
                          <td className="px-3 py-2 text-right" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {row.revisedBudget ? fmtKRW(row.revisedBudget) : '—'}
                          </td>
                          <td className="px-3 py-2 text-muted-foreground">{row.note || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <div className="flex h-full min-h-[160px] items-center justify-center px-4 text-center text-[11px] text-muted-foreground">
                    파일을 올리거나 예산총괄 표를 붙여넣으면 여기에서 반영 전 미리보기를 보여줍니다.
                  </div>
                )}
              </div>

              <div className="flex shrink-0 justify-end gap-2 border-t border-border/60 pt-2">
                <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={closeBudgetImport}>
                  취소
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-[12px]"
                  onClick={applyBudgetImport}
                  disabled={budgetImportApplying || budgetImportMergePlan.importedRows.length === 0}
                >
                  {budgetImportApplying ? '반영 중...' : '미리본 예산 반영'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        <Dialog open={codeBookMode} onOpenChange={(open) => !open && cancelEdit()}>
          <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
            <DialogHeader className="shrink-0">
              <DialogTitle className="text-[14px]">예산 항목 구조 관리</DialogTitle>
            </DialogHeader>
            <div className="min-h-0 flex flex-1 flex-col gap-3 overflow-hidden">
              <div className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2">
                <p className="text-[11px] font-medium text-foreground">현재 예산 표에 쓰이는 비목/세목 구조를 관리합니다.</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  비목·세목·세세목을 직접 추가하거나 수정한 뒤 저장해 주세요.
                </p>
              </div>
              <Tabs value={codeBookEditorTab} onValueChange={(value) => setCodeBookEditorTab(value as 'manual' | 'paste' | 'csv')} className="min-h-0 flex flex-1 flex-col overflow-hidden">
                <TabsList className="grid w-full grid-cols-1">
                  <TabsTrigger value="manual" className="text-[11px]">직접 수정</TabsTrigger>
                </TabsList>

                <TabsContent value="manual" className="mt-3 min-h-0 flex flex-1 flex-col space-y-3 overflow-hidden">
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      {codeBookReplaceMode ? (
                        <p className="text-[10px] text-amber-600">가져온 구조 초안이 반영된 상태입니다. 저장하면 현재 예산 구조가 교체됩니다.</p>
                      ) : null}
                    </div>
                    <Button variant="outline" size="sm" className="h-7 text-[11px] gap-1" onClick={addBudgetCode}>
                      <Plus className="w-3.5 h-3.5" />
                      비목 추가
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 space-y-3 overflow-y-scroll pr-2">
                    {draftTreeCodes.map((entry, idx) => (
                      <div key={`code-${idx}`} className="rounded-md border border-border/60 p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <span className="text-[10px] text-muted-foreground min-w-[24px]">{idx + 1}</span>
                          <input
                            type="text"
                            value={entry.code}
                            placeholder="비목명"
                            className="flex-1 bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                            onChange={(e) => updateBudgetCode(idx, e.target.value)}
                          />
                          <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={() => addSubCode(idx)}>
                            <Plus className="w-3 h-3" />
                            세목 추가
                          </Button>
                          <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={() => removeBudgetCode(idx)}>
                            <Trash2 className="w-3 h-3" />
                            비목 삭제
                          </Button>
                        </div>
                        <div className="space-y-1">
                          {entry.subItems.map((subItem, sidx) => {
                            const showLeafItems = openedLeafEditors.has(`${idx}:${sidx}`)
                              || subItem.leafItems.some((leaf) => normalizeBudgetLabel(leaf.subSubCode))
                              || subItem.leafItems.length > 1;
                            return (
                            <div
                              key={`sub-${idx}-${sidx}`}
                              className={[
                                'rounded-md border border-border/50 px-2 py-2',
                                draggedSubCode?.codeIdx === idx && draggedSubCode.subIdx === sidx ? 'opacity-50' : '',
                                dropTarget?.codeIdx === idx && dropTarget.subIdx === sidx && dropTarget.position === 'before'
                                  ? 'border-t-primary'
                                  : '',
                                dropTarget?.codeIdx === idx && dropTarget.subIdx === sidx && dropTarget.position === 'after'
                                  ? 'border-b-primary'
                                  : '',
                              ].join(' ')}
                              draggable
                              onDragStart={() => handleSubCodeDragStart(idx, sidx)}
                              onDragOver={(event) => handleSubCodeDragOver(event, idx, sidx)}
                              onDrop={() => handleSubCodeDrop(idx, sidx)}
                              onDragEnd={handleSubCodeDragEnd}
                            >
                              <div className="flex items-center gap-2">
                                <button
                                  type="button"
                                  className="flex h-7 w-7 shrink-0 cursor-grab items-center justify-center rounded border border-dashed border-border/80 text-muted-foreground active:cursor-grabbing"
                                  aria-label="세목 순서 드래그"
                                >
                                  <GripVertical className="h-3.5 w-3.5" />
                                </button>
                                <span className="text-[10px] text-muted-foreground min-w-[28px]">{idx + 1}-{sidx + 1}</span>
                                <input
                                  type="text"
                                  value={subItem.subCode}
                                  placeholder="세목명"
                                  className="flex-1 bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                                  onChange={(e) => updateSubCode(idx, sidx, e.target.value)}
                                />
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => reorderSubCode(idx, sidx, 'up')}
                                  disabled={sidx === 0}
                                  aria-label="세목 위로 이동"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </Button>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="h-7 w-7 p-0"
                                  onClick={() => reorderSubCode(idx, sidx, 'down')}
                                  disabled={sidx === entry.subItems.length - 1}
                                  aria-label="세목 아래로 이동"
                                >
                                  <ArrowDown className="w-3 h-3" />
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-[10px] gap-1" onClick={() => addLeafItem(idx, sidx)}>
                                  <Plus className="w-3 h-3" />
                                  세세목
                                </Button>
                                <Button variant="outline" size="sm" className="h-7 text-[10px]" onClick={() => removeSubCode(idx, sidx)}>
                                  <Trash2 className="w-3 h-3" />
                                </Button>
                              </div>
                              {showLeafItems ? (
                              <div className="mt-2 space-y-1">
                                {subItem.leafItems.map((leaf, leafIdx) => (
                                  <div key={`leaf-${idx}-${sidx}-${leafIdx}`} className="flex items-center gap-2 pl-10">
                                    <span className="min-w-[44px] text-[10px] text-muted-foreground">
                                      {idx + 1}-{sidx + 1}-{leafIdx + 1}
                                    </span>
                                    <input
                                      type="text"
                                      value={leaf.subSubCode || ''}
                                      placeholder="세세목명"
                                      className="flex-1 bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                                      onChange={(e) => updateLeafSubSubCode(idx, sidx, leafIdx, e.target.value)}
                                    />
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      className="h-7 text-[10px]"
                                      onClick={() => removeLeafItem(idx, sidx, leafIdx)}
                                    >
                                      <Trash2 className="w-3 h-3" />
                                    </Button>
                                  </div>
                                ))}
                              </div>
                              ) : null}
                            </div>
                            );
                          })}
                          {entry.subItems.length === 0 && (
                            <p className="text-[10px] text-muted-foreground">세목이 없습니다.</p>
                          )}
                        </div>
                      </div>
                    ))}
                    {draftTreeCodes.length === 0 && (
                      <p className="text-[11px] text-muted-foreground">비목을 추가해 주세요.</p>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="paste" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  <div className="rounded-md border border-border/60 p-3 space-y-2">
                    <p className="text-[11px] font-medium">엑셀에서 두 열을 그대로 복사해 붙여넣을 수 있습니다.</p>
                    <p className="text-[10px] text-muted-foreground">
                      첫 번째 열은 비목, 두 번째 열은 세목으로 읽습니다. 헤더가 `비목 / 세목`이면 자동으로 건너뜁니다.
                    </p>
                    <div className="rounded-md bg-slate-950 px-3 py-2 font-mono text-[10px] text-slate-50 whitespace-pre-wrap">
                      비목,세목{'\n'}
                      교육운영비,강사비{'\n'}
                      교육운영비,교재비{'\n'}
                      출장비,교통비
                    </div>
                    <p className="text-[10px] text-muted-foreground">쉼표 CSV와 탭 구분 복붙 둘 다 지원합니다.</p>
                  </div>
                  <Textarea
                    value={codeBookImportText}
                    onChange={(event) => {
                      setCodeBookImportText(event.target.value);
                      setCodeBookImportFileName('');
                    }}
                    placeholder={'비목\t세목\n교육운영비\t강사비\n교육운영비\t교재비'}
                    className="min-h-[220px] text-[11px] font-mono"
                  />
                  <div className="rounded-md border border-border/60 p-3 text-[10px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>비목 {codeBookImportPreview.rows.length}개</span>
                      <span>세목 {codeBookImportPreview.totalPairs}건</span>
                      <span>중복 제외 {codeBookImportPreview.duplicatePairs}건</span>
                      <span>건너뜀 {codeBookImportPreview.skippedRows}건</span>
                    </div>
                    {codeBookImportPreview.samplePairs.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {codeBookImportPreview.samplePairs.map((pair) => (
                          <Badge key={`${pair.code}-${pair.subCode}`} variant="outline" className="text-[10px]">
                            {pair.code} / {pair.subCode}
                          </Badge>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-8 text-[12px]"
                      onClick={applyImportedCodeBook}
                      disabled={codeBookImportPreview.rows.length === 0}
                    >
                      가져온 구조로 교체
                    </Button>
                  </div>
                </TabsContent>

                <TabsContent value="csv" className="mt-3 min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
                  <div className="rounded-md border border-border/60 p-3 space-y-2">
                    <p className="text-[11px] font-medium">CSV 예시는 이 화면 안에서 바로 확인할 수 있습니다.</p>
                    <div className="rounded-md bg-slate-950 px-3 py-2 font-mono text-[10px] text-slate-50 whitespace-pre-wrap">
                      비목,세목{'\n'}
                      교육운영비,강사비{'\n'}
                      교육운영비,교재비{'\n'}
                      출장비,숙박비
                    </div>
                    <p className="text-[10px] text-muted-foreground">엑셀에서 저장한 `.csv` 또는 `.tsv` 파일을 올리면 미리보기 후 현재 구조 초안으로 교체합니다.</p>
                  </div>
                  <div className="rounded-md border border-dashed border-border/70 p-4">
                    <input
                      type="file"
                      accept=".csv,.tsv,text/csv,text/tab-separated-values"
                      className="block w-full text-[11px]"
                      onChange={(event) => {
                        void handleCodeBookImportFile(event.target.files?.[0] || null);
                        event.currentTarget.value = '';
                      }}
                    />
                    <p className="mt-2 text-[10px] text-muted-foreground">
                      {codeBookImportFileName ? `${codeBookImportFileName} 파일을 읽어 미리보기를 준비했습니다.` : '업로드 후 아래 미리보기에서 비목/세목 개수를 확인하세요.'}
                    </p>
                  </div>
                  <div className="rounded-md border border-border/60 p-3 text-[10px] text-muted-foreground">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                      <span>비목 {codeBookImportPreview.rows.length}개</span>
                      <span>세목 {codeBookImportPreview.totalPairs}건</span>
                      <span>중복 제외 {codeBookImportPreview.duplicatePairs}건</span>
                      <span>건너뜀 {codeBookImportPreview.skippedRows}건</span>
                      {codeBookImportPreview.headerDetected ? <span>헤더 자동 인식</span> : null}
                    </div>
                    {codeBookImportPreview.samplePairs.length > 0 ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {codeBookImportPreview.samplePairs.map((pair) => (
                          <Badge key={`${pair.code}-${pair.subCode}`} variant="outline" className="text-[10px]">
                            {pair.code} / {pair.subCode}
                          </Badge>
                        ))}
                      </div>
                    ) : (
                      <p className="mt-2">파일을 올리면 여기에서 예시 행을 바로 확인할 수 있습니다.</p>
                    )}
                  </div>
                  <div className="flex justify-end">
                    <Button
                      size="sm"
                      className="h-8 text-[12px]"
                      onClick={applyImportedCodeBook}
                      disabled={codeBookImportPreview.rows.length === 0}
                    >
                      가져온 구조로 교체
                    </Button>
                  </div>
                </TabsContent>
              </Tabs>
              <div className="flex justify-end gap-2 pt-2 border-t border-border/60">
                <Button variant="outline" size="sm" className="h-8 text-[12px]" onClick={cancelEdit}>
                  취소
                </Button>
                <Button
                  size="sm"
                  className="h-8 text-[12px]"
                  onClick={saveSettings}
                  disabled={settingsSaving || !codeBookValidation.isValid}
                >
                  {settingsSaving ? '저장 중...' : '저장'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>

        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {[
            { label: '총 예산', value: fmtShort(total.effectiveBudget || 0), sub: fmtKRW(total.effectiveBudget || 0) + '원', gradient: 'linear-gradient(135deg, #0891b2, #0f766e)', icon: Calculator },
            { label: '집행액', value: fmtShort(total.spent || 0), sub: fmtKRW(total.spent || 0) + '원', gradient: 'linear-gradient(135deg, #e11d48, #f43f5e)', icon: Wallet },
            { label: '잔액', value: fmtShort(total.balance || 0), sub: fmtKRW(total.balance || 0) + '원', gradient: 'linear-gradient(135deg, #0d9488, #059669)', icon: TrendingUp },
            { label: '소진율', value: fmtPercent(total.burnRate || 0), sub: `${fmtKRW(total.spent || 0)} / ${fmtKRW(total.effectiveBudget || 0)}`, gradient: `linear-gradient(135deg, ${burnColor(total.burnRate || 0)}, ${burnColor(total.burnRate || 0)}88)`, icon: TrendingUp },
          ].map(k => (
            <Card key={k.label} className="overflow-hidden">
              <CardContent className="p-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0" style={{ background: k.gradient }}>
                    <k.icon className="w-4 h-4 text-white" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-[10px] text-muted-foreground">{k.label}</p>
                    <p className="text-[16px] truncate" style={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{k.value}</p>
                  </div>
                </div>
                <p className="text-[9px] text-muted-foreground mt-1.5 truncate" style={{ fontVariantNumeric: 'tabular-nums' }}>{k.sub}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Meta Bar */}
        <Card>
          <CardContent className="p-2.5">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
              <span className="text-muted-foreground">정산: <strong className="text-foreground">{meta.basis}</strong></span>
              <span className="text-muted-foreground">펀더: <strong className="text-foreground">{meta.funder}</strong></span>
              <span className="text-muted-foreground">업데이트: <strong className="text-foreground">{meta.lastUpdated}</strong></span>
              <div className="flex items-center gap-2 ml-auto">
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] bg-blue-50 text-blue-600 dark:bg-blue-900/30 dark:text-blue-300 border border-blue-200/50 dark:border-blue-800/40">
                  <Lock className="w-2 h-2" /> 고정
                </span>
                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded text-[8px] bg-rose-50 text-rose-600 dark:bg-rose-900/30 dark:text-rose-300 border border-rose-200/50 dark:border-rose-800/40">
                  <SlidersHorizontal className="w-2 h-2" /> 조정가능
                </span>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* 보조 테이블 */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-[12px]">예산 구성</CardTitle></CardHeader>
          <CardContent className="p-0">
            <div className="divide-y divide-border/50">
              {auxRows.map((r, i) => (
                <div key={i} className="flex items-center justify-between px-4 py-2.5 text-[11px]">
                  <span>{r.label}</span>
                  <div className="flex items-center gap-4" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <span style={{ fontWeight: 500 }}>{fmtKRW(r.amount)}원</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* 예산 총계 */}
        <Card>
          <CardContent className="p-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
              <span className="text-muted-foreground">총계</span>
              <span>예산 <strong>{fmtKRW(total.effectiveBudget || 0)}</strong></span>
              <span>집행 <strong style={{ color: '#e11d48' }}>{fmtKRW(total.spent || 0)}</strong></span>
              <span>잔액 <strong style={{ color: '#059669' }}>{fmtKRW(total.balance || 0)}</strong></span>
            </div>
          </CardContent>
        </Card>

        {/* ── 그룹별 카드 뷰 (테이블 대체) ── */}
        <div className="space-y-3">
          {budgetCodeViews.map((group) => {
            const gid = group.key;
            const isCollapsed = collapsedGroups.has(gid);
            return (
              <Card key={gid} className="overflow-hidden">
                {/* 그룹 헤더 */}
                <button
                  className="w-full flex items-center gap-2 px-4 py-3 border-b border-border/50 hover:bg-muted/20 transition-colors text-left"
                  onClick={() => toggleGroup(gid)}
                >
                  {isCollapsed ? <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />}
                  <span className="text-[12px] flex-1" style={{ fontWeight: 600 }}>
                    {group.budgetCode || '기타'}
                  </span>
                  <div className="flex items-center gap-3 text-[10px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                    <span className="text-muted-foreground">예산 <strong className="text-foreground">{fmtShort(group.effectiveBudget)}</strong></span>
                    <span className="text-muted-foreground">집행 <strong style={{ color: group.spent > 0 ? '#e11d48' : undefined }}>{fmtShort(group.spent)}</strong></span>
                  </div>
                </button>

                {/* 항목 테이블 */}
                {!isCollapsed && group.subItems.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="bg-muted/30">
                          <th className="px-4 py-2 text-left" style={{ fontWeight: 600, minWidth: 140 }}>세목 / 세세목</th>
                          <th className="px-3 py-2 text-right" style={{ fontWeight: 600, minWidth: 90 }}>최초 예산</th>
                          <th className="px-3 py-2 text-right" style={{ fontWeight: 600, minWidth: 90 }}>최종 수정예산</th>
                          <th className="px-3 py-2 text-right" style={{ fontWeight: 600, minWidth: 90 }}>소진금액</th>
                          <th className="px-3 py-2 text-right" style={{ fontWeight: 600, minWidth: 90 }}>잔액</th>
                          <th className="px-4 py-2 text-left hidden lg:table-cell" style={{ fontWeight: 600, minWidth: 120 }}>특이사항</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.subItems.map((subItem) => {
                          const subCollapsed = collapsedSubItems.has(subItem.key);
                          if (subItem.isSplit) {
                            const rowKey = subItem.key;
                            const draft = editMode
                              ? draftRows.find((row) => row.rowType === 'subItem' && getSubItemRowKey(row) === rowKey)
                              : null;
                            const hasRevised = subItem.revisedBudget > 0;
                            const delta = hasRevised ? subItem.revisedBudget - subItem.initialBudget : 0;
                            const warningMessages = [
                              subItem.hasInitialBudgetMismatch
                                ? `세세목 최초예산 합계 ${fmtKRW(subItem.leafInitialBudgetTotal)}원이 세목 최초예산 ${fmtKRW(subItem.targetInitialBudget)}원과 다릅니다.`
                                : '',
                              subItem.hasRevisedBudgetMismatch
                                ? `세세목 최종 수정예산 합계 ${fmtKRW(subItem.leafRevisedBudgetTotal)}원이 세목 최종 수정예산 ${fmtKRW(subItem.targetRevisedBudget)}원과 다릅니다.`
                                : '',
                            ].filter(Boolean);
                            return (
                              <Fragment key={subItem.key}>
                                <tr className="border-t border-border/30 bg-background/70">
                                    <td className="px-4 py-2.5">
                                      <button
                                        type="button"
                                        className="flex w-full items-center gap-2 text-left"
                                        onClick={() => toggleSubItem(subItem.key)}
                                      >
                                        {subCollapsed ? <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                                        <div className="min-w-0">
                                          <p className="truncate text-[10px]" style={{ fontWeight: 600 }}>{subItem.subCode}</p>
                                        </div>
                                      </button>
                                    </td>
                                    <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                      {editMode ? (
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          value={draft?.initialBudget || ''}
                                          className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                          onChange={(e) => updateDraftSubItemField(rowKey, 'initialBudget', formatInputLive(e.target.value))}
                                        />
                                      ) : (
                                        <div>{fmtKRW(subItem.initialBudget)}</div>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                      {editMode ? (
                                        <input
                                          type="text"
                                          inputMode="numeric"
                                          value={draft?.revisedBudget || ''}
                                          className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                          onChange={(e) => updateDraftSubItemField(rowKey, 'revisedBudget', formatInputLive(e.target.value))}
                                        />
                                      ) : (
                                        <div className="flex flex-col items-end leading-tight">
                                          <div>{fmtKRW(subItem.effectiveBudget)}</div>
                                          {hasRevised && delta !== 0 ? (
                                            <div className={`text-[9px] mt-0.5 inline-flex items-center gap-1 ${delta > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                              {delta > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                                              {delta > 0 ? '증액' : '감액'} {fmtKRW(Math.abs(delta))}
                                            </div>
                                          ) : null}
                                        </div>
                                      )}
                                    </td>
                                    <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: subItem.spent > 0 ? '#e11d48' : undefined }}>
                                      {fmtKRW(subItem.spent)}
                                    </td>
                                    <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: '#059669' }}>
                                      {fmtKRW(subItem.balance)}
                                    </td>
                                    <td className={`px-4 py-2.5 max-w-[180px] ${editMode ? '' : 'hidden lg:table-cell'}`}>
                                      {editMode ? (
                                        <input
                                          type="text"
                                          value={draft?.note || ''}
                                          className="w-full bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                                          placeholder="특이사항"
                                          onChange={(e) => updateDraftSubItemField(rowKey, 'note', e.target.value)}
                                        />
                                      ) : subItem.note ? (
                                        <Tooltip>
                                          <TooltipTrigger>
                                            <span className="text-muted-foreground truncate block text-[10px]">{subItem.note.slice(0, 40)}{subItem.note.length > 40 ? '...' : ''}</span>
                                          </TooltipTrigger>
                                          <TooltipContent className="text-[10px] max-w-[280px]">{subItem.note}</TooltipContent>
                                        </Tooltip>
                                      ) : (
                                        <span className="text-muted-foreground/30">—</span>
                                      )}
                                    </td>
                                  </tr>
                                {!subCollapsed && warningMessages.length > 0 ? (
                                  <tr className="border-t border-border/20 bg-rose-50/60">
                                    <td colSpan={6} className="px-4 py-2 text-[10px] text-rose-600">
                                      {warningMessages.join(' ')}
                                    </td>
                                  </tr>
                                ) : null}
                                {!subCollapsed && subItem.leafItems.map((leaf) => {
                                  const hasRevised = leaf.revisedBudget > 0;
                                  const delta = hasRevised ? leaf.revisedBudget - leaf.initialBudget : 0;
                                  const rowKey = leaf.key;
                                  const draft = editMode
                                    ? draftRows.find((row) => getLeafRowKey(row) === rowKey)
                                    : null;
                                  return (
                                    <tr
                                      key={rowKey}
                                      className={`border-t border-border/30 transition-colors ${editMode ? '' : 'hover:bg-muted/20 cursor-pointer'}`}
                                      onClick={() => {
                                        if (!editMode) setSelectedRow(leaf);
                                      }}
                                    >
                                      <td className="px-4 py-2.5">
                                        <div className="min-w-0 pl-5">
                                          <p className="truncate" style={{ fontWeight: 500 }}>{leaf.subSubCode || '세세목 미입력'}</p>
                                        </div>
                                      </td>
                                      <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {editMode ? (
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            value={draft?.initialBudget || ''}
                                            className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                            onChange={(e) => updateDraftLeafField(rowKey, 'initialBudget', formatInputLive(e.target.value))}
                                          />
                                        ) : (
                                          <div>{fmtKRW(leaf.initialBudget)}</div>
                                        )}
                                      </td>
                                      <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                        {editMode ? (
                                          <input
                                            type="text"
                                            inputMode="numeric"
                                            value={draft?.revisedBudget || ''}
                                            className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                            onChange={(e) => updateDraftLeafField(rowKey, 'revisedBudget', formatInputLive(e.target.value))}
                                          />
                                        ) : (
                                          <div className="flex flex-col items-end leading-tight">
                                            <div>{fmtKRW(leaf.effectiveBudget)}</div>
                                            {hasRevised && delta !== 0 ? (
                                              <div className={`text-[9px] mt-0.5 inline-flex items-center gap-1 ${delta > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                                {delta > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                                                {delta > 0 ? '증액' : '감액'} {fmtKRW(Math.abs(delta))}
                                              </div>
                                            ) : null}
                                          </div>
                                        )}
                                      </td>
                                      <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: leaf.spent > 0 ? '#e11d48' : undefined }}>
                                        {fmtKRW(leaf.spent)}
                                      </td>
                                      <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: '#059669' }}>
                                        {fmtKRW(leaf.balance)}
                                      </td>
                                      <td className={`px-4 py-2.5 max-w-[180px] ${editMode ? '' : 'hidden lg:table-cell'}`}>
                                        {editMode ? (
                                          <input
                                            type="text"
                                            value={draft?.note || ''}
                                            className="w-full bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                                            placeholder="특이사항"
                                            onChange={(e) => updateDraftLeafField(rowKey, 'note', e.target.value)}
                                          />
                                        ) : leaf.note ? (
                                          <Tooltip>
                                            <TooltipTrigger>
                                              <span className="text-muted-foreground truncate block text-[10px]">{leaf.note.slice(0, 40)}{leaf.note.length > 40 ? '...' : ''}</span>
                                            </TooltipTrigger>
                                            <TooltipContent className="text-[10px] max-w-[280px]">{leaf.note}</TooltipContent>
                                          </Tooltip>
                                        ) : (
                                          <span className="text-muted-foreground/30">—</span>
                                        )}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </Fragment>
                            );
                          }

                          const leaf = subItem.leafItems[0];
                          const rowKey = leaf.key;
                          const hasRevised = leaf.revisedBudget > 0;
                          const delta = hasRevised ? leaf.revisedBudget - leaf.initialBudget : 0;
                          const draft = editMode
                            ? draftRows.find((row) => getLeafRowKey(row) === rowKey)
                            : null;
                          return (
                            <tr
                              key={rowKey}
                              className={`border-t border-border/30 transition-colors ${editMode ? '' : 'hover:bg-muted/20 cursor-pointer'}`}
                              onClick={() => {
                                if (!editMode) setSelectedRow(leaf);
                              }}
                            >
                              <td className="px-4 py-2.5">
                                <div className="min-w-0">
                                  <p className="truncate text-[10px]" style={{ fontWeight: 500 }}>{subItem.subCode}</p>
                                </div>
                              </td>
                              <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                {editMode ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={draft?.initialBudget || ''}
                                    className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                    onChange={(e) => updateDraftLeafField(rowKey, 'initialBudget', formatInputLive(e.target.value))}
                                  />
                                ) : (
                                  <div>{fmtKRW(leaf.initialBudget)}</div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right align-top" style={{ fontVariantNumeric: 'tabular-nums' }}>
                                {editMode ? (
                                  <input
                                    type="text"
                                    inputMode="numeric"
                                    value={draft?.revisedBudget || ''}
                                    className="w-full bg-transparent outline-none text-[11px] text-right px-1 py-0.5 border rounded"
                                    onChange={(e) => updateDraftLeafField(rowKey, 'revisedBudget', formatInputLive(e.target.value))}
                                  />
                                ) : (
                                  <div className="flex flex-col items-end leading-tight">
                                    <div>{fmtKRW(leaf.effectiveBudget)}</div>
                                    {hasRevised && delta !== 0 ? (
                                      <div className={`text-[9px] mt-0.5 inline-flex items-center gap-1 ${delta > 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                                        {delta > 0 ? <ArrowUp className="w-3 h-3" /> : <ArrowDown className="w-3 h-3" />}
                                        {delta > 0 ? '증액' : '감액'} {fmtKRW(Math.abs(delta))}
                                      </div>
                                    ) : null}
                                  </div>
                                )}
                              </td>
                              <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: leaf.spent > 0 ? '#e11d48' : undefined }}>
                                {fmtKRW(leaf.spent)}
                              </td>
                              <td className="px-3 py-2.5 text-right" style={{ fontVariantNumeric: 'tabular-nums', color: '#059669' }}>
                                {fmtKRW(leaf.balance)}
                              </td>
                              <td className={`px-4 py-2.5 max-w-[180px] ${editMode ? '' : 'hidden lg:table-cell'}`}>
                                {editMode ? (
                                  <input
                                    type="text"
                                    value={draft?.note || ''}
                                    className="w-full bg-transparent outline-none text-[11px] px-2 py-1 border rounded"
                                    placeholder="특이사항"
                                    onChange={(e) => updateDraftLeafField(rowKey, 'note', e.target.value)}
                                  />
                                ) : leaf.note ? (
                                  <Tooltip>
                                    <TooltipTrigger>
                                      <span className="text-muted-foreground truncate block text-[10px]">{leaf.note.slice(0, 40)}{leaf.note.length > 40 ? '...' : ''}</span>
                                    </TooltipTrigger>
                                    <TooltipContent className="text-[10px] max-w-[280px]">{leaf.note}</TooltipContent>
                                  </Tooltip>
                                ) : (
                                  <span className="text-muted-foreground/30">—</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* 소계 풋터 */}
                <div className="px-4 py-2.5 bg-muted/20 border-t border-border/50 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]" style={{ fontVariantNumeric: 'tabular-nums' }}>
                  <span className="text-muted-foreground">소계</span>
                  <span>예산 <strong>{fmtKRW(group.effectiveBudget)}</strong></span>
                  <span>집행 <strong style={{ color: group.spent > 0 ? '#e11d48' : undefined }}>{fmtKRW(group.spent)}</strong></span>
                  <span className="ml-auto" style={{ fontWeight: 600, color: '#059669' }}>잔액 {fmtKRW(group.balance)}</span>
                </div>
              </Card>
            );
          })}

        </div>

        {/* 행 상세 모달 */}
        <Dialog open={!!selectedRow} onOpenChange={open => !open && setSelectedRow(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader><DialogTitle className="text-[14px]">항목 상세</DialogTitle></DialogHeader>
            {selectedRow && (
              <div className="space-y-3">
                <div className="flex items-center gap-2 mb-2">
                  <Badge className="text-[9px] h-4 px-1.5 bg-slate-100 text-slate-600">
                    {selectedRow.subSubCode ? '세세목' : '세목'}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">{selectedRow.budgetCode}</span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  {[
                    ['비목', selectedRow.budgetCode || '—'],
                    ['세목', selectedRow.subCode || '—'],
                    ['세세목', selectedRow.subSubCode || '—'],
                    ['최초 예산', fmtKRW(selectedRow.initialBudget) + '원'],
                    ['최종 수정예산', selectedRow.revisedBudget > 0 ? fmtKRW(selectedRow.revisedBudget) + '원' : '—'],
                    ['소진금액', fmtKRW(selectedRow.spent) + '원'],
                    ['잔액', fmtKRW(selectedRow.balance) + '원'],
                  ].map(([l, v]) => (
                    <div key={l as string}>
                      <p className="text-[9px] text-muted-foreground mb-0.5">{l}</p>
                      <p style={{ fontWeight: 500, fontVariantNumeric: 'tabular-nums' }}>{v || '—'}</p>
                    </div>
                  ))}
                </div>

                {selectedRow.note && (
                  <div className="p-2.5 rounded-lg bg-amber-50 dark:bg-amber-950/30 border border-amber-200/60 dark:border-amber-800/40">
                    <p className="text-[10px] text-amber-700 dark:text-amber-300" style={{ fontWeight: 600 }}>
                      <Info className="w-3 h-3 inline mr-0.5" /> 특이사항
                    </p>
                    <p className="text-[11px] mt-1 break-words">{selectedRow.note}</p>
                  </div>
                )}

              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
