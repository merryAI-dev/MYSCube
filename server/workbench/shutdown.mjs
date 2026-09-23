import { setTimeout as pause } from 'node:timers/promises';

export async function closeWorkbenchServer({ server, db, remoteRuntime, timeoutMs = 10000 }) {
  let expired = false, timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { expired = true; server.closeAllConnections?.(); resolve(1); }, timeoutMs);
  });
  try {
    if (remoteRuntime) (remoteRuntime.shutdown || remoteRuntime.closeAll).call(remoteRuntime);
    const drain = async () => {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      while (!expired && (remoteRuntime?.reservedSessions || 0) > 0) await pause(25);
      if (expired) return 1;
      await db.terminate();
      return expired ? 1 : 0;
    };
    return await Promise.race([drain(), deadline]);
  } catch { return 1; }
  finally { clearTimeout(timer); }
}
