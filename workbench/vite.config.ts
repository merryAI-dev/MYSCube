import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  envDir: fileURLToPath(new URL('..', import.meta.url)),
  cacheDir: '../node_modules/.vite-workbench',
  plugins: [react()],
  build: { outDir: '../dist-workbench', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 4178, proxy: { '/api': 'http://127.0.0.1:8791' }, fs: { allow: [fileURLToPath(new URL('..', import.meta.url))] } },
});
