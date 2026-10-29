#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { promisify } from 'node:util';

import {
  assertProtectedSettlementStatusesUnchanged,
  assertSettlementCycleCutoverReady,
  assertSettlementCycleInventoryStable,
  isOnboardingReleaseInventoryException,
  createSettlementCycleJvmOperations,
  executeSettlementCycleHeadMigrations,
  executeSettlementCycleRequestNormalizations,
  parseSettlementCycleRolloutArgs,
  readSettlementCycleRolloutInventory,
  settlementCycleRequestNormalizationCandidates,
  settlementCycleRolloutAuditSummary,
  validateSettlementCycleRolloutOptions,
  verifySettlementCycleProjections,
} from '../server/bff/cashflow-settlement-cycle-rollout.mjs';
import { createFirestoreDb } from '../server/bff/firestore.mjs';
import { createJavaWeeklyClient } from '../server/bff/java-weekly-client.mjs';
import { readAlignedCashflowSettlementCycleRequest } from '../server/bff/cashflow/settlement-cycle/jvm-anti-corruption-adapter.mjs';

const execFileAsync = promisify(execFile);

function usage() {
  console.log(`사용:
  # 기본값: read-only inventory (Firestore write 0건)
  node scripts/audit-cashflow-settlement-cycle-rollout.mjs \\
    --firebase-project PROJECT_ID --tenant TENANT_ID

  # JVM canonical projection까지 검증
  node scripts/audit-cashflow-settlement-cycle-rollout.mjs \\
    --firebase-project PROJECT_ID --tenant TENANT_ID \\
    --verify-cutover --normalize-projects PROJECT_A[,PROJECT_B] \\
    --people-uid ACTIVE_ADMIN_UID --jvm-base-url CANDIDATE_URL \\
    --jvm-audience CANONICAL_SERVICE_URL

  # 두 allowlist를 각각 전체 dry-run 후 프로젝트별 JVM transaction migration
  node scripts/audit-cashflow-settlement-cycle-rollout.mjs \\
    --apply \\
    --firebase-project PROJECT_ID --confirm-project PROJECT_ID \\
    --tenant TENANT_ID --confirm-tenant TENANT_ID \\
    --allow-projects PROJECT_A[,PROJECT_B] \\
    --normalize-projects PROJECT_C[,PROJECT_D] \\
    --people-uid ACTIVE_ADMIN_UID --reason "승인된 운영 이관 사유" \\
    --jvm-base-url CANDIDATE_URL --jvm-audience CANONICAL_SERVICE_URL

사전 인증:
  gcloud auth login
  gcloud auth application-default login

안전장치:
  --apply 없이는 쓰지 않습니다. wildcard allowlist, 불일치하는 project/tenant 확인값,
  빈 People UID/사유, JVM capability 부재는 모두 중단합니다. 스크립트는 Firestore authority를
  직접 고치지 않습니다. head 이관 후 request 정규화 순서로, 각 allowlist 전체의 JVM
  dry-run이 성공한 뒤에만 프로젝트별 CAS/idempotency transaction command를 호출합니다.`);
}

async function runGcloud(args, signal) {
  const { stdout } = await execFileAsync('gcloud', [...args, '--quiet'], {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    ...(signal ? { signal } : {}),
  });
  const value = String(stdout || '').trim();
  if (!value) throw new Error(`gcloud returned an empty result for ${args.slice(0, 3).join(' ')}.`);
  return value;
}

async function readJvmServiceToken(firebaseProjectId) {
  const configured = String(process.env.JVM_WEEKLY_INTERNAL_API_TOKEN || '').trim();
  if (configured) return configured;
  return runGcloud([
    'secrets', 'versions', 'access', 'latest',
    '--secret=innerplatform-weekly-api-token',
    `--project=${firebaseProjectId}`,
  ]);
}

