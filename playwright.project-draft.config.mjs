import { defineConfig } from '@playwright/test';
import baseConfig from './playwright.harness.config.mjs';

export default defineConfig({
  ...baseConfig,
  testIgnore: [],
  testMatch: 'project-draft-recovery.spec.ts',
  use: { ...baseConfig.use, baseURL: 'http://localhost:4176' },
  webServer: {
    ...baseConfig.webServer,
    command: 'npm run dev -- --host localhost --port 4176',
    url: 'http://localhost:4176/login',
    env: {
      VITE_PLATFORM_API_ENABLED: 'true',
      VITE_PLATFORM_API_BASE_URL: 'http://localhost:4176',
      VITE_FIREBASE_AUTH_ENABLED: 'false',
      VITE_FIRESTORE_CORE_ENABLED: 'false',
      VITE_DEV_AUTH_HARNESS_ENABLED: 'true',
    },
  },
});
