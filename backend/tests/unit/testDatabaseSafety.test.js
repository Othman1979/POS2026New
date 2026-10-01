const mysql = require('mysql2/promise');
const { seedDatabase } = require('../fixtures/seed');
const { getTestDatabaseOptions } = require('../testDatabase.cjs');

describe('destructive fixture destination', () => {
    const original = { DB_NAME: process.env.DB_NAME, DB_HOST: process.env.DB_HOST, DB_PORT: process.env.DB_PORT };

    afterEach(() => {
        for (const [key, value] of Object.entries(original)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        vi.restoreAllMocks();
    });

    it.each(['posapp', 'customer_live', 'posapp_test`', 'posapp_review_recipe_p1_bad'])('rejects %s before connecting', async (database) => {
        const connect = vi.spyOn(mysql, 'createConnection').mockRejectedValue(new Error('Connection reached'));
        process.env.DB_NAME = database;
        await expect(seedDatabase()).rejects.toThrow('Refusing test database');
        expect(connect).not.toHaveBeenCalled();
    });

    it('rejects a remote host even with an allowlisted database', async () => {
        const connect = vi.spyOn(mysql, 'createConnection').mockRejectedValue(new Error('Connection reached'));
        process.env.DB_NAME = 'posapp_test';
        process.env.DB_HOST = 'database.example.invalid';
        await expect(seedDatabase()).rejects.toThrow('DB_HOST must be loopback');
        expect(connect).not.toHaveBeenCalled();
    });

    it('uses the same configured port as the application pool', async () => {
        const connect = vi.spyOn(mysql, 'createConnection').mockRejectedValue(new Error('Connection probe'));
        process.env.DB_NAME = 'posapp_review_recipe_p1_0123456789ab';
        process.env.DB_HOST = '127.0.0.1';
        process.env.DB_PORT = '3307';
        await expect(seedDatabase()).rejects.toThrow('Connection probe');
        expect(connect).toHaveBeenCalledWith(expect.objectContaining({ host: '127.0.0.1', port: 3307 }));
    });

    it.each(['0', '65536', 'invalid'])('rejects invalid database port %s', (port) => {
        expect(() => getTestDatabaseOptions({ DB_PORT: port })).toThrow('DB_PORT');
    });
});
