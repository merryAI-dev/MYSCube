import { mkdtemp, copyFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use an explicit allowlist so credentials and local dependencies never enter the image.
const destination = await mkdtemp(join(tmpdir(), 'mysc-qa-dashboard-'));
for (const name of ['Dockerfile', 'package.json', 'package-lock.json', 'server.mjs',
  'operations.mjs', 'user-entry.mjs', 'stages.mjs', 'index.html']) {
  await copyFile(new URL(name, import.meta.url), join(destination, name));
}
await mkdir(join(destination, 'shared-qa'));
await copyFile(new URL('../qa-shared/candidate-integrity.mjs', import.meta.url),
  join(destination, 'shared-qa', 'candidate-integrity.mjs'));
console.log(destination);
