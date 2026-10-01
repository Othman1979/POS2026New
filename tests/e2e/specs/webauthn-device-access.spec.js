import { test, expect } from '@playwright/test';

const ORIGIN = 'http://localhost:3012';
const ADMIN_NUMBER = '9001';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret-with-more-than-256-bits-000000000000000000000000';

function cookieValue(response) {
  const header = response.headers()['set-cookie'] || '';
  return header.match(/(?:^|,\s*)pos_token=([^;]+)/)?.[1] || null;
}

async function post(request, path, data, cookie = null) {
  const headers = { Origin: ORIGIN, 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = `pos_token=${cookie}`;
  return request.post(path, { headers, data });
}

async function browserProof(page, message, create = false) {
  return page.evaluate(async ({ proofMessage, shouldCreate }) => {
    const open = () => new Promise((resolve, reject) => {
      const request = indexedDB.open('posapp-browser-device', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('keys');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = async () => {
      const db = await open();
      try {
        return await new Promise((resolve, reject) => {
          const request = db.transaction('keys').objectStore('keys').get('origin-key-v1');
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    };
    const write = async (value) => {
      const db = await open();
      try {
        await new Promise((resolve, reject) => {
          const request = db.transaction('keys', 'readwrite').objectStore('keys').put(value, 'origin-key-v1');
          request.onsuccess = () => resolve();
          request.onerror = () => reject(request.error);
        });
      } finally { db.close(); }
    };
    const encode = (value) => {
      let binary = '';
      for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
      return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    };

    let pair = await read();
    if (!pair && shouldCreate) {
      pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      await write(pair);
      pair = await read();
    }
    if (!pair) return null;
    const exported = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, new TextEncoder().encode(proofMessage));
    return {
      public_key: { kty: exported.kty, crv: exported.crv, x: exported.x, y: exported.y },
      signature: encode(signature),
      extractable: pair.privateKey.extractable,
    };
  }, { proofMessage: message, shouldCreate: create });
}

test('browser key registers without a system prompt, survives reload, and rejects replay or another profile', async ({ browser, page, request }) => {
  await page.goto('/login');

  const legacyLogin = await request.post('/api/auth/login', { data: { user_number: ADMIN_NUMBER } });
  expect(legacyLogin.status()).toBe(200);
  const legacyCookie = cookieValue(legacyLogin);

  const bootstrapOptions = await post(request, '/api/admin/device-access/bootstrap/options', {
    bootstrap_secret: BOOTSTRAP_SECRET,
    device_label: 'Playwright browser',
  }, legacyCookie);
  expect(bootstrapOptions.status()).toBe(200);
  const bootstrap = await bootstrapOptions.json();
  const registration = await browserProof(page, bootstrap.message, true);
  expect(registration.extractable).toBe(false);

  const bootstrapVerify = await post(request, '/api/admin/device-access/bootstrap/verify', {
    ceremony_id: bootstrap.ceremony_id,
    bootstrap_secret: BOOTSTRAP_SECRET,
    public_key: registration.public_key,
    signature: registration.signature,
  }, legacyCookie);
  expect(bootstrapVerify.status()).toBe(200);
  const boundCookie = cookieValue(bootstrapVerify);
  expect(boundCookie).toBeTruthy();
  await request.post('/api/auth/logout', { headers: { Cookie: `pos_token=${boundCookie}` } });

  await page.reload();
  await page.keyboard.type(ADMIN_NUMBER);
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/admin\/dashboard$/, { timeout: 15_000 });

  const replayOptions = await post(request, '/api/auth/webauthn/login/options', { user_number: ADMIN_NUMBER });
  const replayPayload = await replayOptions.json();
  const proof = await browserProof(page, replayPayload.message);
  const first = await post(request, '/api/auth/webauthn/login/verify', { ceremony_id: replayPayload.ceremony_id, signature: proof.signature });
  expect(first.status()).toBe(200);
  const replay = await post(request, '/api/auth/webauthn/login/verify', { ceremony_id: replayPayload.ceremony_id, signature: proof.signature });
  expect([400, 409]).toContain(replay.status());

  const context = await browser.newContext();
  const otherPage = await context.newPage();
  await otherPage.goto(`${ORIGIN}/login`);

  const unrelatedKey = await browserProof(otherPage, 'probe', true);
  expect(unrelatedKey).not.toBeNull();
  await otherPage.keyboard.type(ADMIN_NUMBER);
  await otherPage.keyboard.press('Enter');
  await expect(otherPage.locator('.text-error')).toContainText('This browser is not registered for this user.');
  await expect(otherPage).toHaveURL(/\/login$/);

  await context.close();
});
