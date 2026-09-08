#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFirestoreDb, resolveProjectId } from '../server/bff/firestore.mjs';
import { createProjectRequestContractStorageService } from '../server/bff/project-request-contract-storage.mjs';
import { buildProjectRequestPayloadFromProject } from '../server/bff/routes/projects.mjs';
import { assertTenantId, sha256, stableStringify } from '../server/bff/utils.mjs';

const REPORT_VERSION = 1;

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function jsonValue(value) {
  const serialized = JSON.stringify(value ?? null);
  return JSON.parse(serialized);
}

function stableHash(value) {
  return `sha256:${sha256(stableStringify(jsonValue(value)))}`;
}

function updateTimeIdentity(value) {
  if (typeof value === 'string') return value;
  const seconds = value?.seconds ?? value?._seconds;
  const nanoseconds = value?.nanoseconds ?? value?._nanoseconds;
  if (!Number.isSafeInteger(seconds) || !Number.isSafeInteger(nanoseconds)) return '';
  return `${seconds}:${nanoseconds}`;
}

function sourceRecord(snapshot) {
  return {
    path: snapshot.ref.path,
    data: jsonValue(snapshot.data()),
    updateTime: updateTimeIdentity(snapshot.updateTime),
  };
}

function documentEntries(payload) {
  return Object.entries(payload || {}).filter(([field, document]) => (
    field.endsWith('Document') && document !== null && document !== undefined
  ));
}

function projectIdForRequest(request) {
  return text(request?.targetProjectId || request?.approvedProjectId);
}

function candidateRequest(request) {
  return request?.requestKind === 'CHANGE'
    && request?.status === 'PENDING'
    && (request?.targetProjectVersion === null || request?.targetProjectVersion === undefined);
}

function reportDigest(report) {
  const { planDigest: _planDigest, ...unsigned } = report;
  return stableHash(unsigned);
}

async function inspectDocuments({ tenantId, projectId, proposedSnapshot, inspectAttachment }) {
  return Promise.all(documentEntries(proposedSnapshot).map(async ([field, document]) => {
    const expected = jsonValue(document);
    const path = text(document?.path);
    const prefix = `orgs/${tenantId}/project-registration-documents/${projectId}/`;
    if (!path || !path.startsWith(prefix) || path.slice(prefix.length).includes('/')) {
      return { field, expected, actual: null, ok: false, reason: 'attachment_path_invalid' };
    }
    try {
      const actual = jsonValue(await inspectAttachment({ tenantId, projectId, path }));
      const ok = text(actual?.path) === path
        && text(actual?.attachmentId) === text(document?.attachmentId)
        && Number(actual?.size) === Number(document?.size)
        && text(actual?.contentType) === text(document?.contentType);
      return { field, expected, actual, ok, ...(ok ? {} : { reason: 'attachment_metadata_mismatch' }) };
    } catch {
      return { field, expected, actual: null, ok: false, reason: 'attachment_unavailable' };
    }
  }));
}

