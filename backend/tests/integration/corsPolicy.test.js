const request = require('supertest');
const { app, server, io } = require('../../../server');
const pool = require('../../config/db');

describe('server CORS wiring', () => {
    afterAll(async () => {
        io.close();
        await pool.end();
    });

    it('ships the blank deployment setting as same-origin-only HTTP and Socket.IO', async () => {
        const response = await request(app).get('/__cors_probe__').set('Origin', 'https://attacker.example');
        const socketHandshake = await request(server)
            .get('/socket.io/?EIO=4&transport=polling')
            .set('Host', 'pos.local:3000')
            .set('Origin', 'https://attacker.example');

        expect(response.headers['access-control-allow-origin']).toBeUndefined();
        expect(socketHandshake.status).toBe(403);
        expect(socketHandshake.body).toMatchObject({ code: 4, message: 'Origin not allowed.' });
        expect(io.engine.opts.cors).toEqual({ origin: false });
        expect(typeof io.engine.opts.allowRequest).toBe('function');
    });
});
