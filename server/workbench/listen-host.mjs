export function resolveWorkbenchListenHost(env, demo = false) {
  const host = env.WORKBENCH_BIND_HOST ?? (demo ? '127.0.0.1' : '0.0.0.0');
  if (!['127.0.0.1', '0.0.0.0'].includes(host) || (demo && host !== '127.0.0.1')) {
    throw new Error('WORKBENCH_BIND_HOST must be 127.0.0.1 or 0.0.0.0; emulator login requires loopback.');
  }
  return host;
}
