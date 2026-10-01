const request = require('supertest');
const { app } = require('../../../server');
const pool = require('../../config/db');

describe('GET /api/config/business', () => {
    it('returns business offset and day-start hour', async () => {
        const res = await request(app).get('/api/config/business');

        expect(res.statusCode).toBe(200);
        expect(res.body).toMatchObject({
            success: true,
            business_sql_offset: '+03:00',
            business_day_start_hour: 6,
            business_time_zone: 'Asia/Amman',
        });
    });

    afterAll(async () => {
        await pool.end();
    });
});
