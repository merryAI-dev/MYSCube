import { randomBytes, createHash } from 'node:crypto';
import { createMerryhereClient, kstDate } from './merryhere-client.mjs';

export async function saveLocalRoomLogin({ store, email, password, fetchImpl = fetch }) {
  let session;
  const client = createMerryhereClient({ email, password, fetchImpl, saveSession: async cookies => { session = cookies; } });
  await client.login(); await client.calendar(kstDate());
  const identities = await store.read('identities.json') || {};
  const identity = createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
  const accountKey = identities[identity] || randomBytes(16).toString('hex');
  await store.write('identities.json', { ...identities, [identity]: accountKey });
  await store.write('session.json', { cookies: session, accountKey });
}

export async function localRelayApi(action, token, body) {
  if (!['register', 'poll', 'approve', 'complete', 'permit'].includes(action)) throw new Error('local_action_invalid');
  const response = await fetch(`https://myscube.myscguard.app/api/v1/merryhere/local/${action}`, { method: 'POST', redirect: 'error',
    signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(response.status === 401 ? 'local_connection_expired' : 'local_server_unavailable');
  return response.json();
}
