import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const revisions = [
  '1c6d08176c3c5e9d05f2a9ef05d2cb01bea04d14',
  '336fe9b2e87de39e8c07eafe843d18e05a7aca2e',
  'd9e17d14d971e33d59a9832faf97020a32bac08c',
];
const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const revisionSchema = { type: 'string', enum: revisions };
const pathSchema = { type: 'string', minLength: 1, maxLength: 300 };
const invalid = () => {
  throw new Error('invalid_code_request');
};
function strict(args, keys) {
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).some((key) => !keys.includes(key))
  )
    invalid();
}

// Build-time artifacts only. The model cannot request Git/network/filesystem paths.
export async function createCodeTools({
  snapshotDir = './code-snapshots',
} = {}) {
  const directory = resolve(snapshotDir);
  const manifestPath = join(directory, 'manifest.json');
  if (!(await lstat(manifestPath)).isFile())
    throw new Error('invalid_code_manifest');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    manifest.schema_version !== 1 ||
    !Array.isArray(manifest.sources) ||
    !manifest.sources.length ||
    manifest.sources.length > 30
  )
    throw new Error('invalid_code_manifest');
  const sources = [];
  const identities = new Set();
  for (const entry of manifest.sources) {
    if (
      !revisions.includes(entry.revision) ||
      typeof entry.path !== 'string' ||
      (!/^(src\/app\/|server\/bff\/|server\/jvm-weekly-api\/src\/main\/java\/)[A-Za-z0-9_./-]+$/.test(
        entry.path
      ) &&
        ![
          'api/bff.js',
          'scripts/deploy-vercel-production-candidate.mjs',
        ].includes(entry.path)) ||
      entry.path.split('/').some((part) => part === '..' || part === '.') ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.artifact !== `${entry.sha256}.txt` ||
      !Number.isSafeInteger(entry.line_count) ||
      entry.line_count < 1
    )
      throw new Error('invalid_code_manifest');
    const identity = `${entry.revision}:${entry.path}`;
    if (identities.has(identity)) throw new Error('invalid_code_manifest');
    identities.add(identity);
    const artifact = join(directory, entry.artifact);
    const info = await lstat(artifact);
    if (!info.isFile() || info.size > 4000000)
      throw new Error('invalid_code_artifact');
    const bytes = await readFile(artifact);
    if (digest(bytes) !== entry.sha256)
      throw new Error('code_artifact_hash_mismatch');
    const content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const lines = content.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (lines.length !== entry.line_count)
      throw new Error('code_artifact_line_count_mismatch');
    sources.push({
      revision: entry.revision,
      path: entry.path,
      sha256: entry.sha256,
      line_count: entry.line_count,
      lines,
    });
  }
  function matching(revision, path) {
    if (revision != null && !revisions.includes(revision)) invalid();
    if (path != null && (typeof path !== 'string' || path.length > 300))
      invalid();
    const selected = sources.filter(
      (source) =>
        (revision == null || source.revision === revision) &&
        (path == null || source.path === path)
    );
    if (!selected.length) invalid();
    return selected;
  }
  function tool(name, description, parameters, run) {
    return {
      description,
      parameters,
      async execute(args, { signal } = {}) {
        signal?.throwIfAborted();
        const observed_at = new Date().toISOString();
        try {
          const result = run(args);
          const content_hash = digest(
            JSON.stringify({ source: name, ...result })
          );
          return {
            evidence_id: `ev_${content_hash}`,
            content_hash,
            observed_at,
            source: name,
            status: 'available',
            ...result,
            cause_status: 'not_established',
          };
        } catch {
          return {
            evidence_id: `ev_${digest(JSON.stringify({ name, observed_at }))}`,
            observed_at,
            source: name,
            status: 'unavailable',
            error_code: 'invalid_code_request',
            rows: [],
            coverage: { complete: false },
            cause_status: 'not_established',
          };
        }
      },
    };
  }
  const metadata = (source) => ({
    revision: source.revision,
    path: source.path,
    sha256: source.sha256,
    line_count: source.line_count,
  });
  return {
    list_code_snapshots: tool(
      'list_code_snapshots',
      'List immutable allowlisted source artifacts at exact Git revisions. Catalog is partial; deployment metadata and incident-time correlation must be verified separately. Code alone does not prove an executed branch or root cause.',
      objectSchema({ revision: revisionSchema }),
      (args) => {
        strict(args, ['revision']);
        return {
          rows: matching(args.revision).map(metadata),
          coverage: {
            complete: true,
            scope: 'allowlisted_artifact_catalog',
            whole_repository: false,
          },
        };
      }
    ),
    search_code: tool(
      'search_code',
      'Find literal text in pinned source snapshots. Case-sensitive substring search; bounded matches with exact source lines, never execution evidence.',
      objectSchema(
        {
          revision: revisionSchema,
          path: pathSchema,
          query: { type: 'string', minLength: 1, maxLength: 120 },
          limit: { type: 'integer', minimum: 1, maximum: 50 },
        },
        ['revision', 'query']
      ),
      (args) => {
        strict(args, ['revision', 'path', 'query', 'limit']);
        const limit = args.limit ?? 30;
        if (
          typeof args.query !== 'string' ||
          !args.query.length ||
          args.query.length > 120 ||
          /[\r\n]/.test(args.query) ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          !args.revision
        )
          invalid();
        const rows = [],
          selected = matching(args.revision, args.path);
        let matches = 0;
        for (const source of selected)
          for (let index = 0; index < source.lines.length; index++) {
            if (!source.lines[index].includes(args.query)) continue;
            matches++;
            if (rows.length < limit)
              rows.push({
                ...metadata(source),
                line: index + 1,
                text: source.lines[index].slice(0, 1000),
                line_truncated: source.lines[index].length > 1000,
              });
          }
        return {
          rows,
          coverage: {
            complete: matches <= limit,
            truncated: matches > limit,
            total_matches: matches,
            searched_files: selected.length,
            limit,
            scope: 'literal_static_match',
            executed_branch: false,
          },
        };
      }
    ),
    read_code: tool(
      'read_code',
      'Read up to 160 lines from one exact allowlisted revision/path. Hash identifies the full immutable file; returned range may be truncated.',
      objectSchema(
        {
          revision: revisionSchema,
          path: pathSchema,
          start_line: { type: 'integer', minimum: 1 },
          end_line: { type: 'integer', minimum: 1 },
        },
        ['revision', 'path', 'start_line', 'end_line']
      ),
      (args) => {
        strict(args, ['revision', 'path', 'start_line', 'end_line']);
        if (
          !args.revision ||
          !args.path ||
          !Number.isSafeInteger(args.start_line) ||
          !Number.isSafeInteger(args.end_line) ||
          args.start_line < 1 ||
          args.end_line < args.start_line ||
          args.end_line - args.start_line >= 160
        )
          invalid();
        const source = matching(args.revision, args.path)[0];
        if (
          args.start_line > source.line_count ||
          args.end_line > source.line_count
        )
          invalid();
        const rows = source.lines
          .slice(args.start_line - 1, args.end_line)
          .map((text, index) => ({
            line: args.start_line + index,
            text: text.slice(0, 1000),
            line_truncated: text.length > 1000,
          }));
        return {
          ...metadata(source),
          rows,
          coverage: {
            complete: rows.every((row) => !row.line_truncated),
            scope: 'requested_source_range',
            start_line: args.start_line,
            end_line: args.end_line,
            whole_file:
              args.start_line === 1 && args.end_line === source.line_count,
            executed_branch: false,
          },
        };
      }
    ),
  };
}
