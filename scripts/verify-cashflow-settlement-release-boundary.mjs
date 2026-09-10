#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const JVM_ROOT = 'server/jvm-weekly-api/';
const BFF_CUTOVER_PATHS = [
  'server/bff/routes/jvm-weekly-api.mjs',
  'server/bff/cashflow/settlement-cycle/',
  'server/bff/java-weekly-auth.mjs',
  'server/bff/cashflow-month-close-withdrawal.mjs',
  'src/app/components/cashflow/',
  'src/app/data/admin-route-providers.tsx',
  'src/app/data/portal-route-providers.tsx',
  'src/app/data/cashflow-month-close-request-reconcile.ts',
  'src/app/data/cashflow-weeks-store.tsx',
  'src/app/lib/platform-bff-client.ts',
  'src/app/platform/api-error-messages.ts',
  'src/app/platform/cashflow-settlement-cycle.ts',
];
const PRESENTATION_ONLY_PATHS = new Set([
  'src/app/components/cashflow/CashflowProjectSheet.tsx',
]);
const JVM_ROLLOUT_SUPPORT_PATHS = new Set([
  'server/bff/cashflow/settlement-cycle/contract.mjs',
  'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs',
  'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.test.mjs',
]);
const JVM_ONLY_RELEASE_SUPPORT_PATHS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/jvm-production-deploy.yml',
  '.github/workflows/production-deploy.yml',
  'deploy-prod-align.mjs',
  'policies/jvm-command-roles.json',
  'scripts/audit-cashflow-settlement-cycle-rollout.mjs',
  'scripts/deploy-vercel-production-candidate.mjs',
  'scripts/extract_jvm_command_roles.mjs',
  'scripts/verify-cashflow-settlement-candidate.mjs',
  'scripts/verify-cashflow-settlement-cutover-sequence.mjs',
  'scripts/verify-cashflow-settlement-cycle-projection.mjs',
  'scripts/verify-vercel-deployment-identity.mjs',
  'scripts/verify-cashflow-settlement-release-boundary.mjs',
  'server/bff/cashflow-settlement-cycle-rollout.integration.test.ts',
  'server/bff/cashflow-settlement-cycle-rollout.mjs',
  'server/bff/cashflow-settlement-cycle-rollout.test.mjs',
  'server/bff/cashflow/settlement-cycle/contract.mjs',
  'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs',
  'server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.test.mjs',
  'server/cashflow-settlement-candidate-canary.test.mjs',
  'server/cashflow-settlement-release-boundary.test.mjs',
  'server/deploy-prod-align.test.ts',
  'server/production-deploy-workflow.test.ts',
  'server/vercel-deployment-identity.test.ts',
]);
const JVM_WEEKLY_ROUTE = 'server/bff/routes/jvm-weekly-api.mjs';
const JVM_ROLLOUT_SUPPORT_IMPORT = '../cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs';

function isPathOrChild(path, candidate) {
  return candidate.endsWith('/') ? path.startsWith(candidate) : path === candidate;
}

export function classifyCashflowSettlementReleasePaths(paths, { rolloutSupportIsLive = false } = {}) {
  const normalized = [...new Set(paths.map((path) => String(path || '').trim()).filter(Boolean))];
  return {
    jvm: normalized.filter((path) => path.startsWith(JVM_ROOT)
      || path === 'scripts/verify-cashflow-settlement-cycle-projection.mjs'
      || path === 'scripts/verify-cashflow-settlement-candidate.mjs'),
    bffFrontendCutover: normalized.filter((path) => (
      (!JVM_ROLLOUT_SUPPORT_PATHS.has(path) || rolloutSupportIsLive)
      && !PRESENTATION_ONLY_PATHS.has(path)
      &&
      BFF_CUTOVER_PATHS.some((candidate) => isPathOrChild(path, candidate))
    )),
  };
}

export function classifyCashflowSettlementProductionRelease(paths, options = {}) {
  const normalized = [...new Set(paths.map((path) => String(path || '').trim()).filter(Boolean))];
  const { jvm, bffFrontendCutover } = classifyCashflowSettlementReleasePaths(normalized, options);
  const unexpectedPaths = normalized.filter((path) => (
    !path.startsWith(JVM_ROOT) && !JVM_ONLY_RELEASE_SUPPORT_PATHS.has(path)
  ));
  return {
    releaseMode: options.alreadyDeployed
      ? 'already_deployed'
      : jvm.length > 0 && bffFrontendCutover.length > 0
        ? 'atomic_cutover'
        : jvm.length > 0 && unexpectedPaths.length === 0
          ? 'jvm_only'
          : 'web',
    jvm,
    bffFrontendCutover,
    unexpectedPaths,
  };
}

export function assertCashflowSettlementReleaseBoundary(paths, options) {
  return classifyCashflowSettlementProductionRelease(paths, options);
}

export function isJvmRolloutSupportLiveAt(head, execFile = execFileSync) {
  const routeSource = execFile('git', ['show', `${head}:${JVM_WEEKLY_ROUTE}`], { encoding: 'utf8' });
  return String(routeSource).includes(JVM_ROLLOUT_SUPPORT_IMPORT);
}

export function changedPathsBetween(base, head, execFile = execFileSync) {
  const stdout = execFile('git', [
    'diff', '--name-status', '-z', '--find-renames', '--diff-filter=ACDMRT', base, head,
  ], {
    encoding: 'utf8',
  });
  const fields = String(stdout || '').split('\0');
  const paths = [];
  for (let index = 0; index < fields.length;) {
    const status = fields[index++];
    if (!status) continue;
    const source = fields[index++];
    if (!source) throw new Error(`Malformed git diff entry for status ${status}.`);
    paths.push(source);
    if (status.startsWith('R') || status.startsWith('C')) {
      const target = fields[index++];
      if (!target) throw new Error(`Malformed git ${status} entry.`);
      paths.push(target);
    }
  }
  return [...new Set(paths)];
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!['--base', '--jvm-base', '--bff-base', '--head'].includes(arg) || index + 1 >= argv.length) {
      throw new Error(`Unknown or incomplete option: ${arg}`);
    }
    options[arg.slice(2).replaceAll('-', '')] = argv[index + 1];
    index += 1;
  }
  if (options.base) {
    options.jvmbase ||= options.base;
    options.bffbase ||= options.base;
  }
  if (!options.jvmbase || !options.bffbase || !options.head) {
    throw new Error('--jvm-base, --bff-base, and --head are required.');
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const classificationOptions = {
    rolloutSupportIsLive: isJvmRolloutSupportLiveAt(options.head),
  };
  const jvmPending = classifyCashflowSettlementReleasePaths(
    changedPathsBetween(options.jvmbase, options.head),
    classificationOptions,
  ).jvm;
  const bffPending = classifyCashflowSettlementReleasePaths(
    changedPathsBetween(options.bffbase, options.head),
    classificationOptions,
  ).bffFrontendCutover;
  const result = assertCashflowSettlementReleaseBoundary(
    [...jvmPending, ...bffPending],
    classificationOptions,
  );
  console.log(JSON.stringify({ ok: true, ...result }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error?.message || String(error));
    process.exitCode = 1;
  });
}
