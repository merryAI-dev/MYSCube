import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ popup: vi.fn(), credential: vi.fn(), scopes: [] as string[], currentUser: { uid: 'owner' } as { uid: string } | null }));
vi.mock('firebase/auth', () => ({
  GoogleAuthProvider: class {
    addScope(value: string) { mocks.scopes.push(value); }
    setCustomParameters() {}
    static credentialFromResult = mocks.credential;
  },
  reauthenticateWithPopup: mocks.popup,
}));
vi.mock('../lib/firebase', () => ({ getAuthInstance: () => ({ get currentUser() { return mocks.currentUser; } }) }));
import { requestGoogleDriveMetadataAccess } from './google-drive-metadata-access';

describe('checkout scoped Google connection', () => {
  beforeEach(() => {
    mocks.scopes.length = 0;
    mocks.currentUser = { uid: 'owner' };
    mocks.popup.mockReset().mockResolvedValue({ user: { uid: 'owner' } });
    mocks.credential.mockReset().mockReturnValue({ accessToken: 'user-token' });
  });
  it('requests metadata only on the existing Firebase user', async () => {
    await expect(requestGoogleDriveMetadataAccess('owner')).resolves.toBe('user-token');
    expect(mocks.scopes).toEqual(['https://www.googleapis.com/auth/drive.metadata.readonly']);
    expect(mocks.popup.mock.calls[0][0]).toBe(mocks.currentUser);
  });
  it('does not sign in a different Firebase user', async () => {
    await expect(requestGoogleDriveMetadataAccess('other')).rejects.toThrow('로그인');
    expect(mocks.popup).not.toHaveBeenCalled();
  });
  it('rejects account changes during consent', async () => {
    mocks.popup.mockImplementation(async () => { mocks.currentUser = { uid: 'other' }; return { user: { uid: 'owner' } }; });
    await expect(requestGoogleDriveMetadataAccess('owner')).rejects.toThrow('변경');
  });
  it('sanitizes popup cancellation instead of logging credentials', async () => {
    mocks.popup.mockRejectedValue({ code: 'auth/popup-closed-by-user', message: 'secret' });
    await expect(requestGoogleDriveMetadataAccess('owner')).rejects.toThrow('취소');
  });
});
