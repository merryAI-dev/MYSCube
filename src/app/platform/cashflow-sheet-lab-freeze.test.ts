import { describe, expect, it } from 'vitest';

// @ts-expect-error The guard is intentionally plain Node ESM and exercised here by Vitest.
import * as freeze from '../../../scripts/check_cashflow_sheet_lab_freeze.mjs';

const { CASHFLOW_SHEET_LAB_FREEZE_MARKER, evaluateCashflowSheetLabFreeze } = freeze;

const headSha = 'head-123';
const protectedFile = 'server/bff/routes/cashflow-sheet-lab.mjs';

describe('cashflow sheet-lab one-way freeze', () => {
  it('allows unrelated changes without approval', () => {
    expect(evaluateCashflowSheetLabFreeze({ changedFiles: ['README.md'], reviews: [], headSha }).ok).toBe(true);
  });

  it('blocks a protected change without a current-head approval', () => {
    expect(evaluateCashflowSheetLabFreeze({ changedFiles: [protectedFile], reviews: [], headSha }).ok).toBe(false);
    expect(evaluateCashflowSheetLabFreeze({
      changedFiles: [protectedFile],
      headSha,
      reviews: [{
        user: { login: 'merryAI-dev' }, state: 'APPROVED', commit_id: 'older-head',
        body: CASHFLOW_SHEET_LAB_FREEZE_MARKER, submitted_at: '2026-08-10T00:00:00Z',
      }],
    }).ok).toBe(false);
  });

  it('allows a protected change only after the owner approves the current head', () => {
    expect(evaluateCashflowSheetLabFreeze({
      changedFiles: [protectedFile],
      headSha,
      reviews: [{
        user: { login: 'merryAI-dev' }, state: 'APPROVED', commit_id: headSha,
        body: CASHFLOW_SHEET_LAB_FREEZE_MARKER, submitted_at: '2026-08-10T00:00:00Z',
      }],
    }).ok).toBe(true);
  });
});
