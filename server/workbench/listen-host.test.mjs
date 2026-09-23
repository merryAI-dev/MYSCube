import { createServer } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { resolveWorkbenchListenHost } from './listen-host.mjs';

describe('standalone host listening boundary', () => {
  it('preserves container defaults and prevents emulator public binding', () => {
    expect(resolveWorkbenchListenHost({})).toBe('0.0.0.0');
    expect(resolveWorkbenchListenHost({}, true)).toBe('127.0.0.1');
    for (const value of ['', 'localhost', '::', 'example.org', ' 127.0.0.1 ']) expect(() => resolveWorkbenchListenHost({ WORKBENCH_BIND_HOST: value })).toThrow();
    expect(() => resolveWorkbenchListenHost({ WORKBENCH_BIND_HOST: '0.0.0.0' }, true)).toThrow();
  });

  it('binds a real HTTP listener to loopback for the dedicated host configuration', async () => {
    const server = createServer((_req, res) => res.end('ready'));
    try {
      server.listen(0, resolveWorkbenchListenHost({ WORKBENCH_BIND_HOST: '127.0.0.1' }));
      await once(server, 'listening');
      const address = server.address();
      expect(address.address).toBe('127.0.0.1');
      const response = await fetch(`http://127.0.0.1:${address.port}/health`);
      expect(await response.text()).toBe('ready');
    } finally { await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); }
  });
});
