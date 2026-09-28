import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const exec = promisify(execFile);
const helper = resolve('server/workbench/host-runtime/bootstrap-apt-policy.sh');
const policy = (source: string, otherSource = 'mirror+file:/etc/apt/mirrors/debian.list') => `nginx:\n  Installed: (none)\n  Candidate: 1.22.1-9+deb12u10\n  Version table:\n     1.22.1-9+deb12u10 500\n        500 ${source} bookworm-security/main amd64 Packages\n     1.22.1-9+deb12u9 500\n        500 ${otherSource} bookworm/main amd64 Packages\n`;
const check = (kind: string, text: string, mirrors = 'https://deb.debian.org/debian-security') => exec('bash', ['-c', 'set -euo pipefail; source "$1"; fixture_mirrors=$4; bootstrap_read_approved_mirror() { case "$1" in /etc/apt/mirrors/debian.list|/etc/apt/mirrors/debian-security.list) bootstrap_validate_mirror_text "$fixture_mirrors" ;; *) return 1 ;; esac; }; bootstrap_assert_package_origin "$2" "$3"', 'test', helper, kind, text, mirrors]);

describe('bootstrap selected apt origins with GCE Debian mirror lists', () => {
  it('accepts the actual Debian 12 GCE selected security mirror candidate', async () => {
    await expect(check('debian', policy('mirror+file:/etc/apt/mirrors/debian-security.list'))).resolves.toBeDefined();
    await expect(check('debian', policy('https://deb.debian.org/debian-security'))).resolves.toBeDefined();
  });
  it('rejects an unapproved selected candidate even when an older version is official', async () => {
    await expect(check('debian', policy('https://evil.example/debian', 'https://deb.debian.org/debian'))).rejects.toMatchObject({ code: 1 });
    await expect(check('debian', policy('mirror+file:/tmp/untrusted.list'))).rejects.toMatchObject({ code: 1 });
  });
  it.each(['https://deb.debian.org.evil.example/debian', 'https://user@deb.debian.org/debian', 'https://deb.debian.org/debian?x=1', 'https://deb.debian.org/debian#x', 'https://deb.debian.org/debian/../other', 'http://deb.debian.org/debian', 'https://deb.debian.org/debian\nhttps://evil.example/debian', '# empty mirror list'])('rejects unsafe or mixed mirror lists: %s', async mirrors => {
    await expect(check('debian', policy('mirror+file:/etc/apt/mirrors/debian-security.list'), mirrors)).rejects.toMatchObject({ code: 1 });
  });
  it('requires root ownership, one hard link, bounded size and no group/world write', async () => {
    const call = (metadata: string) => exec('bash', ['-c', 'set -euo pipefail; source "$1"; bootstrap_validate_mirror_stat "$2"', 'test', helper, metadata]);
    await expect(call('0 644 1 39 1:2:time')).resolves.toBeDefined();
    for (const metadata of ['501 644 1 39', '0 664 1 39', '0 646 1 39', '0 644 2 39', '0 644 1 4097', '0 644 1 0']) await expect(call(metadata)).rejects.toMatchObject({ code: 1 });
  });
  it('does not allow an installed status line to prove a trusted package origin', async () => {
    await expect(check('debian', 'nginx:\n  Installed: 1.0\n  Candidate: 1.0\n  Version table:\n *** 1.0 100\n        100 /var/lib/dpkg/status\n')).rejects.toMatchObject({ code: 1 });
  });
  it('handles large Docker policies without grep-q SIGPIPE under pipefail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'axr-apt-policy-'));
    try {
      const fixture = join(directory, 'policy');
      const text = 'docker-ce:\n  Installed: (none)\n  Candidate: 5:29.3.0\n  Version table:\n     5:29.3.0 500\n        500 https://download.docker.com/linux/debian bookworm/stable amd64 Packages\n' + Array.from({ length: 5000 }, (_, index) => `     5:28.${index} 500\n        500 https://download.docker.com/linux/debian bookworm/stable amd64 Packages\n`).join('');
      await writeFile(fixture, text);
      await expect(exec('bash', ['-c', 'set -euo pipefail; source "$1"; docker_policy=$(cat -- "$2"); bootstrap_assert_package_origin docker "$docker_policy"', 'test', helper, fixture])).resolves.toBeDefined();
      await expect(exec('bash', ['-c', 'set -euo pipefail; cat -- "$1" | grep -Fq https://download.docker.com/linux/debian', 'test', fixture])).rejects.toBeDefined();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
