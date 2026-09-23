import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REMOTE_RUNTIME_IMAGE, REMOTE_RENDERER_LABEL, REMOTE_RENDERER_LABEL_VALUE, REMOTE_LIMITS } from './contract.mjs';

const run = promisify(execFile);
const defaultExecute = async (args, { timeoutMs, maxBuffer }) => {
  const { stdout } = await run('docker', args, { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer, env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, windowsHide: true });
  return stdout;
};
const containerName = /^\/axr-render-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function reapExpiredRenderers({ execute = defaultExecute, now = () => Date.now() } = {}) {
  const started = Date.now(); const cutoff = now() - REMOTE_LIMITS.ttlMs - 60000;
  if (!Number.isFinite(cutoff)) throw new Error('Invalid reaper clock');
  const command = async args => {
    const remaining = 30000 - (Date.now() - started); if (remaining <= 0) throw new Error('Reaper deadline');
    return execute(args, { timeoutMs: Math.min(3000, remaining), maxBuffer: 65536 });
  };
  const raw = await command(['ps', '-aq', '--no-trunc', '--filter', `label=${REMOTE_RENDERER_LABEL}=${REMOTE_RENDERER_LABEL_VALUE}`, '--filter', 'name=^/axr-render-']);
  const ids = String(raw).trim().split(/\s+/).filter(Boolean);
  if (ids.length > 1000 || ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('Unexpected Docker container list');
  const result = { examined: 0, removed: [], skipped: 0, failures: [], truncated: ids.length > 100 };
  for (const id of ids.slice(0, 100)) {
    if (Date.now() - started >= 30000) { result.truncated = true; break; }
    result.examined++;
    try {
      const values = JSON.parse(await command(['inspect', '--type', 'container', id]));
      if (!Array.isArray(values) || values.length !== 1) throw new Error('Unexpected inspection');
      const inspected = values[0]; const created = Date.parse(inspected.Created);
      if (inspected.Id !== id || !containerName.test(inspected.Name || '') || inspected.Config?.Image !== REMOTE_RUNTIME_IMAGE
        || inspected.Config?.Labels?.[REMOTE_RENDERER_LABEL] !== REMOTE_RENDERER_LABEL_VALUE || !Number.isFinite(created) || created >= cutoff) { result.skipped++; continue; }
      await command(['rm', '-f', id]); result.removed.push(id);
    } catch { result.failures.push(id); }
  }
  return result;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  reapExpiredRenderers().then(result => { process.stdout.write(`${JSON.stringify(result)}\n`); if (result.failures.length || result.truncated) process.exitCode = 1; })
    .catch(() => { process.stderr.write('Renderer orphan cleanup could not be verified. Check the dedicated Docker host.\n'); process.exitCode = 1; });
}
