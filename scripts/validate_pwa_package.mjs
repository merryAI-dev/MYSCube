import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

function readText(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

function readJson(path) {
  return JSON.parse(readText(path));
}

function readPngSize(path) {
  const buffer = readFileSync(resolve(root, path));
  const signature = buffer.subarray(0, 8).toString('hex');
  if (signature !== '89504e470d0a1a0a') {
    throw new Error(`${path} is not a PNG file`);
  }
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

function requireText(path, expected, label = expected) {
  const text = readText(path);
  if (!text.includes(expected)) {
    fail(`${path} must include ${label}`);
  }
}

const manifest = readJson('public/manifest.webmanifest');

for (const field of ['id', 'name', 'short_name', 'start_url', 'scope', 'display', 'icons']) {
  if (!manifest[field]) fail(`manifest missing ${field}`);
}

if (manifest.display !== 'standalone') fail('manifest display must be standalone');
if (manifest.lang !== 'ko-KR') fail('manifest lang must be ko-KR');
if (manifest.start_url !== '/mobile-entry') fail('manifest start_url must be /mobile-entry');
if (!Array.isArray(manifest.icons) || manifest.icons.length < 3) fail('manifest must include any and maskable icons');

const requiredIcons = new Map([
  ['/pwa/myscube-icon-192.png', 192],
  ['/pwa/myscube-icon-512.png', 512],
  ['/pwa/myscube-icon-maskable-512.png', 512],
]);

for (const [src, expectedSize] of requiredIcons) {
  const filePath = `public${src}`;
  if (!existsSync(resolve(root, filePath))) {
    fail(`missing icon ${filePath}`);
    continue;
  }
  const { width, height } = readPngSize(filePath);
  if (width !== expectedSize || height !== expectedSize) {
    fail(`${filePath} must be ${expectedSize}x${expectedSize}, got ${width}x${height}`);
  }
}

requireText('index.html', '<html lang="ko">');
requireText('index.html', 'name="apple-mobile-web-app-title"');
requireText('index.html', 'rel="apple-touch-icon" href="/pwa/myscube-icon-192.png"');
requireText('vercel.json', 'camera=(self), microphone=(), geolocation=()', 'same-origin camera permissions policy');

for (const privatePrefix of ['/api/', '/api/v1/', '/business-card-imports/']) {
  requireText('public/sw.js', privatePrefix, `service worker private cache bypass ${privatePrefix}`);
}

for (const route of ["'/install'", "'/install/ios'", "'/install/android'", "'/mobile-entry'"]) {
  requireText('src/app/routes.tsx', route, `PWA install route ${route}`);
}

if (failures.length > 0) {
  for (const failure of failures) {
    console.error(`[pwa:verify] ${failure}`);
  }
  process.exit(1);
}

console.log('[pwa:verify] ok');
