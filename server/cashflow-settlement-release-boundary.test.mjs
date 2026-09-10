import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  assertCashflowSettlementReleaseBoundary,
  changedPathsBetween,
  classifyCashflowSettlementProductionRelease,
  classifyCashflowSettlementReleasePaths,
} from '../scripts/verify-cashflow-settlement-release-boundary.mjs';

describe('cashflow settlement release boundary', () => {
  it('publishes every JVM authorization entry including digit-bearing command constants', () => {
    const authorizationSource = readFileSync(new URL(
      './jvm-weekly-api/src/main/java/dev/merryai/innerplatform/weekly/service/WeeklyExpenseAuthorizationService.java',
      import.meta.url,
    ), 'utf8');
    const policy = JSON.parse(readFileSync(
      new URL('../policies/jvm-command-roles.json', import.meta.url),
      'utf8',
    ));
    const authorizedConstants = [...new Set([
      ...authorizationSource.matchAll(
        /WeeklyExpenseCommandService\.([A-Z0-9_]+_COMMAND)/g,
      ),
    ].map((match) => match[1]))].sort();

    expect(authorizedConstants).toContain('MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND');
    expect(Object.keys(policy.commands).sort()).toEqual(authorizedConstants);
    expect(policy.commands.MIGRATE_CASHFLOW_SETTLEMENT_CYCLE_HEAD_V2_COMMAND).toEqual({
      command: 'cashflowSettlementCycle.migrateHeadV2',
      roles: ['admin'],
    });
  });

  it('classifies the exact CI workflow as JVM-only rollout support', () => {
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      '.github/workflows/ci.yml',
      'policies/jvm-command-roles.json',
      'scripts/extract_jvm_command_roles.mjs',
    ])).toEqual({
      releaseMode: 'jvm_only',
      jvm: ['server/jvm-weekly-api/src/main/java/example/Settlement.java'],
      bffFrontendCutover: [],
      unexpectedPaths: [],
    });
  });

  it('classifies the exact Vercel identity helper and its test as JVM-only rollout support', () => {
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      'scripts/verify-vercel-deployment-identity.mjs',
      'server/vercel-deployment-identity.test.ts',
    ])).toEqual({
      releaseMode: 'jvm_only',
      jvm: ['server/jvm-weekly-api/src/main/java/example/Settlement.java'],
      bffFrontendCutover: [],
      unexpectedPaths: [],
    });
  });

  it('classifies only the exact settlement deploy verifiers as JVM-only support', () => {
    const jvmPath = 'server/jvm-weekly-api/src/main/java/example/Settlement.java';
    const verifierPath = 'scripts/verify-cashflow-settlement-cycle-projection.mjs';
    const candidatePath = 'scripts/verify-cashflow-settlement-candidate.mjs';
    expect(classifyCashflowSettlementProductionRelease([
      jvmPath,
      verifierPath,
      candidatePath,
    ])).toEqual({
      releaseMode: 'jvm_only',
      jvm: [jvmPath, verifierPath, candidatePath],
      bffFrontendCutover: [],
      unexpectedPaths: [],
    });

    expect(classifyCashflowSettlementProductionRelease([verifierPath]).releaseMode).toBe('jvm_only');
    expect(classifyCashflowSettlementProductionRelease([candidatePath]).releaseMode).toBe('jvm_only');

    const unexpectedPaths = [
      'scripts/verify-cashflow-settlement-cycle-projection.ts',
      'scripts/verify-cashflow-settlement-cycle-projection.mjs.backup',
      'scripts/verify-cashflow-settlement-cycle-projection.mjs/child',
      'scripts/verify-cashflow-settlement-cycle-projections.mjs',
    ];
    expect(classifyCashflowSettlementProductionRelease([
      jvmPath,
      ...unexpectedPaths,
    ])).toEqual({
      releaseMode: 'web',
      jvm: [jvmPath],
      bffFrontendCutover: [],
      unexpectedPaths,
    });
  });

  it('does not broaden JVM-only support around the Vercel identity helper paths', () => {
    const unexpectedPaths = [
      'scripts/verify-vercel-deployment-identity.ts',
      'scripts/verify-vercel-deployment-identity.mjs.backup',
      'scripts/verify-vercel-deployment-identity.mjs/child',
      'server/vercel-deployment-identity.test.mjs',
      'server/vercel-deployment-identity.test.ts.backup',
      'server/vercel-deployment-identity.test.ts/child',
    ];
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      ...unexpectedPaths,
    ])).toEqual({
      releaseMode: 'web',
      jvm: ['server/jvm-weekly-api/src/main/java/example/Settlement.java'],
      bffFrontendCutover: [],
      unexpectedPaths,
    });
  });

  it('does not broaden JVM-only rollout support beyond the exact CI workflow path', () => {
    const unexpectedPaths = [
      '.github/workflows/ci-extra.yml',
      '.github/workflows/ci.yml/child',
      '.github/workflows/release.yml',
      'policies/jvm-command-roles.backup.json',
      'policies/jvm-command-roles.json/child',
      'policies/rbac-policy.json',
      'scripts/extract_jvm_command_roles.ts',
      'scripts/extract_jvm_command_roles.backup.mjs',
      'package.json',
    ];
    expect(classifyCashflowSettlementProductionRelease([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      ...unexpectedPaths,
    ])).toEqual({
      releaseMode: 'web',
      jvm: ['server/jvm-weekly-api/src/main/java/example/Settlement.java'],
      bffFrontendCutover: [],
      unexpectedPaths,
    });
  });

  it('allows a JVM-first release with rollout tooling but no routed BFF/frontend cutover', () => {
    expect(assertCashflowSettlementReleaseBoundary([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      'server/bff/cashflow-settlement-cycle-rollout.mjs',
      'server/bff/cashflow/settlement-cycle/contract.mjs',
      'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs',
      'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.test.mjs',
      'scripts/audit-cashflow-settlement-cycle-rollout.mjs',
      '.github/workflows/jvm-production-deploy.yml',
    ])).toMatchObject({
      jvm: ['server/jvm-weekly-api/src/main/java/example/Settlement.java'],
      bffFrontendCutover: [],
    });
  });

  it('treats the rollout adapter as a live BFF seam after the route imports it', () => {
    expect(classifyCashflowSettlementReleasePaths([
      'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs',
    ], { rolloutSupportIsLive: true })).toEqual({
      jvm: [],
      bffFrontendCutover: [
        'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs',
      ],
    });
  });

  it('allows the later BFF/frontend cutover after JVM code is absent from that commit', () => {
    const result = assertCashflowSettlementReleaseBoundary([
      'server/bff/routes/jvm-weekly-api.mjs',
      'server/bff/cashflow/settlement-cycle/application-service.mjs',
      'src/app/components/cashflow/CashflowProjectSheet.tsx',
      'src/app/lib/platform-bff-client.ts',
    ]);
    expect(result.jvm).toEqual([]);
    expect(result.bffFrontendCutover).toEqual([
      'server/bff/routes/jvm-weekly-api.mjs',
      'server/bff/cashflow/settlement-cycle/application-service.mjs',
      'src/app/lib/platform-bff-client.ts',
    ]);
  });

  it('routes a mixed settlement release through the atomic cutover', () => {
    expect(assertCashflowSettlementReleaseBoundary([
      'server/jvm-weekly-api/src/main/java/example/Settlement.java',
      'server/bff/routes/jvm-weekly-api.mjs',
    ])).toMatchObject({ releaseMode: 'atomic_cutover' });
  });

  it('does not classify unrelated frontend or BFF files as the settlement cutover', () => {
    expect(classifyCashflowSettlementReleasePaths([
      'src/app/components/people/PeopleDirectoryPage.tsx',
      'server/bff/routes/persons.mjs',
    ])).toEqual({ jvm: [], bffFrontendCutover: [] });
  });

  it('does not gate a presentation-only project sheet change as a settlement cutover', () => {
    expect(classifyCashflowSettlementReleasePaths([
      'src/app/components/cashflow/CashflowProjectSheet.tsx',
    ])).toEqual({ jvm: [], bffFrontendCutover: [] });
  });

  it('classifies the auth and withdrawal seams that can expose settlement commands', () => {
    expect(classifyCashflowSettlementReleasePaths([
      'server/bff/java-weekly-auth.mjs',
      'server/bff/cashflow-month-close-withdrawal.mjs',
      'src/app/data/admin-route-providers.tsx',
      'src/app/data/portal-route-providers.tsx',
      'src/app/data/cashflow-month-close-request-reconcile.ts',
      'src/app/platform/api-error-messages.ts',
    ])).toEqual({
      jvm: [],
      bffFrontendCutover: [
        'server/bff/java-weekly-auth.mjs',
        'server/bff/cashflow-month-close-withdrawal.mjs',
        'src/app/data/admin-route-providers.tsx',
        'src/app/data/portal-route-providers.tsx',
        'src/app/data/cashflow-month-close-request-reconcile.ts',
        'src/app/platform/api-error-messages.ts',
      ],
    });
  });

  it('reads deletions and both sides of renames from the complete git range', () => {
    const calls = [];
    const paths = changedPathsBetween('base-sha', 'head-sha', (command, args, options) => {
      calls.push({ command, args, options });
      return [
        'D', 'server/jvm-weekly-api/obsolete.java',
        'R100', 'server/jvm-weekly-api/Old.java', 'server/bff/routes/jvm-weekly-api.mjs',
        'M', 'src/app/lib/platform-bff-client.ts',
        '',
      ].join('\0');
    });
    expect(paths).toEqual([
      'server/jvm-weekly-api/obsolete.java',
      'server/jvm-weekly-api/Old.java',
      'server/bff/routes/jvm-weekly-api.mjs',
      'src/app/lib/platform-bff-client.ts',
    ]);
    expect(calls).toEqual([expect.objectContaining({
      command: 'git',
      args: [
        'diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACDMRT',
        'base-sha', 'head-sha',
      ],
    })]);
  });

  it('routes a real multi-commit cross-boundary range through the atomic cutover', () => {
    const repository = mkdtempSync(join(tmpdir(), 'settlement-release-boundary-'));
    const git = (...args) => execFileSync('git', args, { cwd: repository, encoding: 'utf8' }).trim();
    const write = (path, value) => {
      const absolutePath = join(repository, path);
      mkdirSync(join(absolutePath, '..'), { recursive: true });
      writeFileSync(absolutePath, value);
    };

    try {
      git('init', '--quiet');
      git('config', 'user.name', 'Release Boundary Test');
      git('config', 'user.email', 'release-boundary@example.test');
      write('server/jvm-weekly-api/Old.java', 'final class Old {}\n');
      write('server/jvm-weekly-api/obsolete.java', 'final class Obsolete {}\n');
      git('add', '.');
      git('commit', '--quiet', '-m', 'base');
      const base = git('rev-parse', 'HEAD');

      mkdirSync(join(repository, 'server/bff/routes'), { recursive: true });
      git('mv', 'server/jvm-weekly-api/Old.java', 'server/bff/routes/jvm-weekly-api.mjs');
      git('commit', '--quiet', '-m', 'rename across release boundary');
      git('rm', '--quiet', 'server/jvm-weekly-api/obsolete.java');
      git('commit', '--quiet', '-m', 'delete old JVM source');
      const head = git('rev-parse', 'HEAD');

      const paths = changedPathsBetween(base, head, (command, args, options) => (
        execFileSync(command, args, { ...options, cwd: repository })
      ));
      expect(paths).toEqual(expect.arrayContaining([
        'server/jvm-weekly-api/Old.java',
        'server/bff/routes/jvm-weekly-api.mjs',
        'server/jvm-weekly-api/obsolete.java',
      ]));
      expect(classifyCashflowSettlementProductionRelease(paths)).toMatchObject({
        releaseMode: 'atomic_cutover',
        bffFrontendCutover: ['server/bff/routes/jvm-weekly-api.mjs'],
      });
      expect(assertCashflowSettlementReleaseBoundary(paths))
        .toMatchObject({ releaseMode: 'atomic_cutover' });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  });
});
