import { describe, expect, it, vi } from 'vitest';
import { resolveApiRequestContext } from './app.mjs';

function createReq(headers: Record<string, string>, method: string = 'PATCH') {
  const normalized = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    normalized.set(key.toLowerCase(), value);
  }
  return {
    method,
    header(name: string) {
      return normalized.get(name.toLowerCase());
    },
  };
}

describe('resolveApiRequestContext', () => {
  it('prefers member role over firebase token role for final RBAC', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'u-member',
      'idempotency-key': 'idem-request-context-role',
    });

    const context = await resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'u-member',
        tenantId: 'mysc',
        role: 'pm',
        email: 'member@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => ({
        role: 'admin',
        status: 'ACTIVE',
        email: 'member@mysc.co.kr',
      })),
    });

    expect(context.actorRole).toBe('admin');
    expect(context.actorEmail).toBe('member@mysc.co.kr');
  });

  it('uses the persisted member name when the firebase token has no display name', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'u-member',
      'idempotency-key': 'idem-request-context-name',
    });

    const context = await resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'u-member',
        tenantId: 'mysc',
        role: 'viewer',
        email: 'member@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => ({
        role: 'viewer',
        status: 'ACTIVE',
        email: 'member@mysc.co.kr',
        name: '인증된 조직장 A',
      })),
    });

    expect(context.actorName).toBe('인증된 조직장 A');
  });

  it('rejects a firebase identity when the canonical member document is missing', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'former-finance',
      'idempotency-key': 'idem-request-context-missing-member',
    });

    await expect(resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'former-finance',
        tenantId: 'mysc',
        role: 'finance',
        email: 'former-finance@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => null),
    })).rejects.toMatchObject({ statusCode: 403, code: 'member_inactive' });
  });

  it.each(['INACTIVE', 'DISABLED'])('rejects a firebase identity with %s membership', async (status) => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'former-finance',
      'idempotency-key': `idem-request-context-${status.toLowerCase()}`,
    });

    await expect(resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'former-finance',
        tenantId: 'mysc',
        role: 'finance',
        email: 'former-finance@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => ({
        role: 'finance',
        status,
        email: 'former-finance@mysc.co.kr',
      })),
    })).rejects.toMatchObject({ statusCode: 403, code: 'member_inactive' });
  });

  it.each([
    { label: 'an empty status', status: '' },
    { label: 'a null status', status: null },
    { label: 'a non-string status', status: 7 },
    { label: 'a noncanonical lowercase status', status: 'active' },
    { label: 'a padded uppercase status', status: ' ACTIVE ' },
  ])('rejects a firebase identity with $label instead of treating it as legacy', async ({ status }) => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'malformed-member',
      'idempotency-key': 'idem-request-context-malformed-member',
    });

    await expect(resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'malformed-member',
        tenantId: 'mysc',
        role: 'finance',
        email: 'malformed-member@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => ({
        role: 'finance',
        status,
        email: 'malformed-member@mysc.co.kr',
      })),
    })).rejects.toMatchObject({ statusCode: 403, code: 'member_inactive' });
  });

  it('fails closed when firebase authentication has no canonical member resolver', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'member-without-resolver',
      'idempotency-key': 'idem-request-context-no-resolver',
    });

    await expect(resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'member-without-resolver',
        tenantId: 'mysc',
        role: 'admin',
        email: 'member-without-resolver@mysc.co.kr',
      })),
    })).rejects.toMatchObject({ statusCode: 503, code: 'member_resolver_unavailable' });
  });

  it('treats a tenant header as a lookup selector rather than cross-tenant authorization', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'org-b',
      'x-actor-id': 'claimless-former-finance',
      'idempotency-key': 'idem-request-context-claimless-tenant',
    });
    const resolveMemberIdentity = vi.fn(async () => null);

    await expect(resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'claimless-former-finance',
        role: 'finance',
        email: 'claimless-former-finance@mysc.co.kr',
      })),
      resolveMemberIdentity,
    })).rejects.toMatchObject({ statusCode: 403, code: 'member_inactive' });
    expect(resolveMemberIdentity).toHaveBeenCalledWith({
      tenantId: 'org-b',
      actorId: 'claimless-former-finance',
    });
  });

  it('accepts a claimless tenant selection only when that tenant has an active canonical member', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'org-b',
      'x-actor-id': 'active-org-b-member',
      'idempotency-key': 'idem-request-context-active-org-b-member',
    });
    const resolveMemberIdentity = vi.fn(async () => ({
      role: 'pm',
      status: 'ACTIVE',
      email: 'active-org-b-member@mysc.co.kr',
    }));

    const context = await resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'active-org-b-member',
        role: 'finance',
        email: 'active-org-b-member@mysc.co.kr',
      })),
      resolveMemberIdentity,
    });

    expect(resolveMemberIdentity).toHaveBeenCalledWith({
      tenantId: 'org-b',
      actorId: 'active-org-b-member',
    });
    expect(context).toMatchObject({ tenantId: 'org-b', actorRole: 'pm' });
  });

  it('keeps a legacy member without status active but never falls back to a token role', async () => {
    const req = createReq({
      authorization: 'Bearer token',
      'x-tenant-id': 'mysc',
      'x-actor-id': 'legacy-member',
      'idempotency-key': 'idem-request-context-legacy-member',
    });

    const context = await resolveApiRequestContext(req as any, {
      authMode: 'firebase_required',
      verifyToken: vi.fn(async () => ({
        uid: 'legacy-member',
        tenantId: 'mysc',
        role: 'finance',
        email: 'legacy-member@mysc.co.kr',
      })),
      resolveMemberIdentity: vi.fn(async () => ({
        role: '',
        email: 'legacy-member@mysc.co.kr',
      })),
    });

    expect(context.actorRole).toBeUndefined();
  });
});
