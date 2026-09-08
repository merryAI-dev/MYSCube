#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getStorage } from 'firebase-admin/storage';
import { createFirestoreDb, getOrInitAdminApp } from '../server/bff/firestore.mjs';
import { sha256, stableStringify } from '../server/bff/utils.mjs';
import { PROJECT_REGISTRATION_DOCUMENT_KINDS, PROJECT_DOCUMENT_FIELD_BY_KIND } from '../server/bff/project-document-validation.mjs';

const hash = value => sha256(stableStringify(JSON.parse(JSON.stringify(value))));
const updateTime = value => typeof value === 'string' ? value : `${value?.seconds}:${value?.nanoseconds}`;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const digest = ({ planDigest: _digest, ...plan }) => hash(plan);

function pathsFor(target) {
  for (const key of ['firebaseProjectId', 'bucketName', 'tenantId', 'projectId', 'requestId', 'outboxId', 'draftId']) {
    assert(typeof target?.[key] === 'string' && /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(target[key]), `Explicit safe ${key} is required`);
  }
  const prefix = `orgs/${target.tenantId}`;
  return {
    project: `${prefix}/projects/${target.projectId}`,
    request: `${prefix}/project_requests/${target.requestId}`,
    draft: `${prefix}/projectRequestDrafts/${target.draftId}`,
    outbox: `outbox/${target.outboxId}`,
  };
}

async function readSources(tx, db, target) {
  const records = {};
  for (const [key, path] of Object.entries(pathsFor(target))) {
    const snap = await tx.get(db.doc(path));
    assert(snap.exists, `${key} is missing`);
    records[key] = { path, updateTime: updateTime(snap.updateTime), data: JSON.parse(JSON.stringify(snap.data())) };
  }
  // CHANGE submit does not update Project; transaction query reads catch a concurrent new Request.
  for (const collection of ['project_requests', 'projectRequests']) {
    for (const field of ['approvedProjectId', 'targetProjectId']) {
      const related = await tx.get(db.collection(`orgs/${target.tenantId}/${collection}`).where(field, '==', target.projectId));
      assert(related.docs.every(snap => snap.ref.path === records.request.path), 'Another project request exists; manual review required');
    }
  }
  return records;
}

function attachmentsFor(target, records) {
  const { project: { data: project }, request: { data: request }, draft: { data: draft }, outbox: { data: event } } = records;
  assert(request.requestKind === 'REGISTRATION' && request.status === 'PENDING', 'Registration request is not pending');
  assert(project.executiveReviewStatus === 'PENDING' && project.managementPlanningReviewStatus === 'PENDING', 'Project review has already progressed');
  assert(request.sourceDraftId === target.draftId && request.approvedProjectId === target.projectId, 'Request source identity mismatch');
  assert(draft.status === 'SUBMITTED' && draft.submittedProjectId === target.projectId && draft.submittedProjectRequestId === target.requestId && draft.submittedOutboxId === target.outboxId, 'Submitted draft identity mismatch');
  assert(event.tenantId === target.tenantId && event.eventType === 'project.registration.submitted' && event.status === 'PENDING', 'Outbox is not an unclaimed pending registration');
  const payload = event.payload;
  assert(payload?.projectId === target.projectId && payload.projectRequestId === target.requestId && payload.draftId === target.draftId && payload.actorId === request.requestedBy && (draft.ownerUid || draft.ownerId) === request.requestedBy, 'Outbox source identity mismatch');
  assert(Array.isArray(payload.attachmentRefs) && payload.attachmentRefs.length > 0 && payload.attachmentRefs.length <= 8, 'Original attachment references are missing');
  const kinds = new Set();
  return payload.attachmentRefs.map(ref => {
    assert(PROJECT_REGISTRATION_DOCUMENT_KINDS.includes(ref.documentKind) && !kinds.has(ref.documentKind), 'Attachment kind is unsupported or ambiguous');
    kinds.add(ref.documentKind);
    const prefix = `orgs/${target.tenantId}/project-registration-drafts/${target.draftId}/`;
    const name = typeof ref.path === 'string' && ref.path.startsWith(prefix) ? ref.path.slice(prefix.length) : '';
    assert(name && !name.includes('/') && name !== '.' && name !== '..' && ref.attachmentId && Number.isSafeInteger(ref.size) && ref.size > 0, 'Attachment source is outside the specified draft');
    const field = PROJECT_DOCUMENT_FIELD_BY_KIND[ref.documentKind];
    assert(project[field] == null && request.payload?.[field] == null, 'Existing attachment must not be overwritten');
    const document = {
      attachmentId: ref.attachmentId, path: `orgs/${target.tenantId}/project-registration-documents/${target.projectId}/${name}`,
      name: ref.name, size: ref.size, contentType: ref.contentType, visibility: 'PRIVATE',
      ...(ref.uploadedAt ? { uploadedAt: ref.uploadedAt } : {}),
    };
    return { field, sourcePath: ref.path, document };
  });
}

