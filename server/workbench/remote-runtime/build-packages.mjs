import { writeFile } from 'node:fs/promises';
import { getReactPackageSet } from '../react-compiler-packages.mjs';
const packages = await getReactPackageSet();
await writeFile(new URL('./packages.json', import.meta.url), JSON.stringify(packages));
