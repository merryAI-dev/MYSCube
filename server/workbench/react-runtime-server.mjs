import express from 'express';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolveReactRuntime } from './react-runtime-config.mjs';
import { getReactPackageSet } from './react-compiler-packages.mjs';
import { createReactRuntimeDocument, reactRuntimeCsp } from './react-compiler-runtime.mjs';

export async function createReactRuntimeServer(env) {
  const runtime = resolveReactRuntime(env);
  if (!runtime) throw new Error('A separate React runtime URL is required.');
  const packages = await getReactPackageSet();
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => { res.set('X-Content-Type-Options', 'nosniff'); res.set('Referrer-Policy', 'no-referrer'); res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()'); next(); });
  app.get(`/packages/${packages.packageSetHash}.js`, (_req, res) => {
    res.set('Cache-Control', 'public, max-age=31536000, immutable'); res.set('Access-Control-Allow-Origin', '*'); res.type('application/javascript').send(packages.bundle);
  });
  app.get('/runtime', (req, res) => {
    if (!/^[a-f0-9-]{36}$/.test(req.query.channel || '')) return res.sendStatus(400);
    const nonce = randomBytes(24).toString('base64');
    res.set('Cache-Control', 'no-store'); res.set('Content-Security-Policy', reactRuntimeCsp({ nonce, parentOrigin: runtime.parentOrigin }));
    res.type('html').send(createReactRuntimeDocument({ nonce, parentOrigin: runtime.parentOrigin, packageSetHash: packages.packageSetHash }));
  });
  app.use((_req, res) => res.sendStatus(404));
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const app = await createReactRuntimeServer(process.env);
  app.listen(Number(process.env.WORKBENCH_RUNTIME_PORT || 8792), process.env.WORKBENCH_AUTH_MODE === 'emulator' ? '127.0.0.1' : '0.0.0.0', () => console.log('Independent React runtime listening'));
}
