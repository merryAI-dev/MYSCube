import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { MerryhereError } from './merryhere-client.mjs';

export const MERRYHERE_CONNECT_PATH = '/api/v1/merryhere/connect';
export const CONNECT_LINK_PLACEHOLDER = '{{MERRYHERE_CONNECT_LINK}}';
const LINK_TTL_MS = 15 * 60000;
const MAX_ATTEMPTS = 5;
const sha = value => createHash('sha256').update(value).digest('hex');
const fail = code => { throw new MerryhereError(code); };
const ownerId = actor => sha(`${actor.tenantId}/${actor.actorId}`);
const aad = actor => Buffer.from(`merryhere-credential:v1:${actor.tenantId}:${actor.actorId}`);

function credentialKey(env) {
  const key = Buffer.from(String(env.MERRYHERE_CREDENTIAL_KEY || ''), 'base64');
  return key.length === 32 ? { key, id: sha(key).slice(0, 12) } : null;
}

// Passwords are stored only as AES-256-GCM ciphertext bound to the owner; a missing key refuses storage instead of falling back to plaintext.
export function createMerryhereConnections({ db, env, now = Date.now, origin = env.MERRYHERE_CONNECT_ORIGIN || 'https://myscube.myscguard.app' }) {
  const secret = credentialKey(env);
  const connectionRef = actor => db.doc(`merryhere_connections/${ownerId(actor)}`);
  const linkRef = token => db.doc(`merryhere_connect_links/${sha(token)}`);
  const encrypt = (actor, value) => {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secret.key, iv);
    cipher.setAAD(aad(actor));
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return { keyId: secret.id, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
  };
  const decrypt = (actor, sealed) => {
    if (!secret || sealed?.keyId !== secret.id) fail('account_not_connected');
    try {
      const decipher = createDecipheriv('aes-256-gcm', secret.key, Buffer.from(sealed.iv, 'base64'));
      decipher.setAAD(aad(actor)); decipher.setAuthTag(Buffer.from(sealed.tag, 'base64'));
      return JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data, 'base64')), decipher.final()]).toString('utf8'));
    } catch { fail('account_not_connected'); }
  };
  return {
    available: Boolean(secret),
    async status(actor) {
      const value = (await connectionRef(actor).get()).data();
      if (!value) return 'NONE';
      if (value.status === 'ACTIVE' && value.sealed?.keyId !== secret?.id) return 'INVALID';
      return value.status || 'INVALID';
    },
    async issueLink(actor, jobId) {
      if (!secret) fail('connect_unavailable');
      const token = randomBytes(32).toString('base64url');
      await db.runTransaction(async tx => tx.create(linkRef(token), { owner: ownerId(actor), tenantId: actor.tenantId, actorId: actor.actorId,
        jobId: jobId || null, attempts: 0, used: false, createdAt: now(), expiresAt: now() + LINK_TTL_MS }));
      return `${origin}${MERRYHERE_CONNECT_PATH}#${token}`;
    },
    async credentials(actor) {
      const value = (await connectionRef(actor).get()).data();
      if (value?.status !== 'ACTIVE') fail(value?.status === 'LOGIN_FAILED' ? 'login_failed' : 'account_not_connected');
      const plain = decrypt(actor, value.sealed);
      if (typeof plain?.loginId !== 'string' || typeof plain.password !== 'string') fail('account_not_connected');
      return { email: plain.loginId, password: plain.password, accountKey: value.accountKey };
    },
    async markLoginFailed(actor) {
      await db.runTransaction(async tx => {
        const ref = connectionRef(actor);
        if ((await tx.get(ref)).data()?.status === 'ACTIVE') tx.update(ref, { status: 'LOGIN_FAILED', failedAt: now() });
      });
    },
    async disconnect(actor) {
      await db.runTransaction(async tx => { const ref = connectionRef(actor); if ((await tx.get(ref)).exists) tx.delete(ref); });
    },
    async connect({ token, loginId, password, consent }, verify) {
      if (!secret) fail('connect_unavailable');
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) fail('link_invalid');
      if (consent !== true || typeof loginId !== 'string' || typeof password !== 'string'
        || !loginId.trim() || loginId.length > 200 || !password || password.length > 200) fail('input_invalid');
      const ref = linkRef(token);
      const link = await db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.used || value.expiresAt <= now() || value.attempts >= MAX_ATTEMPTS) fail('link_invalid');
        const member = (await tx.get(db.doc(`orgs/${value.tenantId}/members/${value.actorId}`))).data();
        if (member?.status !== 'ACTIVE') fail('link_invalid');
        tx.update(ref, { attempts: value.attempts + 1 });
        return value;
      });
      const actor = { tenantId: link.tenantId, actorId: link.actorId };
      await verify({ email: loginId.trim(), password });
      const sealed = encrypt(actor, { loginId: loginId.trim(), password });
      await db.runTransaction(async tx => {
        const value = (await tx.get(ref)).data();
        if (!value || value.used || value.expiresAt <= now()) fail('link_invalid');
        tx.set(connectionRef(actor), { tenantId: actor.tenantId, actorId: actor.actorId, status: 'ACTIVE', sealed,
          accountKey: sha(loginId.trim().toLowerCase()).slice(0, 32), connectedAt: now(), verifiedAt: now() });
        tx.update(ref, { used: true, usedAt: now() });
      });
    },
  };
}
