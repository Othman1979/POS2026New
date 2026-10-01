const path = require('path');
const crypto = require('crypto');

process.env.NODE_ENV = 'test';
require('dotenv').config({
  path: path.resolve(__dirname, '../../.env.test'),
  override: true,
});
process.env.PORT = String(process.env.PLAYWRIGHT_PORT || '3001');

if (process.env.ORDER_INTAKE_E2E === '1') {
  const rawKey = String(process.env.ORDER_INTAKE_API_KEY || '');
  if (rawKey.length < 32) throw new Error('ORDER_INTAKE_API_KEY is required for the order-intake browser fixture.');
  process.env.ORDER_INTAKE_API_KEY_SHA256 = crypto.createHash('sha256').update(rawKey, 'utf8').digest('hex');
}

const { seedDatabase } = require('../../backend/tests/fixtures/seed');
const CONTROL_PORT = Number(process.env.PLAYWRIGHT_CONTROL_PORT || 3091);

// Seeding drops and recreates every posapp_test table, so refuse to start
// before touching the database when either port is already taken.
function assertPortFree(port, host) {
  const net = require('net');
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', (error) => reject(error.code === 'EADDRINUSE'
      ? new Error(`Port ${port} is already in use; stop that server first (the database was not touched).`)
      : error));
    probe.listen(port, host, () => probe.close(resolve));
  });
}

async function bootstrap() {
  await assertPortFree(Number(process.env.PORT));
  await assertPortFree(CONTROL_PORT, '127.0.0.1');
  await seedDatabase();
  if (process.env.ORDER_INTAKE_E2E === '1') {
    const actorId = Number(process.env.ORDER_INTAKE_ACTOR_USER_ID);
    if (!Number.isSafeInteger(actorId) || actorId <= 6) {
      throw new Error('ORDER_INTAKE_ACTOR_USER_ID must identify the dedicated E2E machine actor.');
    }
    const pool = require('../../backend/config/db');
    await pool.query(
      `INSERT INTO users (id, user_number, name, role, is_active)
       VALUES (?, '9070', 'E2E Order Intake', 'call_center', 1)`,
      [actorId]
    );
  }
  const started = await require('../../server').startServer();
  startCacheResetControl();
  return started;
}

// Specs reseed the database from the test process, behind this server's back.
// A loopback-only control port lets them drop the in-memory catalog and
// dashboard caches too (tests/e2e/reseed.js), as a fresh server would start.
// Its /health is Playwright's readiness and reuse check (playwright.config.mjs).
function startCacheResetControl() {
  const http = require('http');
  const cache = require('../../backend/config/cache');
  http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }
    if (request.method === 'POST' && request.url === '/reset-caches') {
      cache.invalidateCatalogCache();
      cache.invalidateDashboardCache();
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  }).listen(CONTROL_PORT, '127.0.0.1');
}

bootstrap()
  .catch((error) => {
    console.error('Playwright web server bootstrap failed:', error);
    // Exit now (the DB pool would keep the process alive) so Playwright reports
    // it at once, e.g. when another server already holds the app port.
    process.exit(1);
  });
