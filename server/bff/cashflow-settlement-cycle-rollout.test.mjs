import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  assertProtectedSettlementStatusesUnchanged,
  assertSettlementCycleInventoryStable,
  isOnboardingReleaseInventoryException,
  assertSettlementCycleCutoverReady,
  buildSettlementCycleHeadMigrationBody,
  buildSettlementCycleRequestNormalizationBody,
  buildSettlementCycleRolloutInventory,
  createSettlementCycleJvmOperations,
  executeSettlementCycleHeadMigrations,
  executeSettlementCycleRequestNormalizations,
  parseSettlementCycleRolloutArgs,
  readSettlementCycleRolloutInventory,
  settlementCycleRolloutAuditSummary,
  settlementCycleRolloutFingerprint,
  validateSettlementCycleRolloutOptions,
  verifySettlementCycleProjections,
} from './cashflow-settlement-cycle-rollout.mjs';

const rootHash = `sha256:${'a'.repeat(64)}`;
const execFileAsync = promisify(execFile);
const settlementCycleCommands = [
  'SUBMIT_MONTH_CLOSE', 'WITHDRAW_MONTH_CLOSE', 'APPROVE_MONTH_CLOSE', 'REJECT_MONTH_CLOSE',
  'REQUEST_MONTH_REOPEN', 'APPROVE_MONTH_REOPEN', 'REJECT_MONTH_REOPEN', 'CANCEL_ACTIVE_CYCLE',
];

function lockedCapabilities() {
  return {
    ...Object.fromEntries(settlementCycleCommands.map((command) => [command, {
      allowed: false, reasonCode: 'BUSINESS_STATE_NOT_ELIGIBLE',
    }])),
    REQUEST_MONTH_REOPEN: { allowed: true, reasonCode: '' },
  };
}

function lockedMonthCloseSettlement() {
  return {
    period: 'MONTH', status: 'LOCKED', revision: 2,
    submittedAt: '2026-09-03T01:00:00Z', submittedBy: 'pm-1',
    approvedAt: '2026-09-03T02:00:00Z', approvedBy: 'head-1',
    deadlineAt: '2026-09-10T15:00:00Z', approverDeadlineAt: '2026-09-30T15:00:00Z',
  };
}

function lockedSettlementStatuses() {
  return {
    projectId: 'project-a',
    yearMonth: '2026-09',
    items: [
      lockedMonthCloseSettlement(),
      ...Array.from({ length: 5 }, (_, index) => ({
        period: `WEEK_${index + 1}`, status: 'WAITING_FOR_UPDATE', revision: 0,
        submittedAt: '', submittedBy: '', approvedAt: '', approvedBy: '',
        deadlineAt: '2026-09-06T15:00:00Z', approverDeadlineAt: '2026-09-07T04:00:00Z',
      })),
    ],
  };
}

function document(id, data, updateTime) {
  return { id, data, ...(updateTime ? { updateTime } : {}) };
}

