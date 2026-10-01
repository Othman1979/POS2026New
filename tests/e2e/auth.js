import { SEED } from '../../backend/tests/fixtures/seed.js';

export const authPaths = {
  admin: 'playwright/.auth/admin.json',
  cashier: 'playwright/.auth/cashier.json',
  waiter: 'playwright/.auth/waiter.json',
  callCenter: 'playwright/.auth/call-center.json',
};

export const CALL_CENTER_USER_NUMBER = '9088';

// Logs every role in and writes its storage state. Seeding drops every table,
// which removes all sessions and the call-center user, so this runs after the
// initial seed (global setup) and again after every reseed.
export async function authenticateRoles(request) {
  const loginAndSave = async (userNumber, savePath) => {
    const response = await request.post('/api/auth/login', { data: { user_number: userNumber } });
    if (response.status() !== 200) {
      throw new Error(`Failed to login user ${userNumber}. Status: ${response.status()}`);
    }
    // Storage state includes HTTP-only cookies such as pos_token.
    await request.storageState({ path: savePath });
  };

  await loginAndSave(SEED.adminUser.user_number, authPaths.admin);

  // A reused harness server may already hold the call-center user (every reseed
  // recreates it), so log it in first and create it only when the login is
  // refused because the user does not exist.
  const callCenterLogin = await request.post('/api/auth/login', { data: { user_number: CALL_CENTER_USER_NUMBER } });
  if (callCenterLogin.status() === 200) {
    await request.storageState({ path: authPaths.callCenter });
  } else if (callCenterLogin.status() === 401) {
    await loginAndSave(SEED.adminUser.user_number, authPaths.admin);
    const createdCallCenter = await request.post('/api/admin/users', {
      data: {
        name: 'E2E Phone Desk',
        user_number: CALL_CENTER_USER_NUMBER,
        role: 'call_center',
        permissions: [],
        allowed_sections: '',
      },
    });
    if (!createdCallCenter.ok()) {
      throw new Error(`Failed to create E2E call-center user. Status: ${createdCallCenter.status()}`);
    }
    await loginAndSave(CALL_CENTER_USER_NUMBER, authPaths.callCenter);
  } else {
    throw new Error(`Failed to login user ${CALL_CENTER_USER_NUMBER}. Status: ${callCenterLogin.status()}`);
  }
  await loginAndSave(SEED.cashierUser.user_number, authPaths.cashier);
  await loginAndSave(SEED.waiterUser.user_number, authPaths.waiter);
}
