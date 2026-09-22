import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createGithubCodeReader } from './github-code-evidence.mjs';
const sha = 'a'.repeat(40);
const response = (path, source = "throw createHttpError(409, '확인 필요', 'project_draft_conflict');") => new Response(JSON.stringify({ type: 'file', encoding: 'base64', path, size: Buffer.byteLength(source), content: Buffer.from(source).toString('base64'),
  sha: createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex') }));
describe('GitHub exact-version evidence', () => {
  it('never substitutes main; validates blob, finds exact literal and reuses immutable cache', async () => {
    const fetchImpl = vi.fn(async (url) => response(new URL(url).pathname.split('/contents/')[1]));
    const read = createGithubCodeReader({ fetchImpl });
    const result = await read({ sha, area: 'draft', code: 'project_draft_conflict' });
    expect(result.items.every((item) => item.matchedCode && item.url.includes(sha))).toBe(true);
    expect(result.items[0].excerpts[0].text).toContain('확인 필요');
    await read({ sha, area: 'draft', code: 'other_code' }); expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect((await read({ sha: null, area: 'draft' })).status).toBe('missing_revision');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('reports unavailable/restricted/missing sources and refuses unsafe areas', async () => {
    for (const status of [403, 429, 404, 500]) {
      const read = createGithubCodeReader({ fetchImpl: async () => new Response('{}', { status }) });
      expect((await read({ sha, area: 'cashflow' })).status).toBe('partial');
    }
    await expect(createGithubCodeReader()({ sha, area: '../../.env' })).rejects.toThrow('Unsupported');
  });
  it('rejects wrong blob hashes and never returns secrets or email in excerpts', async () => {
    const read = createGithubCodeReader({ fetchImpl: async (url) => response(new URL(url).pathname.split('/contents/')[1], "'project_draft_conflict'; 'person@example.com'; 'Bearer secret.token';") });
    const result = await read({ sha, area: 'draft', code: 'project_draft_conflict' });
    expect(JSON.stringify(result)).not.toContain('person@example.com'); expect(JSON.stringify(result)).not.toContain('secret.token');
    const bad = createGithubCodeReader({ fetchImpl: async () => new Response(JSON.stringify({ type: 'file', encoding: 'base64', path: 'server/bff/routes/project-registration-drafts.mjs', size: 1, content: 'YQ==', sha: 'bad' })) });
    expect((await bad({ sha, area: 'draft' })).items[0].status).toBe('unavailable');
  });
});
