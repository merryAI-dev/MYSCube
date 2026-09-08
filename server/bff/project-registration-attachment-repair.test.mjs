import { describe, expect, it } from 'vitest';
import { buildRegistrationAttachmentRepairPlan, applyRegistrationAttachmentRepairPlan } from '../../scripts/repair-project-registration-attachments.mjs';

function harness() {
  const target = { firebaseProjectId: 'demo-repair', bucketName: 'demo-repair.bucket', tenantId: 'tenant', projectId: 'project', requestId: 'request', outboxId: 'event', draftId: 'draft' };
  const source = 'orgs/tenant/project-registration-drafts/draft/attachment-file.pdf';
  const attachment = { attachmentId: 'attachment', documentKind: 'contract', path: source, name: 'file.pdf', size: 100, contentType: 'application/pdf' };
  const documents = new Map(Object.entries({
    'orgs/tenant/projects/project': { version: 2, executiveReviewStatus: 'PENDING', managementPlanningReviewStatus: 'PENDING', contractDocument: null, name: 'business unchanged' },
    'orgs/tenant/project_requests/request': { requestKind: 'REGISTRATION', status: 'PENDING', requestVersion: 1, sourceDraftId: 'draft', approvedProjectId: 'project', requestedBy: 'actor', payload: { contractDocument: null } },
    'orgs/tenant/projectRequestDrafts/draft': { status: 'SUBMITTED', ownerUid: 'actor', submittedProjectId: 'project', submittedProjectRequestId: 'request', submittedOutboxId: 'event' },
    outbox: null,
    'outbox/event': { tenantId: 'tenant', eventType: 'project.registration.submitted', status: 'PENDING', payload: { projectId: 'project', projectRequestId: 'request', draftId: 'draft', actorId: 'actor', attachmentRefs: [attachment] } },
  }));
  documents.delete('outbox');
  const times = new Map([...documents.keys()].map(path => [path, 'original']));
  const updates = [];
  let beforeCommit = () => {};
  const snapshot = path => ({ exists: documents.has(path), ref: { path }, updateTime: times.get(path), data: () => structuredClone(documents.get(path)) });
  const db = {
    projectId: target.firebaseProjectId,
    doc: path => ({ path }),
    collection: path => ({ where: (field, _op, value) => ({ query: true, path, field, value }) }),
    runTransaction: async callback => {
      beforeCommit();
      const writes = [];
      const result = await callback({
        get: async ref => ref.query ? { docs: [...documents.entries()].filter(([path, data]) => path.startsWith(ref.path + '/') && data[ref.field] === ref.value).map(([path]) => snapshot(path)) } : snapshot(ref.path),
        update: (ref, fields) => writes.push({ path: ref.path, fields }),
      });
      for (const write of writes) {
        const record = documents.get(write.path);
        for (const [key, value] of Object.entries(write.fields)) {
          const parts = key.split('.');
          let parent = record;
          for (const part of parts.slice(0, -1)) parent = parent[part] ||= {};
          parent[parts.at(-1)] = structuredClone(value);
        }
        times.set(write.path, 'repaired');
        updates.push(write);
      }
      return result;
    },
  };
  const files = new Map([[source, { generation: '100', metageneration: '1', size: '100', contentType: 'application/pdf', md5Hash: 'checksum', crc32c: 'crc', metadata: { tenantId: 'tenant', draftId: 'draft', attachmentId: 'attachment' } }]]);
  const copies = [];
  const bucket = { name: target.bucketName, file: (path, options) => ({
    name: path,
    getMetadata: async () => { if (!files.has(path)) throw Object.assign(new Error('not found'), { code: 404 }); return [structuredClone(files.get(path))]; },
    copy: async (destination, config) => {
      expect(options.generation).toBe('100');
      expect(config.preconditionOpts.ifGenerationMatch).toBe(0);
      if (files.has(destination.name)) throw Object.assign(new Error('exists'), { code: 412 });
      copies.push(destination.name);
      files.set(destination.name, { ...structuredClone(files.get(path)), generation: '200', metadata: config.metadata });
    },
  }) };
  return { target, db, bucket, documents, times, files, copies, updates, source, setBeforeCommit: fn => { beforeCommit = fn; } };
}

