// A reported path is diagnostic metadata, never authority to read its resource.
// Keep service origin and syntax checks shared by collection and log correlation.
export function myscRequestPath(value) {
  if (typeof value !== 'string' || value.length > 4000) return null;
  if (!value.startsWith('/api/v1/') && !value.startsWith('https://myscube.myscguard.app/api/v1/')) return null;
  const rawPath = value.replace('https://myscube.myscguard.app', '').split(/[?#]/, 1)[0];
  if (rawPath.length > 250 || !/^\/api\/v1\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(rawPath)) return null;
  try {
    const url = new URL(value, 'https://myscube.myscguard.app');
    return url.origin === 'https://myscube.myscguard.app' && url.pathname === rawPath ? rawPath : null;
  } catch { return null; }
}
