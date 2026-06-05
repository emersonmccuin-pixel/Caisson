// Playwright configuration for e2e smoke tests.
//
// Tests 1–3 (z-order stacking) are self-contained: they inject synthetic
// DOM elements and call document.elementFromPoint — no server required.
// Test 4 (app-load smoke) optionally connects to the running dev server at
// localhost:5173 and is skipped if the server is unreachable.
//
// To run: `pnpm test:e2e`
// Pre-req: `npx playwright install chromium` (once per machine / worktree).
//
// Screenshots land in e2e/evidence/ (playwright.config screenshot: 'on').

import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = Number(process.env.PC_DEV_WEB_PORT ?? 5173);

export default defineConfig({
  testDir: './e2e',
  outputDir: './e2e/evidence',

  retries: process.env.CI ? 1 : 0,
  workers: 1,

  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e/report', open: 'never' }],
  ],

  use: {
    // Individual tests navigate to about:blank or localhost:5173 as needed.
    headless: true,
    screenshot: 'on',       // always capture — evidence for QA review
    trace: 'on-first-retry',
    ...devices['Desktop Chrome'],
  },

  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],

  // No webServer — self-contained tests don't need one.
  // The optional app-load smoke (test 4) probes localhost:5173 directly.
  // Set PC_DEV_WEB_PORT if your dev server runs on a different port.
});
