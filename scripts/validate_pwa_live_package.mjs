#!/usr/bin/env node

const DEFAULT_BASE_URL = 'https://myscube.myscguard.app';
const failures = [];
const MAX_FETCH_RETRIES = Number.parseInt(process.env.PWA_LIVE_VERIFY_FETCH_RETRIES ?? '4', 10);
const RETRY_DELAY_MS = Number.parseInt(process.env.PWA_LIVE_VERIFY_RETRY_DELAY_MS ?? '1000', 10);
const RETRY_STATUSES = new Set([403, 408, 429, 500, 502, 503, 504]);

function fail(message) {
  failures.push(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeBaseUrl(input) {
  const raw = input?.trim() || DEFAULT_BASE_URL;
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const url = new URL(withProtocol);

  if (url.protocol !== 'https:') {
    throw new Error(`live PWA verification requires HTTPS, got ${url.protocol}`);
  }

  url.pathname = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function joinUrl(baseUrl, path) {
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
}

async function fetchRequired(baseUrl, path, options = {}) {
  const headers = {
    accept: options.accept ?? '*/*',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  };
  const url = joinUrl(baseUrl, path);

  for (let attempt = 1; attempt <= MAX_FETCH_RETRIES; attempt += 1) {
    const response = await fetch(url, {
      headers,
      redirect: 'follow',
    });

    if (response.ok) return response;

    if (RETRY_STATUSES.has(response.status) && attempt < MAX_FETCH_RETRIES) {
      await sleep(RETRY_DELAY_MS * attempt);
      continue;
    }

    fail(`${path} must return 2xx, got ${response.status}`);
    return response;
  }

  return null;
}

function readPngSize(buffer) {
  const signature = Buffer.from(buffer.slice(0, 8)).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error('not a PNG file');
  }

  const bytes = Buffer.from(buffer);
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

async function verifyHtmlEndpoint(baseUrl, path) {
  const response = await fetchRequired(baseUrl, path, { accept: 'text/html' });
  if (!response || !response.ok) return;

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();

  if (!contentType.includes('text/html')) {
    fail(`${path} must serve HTML, got content-type "${contentType || 'missing'}"`);
  }

  if (!body.includes('id="root"')) {
    fail(`${path} must serve the Vite app shell`);
  }

  return response;
}

async function verifyManifest(baseUrl) {
  const response = await fetchRequired(baseUrl, '/manifest.webmanifest', {
    accept: 'application/manifest+json, application/json',
  });
  if (!response || !response.ok) return;

  const contentType = response.headers.get('content-type') ?? '';
  const body = await response.text();
  let manifest;

  if (!contentType.includes('json') && !contentType.includes('manifest')) {
    fail(`/manifest.webmanifest must serve a JSON manifest, got content-type "${contentType || 'missing'}"`);
  }

  try {
    manifest = JSON.parse(body);
  } catch {
    fail('/manifest.webmanifest must be valid JSON');
    return;
  }

  for (const field of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
    if (!manifest[field]) fail(`manifest missing ${field}`);
  }

  if (manifest.display !== 'standalone') fail('manifest display must be standalone');
  if (manifest.lang !== 'ko-KR') fail('manifest lang must be ko-KR');
  if (manifest.start_url !== '/mobile-entry') fail('manifest start_url must be /mobile-entry');

  const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
  const requiredIcons = new Map([
    ['/pwa/myscube-icon-192.png', '192x192'],
    ['/pwa/myscube-icon-512.png', '512x512'],
    ['/pwa/myscube-icon-maskable-512.png', '512x512'],
  ]);

  for (const [src, sizes] of requiredIcons) {
    const match = icons.find((icon) => icon.src === src && icon.sizes === sizes && icon.type === 'image/png');
    if (!match) fail(`manifest must include ${src} as ${sizes} image/png`);
  }

  if (!icons.some((icon) => icon.src === '/pwa/myscube-icon-maskable-512.png' && icon.purpose === 'maskable')) {
    fail('manifest must include maskable launcher icon');
  }
}

async function verifyIcon(baseUrl, path, expectedSize) {
  const response = await fetchRequired(baseUrl, path, { accept: 'image/png' });
  if (!response || !response.ok) return;

  const contentType = response.headers.get('content-type') ?? '';
  const buffer = await response.arrayBuffer();

  if (!contentType.includes('image/png')) {
    fail(`${path} must serve image/png, got "${contentType || 'missing'}"`);
  }

  try {
    const { width, height } = readPngSize(buffer);
    if (width !== expectedSize || height !== expectedSize) {
      fail(`${path} must be ${expectedSize}x${expectedSize}, got ${width}x${height}`);
    }
  } catch (error) {
    fail(`${path} must be a valid PNG: ${error.message}`);
  }
}

async function verifyServiceWorker(baseUrl) {
  const response = await fetchRequired(baseUrl, '/sw.js', { accept: 'application/javascript, text/javascript' });
  if (!response || !response.ok) return;

  const body = await response.text();

  for (const privatePrefix of ['/api/', '/api/v1/', '/business-card-imports/']) {
    if (!body.includes(privatePrefix)) {
      fail(`service worker must bypass private cache prefix ${privatePrefix}`);
    }
  }
}

function verifyCameraPolicy(response) {
  const policy = response.headers.get('permissions-policy') ?? '';
  const match = /camera=\(([^)]*)\)/.exec(policy);

  if (!match) {
    fail(`Permissions-Policy must allow same-origin camera capture, got "${policy || 'missing'}"`);
    return;
  }

  if (!match[1].split(',').map((token) => token.trim()).includes('self')) {
    fail(`Permissions-Policy must allow same-origin camera capture, got "${policy}"`);
  }

  if (match[1].replace(/\s+/g, '') === '()') {
    fail(`Permissions-Policy must not block camera capture, got "${policy}"`);
  }
}

async function main() {
  const baseUrl = normalizeBaseUrl(process.argv[2] ?? process.env.PWA_LIVE_BASE_URL);

  await Promise.all([
    verifyHtmlEndpoint(baseUrl, '/install'),
    verifyHtmlEndpoint(baseUrl, '/install/ios'),
    verifyHtmlEndpoint(baseUrl, '/install/android'),
    verifyHtmlEndpoint(baseUrl, '/mobile-entry'),
    verifyManifest(baseUrl),
    verifyIcon(baseUrl, '/pwa/myscube-icon-192.png', 192),
    verifyIcon(baseUrl, '/pwa/myscube-icon-512.png', 512),
    verifyIcon(baseUrl, '/pwa/myscube-icon-maskable-512.png', 512),
    verifyServiceWorker(baseUrl),
  ]);

  const homeResponse = await verifyHtmlEndpoint(baseUrl, '/');
  verifyCameraPolicy(homeResponse);

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[pwa:verify:live] ${failure}`);
    }
    process.exit(1);
  }

  console.log(`[pwa:verify:live] ok ${baseUrl}`);
}

main().catch((error) => {
  console.error(`[pwa:verify:live] ${error.message}`);
  process.exit(1);
});
