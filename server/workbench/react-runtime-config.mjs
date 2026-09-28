import { getDomain } from 'tldts';

export function resolveReactRuntime(env) {
  if (!env.WORKBENCH_REACT_RUNTIME_URL) return null;
  const runtime = new URL(env.WORKBENCH_REACT_RUNTIME_URL);
  const parent = new URL(env.WORKBENCH_APP_ORIGIN);
  if (runtime.username || runtime.password || runtime.search || runtime.hash || parent.origin !== env.WORKBENCH_APP_ORIGIN || runtime.pathname !== '/runtime') throw new Error('React runtime URL and parent origin must be explicit and credential-free.');
  const loopback = (url) => ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  const local = env.WORKBENCH_AUTH_MODE === 'emulator' && env.WORKBENCH_PROJECT_ID?.startsWith('demo-') && loopback(runtime) && loopback(parent) && runtime.origin !== parent.origin;
  if (!local) {
    const site = getDomain(runtime.hostname, { allowPrivateDomains: true });
    const parentSite = getDomain(parent.hostname, { allowPrivateDomains: true });
    if (runtime.protocol !== 'https:' || parent.protocol !== 'https:' || !site || !parentSite || site === parentSite || loopback(runtime) || loopback(parent)) throw new Error('React execution requires a separate HTTPS site, not a same-site subdomain.');
    if (env.WORKBENCH_REACT_RUNTIME_VERIFIED !== 'true') throw new Error('React execution requires verified runtime egress and resource isolation.');
    throw new Error('Browser React execution is restricted to local emulator tests. Production requires the container runtime.');
  }
  return Object.freeze({ url: runtime.href, origin: runtime.origin, parentOrigin: parent.origin, local });
}
