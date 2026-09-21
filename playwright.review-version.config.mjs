import { defineConfig } from '@playwright/test';
export default defineConfig({
 testDir:'./tests/e2e',testMatch:'project-review-version.spec.ts',timeout:60000,expect:{timeout:10000},workers:1,retries:0,
 use:{baseURL:'http://localhost:4214',trace:'retain-on-failure'},
 webServer:{command:'VITE_DEV_AUTH_HARNESS_ENABLED=true VITE_DEMO_LOGIN_ENABLED=true VITE_FIREBASE_AUTH_ENABLED=false VITE_FIRESTORE_CORE_ENABLED=false VITE_PLATFORM_API_ENABLED=true npm run dev -- --host localhost --port 4214',url:'http://localhost:4214/login',reuseExistingServer:false,timeout:120000},
});
