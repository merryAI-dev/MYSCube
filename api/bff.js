import { waitUntil } from '@vercel/functions';
import { createBffApp } from '../server/bff/app.mjs';
import { resolveProjectId } from '../server/bff/firestore.mjs';

const projectId = resolveProjectId();
const app = createBffApp({ projectId, waitUntil });

function resolveForwardedUrl(rawUrl = '/') {
  const url = new URL(rawUrl, 'http://localhost');
  const forwardedPath = url.searchParams.get('__path');
  if (!forwardedPath) return rawUrl;

  url.searchParams.delete('__path');
  const safePath = forwardedPath.startsWith('/') ? forwardedPath : `/${forwardedPath}`;
  const query = url.searchParams.toString();
  return query ? `${safePath}?${query}` : safePath;
}

export default function handler(req, res) {
  req.url = resolveForwardedUrl(req.url);
  return app(req, res);
}
