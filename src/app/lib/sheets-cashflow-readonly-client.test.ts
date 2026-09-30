import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  applyCashflowSheetLabViaBff,
  extractSpreadsheetIdFromSheetInput,
  getCashflowSheetLabMirrorViaBff,
  getCashflowSheetLabShareAccountViaBff,
  isCashflowSheetApplyResultUncertain,
  refreshCashflowSheetLabMirrorViaBff,
  saveCashflowSheetLabConfigViaBff,
  stageCashflowSheetLabViaBff,
} from './sheets-cashflow-readonly-client';

const lease = { sessionId: 'session-a', leaseId: 'lease-a', fence: 7 };
const clientSource = readFileSync(resolve(import.meta.dirname, 'sheets-cashflow-readonly-client.ts'), 'utf8');

function asMockClient(client: {
  post?: ReturnType<typeof vi.fn>;
  get?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
}) {
  return {
    get: client.get || vi.fn(),
    post: client.post || vi.fn(),
    patch: client.patch || vi.fn(),
    request: client.request || vi.fn(),
  };
}

describe('sheets cashflow readonly client', () => {
  it('treats only transport-uncertain apply failures as resumable', () => {
    expect(isCashflowSheetApplyResultUncertain({
      status: 503,
      body: { code: 'unsafe_bff_runtime' },
    })).toBe(false);
    expect(isCashflowSheetApplyResultUncertain({
      status: 503,
      body: { code: 'jvm_weekly_api_unconfigured' },
    })).toBe(false);
    expect(isCashflowSheetApplyResultUncertain({
      status: 503,
      body: { code: 'cashflow_sheet_operation_uncertain' },
    })).toBe(true);
    expect(isCashflowSheetApplyResultUncertain(new TypeError('Failed to fetch'))).toBe(true);
  });

  it('has no retired direct preview or sheet writeback client path', () => {
    expect(clientSource).not.toContain('previewCashflowSheetLabViaBff');
    expect(clientSource).not.toContain('/cashflow-sheet-lab/preview');
    expect(clientSource).not.toContain('writeback');
  });
  it('extracts spreadsheet ids for immediate input feedback', () => {
    expect(extractSpreadsheetIdFromSheetInput('https://docs.google.com/spreadsheets/d/sheet_12345678901234567890/edit#gid=1')).toBe('sheet_12345678901234567890');
    expect(extractSpreadsheetIdFromSheetInput('https://drive.google.com/open?id=sheet-12345678901234567890')).toBe('sheet-12345678901234567890');
    expect(extractSpreadsheetIdFromSheetInput('sheet_12345678901234567890')).toBe('sheet_12345678901234567890');
    expect(extractSpreadsheetIdFromSheetInput('not a sheet')).toBe('');
  });

  it('saves sheet lab config through same-origin BFF', async () => {
    const client = asMockClient({
      request: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          configured: true,
          config: {
            value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
            sheetName: 'cashflow(사용내역 연동)',
            spreadsheetId: 'sheet-001',
            startWeek: '26-1-1',
            endWeek: '26-12-5',
          },
          systemAccountEmail: 'cashflow-service@mysc.iam.gserviceaccount.com',
        },
      })),
    });

    await saveCashflowSheetLabConfigViaBff({
      tenantId: 'mysc',
      actor: {
        uid: 'user-1',
        role: 'workspace_user',
        email: 'user@mysc.co.kr',
        idToken: 'firebase-token',
      },
      projectId: 'p001',
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
      sheetName: 'cashflow(사용내역 연동)',
      startWeek: '26-1-1',
      endWeek: '26-12-5',
      client,
    });

    expect(client.request).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/config',
      expect.objectContaining({
        method: 'PUT',
        tenantId: 'mysc',
        body: {
          value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-12-5',
        },
      }),
    );
    expect(client.request.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it('final-applies explicitly provided sheet values and atomically finalizes the lease', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          spreadsheetId: 'sheet-001',
          spreadsheetTitle: 'cashflow',
          selectedSheetName: 'cashflow(사용내역 연동)',
          appliedLineCount: 24,
          projectionLineCount: 12,
          actualLineCount: 12,
          firebaseResult: {
            ok: true,
            commandName: 'cashflowSheetLab.apply.firebase',
            projectId: 'p001',
            sourceSheetKey: 'cashflow-sheet-lab',
            savedProjectionLineCount: 12,
            savedActualLineCount: 12,
            updatedWeeks: [],
          },
        },
      })),
    });

    await applyCashflowSheetLabViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
      sheetName: 'cashflow(사용내역 연동)',
      startWeek: '26-1-1',
      endWeek: '26-6-5',
      idempotencyKey: 'apply-001',
      replaceAllActualSources: true,
      lease,
      finalize: true,
      client,
    });

    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/apply',
      expect.objectContaining({
        tenantId: 'mysc',
        body: {
          value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-6-5',
          replaceAllActualSources: true,
          idempotencyKey: 'apply-001',
        },
        idempotencyKey: 'apply-001',
        timeoutMs: 300000,
        headers: {
          'x-edit-session-id': 'session-a',
          'x-edit-lease-id': 'lease-a',
          'x-edit-fence': '7',
          'x-edit-finalize': 'true',
        },
      }),
    );
  });

  it('lets the sheet-lab BFF supply its short-lived apply lease when the caller has none', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: { projectId: 'p001', appliedLineCount: 1 } })),
    });

    await applyCashflowSheetLabViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      stageRunId: 'stage-001',
      settledWeekChangeConfirmationId: 'confirmation-001',
      acceptFormulaMismatches: true,
      acceptPendingApprovalDifferences: true,
      pendingApprovalDifferenceCount: 160,
      pendingApprovalDifferenceManifestHash: `sha256:${'a'.repeat(64)}`,
      idempotencyKey: 'apply-without-ui-lease',
      client,
    });

    expect(client.post.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(client.post.mock.calls[0]?.[1]?.body).toEqual({
      stageRunId: 'stage-001',
      settledWeekChangeConfirmationId: 'confirmation-001',
      acceptFormulaMismatches: true,
      acceptPendingApprovalDifferences: true,
      pendingApprovalDifferenceCount: 160,
      pendingApprovalDifferenceManifestHash: `sha256:${'a'.repeat(64)}`,
      idempotencyKey: 'apply-without-ui-lease',
    });
  });

  it('reads only the pinned mirror without contacting Google Sheets', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          status: 'FRESH',
          sourceRevision: 'sha256:source-001',
          targetRevisionAtFetch: 'sha256:target-001',
          capturedAt: '2026-07-13T01:00:00.000Z',
          summary: { cellCount: 1920, valueCount: 20, emptyCount: 1900, invalidCount: 0 },
          cells: [],
        },
      })),
    });

    const result = await getCashflowSheetLabMirrorViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      client,
    });

    expect(result.status).toBe('FRESH');
    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/mirror',
      expect.objectContaining({ tenantId: 'mysc' }),
    );
    expect(client.post).not.toHaveBeenCalled();
  });

  it('does not expose the retired full sheet change-count check', () => {
    expect(clientSource).not.toContain('checkCashflowSheetChangesViaBff');
    expect(clientSource).not.toContain('/cashflow-sheet-lab/changes/check');
  });

  it('refreshes the mirror only on an explicit request and retains a stale last-good snapshot', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          status: 'STALE',
          sourceRevision: 'sha256:last-good',
          targetRevisionAtFetch: 'sha256:target-001',
          lastRefreshIdempotencyKey: 'refresh-001',
          capturedAt: '2026-07-13T01:00:00.000Z',
          summary: { cellCount: 1, valueCount: 1, emptyCount: 0, invalidCount: 0 },
          cells: [{
            mode: 'projection', yearMonth: '2026-01', weekNo: 1, lineId: 'SALES_IN',
            direction: 'IN', sourceCell: 'D14', sourceLabel: '매출액(입금)', state: 'VALUE', amount: 1000,
          }],
          annualCells: [],
          lastRefreshError: { code: 'sheet_unavailable', message: '시트를 읽지 못했습니다.', at: '2026-07-13T02:00:00.000Z' },
        },
      })),
    });

    const result = await refreshCashflowSheetLabMirrorViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
      sheetName: 'cashflow(사용내역 연동)',
      startWeek: '26-1-1',
      endWeek: '26-6-5',
      idempotencyKey: 'refresh-001',
      client,
    });

    expect(result).toMatchObject({
      status: 'STALE',
      sourceRevision: 'sha256:last-good',
      capturedAt: '2026-07-13T01:00:00.000Z',
      cells: [expect.objectContaining({ amount: 1000 })],
    });
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/mirror/refresh',
      expect.objectContaining({
        tenantId: 'mysc',
        body: {
          value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
          sheetName: 'cashflow(사용내역 연동)',
          startWeek: '26-1-1',
          endWeek: '26-6-5',
          idempotencyKey: 'refresh-001',
        },
        idempotencyKey: 'refresh-001',
      }),
    );
  });

  it('does not issue a recovery read when refresh returns an unusable response', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({ data: null })),
      get: vi.fn(),
    });

    await expect(refreshCashflowSheetLabMirrorViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      value: 'https://docs.google.com/spreadsheets/d/sheet-001/edit',
      idempotencyKey: 'refresh-invalid-001',
      client,
    })).rejects.toMatchObject({ code: 'cashflow_sheet_refresh_response_invalid' });
    expect(client.get).not.toHaveBeenCalled();
  });

  it('stages the explicitly selected pinned revision through the review endpoint', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          commandName: 'cashflowSheetLab.stage.firebase',
          projectId: 'p001',
          runId: 'stage-run-1',
          stagedLineCount: 4,
          projectionLineCount: 2,
          actualLineCount: 2,
          riskLineCount: 1,
          candidates: [],
        },
      })),
    });

    const result = await stageCashflowSheetLabViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      expectedMirrorRevision: 'sha256:source-001',
      idempotencyKey: 'stage-001',
      yearMonth: '2026-07',
      replaceAllActualSources: true,
      client,
    });

    expect(result.stagedLineCount).toBe(4);
    expect(client.post).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/stage',
      expect.objectContaining({
        tenantId: 'mysc',
        body: {
          expectedMirrorRevision: 'sha256:source-001',
          idempotencyKey: 'stage-001',
          yearMonth: '2026-07',
          replaceAllActualSources: true,
        },
        idempotencyKey: 'stage-001',
      }),
    );
    expect(client.post.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it('preserves a durable no-op stage acknowledgement', async () => {
    const client = asMockClient({
      post: vi.fn(async () => ({
        data: {
          ok: true,
          commandName: 'cashflowSheetLab.stage.firebase',
          projectId: 'p001',
          runId: 'stage-run-noop',
          status: 'NO_CHANGES',
          stagedLineCount: 0,
          projectionLineCount: 0,
          actualLineCount: 0,
          riskLineCount: 0,
        },
      })),
    });

    const result = await stageCashflowSheetLabViaBff({
      tenantId: 'mysc',
      actor: { uid: 'user-1', role: 'workspace_user', email: 'user@mysc.co.kr' },
      projectId: 'p001',
      expectedMirrorRevision: 'sha256:source-001',
      idempotencyKey: 'stage-noop-001',
      client,
    });

    expect(clientSource).toContain("status?: 'READY' | 'BLOCKED' | 'NO_CHANGES'");
    expect(result.status).toBe('NO_CHANGES');
  });

  it('loads the service account share target manually through same-origin BFF', async () => {
    const client = asMockClient({
      get: vi.fn(async () => ({
        data: {
          projectId: 'p001',
          configured: false,
          config: null,
          systemAccountEmail: 'cashflow-service@mysc.iam.gserviceaccount.com',
          accessPolicy: {
            googleAuth: 'service_account',
            serviceAccountEmail: 'cashflow-service@mysc.iam.gserviceaccount.com',
            sheetPermission: 'shared_with_mysc_system_account',
          },
        },
      })),
    });

    const result = await getCashflowSheetLabShareAccountViaBff({
      tenantId: 'mysc',
      actor: {
        uid: 'user-1',
        role: 'workspace_user',
        email: 'user@mysc.co.kr',
        idToken: 'firebase-token',
      },
      projectId: 'p001',
      client,
    });

    expect(result.systemAccountEmail).toBe('cashflow-service@mysc.iam.gserviceaccount.com');
    expect(client.get).toHaveBeenCalledWith(
      '/api/v1/projects/p001/cashflow-sheet-lab/config',
      expect.objectContaining({
        tenantId: 'mysc',
        actor: expect.objectContaining({
          id: 'user-1',
          email: 'user@mysc.co.kr',
          role: 'workspace_user',
          idToken: 'firebase-token',
        }),
      }),
    );
    expect(client.get.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

});

describe('describeCashflowSheetExclusions', () => {
  it('keeps the server reason, the cells and the following months in one readable list', async () => {
    const { describeCashflowSheetExclusions } = await import('./sheets-cashflow-readonly-client');
    expect(describeCashflowSheetExclusions({
      excludedMonths: [
        { yearMonth: '2026-05', reason: 'INVALID_CELLS', message: '2026-05에 숫자로 읽을 수 없는 칸이 있습니다.', cells: [{ sourceCell: 'Y15', rawValue: '확인 필요' }], cellCount: 1 },
        { yearMonth: '2026-06', reason: 'AFTER_BLOCKED_MONTH', message: 'x' },
        { yearMonth: '2026-12', reason: 'AFTER_BLOCKED_MONTH', message: 'x' },
      ],
      excludedYears: [{ year: 2028, reason: 'AFTER_BLOCKED_MONTH', message: '2026-05 이후 잔액을 이어받는 연도라 이번 반영에서 뺐습니다.' }],
    })).toEqual([
      "2026-05에 숫자로 읽을 수 없는 칸이 있습니다. 확인할 칸: Y15('확인 필요')",
      '2026-06~2026-12은 앞 달 잔액을 이어받을 수 없어 이번 반영에서 뺐습니다.',
      '2026-05 이후 잔액을 이어받는 연도라 이번 반영에서 뺐습니다.',
    ]);
  });

  it('says nothing when nothing was excluded', async () => {
    const { describeCashflowSheetExclusions } = await import('./sheets-cashflow-readonly-client');
    expect(describeCashflowSheetExclusions({})).toEqual([]);
  });
});

describe('describeCashflowSheetFormulaMismatches', () => {
  it('names the week, the cell, the sheet value and the engine value', async () => {
    const { describeCashflowSheetFormulaMismatches } = await import('./sheets-cashflow-readonly-client');
    expect(describeCashflowSheetFormulaMismatches([{
      yearMonth: '2026-01', mode: 'projection', weekNo: 1, field: 'depositTotal', reported: 6_800_000, calculated: 6_700_000, sourceCell: 'E22',
    }])).toEqual(['2026-01 1주차 Projection 입금 합계(E22): 시트 6,800,000원 · 항목 합으로 계산 6,700,000원']);
  });
});
