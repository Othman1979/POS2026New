import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

// Isolate environment loading from the parent review preload and private .env.test.
// The MySQL double cannot open or mutate a real database.
function probe({ env = {}, failLock = false, changeName = false } = {}) {
    const script = `
        const { createRequire } = await import('node:module');
        const require = createRequire(process.cwd() + '/package.json');
        require('dotenv').config = () => ({ parsed: {} });
        for (const key of ['DB_NAME', 'DB_HOST', 'DB_PORT', 'NODE_ENV']) delete process.env[key];
        Object.assign(process.env, ${JSON.stringify(env)});
        const calls = [];
        require('mysql2/promise').createConnection = async options => {
            calls.push({ host: options.host, port: options.port });
            return {
                query: async (sql, args) => { calls.push(args[0]); return [[{ acquired: ${failLock ? 0 : 1} }]]; },
                end: async () => { calls.push('closed'); }
            };
        };
        const setup = await import('./backend/tests/globalSetup.mjs');
        try {
            await setup.setup();
            const database = process.env.DB_NAME;
            ${changeName ? "process.env.DB_NAME = 'changed_after_setup';" : ''}
            await setup.teardown();
            console.log(JSON.stringify({ database, mode: process.env.NODE_ENV, calls }));
        } catch (error) { console.log(JSON.stringify({ error: error.message, calls })); }
    `;
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, encoding: 'utf8',
    }).trim());
}

describe('test global setup', () => {
    it('defaults to the local test database and forces test mode', () => {
        expect(probe({ env: { NODE_ENV: 'production' } })).toMatchObject({ database: 'posapp_test', mode: 'test' });
    });

    it('rejects an inherited application database before connecting', () => {
        expect(probe({ env: { DB_NAME: 'posapp' } })).toMatchObject({ error: expect.stringContaining('Refusing test database'), calls: [] });
    });

    it('locks the configured server and releases the original database lock', () => {
        expect(probe({ env: { DB_PORT: '3307' }, changeName: true }).calls).toEqual([
            { host: '127.0.0.1', port: 3307 }, 'posapp_test:vitest', 'posapp_test:vitest', 'closed',
        ]);
    });

    it('closes the lock connection when another run owns the fixture', () => {
        expect(probe({ failLock: true })).toMatchObject({
            error: expect.stringContaining('already in use'),
            calls: [{ host: '127.0.0.1', port: 3306 }, 'posapp_test:vitest', 'closed'],
        });
    });
});
