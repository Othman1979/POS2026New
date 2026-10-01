const request = require('supertest');
const crypto = require('crypto');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const { beginEnrollment, completeRegistration, getActiveUser, listDeviceAccess, invalidateAuthModeCache } = require('../../services/deviceAccess');
const { createCeremony, getCeremonyForUpdate } = require('../../services/webauthn/ceremonies');
const { createSession, hashSessionToken } = require('../../services/staffSessions');
const { ELIGIBLE_CREDENTIAL_SQL } = require('../../services/webauthn/credentials');
const { publicKeyFingerprint } = require('../../services/browserDeviceCrypto');
const { proofMessage } = require('../../routes/auth/webauthn');

const ORIGIN = 'http://localhost:3001';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret-with-more-than-256-bits-000000000000000000000000';
const PROGRAMMER = { id: 30, user_number: '87654321', name: 'Support Programmer', role: 'programmer' };

// The admin Device Access panel refreshes on this event instead of polling.
const deviceAccessEvents = () => global.__mockEmit__.mock.calls.filter(([event]) => event === 'device_access_changed').length;

async function setAuthMode(mode) {
    await pool.query("UPDATE settings SET setting_value=? WHERE setting_key='staff_device_auth_mode'", [mode]);
    invalidateAuthModeCache();
}

function publicJwk() {
    return crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
}

