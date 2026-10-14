import { mkdtemp, copyFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The live case worker gets incident evidence through authorized tools at runtime.
// Historical operator observations are deliberately excluded from its image.
const destination = await mkdtemp(join(tmpdir(), 'mysc-qa-investigator-'));
const directory = new URL('./', import.meta.url);
const runtimeFiles = (await readdir(directory)).filter(name => name.endsWith('.mjs') &&
  !name.endsWith('.test.mjs') && name !== 'build-context.mjs');
for (const name of [...runtimeFiles, 'Dockerfile.case', 'package.json', 'package-lock.json', 'sheet-label-contract.json']) {
  await copyFile(new URL(name, directory), join(destination, name === 'Dockerfile.case' ? 'Dockerfile' : name));
}
for (const [folder, names] of Object.entries({
  'bff': ['cashflow-close-hash.mjs', 'utils.mjs'],
  'qa-shared': ['candidate-integrity.mjs', 'case-authority-client.mjs'],
})) {
  const target = folder === 'bff' ? 'shared-bff' : 'shared-qa';
  await mkdir(join(destination, target));
  for (const name of names) await copyFile(new URL(`../${folder}/${name}`, directory), join(destination, target, name));
}
console.log(destination);
