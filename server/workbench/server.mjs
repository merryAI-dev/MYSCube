import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { Firestore } from '@google-cloud/firestore';
import { createWorkbenchApp } from './app.mjs';
import { resolveWorkbenchRuntime } from './runtime-config.mjs';
import { resolveReactRuntime } from './react-runtime-config.mjs';
import { assertRendererHostReady } from './remote-runtime/reaper.mjs';
import { resolveWorkbenchListenHost } from './listen-host.mjs';
import { closeWorkbenchServer } from './shutdown.mjs';
import { workbenchShellCsp } from './shell-csp.mjs';

const env = process.env;
const runtime = resolveWorkbenchRuntime(env);
const reactRuntime = env.WORKBENCH_REMOTE_RUNTIME_ENABLED === 'true' ? null : resolveReactRuntime(env);
if (env.WORKBENCH_REMOTE_RUNTIME_ENABLED === 'true') {
  if (env.WORKBENCH_REMOTE_RUNTIME_DRIVER !== 'docker-host' || env.K_SERVICE) throw new Error('Remote React requires a dedicated Docker host.');
  await assertRendererHostReady();
}
const demo = env.WORKBENCH_AUTH_MODE === 'emulator';
const listenHost = resolveWorkbenchListenHost(env, demo);
if (demo && (!runtime.projectId.startsWith('demo-') || !env.FIRESTORE_EMULATOR_HOST?.match(/^(127\.0\.0\.1|localhost):\d+$/))) throw new Error('Emulator login requires a local demo project.');
const db = new Firestore({ projectId: runtime.projectId });
let auth;
if (!demo) {
  if (!env.WORKBENCH_AUTH_PROJECT_ID) throw new Error('WORKBENCH_AUTH_PROJECT_ID is required.');
  auth = getAuth(initializeApp({ projectId: env.WORKBENCH_AUTH_PROJECT_ID }, 'isolated-workbench-identity'));
}
if (demo) {
  const member = db.doc(`orgs/${env.WORKBENCH_TENANT_ID || 'demo-org'}/members/demo-admin`);
  const renew = () => member.set({ status: 'ACTIVE', role: 'admin', permissionsCapturedAt: new Date().toISOString() }, { merge: true });
  await renew();
  setInterval(() => void renew().catch(() => {}), 60000).unref();
}
const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', workbenchShellCsp({ reactRuntimeOrigin: reactRuntime?.origin || '' }));
  next();
});
if (demo) app.use('/api', (req, _res, next) => { req.headers['x-actor-id'] = 'demo-admin'; req.headers['x-tenant-id'] = env.WORKBENCH_TENANT_ID || 'demo-org'; next(); });
const workbench = createWorkbenchApp({ db, env, authMode: demo ? 'headers' : undefined, verifyToken: demo ? undefined : async (header) => {
  if (!/^Bearer \S+$/.test(header || '')) throw Object.assign(new Error('로그인이 필요합니다.'), { statusCode: 401, expose: true });
  return auth.verifyIdToken(header.slice(7), true);
} });
app.use(workbench);
const dist = resolve(fileURLToPath(new URL('../../', import.meta.url)), 'dist-workbench');
app.use(express.static(dist));
app.get('/{*path}', (_req, res) => res.sendFile(resolve(dist, 'index.html')));
const server = app.listen(Number(env.PORT || 8791), listenHost, () => console.log('Isolated AXR Workbench listening'));
server.requestTimeout = 120000;
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (closing) return;
  closing = true;
  void closeWorkbenchServer({ server, db, remoteRuntime: workbench.locals.remoteRuntime }).then((code) => process.exit(code));
});