describe('cashflow settlement-cycle rollout audit', () => {
  it('classifies legacy authority, unresolved requests, and canonical verification targets without writing', () => {
    const inventory = buildSettlementCycleRolloutInventory({
      requests: [
        document('legacy-pending', {
          projectId: 'project-a', status: 'APPROVING', yearMonth: '2026-08',
        }),
        document('project-b-2026-09', {
          documentType: 'REQUEST', contractVersion: 'cashflow-cumulative-close-v2',
          requestId: 'project-b-2026-09', projectId: 'project-b', status: 'APPROVED',
          cycleYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
        }),
        document('__active__-project-b', {
          documentType: 'ACTIVE_COORDINATOR', projectId: 'project-b',
          activeState: 'INACTIVE', workflowRevision: 2,
        }),
      ],
      heads: [
        document('project-a', {
          contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
          status: 'CLOSED', closedThrough: '2026-08', settlementMonth: '2026-09',
          fromMonth: '2023-01', revision: 4, rootHash,
          requestId: 'project-a-2026-09', requestRevision: 2,
          approvalId: '', operationId: '',
        }),
        document('project-b', {
          contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-b',
          status: 'CLOSED', authorityExists: true, revision: 8, rootHash,
          fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
          closedRanges: [{
            affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
            closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-b',
            requestId: 'project-b-2026-09', ledgerRevision: 1, rootHash,
          }],
        }),
      ],
      settlements: [
        document('project-a-2026-08', {
          projectId: 'project-a', yearMonth: '2026-08',
          periods: { MONTH: { status: 'COMPLETED' } },
        }),
      ],
    });

    expect(inventory.counts).toMatchObject({
      legacyHeads: 1,
      canonicalHeads: 1,
      unresolvedRequests: 1,
      legacyActiveRequests: 1,
      coordinators: 1,
      genericMonthDocuments: 1,
    });
    expect(inventory.legacyHeads).toEqual([{
      projectId: 'project-a', expectedHeadRevision: 4, expectedHeadRootHash: rootHash,
    }]);
    expect(inventory.verificationTargets).toEqual([{
      projectId: 'project-b', cycleYearMonth: '2026-09', requestId: 'project-b-2026-09',
    }]);
    expect(() => assertSettlementCycleCutoverReady(inventory, [])).toThrow(/not ready/i);
  });

  function firstCloseHead(fromMonth = '2026-01') {
    return {
      contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-range',
      status: 'CLOSED', authorityExists: true, revision: 1, rootHash,
      fromMonth: '2023-01', closedThrough: '2026-09', settlementMonth: '2026-10',
      closedRanges: [{
        affectedFromMonth: fromMonth, affectedThroughMonth: '2026-09',
        closedByCycleYearMonth: '2026-10', approvalVersionId: 'version-range',
        requestId: 'project-range-2026-10', ledgerRevision: 1, rootHash,
      }],
    };
  }

  it.each(['2023-01', '2026-01'])('accepts the JVM first-close start %s without skipping projection verification', (start) => {
    const inventory = buildSettlementCycleRolloutInventory({
      heads: [document('project-range', firstCloseHead(start))],
    });
    expect(inventory.counts).toMatchObject({ canonicalHeads: 1, invalidHeads: 0 });
    expect(inventory.verificationTargets).toEqual([{
      projectId: 'project-range', cycleYearMonth: '2026-10', requestId: 'project-range-2026-10',
    }]);
    expect(() => assertSettlementCycleCutoverReady(inventory, [])).toThrow(/invalidProjections/);
  });

  it.each([
    ['wrong month', (head) => { head.closedRanges[0].affectedFromMonth = '2026-02'; }],
    ['wrong year', (head) => { head.closedRanges[0].affectedFromMonth = '2025-01'; }],
    ['reversed range', (head) => { head.closedRanges[0].affectedFromMonth = '2027-01'; }],
    ['hash mismatch', (head) => { head.closedRanges[0].rootHash = `sha256:${'b'.repeat(64)}`; }],
    ['malformed hash', (head) => { head.closedRanges[0].rootHash = 'invalid'; }],
    ['request mismatch', (head) => { head.closedRanges[0].requestId = 'project-other-2026-10'; }],
    ['cycle mismatch', (head) => { head.closedRanges[0].closedByCycleYearMonth = '2026-11'; }],
    ['head revision', (head) => { head.revision = 0; }],
    ['range revision', (head) => { head.closedRanges[0].ledgerRevision = 0; }],
    ['fractional revision', (head) => { head.closedRanges[0].ledgerRevision = 1.5; }],
  ])('still rejects %s for a yearly first-close range', (_name, mutate) => {
    const head = firstCloseHead();
    mutate(head);
    const inventory = buildSettlementCycleRolloutInventory({ heads: [document('project-range', head)] });
    expect(inventory.counts).toMatchObject({ canonicalHeads: 0, invalidHeads: 1 });
    expect(() => assertSettlementCycleCutoverReady(inventory, [])).toThrow(/invalidHeads=1/);
  });

  it.each(['2023-01', '2026-01'])('keeps later ranges contiguous after first start %s', (start) => {
    const head = firstCloseHead(start);
    head.closedRanges.push({
      ...head.closedRanges[0], affectedFromMonth: '2026-10', affectedThroughMonth: '2026-10',
      closedByCycleYearMonth: '2026-11', requestId: 'project-range-2026-11', ledgerRevision: 2,
    });
    head.closedThrough = '2026-10';
    head.settlementMonth = '2026-11';
    const inventory = () => buildSettlementCycleRolloutInventory({ heads: [document('project-range', head)] });
    expect(inventory().counts).toMatchObject({ canonicalHeads: 1, invalidHeads: 0 });
    for (const invalidStart of ['2026-09', '2026-11', '2026-01']) {
      head.closedRanges[1].affectedFromMonth = invalidStart;
      expect(inventory().counts).toMatchObject({ canonicalHeads: 0, invalidHeads: 1 });
    }
  });

  it('requires every canonical authority head to have a JVM-verifiable projection target', () => {
    const valid = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-09', ledgerRevision: 2, rootHash,
        }],
      })],
    });
    expect(valid.verificationTargets).toContainEqual({
      projectId: 'project-a', cycleYearMonth: '2026-09', requestId: 'project-a-2026-09',
    });

    const invalid = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        closedRanges: [{ affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08' }],
      })],
    });
    expect(invalid.counts.invalidHeads).toBe(1);
    expect(invalid.counts.canonicalHeads).toBe(0);
    expect(invalid.verificationTargets).toEqual([]);
  });

  it('verifies only the head cycle once a project has several approved cycles', () => {
    const request = (cycle) => document(`project-a-${cycle}`, {
      documentType: 'REQUEST', contractVersion: 'cashflow-cumulative-close-v2',
      projectId: 'project-a', requestId: `project-a-${cycle}`, cycleYearMonth: cycle, status: 'APPROVED',
    });
    const inventory = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-09', settlementMonth: '2026-10',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-09',
          closedByCycleYearMonth: '2026-10', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-10', ledgerRevision: 2, rootHash,
        }],
      })],
      requests: [request('2026-08'), request('2026-09'), request('2026-10')],
    });
    expect(inventory.verificationTargets).toEqual([{
      projectId: 'project-a', cycleYearMonth: '2026-10', requestId: 'project-a-2026-10',
    }]);
  });

  it('accepts only the cycle-keyed request identity for a canonical authority range', () => {
    const targetKeyed = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', tenantId: 'mysc', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        requestId: 'project-a-2026-08', requestRevision: 2,
        approvalId: '', operationId: '',
        migratedAt: '2026-08-27T03:04:05Z', migratedByUid: 'admin-1',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-08', ledgerRevision: 2, rootHash,
        }],
      })],
    });
    expect(targetKeyed.counts.invalidHeads).toBe(0);
    expect(targetKeyed.recoverableHeads).toEqual([expect.objectContaining({
      projectId: 'project-a', expectedHeadRevision: 3, expectedHeadRootHash: rootHash,
    })]);
    expect(targetKeyed.verificationTargets).toEqual([]);

    const cycleKeyed = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-09', ledgerRevision: 2, rootHash,
        }],
      })],
    });
    expect(cycleKeyed.verificationTargets).toEqual([{
      projectId: 'project-a', cycleYearMonth: '2026-09', requestId: 'project-a-2026-09',
    }]);
  });

  it('separates historical, Sep normalization, canonical, and invalid active requests', () => {
    const inventory = buildSettlementCycleRolloutInventory({
      requests: [
        document('historical-2026-08', {
          contractVersion: 'cashflow-cumulative-close-v2', requestId: 'historical-2026-08',
          projectId: 'historical', status: 'UNCERTAIN', yearMonth: '2026-08', throughMonth: '2026-07',
        }),
        document('normalize-2026-09', {
          contractVersion: 'cashflow-cumulative-close-v2', requestId: 'normalize-2026-09',
          projectId: 'normalize', status: 'PENDING', yearMonth: '2026-09', throughMonth: '2026-08',
          revision: 1, manifestHash: rootHash,
          requestedAt: '2026-09-03T02:00:00Z', requestedByUid: 'pm-1',
        }),
        document('canonical-2026-09', {
          documentType: 'REQUEST', contractVersion: 'cashflow-cumulative-close-v2',
          requestId: 'canonical-2026-09', projectId: 'canonical', status: 'PENDING_APPROVAL',
          cycleYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
          workflowRevision: 2, evidenceRevision: 1, manifestHash: rootHash,
          requestedAt: '2026-09-03T02:00:00Z', requestedByUid: 'pm-1',
        }),
        document('unexpected-2026-10', {
          projectId: 'unexpected', requestId: 'unexpected-2026-10',
          status: 'PENDING', yearMonth: '2026-10', throughMonth: '2026-09',
        }),
        document('__active__-canonical', {
          documentType: 'ACTIVE_COORDINATOR', projectId: 'canonical',
          activeState: 'PENDING_APPROVAL', activeCycleYearMonth: '2026-09',
          activeRequestId: 'canonical-2026-09', workflowRevision: 2,
        }),
      ],
    });

    expect(inventory.counts).toMatchObject({
      unresolvedRequests: 4,
      historicalActiveRequests: 1,
      normalizationCandidates: 1,
      canonicalActiveRequests: 1,
      invalidActiveRequests: 1,
      coordinators: 1,
      activeCoordinators: 1,
      invalidCoordinators: 0,
    });
    expect(inventory.verificationTargets).toContainEqual({
      projectId: 'canonical', cycleYearMonth: '2026-09', requestId: 'canonical-2026-09',
      expectedBusinessState: 'SUBMITTED', expectedRequestStatus: 'PENDING_APPROVAL',
    });
    expect(() => assertSettlementCycleCutoverReady(inventory, []))
      .toThrow(/normalizationCandidates=1.*invalidActiveRequests=1/);
  });

  it('requires an explicit production identity, allowlist, actor, reason, and JVM endpoint before apply', () => {
    expect(() => validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--apply', '--firebase-project', 'live-project', '--tenant', 'mysc',
    ]))).toThrow(/confirm-project/i);
    expect(() => validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--apply', '--firebase-project', 'live-project', '--confirm-project', 'other-project',
      '--tenant', 'mysc', '--confirm-tenant', 'mysc', '--allow-projects', 'project-a',
      '--people-uid', 'admin-1', '--reason', '승인된 이관', '--jvm-base-url', 'https://jvm.example',
    ]))).toThrow(/confirm-project/i);
    expect(() => validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--apply', '--firebase-project', 'live-project', '--confirm-project', 'live-project',
      '--tenant', 'mysc', '--confirm-tenant', 'mysc', '--allow-projects', '*',
      '--people-uid', 'admin-1', '--reason', '승인된 이관', '--jvm-base-url', 'https://jvm.example',
    ]))).toThrow(/allow-projects/i);
    expect(validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--apply', '--firebase-project', 'live-project', '--confirm-project', 'live-project',
      '--tenant', 'mysc', '--confirm-tenant', 'mysc', '--allow-projects', 'project-a',
      '--normalize-projects', 'project-b',
      '--people-uid', 'admin-1', '--reason', '승인된 이관', '--jvm-base-url', 'https://jvm.example',
    ]))).toMatchObject({ apply: true, allowProjects: ['project-a'], normalizeProjects: ['project-b'] });
    expect(() => validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--verify-cutover', '--firebase-project', 'live-project', '--tenant', 'mysc',
      '--jvm-base-url', 'https://jvm.example',
    ]))).toThrow(/people-uid/i);
    expect(() => validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--verify-cutover', '--firebase-project', 'live-project', '--tenant', 'mysc',
      '--people-uid', 'admin-1', '--jvm-base-url', 'http://jvm.example/path',
    ]))).toThrow(/https/i);
    expect(validateSettlementCycleRolloutOptions(parseSettlementCycleRolloutArgs([
      '--verify-cutover', '--firebase-project', 'live-project', '--tenant', 'mysc',
      '--people-uid', 'admin-1', '--jvm-base-url', 'https://candidate.example',
      '--jvm-audience', 'https://service.example', '--normalize-projects', 'project-a',
    ]))).toMatchObject({
      jvmBaseUrl: 'https://candidate.example', jvmAudience: 'https://service.example',
    });
  });

  it('builds one deterministic actor-bound migration command without inventing evidence', () => {
    expect(buildSettlementCycleHeadMigrationBody({
      tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
      projectId: 'project-a', expectedHeadRevision: 4, expectedHeadRootHash: rootHash,
    })).toEqual({
      idempotencyKey: `settlement-cycle-v3:mysc:project-a:r4:${'a'.repeat(16)}`,
      expectedHeadRevision: 4,
      expectedHeadRootHash: rootHash,
      reason: '승인된 이관',
      dryRun: false,
      expectedMigrationFingerprint: '',
    });
  });

  it('dry-runs every allowlisted project before applying them one project at a time', async () => {
    const calls = [];
    const migrate = vi.fn(async ({ projectId, body }) => {
      calls.push(`${body.dryRun ? 'dry' : 'apply'}:${projectId}`);
      const migrationFingerprint = `sha256:${(projectId === 'project-a' ? 'c' : 'd').repeat(64)}`;
      if (!body.dryRun) expect(body.expectedMigrationFingerprint).toBe(migrationFingerprint);
      const migrationRequired = projectId !== 'project-c';
      return {
        ok: true,
        commandName: 'cashflowSettlementCycle.migrateHeadV2',
        projectId,
        closedThrough: '2026-08',
        cycleYearMonth: '2026-09',
        approvalVersionId: 'version-1',
        headRevision: body.expectedHeadRevision + (migrationRequired ? 1 : 0),
        migrationRequired,
        migrationFingerprint,
        auditId: body.dryRun ? '' : `audit-${projectId}`,
      };
    });

    await expect(executeSettlementCycleHeadMigrations({
      inventory: {
        counts: { invalidActiveRequests: 1 },
        legacyHeads: [{ projectId: 'project-a', expectedHeadRevision: 4, expectedHeadRootHash: rootHash }],
      },
      options: {
        apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        allowProjects: ['project-a'],
      },
      migrate,
    })).rejects.toThrow(/invalidActiveRequests=1/);
    expect(calls).toEqual([]);

    const result = await executeSettlementCycleHeadMigrations({
      inventory: {
        legacyHeads: [
          { projectId: 'project-a', expectedHeadRevision: 4, expectedHeadRootHash: rootHash },
          { projectId: 'project-b', expectedHeadRevision: 2, expectedHeadRootHash: `sha256:${'b'.repeat(64)}` },
        ],
        recoverableHeads: [{
          projectId: 'project-c', tenantId: 'mysc',
          expectedHeadRevision: 7, expectedHeadRootHash: `sha256:${'e'.repeat(64)}`,
        }],
      },
      options: {
        apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        allowProjects: ['project-a', 'project-b', 'project-c'],
      },
      migrate,
    });

    expect(calls).toEqual([
      'dry:project-a', 'dry:project-b', 'dry:project-c', 'apply:project-a', 'apply:project-b',
    ]);
    expect(result).toEqual([
      { projectId: 'project-a', cycleYearMonth: '2026-09', headRevision: 5, auditId: 'audit-project-a' },
      { projectId: 'project-b', cycleYearMonth: '2026-09', headRevision: 3, auditId: 'audit-project-b' },
    ]);
    const resumedInventory = {
      recoverableHeads: ['project-a', 'project-b', 'project-c'].map((projectId) => ({
        projectId, tenantId: 'mysc', expectedHeadRevision: 5, expectedHeadRootHash: rootHash,
      })),
      canonicalActiveRequests: [{
        projectId: 'project-a', cycleYearMonth: '2026-09',
        requestId: 'project-a-2026-09', workflowRevision: 1,
      }],
      activeCoordinatorRecords: [{
        projectId: 'project-a', cycleYearMonth: '2026-09',
        requestId: 'project-a-2026-09', workflowRevision: 1,
      }],
    };
    const resumedOptions = {
      apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
      allowProjects: ['project-a', 'project-b', 'project-c'],
    };
    expect(await executeSettlementCycleHeadMigrations({
      inventory: resumedInventory,
      options: resumedOptions,
      migrate,
    })).toEqual([]);
    expect(calls).toHaveLength(5);
    resumedInventory.recoverableHeads[0].tenantId = 'other-tenant';
    await expect(executeSettlementCycleHeadMigrations({
      inventory: resumedInventory,
      options: resumedOptions,
      migrate,
    })).rejects.toThrow(/resume order/i);

    calls.length = 0;
    migrate.mockImplementation(async ({ projectId, body }) => {
      calls.push(`${body.dryRun ? 'dry' : 'apply'}:${projectId}`);
      if (body.dryRun && projectId === 'project-b') throw new Error('legacy evidence invalid');
      return {
        ok: true,
        commandName: 'cashflowSettlementCycle.migrateHeadV2',
        projectId,
        closedThrough: '2026-08',
        cycleYearMonth: '2026-09',
        approvalVersionId: 'version-1',
        headRevision: body.expectedHeadRevision + 1,
        migrationRequired: true,
        migrationFingerprint: `sha256:${'c'.repeat(64)}`,
        auditId: body.dryRun ? '' : `audit-${projectId}`,
      };
    });
    await expect(executeSettlementCycleHeadMigrations({
      inventory: {
        legacyHeads: [
          { projectId: 'project-a', expectedHeadRevision: 4, expectedHeadRootHash: rootHash },
          { projectId: 'project-b', expectedHeadRevision: 2, expectedHeadRootHash: `sha256:${'b'.repeat(64)}` },
        ],
      },
      options: {
        apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        allowProjects: ['project-a', 'project-b'],
      },
      migrate,
    })).rejects.toThrow(/legacy evidence invalid/i);
    expect(calls).toEqual(['dry:project-a', 'dry:project-b']);
  });

  it('repairs a head-only migration marker with its current head revision', async () => {
    const inventory = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', tenantId: 'mysc', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 5, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        requestId: 'project-a-2026-08', requestRevision: 3,
        approvalId: 'approval-a', operationId: 'operation-a',
        migratedAt: '2026-08-27T03:04:05Z', migratedByUid: 'admin-1',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-08', ledgerRevision: 3, rootHash,
        }],
      })],
    });
    const migrationFingerprint = `sha256:${'c'.repeat(64)}`;
    const migrate = vi.fn(async ({ body }) => ({
      ok: true, commandName: 'cashflowSettlementCycle.migrateHeadV2',
      projectId: 'project-a', closedThrough: '2026-08', cycleYearMonth: '2026-09',
      approvalVersionId: 'project-a-2026-09-r3-migrated-v3', headRevision: 6,
      migrationRequired: true, migrationFingerprint,
      auditId: body.dryRun ? '' : 'settlement-cycle-v3-migration',
    }));

    const result = await executeSettlementCycleHeadMigrations({
      inventory,
      options: {
        apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        allowProjects: ['project-a'],
      },
      migrate,
    });

    expect(migrate).toHaveBeenCalledTimes(2);
    expect(migrate).toHaveBeenNthCalledWith(1, {
      projectId: 'project-a',
      body: { ...buildSettlementCycleHeadMigrationBody({
        tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        projectId: 'project-a', expectedHeadRevision: 5, expectedHeadRootHash: rootHash,
      }), dryRun: true },
    });
    expect(result).toEqual([{
      projectId: 'project-a', cycleYearMonth: '2026-09', headRevision: 6,
      auditId: 'settlement-cycle-v3-migration',
    }]);
  });

  it('dry-runs every Sep request normalization before applying one project at a time', async () => {
    const calls = [];
    const normalize = vi.fn(async ({ projectId, body }) => {
      calls.push(`${body.dryRun ? 'dry' : 'apply'}:${projectId}`);
      return {
        ok: true, commandName: 'cashflowSettlementCycle.normalizeLegacyActiveRequest', projectId,
        cycleYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
        requestId: `${projectId}-2026-09`, workflowRevision: 1, evidenceRevision: 1,
        migrationFingerprint: `sha256:${(projectId === 'project-a' ? 'c' : 'd').repeat(64)}`,
        migrationRequired: true, auditId: body.dryRun ? '' : `audit-${projectId}`,
      };
    });
    const rows = ['project-a', 'project-b'].map((projectId) => ({
      projectId, requestId: `${projectId}-2026-09`, cycleYearMonth: '2026-09',
      monthCloseTargetYearMonth: '2026-08', expectedRequestRevision: 1,
      expectedManifestHash: rootHash,
    }));

    const result = await executeSettlementCycleRequestNormalizations({
      inventory: { normalizationCandidates: rows },
      options: {
        apply: true, tenantId: 'mysc', reason: '승인된 이관',
        normalizeProjects: rows.map(({ projectId }) => projectId),
      },
      normalize,
    });

    expect(calls).toEqual(['dry:project-a', 'dry:project-b', 'apply:project-a', 'apply:project-b']);
    expect(normalize).toHaveBeenNthCalledWith(1, {
      projectId: 'project-a',
      body: { ...buildSettlementCycleRequestNormalizationBody({
        tenantId: 'mysc', reason: '승인된 이관', ...rows[0],
      }), dryRun: true },
    });
    expect(result).toHaveLength(2);

    calls.length = 0;
    normalize.mockImplementation(async ({ projectId, body }) => {
      calls.push(`${body.dryRun ? 'dry' : 'apply'}:${projectId}`);
      return {
        ok: true, commandName: 'cashflowSettlementCycle.normalizeLegacyActiveRequest', projectId,
        cycleYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
        requestId: `${projectId}-2026-09`, workflowRevision: projectId === 'project-a' ? 2 : 1,
        evidenceRevision: 1,
        migrationFingerprint: `sha256:${(projectId === 'project-a' ? 'c' : 'd').repeat(64)}`,
        migrationRequired: projectId !== 'project-a', auditId: body.dryRun ? '' : `audit-${projectId}`,
      };
    });
    await executeSettlementCycleRequestNormalizations({
      inventory: {
        normalizationCandidates: [rows[1]],
        canonicalActiveRequests: [{
          projectId: 'project-a', requestId: 'project-a-2026-09',
          cycleYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
          workflowRevision: 2, evidenceRevision: 1, manifestHash: rootHash,
          requestedAt: '2026-09-03T02:00:00Z', requestedByUid: 'pm-1',
          status: 'PENDING_APPROVAL',
        }],
        activeCoordinatorRecords: [{
          projectId: 'project-a', requestId: 'project-a-2026-09',
          cycleYearMonth: '2026-09', workflowRevision: 2,
        }],
      },
      options: {
        apply: true, tenantId: 'mysc', reason: '승인된 이관',
        normalizeProjects: rows.map(({ projectId }) => projectId),
      },
      normalize,
    });
    expect(calls).toEqual(['dry:project-a', 'dry:project-b', 'apply:project-b']);

    normalize.mockClear();
    await expect(executeSettlementCycleRequestNormalizations({
      inventory: { normalizationCandidates: rows },
      expectedCandidates: [{ ...rows[0], expectedRequestRevision: 2 }, rows[1]],
      options: { apply: true, normalizeProjects: rows.map(({ projectId }) => projectId) },
      normalize,
    })).rejects.toThrow(/evidence changed/i);
    expect(normalize).not.toHaveBeenCalled();
  });

  it('fails closed instead of replaying canonical evidence scoped to a different tenant', async () => {
    const inventory = buildSettlementCycleRolloutInventory({
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', tenantId: 'other-tenant', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 5, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        requestId: 'project-a-2026-08', requestRevision: 3,
        approvalId: 'approval-a', operationId: 'operation-a',
        migratedAt: '2026-08-27T03:04:05Z', migratedByUid: 'admin-1',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-08', ledgerRevision: 3, rootHash,
        }],
      })],
    });
    const migrate = vi.fn();

    await expect(executeSettlementCycleHeadMigrations({
      inventory,
      options: {
        apply: true, tenantId: 'mysc', actorUid: 'admin-1', reason: '승인된 이관',
        allowProjects: ['project-a'],
      },
      migrate,
    })).rejects.toThrow(/tenant|eligible/i);
    expect(migrate).not.toHaveBeenCalled();
  });

  it('emits the protected status baseline without exposing the other Firestore payloads', () => {
    const report = {
      mode: 'APPLY',
      firebaseProjectId: 'secret-firebase-project',
      tenantId: 'secret-tenant',
      before: {
        counts: {
          legacyHeads: 1, canonicalHeads: 2, invalidHeads: 0,
          unresolvedRequests: 0, legacyActiveRequests: 0,
          coordinators: 2, activeCoordinators: 0, invalidCoordinators: 0, genericMonthDocuments: 4,
        },
        canonicalState: {
          heads: [{ projectId: 'secret-project', rootHash: 'secret-root-hash', migratedByUid: 'secret-actor' }],
          requests: [{ requestId: 'secret-request', submittedAt: 'secret-request-time' }],
          settlements: [{ month: { approvedBy: 'secret-approver', approvedAt: 'secret-approval-time' } }],
        },
        protectedSettlementStatuses: [{
          documentId: 'project-a-2026-09',
          dataHash: `sha256:${'f'.repeat(64)}`,
          updateTime: { seconds: 123, nanoseconds: 456 },
        }],
      },
      migrations: [{ projectId: 'secret-project', auditId: 'secret-audit-id', headRevision: 5 }],
      after: {
        counts: {
          legacyHeads: 0, canonicalHeads: 3, invalidHeads: 0,
          unresolvedRequests: 0, legacyActiveRequests: 0,
          coordinators: 2, activeCoordinators: 0, invalidCoordinators: 0, genericMonthDocuments: 4,
        },
        canonicalState: { heads: [{ migratedAt: 'secret-migrated-time' }] },
      },
      projections: [{ projectId: 'secret-project', requestId: 'secret-request' }],
      cutover: { ready: true, verifiedProjects: 1 },
    };

    const summary = settlementCycleRolloutAuditSummary(report);
    const serialized = JSON.stringify(summary);

    expect(Object.keys(summary)).toEqual([
      'counts', 'blockers', 'protectedSettlementStatuses', 'fingerprint',
    ]);
    const newCounts = {
      recoverableHeads: 0, historicalActiveRequests: 0, normalizationCandidates: 0,
      canonicalActiveRequests: 0, invalidActiveRequests: 0,
    };
    expect(summary.counts).toEqual({
      before: { ...report.before.counts, ...newCounts, migrationCandidates: 1 },
      migrations: 1,
      normalizations: 0,
      after: { ...report.after.counts, ...newCounts, migrationCandidates: 0 },
      projections: 1,
      verifiedProjects: 1,
    });
    expect(summary.blockers).toEqual({});
    expect(summary.protectedSettlementStatuses).toEqual({
      count: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(summary.fingerprint).toBe(settlementCycleRolloutFingerprint(report));
    for (const secret of [
      'secret-firebase-project', 'secret-tenant', 'secret-project', 'secret-root-hash',
      'secret-actor', 'secret-request', 'secret-request-time', 'secret-approver',
      'secret-approval-time', 'secret-audit-id', 'secret-migrated-time', 'project-a-2026-09',
    ]) {
      expect(serialized).not.toContain(secret);
    }

    const actorChanged = structuredClone(report);
    actorChanged.before.canonicalState.heads[0].migratedByUid = 'different-actor';
    expect(settlementCycleRolloutAuditSummary(actorChanged).fingerprint).not.toBe(summary.fingerprint);
  });

  it('reports an unhealthy matching projection only as an aggregate blocker count', () => {
    const report = {
      before: { counts: {} },
      migrations: [],
      after: {
        counts: {},
        verificationTargets: [{
          projectId: 'secret-project', cycleYearMonth: '2026-09', requestId: 'secret-request',
        }],
      },
      projections: [{
        projectId: 'secret-project', cycleYearMonth: '2026-09', requestId: 'secret-request',
        businessState: 'LOCKED', health: 'INCONSISTENT',
      }],
      cutover: null,
    };

    const summary = settlementCycleRolloutAuditSummary(report);

    expect(summary.blockers).toEqual({ invalidProjections: 1 });
    expect(JSON.stringify(summary)).not.toContain('secret-project');
    expect(JSON.stringify(summary)).not.toContain('secret-request');
  });

  it('opens the frontend cutover gate only after storage and JVM projections agree', () => {
    const inventory = {
      counts: {
        legacyHeads: 0, invalidHeads: 0, unresolvedRequests: 0,
        legacyActiveRequests: 0, invalidCoordinators: 0,
      },
      verificationTargets: [
        { projectId: 'project-a', cycleYearMonth: '2026-09', requestId: 'project-a-2026-09' },
      ],
    };
    expect(assertSettlementCycleCutoverReady(inventory, [{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      businessState: 'LOCKED', health: 'OK', requestId: 'project-a-2026-09',
    }])).toEqual({ ready: true, verifiedProjects: 1 });
    expect(assertSettlementCycleCutoverReady(inventory, [{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      businessState: 'LOCKED', health: 'OK', requestId: 'project-a-2026-09',
    }], ['project-a'])).toEqual({ ready: true, verifiedProjects: 1 });
    const unexpectedInventory = {
      ...inventory,
      canonicalActiveRequests: [{ projectId: 'project-b' }],
      activeCoordinatorRecords: [{ projectId: 'project-b' }],
    };
    expect(() => assertSettlementCycleCutoverReady(unexpectedInventory, [{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      businessState: 'LOCKED', health: 'OK', requestId: 'project-a-2026-09',
    }], ['project-a'])).toThrow(/unexpectedActiveRequests/);
    const laterCycleInventory = {
      ...inventory,
      canonicalActiveRequests: [{ projectId: 'project-b', cycleYearMonth: '2026-10', requestId: 'project-b-2026-10', workflowRevision: 1 }],
      activeCoordinatorRecords: [{ projectId: 'project-b', cycleYearMonth: '2026-10', requestId: 'project-b-2026-10', workflowRevision: 1 }],
    };
    expect(assertSettlementCycleCutoverReady(laterCycleInventory, [{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      businessState: 'LOCKED', health: 'OK', requestId: 'project-a-2026-09',
    }], ['project-a'])).toEqual({ ready: true, verifiedProjects: 1 });
    expect(() => assertSettlementCycleCutoverReady(inventory, [{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      businessState: 'LOCKED', health: 'INCONSISTENT', requestId: 'project-a-2026-09',
    }])).toThrow(/not ready/i);
  });

  it('rejects a cutover check when canonical storage changes during projection verification', () => {
    const before = {
      counts: { legacyHeads: 0, unresolvedRequests: 0 },
      verificationTargets: [{ projectId: 'project-a', cycleYearMonth: '2026-09', requestId: 'request-a' }],
    };
    expect(assertSettlementCycleInventoryStable(before, structuredClone(before))).toEqual({ stable: true });
    expect(() => assertSettlementCycleInventoryStable(before, {
      ...before,
      counts: { legacyHeads: 0, unresolvedRequests: 1 },
    })).toThrow(/changed/i);

    const canonicalBefore = buildSettlementCycleRolloutInventory({
      requests: [document('__active__-project-a', {
        documentType: 'ACTIVE_COORDINATOR', projectId: 'project-a',
        activeState: 'PENDING_APPROVAL', activeCycleYearMonth: '2026-09',
        activeRequestId: 'project-a-2026-09', workflowRevision: 2,
      })],
      heads: [document('project-a', {
        contractVersion: 'cashflow-cumulative-close-v2', projectId: 'project-a',
        status: 'CLOSED', authorityExists: true, revision: 3, rootHash,
        fromMonth: '2023-01', closedThrough: '2026-08', settlementMonth: '2026-09',
        closedRanges: [{
          affectedFromMonth: '2023-01', affectedThroughMonth: '2026-08',
          closedByCycleYearMonth: '2026-09', approvalVersionId: 'version-a',
          requestId: 'project-a-2026-09', ledgerRevision: 2, rootHash,
        }],
      })],
    });
    const canonicalAfter = structuredClone(canonicalBefore);
    canonicalAfter.canonicalState.requests[0].workflowRevision = 3;
    expect(canonicalAfter.counts).toEqual(canonicalBefore.counts);
    expect(canonicalAfter.verificationTargets).toEqual(canonicalBefore.verificationTargets);
    expect(() => assertSettlementCycleInventoryStable(canonicalBefore, canonicalAfter)).toThrow(/changed/i);

    const protectedAfter = structuredClone(canonicalBefore);
    canonicalBefore.protectedSettlementStatuses = [{
      documentId: 'project-a-2026-09', dataHash: rootHash,
      updateTime: { seconds: 123, nanoseconds: 456 },
    }, {
      documentId: 'unrelated-2026-09', dataHash: rootHash,
      updateTime: { seconds: 123, nanoseconds: 456 },
    }];
    protectedAfter.protectedSettlementStatuses = structuredClone(canonicalBefore.protectedSettlementStatuses);
    protectedAfter.protectedSettlementStatuses[1].updateTime.nanoseconds += 1;
    expect(assertProtectedSettlementStatusesUnchanged(
      canonicalBefore, protectedAfter, ['project-a-2026-09'],
    )).toEqual({ stable: true });
    protectedAfter.protectedSettlementStatuses[0].updateTime.nanoseconds += 1;
    expect(() => assertProtectedSettlementStatusesUnchanged(
      canonicalBefore, protectedAfter, ['project-a-2026-09'],
    )).toThrow(/status/i);
  });

  it('reads one snapshot with the protected settlement fingerprints and migration evidence', async () => {
    const collections = {
      'orgs/mysc/cashflow_month_close_requests': [document('request-1', { status: 'APPROVED' })],
      'orgs/mysc/cashflow_cumulative_close_heads': [document('project-a', { projectId: 'project-a' })],
      'orgs/mysc/cashflow_settlement_statuses': [document(
        'project-a-2026-09',
        { projectId: 'project-a', yearMonth: '2026-09', periods: {} },
        { seconds: 123, nanoseconds: 456 },
      )],
    };
    const get = vi.fn(async (query) => ({ docs: collections[query.path] }));
    const runTransaction = vi.fn(async (callback) => callback({ get }));
    const db = { collection: (path) => ({ path }), runTransaction };

    const inventory = await readSettlementCycleRolloutInventory({ db, tenantId: 'mysc' });

    expect(get).toHaveBeenCalledTimes(3);
    expect(get.mock.calls.map(([query]) => query.path)).toEqual(Object.keys(collections));
    expect(runTransaction).toHaveBeenCalledTimes(1);
    expect(runTransaction).toHaveBeenCalledWith(expect.any(Function), { readOnly: true });
    expect(inventory.counts.invalidHeads).toBe(1);
    expect(inventory.protectedSettlementStatuses).toEqual([{
      documentId: 'project-a-2026-09',
      dataHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      nonWeeklyDataHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      updateTime: { seconds: 123, nanoseconds: 456 },
    }]);
  });

  it('verifies each projection against the exact project, cycle, and request identity', async () => {
    const targets = [
      {
        projectId: 'project-a', cycleYearMonth: '2026-09', requestId: 'project-a-2026-09',
        expectedRequestStatus: 'PENDING_APPROVAL',
      },
    ];
    const submittedMonth = {
      ...lockedMonthCloseSettlement(), status: 'SUBMITTED', revision: 1, approvedAt: '', approvedBy: '',
    };
    const readProjection = vi.fn(async () => ({
      settlementStatuses: {
        ...lockedSettlementStatuses(),
        items: [submittedMonth, ...lockedSettlementStatuses().items.slice(1)],
      },
      settlementCycle: {
        cycleYearMonth: '2026-09', weeklyYearMonth: '2026-09', monthCloseTargetYearMonth: '2026-08',
        closeDeadline: '2026-09-10',
        businessState: 'SUBMITTED', health: 'OK', workflowRevision: 7,
        monthCloseSettlement: submittedMonth, supersededAttempt: null,
        commandCapabilities: {
          ...Object.fromEntries(settlementCycleCommands.map((command) => [command, {
            allowed: false, reasonCode: 'BUSINESS_STATE_NOT_ELIGIBLE',
          }])),
          WITHDRAW_MONTH_CLOSE: { allowed: true, reasonCode: '' },
        },
        provenance: null,
      },
    }));
    const readAlignedRequest = vi.fn(async () => ({
      requestId: 'project-a-2026-09', cycleYearMonth: '2026-09',
      monthCloseTargetYearMonth: '2026-08', status: 'PENDING_APPROVAL', workflowRevision: 7,
    }));

    await expect(verifySettlementCycleProjections({
      targets, readProjection, readAlignedRequest,
    })).resolves.toEqual([{
      projectId: 'project-a', cycleYearMonth: '2026-09',
      requestId: 'project-a-2026-09', businessState: 'SUBMITTED', health: 'OK',
    }]);
    expect(readProjection).toHaveBeenCalledWith({ projectId: 'project-a', cycleYearMonth: '2026-09' });
    expect(readAlignedRequest).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      context: expect.objectContaining({ requestId: 'project-a-2026-09' }),
    }));

    await expect(verifySettlementCycleProjections({
      targets: [{ ...targets[0], requestId: 'project-b-2026-09' }],
      readAlignedRequest,
      readProjection,
    })).rejects.toThrow(/identity/i);
  });

  it('checks the JVM capability before exposing migration and canonical projection operations', async () => {
    const requestJson = vi.fn(async ({ path }) => {
      if (path === '/api/v1/health') {
        return { ok: true, capabilities: ['settlement-cycle-v1'] };
      }
      if (path.includes('/migrate-head-v2')) {
        return { ok: true, commandName: 'cashflowSettlementCycle.migrateHeadV2' };
      }
      if (path.includes('/normalize-legacy-active-request')) {
        return { ok: true, commandName: 'cashflowSettlementCycle.normalizeLegacyActiveRequest' };
      }
      return {
        settlementCycle: {
          cycleYearMonth: '2026-09', businessState: 'LOCKED', health: 'OK',
          provenance: { requestId: 'project-a-2026-09' },
        },
      };
    });
    const operations = await createSettlementCycleJvmOperations({
      client: { requestJson }, tenantId: 'mysc', actorUid: 'admin-1',
    });

    await operations.migrate({ projectId: 'project-a', body: { idempotencyKey: 'migration-1' } });
    await operations.normalize({ projectId: 'project-a', body: { idempotencyKey: 'normalization-1' } });
    await operations.readProjection({ projectId: 'project-a', cycleYearMonth: '2026-09' });

    expect(requestJson).toHaveBeenNthCalledWith(1, expect.objectContaining({
      method: 'GET', path: '/api/v1/health', retry: false,
    }));
    expect(requestJson).toHaveBeenNthCalledWith(2, expect.objectContaining({
      method: 'POST',
      path: '/api/v1/cashflow/project-a/settlement-cycle/migrate-head-v2',
      retry: false,
      mutation: true,
      body: { idempotencyKey: 'migration-1' },
      context: expect.objectContaining({ tenantId: 'mysc', actorId: 'admin-1', actorRole: 'admin' }),
    }));
    expect(requestJson).toHaveBeenNthCalledWith(3, expect.objectContaining({
      method: 'POST',
      path: '/api/v1/cashflow/project-a/settlement-cycle/normalize-legacy-active-request',
      mutation: true,
      body: { idempotencyKey: 'normalization-1' },
    }));
    expect(requestJson).toHaveBeenNthCalledWith(4, expect.objectContaining({
      method: 'GET',
      path: '/api/v1/cashflow/project-a/month-close/dashboard-source?yearMonth=2026-09&settlementCycle=true',
      mutation: false,
    }));

    await expect(createSettlementCycleJvmOperations({
      client: { requestJson: async () => ({ ok: true, capabilities: [] }) },
      tenantId: 'mysc', actorUid: 'admin-1',
    })).rejects.toThrow(/capability/i);
  });

  it('documents a read-only default and all mutation confirmations in the executable CLI', async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      'scripts/audit-cashflow-settlement-cycle-rollout.mjs', '--help',
    ], { cwd: process.cwd() });

    expect(stdout).toContain('기본값: read-only');
    expect(stdout).toContain('--confirm-project');
    expect(stdout).toContain('--confirm-tenant');
    expect(stdout).toContain('--allow-projects');
    expect(stdout).toContain('--normalize-projects');
    expect(stdout).toContain('--people-uid');
    expect(stdout).toContain('--reason');
    expect(stdout).toContain('--jvm-audience');
  });
});


