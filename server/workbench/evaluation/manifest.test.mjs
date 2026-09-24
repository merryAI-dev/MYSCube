import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, link, lstat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
const readBoundary = vi.hoisted(() => ({ target: null, action: null }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original();
  return { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (readBoundary.action && String(args[0]).endsWith(readBoundary.target)) {
      const read = handle.read.bind(handle), action = readBoundary.action; readBoundary.action = null;
      handle.read = async (...readArgs) => { const result = await read(...readArgs); await action(); return result; };
    }
    return handle;
  } };
});
import {
  EVALUATION_REQUIRED_FILES, EVALUATION_SOURCE_ROOTS, createEvaluationManifest, evaluationManifestDigest,
  inspectEvaluationRenderer, readEvaluationManifest, validateEvaluationManifest, verifyEvaluationManifest, writeEvaluationManifest,
} from './manifest.mjs';

const sha = 'a'.repeat(40), archive = 'b'.repeat(64), image = `sha256:${'c'.repeat(64)}`;
const identity = { id: image, revision: sha, classification: 'synthetic', os: 'linux', architecture: 'amd64' };
const oracle = 'server/workbench/evaluation/acceptance-cases.mjs';
const fixturePath = 'server/workbench/cashflow-inflow-fixture.mjs';
const directories = [];
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'myscube-eval-fixture-')); directories.push(directory);
  for (const root of EVALUATION_SOURCE_ROOTS) await mkdir(join(directory, root), { recursive: true });
  for (const file of [...EVALUATION_REQUIRED_FILES, fixturePath, 'shared/workbench-react-workspace.mjs', 'server/bff/cashflow-coordinates.mjs', 'policies/rbac.json']) {
    await mkdir(dirname(join(directory, file)), { recursive: true }); await writeFile(join(directory, file), file.endsWith('.json') ? '{}' : `export const fixture = ${JSON.stringify(file)};\n`);
  }
  const inspectImage = vi.fn(async () => ({ ...identity }));
  return { directory, sourceSha: sha, archiveSha256: archive, rendererImageId: image, classification: 'synthetic', platform: { os: 'linux', architecture: 'amd64' }, oraclePaths: [oracle], fixturePaths: [oracle, fixturePath], inspectImage };
}
function verifyInput(input, recorded) {
  return { directory: input.directory, manifest: recorded.manifest, expectedManifestSha256: recorded.manifestSha256, expectedSourceSha: sha, expectedArchiveSha256: archive, expectedRendererImageId: image, inspectImage: input.inspectImage };
}
const clone = (value) => JSON.parse(JSON.stringify(value));
afterEach(async () => { readBoundary.action = null; readBoundary.target = null; await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe('evaluation source and immutable renderer manifest', () => {
  it('records actual source/oracle/fixture bytes, freezes the result and verifies them again', async () => {
    const input = await fixture(), result = await createEvaluationManifest(input);
    const record = result.manifest.source.files.find((item) => item.path === oracle);
    expect(record.sha256).toBe(createHash('sha256').update(await readFile(join(input.directory, oracle))).digest('hex'));
    expect(result.manifest.oracles).toEqual([record]);
    expect(result.manifest.fixtures.map((item) => item.path)).toEqual([fixturePath, oracle].sort());
    expect(Object.isFrozen(result.manifest.renderer)).toBe(true); expect(Object.isFrozen(record)).toBe(true);
    const checked = await verifyEvaluationManifest(verifyInput(input, result));
    expect(checked.rendererImageId).toBe(image); expect(checked.manifestSha256).toBe(result.manifestSha256);
    expect(input.inspectImage).toHaveBeenCalledTimes(2); expect(input.inspectImage).toHaveBeenCalledWith(image);
  });
  it('writes canonical manifest bytes matching ordinary SHA256 and refuses overwriting output', async () => {
    const input = await fixture(), result = await createEvaluationManifest(input), file = join(input.directory, 'evaluation-manifest.json');
    expect(await writeEvaluationManifest({ file, manifest: result.manifest })).toEqual({ manifestSha256: result.manifestSha256 });
    const bytes = await readFile(file); expect(bytes.at(-1)).toBe(10);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(result.manifestSha256);
    expect((await lstat(file)).mode & 0o777).toBe(0o600);
    expect(await readEvaluationManifest({ file, expectedManifestSha256: result.manifestSha256 })).toEqual(result.manifest);
    await expect(writeEvaluationManifest({ file, manifest: result.manifest })).rejects.toMatchObject({ code: 'EEXIST' });
  });
  it.each(['source', 'oracle', 'fixture', 'extra', 'missing'])('rejects %s drift when checking a recorded manifest', async (kind) => {
    const input = await fixture(), result = await createEvaluationManifest(input);
    if (kind === 'missing') await rm(join(input.directory, 'package-lock.json'));
    else await writeFile(join(input.directory, { source: 'server/bff/cashflow-coordinates.mjs', oracle, fixture: fixturePath, extra: 'shared/unreviewed.mjs' }[kind]), 'export const changed = true;');
    await expect(verifyEvaluationManifest(verifyInput(input, result))).rejects.toThrow();
  });
  it.each(['rewrite', 'replace', 'extra'])('rejects a %s during immutable image inspection, with sabotage confirmed', async (kind) => {
    const input = await fixture(); let sabotaged = false;
    input.inspectImage = async () => {
      const file = join(input.directory, oracle);
      if (kind === 'replace') { await rename(file, `${file}.old`); await writeFile(file, 'replacement'); }
      else await writeFile(kind === 'extra' ? join(input.directory, 'shared/added.mjs') : file, 'changed');
      sabotaged = true; return { ...identity };
    };
    await expect(createEvaluationManifest(input)).rejects.toThrow(/changed/); expect(sabotaged).toBe(true);
  });
  it.each(['truncate', 'rewrite', 'replace'])('rejects %s at the actual opened-file read boundary', async (kind) => {
    const input = await fixture(); let sabotaged = false;
    const file = join(input.directory, oracle), original = await readFile(file);
    readBoundary.target = oracle;
    readBoundary.action = async () => {
      if (kind === 'replace') { await rename(file, `${file}.old`); await writeFile(file, original); }
      else await writeFile(file, kind === 'truncate' ? '' : Buffer.alloc(original.length, 120));
      sabotaged = true;
    };
    await expect(createEvaluationManifest(input)).rejects.toThrow(/changed/);
    expect(sabotaged).toBe(true); expect(input.inspectImage).not.toHaveBeenCalled();
  });
  it.each(['source', 'archive', 'manifest', 'image', 'missing'])('requires externally trusted matching %s pins', async (kind) => {
    const input = await fixture(), result = await createEvaluationManifest(input), verification = verifyInput(input, result);
    const fields = { source: 'expectedSourceSha', archive: 'expectedArchiveSha256', manifest: 'expectedManifestSha256', image: 'expectedRendererImageId', missing: 'expectedManifestSha256' };
    verification[fields[kind]] = kind === 'missing' ? undefined : kind === 'source' ? 'f'.repeat(40) : kind === 'image' ? `sha256:${'f'.repeat(64)}` : 'f'.repeat(64);
    await expect(verifyEvaluationManifest(verification)).rejects.toThrow(); expect(input.inspectImage).toHaveBeenCalledTimes(1);
  });
  it.each(['id', 'revision', 'classification', 'os', 'architecture', 'unknown'])('rejects mismatched or unexpected renderer %s', async (field) => {
    const input = await fixture();
    input.inspectImage = async () => ({ ...identity, [field]: { id: `sha256:${'e'.repeat(64)}`, revision: 'e'.repeat(40), classification: 'production_candidate', os: 'windows', architecture: 'arm64', unknown: 'secret' }[field] });
    await expect(createEvaluationManifest(input)).rejects.toThrow();
  });
  it.each(['tag', 'escaped', 'hidden', 'output', 'outside'])('rejects %s supplied paths or identities before using them', async (kind) => {
    const input = await fixture();
    if (kind === 'tag') input.rendererImageId = 'myscube-axr-renderer:latest';
    else input.oraclePaths = [{ escaped: 'server/workbench/evaluation/../react-compiler.mjs', hidden: 'server/workbench/evaluation/.env', output: 'server/workbench/evaluation/report.json', outside: 'server/bff/cashflow-coordinates.mjs' }[kind]];
    await expect(createEvaluationManifest(input)).rejects.toThrow(); expect(input.inspectImage).not.toHaveBeenCalled();
  });
  it.each(['root', 'directory', 'file', 'hardlink'])('rejects source %s indirection', async (kind) => {
    const input = await fixture();
    if (kind === 'root') { const alias = `${input.directory}-alias`; directories.push(alias); await symlink(input.directory, alias); input.directory = alias; }
    if (kind === 'directory') { await rename(join(input.directory, 'shared'), join(input.directory, 'moved')); await symlink(join(input.directory, 'moved'), join(input.directory, 'shared')); }
    if (kind === 'file') { const target = join(input.directory, oracle); await rename(target, `${target}.old`); await symlink(`${target}.old`, target); }
    if (kind === 'hardlink') await link(join(input.directory, oracle), join(input.directory, 'linked-file'));
    await expect(createEvaluationManifest(input)).rejects.toThrow(); expect(input.inspectImage).not.toHaveBeenCalled();
  });
  it('does not read or inventory env files, caches, dependencies or evidence output', async () => {
    const input = await fixture();
    for (const excluded of ['.env', 'server/workbench/.env', 'server/workbench/node_modules/private/index.mjs', 'server/workbench/nodecache/a.mjs', 'server/workbench/results/a.mjs', 'server/workbench/evaluation/report.json']) {
      await mkdir(dirname(join(input.directory, excluded)), { recursive: true }); await writeFile(join(input.directory, excluded), 'excluded-private-fixture');
    }
    const result = await createEvaluationManifest(input);
    expect(JSON.stringify(result)).not.toContain('excluded-private-fixture');
    expect(result.manifest.source.files.some((item) => /env|node_modules|nodecache|results|report\.json/.test(item.path))).toBe(false);
    await writeFile(join(input.directory, '.env'), 'changed-but-excluded');
    await expect(verifyEvaluationManifest(verifyInput(input, result))).resolves.toMatchObject({ rendererImageId: image });
  });
  it.each(['unknown', 'version', 'number-hash', 'escape', 'duplicate', 'missing-required'])('strictly rejects invalid %s manifest fields', async (kind) => {
    const result = await createEvaluationManifest(await fixture()), manifest = clone(result.manifest);
    if (kind === 'unknown') manifest.source.unexpected = true;
    if (kind === 'version') manifest.schemaVersion = 2;
    if (kind === 'number-hash') manifest.source.files[0].sha256 = 1;
    if (kind === 'escape') manifest.fixtures[0].path = '../outside.mjs';
    if (kind === 'duplicate') manifest.source.files.push(manifest.source.files.at(-1));
    if (kind === 'missing-required') manifest.source.files = manifest.source.files.filter((item) => item.path !== 'package-lock.json');
    expect(() => validateEvaluationManifest(manifest)).toThrow();
  });
  it('rejects changed output bytes even if JSON parses to the same manifest', async () => {
    const result = await createEvaluationManifest(await fixture()), directory = await mkdtemp(join(tmpdir(), 'myscube-eval-output-')); directories.push(directory);
    const file = join(directory, 'manifest.json'); await writeEvaluationManifest({ file, manifest: result.manifest });
    await writeFile(file, JSON.stringify(result.manifest, null, 2));
    await expect(readEvaluationManifest({ file, expectedManifestSha256: result.manifestSha256 })).rejects.toThrow(/bytes/);
    await expect(readEvaluationManifest({ file })).rejects.toThrow(/trusted/);
  });
  it('does not let a caller change renderer metadata after inspection while source is being rechecked', async () => {
    const input = await fixture(), returned = { ...identity };
    input.inspectImage = async () => { setTimeout(() => { returned.classification = 'production_candidate'; }, 0); return returned; };
    const result = await createEvaluationManifest(input); expect(result.manifest.renderer.classification).toBe('synthetic');
  });
});

describe('read-only local Docker identity projection', () => {
  it('uses exact image ID, explicit local daemon and empty config, bounded process, with no credentials or Env projection', async () => {
    let temporary;
    const execute = vi.fn(async (command, args, options) => {
      expect(command).toBe('docker'); expect(args.slice(0, 3)).toEqual(['--host', 'unix:///var/run/docker.sock', '--config']);
      temporary = args[3]; expect(await readdir(temporary)).toEqual([]); expect(args.at(-1)).toBe(image);
      expect(args.slice(4, 7)).toEqual(['image', 'inspect', '--format']); expect(args[7]).not.toContain('.Config.Env');
      expect(options).toEqual({ env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }, timeout: 10000, maxBuffer: 65536 });
      return { stdout: JSON.stringify(identity) };
    });
    expect(await inspectEvaluationRenderer({ imageId: image, execute })).toEqual(identity);
    await expect(lstat(temporary)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['tag', 'malformed', 'missing', 'extra', 'wrong-id', 'oversize', 'stderr'])('refuses %s without exposing Docker stderr', async (kind) => {
    const execute = vi.fn(async () => {
      if (kind === 'stderr') throw new Error('credential-private-fixture');
      return { stdout: { malformed: '{', missing: JSON.stringify({ id: image }), extra: JSON.stringify({ ...identity, Env: ['private-fixture'] }), 'wrong-id': JSON.stringify({ ...identity, id: `sha256:${'f'.repeat(64)}` }), oversize: ' '.repeat(65537) }[kind] };
    });
    const error = await inspectEvaluationRenderer({ imageId: kind === 'tag' ? 'renderer:latest' : image, execute }).catch((value) => value);
    expect(error).toBeInstanceOf(Error); expect(error.message).not.toContain('credential-private-fixture');
    if (kind === 'tag') expect(execute).not.toHaveBeenCalled();
  });
});
