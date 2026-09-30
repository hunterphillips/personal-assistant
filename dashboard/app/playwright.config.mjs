// Browser tests for the shell. Each test starts its own servers on ephemeral
// loopback ports (test/support/browser-server.mjs), so there is no webServer
// entry and nothing attaches to 4242 or 4243. Output stays in test-results/,
// which is ignored and never uploaded.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'test/browser',
  testMatch: '**/*.spec.mjs',
  outputDir: 'test-results/browser',
  fullyParallel: true,
  workers: 4,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  forbidOnly: true,
  retries: 0,
  reporter: [['list']],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Date lines in threads come from local calendar days; one zone keeps
    // them deterministic wherever the suite runs.
    timezoneId: 'America/Chicago',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } },
    },
    {
      // Device emulation: a 390px-wide WebKit viewport with touch events
      // enabled. It does not exercise real touch hardware.
      name: 'mobile-webkit',
      use: { ...devices['iPhone 13'] },
    },
  ],
});
