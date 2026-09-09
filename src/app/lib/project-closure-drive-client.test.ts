import { describe, expect, it, vi } from 'vitest';
import { fetchProjectClosureDriveViaBff, type PlatformApiClientLike } from './platform-bff-client';

describe('closure Drive client', () => {
  it('uses authenticated project-scoped GET with encoded pagination', async () => {
    const data = { rootFolderId: 'root', items: [{ id: 'file', name: '정산서', mimeType: 'application/pdf' }], nextPageToken: 'next' };
    const get = vi.fn(async (_path: string, _options: unknown) => ({ data }));
    const result = await fetchProjectClosureDriveViaBff({ tenantId: 'mysc', actor: { uid: 'owner', role: 'pm' }, projectId: 'project', googleAccessToken: 'user-token',
      link: 'https://drive.google.com/drive/folders/root', pageToken: 'token+with&chars', client: { get } as unknown as PlatformApiClientLike });
    expect(result).toEqual(data);
    const url = new URL(get.mock.calls[0][0], 'https://local.test');
    expect(url.pathname).toBe('/api/v1/projects/project/closure-drive');
    expect(url.searchParams.get('pageToken')).toBe('token+with&chars');
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(get.mock.calls[0][1]).toMatchObject({ tenantId: 'mysc', actor: { id: 'owner' } });
    expect(get.mock.calls[0][1]).toMatchObject({ headers: { 'x-google-access-token': 'user-token' } });
    expect(url.toString()).not.toContain('user-token');
  });
  it.each([
    { rootFolderId: 'root', items: [{ id: 'javascript:alert(1)', name: 'bad', mimeType: 'text/plain' }], nextPageToken: null },
    { rootFolderId: 'root', items: null, nextPageToken: null },
    { rootFolderId: 'root', items: [], nextPageToken: 123 },
  ])('rejects malformed metadata responses', async (data) => {
    await expect(fetchProjectClosureDriveViaBff({ tenantId: 'mysc', actor: { uid: 'owner' }, projectId: 'project', googleAccessToken: 'user-token',
      client: { get: async () => ({ data }) } as unknown as PlatformApiClientLike })).rejects.toThrow('자료 목록 응답');
  });
});
