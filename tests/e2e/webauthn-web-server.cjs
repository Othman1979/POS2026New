const path = require('path');

const envTestPath = path.resolve(__dirname, '../../.env.test');
process.env.NODE_ENV = 'test';
require('dotenv').config({ path: envTestPath, override: true });

const { seedDatabase } = require('../../backend/tests/fixtures/seed');

// The normal E2E server is intentionally not reused: this harness owns an
// isolated port and scratch database so it can move authentication to staged
// mode without changing the ordinary browser suite.
seedDatabase()
    .then(() => {
        process.env.PORT = '3012';
        process.env.NODE_ENV = 'development';
        process.env.POSAPP_ENV_FILE = envTestPath;
        process.env.DEVICE_AUTH_ALLOWED_ORIGINS = 'http://localhost:3012';
        process.env.DEVICE_AUTH_BOOTSTRAP_SECRET = 'test-bootstrap-secret-with-more-than-256-bits-000000000000000000000000';
        process.env.ENFORCE_HTTPS = 'false';
        require('../../server');
    })
    .catch((error) => {
        console.error('WebAuthn Playwright server bootstrap failed:', error);
        process.exitCode = 1;
    });
