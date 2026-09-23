import { mkdir, writeFile } from 'node:fs/promises';
import { getReactPackageSet } from '../server/workbench/react-compiler-packages.mjs';

const value = await getReactPackageSet();
const directory = new URL('../dist-workbench-runtime/packages/', import.meta.url);
await mkdir(directory, { recursive: true });
await writeFile(new URL(`${value.packageSetHash}.js`, directory), value.bundle);
const { bundle, ...manifest } = value;
await writeFile(new URL('../manifest.json', directory), `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`Prepared React package set ${value.packageSetHash}\n`);
