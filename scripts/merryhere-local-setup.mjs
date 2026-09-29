import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import { localStore } from '../server/mcp/merryhere-local-store.mjs';
import { startLocalRoomSetup } from '../server/mcp/merryhere-local-setup.mjs';

const run = promisify(execFile);
const store = await localStore(join(homedir(), '.myscube-merryhere'));
async function startRunner() {
  if (process.platform !== 'darwin') throw new Error('macos_required');
  const runner = join(dirname(fileURLToPath(import.meta.url)), 'merryhere-local.mjs');
  await access(runner);
  const label = 'kr.mysc.merryhere-local', domain = `gui/${process.getuid()}`;
  const directory = join(homedir(), 'Library', 'LaunchAgents'), path = join(directory, `${label}.plist`);
  const xml = value => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char]));
  await mkdir(directory, { recursive: true });
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(runner)}</string><string>run</string></array><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string></dict></plist>`, { mode: 0o600 });
  await run('launchctl', ['bootout', `${domain}/${label}`]).catch(() => {});
  await run('launchctl', ['bootstrap', domain, path]);
  for (let attempt = 0; attempt < 12; attempt++) {
    const { stdout } = await run('launchctl', ['print', `${domain}/${label}`]);
    if (/state = running/.test(stdout)) return;
    await sleep(250);
  }
  throw new Error('runner_not_running');
}
const setup = await startLocalRoomSetup({ store, startRunner });
console.log(JSON.stringify({ setupUrl: setup.url }));
setTimeout(() => setup.server.close(() => process.exit(0)), 30 * 60000).unref();