async function createJvmOperations(options) {
  const serviceToken = await readJvmServiceToken(options.firebaseProjectId);
  const configuredIdToken = String(process.env.JVM_WEEKLY_API_ID_TOKEN || '').trim();
  const client = createJavaWeeklyClient({
    env: {
      ...process.env,
      BFF_DATA_PROJECT_ID: options.firebaseProjectId,
      FIREBASE_PROJECT_ID: options.firebaseProjectId,
    },
    jvmWeeklyApiBaseUrl: options.jvmBaseUrl,
    jvmWeeklyApiServiceToken: serviceToken,
    jvmWeeklyApiIdTokenAudience: options.jvmAudience,
    jvmWeeklyApiIdentityTokenResolver: ({ audience, signal }) => configuredIdToken
      || runGcloud(['auth', 'print-identity-token', `--audiences=${audience}`], signal),
    jvmWeeklyAuthMode: 'strict',
    jvmWeeklyFirestoreProjectId: options.firebaseProjectId,
  });
  return createSettlementCycleJvmOperations({
    client,
    tenantId: options.tenantId,
    actorUid: options.actorUid,
  });
}

async function main() {
  const parsed = parseSettlementCycleRolloutArgs(process.argv.slice(2));
  if (parsed.help) {
    usage();
    return;
  }
  const options = validateSettlementCycleRolloutOptions(parsed);
  const db = createFirestoreDb({ projectId: options.firebaseProjectId });
  const before = await readSettlementCycleRolloutInventory({ db, tenantId: options.tenantId });

  let operations = null;
  let migrations = [];
  let normalizations = [];
  if (options.apply || options.verifyCutover) {
    operations = await createJvmOperations(options);
  }
  if (options.apply) {
    migrations = await executeSettlementCycleHeadMigrations({
      inventory: before,
      options,
      migrate: operations.migrate,
    });
    const afterHeads = await readSettlementCycleRolloutInventory({ db, tenantId: options.tenantId });
    normalizations = await executeSettlementCycleRequestNormalizations({
      inventory: afterHeads,
      expectedCandidates: settlementCycleRequestNormalizationCandidates(before),
      options,
      normalize: operations.normalize,
    });
  }

  let after = options.apply
    ? await readSettlementCycleRolloutInventory({ db, tenantId: options.tenantId })
    : before;
  if (options.apply) {
    assertProtectedSettlementStatusesUnchanged(
      before,
      after,
      migrations.map(({ projectId, cycleYearMonth }) => `${projectId}-${cycleYearMonth}`),
    );
  }
  let projections = [];
  let cutover = null;
  if (options.verifyCutover) {
    projections = await verifySettlementCycleProjections({
      targets: after.verificationTargets,
      readProjection: operations.readProjection,
      readAlignedRequest: ({ projectId, context }) => readAlignedCashflowSettlementCycleRequest({
        db,
        tenantId: options.tenantId,
        projectId,
        context,
      }),
    });
    const confirmed = await readSettlementCycleRolloutInventory({ db, tenantId: options.tenantId });
    let parentSha = '';
    if (!options.apply && process.env.GITHUB_WORKFLOW === 'Production Deploy') {
      parentSha = await execFileAsync('git', ['rev-parse', 'HEAD^'])
        .then(({ stdout }) => stdout).catch(() => '');
    }
    const allowWeeklyOnly = !options.apply && isOnboardingReleaseInventoryException({
      parentSha: parentSha.trim(), workflow: process.env.GITHUB_WORKFLOW,
      ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
    });
    // Both snapshots must independently satisfy semantic readiness, even under the exception.
    assertSettlementCycleCutoverReady(after, projections, options.normalizeProjects);
    const stability = assertSettlementCycleInventoryStable(after, confirmed, { allowWeeklyOnly });
    if (stability.weeklyOnlyException) {
      console.warn('AUDITED ONE-RELEASE EXCEPTION: weekly-only settlement document changes accepted; non-weekly hashes, canonical state and semantic readiness unchanged. Expires 2026-10-29T10:00:00Z.');
    }
    after = confirmed;
    cutover = assertSettlementCycleCutoverReady(after, projections, options.normalizeProjects);
  }

  const report = {
    mode: options.apply ? 'APPLY' : 'READ_ONLY',
    firebaseProjectId: options.firebaseProjectId,
    tenantId: options.tenantId,
    before,
    migrations,
    normalizations,
    after,
    projections,
    cutover,
  };
  if (options.outputPath) {
    writeFileSync(options.outputPath, `${JSON.stringify(report)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }
  console.log(JSON.stringify(settlementCycleRolloutAuditSummary(report), null, 2));
}

main().catch((error) => {
  console.error(error?.stack || String(error));
  process.exitCode = 1;
});