export async function buildProjectChangeNormalizationReport({
  firebaseProjectId,
  tenantId,
  generatedAt = new Date().toISOString(),
  projects,
  requests,
  inspectAttachment,
}) {
  if (!text(firebaseProjectId) || typeof inspectAttachment !== 'function') {
    throw new Error('firebaseProjectId, tenantId, and inspectAttachment are required');
  }
  tenantId = assertTenantId(tenantId);
  const projectsById = new Map((projects || []).map((project) => [project.path.split('/').at(-1), project]));
  const candidates = (requests || []).filter(({ data }) => candidateRequest(data));
  const rows = await Promise.all(candidates.map(async (requestSource) => {
    const request = jsonValue(requestSource.data);
    const projectId = projectIdForRequest(request);
    const projectSource = projectsById.get(projectId) || null;
    const project = projectSource ? jsonValue(projectSource.data) : null;
    const proposedSnapshot = request.proposedSnapshot && typeof request.proposedSnapshot === 'object'
      ? request.proposedSnapshot
      : request.payload;
    const currentProjectSnapshot = project && proposedSnapshot && typeof proposedSnapshot === 'object'
      ? jsonValue(buildProjectRequestPayloadFromProject(project, proposedSnapshot))
      : null;
    const attachmentChecks = projectId && proposedSnapshot && typeof proposedSnapshot === 'object'
      ? await inspectDocuments({ tenantId, projectId, proposedSnapshot, inspectAttachment })
      : [];
    const reasons = [];
    const baseVersion = Number(request.baseProjectVersion);
    const currentVersion = Number(project?.version);
    if (!projectId || !projectSource) reasons.push('project_missing');
    if (!Number.isSafeInteger(baseVersion) || !Number.isSafeInteger(currentVersion) || currentVersion !== baseVersion + 1) {
      reasons.push('project_version_mismatch');
    }
    if (!proposedSnapshot || typeof proposedSnapshot !== 'object' || Array.isArray(proposedSnapshot)) {
      reasons.push('proposed_snapshot_missing');
    } else if (stableHash(proposedSnapshot) !== stableHash(currentProjectSnapshot)) {
      reasons.push('project_snapshot_mismatch');
    }
    const attachmentReasons = [...new Set(attachmentChecks.filter((check) => !check.ok).map((check) => (
      check.reason === 'attachment_unavailable' ? 'attachment_unavailable' : 'attachment_mismatch'
    )))];
    reasons.push(...attachmentReasons);
    return {
      classification: reasons.length === 0 ? 'SAFE' : 'STALE',
      reasons,
      projectId,
      request: {
        path: requestSource.path,
        updateTime: requestSource.updateTime,
        hash: stableHash(request),
        data: request,
      },
      project: projectSource ? {
        path: projectSource.path,
        updateTime: projectSource.updateTime,
        hash: stableHash(project),
        data: project,
      } : null,
      proposedSnapshotHash: proposedSnapshot ? stableHash(proposedSnapshot) : null,
      currentProjectSnapshot,
      currentProjectSnapshotHash: currentProjectSnapshot ? stableHash(currentProjectSnapshot) : null,
      attachmentChecks,
    };
  }));
  rows.sort((left, right) => left.request.path.localeCompare(right.request.path));
  const report = {
    reportVersion: REPORT_VERSION,
    mode: 'dry-run',
    generatedAt,
    firebaseProjectId: text(firebaseProjectId),
    tenantId: text(tenantId),
    summary: {
      candidates: rows.length,
      safe: rows.filter((row) => row.classification === 'SAFE').length,
      stale: rows.filter((row) => row.classification === 'STALE').length,
    },
    rows,
  };
  return { ...report, planDigest: reportDigest(report) };
}

function assertFrozenSnapshot(snapshot, expected, label) {
  if (!snapshot?.exists) throw new Error(`${label} no longer exists`);
  if (
    updateTimeIdentity(snapshot.updateTime) !== expected.updateTime
    || stableHash(snapshot.data()) !== expected.hash
  ) throw new Error(`${label} changed since dry-run`);
}

function assertPlan(plan) {
  if (
    plan?.reportVersion !== REPORT_VERSION
    || plan?.mode !== 'dry-run'
    || !Array.isArray(plan?.rows)
    || assertTenantId(plan?.tenantId) !== plan.tenantId
  ) {
    throw new Error('Normalization plan format is invalid');
  }
  if (reportDigest(plan) !== plan.planDigest) throw new Error('Normalization plan digest does not match');
}

function refsForRow(db, plan, row) {
  const projectPrefix = `orgs/${plan.tenantId}/projects/`;
  const requestPrefixes = [
    `orgs/${plan.tenantId}/project_requests/`,
    `orgs/${plan.tenantId}/projectRequests/`,
  ];
  const isDirectDocument = (path, prefix) => {
    const id = text(path).startsWith(prefix) ? text(path).slice(prefix.length) : '';
    return Boolean(id && !id.includes('/'));
  };
  if (!isDirectDocument(row.project?.path, projectPrefix)
    || !requestPrefixes.some((prefix) => isDirectDocument(row.request?.path, prefix))) {
    throw new Error('Normalization plan contains an invalid document path');
  }
  return { projectRef: db.doc(row.project.path), requestRef: db.doc(row.request.path) };
}

