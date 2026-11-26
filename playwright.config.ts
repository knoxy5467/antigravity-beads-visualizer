import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  outputDir: './test-results/artifacts',
  timeout: 30000,
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true,
    viewport: { width: 1280, height: 800 },
    screenshot: 'only-on-failure',
    video: 'on',
  },
  webServer: {
    command: 'node dist/src/standalone/server.js',
    url: 'http://127.0.0.1:4173/api/health',
    reuseExistingServer: false,
    env: {
      PORT: '4173',
      BEADS_TEST_ENV: 'synthetic',
      BEADS_FIXTURE_PATH: 'tests/fixtures/synthetic-beads.json',
    },
  },
});
