import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const temporaryDirectories = [];

function writeEnvironment(overrides = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'posapp-maintenance-env-'));
    temporaryDirectories.push(directory);
    const envPath = path.join(directory, 'backup.env');
    const values = {
        DB_HOST: '127.0.0.1',
        DB_PORT: '3307',
        DB_NAME: 'posapp',
        DB_USER: 'posapp_maintenance',
        DB_PASSWORD: 'do-not-print-me',
        ...overrides,
    };
    fs.writeFileSync(envPath, Object.entries(values)
        .filter(([, value]) => value !== null)
        .map(([key, value]) => `${key}=${value}`).join('\n'));
    return envPath;
}

afterEach(() => {
    while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
    vi.resetModules();
});

describe('pending migration maintenance CLI', () => {
    it('runs ordinary migrations, validates the schema, reports names only, and closes its pool', async () => {
        const { runPendingMigrationsCli } = require('../../../deployment/tools/run-pending-migrations');
        const end = vi.fn(async () => {});
        const createPool = vi.fn(() => ({ end }));
        const write = vi.fn();

        const runMigrations = vi.fn(async () => ({ applied: ['repair-v1'], skipped: ['older-v1'] }));
        const validateSchema = vi.fn(async () => true);
        await expect(runPendingMigrationsCli(['--env', writeEnvironment()], {
            createPool,
            runMigrations,
            validateSchema,
            write,
        })).resolves.toEqual({ applied: ['repair-v1'], skipped: ['older-v1'] });

        expect(createPool).toHaveBeenCalledWith(expect.objectContaining({
            host: '127.0.0.1', port: 3307, database: 'posapp',
            user: 'posapp_maintenance', password: 'do-not-print-me',
        }));
        expect(end).toHaveBeenCalledOnce();
        expect(runMigrations).toHaveBeenCalledWith(expect.anything());
        expect(validateSchema).toHaveBeenCalledWith(expect.anything());
        expect(write.mock.calls.flat().join(' ')).toContain('repair-v1');
        expect(write.mock.calls.flat().join(' ')).not.toContain('do-not-print-me');
    });

    it('runs repeatable repairs once and revalidates only for managed schema drift', async () => {
        const { runPendingMigrationsCli } = require('../../../deployment/tools/run-pending-migrations');
        const end = vi.fn(async () => {});
        const pool = { end };
        const createPool = vi.fn(() => pool);
        const runMigrations = vi.fn()
            .mockResolvedValueOnce({ applied: ['ordinary-v1'], skipped: ['older-v1'] })
            .mockResolvedValueOnce({ applied: ['repair-v1'], skipped: ['ordinary-v1'] });
        const drift = Object.assign(new Error('schema drift'), { code: 'SCHEMA_MIGRATION_REQUIRED' });
        const validateSchema = vi.fn()
            .mockRejectedValueOnce(drift)
            .mockResolvedValueOnce(true);

        await expect(runPendingMigrationsCli(['--env', writeEnvironment()], {
            createPool,
            runMigrations,
            validateSchema,
            write: vi.fn(),
        })).resolves.toEqual({
            applied: ['ordinary-v1', 'repair-v1'],
            skipped: ['older-v1'],
        });

        expect(runMigrations).toHaveBeenNthCalledWith(1, pool);
        expect(runMigrations).toHaveBeenNthCalledWith(2, pool, { includeRepeatable: true });
        expect(validateSchema).toHaveBeenCalledTimes(2);
        expect(validateSchema).toHaveBeenNthCalledWith(1, pool);
        expect(validateSchema).toHaveBeenNthCalledWith(2, pool);
        expect(end).toHaveBeenCalledOnce();
    });

    it('does not attempt repeatable repairs when schema validation fails for another reason', async () => {
        const { runPendingMigrationsCli } = require('../../../deployment/tools/run-pending-migrations');
        const end = vi.fn(async () => {});
        const pool = { end };
        const runMigrations = vi.fn(async () => ({ applied: [], skipped: [] }));
        const failure = new Error('permission denied');
        const validateSchema = vi.fn(async () => { throw failure; });

        await expect(runPendingMigrationsCli(['--env', writeEnvironment()], {
            createPool: () => pool,
            runMigrations,
            validateSchema,
            write: vi.fn(),
        })).rejects.toBe(failure);

        expect(runMigrations).toHaveBeenCalledOnce();
        expect(runMigrations).toHaveBeenCalledWith(pool);
        expect(validateSchema).toHaveBeenCalledOnce();
        expect(end).toHaveBeenCalledOnce();
    });

    it('closes its pool when migration execution fails', async () => {
        const { runPendingMigrationsCli } = require('../../../deployment/tools/run-pending-migrations');
        const end = vi.fn(async () => {});
        const failure = new Error('migration refused');

        await expect(runPendingMigrationsCli(['--env', writeEnvironment()], {
            createPool: () => ({ end }),
            runMigrations: vi.fn(async () => { throw failure; }),
            write: vi.fn(),
        })).rejects.toBe(failure);

        expect(end).toHaveBeenCalledOnce();
    });

    it('rejects relative paths, incomplete credentials, and invalid ports before connecting', async () => {
        const { runPendingMigrationsCli } = require('../../../deployment/tools/run-pending-migrations');
        const createPool = vi.fn();

        await expect(runPendingMigrationsCli(['--env', '.env'], { createPool }))
            .rejects.toThrow(/absolute-path/);
        await expect(runPendingMigrationsCli(['--env', writeEnvironment({ DB_PASSWORD: null })], { createPool }))
            .rejects.toThrow(/incomplete/);
        await expect(runPendingMigrationsCli(['--env', writeEnvironment({ DB_PORT: 'invalid' })], { createPool }))
            .rejects.toThrow(/port/);

        expect(createPool).not.toHaveBeenCalled();
    });
});
