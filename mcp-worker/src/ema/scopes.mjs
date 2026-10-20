export const REGISTRY_SCOPE = 'ema:registry';
export const NEWS_SCOPE = 'ema:news:read';
export const SCOPES = Object.freeze([REGISTRY_SCOPE, NEWS_SCOPE]);
export const NEWS_CONSENT_VERSION = 'news-read.v1';

export function requestedScopes(scope) {
  if (!Array.isArray(scope) || !scope.every((item) => SCOPES.includes(item))) throw new Error('unsupported_ema_scope');
  return scope.length ? [...new Set(scope)] : [REGISTRY_SCOPE];
}

export function scopedAccess(props, tokenScope) {
  const scopes = Array.isArray(tokenScope) ? tokenScope : [];
  return {
    canReadRegistry: scopes.includes(REGISTRY_SCOPE),
    canReadNews: scopes.includes(NEWS_SCOPE) && props.newsConsentVersion === NEWS_CONSENT_VERSION
      && Array.isArray(props.grantedScopes) && props.grantedScopes.includes(NEWS_SCOPE),
  };
}
