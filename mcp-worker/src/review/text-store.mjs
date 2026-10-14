import { hashId } from './contract.mjs';

// 첨부 텍스트 캐시와 사용 권한(grant). 스펙 10.2·10.3절.
// - 키 접두어는 review: 다. OAuth 라이브러리가 같은 KV 에서 grant:·token:·client: 를 쓰고
//   grant:<userId>: 접두어로 로그인 목록을 조회하므로 그 이름을 피한다.
// - 텍스트는 내용 해시로 저장해 사용자끼리 공유한다.
// - 꺼내 쓰는 권한(grant)은 "사용자 + 해시 + 범위(검토 대상·서류 종류)"에 묶고, 받았을 때의 첨부 경로를 값에 둔다.
//   다른 대상·서류의 textRef 는 쓰지 못한다(코드 리뷰 #1). 판정 단계는 현재 첨부 경로를 넘겨,
//   작성자가 첨부를 바꿨으면(경로가 다르면) 캐시를 쓰지 않는다. 쪽 넘김은 경로 확인 없이 캐시를 쓴다(2차 리뷰 #2).
// - KV 의 만료(expirationTtl)와 별개로 값 안에도 만료 시각을 두고 읽을 때 확인한다.
export const TEXT_TTL_SECONDS = 60 * 60;
// KV 값 한도(25MB) 안. BFF 텍스트 응답 상한(8MB)보다 넉넉히 커야 받은 텍스트를 캐시할 수 있다(코드 리뷰 #9).
export const MAX_CACHED_TEXT_BYTES = 20 * 1024 * 1024;
const SHA256 = /^[0-9a-f]{64}$/u;

const textKey = (sha256) => `review:text:${sha256}`;

// scope: { subjectKey, kind, path? }. 키는 대상·종류로만 만든다.
async function grantKey(uid, sha256, scope) {
  if (!scope?.subjectKey || !scope?.kind) throw new Error('text_store_invalid_scope');
  const scopeId = await hashId('s', { subjectKey: scope.subjectKey, kind: scope.kind });
  return `review:grant:${uid}:${sha256}:${scopeId}`;
}

export function createTextStore(kv, { now = () => Date.now() } = {}) {
  const valid = (uid, sha256) => typeof uid === 'string' && uid.length > 0 && !uid.includes(':') && SHA256.test(String(sha256));

  return {
    // BFF 에서 받은 텍스트 응답을 저장하고 이 사용자에게 그 범위의 grant 를 준다. 저장 여부를 돌려준다.
    async put(uid, text, scope) {
      if (!valid(uid, text?.sha256)) throw new Error('text_store_invalid_key');
      if (!scope?.path) throw new Error('text_store_invalid_scope');
      const key = await grantKey(uid, text.sha256, scope);
      const expiresAt = now() + TEXT_TTL_SECONDS * 1000;
      await kv.put(key, JSON.stringify({ expiresAt, path: scope.path }), { expirationTtl: TEXT_TTL_SECONDS });
      const record = JSON.stringify({ ...text, expiresAt });
      if (new TextEncoder().encode(record).byteLength > MAX_CACHED_TEXT_BYTES) return { cached: false };
      await kv.put(textKey(text.sha256), record, { expirationTtl: TEXT_TTL_SECONDS });
      return { cached: true };
    },

    // 같은 범위의 grant 가 있는 사용자만 꺼낸다. scope.path 를 주면 받았을 때의 첨부 경로와 같아야 한다.
    // 없거나 만료·불일치면 null(호출한 쪽이 BFF 에서 다시 받는다).
    async get(uid, sha256, scope) {
      if (!valid(uid, sha256) || !scope?.subjectKey || !scope?.kind) return null;
      const grant = JSON.parse((await kv.get(await grantKey(uid, sha256, scope))) || 'null');
      if (!grant || !(grant.expiresAt > now())) return null;
      if (scope.path && grant.path !== scope.path) return null;
      const record = JSON.parse((await kv.get(textKey(sha256))) || 'null');
      // 본문은 내용 해시로만 공유한다. 같은 파일을 다른 서류 종류로 써도 덮어쓰지 않게 종류는 grant 가 구분한다(2차 리뷰 #7).
      if (!record || !(record.expiresAt > now()) || record.sha256 !== sha256) return null;
      const { expiresAt, ...text } = record;
      return { ...text, kind: scope.kind };
    },
  };
}
