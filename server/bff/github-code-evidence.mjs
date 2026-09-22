import { createHash } from 'node:crypto';

export const REPOSITORY = 'merryAI-dev/MYSCube';
export const CODE_AREAS = Object.freeze({
  cashflow: ['server/bff/routes/jvm-weekly-api.mjs', 'server/bff/cashflow-coordinates.mjs'],
  draft: ['server/bff/routes/project-registration-drafts.mjs', 'server/bff/routes/project-info-drafts.mjs'],
  approval: ['server/bff/project-review-readiness.mjs', 'server/bff/project-review-version.mjs'],
  frontend: ['src/app/platform/api-client.ts', 'src/app/platform/observability.ts'],
});
export const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const clean = (line) => line.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]').replace(/(?:gh[pousr]_[A-Za-z0-9]+|AIza[A-Za-z0-9_-]{30,}|Bearer\s+[A-Za-z0-9._-]+)/g, '[redacted]');

async function boundedJson(response) {
  const reader = response.body.getReader();
  let size = 0;
  const chunks = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1400000) throw new Error('response_too_large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export function createGithubCodeReader({ fetchImpl = fetch, now = () => new Date().toISOString() } = {}) {
  const cache = new Map();
  return async ({ sha, area, code, signal }) => {
    if (!validSha(sha)) return { status: 'missing_revision', items: [], message: '기록에 정확한 코드 버전이 없어 해당 시점 코드를 확인할 수 없습니다.' };
    if (!Object.hasOwn(CODE_AREAS, area)) throw new Error('Unsupported source area');
    const items = await Promise.all(CODE_AREAS[area].map(async (path) => {
      const key = `${sha}:${path}`;
      let cached = cache.get(key);
      if (!cached || Date.now() - cached.at > 600000) {
        const pending = (async () => {
          const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/contents/${path}?ref=${sha}`, {
            headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
            redirect: 'error', signal: AbortSignal.timeout(8000),
          });
          if (!response.ok) return { status: response.status === 404 ? 'not_found' : [403, 429].includes(response.status) ? 'access_or_rate_limited' : 'unavailable', path, sha };
          const body = await boundedJson(response);
          if (body.type !== 'file' || body.encoding !== 'base64' || body.path !== path || body.size > 1000000) throw new Error('invalid_source');
          const source = Buffer.from(body.content, 'base64');
          const hash = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
          if (hash !== body.sha) throw new Error('source_integrity_failed');
          return { status: 'available', path, sha, blobSha: hash, source: source.toString('utf8'), fetchedAt: now() };
        })().catch(() => ({ status: 'unavailable', path, sha }));
        if (cache.size >= 64) cache.delete(cache.keys().next().value);
        cached = { at: Date.now(), pending }; cache.set(key, cached);
      }
      const value = await cached.pending;
      signal?.throwIfAborted();
      if (value.status !== 'available') { cache.delete(key); return value; }
      const lines = value.source.split('\n');
      const hits = typeof code === 'string' && /^[a-z][a-z0-9_]{2,99}$/.test(code)
        ? lines.flatMap((line, index) => line.includes(`'${code}'`) || line.includes(`"${code}"`) ? [index] : []) : [];
      const excerpts = hits.slice(0, 3).map((index) => {
        const start = Math.max(0, index - 5); const end = Math.min(lines.length, index + 7);
        return { startLine: start + 1, endLine: end, text: lines.slice(start, end).map(clean).join('\n'),
          url: `https://github.com/${REPOSITORY}/blob/${sha}/${path}#L${start + 1}-L${end}` };
      });
      const { source, ...metadata } = value;
      return { ...metadata, url: `https://github.com/${REPOSITORY}/blob/${sha}/${path}`, excerpts, matchedCode: hits.length > 0, truncated: hits.length > 3 };
    }));
    return { repository: REPOSITORY, status: items.every((item) => item.status === 'available') ? 'available' : 'partial', items,
      message: 'GitHub의 지정된 버전에서 읽었습니다. 오류 코드가 있는 경로는 원인 후보이며 실행된 분기라는 증거는 아닙니다.' };
  };
}