function browserKey() {
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    return {
        publicJwk: pair.publicKey.export({ format: 'jwk' }),
        sign: (message) => crypto.sign('sha256', Buffer.from(message), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    };
}

async function insertEligibleCredential(userId, deviceLabel) {
    const rawId = crypto.randomBytes(24);
    const [result] = await pool.query(
        `INSERT INTO webauthn_credentials
            (user_id, credential_lookup, credential_id, public_key, device_type,
             backed_up, authenticator_attachment, device_label)
         VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', ?)`,
        [userId, rawId, rawId, Buffer.from(JSON.stringify(publicJwk())), deviceLabel]
    );
    return result.insertId;
}

describe('registered-device access boundaries', () => {
    beforeAll(async () => {
        process.env.DEVICE_AUTH_ALLOWED_ORIGINS = ORIGIN;
        process.env.DEVICE_AUTH_BOOTSTRAP_SECRET = BOOTSTRAP_SECRET;
        await seedDatabase();
        await pool.query(
            `INSERT INTO users (id, user_number, name, role, is_active, xyz)
             VALUES (?, ?, ?, 'programmer', 1, 0)`,
            [PROGRAMMER.id, PROGRAMMER.user_number, PROGRAMMER.name]
        );
    });

    afterAll(async () => {
        await pool.end();
    });

    it('keeps PIN login and WebAuthn disabled by default', async () => {
        const policy = await request(app).get('/api/auth/login-policy');
        expect(policy.statusCode).toBe(200);
        expect(policy.body).toMatchObject({ success: true, mode: 'disabled', supported: false });

        const options = await request(app)
            .post('/api/auth/webauthn/login/options')
            .set('Origin', ORIGIN)
            .send({ user_number: SEED.adminUser.user_number });
        expect(options.statusCode).toBe(409);
        expect(options.body.code).toBe('WEBAUTHN_DISABLED');
    });

    it('serves the desktop enrollment route through the POS application shell', async () => {
        const response = await request(app).get('/device-enrollment');
        expect(response.statusCode).toBe(200);
        expect(response.type).toMatch(/html/);
        expect(response.text).toContain('<div id="app"');
    });

    it('requires the existing admin session for bootstrap and never accepts a wrong secret', async () => {
        const noSession = await request(app)
            .post('/api/admin/device-access/bootstrap/options')
            .set('Origin', ORIGIN)
            .send({ bootstrap_secret: BOOTSTRAP_SECRET, device_label: 'Admin terminal' });
        expect(noSession.statusCode).toBe(401);

        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        const wrong = await request(app)
            .post('/api/admin/device-access/bootstrap/options')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ bootstrap_secret: 'wrong', device_label: 'Admin terminal' });
        expect(wrong.statusCode).toBe(400);
        expect(wrong.body.code).toBe('WEBAUTHN_BOOTSTRAP_INVALID');
    });

    it('serializes the one-time bootstrap ceremony under concurrent starts', async () => {
        await setAuthMode('disabled');
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE flow='bootstrap_registration' AND terminal_state='pending'");
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        const start = () => request(app)
            .post('/api/admin/device-access/bootstrap/options')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ bootstrap_secret: BOOTSTRAP_SECRET, device_label: 'Admin terminal' });

        const responses = await Promise.all([start(), start()]);
        expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
        const [[pending]] = await pool.query(
            "SELECT COUNT(*) AS count FROM webauthn_ceremonies WHERE flow='bootstrap_registration' AND terminal_state='pending'"
        );
        expect(Number(pending.count)).toBe(1);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE flow='bootstrap_registration' AND terminal_state='pending'");
    });

    it('does not let an old bootstrap ceremony downgrade programmer-enabled enforcement', async () => {
        await setAuthMode('disabled');
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='webauthn_bootstrap_consumed'");
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE flow='bootstrap_registration' AND terminal_state='pending'");
        await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Bootstrap race %'");

        let ceremonyId;
        try {
            const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
            const started = await request(app)
                .post('/api/admin/device-access/bootstrap/options')
                .set('Cookie', adminLogin.headers['set-cookie'][0])
                .set('Origin', ORIGIN)
                .send({ bootstrap_secret: BOOTSTRAP_SECRET, device_label: 'Bootstrap race pending browser' });
            expect(started.statusCode).toBe(200);
            ceremonyId = started.body.ceremony_id;

            const [users] = await pool.query("SELECT id FROM users WHERE is_active=1 AND role <> 'programmer' ORDER BY id");
            for (const user of users) await insertEligibleCredential(user.id, `Bootstrap race ready ${user.id}`);
            const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
            const enabled = await request(app)
                .post('/api/admin/device-access/mode')
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', ORIGIN)
                .send({ mode: 'enforced' });
            expect(enabled.statusCode).toBe(200);

            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const ceremony = await getCeremonyForUpdate(ceremonyId, conn);
                await expect(completeRegistration({
                    executor: conn,
                    ceremony,
                    publicKey: publicJwk(),
                    actorUserId: SEED.adminUser.id,
                })).rejects.toMatchObject({ publicCode: 'WEBAUTHN_BOOTSTRAP_UNAVAILABLE' });
                await conn.rollback();
            } finally {
                await conn.rollback().catch(() => {});
                conn.release();
            }

            const [[mode]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
            expect(mode.setting_value).toBe('enforced');
        } finally {
            await setAuthMode('staged');
            await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='webauthn_bootstrap_consumed'");
            await pool.query("DELETE FROM auth_sessions WHERE user_id IN (?, ?)", [SEED.adminUser.id, PROGRAMMER.id]);
            await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Bootstrap race %'");
            if (ceremonyId) await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=?", [ceremonyId]);
        }
    });

    it('returns an opaque prompt-free browser proof message in staged mode', async () => {
        await setAuthMode('staged');
        const result = await request(app)
            .post('/api/auth/webauthn/login/options')
            .set('Origin', ORIGIN)
            .send({ user_number: SEED.cashierUser.user_number });
        expect(result.statusCode).toBe(200);
        expect(result.body.message).toContain('posapp-browser-device-v1');
        expect(result.body.options).toBeUndefined();
    });

    it('requires registered users to use WebAuthn during staged rollout while preserving unregistered PIN login', async () => {
        await setAuthMode('staged');
        const credentialId = Buffer.from('staged-admin-credential');
        await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type,
                 backed_up, authenticator_attachment, transports, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', '["internal"]', ?)`,
            [SEED.adminUser.id, credentialId, credentialId, Buffer.from('public-key'), 'Staged admin']
        );

        const registered = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        expect(registered.statusCode).toBe(403);
        expect(registered.body.code).toBe('DEVICE_AUTH_REQUIRED');

        const unregistered = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(unregistered.statusCode).toBe(200);
        expect(unregistered.body.device_registration_required).toBe(true);
        await pool.query("DELETE FROM webauthn_credentials WHERE user_id=? AND device_label='Staged admin'", [SEED.adminUser.id]);
    });

    it('serializes PIN login behind an enforcement transition', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const blocker = await pool.getConnection();
        try {
            await blocker.beginTransaction();
            await blocker.query("UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'");
            const loginPromise = request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            const early = await Promise.race([
                loginPromise.then(() => 'completed'),
                new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
            ]);
            expect(early).toBe('blocked');
            await blocker.commit();
            const login = await loginPromise;
            expect(login.statusCode).toBe(200);
            expect(login.body.device_registration_required).toBe(false);
            expect((await request(app).get('/api/auth/me').set('Cookie', login.headers['set-cookie'][0])).statusCode).toBe(200);
        } finally {
            await blocker.rollback().catch(() => {});
            blocker.release();
            await setAuthMode('staged');
            await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
        }
    });

    it('never returns inactive users and no longer requires an OS authenticator handle', async () => {
        await pool.query('UPDATE users SET is_active=0 WHERE id=?', [SEED.cashierUser.id]);
        await expect(getActiveUser(SEED.cashierUser.id)).resolves.toBeNull();
        await pool.query('UPDATE users SET is_active=1 WHERE id=?', [SEED.cashierUser.id]);

        const started = await beginEnrollment({
            requestingUserId: SEED.adminUser.id,
            userId: SEED.cashierUser.id,
            deviceLabel: 'Cashier terminal',
        });
        expect(started.user.id).toBe(SEED.cashierUser.id);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled' WHERE id=?", [started.ceremony.id]);
    });

    it('atomically binds the first registered browser and revokes only that user PIN-only sessions', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const cashierSession = await createSession({ userId: SEED.cashierUser.id });
        const adminSession = await createSession({ userId: SEED.adminUser.id });
        const started = await beginEnrollment({
            requestingUserId: PROGRAMMER.id,
            userId: SEED.cashierUser.id,
            deviceLabel: 'Laptop browser',
        });
        const conn = await pool.getConnection();
        let registered;
        try {
            await conn.beginTransaction();
            const ceremony = await getCeremonyForUpdate(started.ceremony.id, conn);
            registered = await completeRegistration({
                executor: conn,
                ceremony,
                publicKey: publicJwk(),
                actorUserId: PROGRAMMER.id,
            });
            await conn.commit();
        } finally {
            await conn.rollback().catch(() => {});
            conn.release();
        }

        const [sessions] = await pool.query(
            'SELECT id, revoked_at, revoke_reason FROM auth_sessions WHERE id IN (?, ?) ORDER BY id',
            [cashierSession.id, adminSession.id]
        );
        expect(sessions.find(({ id }) => id === cashierSession.id)).toMatchObject({ revoke_reason: 'device_registered' });
        expect(sessions.find(({ id }) => id === cashierSession.id).revoked_at).not.toBeNull();
        expect(sessions.find(({ id }) => id === adminSession.id).revoked_at).toBeNull();
        const access = await listDeviceAccess();
        expect(access.users.find(({ id }) => id === SEED.cashierUser.id)).toMatchObject({
            active_device_count: 1,
            credentials: expect.arrayContaining([
                expect.objectContaining({ id: registered.credential.id, device_label: 'Laptop browser', status: 'active' }),
            ]),
        });

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [SEED.cashierUser.id, SEED.adminUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [registered.credential.id]);
    });

    it('does not treat a backed-up or multi-device credential as registered browser access', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const key = browserKey();
        const credentialId = Buffer.from('ineligible-browser-credential');
        await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type, backed_up, authenticator_attachment, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'multiDevice', 1, 'cross-platform', 'Synced key')`,
            [SEED.cashierUser.id, credentialId, credentialId, Buffer.from(JSON.stringify(key.publicJwk))]
        );

        const pinLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(pinLogin.statusCode).toBe(200);
        expect(pinLogin.body.device_registration_required).toBe(true);
        const access = await listDeviceAccess();
        expect(access.users.find(({ id }) => id === SEED.cashierUser.id).active_device_count).toBe(0);

        await setAuthMode('enforced');
        const options = await request(app).post('/api/auth/webauthn/login/options').set('Origin', ORIGIN).send({ user_number: SEED.cashierUser.user_number });
        const rejected = await request(app)
            .post('/api/auth/webauthn/login/verify')
            .set('Origin', ORIGIN)
            .send({ ceremony_id: options.body.ceremony_id, signature: key.sign(options.body.message) });
        expect(rejected.statusCode).toBe(401);
        expect(rejected.body.code).toBe('WEBAUTHN_AUTHENTICATION_FAILED');

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
    });

    it('does not allow generic settings to mutate device-auth authority', async () => {
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const settings = await request(app)
            .get('/api/system/settings')
            .set('Cookie', login.headers['set-cookie'][0]);
        expect(settings.statusCode).toBe(200);
        expect(settings.body.staff_device_auth_mode).toBeUndefined();
        expect(settings.body.webauthn_bootstrap_consumed).toBeUndefined();
        const response = await request(app)
            .post('/api/system/settings')
            .set('Cookie', login.headers['set-cookie'][0])
            .send({ staff_device_auth_mode: 'enforced' });
        expect(response.statusCode).toBe(400);
        const [[setting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
        expect(setting.setting_value).toBe('staged');
    });

    it('does not expose PIN-only session details in the device inventory', async () => {
        await setAuthMode('staged');
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        expect(login.statusCode).toBe(200);
        const response = await listDeviceAccess();
        expect(response.unbound_sessions).toBeUndefined();
    });

    it('binds a newly detected cashier browser only after registered-admin approval', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE terminal_state='pending'");

        const adminKey = browserKey();
        const adminCredentialId = Buffer.from('approval-admin-browser');
        const [adminCredential] = await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type,
                 backed_up, authenticator_attachment, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', 'Approval admin')`,
            [SEED.adminUser.id, adminCredentialId, adminCredentialId, Buffer.from(JSON.stringify(adminKey.publicJwk))]
        );
        const adminSession = await createSession({ userId: SEED.adminUser.id, credentialId: adminCredential.insertId, webauthnVerifiedAt: new Date() });
        const adminCookie = `pos_token=${adminSession.rawToken}`;

        const cashierLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(cashierLogin.statusCode).toBe(200);
        expect(cashierLogin.body.device_registration_required).toBe(true);
        const cashierCookie = cashierLogin.headers['set-cookie'][0];
        const cashierKey = browserKey();

        const options = await request(app)
            .post('/api/auth/webauthn/device-request/options')
            .set('Cookie', cashierCookie)
            .set('Origin', ORIGIN)
            .send({ device_label: 'Chrome on Windows', public_key: cashierKey.publicJwk });
        expect(options.statusCode).toBe(200);

        const submitted = await request(app)
            .post('/api/auth/webauthn/device-request/submit')
            .set('Cookie', cashierCookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id, public_key: cashierKey.publicJwk, signature: cashierKey.sign(options.body.message) });
        expect(submitted.body).toMatchObject({ success: true, state: 'pending' });
        expect(deviceAccessEvents()).toBe(1);

        const replacementKey = browserKey();
        const replaced = await request(app)
            .post('/api/auth/webauthn/device-request/submit')
            .set('Cookie', cashierCookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id, public_key: replacementKey.publicJwk, signature: replacementKey.sign(options.body.message) });
        expect(replaced.statusCode).toBe(409);
        expect(replaced.body.code).toBe('BROWSER_DEVICE_REQUEST_INVALID');

        const replacementOptions = await request(app)
            .post('/api/auth/webauthn/device-request/options')
            .set('Cookie', cashierCookie)
            .set('Origin', ORIGIN)
            .send({ device_label: 'Different browser', public_key: replacementKey.publicJwk });
        expect(replacementOptions.statusCode).toBe(409);
        expect(replacementOptions.body.code).toBe('WEBAUTHN_ENROLLMENT_PENDING');

        const beforeApproval = await listDeviceAccess();
        expect(beforeApproval.users.find(({ id }) => id === SEED.cashierUser.id).pending_enrollment)
            .toMatchObject({ id: options.body.request_id, browser_requested: true, device_label: 'Chrome on Windows' });
        const [[beforeCredential]] = await pool.query("SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id=? AND status='active'", [SEED.cashierUser.id]);
        expect(Number(beforeCredential.count)).toBe(0);

        const selfApproval = await request(app)
            .post(`/api/admin/device-access/enrollments/${options.body.request_id}/approve`)
            .set('Cookie', cashierCookie)
            .set('Origin', ORIGIN)
            .send({});
        expect(selfApproval.statusCode).toBe(403);
        const [[stillPending]] = await pool.query(
            'SELECT requesting_user_id FROM webauthn_ceremonies WHERE id=?',
            [options.body.request_id]
        );
        expect(stillPending.requesting_user_id).toBeNull();

        const unboundAdmin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        expect(unboundAdmin.statusCode).toBe(403);
        expect(deviceAccessEvents()).toBe(1);

        const approved = await request(app)
            .post(`/api/admin/device-access/enrollments/${options.body.request_id}/approve`)
            .set('Cookie', adminCookie)
            .set('Origin', ORIGIN)
            .send({});
        expect(approved.statusCode).toBe(200);
        expect(deviceAccessEvents()).toBe(2);

        const refreshedLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(refreshedLogin.statusCode).toBe(200);
        const refreshedCookie = refreshedLogin.headers['set-cookie'][0];
        const resumedOptions = await request(app)
            .post('/api/auth/webauthn/device-request/options')
            .set('Cookie', refreshedCookie)
            .set('Origin', ORIGIN)
            .send({ device_label: 'Chrome on Windows', public_key: cashierKey.publicJwk });
        expect(resumedOptions.body.request_id).toBe(options.body.request_id);
        // Resuming pushes the request's expiry out, which the open panel must re-read.
        expect(deviceAccessEvents()).toBe(3);
        const resumed = await request(app)
            .post('/api/auth/webauthn/device-request/submit')
            .set('Cookie', refreshedCookie)
            .set('Origin', ORIGIN)
            .send({ request_id: resumedOptions.body.request_id, public_key: cashierKey.publicJwk, signature: cashierKey.sign(resumedOptions.body.message) });
        expect(resumed.body).toMatchObject({ success: true, state: 'approved' });

        const status = await request(app)
            .post('/api/auth/webauthn/device-request/status')
            .set('Cookie', refreshedCookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id });
        expect(status.body).toMatchObject({ success: true, state: 'approved' });

        const completed = await request(app)
            .post('/api/auth/webauthn/device-request/complete')
            .set('Cookie', refreshedCookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id, public_key: cashierKey.publicJwk, signature: cashierKey.sign(status.body.message) });
        expect(completed.statusCode).toBe(200);
        expect(completed.body).toMatchObject({ success: true, user: { id: SEED.cashierUser.id, role: 'cashier' } });
        expect(completed.headers['set-cookie']?.[0]).toContain('pos_token=');
        expect(deviceAccessEvents()).toBe(4);

        const [[credential]] = await pool.query("SELECT id, device_label FROM webauthn_credentials WHERE user_id=? AND status='active'", [SEED.cashierUser.id]);
        expect(credential.device_label).toBe('Chrome on Windows');
        const visible = await listDeviceAccess();
        expect(visible.users.find(({ id }) => id === SEED.cashierUser.id)).toMatchObject({
            active_device_count: 1,
            credentials: expect.arrayContaining([
                expect.objectContaining({ id: credential.id, device_label: 'Chrome on Windows', status: 'active' }),
            ]),
        });
        const legacyLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(legacyLogin.body.code).toBe('DEVICE_AUTH_REQUIRED');

        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id IN (?, ?)', [SEED.adminUser.id, SEED.cashierUser.id]);
    });

    it('lets the waiting browser cancel its own approval request', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        const cookie = login.headers['set-cookie'][0];
        const key = browserKey();
        const missingKey = await request(app)
            .post('/api/auth/webauthn/device-request/options')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ device_label: 'Invalid browser' });
        expect(missingKey.statusCode).toBe(400);
        expect(missingKey.body.code).toBe('BROWSER_DEVICE_PUBLIC_KEY_INVALID');
        const options = await request(app)
            .post('/api/auth/webauthn/device-request/options')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ device_label: 'Cancelled browser', public_key: key.publicJwk });
        await request(app)
            .post('/api/auth/webauthn/device-request/submit')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id, public_key: key.publicJwk, signature: key.sign(options.body.message) });

        const cancelled = await request(app)
            .post('/api/auth/webauthn/device-request/cancel')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ request_id: options.body.request_id });
        expect(cancelled.body).toMatchObject({ success: true });
        expect(deviceAccessEvents()).toBe(2);
        const [[ceremony]] = await pool.query('SELECT terminal_state FROM webauthn_ceremonies WHERE id=?', [options.body.request_id]);
        expect(ceremony.terminal_state).toBe('cancelled');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
    });

    it('cannot upgrade an unbound session revoked while approval completion is waiting', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const key = browserKey();
        const session = await createSession({ userId: SEED.cashierUser.id });
        const created = await createCeremony({ flow: 'enrollment_registration', userId: SEED.cashierUser.id, intendedDeviceLabel: 'Revoked browser' });
        await pool.query(
            'UPDATE webauthn_ceremonies SET enrollment_token_hash=?, requesting_user_id=? WHERE id=?',
            [publicKeyFingerprint(key.publicJwk), SEED.adminUser.id, created.id]
        );
        const ceremony = await getCeremonyForUpdate(created.id, pool);
        const revoker = await pool.getConnection();
        try {
            await revoker.beginTransaction();
            await revoker.query("UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP, revoke_reason='test_race' WHERE token_hash=?", [hashSessionToken(session.rawToken)]);
            const completionPromise = request(app)
                .post('/api/auth/webauthn/device-request/complete')
                .set('Cookie', `pos_token=${session.rawToken}`)
                .set('Origin', ORIGIN)
                .send({ request_id: created.id, public_key: key.publicJwk, signature: key.sign(proofMessage(ceremony, ORIGIN)) })
                .then((response) => response);
            await new Promise((resolve) => setTimeout(resolve, 100));
            await revoker.commit();
            const completed = await completionPromise;
            expect(completed.statusCode).not.toBe(200);
            const [[credential]] = await pool.query("SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id=? AND status='active'", [SEED.cashierUser.id]);
            expect(Number(credential.count)).toBe(0);
        } finally {
            await revoker.rollback().catch(() => {});
            revoker.release();
            await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.cashierUser.id]);
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=? AND terminal_state='pending'", [created.id]);
        }
    });

    it('requires device proof for a registered user while an unregistered user keeps PIN login', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const credentialId = await insertEligibleCredential(SEED.cashierUser.id, 'Enforced cashier browser');
        const before = await pool.query('SELECT COUNT(*) AS count FROM auth_sessions');
        const response = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(response.statusCode).toBe(403);
        expect(response.body.code).toBe('DEVICE_AUTH_REQUIRED');
        expect(response.body.success).toBe(false);
        const after = await pool.query('SELECT COUNT(*) AS count FROM auth_sessions');
        expect(Number(after[0][0].count)).toBe(Number(before[0][0].count));

        const unknown = await request(app).post('/api/auth/login').send({ user_number: '999999' });
        expect(unknown.statusCode).toBe(401);
        expect(unknown.body).toMatchObject({ success: false, message: 'Invalid user number.' });
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [credentialId]);
    });

    it('allows only the hidden programmer to use PIN login and device administration during enforcement', async () => {
        await setAuthMode('enforced');
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);

        const login = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        expect(login.statusCode).toBe(200);
        expect(login.body.user).toMatchObject({ id: PROGRAMMER.id, role: 'programmer' });
        const cookie = login.headers['set-cookie'][0];

        const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
        expect(me.statusCode).toBe(200);
        expect(me.body.user.role).toBe('programmer');

        const deviceAccess = await request(app).get('/api/admin/device-access').set('Cookie', cookie);
        expect(deviceAccess.statusCode).toBe(200);
        expect(deviceAccess.body.users.some((user) => user.role === 'programmer')).toBe(false);

        const selfEnrollment = await request(app)
            .post('/api/admin/device-access/enrollments')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ user_id: PROGRAMMER.id, action: 'add', device_label: 'Forbidden programmer browser' });
        try {
            expect(selfEnrollment.statusCode).toBe(404);
            expect(selfEnrollment.body.code).toBe('WEBAUTHN_USER_NOT_FOUND');
        } finally {
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [PROGRAMMER.id]);
        }

        const enrollment = await request(app)
            .post('/api/admin/device-access/enrollments')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ user_id: SEED.cashierUser.id, action: 'add', device_label: 'Programmer replacement' });
        expect(enrollment.statusCode).toBe(201);
        expect(deviceAccessEvents()).toBe(1);

        const rotateRecovery = await request(app)
            .post('/api/admin/device-access/recovery-codes/rotate')
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ user_id: SEED.adminUser.id });
        expect(rotateRecovery.statusCode).toBe(404);

        const recoveryOptions = await request(app)
            .post('/api/auth/webauthn/recovery/options')
            .set('Origin', ORIGIN)
            .send({ user_number: SEED.adminUser.user_number, recovery_code: 'unused', manager_pin: SEED.adminUser.pin, device_label: 'Removed' });
        expect(recoveryOptions.statusCode).toBe(404);

        const [[audit]] = await pool.query("SELECT COUNT(*) AS count FROM audit_events WHERE event_type='programmer_login' AND user_id=?", [PROGRAMMER.id]);
        expect(Number(audit.count)).toBeGreaterThan(0);

        const replacementLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        expect(replacementLogin.statusCode).toBe(200);
        expect((await request(app).get('/api/auth/me').set('Cookie', cookie)).statusCode).toBe(401);
        expect((await request(app).get('/api/auth/me').set('Cookie', replacementLogin.headers['set-cookie'][0])).statusCode).toBe(200);

        await pool.query('UPDATE users SET is_active=0 WHERE id=?', [PROGRAMMER.id]);
        const inactiveLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        expect(inactiveLogin.statusCode).toBe(401);
        expect(inactiveLogin.body.message).toBe('Invalid user number.');
        await pool.query('UPDATE users SET is_active=1 WHERE id=?', [PROGRAMMER.id]);

        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
    });

    it('rejects a programmer ceremony created behind the normal enrollment route', async () => {
        const created = await createCeremony({
            flow: 'enrollment_registration',
            userId: PROGRAMMER.id,
            requestingUserId: PROGRAMMER.id,
            enrollmentToken: 'forged-programmer-enrollment',
            intendedDeviceLabel: 'Forged programmer browser'
        });
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const ceremony = await getCeremonyForUpdate(created.id, conn);
            await expect(completeRegistration({
                executor: conn,
                ceremony,
                publicKey: publicJwk(),
                actorUserId: PROGRAMMER.id
            })).rejects.toMatchObject({ publicCode: 'WEBAUTHN_USER_NOT_FOUND' });
            await conn.rollback();
        } finally {
            await conn.rollback().catch(() => {});
            conn.release();
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=?", [created.id]);
            await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [PROGRAMMER.id]);
        }
    });

    it('serializes two registrations racing for the final administrator slot', async () => {
        await pool.query("DELETE FROM webauthn_credentials WHERE user_id=? AND device_label LIKE 'Race %'", [SEED.adminUser.id]);
        const existingId = Buffer.from('race-existing-admin');
        await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type, backed_up,
                 authenticator_attachment, transports, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', '[\"internal\"]', 'Race existing')`,
            [SEED.adminUser.id, existingId, existingId, Buffer.from(JSON.stringify(publicJwk()))]
        );
        const ceremonies = await Promise.all(['Race A', 'Race B'].map((label) => createCeremony({
            flow: 'enrollment_registration',
            userId: SEED.adminUser.id,
            requestingUserId: SEED.adminUser.id,
            intendedDeviceLabel: label,
        })));

        async function register(ceremony, marker) {
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const locked = await getCeremonyForUpdate(ceremony.id, conn);
                const result = await completeRegistration({
                    executor: conn,
                    ceremony: locked,
                    publicKey: publicJwk(),
                    actorUserId: SEED.adminUser.id,
                });
                await conn.commit();
                return result;
            } catch (error) {
                await conn.rollback().catch(() => {});
                throw error;
            } finally { conn.release(); }
        }

        const settled = await Promise.allSettled(ceremonies.map((ceremony, index) => register(ceremony, index)));
        expect(settled.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
        expect(settled.filter(({ status }) => status === 'rejected')).toHaveLength(1);
        expect(settled.find(({ status }) => status === 'rejected').reason.publicCode).toBe('WEBAUTHN_DEVICE_LIMIT_REACHED');
        const [[active]] = await pool.query("SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id=? AND status='active' AND device_label LIKE 'Race %'", [SEED.adminUser.id]);
        expect(Number(active.count)).toBe(2);

        await pool.query("DELETE FROM webauthn_credentials WHERE user_id=? AND device_label LIKE 'Race %'", [SEED.adminUser.id]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.adminUser.id]);
    });

    it('does not spend two administrator slots on the same browser key', async () => {
        const key = publicJwk();
        const rawId = Buffer.from('duplicate-browser-admin');
        const [inserted] = await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type, backed_up,
                 authenticator_attachment, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', 'Duplicate existing')`,
            [SEED.adminUser.id, rawId, rawId, Buffer.from(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }))]
        );
        const created = await createCeremony({
            flow: 'enrollment_registration',
            userId: SEED.adminUser.id,
            requestingUserId: SEED.adminUser.id,
            intendedDeviceLabel: 'Duplicate second slot',
        });
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const ceremony = await getCeremonyForUpdate(created.id, conn);
            await expect(completeRegistration({ executor: conn, ceremony, publicKey: key, actorUserId: SEED.adminUser.id }))
                .rejects.toMatchObject({ publicCode: 'BROWSER_DEVICE_ALREADY_REGISTERED' });
            await conn.rollback();
        } finally { conn.release(); }

        const [[active]] = await pool.query("SELECT COUNT(*) AS count FROM webauthn_credentials WHERE user_id=? AND status='active' AND public_key=?", [SEED.adminUser.id, Buffer.from(JSON.stringify({ kty: key.kty, crv: key.crv, x: key.x, y: key.y }))]);
        expect(Number(active.count)).toBe(1);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [inserted.insertId]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=?", [created.id]);
    });

    it('keeps the old cashier device active when replacement verification is rejected', async () => {
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        const oldRawId = Buffer.from('safe-replace-old');
        const [inserted] = await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type, backed_up,
                 authenticator_attachment, transports, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'singleDevice', 0, 'platform', '[\"internal\"]', 'Safe old')`,
            [SEED.cashierUser.id, oldRawId, oldRawId, Buffer.from(JSON.stringify(publicJwk()))]
        );
        const started = await beginEnrollment({
            requestingUserId: SEED.adminUser.id,
            userId: SEED.cashierUser.id,
            deviceLabel: 'Unsafe synced replacement',
            replacementCredentialId: inserted.insertId,
        });
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const ceremony = await getCeremonyForUpdate(started.ceremony.id, conn);
            await expect(completeRegistration({
                executor: conn,
                ceremony,
                publicKey: { kty: 'EC', crv: 'P-384', x: 'bad', y: 'bad' },
                actorUserId: SEED.adminUser.id,
            })).rejects.toMatchObject({ publicCode: 'BROWSER_DEVICE_PUBLIC_KEY_INVALID' });
            await conn.rollback();
        } finally { conn.release(); }

        const [[old]] = await pool.query('SELECT status, revoked_at FROM webauthn_credentials WHERE id=?', [inserted.insertId]);
        expect(old).toMatchObject({ status: 'active', revoked_at: null });
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [inserted.insertId]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=?", [started.ceremony.id]);
    });

    it('rejects replacing an active but ineligible credential at start and completion', async () => {
        await setAuthMode('staged');
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);

        const eligibleId = await insertEligibleCredential(SEED.cashierUser.id, 'Eligible cashier browser');
        const rawId = Buffer.from('ineligible-replacement-target');
        const [ineligible] = await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type, backed_up,
                 authenticator_attachment, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'multiDevice', 1, 'cross-platform', 'Ineligible replacement')`,
            [SEED.cashierUser.id, rawId, rawId, Buffer.from(JSON.stringify(publicJwk()))]
        );

        try {
            await expect(beginEnrollment({
                requestingUserId: SEED.adminUser.id,
                userId: SEED.cashierUser.id,
                deviceLabel: 'Invalid replacement start',
                replacementCredentialId: ineligible.insertId,
            })).rejects.toMatchObject({ publicCode: 'WEBAUTHN_REPLACEMENT_INVALID' });

            const created = await createCeremony({
                flow: 'enrollment_registration',
                userId: SEED.cashierUser.id,
                requestingUserId: SEED.adminUser.id,
                replacementCredentialId: ineligible.insertId,
                intendedDeviceLabel: 'Forged invalid replacement',
            });
            const conn = await pool.getConnection();
            try {
                await conn.beginTransaction();
                const ceremony = await getCeremonyForUpdate(created.id, conn);
                await expect(completeRegistration({
                    executor: conn,
                    ceremony,
                    publicKey: publicJwk(),
                    actorUserId: SEED.adminUser.id,
                })).rejects.toMatchObject({ publicCode: 'WEBAUTHN_REPLACEMENT_INVALID' });
                await conn.rollback();
            } finally { conn.release(); }

            const [[eligible]] = await pool.query(
                `SELECT COUNT(*) AS count FROM webauthn_credentials
                  WHERE user_id=? AND ${ELIGIBLE_CREDENTIAL_SQL}`,
                [SEED.cashierUser.id]
            );
            expect(Number(eligible.count)).toBe(1);
        } finally {
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
            await pool.query('DELETE FROM webauthn_credentials WHERE id IN (?, ?)', [eligibleId, ineligible.insertId]);
        }
    });

    it('allows only the programmer to change the global device-access mode', async () => {
        await setAuthMode('enforced');
        const adminCredentialId = await insertEligibleCredential(SEED.adminUser.id, 'Mode authority admin');
        const adminSession = await createSession({
            userId: SEED.adminUser.id,
            credentialId: adminCredentialId,
            webauthnVerifiedAt: new Date(),
        });

        const denied = await request(app)
            .post('/api/admin/device-access/mode')
            .set('Cookie', `pos_token=${adminSession.rawToken}`)
            .set('Origin', ORIGIN)
            .send({ mode: 'disabled' });

        expect(denied.statusCode).toBe(403);
        expect(denied.body.code).toBe('DEVICE_AUTH_PROGRAMMER_REQUIRED');
        expect(deviceAccessEvents()).toBe(0);
        const [[setting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
        expect(setting.setting_value).toBe('enforced');

        await pool.query('DELETE FROM auth_sessions WHERE id=?', [adminSession.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [adminCredentialId]);
        await setAuthMode('staged');
    });

    it('keeps device mutations programmer-only while device access is disabled', async () => {
        await setAuthMode('disabled');
        const adminCredentialId = await insertEligibleCredential(SEED.adminUser.id, 'Disabled-mode administrator');
        const adminSession = await createSession({
            userId: SEED.adminUser.id,
            credentialId: adminCredentialId,
            webauthnVerifiedAt: new Date(),
        });

        const denied = await request(app)
            .post('/api/admin/device-access/enrollments')
            .set('Cookie', `pos_token=${adminSession.rawToken}`)
            .set('Origin', ORIGIN)
            .send({ user_id: SEED.cashierUser.id, action: 'add', device_label: 'Disabled-mode attempt' });

        expect(denied.statusCode).toBe(403);
        expect(denied.body.code).toBe('DEVICE_AUTH_PROGRAMMER_REQUIRED');

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.adminUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [adminCredentialId]);
    });

    it('rejects an administrator enrollment that completes after device access is disabled', async () => {
        await setAuthMode('staged');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const ceremony = await createCeremony({
            flow: 'enrollment_registration',
            userId: SEED.cashierUser.id,
            requestingUserId: SEED.adminUser.id,
            intendedDeviceLabel: 'Disabled completion rejected',
        });
        await setAuthMode('disabled');

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const locked = await getCeremonyForUpdate(ceremony.id, conn);
            await expect(completeRegistration({
                executor: conn,
                ceremony: locked,
                publicKey: publicJwk(),
                actorUserId: SEED.adminUser.id,
            })).rejects.toMatchObject({ publicCode: 'DEVICE_AUTH_PROGRAMMER_REQUIRED' });
            await conn.rollback();
        } finally {
            await conn.rollback().catch(() => {});
            conn.release();
            await setAuthMode('staged');
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE id=?", [ceremony.id]);
            await pool.query("DELETE FROM webauthn_credentials WHERE device_label='Disabled completion rejected'");
        }
    });

    it('lets a programmer-owned enrollment complete while access stays disabled', async () => {
        await setAuthMode('disabled');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const ceremony = await createCeremony({
            flow: 'enrollment_registration',
            userId: SEED.cashierUser.id,
            requestingUserId: PROGRAMMER.id,
            intendedDeviceLabel: 'Programmer disabled setup',
        });

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            const locked = await getCeremonyForUpdate(ceremony.id, conn);
            await completeRegistration({
                executor: conn,
                ceremony: locked,
                publicKey: publicJwk(),
                actorUserId: PROGRAMMER.id,
            });
            await conn.commit();
            const [[mode]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
            expect(mode.setting_value).toBe('disabled');
        } finally {
            await conn.rollback().catch(() => {});
            conn.release();
            await setAuthMode('staged');
            await pool.query("DELETE FROM webauthn_credentials WHERE device_label='Programmer disabled setup'");
        }
    });

    it('does not authorize the device-access page from a stale disabled-mode cache', async () => {
        await setAuthMode('disabled');
        const adminLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number });
        const cookie = adminLogin.headers['set-cookie'][0];
        expect((await request(app).get('/api/admin/device-access').set('Cookie', cookie)).statusCode).toBe(200);

        await pool.query("UPDATE settings SET setting_value='enforced' WHERE setting_key='staff_device_auth_mode'");
        const denied = await request(app).get('/api/admin/device-access').set('Cookie', cookie);
        expect(denied.statusCode).toBe(401);
        expect(denied.body.code).toBe('WEBAUTHN_STEP_UP_REQUIRED');

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [SEED.adminUser.id]);
    });

    it('serializes an admitted admin device mutation before programmer disable', async () => {
        await setAuthMode('enforced');
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        const adminCredentialId = await insertEligibleCredential(SEED.adminUser.id, 'Disable race administrator');
        const adminSession = await createSession({
            userId: SEED.adminUser.id,
            credentialId: adminCredentialId,
            webauthnVerifiedAt: new Date(),
        });
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        const blocker = await pool.getConnection();
        let enrollmentPromise;
        let disablePromise;
        let earlyEnrollmentResult;
        try {
            await blocker.beginTransaction();
            await blocker.query('SELECT id FROM users WHERE id=? FOR UPDATE', [SEED.cashierUser.id]);

            enrollmentPromise = request(app)
                .post('/api/admin/device-access/enrollments')
                .set('Cookie', `pos_token=${adminSession.rawToken}`)
                .set('Origin', ORIGIN)
                .send({ user_id: SEED.cashierUser.id, action: 'add', device_label: 'Disable race browser' })
                .then((response) => {
                    earlyEnrollmentResult = { statusCode: response.statusCode, body: response.body };
                    return response;
                });
            let mutationOwnsMode = false;
            for (let attempt = 0; attempt < 40 && !mutationOwnsMode; attempt += 1) {
                const probe = await pool.getConnection();
                try {
                    await probe.beginTransaction();
                    await probe.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode' LIMIT 1 FOR UPDATE NOWAIT");
                } catch (error) {
                    mutationOwnsMode = Number(error?.errno) === 1205;
                } finally {
                    await probe.rollback().catch(() => {});
                    probe.release();
                }
                if (!mutationOwnsMode) await new Promise((resolve) => setTimeout(resolve, 25));
            }
            expect(earlyEnrollmentResult).toBeUndefined();
            expect(mutationOwnsMode).toBe(true);

            disablePromise = request(app)
                .post('/api/admin/device-access/mode')
                .set('Host', 'localhost:3001')
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', ORIGIN)
                .send({ mode: 'disabled' });
            const earlyDisable = await Promise.race([
                disablePromise.then((response) => ({ statusCode: response.statusCode, body: response.body })),
                new Promise((resolve) => setTimeout(() => resolve('blocked'), 150)),
            ]);
            expect(earlyDisable).toBe('blocked');

            await blocker.commit();
            expect((await enrollmentPromise).statusCode).toBe(201);
            expect((await disablePromise).statusCode).toBe(200);
            const [[mode]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
            expect(mode.setting_value).toBe('disabled');
        } finally {
            await blocker.rollback().catch(() => {});
            blocker.release();
            await Promise.allSettled([enrollmentPromise, disablePromise].filter(Boolean));
            await setAuthMode('staged');
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
            await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [SEED.adminUser.id, PROGRAMMER.id]);
            await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [adminCredentialId]);
        }
    });

    it('lets the programmer disable enforcement so revoked users can use PIN login anywhere', async () => {
        await setAuthMode('enforced');
        await pool.query("UPDATE settings SET setting_value='1' WHERE setting_key='webauthn_bootstrap_consumed'");
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        expect(programmerLogin.statusCode).toBe(200);

        const disabled = await request(app)
            .post('/api/admin/device-access/mode')
            .set('Host', 'localhost:3001')
            .set('Cookie', programmerLogin.headers['set-cookie'][0])
            .set('Origin', ORIGIN)
            .send({ mode: 'disabled' });

        expect(disabled.statusCode).toBe(200);
        expect(disabled.body).toMatchObject({ success: true, mode: 'disabled' });
        const pinLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(pinLogin.statusCode).toBe(200);
        expect(pinLogin.body.device_registration_required).toBe(false);
        const access = await request(app)
            .get('/api/admin/device-access')
            .set('Cookie', programmerLogin.headers['set-cookie'][0]);
        expect(access.body.bootstrap_consumed).toBe(true);
        const [[audit]] = await pool.query(
            "SELECT old_value, new_value FROM audit_events WHERE event_type='device_auth_mode_changed' ORDER BY id DESC LIMIT 1"
        );
        expect(JSON.parse(audit.old_value)).toEqual({ mode: 'enforced' });
        expect(JSON.parse(audit.new_value)).toEqual({ mode: 'disabled' });

        await setAuthMode('staged');
        await pool.query("UPDATE settings SET setting_value='0' WHERE setting_key='webauthn_bootstrap_consumed'");
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [PROGRAMMER.id, SEED.cashierUser.id]);
    });

    it('keeps the programmer off-switch available when WebAuthn configuration is broken', async () => {
        const previousOrigins = process.env.DEVICE_AUTH_ALLOWED_ORIGINS;
        await setAuthMode('enforced');
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        process.env.DEVICE_AUTH_ALLOWED_ORIGINS = '';
        try {
            const rejected = await request(app)
                .post('/api/admin/device-access/mode')
                .set('Host', 'localhost:3001')
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', 'http://attacker.example')
                .send({ mode: 'disabled' });
            expect(rejected.statusCode).toBe(403);
            expect(rejected.body.code).toBe('DEVICE_AUTH_ORIGIN_INVALID');

            const disabled = await request(app)
                .post('/api/admin/device-access/mode')
                .set('Host', 'localhost:80')
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', 'http://localhost')
                .send({ mode: 'disabled' });

            expect(disabled.statusCode).toBe(200);
            expect(disabled.body).toMatchObject({ success: true, mode: 'disabled' });
        } finally {
            process.env.DEVICE_AUTH_ALLOWED_ORIGINS = previousOrigins;
            await setAuthMode('staged');
            await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        }
    });

    it('enables per-user enforcement while users without a registered browser remain PIN-only', async () => {
        await setAuthMode('disabled');
        await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Incomplete readiness %'");
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const adminCredentialId = await insertEligibleCredential(SEED.adminUser.id, 'Incomplete readiness admin');
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });

        const enabled = await request(app)
            .post('/api/admin/device-access/mode')
            .set('Cookie', programmerLogin.headers['set-cookie'][0])
            .set('Origin', ORIGIN)
            .send({ mode: 'enforced' });

        expect(enabled.statusCode).toBe(200);
        expect(enabled.body).toMatchObject({ success: true, mode: 'enforced' });
        const [[setting]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
        expect(setting.setting_value).toBe('enforced');
        const cashierLogin = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(cashierLogin.statusCode).toBe(200);
        expect(cashierLogin.body.device_registration_required).toBe(false);
        expect(cashierLogin.body.device_registration_suggested).toBe(true);

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [adminCredentialId]);
    });

    it('detects an unbound browser after enforced PIN login and binds it after approval without blocking work', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [PROGRAMMER.id, SEED.cashierUser.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        const key = browserKey();

        try {
            const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
            expect(login.statusCode).toBe(200);
            expect(login.body).toMatchObject({
                success: true,
                device_registration_required: false,
                device_registration_suggested: true,
            });
            const cashierCookie = login.headers['set-cookie'][0];

            const options = await request(app)
                .post('/api/auth/webauthn/device-request/options')
                .set('Cookie', cashierCookie)
                .set('Origin', ORIGIN)
                .send({ device_label: 'Detected cashier laptop', public_key: key.publicJwk });
            expect(options.statusCode).toBe(200);

            const submitted = await request(app)
                .post('/api/auth/webauthn/device-request/submit')
                .set('Cookie', cashierCookie)
                .set('Origin', ORIGIN)
                .send({ request_id: options.body.request_id, public_key: key.publicJwk, signature: key.sign(options.body.message) });
            expect(submitted.body).toMatchObject({ success: true, state: 'pending' });

            const detected = await listDeviceAccess();
            expect(detected.users.find(({ id }) => id === SEED.cashierUser.id).pending_enrollment)
                .toMatchObject({ id: options.body.request_id, device_label: 'Detected cashier laptop', browser_requested: true });

            const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
            const approved = await request(app)
                .post(`/api/admin/device-access/enrollments/${options.body.request_id}/approve`)
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', ORIGIN)
                .send({});
            expect(approved.statusCode).toBe(200);

            const status = await request(app)
                .post('/api/auth/webauthn/device-request/status')
                .set('Cookie', cashierCookie)
                .set('Origin', ORIGIN)
                .send({ request_id: options.body.request_id });
            expect(status.body).toMatchObject({ success: true, state: 'approved' });

            const completed = await request(app)
                .post('/api/auth/webauthn/device-request/complete')
                .set('Cookie', cashierCookie)
                .set('Origin', ORIGIN)
                .send({ request_id: options.body.request_id, public_key: key.publicJwk, signature: key.sign(status.body.message) });
            expect(completed.statusCode).toBe(200);
            expect(completed.body.user.device_auth_mode).toBe('enforced');
            expect(completed.headers['set-cookie']?.[0]).toContain('pos_token=');
            const boundCookie = completed.headers['set-cookie'][0];
            const me = await request(app).get('/api/auth/me').set('Cookie', boundCookie);
            expect(me.statusCode).toBe(200);
            expect(me.body.user.id).toBe(SEED.cashierUser.id);

            const bound = await listDeviceAccess();
            expect(bound.users.find(({ id }) => id === SEED.cashierUser.id)).toMatchObject({
                active_device_count: 1,
                pending_enrollment: null,
                credentials: expect.arrayContaining([
                    expect.objectContaining({ device_label: 'Detected cashier laptop', status: 'active' }),
                ]),
            });
        } finally {
            await setAuthMode('staged');
            await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [PROGRAMMER.id, SEED.cashierUser.id]);
            await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
            await pool.query("UPDATE webauthn_ceremonies SET terminal_state='cancelled', consumed_at=CURRENT_TIMESTAMP WHERE user_id=? AND terminal_state='pending'", [SEED.cashierUser.id]);
        }
    });

    it('does not revoke PIN-only sessions for users who remain unbound when enforcement is enabled', async () => {
        await setAuthMode('disabled');
        await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Re-enable %'");
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const unbound = await createSession({ userId: SEED.cashierUser.id });
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });

        const enabled = await request(app)
            .post('/api/admin/device-access/mode')
            .set('Cookie', programmerLogin.headers['set-cookie'][0])
            .set('Origin', ORIGIN)
            .send({ mode: 'enforced' });

        expect(enabled.statusCode).toBe(200);
        expect(enabled.body).toMatchObject({ success: true, mode: 'enforced' });
        const [[session]] = await pool.query('SELECT revoked_at, revoke_reason FROM auth_sessions WHERE id=?', [unbound.id]);
        expect(session.revoked_at).toBeNull();
        expect(session.revoke_reason).toBeNull();
        await expect(require('../../services/staffSessions').findActiveSession(unbound.rawToken)).resolves.toMatchObject({ user_id: SEED.cashierUser.id });

        await setAuthMode('staged');
        await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Re-enable %'");
        await pool.query('DELETE FROM auth_sessions WHERE user_id IN (?, ?)', [PROGRAMMER.id, SEED.cashierUser.id]);
    });

    it('revokes the last valid browser and returns that user to PIN-only access', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const credentialId = await insertEligibleCredential(SEED.cashierUser.id, 'Last enforced browser');
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });

        const revoked = await request(app)
            .post(`/api/admin/device-access/credentials/${credentialId}/revoke`)
            .set('Cookie', programmerLogin.headers['set-cookie'][0])
            .set('Origin', ORIGIN)
            .send({ reason: 'terminal replaced' });

        expect(revoked.statusCode).toBe(200);
        const [[credential]] = await pool.query('SELECT status FROM webauthn_credentials WHERE id=?', [credentialId]);
        expect(credential.status).toBe('revoked');
        const login = await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number });
        expect(login.statusCode).toBe(200);
        expect(login.body.device_registration_required).toBe(false);

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [credentialId]);
    });

    it('still revokes an ineligible credential while preserving the last valid browser', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const validCredentialId = await insertEligibleCredential(SEED.cashierUser.id, 'Only valid browser');
        const rawId = crypto.randomBytes(24);
        const [inserted] = await pool.query(
            `INSERT INTO webauthn_credentials
                (user_id, credential_lookup, credential_id, public_key, device_type,
                 backed_up, authenticator_attachment, device_label)
             VALUES (?, UNHEX(SHA2(?, 256)), ?, ?, 'multiDevice', 1, 'cross-platform', 'Synced unusable browser')`,
            [SEED.cashierUser.id, rawId, rawId, Buffer.from(JSON.stringify(publicJwk()))]
        );
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });

        const revoked = await request(app)
            .post(`/api/admin/device-access/credentials/${inserted.insertId}/revoke`)
            .set('Cookie', programmerLogin.headers['set-cookie'][0])
            .set('Origin', ORIGIN)
            .send({ reason: 'ineligible credential cleanup' });

        expect(revoked.statusCode).toBe(200);
        const [credentials] = await pool.query(
            'SELECT id, status FROM webauthn_credentials WHERE id IN (?, ?) ORDER BY id',
            [validCredentialId, inserted.insertId]
        );
        expect(credentials).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: validCredentialId, status: 'active' }),
            expect.objectContaining({ id: inserted.insertId, status: 'revoked' }),
        ]));

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id IN (?, ?)', [validCredentialId, inserted.insertId]);
    });

    it('allows cleanup of the last credential for an inactive user', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const credentialId = await insertEligibleCredential(SEED.cashierUser.id, 'Inactive user browser');
        await pool.query('UPDATE users SET is_active=0 WHERE id=?', [SEED.cashierUser.id]);
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });

        try {
            const revoked = await request(app)
                .post(`/api/admin/device-access/credentials/${credentialId}/revoke`)
                .set('Cookie', programmerLogin.headers['set-cookie'][0])
                .set('Origin', ORIGIN)
                .send({ reason: 'inactive user cleanup' });

            expect(revoked.statusCode).toBe(200);
        } finally {
            await pool.query('UPDATE users SET is_active=1 WHERE id=?', [SEED.cashierUser.id]);
            await setAuthMode('staged');
            await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
            await pool.query('DELETE FROM webauthn_credentials WHERE id=?', [credentialId]);
        }
    });

    it('serializes concurrent revocations while allowing the user to become PIN-only', async () => {
        await setAuthMode('enforced');
        await pool.query('DELETE FROM webauthn_credentials WHERE user_id=?', [SEED.cashierUser.id]);
        const firstId = await insertEligibleCredential(SEED.cashierUser.id, 'Concurrent revoke A');
        const secondId = await insertEligibleCredential(SEED.cashierUser.id, 'Concurrent revoke B');
        const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
        const cookie = programmerLogin.headers['set-cookie'][0];

        const revoke = (credentialId) => request(app)
            .post(`/api/admin/device-access/credentials/${credentialId}/revoke`)
            .set('Cookie', cookie)
            .set('Origin', ORIGIN)
            .send({ reason: 'concurrent replacement test' });
        const responses = await Promise.all([revoke(firstId), revoke(secondId)]);

        expect(responses.map(({ statusCode }) => statusCode).sort()).toEqual([200, 200]);
        const [[remaining]] = await pool.query(
            `SELECT COUNT(*) AS count FROM webauthn_credentials
              WHERE user_id=? AND ${ELIGIBLE_CREDENTIAL_SQL}`,
            [SEED.cashierUser.id]
        );
        expect(Number(remaining.count)).toBe(0);
        expect((await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).statusCode).toBe(200);

        await setAuthMode('staged');
        await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
        await pool.query('DELETE FROM webauthn_credentials WHERE id IN (?, ?)', [firstId, secondId]);
    });

    it('keeps per-user enforcement coherent when enable races final revocation', async () => {
        for (let attempt = 0; attempt < 6; attempt += 1) {
            await setAuthMode('disabled');
            await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Enable race %'");
            const [users] = await pool.query("SELECT id FROM users WHERE is_active=1 AND role <> 'programmer' ORDER BY id");
            const credentials = new Map();
            for (const user of users) {
                credentials.set(user.id, await insertEligibleCredential(user.id, `Enable race ${attempt}-${user.id}`));
            }
            const programmerLogin = await request(app).post('/api/auth/login').send({ user_number: PROGRAMMER.user_number });
            const cookie = programmerLogin.headers['set-cookie'][0];

            await Promise.all([
                request(app)
                    .post('/api/admin/device-access/mode')
                    .set('Cookie', cookie)
                    .set('Origin', ORIGIN)
                    .send({ mode: 'enforced' }),
                request(app)
                    .post(`/api/admin/device-access/credentials/${credentials.get(SEED.cashierUser.id)}/revoke`)
                    .set('Cookie', cookie)
                    .set('Origin', ORIGIN)
                    .send({ reason: 'enable race test' }),
            ]);

            const [[mode]] = await pool.query("SELECT setting_value FROM settings WHERE setting_key='staff_device_auth_mode'");
            const [[remaining]] = await pool.query(
                `SELECT COUNT(*) AS count FROM webauthn_credentials
                  WHERE user_id=? AND ${ELIGIBLE_CREDENTIAL_SQL}`,
                [SEED.cashierUser.id]
            );
            expect(mode.setting_value).toBe('enforced');
            expect(Number(remaining.count)).toBe(0);
            expect((await request(app).post('/api/auth/login').send({ user_number: SEED.cashierUser.user_number })).statusCode).toBe(200);

            await pool.query('DELETE FROM auth_sessions WHERE user_id=?', [PROGRAMMER.id]);
            await pool.query("DELETE FROM webauthn_credentials WHERE device_label LIKE 'Enable race %'");
        }
        await setAuthMode('staged');
    });
});