async function assertRowsFrozen(db, plan, rows) {
  await db.runTransaction(async (tx) => {
    for (const row of rows) {
      const { projectRef, requestRef } = refsForRow(db, plan, row);
      const [projectSnapshot, requestSnapshot] = await Promise.all([tx.get(projectRef), tx.get(requestRef)]);
      assertFrozenSnapshot(projectSnapshot, row.project, 'Project');
      assertFrozenSnapshot(requestSnapshot, row.request, 'Project request');
    }
  });
}

export async function applyProjectChangeNormalizationPlan({ db, plan, reason, now = () => new Date().toISOString() }) {
  if (!db || !text(reason)) throw new Error('db and reason are required');
  assertPlan(plan);
  const rows = plan.rows.filter((row) => row.classification === 'SAFE');
  await assertRowsFrozen(db, plan, rows);
  for (const row of rows) {
    await db.runTransaction(async (tx) => {
      const { projectRef, requestRef } = refsForRow(db, plan, row);
      const [projectSnapshot, requestSnapshot] = await Promise.all([tx.get(projectRef), tx.get(requestRef)]);
      assertFrozenSnapshot(projectSnapshot, row.project, 'Project');
      assertFrozenSnapshot(requestSnapshot, row.request, 'Project request');
      const currentVersion = Number(projectSnapshot.data()?.version);
      if (!Number.isSafeInteger(currentVersion) || currentVersion < 1) {
        throw new Error('Project version is invalid');
      }
      tx.set(requestRef, {
        baseProjectVersion: currentVersion,
        targetProjectVersion: currentVersion + 1,
        beforeSnapshot: row.currentProjectSnapshot,
        updatedAt: now(),
      }, { merge: true });
    });
  }
  return { applied: rows.length, planDigest: plan.planDigest };
}

async function readCollection(db, path) {
  const snapshot = await db.collection(path).get();
  return snapshot.docs.map(sourceRecord);
}

function flag(name, fallback = '') {
  const index = process.argv.indexOf(name);
  return index === -1 ? fallback : process.argv[index + 1] || fallback;
}

function requireAbsolutePath(value, flagName) {
  if (!value || !isAbsolute(value)) throw new Error(`${flagName} must be an absolute path`);
  return value;
}

async function main() {
  const apply = process.argv.includes('--apply');
  const firebaseProjectId = text(flag('--firebase-project', flag('--project', resolveProjectId())));
  const tenantId = assertTenantId(flag('--tenant', 'mysc'));
  const db = createFirestoreDb({ projectId: firebaseProjectId });
  if (apply) {
    const planPath = requireAbsolutePath(flag('--plan'), '--plan');
    const reason = text(flag('--reason'));
    if (!reason) throw new Error('--reason is required with --apply');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    if (plan.firebaseProjectId !== firebaseProjectId || plan.tenantId !== tenantId) {
      throw new Error('Normalization plan target does not match CLI target');
    }
    const result = await applyProjectChangeNormalizationPlan({ db, plan, reason });
    console.log(JSON.stringify({ mode: 'apply', ...result }));
    return;
  }

  const outputPath = requireAbsolutePath(flag('--output'), '--output');
  const [projects, canonicalRequests, legacyRequests] = await Promise.all([
    readCollection(db, `orgs/${tenantId}/projects`),
    readCollection(db, `orgs/${tenantId}/project_requests`),
    readCollection(db, `orgs/${tenantId}/projectRequests`).catch(() => []),
  ]);
  const storage = createProjectRequestContractStorageService({ projectId: firebaseProjectId });
  const report = await buildProjectChangeNormalizationReport({
    firebaseProjectId,
    tenantId,
    projects,
    requests: [...canonicalRequests, ...legacyRequests],
    inspectAttachment: (input) => storage.inspectProjectRegistrationAttachment(input),
  });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ mode: 'dry-run', outputPath, planDigest: report.planDigest, ...report.summary }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error('Project change request normalization failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
