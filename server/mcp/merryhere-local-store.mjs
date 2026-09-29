import { mkdir, lstat, open, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function localStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const dir = await lstat(directory);
  if (!dir.isDirectory() || dir.isSymbolicLink() || (dir.mode & 0o077)) throw new Error('local_directory_permissions');
  const path = name => {
    if (!/^[a-z0-9-]+\.json$/.test(name)) throw new Error('local_file_invalid');
    return join(directory, name);
  };
  return {
    async claim(name, value) {
      let file;
      try { file = await open(path(name), 'wx', 0o600); }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      return true;
    },
    async read(name) {
      let file;
      try { file = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
      try {
        const stat = await file.stat();
        if (!stat.isFile() || (stat.mode & 0o077)) throw new Error('local_file_permissions');
        return JSON.parse(await file.readFile('utf8'));
      } finally { await file.close(); }
    },
    async write(name, value) {
      const destination = path(name), temporary = join(directory, `${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
      finally { await file.close(); }
      try { await rename(temporary, destination); }
      catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    },
  };
}
