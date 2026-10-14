// 첨부 텍스트 캐시와 사용 권한(grant). 스펙 10.2·10.3절.
// - 키 접두어는 review: 다. OAuth 라이브러리가 같은 KV 에서 grant:·token:·client: 를 쓰고
//   grant:<userId>: 접두어로 로그인 목록을 조회하므로 그 이름을 피한다.
// - 텍스트는 내용 해시로 저장해 사용자끼리 공유하되, 꺼내 쓰는 것은 그 파일을 BFF 에서 직접 받은 사용자(grant)만.
// - KV 의 만료(expirationTtl)와 별개로 값 안에도 만료 시각을 두고 읽을 때 확인한다.
export const TEXT_TTL_SECONDS = 60 * 60;
// KV 값 한도(25MB)보다 충분히 작게. 넘으면 캐시하지 않는다(그때마다 BFF 에서 다시 받는다).
export const MAX_CACHED_TEXT_BYTES = 8 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

const textKey = (sha256) => `review:text:${sha256}`;
const grantKey = (uid, sha256) => `review:grant:${uid}:${sha256}`;

export function createTextStore(kv, { now = () => Date.now() } = {}) {
  const valid = (uid, sha256) => typeof uid === 'string' && uid.length > 0 && !uid.includes(':') && SHA256.test(String(sha256));

  return {
    // BFF 에서 받은 텍스트 응답을 저장하고 이 사용자에게 grant 를 준다. 저장 여부를 돌려준다.
    async put(uid, text) {
      if (!valid(uid, text?.sha256)) throw new Error('text_store_invalid_key');
      const expiresAt = now() + TEXT_TTL_SECONDS * 1000;
      const record = JSON.stringify({ ...text, expiresAt });
      await kv.put(grantKey(uid, text.sha256), JSON.stringify({ expiresAt, kind: text.kind }), { expirationTtl: TEXT_TTL_SECONDS });
      if (new TextEncoder().encode(record).byteLength > MAX_CACHED_TEXT_BYTES) return { cached: false };
      await kv.put(textKey(text.sha256), record, { expirationTtl: TEXT_TTL_SECONDS });
      return { cached: true };
    },

    // grant 가 있는 사용자만 꺼낸다. 없거나 만료면 null(호출한 쪽이 BFF 에서 다시 받는다).
    async get(uid, sha256) {
      if (!valid(uid, sha256)) return null;
      const grant = JSON.parse((await kv.get(grantKey(uid, sha256))) || 'null');
      if (!grant || !(grant.expiresAt > now())) return null;
      const record = JSON.parse((await kv.get(textKey(sha256))) || 'null');
      if (!record || !(record.expiresAt > now()) || record.sha256 !== sha256) return null;
      const { expiresAt, ...text } = record;
      return text;
    },

    async hasGrant(uid, sha256) {
      if (!valid(uid, sha256)) return false;
      const grant = JSON.parse((await kv.get(grantKey(uid, sha256))) || 'null');
      return Boolean(grant && grant.expiresAt > now());
    },
  };
}