describe('single onboarding release stability exception', () => {
  const context = { parentSha: 'd0a2721945892f604ba39ab4c3adc7f79f519cd5', workflow: 'Production Deploy', ref: 'refs/heads/main', event: 'workflow_run', now: Date.parse('2026-10-29T09:00:00Z') };
  it('is bounded to one parent, production workflow and expiry', () => {
    expect(isOnboardingReleaseInventoryException(context)).toBe(true);
    for (const override of [{ parentSha: 'another' }, { workflow: 'CI' }, { ref: 'refs/heads/topic' }, { event: 'pull_request' }, { now: Date.parse('2026-10-29T10:00:00Z') }, { now: NaN }]) {
      expect(isOnboardingReleaseInventoryException({ ...context, ...override })).toBe(false);
    }
  });
  it('allows concurrent weekly status only and retains strict defaults and all non-weekly fields', () => {
    const record = { projectId: 'project-a', yearMonth: '2026-10', periods: { MONTH: { status: 'OPEN', revision: 1 }, WEEK_5: { status: 'PENDING_APPROVAL', revision: 1 } }, updatedAt: 'before' };
    const inventory = (data) => buildSettlementCycleRolloutInventory({ settlements: [document('project-a-2026-10', data)] });
    const before = inventory(record);
    const changed = structuredClone(record); changed.periods.WEEK_5 = { status: 'COMPLETED', revision: 2 }; changed.updatedAt = 'after';
    expect(() => assertSettlementCycleInventoryStable(before, inventory(changed))).toThrow(/changed/);
    expect(assertSettlementCycleInventoryStable(before, inventory(changed), { allowWeeklyOnly: true })).toEqual({ stable: false, weeklyOnlyException: true });
    for (const mutate of [r => { r.periods.MONTH.revision++; }, r => { r.unrelated = 'changed'; }, r => { r.periods.WEEK_6 = {}; }, r => { r.periods.MONTH.updatedAt = 'changed'; }]) {
      const candidate = structuredClone(changed); mutate(candidate);
      expect(() => assertSettlementCycleInventoryStable(before, inventory(candidate), { allowWeeklyOnly: true })).toThrow(/changed/);
    }
    const missing = structuredClone(before); delete missing.protectedSettlementStatuses[0].nonWeeklyDataHash;
    expect(() => assertSettlementCycleInventoryStable(before, missing, { allowWeeklyOnly: true })).toThrow(/Missing/);
    for (const field of ['heads', 'requests']) {
      const candidate = structuredClone(before); candidate.canonicalState[field].push({ documentId: 'new' });
      expect(() => assertSettlementCycleInventoryStable(before, candidate, { allowWeeklyOnly: true })).toThrow(/changed/);
    }
    const removed = buildSettlementCycleRolloutInventory({ settlements: [] });
    expect(() => assertSettlementCycleInventoryStable(before, removed, { allowWeeklyOnly: true })).toThrow(/changed/);
    const requestChanged = structuredClone(before); requestChanged.canonicalState.requests.push({ documentId: 'new' });
    expect(() => assertSettlementCycleInventoryStable(before, requestChanged, { allowWeeklyOnly: true })).toThrow(/changed/);
  });
});

it('preserves malformed/missing periods and future protected fields in the exception', () => {
  const inventory = data => buildSettlementCycleRolloutInventory({ settlements: [document('project-a-2026-10', data)] });
  const before = inventory({ projectId: 'project-a' });
  for (const periods of [null, false, [], 0, '']) {
    expect(() => assertSettlementCycleInventoryStable(before, inventory({ projectId: 'project-a', periods }), { allowWeeklyOnly: true })).toThrow(/changed/);
  }
  const after = structuredClone(before); after.protectedSettlementStatuses[0].futureField = 'changed';
  expect(() => assertSettlementCycleInventoryStable(before, after, { allowWeeklyOnly: true })).toThrow(/changed/);
});