describe('scoped registration attachment repair', () => {
  it('backs up without writes; applies only attachments atomically and repeats as a no-op', async () => {
    const h = harness();
    const plan = await buildRegistrationAttachmentRepairPlan(h);
    expect(h.updates).toHaveLength(0);
    expect(h.copies).toHaveLength(0);
    const result = await applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'approved missing attachment repair' });
    expect(result.applied).toBe(1);
    expect(h.updates).toHaveLength(3);
    const project = h.documents.get('orgs/tenant/projects/project');
    expect(project).toMatchObject({ version: 2, name: 'business unchanged', executiveReviewStatus: 'PENDING' });
    expect(project.contractDocument.path).toContain('/project-registration-documents/project/');
    expect(h.documents.get('orgs/tenant/project_requests/request').payload.contractDocument).toEqual(project.contractDocument);
    expect(h.documents.get('outbox/event')).toMatchObject({ status: 'PENDING', sideEffects: { registrationAttachments: 'DONE' } });
    expect(h.files.has(h.source)).toBe(true);
    expect(await applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'repeat' })).toMatchObject({ applied: 0 });
    expect(h.copies).toHaveLength(1);
    expect(h.updates).toHaveLength(3);
  });

  it.each(['changed', 'new-request', 'checksum', 'foreign-path', 'occupied', 'wrong-database'])('refuses %s without canonical writes', async scenario => {
    const h = harness();
    const plan = await buildRegistrationAttachmentRepairPlan(h);
    if (scenario === 'changed') h.times.set('orgs/tenant/projects/project', 'new');
    if (scenario === 'new-request') h.documents.set('orgs/tenant/project_requests/new', { requestKind: 'CHANGE', targetProjectId: 'project' });
    if (scenario === 'checksum') h.files.get(h.source).md5Hash = 'changed';
    if (scenario === 'foreign-path') plan.target.tenantId = 'other';
    if (scenario === 'occupied') h.files.set(h.source.replace('project-registration-drafts/draft', 'project-registration-documents/project'), { ...h.files.get(h.source), metadata: {} });
    if (scenario === 'wrong-database') h.db.projectId = 'another-project';
    await expect(applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'test' })).rejects.toThrow();
    expect(h.updates).toHaveLength(0);
  });

  it('rechecks after copying, retains the source and reports prepared paths on a late conflict', async () => {
    const h = harness();
    const plan = await buildRegistrationAttachmentRepairPlan(h);
    h.setBeforeCommit(() => { if (h.copies.length) h.times.set('orgs/tenant/projects/project', 'new'); });
    await expect(applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'test' })).rejects.toMatchObject({ preparedPaths: [expect.stringContaining('/project-registration-documents/project/')] });
    expect(h.updates).toHaveLength(0);
    expect(h.files.has(h.source)).toBe(true);
  });

  it('does not report a completed repair when its stored copy is missing', async () => {
    const h = harness();
    const plan = await buildRegistrationAttachmentRepairPlan(h);
    await applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'test' });
    h.files.delete(h.copies[0]);
    await expect(applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'repeat' })).rejects.toThrow();
    expect(h.updates).toHaveLength(3);
    expect(h.copies).toHaveLength(1);
  });

  it('reports a possibly created destination when copy commits but its response is lost', async () => {
    const h = harness();
    const plan = await buildRegistrationAttachmentRepairPlan(h);
    const file = h.bucket.file;
    h.bucket.file = (path, options) => {
      const result = file(path, options);
      const copy = result.copy;
      result.copy = async (...args) => { await copy(...args); throw new Error('response lost'); };
      return result;
    };
    await expect(applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'test' })).rejects.toMatchObject({ attemptedPaths: [plan.attachments[0].document.path] });
    expect(h.updates).toHaveLength(0);
    expect(h.files.has(h.source)).toBe(true);
    h.bucket.file = file;
    expect(await applyRegistrationAttachmentRepairPlan({ ...h, plan, reason: 'resume' })).toMatchObject({ applied: 1 });
    expect(h.copies).toHaveLength(1);
  });
});
