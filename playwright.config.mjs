import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false, // Run sequentially to avoid MySQL write lock contention
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: 1, // Single worker prevents database transaction overlap issues
  reporter: 'html',
  
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  // Setup projects: Setup runs first, then tests use the populated credentials
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.js/,
    },
    {
      name: 'cashier-tests',
      testMatch: /specs\/(?:cashier\..*|subscription-receivables)\.spec\.js/,
      use: { 
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/cashier.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'checkout-recovery-tests',
      testMatch: /specs\/checkout-recovery\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/cashier.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'waiter-tests',
      testMatch: /specs\/waiter\..*\.spec\.js/,
      use: { 
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/waiter.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'admin-tests',
      testMatch: /specs\/admin\..*\.spec\.js/,
      use: { 
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/admin.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'held-order-lifecycle-tests',
      testMatch: /specs\/held-order-lifecycle\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/cashier.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'catalog-refresh-lifecycle-tests',
      testMatch: /specs\/catalog-refresh-lifecycle\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/cashier.json',
      },
      dependencies: ['setup'],
    },
    {
      name: 'call-center-tests',
      testMatch: /specs\/call-center\.holds\.spec\.js/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'playwright/.auth/call-center.json',
      },
      dependencies: ['setup'],
    },
  ],

  // Run a local server automatically before E2E tests start
  webServer: {
    command: 'npm run build && node tests/e2e/web-server.cjs',
    // The harness control port comes up once the app is listening, so a reused
    // server is always one that tests/e2e/reseed.js can reset (never a plain app).
    url: `http://127.0.0.1:${process.env.PLAYWRIGHT_CONTROL_PORT || 3091}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120 * 1000,
  },
});
