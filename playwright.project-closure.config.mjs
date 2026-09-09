import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.project-draft.config.mjs';

export default defineConfig({
  ...baseConfig,
  testMatch: 'project-closure.spec.ts',
  use: { ...baseConfig.use, baseURL: 'http://localhost:4180' },
  webServer: {
    ...baseConfig.webServer,
    command: 'npm run dev -- --host localhost --port 4180',
    url: 'http://localhost:4180/login',
    env: { ...baseConfig.webServer.env, VITE_PLATFORM_API_BASE_URL: 'http://localhost:4180' },
  },
});
