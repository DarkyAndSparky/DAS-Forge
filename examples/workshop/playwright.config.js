import { defineConfig } from '@playwright/test';

const port = process.env.E2E_PORT ?? '4399';

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.js', // keeps vitest from picking these up
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: [['list']],
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    locale: 'en-US', // the scenarios click buttons by their English names
    ignoreHTTPSErrors: true, // the app serves a self-signed certificate by default
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node e2e/start.js',
    url: `https://127.0.0.1:${port}/health`,
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
