import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', testMatch: 'product-operations-workbench.spec.ts', workers: 1,
  timeout: 180000, expect: { timeout: 10000 },
  use: { baseURL: 'http://localhost:4173', screenshot: 'only-on-failure' },
  webServer: {
    command: process.env.PRODUCT_OPERATIONS_QA_BUILD === 'true' ? 'VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_PLATFORM_API_ENABLED=true VITE_PLATFORM_API_BASE_URL=http://127.0.0.1:8797 npm run build && npx vite preview --host localhost --port 4173 --strictPort' : 'VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_PLATFORM_API_ENABLED=true VITE_PLATFORM_API_BASE_URL=http://127.0.0.1:8797 npm run dev -- --host localhost --port 4173 --strictPort',
    url: 'http://localhost:4173/login', timeout: 120000, reuseExistingServer: false,
  },
});
