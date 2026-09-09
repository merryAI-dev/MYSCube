import { describe, expect, it } from 'vitest';
import { PROJECT_DOCUMENTS, projectUpdatePayload } from './project-documents';
import type { Project } from '../data/types';

describe('project document write boundary', () => {
  it('does not echo server-owned closure facts through ordinary project saves', () => {
    const payload = projectUpdatePayload({ id: 'p', closureRequestId: 'c', closure: { requestId: 'c' } } as Project, { name: '수정' });
    expect(payload).not.toHaveProperty('closure');
    expect(payload).not.toHaveProperty('closureRequestId');
  });
  const cached = { id: 'project', name: 'Project', version: 2, ...Object.fromEntries(PROJECT_DOCUMENTS.map(({ field }) => [field, null])) } as Project;

  it.each([{ status: 'COMPLETED' }, { checkout: { complete: true } }])('omits every cached attachment for %j', (updates) => {
    const payload = projectUpdatePayload(cached, updates as Partial<Project>);
    expect(payload).toMatchObject(updates);
    for (const { field } of PROJECT_DOCUMENTS) expect(Object.hasOwn(payload, field)).toBe(false);
    expect(payload.expectedProjectDocuments).toEqual({});
  });

  it.each(PROJECT_DOCUMENTS)('carries originals only for explicit $field writes, including deletion', ({ field }) => {
    const attachment = { path: `private/${field}.pdf`, name: field, size: 1, contentType: 'application/pdf' };
    expect(projectUpdatePayload(cached, { [field]: attachment })).toMatchObject({ [field]: attachment, expectedProjectDocuments: { [field]: null } });
    expect(projectUpdatePayload({ ...cached, [field]: attachment }, { [field]: null })).toMatchObject({ [field]: null, expectedProjectDocuments: { [field]: attachment } });
    expect(Object.keys(projectUpdatePayload(cached, { [field]: attachment }).expectedProjectDocuments)).toEqual([field]);
  });
});
