import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testIgnore: [
    'admin-cashflow-export-api.spec.ts',
    'people-professional-profile.spec.ts',
    // 기본 harness 서버는 VITE_PLATFORM_API_ENABLED 가 꺼져 있어 /people 이 disabled 분기로
    // 렌더된다. 플래그 켠 서버를 띄우고 단독 실행한다 (people-professional-profile 과 동일):
    //   VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_PLATFORM_API_ENABLED=true npx vite --port 4173
    //   npx playwright test tests/e2e/people-roster-push.spec.ts --config playwright.harness.config.mjs
    'people-roster-push.spec.ts',
  ],
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 0,
  use: {
    baseURL: 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'VITE_DEV_AUTH_HARNESS_ENABLED=true npm run dev -- --host localhost --port 4173',
    url: 'http://localhost:4173/login',
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
