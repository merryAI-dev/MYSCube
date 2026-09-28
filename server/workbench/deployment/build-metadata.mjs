import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function releaseIdentity(env) {
  const sourceSha = env.WORKBENCH_RELEASE_SHA;
  const classification = env.WORKBENCH_BUILD_CLASS;
  if (!/^[a-f0-9]{40}$/.test(sourceSha || '')) throw new Error('A full release source SHA is required.');
  if (!['synthetic', 'production_candidate'].includes(classification)) throw new Error('An explicit build classification is required.');
  return { sourceSha, classification };
}

export async function createBuildMetadata({ env = process.env, directory = process.cwd(), runtime = process } = {}) {
  const identity = releaseIdentity(env);
  if (runtime.platform !== 'linux' || !['x64', 'arm64'].includes(runtime.arch) || !/^v24\.\d+\.\d+$/.test(runtime.version)) throw new Error('Build requires Linux and Node 24.');
  const projectId = env.VITE_WORKBENCH_AUTH_PROJECT_ID;
  const domain = env.VITE_WORKBENCH_AUTH_DOMAIN;
  const apiKey = env.VITE_WORKBENCH_AUTH_API_KEY;
  if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(projectId || '') || !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,63}$/.test(domain || '') || typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 256) throw new Error('Explicit public authentication build settings are required.');
  const demo = projectId.startsWith('demo-');
  const syntheticKey = apiKey.startsWith('synthetic-');
  if (identity.classification === 'synthetic' ? !demo || !syntheticKey : demo || syntheticKey) throw new Error('Authentication settings do not match the build classification.');
  const hash = value => createHash('sha256').update(value).digest('hex');
  return {
    schemaVersion: 1,
    ...identity,
    platform: { os: 'linux', architecture: runtime.arch === 'x64' ? 'amd64' : 'arm64' },
    nodeVersion: runtime.version,
    auth: { projectId, domain, apiKeySha256: hash(apiKey) },
    locks: { root: hash(await readFile(resolve(directory, 'package-lock.json'))), workbench: hash(await readFile(resolve(directory, 'server/workbench/package-lock.json'))) },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] === 'identity') releaseIdentity(process.env);
  else if (process.argv.length === 2) await writeFile('workbench-build.json', `${JSON.stringify(await createBuildMetadata(), null, 2)}\n`, { flag: 'wx', mode: 0o444 });
  else throw new Error('Unsupported build metadata command.');
}
