import { defineConfig } from '@playwright/test';
import base from './playwright.project-closure.config.mjs';

export default defineConfig({ ...base, testMatch: 'field-appearance.spec.ts' });
