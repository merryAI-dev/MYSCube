import { describe, expect, it, vi } from 'vitest';
import { createBffClient } from '../src/bff.mjs';
import { attachmentRoute } from '../src/review/attachment-route.mjs';

describe('document deployment boundary', () => {
  it.each(['projects', 'project-requests', 'project-registration-drafts', 'project-info-drafts'])('routes only attachment processing for %s', async (type) => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    const client = createBffClient({ baseUrl: 'https://myscube.myscguard.app', attachmentBaseUrl: 'https://documents.example', idToken: 'member', fetchImpl });
    const path = `/api/v1/${type}/p1/attachments/contract/text`;
    await client.get(path, { format: 'image', page: 2 });
    await client.get('/api/v1/projects/p1/review-document');
    await client.get('/api/v1/projects/p1/attachments/contract');
    expect(fetchImpl.mock.calls.map(([url]) => url.hostname)).toEqual(['documents.example', 'myscube.myscguard.app', 'myscube.myscguard.app']);
    expect(fetchImpl.mock.calls[0][0].searchParams.get('page')).toBe('2');
  });

  it('keeps the old route until service activation and does not silently fall back on denial', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"code":"forbidden"}', { status: 403 }));
    const path = '/api/v1/projects/p1/attachments/contract/text';
    const client = createBffClient({ baseUrl: 'https://myscube.myscguard.app', attachmentBaseUrl: 'https://documents.example', idToken: 'member', fetchImpl });
    await expect(client.get(path)).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const legacy = createBffClient({ baseUrl: 'https://myscube.myscguard.app', idToken: 'member', fetchImpl });
    await expect(legacy.get(path)).rejects.toMatchObject({ status: 403 });
    expect(fetchImpl.mock.calls[1][0].hostname).toBe('myscube.myscguard.app');
  });

  it.each(['http://documents.example', 'https://user:secret@documents.example', 'https://documents.example/path'])('rejects unsafe configured origin %s', (origin) => {
    expect(() => createBffClient({ baseUrl: 'https://myscube.myscguard.app', attachmentBaseUrl: origin })).toThrow('attachment_origin_invalid');
  });

  it.each(['/api/v1/projects/../attachments/contract/text', '/api/v1/projects/p1/attachments/constructor/text', '/api/v1/projects/p1/attachments/contract/text?url=https://example.com'])('rejects non-attachment paths %s', (path) => {
    expect(attachmentRoute(path)).toBeNull();
  });
});
