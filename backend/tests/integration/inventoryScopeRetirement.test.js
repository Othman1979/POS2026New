const { withUserEditVersion } = require('../helpers/adminUsers');
const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');
const { seedDatabase, SEED } = require('../fixtures/seed');

describe('POS inventory scope retirement', () => {
    let admin;
    beforeAll(async () => {
        await seedDatabase();
        admin = (await request(app).post('/api/auth/login').send({ user_number: SEED.adminUser.user_number })).headers['set-cookie'][0];
    });
    afterAll(() => pool.end());
    test('retired permission placeholders are neither advertised nor granted', async () => {
        const service = require('../../services/PermissionService');
        const catalog = await service.getCatalog();
        expect(catalog.some(row => /^(supplier|purchase|transfer|prep|period|value|receipt)\./.test(row.perm_key))).toBe(false);
        for (const key of ['supplier.manage', 'purchase.approve', 'period.close']) expect(service.userHas({ role: 'admin' }, key)).toBe(false);
    });
    test('old permission grants disappear from staff reads and cannot be assigned again', async () => {
        await pool.query('INSERT IGNORE INTO user_permissions(user_id,perm_key) VALUES (?,?)',[SEED.cashierUser.id,'supplier.manage']);
        const listed = await request(app).get('/api/admin/users').set('Cookie',admin);
        expect(listed.status).toBe(200);
        expect(listed.body.users.find(row=>row.id===SEED.cashierUser.id).permissions).not.toContain('supplier.manage');
        const saved = await request(app).put('/api/admin/users').set('Cookie',admin).send(await withUserEditVersion(app, admin, {id:SEED.cashierUser.id,name:SEED.cashierUser.name,user_number:SEED.cashierUser.user_number,role:'cashier',permissions:['pos.checkout','supplier.manage','period.close']}));
        expect(saved.status,JSON.stringify(saved.body)).toBe(200);
        const [grants] = await pool.query('SELECT perm_key FROM user_permissions WHERE user_id=?',[SEED.cashierUser.id]);
        expect(grants.map(row=>row.perm_key)).toEqual(['pos.checkout']);
    });
});
