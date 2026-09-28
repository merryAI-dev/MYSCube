import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { reactPackageIdentity, REACT_RUNTIME_VERSION } from './react-compiler-packages.mjs';
import { REACT_TYPE_DEPENDENCIES } from '../../shared/workbench-react-workspace.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const require = createRequire(import.meta.url);
export const REACT_COMPILER_CACHE_LIMITS = Object.freeze({ ttlMs: 300000, entries: 32, ownerEntries: 4, bytes: 8 * 1024 * 1024 });
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);

export function snapshotReactCompilerInput(source, apis) {
  if (!Array.isArray(apis) || apis.length > 12) throw new Error('api_type_schema_invalid');
  const raw = JSON.stringify(apis);
  if (Buffer.byteLength(raw) > 256000) throw new Error('api_type_schema_invalid');
  const copied = JSON.parse(raw);
  const normalized = copied.map(api => {
    if (!api || typeof api !== 'object' || Array.isArray(api)) throw new Error('api_type_schema_invalid');
    // Registry provenance belongs to the caller, not the flattened compiler definition.
    const { id, version, responseKind, responseSchema, definitionHash, endpointHash, ...flattened } = api;
    const definition = Object.hasOwn(api, 'definition') ? api.definition : flattened;
    if (!definition || typeof definition !== 'object' || Array.isArray(definition)) throw new Error('api_type_schema_invalid');
    return { id, version, definition, responseKind: responseKind || definition.kind, responseSchema: responseSchema ?? null };
  }).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  // One immutable byte string is used for both cache identity and worker input.
  return canonical({ source, apis: normalized });
}

export function reactCompilerCacheNamespace(context) {
  if (!context || ![context.tenantId, context.actorId].every(value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value))
    || typeof context.analyticsScope?.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(context.analyticsScope.fingerprint)) return null;
  return hash(JSON.stringify([context.tenantId, context.actorId, context.analyticsScope.fingerprint]));
}

export async function reactCompilerCacheIdentity() {
  // Deployed compiler modules/packages are immutable for a process lifetime. Re-read
  // identity inputs on each lookup; a failed read must never reuse an older identity.
  const paths = ['./react-compiler.mjs', './react-compiler-worker.mjs', './react-compiler-cache.mjs', './react-typecheck.mjs', './react-compiler-packages.mjs', '../../shared/workbench-react-workspace.mjs'];
  const [packageSetHash, files, types] = await Promise.all([
    reactPackageIdentity(),
    Promise.all(paths.map(async path => [path, hash(await readFile(new URL(path, import.meta.url)))])),
    Promise.all(REACT_TYPE_DEPENDENCIES.map(async ({ name }) => [name, hash(await readFile(require.resolve(`${name}/package.json`)))])),
  ]);
  return { packageSetHash, hash: hash(canonical({ packageSetHash, runtimeVersion: REACT_RUNTIME_VERSION, files, types })) };
}

export const reactCompilerCacheKey = (input, identity) => hash(JSON.stringify([identity.hash, identity.packageSetHash, input]));

export function createCompletedReactArtifactCache({ now = () => performance.now() } = {}) {
  const entries = new Map(); let bytes = 0;
  const remove = key => { const old = entries.get(key); if (old) { bytes -= old.bytes; entries.delete(key); } };
  const prune = at => { for (const [key, entry] of entries) if (at >= entry.expiresAt) remove(key); };
  const slot = (owner, key) => `${owner}:${key}`;
  return {
    get(owner, key) {
      prune(now()); const id = slot(owner, key), entry = entries.get(id);
      if (!entry) return null;
      entries.delete(id); entries.set(id, entry);
      return JSON.parse(entry.value);
    },
    set(owner, key, artifact) {
      const at = now(); prune(at);
      const id = slot(owner, key), value = JSON.stringify(artifact), size = Buffer.byteLength(value) + Buffer.byteLength(id);
      if (size > REACT_COMPILER_CACHE_LIMITS.bytes) return;
      remove(id);
      while ([...entries.values()].filter(entry => entry.owner === owner).length >= REACT_COMPILER_CACHE_LIMITS.ownerEntries) remove([...entries].find(([, entry]) => entry.owner === owner)[0]);
      while (entries.size >= REACT_COMPILER_CACHE_LIMITS.entries || bytes + size > REACT_COMPILER_CACHE_LIMITS.bytes) remove(entries.keys().next().value);
      entries.set(id, { owner, value, bytes: size, expiresAt: at + REACT_COMPILER_CACHE_LIMITS.ttlMs }); bytes += size;
    },
  };
}
