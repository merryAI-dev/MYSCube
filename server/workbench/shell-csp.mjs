export function workbenchShellCsp({ reactRuntimeOrigin = '' } = {}) {
  if (reactRuntimeOrigin) {
    const url = new URL(reactRuntimeOrigin);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== reactRuntimeOrigin) throw new Error('Invalid preview origin.');
  }
  return `default-src 'self'; script-src 'self' https://apis.google.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://identitytoolkit.googleapis.com https://securetoken.googleapis.com; frame-src 'self' https://*.firebaseapp.com ${reactRuntimeOrigin}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
}
