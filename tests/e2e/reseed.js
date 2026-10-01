import { request } from '@playwright/test';
import { seedDatabase } from '../../backend/tests/fixtures/seed.js';
import { authenticateRoles } from './auth.js';

// Reseeding rewrites the database behind the e2e server, which keeps catalog and
// dashboard caches in memory. Drop them as well so every test starts the way a
// fresh server would, instead of relying on some earlier sale to clear them.
// Seeding also drops every session and the call-center user, so log every role
// in again and rewrite the storage-state files later contexts load. Reseed in a
// beforeEach without a page fixture, so the page is created from the fresh files.
export async function resetServerCaches() {
  const port = process.env.PLAYWRIGHT_CONTROL_PORT || 3091;
  const response = await fetch(`http://127.0.0.1:${port}/reset-caches`, { method: 'POST' });
  if (!response.ok) throw new Error(`E2E server cache reset failed (${response.status}); start the server with tests/e2e/web-server.cjs.`);
}

export async function reseedDatabase() {
  await seedDatabase();
  await resetServerCaches();

  const context = await request.newContext({
    baseURL: 'http://localhost:3001',
    // A clean context: otherwise it inherits the running project's storage state.
    storageState: { cookies: [], origins: [] },
  });
  try {
    await authenticateRoles(context);
  } finally {
    await context.dispose();
  }
}
