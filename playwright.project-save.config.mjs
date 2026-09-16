import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'project-save-policy.spec.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  use: { baseURL: 'http://localhost:4193', trace: 'retain-on-failure' },
  webServer: {
    command: 'VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_DEMO_LOGIN_ENABLED=true VITE_FIREBASE_AUTH_ENABLED=false VITE_FIRESTORE_CORE_ENABLED=false VITE_PLATFORM_API_ENABLED=true npm run dev -- --host localhost --port 4193',
    url: 'http://localhost:4193/login',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