function assertMetadata(metadata, attachment, target) {
  assert(metadata.generation && metadata.metageneration && (metadata.md5Hash || metadata.crc32c), 'Storage checksum/generation is missing');
  assert(Number(metadata.size) === attachment.document.size && metadata.contentType === attachment.document.contentType, 'Storage size/type mismatch');
  assert(metadata.metadata?.tenantId === target.tenantId && metadata.metadata?.draftId === target.draftId && metadata.metadata?.attachmentId === attachment.document.attachmentId, 'Storage ownership mismatch');
}

export async function buildRegistrationAttachmentRepairPlan({ db, bucket, target }) {
  pathsFor(target);
  assert(db.projectId === target.firebaseProjectId, 'Firestore project mismatch');
  assert(bucket.name === target.bucketName, 'Storage bucket mismatch');
  const records = await db.runTransaction(tx => readSources(tx, db, target));
  const attachments = attachmentsFor(target, records);
  for (const attachment of attachments) {
    const [metadata] = await bucket.file(attachment.sourcePath).getMetadata();
    assertMetadata(metadata, attachment, target);
    attachment.metadata = metadata;
  }
  const plan = { reportVersion: 1, mode: 'dry-run', target, generatedAt: new Date().toISOString(), records, attachments };
  return { ...plan, planDigest: digest(plan) };
}

function assertPlan(plan, bucket) {
  assert(plan?.reportVersion === 1 && plan.mode === 'dry-run' && plan.planDigest === digest(plan), 'Repair plan digest/format mismatch');
  const paths = pathsFor(plan.target);
  assert(bucket.name === plan.target.bucketName, 'Storage bucket mismatch');
  for (const [key, path] of Object.entries(paths)) assert(plan.records?.[key]?.path === path, 'Backup document path mismatch');
  const derived = attachmentsFor(plan.target, plan.records);
  assert(hash(derived) === hash(plan.attachments.map(({ metadata: _metadata, ...attachment }) => attachment)), 'Repair references differ from original event');
  for (const attachment of plan.attachments) assertMetadata(attachment.metadata, attachment, plan.target);
}

async function checkFrozen(tx, db, plan) {
  const current = await readSources(tx, db, plan.target);
  const repaired = ['project', 'request', 'outbox'].every(key => current[key].data.registrationAttachmentRepair?.planDigest === plan.planDigest);
  if (repaired) {
    for (const { field, document } of plan.attachments) {
      assert(hash(current.project.data[field]) === hash(document) && hash(current.request.data.payload[field]) === hash(document), 'Previously repaired references changed');
    }
    assert(current.outbox.data.sideEffects?.registrationAttachments === 'DONE', 'Repair side effect marker changed');
    return true;
  }
  for (const key of Object.keys(plan.records)) {
    assert(current[key].updateTime === plan.records[key].updateTime && hash(current[key].data) === hash(plan.records[key].data), `${key} changed since backup`);
  }
  attachmentsFor(plan.target, current);
  return false;
}

function copyMatches(metadata, attachment) {
  return metadata.metadata?.repairSourcePath === attachment.sourcePath
    && metadata.metadata?.repairSourceGeneration === attachment.metadata.generation
    && metadata.size === attachment.metadata.size && metadata.contentType === attachment.metadata.contentType
    && metadata.md5Hash === attachment.metadata.md5Hash && metadata.crc32c === attachment.metadata.crc32c;
}

async function verifyCopies(bucket, plan) {
  for (const attachment of plan.attachments) {
    const [metadata] = await bucket.file(attachment.document.path).getMetadata();
    assert(copyMatches(metadata, attachment), 'Previously repaired file changed');
  }
}

