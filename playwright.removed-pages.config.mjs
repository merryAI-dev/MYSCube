import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: 'removed-work-pages.spec.ts',
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:4186' },
  webServer: {
    command: 'VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_PLATFORM_API_ENABLED=false npm run dev -- --host localhost --port 4186 --strictPort',
    url: 'http://localhost:4186/login',
    reuseExistingServer: false,
    timeout: 120000,
  },
});
