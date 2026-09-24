import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
export default defineConfig({
  testDir: '.', testMatch: '*.e2e.spec.ts', fullyParallel: false, workers: 1, timeout: 45000,
  use: { baseURL: 'http://127.0.0.1:4178', headless: true, trace: 'retain-on-failure' },
  reporter: [['list']], outputDir: '../test-results/workbench',
  webServer: process.env.CI ? [
    { command: 'node server/workbench/server.mjs', cwd: root, url: 'http://127.0.0.1:8791/health', timeout: 30000,
      env: { WORKBENCH_AUTH_MODE: 'emulator', WORKBENCH_PROJECT_ID: 'demo-workbench-ci', PRODUCTION_PROJECT_ID: 'isolated-unused-prod', WORKBENCH_MODEL_PROJECT_ID: 'demo-workbench-model', PRODUCTION_MODEL_PROJECT_ID: 'isolated-unused-model', WORKBENCH_TENANT_ID: 'demo-org', WORKBENCH_AI_ENABLED: 'false' } },
    { command: 'npm run workbench:dev', cwd: root, url: 'http://127.0.0.1:4178', timeout: 30000, env: { VITE_WORKBENCH_DEMO: 'true' } },
  ] : undefined,
});
