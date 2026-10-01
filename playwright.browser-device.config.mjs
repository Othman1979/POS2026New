import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /specs\/webauthn-device-access\.spec\.js/,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  timeout: 90_000,
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://localhost:3012',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'npm run build && node tests/e2e/webauthn-web-server.cjs',
    url: 'http://localhost:3012/health',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
