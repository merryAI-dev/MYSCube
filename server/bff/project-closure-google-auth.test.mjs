import { describe, expect, it, vi } from 'vitest';
import { verifyClosureGoogleAccess } from './project-closure-google-auth.mjs';

const context = { authSource: 'firebase', googleSubject: 'google-person' };
const info = { aud: 'myscube.apps.googleusercontent.com', sub: 'google-person', expires_in: 3500, scope: 'openid https://www.googleapis.com/auth/drive.metadata.readonly' };
const options = (body = info) => ({ clientId: info.aud, fetchImpl: vi.fn(async () => new Response(JSON.stringify(body))) });

describe('checkout Google identity boundary', () => {
  it('verifies the same bearer against Google without placing it in the URL', async () => {
    const config = options();
    await expect(verifyClosureGoogleAccess('user-token', context, config)).resolves.toBeUndefined();
    expect(config.fetchImpl).toHaveBeenCalledWith('https://oauth2.googleapis.com/tokeninfo', expect.objectContaining({ method: 'POST', headers: { authorization: 'Bearer user-token', 'content-type': 'application/x-www-form-urlencoded' }, redirect: 'error' }));
  });
  it.each([
    [{ ...info, sub: 'other' }, 'project_closure_google_account_mismatch'],
    [{ ...info, aud: 'other-client' }, 'project_closure_google_reconnect'],
    [{ ...info, expires_in: 0 }, 'project_closure_google_reconnect'],
    [{ ...info, scope: 'openid' }, 'project_closure_google_reconnect'],
  ])('rejects invalid token claims', async (body, code) => {
    await expect(verifyClosureGoogleAccess('user-token', context, options(body))).rejects.toMatchObject({ code });
  });
  it.each(['', 'token\r\ninjection'])('rejects missing or malformed bearer before Google', async (token) => {
    const config = options();
    await expect(verifyClosureGoogleAccess(token, context, config)).rejects.toMatchObject({ statusCode: 401 });
    expect(config.fetchImpl).not.toHaveBeenCalled();
  });
  it('rejects header-auth and fails closed without client configuration', async () => {
    await expect(verifyClosureGoogleAccess('token', { ...context, authSource: 'headers' }, options())).rejects.toMatchObject({ statusCode: 403 });
    await expect(verifyClosureGoogleAccess('token', context, { ...options(), clientId: '' })).rejects.toMatchObject({ statusCode: 503 });
  });
  it.each([400, 401, 500])('sanitizes Google failures %s', async (status) => {
    await expect(verifyClosureGoogleAccess('secret', context, { ...options(), fetchImpl: async () => new Response('secret', { status }) })).rejects.toMatchObject({ code: status < 500 ? 'project_closure_google_reconnect' : 'project_closure_drive_unavailable' });
  });
});
