import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { environment: 'node', globals: true, include: ['server/workbench/**/*.test.ts', 'server/workbench/**/*.test.mjs', 'src/app/components/product-operations/html-preview/SourcePreview.test.ts'], testTimeout: 30000, hookTimeout: 30000 } });
