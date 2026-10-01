import { test as setup } from '@playwright/test';
import { authenticateRoles } from './auth.js';

setup('Authenticate all roles against seeded database', async ({ request }) => {
  // The web-server bootstrap seeds the scratch database before this setup
  // project starts. Keeping the reset outside the auth step prevents cookies
  // created here from being invalidated by a second DROP/CREATE cycle.
  await authenticateRoles(request);
});