async function prepareCopy(bucket, attachment) {
  const [sourceNow] = await bucket.file(attachment.sourcePath).getMetadata();
  assert(hash(sourceNow) === hash(attachment.metadata), 'Storage source changed since backup');
  const destination = bucket.file(attachment.document.path);
  try {
    const [metadata] = await destination.getMetadata();
    assert(copyMatches(metadata, attachment), 'Destination already exists with different provenance/content');
    return;
  } catch (error) { if (Number(error.code) !== 404) throw error; }
  await bucket.file(attachment.sourcePath, { generation: attachment.metadata.generation }).copy(destination, {
    preconditionOpts: { ifGenerationMatch: 0 },
    metadata: { ...attachment.metadata.metadata, repairSourcePath: attachment.sourcePath, repairSourceGeneration: attachment.metadata.generation },
  });
  const [metadata] = await destination.getMetadata();
  assert(copyMatches(metadata, attachment), 'Copied attachment checksum/provenance mismatch');
}

export async function applyRegistrationAttachmentRepairPlan({ db, bucket, plan, reason }) {
  assert(typeof reason === 'string' && reason.trim(), 'Repair reason is required');
  assertPlan(plan, bucket);
  assert(db.projectId === plan.target.firebaseProjectId, 'Firestore project mismatch');
  if (await db.runTransaction(tx => checkFrozen(tx, db, plan))) {
    await verifyCopies(bucket, plan);
    return { applied: 0, planDigest: plan.planDigest };
  }
  const preparedPaths = [];
  const attemptedPaths = [];
  try {
    for (const attachment of plan.attachments) {
      attemptedPaths.push(attachment.document.path);
      await prepareCopy(bucket, attachment);
      preparedPaths.push(attachment.document.path);
    }
    const applied = await db.runTransaction(async tx => {
      if (await checkFrozen(tx, db, plan)) return 0;
      const timestamp = new Date().toISOString();
      const marker = { planDigest: plan.planDigest, reason: reason.trim(), repairedAt: timestamp };
      tx.update(db.doc(plan.records.project.path), {
        ...Object.fromEntries(plan.attachments.map(({ field, document }) => [field, document])),
        registrationAttachmentsPublishedAt: timestamp, registrationAttachmentRepair: marker,
      });
      tx.update(db.doc(plan.records.request.path), {
        ...Object.fromEntries(plan.attachments.map(({ field, document }) => [`payload.${field}`, document])),
        registrationAttachmentsPublishedAt: timestamp, registrationAttachmentRepair: marker,
      });
      tx.update(db.doc(plan.records.outbox.path), {
        'sideEffects.registrationAttachments': 'DONE', 'sideEffects.registrationAttachmentsAt': timestamp,
        registrationAttachmentRepair: marker,
      });
      return 1;
    });
    return { applied, preparedPaths, planDigest: plan.planDigest };
  } catch (error) {
    error.preparedPaths = preparedPaths;
    error.attemptedPaths = attemptedPaths;
    throw error;
  }
}

export async function runRegistrationAttachmentRepairCli({ args = process.argv.slice(2), db, bucket } = {}) {
  const flag = name => args[args.indexOf(name) + 1];
  const required = name => { assert(args.includes(name) && flag(name) && !flag(name).startsWith('--'), `${name} is required`); return flag(name); };
  const target = Object.fromEntries(['firebaseProjectId', 'bucketName', 'tenantId', 'projectId', 'requestId', 'outboxId', 'draftId'].map(key => [key, required(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`)]));
  pathsFor(target);
  db ||= createFirestoreDb({ projectId: target.firebaseProjectId });
  bucket ||= getStorage(getOrInitAdminApp({ projectId: target.firebaseProjectId })).bucket(target.bucketName);
  if (args.includes('--apply')) {
    const planPath = required('--plan');
    assert(isAbsolute(planPath), '--plan must be absolute');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    assert(hash(plan.target) === hash(target), 'CLI target differs from backup');
    console.log(JSON.stringify(await applyRegistrationAttachmentRepairPlan({ db, bucket, plan, reason: required('--reason') })));
  } else {
    const output = required('--output');
    assert(isAbsolute(output), '--output must be absolute');
    const plan = await buildRegistrationAttachmentRepairPlan({ db, bucket, target });
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ mode: 'dry-run', output, planDigest: plan.planDigest, attachments: plan.attachments.length }));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRegistrationAttachmentRepairCli().catch(error => { console.error(JSON.stringify({ error: error.message, preparedPaths: error.preparedPaths || [], attemptedPaths: error.attemptedPaths || [] })); process.exitCode = 1; });
}
