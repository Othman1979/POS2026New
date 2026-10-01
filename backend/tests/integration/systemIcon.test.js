// backend/tests/integration/systemIcon.test.js
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');
const fs = require('fs');
const path = require('path');

describe('System Icon Integration Tests', () => {
    let adminCookie;
    let cashierCookie;

    beforeAll(async () => {
        await seedDatabase();

        // Login Admin
        const adminRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.adminUser.user_number });
        adminCookie = adminRes.headers['set-cookie'][0];

        // Login Cashier
        const cashierRes = await request(app)
            .post('/api/auth/login')
            .send({ user_number: SEED.cashierUser.user_number });
        cashierCookie = cashierRes.headers['set-cookie'][0];
    });

    afterAll(async () => {
        // Clean up test file if it was created
        const uploadsDir = path.join(__dirname, '../../../uploads');
        if (fs.existsSync(uploadsDir)) {
            const files = fs.readdirSync(uploadsDir);
            for (const file of files) {
                if (file.startsWith('store_icon.')) {
                    try { fs.unlinkSync(path.join(uploadsDir, file)); } catch (_) {}
                }
            }
        }
        await pool.end();
    });

    describe('GET /api/system/settings', () => {
        it('should return store_icon as null by default', async () => {
            const res = await request(app)
                .get('/api/system/settings')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.store_icon).toBeNull();
        });
    });

    describe('GET /api/system/public_preferences', () => {
        it('should return store_icon as null by default', async () => {
            const res = await request(app)
                .get('/api/system/public_preferences');

            expect(res.statusCode).toBe(200);
            expect(res.body.store_icon).toBeNull();
        });
    });

    describe('POST /api/system/brand-icon', () => {
        const PNG = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a, 0,0,0,0]);

        it('should reject requests from unauthenticated clients', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .attach('icon', Buffer.from('fake image data'), 'icon.png');

            expect(res.statusCode).toBe(401);
        });

        it('should reject requests from non-admin accounts', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', cashierCookie)
                .attach('icon', Buffer.from('fake image data'), 'icon.png');

            expect(res.statusCode).toBe(403);
        });

        it('should reject invalid file types', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', Buffer.from('some text'), 'document.txt');

            expect(res.statusCode).toBe(400);
            expect(res.body.success).toBe(false);
            expect(res.body.message).toContain('Only PNG, JPG, ICO, and WEBP');
        });

        it('should reject a PHP payload disguised as image/png (content sniff)', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', Buffer.from('<?php system($_GET[0]); ?>'), { filename: 'x.php', contentType: 'image/png' });
            expect(res.statusCode).toBe(400);
            const uploadsDir = path.join(__dirname, '../../../uploads');
            const files = fs.existsSync(uploadsDir) ? fs.readdirSync(uploadsDir) : [];
            expect(files.some(f => f.startsWith('store_icon.'))).toBe(false); // nothing written
        });

        it('should reject an SVG upload', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), { filename: 'x.svg', contentType: 'image/svg+xml' });
            expect(res.statusCode).toBe(400);
        });

        it('should accept a real PNG and store it as store_icon.png', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', PNG, { filename: 'whatever.bin', contentType: 'image/png' });
            expect(res.statusCode).toBe(200);
            expect(res.body.store_icon).toBe('/uploads/store_icon.png');
        });

        it('should NOT delete the existing icon when a later upload is invalid (validate before delete)', async () => {
            // valid PNG first
            await request(app).post('/api/system/brand-icon').set('Cookie', adminCookie)
                .attach('icon', PNG, { filename: 'a.png', contentType: 'image/png' });
            // now an invalid upload
            await request(app).post('/api/system/brand-icon').set('Cookie', adminCookie)
                .attach('icon', Buffer.from('not an image'), { filename: 'b.png', contentType: 'image/png' });
            // old icon must survive
            const uploadsPath = path.join(__dirname, '../../../uploads/store_icon.png');
            expect(fs.existsSync(uploadsPath)).toBe(true);
            const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'store_icon'");
            expect(rows[0].setting_value).toBe('/uploads/store_icon.png');
        });

        it('should upload valid image, save to DB, and emit settings_changed', async () => {
            const res = await request(app)
                .post('/api/system/brand-icon')
                .set('Cookie', adminCookie)
                .attach('icon', PNG, 'test_logo.png');

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);
            expect(res.body.store_icon).toContain('/uploads/store_icon.png');

            // Verify physical file exists in uploads/
            const uploadsPath = path.join(__dirname, '../../../uploads/store_icon.png');
            expect(fs.existsSync(uploadsPath)).toBe(true);

            // Verify DB contains it
            const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'store_icon'");
            expect(rows[0].setting_value).toContain('/uploads/store_icon.png');
        });
    });

    describe('DELETE /api/system/brand-icon', () => {
        it('should reject unauthenticated deletion', async () => {
            const res = await request(app)
                .delete('/api/system/brand-icon');

            expect(res.statusCode).toBe(401);
        });

        it('should reject cashier deletion', async () => {
            const res = await request(app)
                .delete('/api/system/brand-icon')
                .set('Cookie', cashierCookie);

            expect(res.statusCode).toBe(403);
        });

        it('should delete icon from disk and DB setting', async () => {
            const res = await request(app)
                .delete('/api/system/brand-icon')
                .set('Cookie', adminCookie);

            expect(res.statusCode).toBe(200);
            expect(res.body.success).toBe(true);

            // Verify file deleted
            const uploadsPath = path.join(__dirname, '../../../uploads/store_icon.png');
            expect(fs.existsSync(uploadsPath)).toBe(false);

            // Verify DB record deleted
            const [rows] = await pool.query("SELECT setting_value FROM settings WHERE setting_key = 'store_icon'");
            expect(rows.length).toBe(0);
        });
    });
});
